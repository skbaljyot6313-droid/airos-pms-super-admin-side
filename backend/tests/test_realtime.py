"""Centrifugo realtime — token minting, channel authorization, dispatch.

Channel authorization is the security boundary: every channel lives in
the private `priv` namespace, so clients can only subscribe with a
per-channel JWT minted by POST /realtime/subscribe. These tests pin the
authorization rules:

  - property channels require company/property scope proof (server-side)
  - emp channels are self-only
  - unknown channel shapes are rejected
  - events buffered mid-transaction only publish via dispatch after
    commit; unconfigured Centrifugo no-ops everywhere
"""

import time
import uuid
from types import SimpleNamespace

import jwt as pyjwt
import pytest

from app.api.v1 import realtime as realtime_api
from app.core import centrifugo
from app.core.config import settings
from app.models.user import UserRole

SECRET = "test-centrifugo-secret-key-32byte"
PROP_ID = uuid.uuid4()
OTHER_PROP = uuid.uuid4()
EMP_ID = uuid.uuid4()


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    monkeypatch.setattr(settings, "CENTRIFUGO_URL", "http://centrifugo.test")
    monkeypatch.setattr(settings, "CENTRIFUGO_API_KEY", "api-key")
    monkeypatch.setattr(settings, "CENTRIFUGO_TOKEN_SECRET", SECRET)
    monkeypatch.setattr(settings, "CENTRIFUGO_WS_URL", None)
    yield


def _user(**kw):
    base = dict(
        id=uuid.uuid4(),
        role=UserRole.SUPER_ADMIN,
        company_id=uuid.uuid4(),
        property_id=None,
        employee_id=None,
        name="Test User",
    )
    base.update(kw)
    return SimpleNamespace(**base)


# -- channels + urls ---------------------------------------------------------


def test_channel_grammar():
    assert centrifugo.prop_channel(PROP_ID, "tasks") == (
        f"priv:prop:{PROP_ID}:tasks"
    )
    assert centrifugo.emp_channel(EMP_ID) == f"priv:emp:{EMP_ID}"
    assert centrifugo.ws_url() == (
        "http://centrifugo.test/connection/websocket"
    )


def test_ws_url_override(monkeypatch):
    monkeypatch.setattr(
        settings, "CENTRIFUGO_WS_URL", "wss://rt.example.com/connection/websocket"
    )
    assert centrifugo.ws_url() == "wss://rt.example.com/connection/websocket"


# -- tokens ------------------------------------------------------------------


def test_connection_token_claims():
    user = _user()
    token, exp = centrifugo.connection_token(user)
    claims = pyjwt.decode(token, SECRET, algorithms=["HS256"])
    assert claims["sub"] == str(user.id)
    assert claims["exp"] == exp > int(time.time())
    assert claims["info"]["role"] == "super_admin"


def test_subscription_token_binds_channel():
    user = _user()
    ch = centrifugo.prop_channel(PROP_ID, "tasks")
    token, exp = centrifugo.subscription_token(user, ch)
    claims = pyjwt.decode(token, SECRET, algorithms=["HS256"])
    assert claims["channel"] == ch
    assert claims["sub"] == str(user.id)
    assert claims["exp"] == exp > int(time.time())


# -- publish + dispatch ------------------------------------------------------


@pytest.mark.asyncio
async def test_publish_unconfigured_noop(monkeypatch):
    monkeypatch.setattr(settings, "CENTRIFUGO_API_KEY", None)
    assert await centrifugo.publish("priv:x", "task.created", {}) is False


@pytest.mark.asyncio
async def test_publish_envelope(monkeypatch):
    captured = {}

    class FakeResp:
        status_code = 200

    class FakeClient:
        async def post(self, url, headers=None, json=None, timeout=None):
            captured.update(url=url, headers=headers, json=json)
            return FakeResp()

    monkeypatch.setattr(
        "app.core.centrifugo.get_eb_client", lambda: FakeClient()
    )
    ok = await centrifugo.publish("priv:prop:x:tasks", "task.created", {"a": 1})
    assert ok is True
    assert captured["url"] == "http://centrifugo.test/api/publish"
    assert captured["headers"]["X-API-Key"] == "api-key"
    env = captured["json"]["data"]
    assert env["v"] == 1
    assert env["type"] == "task.created"
    assert env["data"] == {"a": 1}
    assert env["id"] and env["ts"]


@pytest.mark.asyncio
async def test_dispatch_bounded(monkeypatch):
    sent = []

    async def _fake(ch, t, d):
        sent.append((ch, t))
        return True

    monkeypatch.setattr(centrifugo, "publish", _fake)
    events = [("c", "t", {}) for _ in range(60)]
    await centrifugo.dispatch_realtime_events(events)
    assert len(sent) == 50  # bounded drain


def test_queue_event_buffers_on_session():
    session = SimpleNamespace(info={})
    centrifugo.queue_event(session, "c1", "task.created", {"x": 1})
    centrifugo.queue_event(session, "c2", "task.updated", {"x": 2})
    assert session.info[centrifugo.RT_EVENTS] == [
        ("c1", "task.created", {"x": 1}),
        ("c2", "task.updated", {"x": 2}),
    ]


def test_queue_event_unconfigured_noop(monkeypatch):
    monkeypatch.setattr(settings, "CENTRIFUGO_URL", None)
    session = SimpleNamespace(info={})
    centrifugo.queue_event(session, "c", "t", {})
    assert centrifugo.RT_EVENTS not in session.info


# -- subscribe endpoint authorization ----------------------------------------


class _ScalarResult:
    def __init__(self, values):
        self._values = values

    def scalars(self):
        return self._values


class _FakeSession:
    """Returns the company-scoped property ids the query asks about —
    simulates `Property.company_id == user.company_id` filtering."""
    def __init__(self, allowed: set):
        self._allowed = allowed

    async def execute(self, _q):
        return _ScalarResult(self._allowed)


@pytest.mark.asyncio
async def test_token_endpoint_unconfigured(monkeypatch):
    monkeypatch.setattr(settings, "CENTRIFUGO_URL", None)
    with pytest.raises(realtime_api.RealtimeUnavailable):
        await realtime_api.realtime_token(user=_user())


@pytest.mark.asyncio
async def test_token_endpoint_mints():
    res = await realtime_api.realtime_token(user=_user())
    claims = pyjwt.decode(res["token"], SECRET, algorithms=["HS256"])
    assert claims["exp"] == res["expires_at"]
    assert res["ws_url"].endswith("/connection/websocket")


@pytest.mark.asyncio
async def test_subscribe_emp_self_only():
    user = _user(employee_id=EMP_ID)
    ch = centrifugo.emp_channel(EMP_ID)
    res = await realtime_api.subscribe(
        realtime_api.SubscribeRequest(channels=[ch]),
        user=user, session=None,
    )
    assert ch in res["tokens"]

    other = _user(employee_id=uuid.uuid4())
    with pytest.raises(realtime_api.ChannelDenied):
        await realtime_api.subscribe(
            realtime_api.SubscribeRequest(channels=[ch]),
            user=other, session=None,
        )


@pytest.mark.asyncio
async def test_subscribe_unknown_channel_rejected():
    for ch in (
        "tasks",                          # no namespace
        "public:prop:x",                  # wrong namespace
        f"priv:prop:{PROP_ID}:secrets",   # unknown topic
        f"priv:prop:{PROP_ID}",           # missing topic
        f"priv:emp:{EMP_ID}:extra",       # malformed emp channel
        "priv:user:abc",                  # user channel isn't grantable
    ):
        with pytest.raises(realtime_api.ChannelDenied):
            await realtime_api.subscribe(
                realtime_api.SubscribeRequest(channels=[ch]),
                user=_user(), session=None,
            )


@pytest.mark.asyncio
async def test_subscribe_super_admin_company_scope():
    user = _user()
    in_scope = centrifugo.prop_channel(PROP_ID, "tasks")
    out_scope = centrifugo.prop_channel(OTHER_PROP, "tasks")
    session = _FakeSession({PROP_ID})

    res = await realtime_api.subscribe(
        realtime_api.SubscribeRequest(channels=[in_scope]),
        user=user, session=session,
    )
    assert in_scope in res["tokens"]

    with pytest.raises(realtime_api.ChannelDenied):
        await realtime_api.subscribe(
            realtime_api.SubscribeRequest(channels=[out_scope]),
            user=user, session=session,
        )


@pytest.mark.asyncio
async def test_subscribe_property_manager_own_property_only():
    pm = _user(role=UserRole.PROPERTY_MANAGER, property_id=PROP_ID)
    own = centrifugo.prop_channel(PROP_ID, "attendance")
    foreign = centrifugo.prop_channel(OTHER_PROP, "attendance")

    res = await realtime_api.subscribe(
        realtime_api.SubscribeRequest(channels=[own]),
        user=pm, session=None,
    )
    assert own in res["tokens"]

    # A PM must never mint a token for another property — no DB consult
    # is even needed; their scope is their own property_id.
    with pytest.raises(realtime_api.ChannelDenied):
        await realtime_api.subscribe(
            realtime_api.SubscribeRequest(channels=[foreign]),
            user=pm, session=None,
        )


@pytest.mark.asyncio
async def test_subscribe_mixed_batch_all_or_nothing():
    """One denied channel fails the whole request — a client can never
    smuggle a partial grant."""
    user = _user(employee_id=EMP_ID)
    good = centrifugo.emp_channel(EMP_ID)
    bad = centrifugo.prop_channel(OTHER_PROP, "locations")
    session = _FakeSession(set())  # no company properties allowed
    with pytest.raises(realtime_api.ChannelDenied):
        await realtime_api.subscribe(
            realtime_api.SubscribeRequest(channels=[good, bad]),
            user=user, session=session,
        )
