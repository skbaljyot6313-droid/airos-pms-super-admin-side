"""Shift management — super_admin + scoped property_manager.

Shift definitions are per-property; PMs are pinned to their own
property, super_admins may manage any property in their company.
Assignments keep effective-date windows so historical attendance metrics
stay stable when schedules change.
"""

import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.dependencies.auth import require_property_manager
from app.models.user import User
from app.services.shifts import (
    ShiftService,
    assignment_out,
    shift_out,
)

router = APIRouter(tags=["shifts"])

Staff = Depends(require_property_manager)


class ShiftBody(BaseModel):
    property_uid: uuid.UUID
    name: str = Field(min_length=1, max_length=120)
    start_time: str  # 'HH:MM' IST
    end_time: str
    grace_minutes: int = Field(default=10, ge=0, le=720)
    early_exit_minutes: int = Field(default=0, ge=0, le=720)
    working_days: str = "1111111"


class ShiftPatch(BaseModel):
    name: str | None = None
    start_time: str | None = None
    end_time: str | None = None
    grace_minutes: int | None = Field(default=None, ge=0, le=720)
    early_exit_minutes: int | None = Field(default=None, ge=0, le=720)
    working_days: str | None = None
    is_active: bool | None = None


class AssignBody(BaseModel):
    shift_uid: uuid.UUID
    effective_from: str  # 'YYYY-MM-DD' IST op-day key
    effective_until: str | None = None


class AssignmentPatch(BaseModel):
    effective_until: str | None = None
    clear_until: bool = False


@router.get("/shifts")
async def list_shifts(
    property_id: uuid.UUID | None = None,
    include_inactive: bool = False,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    shifts = await ShiftService(session).list_shifts(
        user, property_id, include_inactive=include_inactive
    )
    return {"items": [shift_out(s) for s in shifts]}


@router.post("/shifts", status_code=201)
async def create_shift(
    body: ShiftBody,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    shift = await ShiftService(session).create_shift(
        user,
        property_id=body.property_uid,
        name=body.name,
        start_time=body.start_time,
        end_time=body.end_time,
        grace_minutes=body.grace_minutes,
        early_exit_minutes=body.early_exit_minutes,
        working_days=body.working_days,
    )
    return shift_out(shift)


@router.patch("/shifts/{shift_uid}")
async def update_shift(
    shift_uid: uuid.UUID,
    body: ShiftPatch,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    shift = await ShiftService(session).update_shift(
        user, shift_uid, **body.model_dump(exclude_unset=True)
    )
    return shift_out(shift)


@router.get("/employees/{employee_uid}/shift-assignments")
async def list_assignments(
    employee_uid: uuid.UUID,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    rows = await ShiftService(session).list_assignments(user, employee_uid)
    return {"items": [assignment_out(a, s) for a, s in rows]}


@router.post("/employees/{employee_uid}/shift-assignments", status_code=201)
async def assign_shift(
    employee_uid: uuid.UUID,
    body: AssignBody,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    a = await ShiftService(session).assign_shift(
        user,
        employee_uid,
        shift_uid=body.shift_uid,
        effective_from=body.effective_from,
        effective_until=body.effective_until,
    )
    return assignment_out(a, None)


@router.get("/shift-assignments")
async def list_current_assignments(
    property_id: uuid.UUID | None = None,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    """Every property employee's currently effective assignment — the
    shift board renders containers from this. `exempt_employee_uids`
    are SA/PM-linked staff who work 24×7 and carry no shift."""
    rows, exempt = await ShiftService(session).list_current_assignments(
        user, property_id
    )
    return {
        "items": [assignment_out(a, s) for a, s in rows],
        "exempt_employee_uids": [str(e) for e in exempt],
    }


@router.patch("/shift-assignments/{assignment_uid}")
async def update_assignment(
    assignment_uid: uuid.UUID,
    body: AssignmentPatch,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    a = await ShiftService(session).update_assignment(
        user,
        assignment_uid,
        effective_until=body.effective_until,
        clear_until=body.clear_until,
    )
    return assignment_out(a, None)


@router.delete("/shift-assignments/{assignment_uid}", status_code=204)
async def delete_assignment(
    assignment_uid: uuid.UUID,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    """Remove an assignment that starts today or later — enables
    same-day reassignment on the board without overlap conflicts."""
    await ShiftService(session).delete_assignment(user, assignment_uid)
