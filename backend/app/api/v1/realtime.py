"""Centrifugo realtime endpoints — connection + subscription tokens.

    GET  /realtime/token      → short-lived Centrifugo connection JWT
    POST /realtime/subscribe  → per-channel subscription JWTs after
                                server-side scope validation

All channels live in the private `priv` namespace, so a subscription
token is REQUIRED per channel — this endpoint is the authorization gate:
    priv:prop:{pid}:{topic}  → property must be inside the caller's scope
                               (super_admin → any company property,
                                property_manager → own property only)
    priv:emp:{eid}           → only when the caller IS that employee

Clients may also subscribe to their own user channel implicitly — the
Centrifugo user-limited channel `priv:#{user_id}` is covered by the
connection token, no subscribe call needed.
"""

import re
import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import centrifugo
from app.core.database import get_db
from app.core.exceptions import AppError
from app.dependencies.auth import get_current_user
from app.models.property import Property
from app.models.user import User, UserRole

router = APIRouter(prefix="/realtime", tags=["realtime"])

_TOPIC = "|".join(centrifugo.CHANNEL_RE_PARTS.values())
_CHAN_RE = re.compile(
    rf"^{centrifugo.PRIVATE_NS}:(prop:([0-9a-f-]{{36}}):(?:{_TOPIC})"
    rf"|emp:([0-9a-f-]{{36}}))$"
)


class RealtimeUnavailable(AppError):
    status_code = 503
    code = "REALTIME_UNAVAILABLE"
    message = "Real-time delivery is not configured."


class Forbidden(AppError):
    status_code = 403
    code = "FORBIDDEN"
    message = "You do not have permission to perform this action."


class ChannelDenied(AppError):
    status_code = 403
    code = "CHANNEL_DENIED"
    message = "You are not authorized for one or more channels."


class SubscribeRequest(BaseModel):
    channels: list[str] = Field(min_length=1, max_length=20)


@router.get("/token")
async def realtime_token(user: User = Depends(get_current_user)):
    """Connection JWT — short-lived; client renews via this endpoint."""
    if not centrifugo.configured():
        raise RealtimeUnavailable()
    token, exp = centrifugo.connection_token(user)
    return {
        "token": token,
        "expires_at": exp,
        "ws_url": centrifugo.ws_url(),
    }


@router.post("/subscribe")
async def subscribe(
    payload: SubscribeRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Validate each requested channel against the caller's server-side
    scope, then mint per-channel subscription JWTs."""
    if not centrifugo.configured():
        raise RealtimeUnavailable()

    prop_ids: set[uuid.UUID] = set()
    for ch in payload.channels:
        m = _CHAN_RE.match(ch)
        if m is None:
            raise ChannelDenied(f"Unknown channel pattern: {ch[:40]}")
        if m.group(2) is not None:
            prop_ids.add(uuid.UUID(m.group(2)))
        else:
            # priv:emp:{eid} — self only
            if user.employee_id != uuid.UUID(m.group(3)):
                raise ChannelDenied()

    if prop_ids:
        if user.role == UserRole.SUPER_ADMIN:
            res = await session.execute(
                select(Property.id).where(
                    Property.id.in_(prop_ids),
                    Property.company_id == user.company_id,
                )
            )
            allowed = set(res.scalars())
        else:
            allowed = {user.property_id} & prop_ids
        if allowed != prop_ids:
            raise ChannelDenied()

    tokens = {}
    for ch in payload.channels:
        tokens[ch], exp = centrifugo.subscription_token(user, ch)
    return {"tokens": tokens, "expires_at": exp}
