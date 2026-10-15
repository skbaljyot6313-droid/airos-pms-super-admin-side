"""Lifecycle-managed shared httpx.AsyncClient for Employee Backend calls.

B-03 remediation: `live_location._get` and
`employee_events.dispatch_allocation_notices` previously constructed a
NEW `httpx.AsyncClient` per call — paying DNS + TCP + TLS setup (~200 ms
to the Railway upstream) on every 10-second live-location poll. A single
process-wide client reuses pooled keep-alive connections instead.

The client is intentionally GENERIC: base URL and X-Location-Service-Key
are resolved per call from settings (tests monkeypatch them), and only
the transport pool is shared — httpx keys pooled connections by origin,
so all EB calls ride the same keep-alive pool.

Lifespan: `init_eb_client()` warms the client at startup;
`close_eb_client()` drains the pool at shutdown. Outside a running app
(tests, scripts) the client is created lazily on first use.
"""

import httpx

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger("app.http_client")

_client: httpx.AsyncClient | None = None


# keepalive_expiry must exceed the 10 s live-location poll interval —
# httpx's 5 s default would close the connection between every poll
# and defeat reuse entirely.
EB_CLIENT_LIMITS = httpx.Limits(
    max_connections=20,
    max_keepalive_connections=10,
    keepalive_expiry=45.0,
)


def _build_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=httpx.Timeout(
            settings.LOCATION_SERVICE_TIMEOUT_SECONDS,
            connect=4.0,
            pool=5.0,
        ),
        limits=EB_CLIENT_LIMITS,
    )


def get_eb_client() -> httpx.AsyncClient:
    """The shared client — created on first use, reused until closed."""
    global _client
    if _client is None or _client.is_closed:
        _client = _build_client()
    return _client


def set_eb_client(client: httpx.AsyncClient | None) -> None:
    """Test hook — inject a client (e.g. one with a mock transport)."""
    global _client
    _client = client


async def init_eb_client() -> None:
    """Lifespan startup — build eagerly so the first request doesn't pay
    client construction cost."""
    get_eb_client()


async def close_eb_client() -> None:
    """Lifespan shutdown — drain keep-alive connections cleanly."""
    global _client
    client, _client = _client, None
    if client is not None:
        await client.aclose()
