import re
import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.exceptions import AppError
from app.models.user import User
from app.schemas import workspace as ws
from app.schemas.structure import (
    EmployeeAllocationRequest,
    EmployeeAreaAssignRequest,
    EmployeeCreateRequest,
    EmployeeUpdateRequest,
    EmployeeZoneAssignRequest,
)
from app.services.employee import _UNSET, EmployeeService
from app.services.employee_profile import EmployeeProfileService

from ._common import Staff

router = APIRouter()


# ------------------------------- Employees --------------------------------

class InvalidDateRange(AppError):
    status_code = status.HTTP_422_UNPROCESSABLE_CONTENT
    code = "INVALID_DATE_RANGE"


def _validate_date_range(date_from: datetime | None, date_to: datetime | None) -> None:
    if any(v is not None and v.utcoffset() is None for v in (date_from, date_to)):
        raise InvalidDateRange("Date filters must include a timezone.")
    if date_from and date_to and date_from >= date_to:
        raise InvalidDateRange("The end date must be after the start date.")


@router.get("/employees/{employee_id}/profile")
async def employee_profile(
    employee_id: uuid.UUID, response: Response, property_id: uuid.UUID | None = None,
    date_from: datetime | None = None, date_to: datetime | None = None,
    user: User = Staff, session: AsyncSession = Depends(get_db),
):
    _validate_date_range(date_from, date_to)
    response.headers["Cache-Control"] = "private, no-store"
    return await EmployeeProfileService(session).profile(
        user, employee_id, property_id, date_from=date_from, date_to=date_to)


@router.get("/employees/{employee_id}/tasks")
async def employee_task_history(
    employee_id: uuid.UUID, response: Response, property_id: uuid.UUID | None = None,
    filter: Literal["all", "allocated", "completed", "abandoned", "rejected", "pending_review", "current_open"] = "all",
    search: str | None = Query(None, max_length=200),
    page: int = Query(1, ge=1, le=100000), limit: int = Query(25, ge=1, le=100),
    date_from: datetime | None = None, date_to: datetime | None = None,
    user: User = Staff, session: AsyncSession = Depends(get_db),
):
    _validate_date_range(date_from, date_to)
    response.headers["Cache-Control"] = "private, no-store"
    return await EmployeeProfileService(session).tasks(
        user, employee_id, property_id=property_id, filter=filter, search=search, page=page,
        limit=limit, date_from=date_from, date_to=date_to)


@router.get("/employees/{employee_id}/analytics")
async def employee_analytics(
    employee_id: uuid.UUID, response: Response, property_id: uuid.UUID | None = None,
    date_from: datetime | None = None, date_to: datetime | None = None,
    bucket: Literal["day", "week", "month"] = "day",
    user: User = Staff, session: AsyncSession = Depends(get_db),
):
    _validate_date_range(date_from, date_to)
    response.headers["Cache-Control"] = "private, no-store"
    return await EmployeeProfileService(session).analytics(
        user, employee_id, property_id=property_id, date_from=date_from,
        date_to=date_to, bucket=bucket)


@router.get("/employees/{employee_id}/records")
async def employee_records(
    employee_id: uuid.UUID, response: Response, kind: Literal["attendance", "leaves", "shifts", "allocations", "submissions", "maintenance"],
    property_id: uuid.UUID | None = None,
    page: int = Query(1, ge=1, le=100000), limit: int = Query(25, ge=1, le=100),
    date_from: datetime | None = None, date_to: datetime | None = None,
    direction: Literal["received", "away"] | None = None,
    ticket_kind: Literal["task", "maintenance"] | None = None,
    user: User = Staff, session: AsyncSession = Depends(get_db),
):
    _validate_date_range(date_from, date_to)
    response.headers["Cache-Control"] = "private, no-store"
    return await EmployeeProfileService(session).records(
        user, employee_id, property_id=property_id, kind=kind, page=page, limit=limit,
        date_from=date_from, date_to=date_to, direction=direction, ticket_kind=ticket_kind)


@router.get("/employees/{employee_id}/locations")
async def employee_locations(
    employee_id: uuid.UUID, response: Response, property_id: uuid.UUID | None = None,
    date_from: datetime | None = None, date_to: datetime | None = None,
    user: User = Staff, session: AsyncSession = Depends(get_db),
):
    _validate_date_range(date_from, date_to)
    response.headers["Cache-Control"] = "private, no-store"
    return await EmployeeProfileService(session).locations(
        user, employee_id, property_id=property_id,
        date_from=date_from, date_to=date_to)


@router.get("/employees/{employee_id}/attendance/calendar")
async def employee_attendance_calendar(
    employee_id: uuid.UUID, response: Response, month: str,
    property_id: uuid.UUID | None = None,
    user: User = Staff, session: AsyncSession = Depends(get_db),
):
    if not re.fullmatch(r"\d{4}-\d{2}", month) or not 1 <= int(month[5:7]) <= 12:
        raise InvalidDateRange("month must be YYYY-MM.")
    response.headers["Cache-Control"] = "private, no-store"
    return await EmployeeProfileService(session).attendance_calendar(
        user, employee_id, property_id=property_id, month=month)


@router.get("/employees/{employee_id}/attendance/day")
async def employee_attendance_day(
    employee_id: uuid.UUID, response: Response, date: str,
    property_id: uuid.UUID | None = None,
    user: User = Staff, session: AsyncSession = Depends(get_db),
):
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise InvalidDateRange("date must be YYYY-MM-DD.")
    response.headers["Cache-Control"] = "private, no-store"
    return await EmployeeProfileService(session).attendance_day(
        user, employee_id, property_id=property_id, day=date)


@router.get("/employees/team-analytics")
async def employees_team_analytics(
    response: Response, property_id: uuid.UUID | None = None,
    date_from: datetime | None = None, date_to: datetime | None = None,
    user: User = Staff, session: AsyncSession = Depends(get_db),
):
    _validate_date_range(date_from, date_to)
    response.headers["Cache-Control"] = "private, no-store"
    return await EmployeeProfileService(session).team_analytics(
        user, property_id=property_id, date_from=date_from, date_to=date_to)


@router.get("/employees/{employee_id}/devices")
async def employee_devices(
    employee_id: uuid.UUID, response: Response, property_id: uuid.UUID | None = None,
    user: User = Staff, session: AsyncSession = Depends(get_db),
):
    response.headers["Cache-Control"] = "private, no-store"
    return await EmployeeProfileService(session).devices(
        user, employee_id, property_id=property_id)


@router.post("/employees", status_code=status.HTTP_201_CREATED)
async def create_employee(
    payload: EmployeeCreateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ws.employee_out(
        await EmployeeService(session).create_employee(user, payload)
    )


@router.patch("/employees/{employee_id}")
async def update_employee(
    employee_id: uuid.UUID,
    payload: EmployeeUpdateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ws.employee_out(
        await EmployeeService(session).update_employee(user, employee_id, payload)
    )


def _assign_kwargs(payload) -> dict:
    """Map the assign payload to explicit directives — absent fields are
    _UNSET (left alone), explicit nulls clear, values set."""
    fields = payload.model_fields_set
    return {
        "zone_uid": payload.zone_uid if "zone_uid" in fields else _UNSET,
        "area_uid": payload.area_uid if "area_uid" in fields else _UNSET,
        "secondary_zone_uid": (
            payload.secondary_zone_uid
            if "secondary_zone_uid" in fields else _UNSET
        ),
        "property_wide": (
            payload.property_wide if "property_wide" in fields else None
        ),
    }


@router.patch("/employees/{employee_id}/zone")
async def assign_employee_zone(
    employee_id: uuid.UUID,
    payload: EmployeeZoneAssignRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ws.employee_out(
        await EmployeeService(session).assign(
            user, employee_id, **_assign_kwargs(payload),
        )
    )


@router.patch("/employees/{employee_id}/allocation")
async def allocate_employee(
    employee_id: uuid.UUID,
    payload: EmployeeAllocationRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ws.employee_out(
        await EmployeeService(session).assign(
            user, employee_id, **_assign_kwargs(payload),
        )
    )


@router.post("/employees/{employee_id}/areas")
async def add_employee_area(
    employee_id: uuid.UUID,
    payload: EmployeeAreaAssignRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ws.employee_out(
        await EmployeeService(session).add_area(
            user, employee_id, payload.area_uid
        )
    )


@router.delete("/employees/{employee_id}/areas/{area_uid}")
async def remove_employee_area(
    employee_id: uuid.UUID,
    area_uid: uuid.UUID,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ws.employee_out(
        await EmployeeService(session).remove_area(
            user, employee_id, area_uid
        )
    )


@router.post("/employees/{employee_id}/deactivate")
async def deactivate_employee(
    employee_id: uuid.UUID,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ws.employee_out(
        await EmployeeService(session).deactivate(user, employee_id)
    )


@router.post("/employees/{employee_id}/reactivate")
async def reactivate_employee(
    employee_id: uuid.UUID,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ws.employee_out(
        await EmployeeService(session).reactivate(user, employee_id)
    )


@router.delete("/employees/{employee_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_employee(
    employee_id: uuid.UUID,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    await EmployeeService(session).delete_employee(user, employee_id)


