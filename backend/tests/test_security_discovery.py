import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import httpx
import jwt
import pytest
from fastapi import FastAPI
from starlette.requests import Request

from app.api.v1 import logs, media
from app.core.config import settings
from app.core.exceptions import register_exception_handlers
from app.core.rate_limit import _client_ip
from app.core.security import decode_access_token, hash_refresh_token
from app.models.user import UserRole
from app.services.auth import AuthService, InvalidRefreshToken


def refresh_service():
    user = SimpleNamespace(
        id=uuid.uuid4(), company_id=uuid.uuid4(), property_id=None,
        name="Synthetic audit user", role=UserRole.SUPER_ADMIN, is_active=True,
    )
    stored = SimpleNamespace(
        user_id=user.id, revoked=False,
        expires_at=datetime.now(UTC) + timedelta(days=30),
    )
    session = MagicMock()
    session.commit = AsyncMock()
    service = AuthService(session)
    service.users = SimpleNamespace(get_by_id=AsyncMock(return_value=user))
    service.tokens = SimpleNamespace(
        get_by_hash=AsyncMock(return_value=stored),
        create=AsyncMock(),
        revoke_all_for_user=AsyncMock(return_value=3),
    )
    return service, stored


@pytest.mark.asyncio
async def test_refresh_rotates_and_revokes_presented_token():
    service, stored = refresh_service()
    access, new_refresh = await service.refresh("synthetic-refresh-only")
    assert decode_access_token(access)["type"] == "access"
    assert isinstance(new_refresh, str) and new_refresh
    assert stored.revoked is True
    service.tokens.create.assert_awaited_once()
    service.tokens.get_by_hash.assert_awaited_with(hash_refresh_token("synthetic-refresh-only"))


@pytest.mark.asyncio
async def test_refresh_reuse_of_revoked_token_revokes_family():
    service, stored = refresh_service()
    stored.revoked = True
    with pytest.raises(InvalidRefreshToken):
        await service.refresh("synthetic-refresh-only")
    service.tokens.revoke_all_for_user.assert_awaited_once_with(stored.user_id)
    service.tokens.create.assert_not_awaited()


@pytest.mark.asyncio
async def test_concurrent_refresh_under_shared_row_marks_it_consumed():
    services = [refresh_service()[0] for _ in range(4)]
    stored = (await services[0].tokens.get_by_hash("unused"))
    ready = asyncio.Event()
    readers = 0

    async def read_shared_token(_hash):
        nonlocal readers
        readers += 1
        if readers == 4:
            ready.set()
        await asyncio.wait_for(ready.wait(), timeout=2)
        return stored

    shared_tokens = SimpleNamespace(
        get_by_hash=AsyncMock(side_effect=read_shared_token),
        create=AsyncMock(),
        revoke_all_for_user=AsyncMock(return_value=0),
    )
    for service in services:
        service.users = services[0].users
        service.tokens = shared_tokens
    # The real guarantee is the SELECT ... FOR UPDATE on the token row:
    # concurrent refreshes serialize, the loser sees revoked=True and hits
    # reuse detection. Mocks share one object without locking, so the
    # honest assertion is: at least one refresh succeeds, every failure is
    # InvalidRefreshToken, and the token row ends revoked.
    results = await asyncio.gather(
        *(service.refresh("synthetic-refresh-only") for service in services),
        return_exceptions=True,
    )
    successes = [r for r in results if not isinstance(r, Exception)]
    failures = [r for r in results if isinstance(r, Exception)]
    assert len(successes) >= 1
    assert all(
        decode_access_token(access)["sub"] == str(stored.user_id)
        for access, _new_refresh in successes
    )
    assert all(isinstance(f, InvalidRefreshToken) for f in failures)
    assert stored.revoked is True


def _media_session(*, referenced: bool):
    """Synthetic session: task lookup returns no rows; the maintenance-
    attachment existence check is `referenced`."""
    result = SimpleNamespace(
        scalars=lambda: SimpleNamespace(all=lambda: []),
        first=lambda: (1,) if referenced else None,
    )
    return SimpleNamespace(execute=AsyncMock(return_value=result))


@pytest.mark.asyncio
async def test_unreferenced_media_key_is_not_served(monkeypatch):
    """Orphan objects have no owner to authorize against — 404."""
    monkeypatch.setattr(settings, "RATE_LIMIT_ENABLED", False)
    app = FastAPI()
    register_exception_handlers(app)
    app.dependency_overrides[media.get_db] = lambda: _media_session(referenced=False)
    app.include_router(media.router, prefix="/api/v1")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://audit.test") as client:
        response = await client.get("/api/v1/media/file/" + "a" * 32 + ".jpg")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_anonymous_media_access_for_referenced_attachment(monkeypatch):
    """Maintenance attachments stay public-by-unguessable-key (<img> can't
    carry a JWT) — same exposure as the storage URLs they replace."""
    async def stream():
        yield b"synthetic-evidence"

    storage = SimpleNamespace(open=AsyncMock(return_value=(stream, "image/jpeg", 18)))
    monkeypatch.setattr(media, "get_storage", lambda: storage)
    monkeypatch.setattr(settings, "RATE_LIMIT_ENABLED", False)
    app = FastAPI()
    app.dependency_overrides[media.get_db] = lambda: _media_session(referenced=True)
    app.include_router(media.router, prefix="/api/v1")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://audit.test") as client:
        response = await client.get("/api/v1/media/file/" + "a" * 32 + ".jpg")
    assert response.status_code == 200
    assert response.content == b"synthetic-evidence"
    assert response.headers["cache-control"] == "private, no-store"
    storage.open.assert_awaited_once_with("a" * 32 + ".jpg")


@pytest.mark.asyncio
async def test_log_attachment_requires_authentication_without_database():
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(logs.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://audit.test") as client:
        response = await client.get("/admin/logs/attachments/task_photo/" + str(uuid.uuid4()))
    assert response.status_code == 401


def test_characterizes_forwarded_header_trust_from_direct_client():
    request = Request({
        "type": "http", "method": "GET", "path": "/", "headers": [
            (b"x-forwarded-for", b"198.51.100.99"),
        ], "client": ("127.0.0.1", 12345),
    })
    assert _client_ip(request) == "198.51.100.99"


def test_characterizes_signed_access_token_without_expiry(monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET_KEY", "synthetic-audit-signing-key-at-least-32-bytes")
    monkeypatch.setattr(settings, "JWT_ALGORITHM", "HS256")
    token = jwt.encode({"sub": str(uuid.uuid4()), "type": "access"}, settings.JWT_SECRET_KEY, algorithm="HS256")
    assert decode_access_token(token) is not None
