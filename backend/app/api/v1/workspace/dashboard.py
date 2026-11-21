"""Workspace API — property dashboard (one bounded aggregate)."""
import uuid
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.user import User
from app.services.dashboard import PERIOD_KEYS, DashboardService
from app.services.structure import ValidationErr

from ._common import Staff

router = APIRouter()


@router.get("/properties/{property_id}/dashboard")
async def property_dashboard(
    response: Response,
    property_id: uuid.UUID,
    period: Literal["today", "yesterday", "last_7_days", "last_30_days", "last_90_days",
                       "this_month", "last_month", "last_6_months", "custom"] = "today",
    from_: date | None = Query(None, alias="from"),
    to: date | None = None,
    granularity: Literal["day", "week", "month"] = "day",
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    response.headers["Cache-Control"] = "private, no-store"
    if period not in PERIOD_KEYS:
        raise HTTPException(status_code=422, detail="unknown period")
    try:
        return await DashboardService(session).summary(
            user, property_id, period=period, custom_from=from_, custom_to=to,
            granularity=granularity,
        )
    except ValueError as exc:
        raise ValidationErr(str(exc)) from exc
