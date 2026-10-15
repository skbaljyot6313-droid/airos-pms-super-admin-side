"""Centrifugo integration — connection/subscription tokens + HTTP publish.

Channel grammar (all inside the private namespace `priv`, so EVERY
subscription requires a per-channel JWT minted by POST /realtime/subscribe
— clients can never subscribe to arbitrary channels):

    priv:prop:{property_uid}:tasks        task.* events
    priv:prop:{property_uid}:units        resource.state_changed events
    priv:prop:{property_uid}:attendance   attendance.* / leave.* / shift.*
    priv:prop:{property_uid}:maintenance  maintenance.* events
    priv:prop:{property_uid}:locations    employee.location_updated
    priv:emp:{employee_uid}               per-employee channel (EB-owned;
                                          minted here only when the SA
                                          user's own employee_id matches)

Event envelope (versioned, minimal payload — events are INVALIDATION
HINTS, never the source of truth; clients refetch the affected slice or
merge whitelisted fields):

    {"v": 1, "id": "<uuid>", "type": "task.created",
     "ts": "<iso8601 utc>", "data": {...}}

Secrets stay server-side: CENTRIFUGO_API_KEY authorizes publishes,
CENTRIFUGO_TOKEN_SECRET signs client JWTs — both Railway-only env vars.
"""

import time
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx
import jwt

from app.core.config import settings
from app.core.http_client import get_eb_client
from app.core.logging import get_logger

logger = get_logger("app.centrifugo")

PRIVATE_NS = "priv"
CHANNEL_RE_PARTS = {
    "prop_tasks": "tasks",
    "prop_units": "units",
    "prop_attendance": "attendance",
    "prop_maintenance": "maintenance",
    "prop_locations": "locations",
    "prop_employees": "employees",
}


def prop_channel(property_id: uuid.UUID, topic: str) -> str:
    """priv:prop:{uid}:{topic} — topic in CHANNEL_RE_PARTS.values()."""
    return f"{PRIVATE_NS}:prop:{property_id}:{topic}"


def emp_channel(employee_id: uuid.UUID) -> str:
    return f"{PRIVATE_NS}:emp:{employee_id}"


def configured() -> bool:
    return bool(
        settings.CENTRIFUGO_URL
        and settings.CENTRIFUGO_API_KEY
        and settings.CENTRIFUGO_TOKEN_SECRET
    )


def ws_url() -> str | None:
    """Client-facing WebSocket URL (public value — safe for the SPA)."""
    if settings.CENTRIFUGO_WS_URL:
        return settings.CENTRIFUGO_WS_URL
    if settings.CENTRIFUGO_URL:
        return settings.CENTRIFUGO_URL.rstrip("/") + "/connection/websocket"
    return None


# ---------------------------------------------------------------------------
# Tokens — HMAC-SHA256 JWTs in Centrifugo's expected format.
# Connection token: {"sub": user_id, "exp", "iat"}. Subscription token adds
# "channel" — Centrifugo verifies it against the private channel name.
# ---------------------------------------------------------------------------

def _sign(claims: dict) -> str:
    return jwt.encode(
        claims, settings.CENTRIFUGO_TOKEN_SECRET, algorithm="HS256"
    )


def connection_token(user) -> tuple[str, int]:
    """Signed connection JWT. `sub` is the immutable user id — role and
    scope claims are NOT trusted client-side anyway, so only carry them
    as informational `meta` (authorization is re-checked server-side at
    subscribe time)."""
    now = int(time.time())
    exp = now + settings.CENTRIFUGO_CONN_TOKEN_TTL_SECONDS
    token = _sign({
        "sub": str(user.id),
        "iat": now,
        "exp": exp,
        "info": {
            "role": str(getattr(user.role, "value", user.role)),
            "company_id": str(user.company_id),
            "property_id": str(user.property_id) if user.property_id else None,
        },
    })
    return token, exp


def subscription_token(user, channel: str) -> tuple[str, int]:
    now = int(time.time())
    exp = now + settings.CENTRIFUGO_SUB_TOKEN_TTL_SECONDS
    token = _sign({
        "sub": str(user.id),
        "channel": channel,
        "iat": now,
        "exp": exp,
    })
    return token, exp


# ---------------------------------------------------------------------------
# HTTP publish — POST {CENTRIFUGO_URL}/api/publish via the shared pooled
# client (R-01). Failures are logged, never raised — an event is a hint;
# callers' reconciliation polls are the correctness backstop.
# ---------------------------------------------------------------------------

async def publish(channel: str, event_type: str, data: dict[str, Any]) -> bool:
    """Publish one event. Returns False when unconfigured or on failure."""
    if not configured():
        return False
    envelope = {
        "v": 1,
        "id": uuid.uuid4().hex,
        "type": event_type,
        "ts": datetime.now(timezone.utc).isoformat(),
        "data": data,
    }
    try:
        client = get_eb_client()
        res = await client.post(
            f"{settings.CENTRIFUGO_URL.rstrip('/')}/api/publish",
            headers={"X-API-Key": settings.CENTRIFUGO_API_KEY},
            json={"channel": channel, "data": envelope},
            timeout=4.0,
        )
        if res.status_code != 200:
            logger.warning(
                "centrifugo publish %s -> HTTP %s", channel, res.status_code
            )
            return False
        return True
    except httpx.HTTPError as exc:
        logger.warning(
            "centrifugo publish %s failed: %s", channel, type(exc).__name__
        )
        return False


# ---------------------------------------------------------------------------
# Post-commit dispatch — events queued on session.info are published ONLY
# after the outer transaction commits (same pattern as EB allocation
# notices): a rolled-back mutation never emits a success event, and a
# publish failure can never fail the committed business transaction.
# ---------------------------------------------------------------------------

RT_EVENTS = "_centrifugo_events"


def queue_event(
    session, channel: str, event_type: str, data: dict[str, Any]
) -> None:
    """Buffer an event on the session — dispatched by the after_commit
    hook in app.core.database. No-op when Centrifugo is unconfigured."""
    if not configured():
        return
    session.info.setdefault(RT_EVENTS, []).append(
        (channel, event_type, dict(data))
    )


async def dispatch_realtime_events(events: list[tuple]) -> None:
    """Publish a drained buffer — best-effort, sequential (bounded)."""
    for channel, event_type, data in events[:50]:
        await publish(channel, event_type, data)
