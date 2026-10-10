"""Employee live locations & route history — Super Admin only.

Thin proxy over the Employee Backend's service-to-service endpoints;
LOCATION_SERVICE_API_KEY is injected server-side and never leaves this
process — the browser only ever sees these routes' responses.

  GET /live-locations                          snapshot (optional
                                               employee/property/zone
                                               filters + stale lookup)
  GET /live-locations/{employee_uid}           one employee, live or stale
  GET /live-locations/{employee_uid}/history   time-ranged route

Tenant scope: every supplied employee/property/zone UUID is verified
against the caller's company before anything is forwarded upstream.
"""

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.exceptions import AppError
from app.dependencies.auth import require_property_manager
from app.models.employee import Employee
from app.models.property import Property
from app.models.structure import Zone
from app.models.user import User
from app.services import live_location
from app.services.attendance import current_work_statuses

router = APIRouter(tags=["live-locations"])


class LocationScopeNotFound(AppError):
    status_code = status.HTTP_404_NOT_FOUND
    code = "NOT_FOUND"
    message = "The requested resource was not found."


async def _assert_company_scope(
    session: AsyncSession,
    user: User,
    *,
    employee_id: uuid.UUID | None = None,
    property_id: uuid.UUID | None = None,
    zone_id: uuid.UUID | None = None,
) -> None:
    """Every scoped id must belong to the caller's company — never forward
    a foreign-tenant filter upstream. Property managers are further pinned
    to their own property. 404 (not 403) so a bad id reveals nothing about
    other tenants."""
    from app.models.user import UserRole

    is_sa = user.role == UserRole.SUPER_ADMIN
    if employee_id is not None:
        cond = [Employee.id == employee_id,
                Employee.company_id == user.company_id]
        if not is_sa:
            cond.append(Employee.property_id == user.property_id)
        found = await session.scalar(select(Employee.id).where(*cond))
        if found is None:
            raise LocationScopeNotFound("Employee not found.")
    if property_id is not None:
        if not is_sa and property_id != user.property_id:
            raise LocationScopeNotFound("Property not found.")
        found = await session.scalar(
            select(Property.id).where(
                Property.id == property_id,
                Property.company_id == user.company_id,
            )
        )
        if found is None:
            raise LocationScopeNotFound("Property not found.")
    if zone_id is not None:
        found = await session.scalar(
            select(Zone.id)
            .join(Property, Zone.property_id == Property.id)
            .where(Zone.id == zone_id, Property.company_id == user.company_id)
        )
        zone = None
        if found is not None and not is_sa:
            # PM's zone must live inside their own property
            zone = await session.scalar(
                select(Zone.property_id).where(Zone.id == zone_id)
            )
            if zone != user.property_id:
                found = None
        if found is None:
            raise LocationScopeNotFound("Zone not found.")


_UNKNOWN_WORK_STATUS = {"state": "unknown", "label": "Unknown"}


async def _attach_work_status(
    session: AsyncSession, user: User, locations: list[dict]
) -> None:
    """Decorate each location with the employee's attendance-derived work
    status. GPS activity alone never implies "working" — attendance
    day/break rows are the only source of truth; unresolved entries
    stay "unknown"."""
    ids = []
    for loc in locations:
        try:
            ids.append(uuid.UUID(loc["employee_id"]))
        except (KeyError, TypeError, ValueError):
            continue
    statuses = await current_work_statuses(session, user, ids)
    for loc in locations:
        try:
            uid = uuid.UUID(loc["employee_id"])
        except (KeyError, TypeError, ValueError):
            uid = None
        loc["work_status"] = (
            statuses.get(uid, dict(_UNKNOWN_WORK_STATUS))
            if uid is not None
            else dict(_UNKNOWN_WORK_STATUS)
        )


# Only staff with an open attendance day — clocked in and not yet clocked
# out — may appear on the live map. "on_break" still counts: the break is
# inside an active shift. GPS activity alone is never enough.
_ON_DUTY_STATES = frozenset({"working", "on_break"})


def _is_on_duty(loc: dict) -> bool:
    return (loc.get("work_status") or {}).get("state") in _ON_DUTY_STATES


@router.get("/live-locations")
async def get_live_locations(
    employee_id: uuid.UUID | None = None,
    property_id: uuid.UUID | None = None,
    zone_id: uuid.UUID | None = None,
    is_active: bool = True,
    user: User = Depends(require_property_manager),
    session: AsyncSession = Depends(get_db),
):
    """Snapshot of reporting employees. `is_active=false` requires
    `employee_id` and returns a stale (null-coordinate) entry after the
    fix has expired — the service enforces the same rule as upstream.
    Property managers are always pinned to their own property."""
    from app.models.user import UserRole

    await _assert_company_scope(
        session,
        user,
        employee_id=employee_id,
        property_id=property_id,
        zone_id=zone_id,
    )
    # PMs are pinned to their own property — scope-check above already
    # rejected an explicitly foreign id; absent filter defaults to theirs.
    if user.role != UserRole.SUPER_ADMIN:
        property_id = user.property_id
    data = await live_location.fetch_live_locations(
        employee_id=str(employee_id) if employee_id else None,
        property_id=str(property_id) if property_id else None,
        zone_id=str(zone_id) if zone_id else None,
        is_active=is_active,
    )
    locations = data.get("locations") or []
    await _attach_work_status(session, user, locations)
    data["locations"] = [loc for loc in locations if _is_on_duty(loc)]
    return data


@router.get("/live-locations/{employee_uid}")
async def get_live_location(
    employee_uid: uuid.UUID,
    user: User = Depends(require_property_manager),
    session: AsyncSession = Depends(get_db),
):
    """One employee's latest entry — live or stale (is_active=false lookup
    upstream). {"location": null} when the employee has never reported."""
    await _assert_company_scope(session, user, employee_id=employee_uid)
    payload = await live_location.fetch_live_locations(
        employee_id=str(employee_uid), is_active=False
    )
    locations = payload.get("locations") or []
    await _attach_work_status(session, user, locations)
    loc = locations[0] if locations else None
    return {"location": loc if loc is not None and _is_on_duty(loc) else None}


@router.get("/live-locations/{employee_uid}/history")
async def get_location_history(
    employee_uid: uuid.UUID,
    from_dt: datetime = Query(alias="from"),
    to_dt: datetime = Query(alias="to"),
    tracking_session_id: uuid.UUID | None = None,
    max_points: int = Query(default=10_000, ge=1, le=100_000),
    user: User = Depends(require_property_manager),
    session: AsyncSession = Depends(get_db),
):
    """Time-ranged route for one employee. `from`/`to` are ISO-8601
    datetimes; the service enforces to>from and a 31-day maximum span."""
    await _assert_company_scope(session, user, employee_id=employee_uid)
    return await live_location.fetch_location_history(
        str(employee_uid),
        from_dt,
        to_dt,
        tracking_session_id=str(tracking_session_id) if tracking_session_id else None,
        max_points=max_points,
    )
