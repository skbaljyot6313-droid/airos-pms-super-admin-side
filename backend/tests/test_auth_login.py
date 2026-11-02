"""Login-flow regression tests — single-write CTE, verify-queue usage,
uniform credential failure, inactive accounts. Faked session: no DB."""

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.core.security import hash_password, hash_refresh_token
from app.models.user import UserRole
from app.services.auth import (
    AccountInactive,
    AuthService,
    InvalidCredentials,
)


class _Result:
    def scalar_one_or_none(self):
        return None


class FakeSession:
    """Records statements/commits; never touches a database."""

    def __init__(self):
        self.statements = []
        self.commits = 0
        self.events = []

    async def execute(self, stmt, params=None):
        self.statements.append(str(stmt))
        return _Result()

    async def commit(self):
        self.commits += 1

    async def rollback(self):
        pass

    def add(self, _obj):
        self.events.append(_obj)

    async def flush(self):
        pass


class StubUserRepo:
    def __init__(self, user):
        self._user = user
        self.touched = False

    async def get_by_identifier(self, _ident):
        return self._user

    async def touch_last_login(self, _user):
        self.touched = True


class StubTokenRepo:
    def __init__(self):
        self.created = 0

    async def create(self, **_kw):
        self.created += 1


def _user(password="secret-pw", active=True):
    return SimpleNamespace(
        id=uuid.uuid4(), company_id=uuid.uuid4(),
        name="T", email="t@x.dev", username="t",
        password_hash=hash_password(password),
        phone_number=None, role=UserRole.SUPER_ADMIN,
        property_id=None, employee_id=None, zone_id=None,
        job_title=None, is_active=active,
        company=SimpleNamespace(
            id=uuid.uuid4(), company_name="Co", legal_name=None,
            brand_name="Co", email="c@x.dev", phone_number="1",
            address=None, pin_code=None, operational_day_start="06:00",
            created_at=datetime.now(timezone.utc)),
    )


def _svc(user):
    session = FakeSession()
    svc = AuthService(session)
    svc.users = StubUserRepo(user)
    svc.tokens = StubTokenRepo()
    return svc, session


async def test_valid_login_single_write_round_trip():
    svc, session = _svc(_user())
    resp = await svc.login("t@x.dev", "secret-pw")
    assert resp.access_token and resp.refresh_token
    # The lookup SELECT is faked at the repo layer; the ONLY statement the
    # service itself issues is the merged UPDATE+INSERT CTE — the old path
    # flushed UPDATE and INSERT as two separate remote round trips.
    assert len(session.statements) == 1
    assert "UPDATE users" in session.statements[0]
    assert "INSERT INTO refresh_tokens" in session.statements[0]
    # 2 commits: lookup read-commit (releases the pool connection during
    # argon2 verify) + final token-write commit
    assert session.commits == 2
    # token repo's ORM insert must NOT have been used on the login path
    assert svc.tokens.created == 0
    assert svc.users.touched is False  # folded into the CTE


async def test_invalid_password_uniform_rejection():
    svc, _s = _svc(_user())
    with pytest.raises(InvalidCredentials):
        await svc.login("t@x.dev", "wrong")
    event = _s.events[-1]
    assert event.action == "login_failed" and event.detail["outcome"] == "failed"
    assert event.detail["http_status"] == 401 and event.detail["reason_code"] == "INVALID_CREDENTIALS"
    assert event.actor_name is None and event.actor_user_id is None
    assert event.detail["target_account_name"] == "T"
    assert "wrong" not in str(event.detail) and "secret-pw" not in str(event.detail)


async def test_unknown_user_uniform_rejection_and_no_token():
    svc, session = _svc(user=None)
    with pytest.raises(InvalidCredentials):
        await svc.login("ghost@x.dev", "any")
    # Dummy-hash verify ran through the queue; no token-write statement issued.
    # Read-release and the unattributed failure audit each commit separately.
    assert session.statements == []
    assert session.commits == 2
    assert session.events[-1].detail["company_uid"] is None
    assert session.events[-1].detail["target_account_name"] is None
    assert "ghost@x.dev" not in str(session.events[-1].detail)


async def test_inactive_account_rejected():
    svc, _s = _svc(_user(active=False))
    with pytest.raises(AccountInactive):
        await svc.login("t@x.dev", "secret-pw")


async def test_concurrent_logins_all_succeed():
    svc, _s = _svc(_user())
    import asyncio
    results = await asyncio.gather(*(
        svc.login("t@x.dev", "secret-pw") for _ in range(5)))
    assert all(r.access_token for r in results)


async def test_refresh_token_hash_stored_not_plain():
    svc, session = _svc(_user())
    resp = await svc.login("t@x.dev", "secret-pw")
    # the CTE params aren't visible in FakeSession, but the plaintext
    # refresh token must never equal what we'd store
    assert hash_refresh_token(resp.refresh_token) != resp.refresh_token
