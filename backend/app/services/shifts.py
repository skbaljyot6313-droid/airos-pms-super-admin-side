"""Shift definitions + employee assignments — scheduling authority.

Shifts are reusable per-property templates carrying IST wall-clock
times; `end_time <= start_time` denotes an overnight shift whose window
ends on the following calendar day. Assignments carry inclusive
effective-date keys (IST 'YYYY-MM-DD', the same op-day vocabulary as
attendance_days) so metrics always evaluate the schedule that was in
force on the date being measured — current assignments never rewrite
history.

Scope: super_admin manages shifts for any property in their company;
property_manager is pinned to their own property. Employee/assignment
rows are always validated against that property/company before use.
"""

import uuid
from datetime import date, datetime, time, timedelta, timezone
from typing import Iterable
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.employee import Employee
from app.models.property import Property
from app.models.shift import EmployeeShiftAssignment, Shift
from app.models.user import User, UserRole
from app.services.audit import AuditService
from app.services.structure import ConflictErr, NotFoundErr, ValidationErr

IST = ZoneInfo("Asia/Kolkata")


def shift_out(s: Shift) -> dict:
    return {
        "shift_uid": str(s.id),
        "property_uid": str(s.property_id),
        "name": s.name,
        "start_time": s.start_time.strftime("%H:%M"),
        "end_time": s.end_time.strftime("%H:%M"),
        "overnight": s.end_time <= s.start_time,
        "grace_minutes": s.grace_minutes,
        "early_exit_minutes": s.early_exit_minutes,
        "working_days": s.working_days,
        "is_active": s.is_active,
        "created_at": s.created_at.isoformat() if s.created_at else None,
    }


def assignment_out(a: EmployeeShiftAssignment, shift: Shift | None) -> dict:
    return {
        "assignment_uid": str(a.id),
        "employee_uid": str(a.employee_id),
        "shift_uid": str(a.shift_id),
        "shift_name": shift.name if shift else None,
        "effective_from": a.effective_from,
        "effective_until": a.effective_until,
        "created_by_name": a.created_by_name,
        "created_at": a.created_at.isoformat() if a.created_at else None,
    }


def _validate_time(value: str, field: str) -> time:
    try:
        hh, mm = (int(p) for p in (value or "").split(":"))
        if not (0 <= hh <= 23 and 0 <= mm <= 59):
            raise ValueError
        return time(hh, mm)
    except (ValueError, AttributeError):
        raise ValidationErr(f"{field} must be 'HH:MM'.", field=field)


def _validate_op_date(value: str | None, field: str) -> str:
    """Strict 'YYYY-MM-DD' op-day key — matches the EB convention."""
    s = (value or "").strip()
    try:
        parsed = datetime.strptime(s, "%Y-%m-%d")
    except (ValueError, TypeError):
        raise ValidationErr(f"{field} must be 'YYYY-MM-DD'.", field=field)
    if parsed.strftime("%Y-%m-%d") != s:
        raise ValidationErr(f"{field} must be 'YYYY-MM-DD'.", field=field)
    return s


def _validate_working_days(value: str) -> str:
    s = (value or "").strip()
    if len(s) != 7 or any(c not in "01" for c in s):
        raise ValidationErr(
            "working_days must be a 7-char '0'/'1' bitmap, Monday first.",
            field="working_days",
        )
    if "1" not in s:
        raise ValidationErr(
            "A shift must apply to at least one weekday.",
            field="working_days",
        )
    return s


def shift_applies_on(shift: Shift, op_date: str) -> bool:
    """True when the shift is scheduled for this IST op-day (weekday bitmap)."""
    try:
        weekday = date.fromisoformat(op_date).weekday()  # Mon=0
    except ValueError:
        return False
    return shift.working_days[weekday] == "1"


def shift_window_utc(shift: Shift, op_date: str) -> tuple[datetime, datetime]:
    """Aware-UTC [start, end) instants of the shift for one op-day.

    Overnight shifts (end_time <= start_time) end the following calendar
    day. Because attendance_date keys are IST wall-clock op-days, the
    window is anchored on the IST calendar date — the company's
    operational_day_start does not shift the wall-clock shift itself.
    """
    d = date.fromisoformat(op_date)
    start = datetime.combine(d, shift.start_time, IST)
    end_d = d + timedelta(days=1) if shift.end_time <= shift.start_time else d
    end = datetime.combine(end_d, shift.end_time, IST)
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc)


async def effective_assignments(
    session: AsyncSession,
    employee_ids: Iterable[uuid.UUID],
    op_date: str,
) -> dict[uuid.UUID, tuple[EmployeeShiftAssignment, Shift]]:
    """The assignment in force on `op_date` for each employee.

    An assignment applies when effective_from <= op_date and
    (effective_until IS NULL or effective_until >= op_date). The latest
    effective_from wins; overlap validation keeps at most one anyway.
    Inactive shifts still resolve — a deactivated definition remains
    historically accurate for the days it covered.
    """
    ids = set(employee_ids)
    if not ids:
        return {}
    res = await session.execute(
        select(EmployeeShiftAssignment, Shift)
        .join(Shift, EmployeeShiftAssignment.shift_id == Shift.id)
        .where(
            EmployeeShiftAssignment.employee_id.in_(ids),
            EmployeeShiftAssignment.effective_from <= op_date,
            (EmployeeShiftAssignment.effective_until.is_(None))
            | (EmployeeShiftAssignment.effective_until >= op_date),
        )
        .order_by(
            EmployeeShiftAssignment.effective_from.desc(),
            EmployeeShiftAssignment.created_at.desc(),
        )
    )
    out: dict[uuid.UUID, tuple[EmployeeShiftAssignment, Shift]] = {}
    for a, s in res.all():
        out.setdefault(a.employee_id, (a, s))
    return out


class ShiftService:
    def __init__(self, session: AsyncSession):
        self.session = session

    # -- scope ----------------------------------------------------------

    async def _property(
        self, user: User, property_id: uuid.UUID | None
    ) -> Property:
        """SA picks any company property; PM is pinned to their own."""
        pid = (
            property_id
            if user.role == UserRole.SUPER_ADMIN
            else user.property_id
        )
        if pid is None:
            raise ValidationErr("property_id is required.")
        prop = await self.session.scalar(
            select(Property).where(
                Property.id == pid,
                Property.company_id == user.company_id,
            )
        )
        if prop is None:
            raise NotFoundErr("Property not found.")
        return prop

    async def _employee(
        self, user: User, employee_uid: uuid.UUID
    ) -> Employee:
        emp = await self.session.scalar(
            select(Employee).where(
                Employee.id == employee_uid,
                Employee.company_id == user.company_id,
            )
        )
        if emp is None:
            raise NotFoundErr("Employee not found.")
        if user.role != UserRole.SUPER_ADMIN and (
            user.property_id is not None
            and emp.property_id != user.property_id
        ):
            raise NotFoundErr("Employee not found.")
        return emp

    async def _shift_in_scope(
        self, user: User, shift_uid: uuid.UUID
    ) -> Shift:
        shift = await self.session.scalar(
            select(Shift).where(
                Shift.id == shift_uid,
                Shift.company_id == user.company_id,
            )
        )
        if shift is None:
            raise NotFoundErr("Shift not found.")
        if user.role != UserRole.SUPER_ADMIN and (
            user.property_id is not None
            and shift.property_id != user.property_id
        ):
            raise NotFoundErr("Shift not found.")
        return shift

    # -- shift definitions ----------------------------------------------

    async def list_shifts(
        self,
        user: User,
        property_id: uuid.UUID | None,
        *,
        include_inactive: bool = False,
    ) -> list[Shift]:
        prop = await self._property(user, property_id)
        q = select(Shift).where(Shift.property_id == prop.id)
        if not include_inactive:
            q = q.where(Shift.is_active.is_(True))
        res = await self.session.execute(q.order_by(Shift.name))
        return list(res.scalars())

    async def create_shift(
        self,
        user: User,
        *,
        property_id: uuid.UUID,
        name: str,
        start_time: str,
        end_time: str,
        grace_minutes: int = 10,
        early_exit_minutes: int = 0,
        working_days: str = "1111111",
    ) -> Shift:
        prop = await self._property(user, property_id)
        shift = Shift(
            company_id=prop.company_id,
            property_id=prop.id,
            name=(name or "").strip() or "Shift",
            start_time=_validate_time(start_time, "start_time"),
            end_time=_validate_time(end_time, "end_time"),
            grace_minutes=max(0, min(grace_minutes, 720)),
            early_exit_minutes=max(0, min(early_exit_minutes, 720)),
            working_days=_validate_working_days(working_days),
            is_active=True,
        )
        self.session.add(shift)
        AuditService(self.session).record(
            user,
            entity_type="shift",
            entity_id=shift.id,
            entity_name=shift.name,
            action="shift_created",
            property_id=prop.id,
            detail={
                "start_time": start_time,
                "end_time": end_time,
                "working_days": shift.working_days,
            },
        )
        await self.session.commit()
        return shift

    async def update_shift(
        self, user: User, shift_uid: uuid.UUID, **fields
    ) -> Shift:
        shift = await self._shift_in_scope(user, shift_uid)
        if "name" in fields and fields["name"] is not None:
            shift.name = fields["name"].strip() or shift.name
        if fields.get("start_time") is not None:
            shift.start_time = _validate_time(
                fields["start_time"], "start_time"
            )
        if fields.get("end_time") is not None:
            shift.end_time = _validate_time(fields["end_time"], "end_time")
        if fields.get("grace_minutes") is not None:
            shift.grace_minutes = max(0, min(fields["grace_minutes"], 720))
        if fields.get("early_exit_minutes") is not None:
            shift.early_exit_minutes = max(
                0, min(fields["early_exit_minutes"], 720)
            )
        if fields.get("working_days") is not None:
            shift.working_days = _validate_working_days(
                fields["working_days"]
            )
        if fields.get("is_active") is not None:
            shift.is_active = bool(fields["is_active"])
        AuditService(self.session).record(
            user,
            entity_type="shift",
            entity_id=shift.id,
            entity_name=shift.name,
            action="shift_updated",
            property_id=shift.property_id,
            detail={
                k: (str(v) if isinstance(v, (time,)) else v)
                for k, v in fields.items()
                if v is not None
            },
        )
        await self.session.commit()
        return shift

    # -- assignments ------------------------------------------------------

    async def list_assignments(
        self, user: User, employee_uid: uuid.UUID
    ) -> list[tuple[EmployeeShiftAssignment, Shift]]:
        await self._employee(user, employee_uid)
        res = await self.session.execute(
            select(EmployeeShiftAssignment, Shift)
            .join(Shift, EmployeeShiftAssignment.shift_id == Shift.id)
            .where(EmployeeShiftAssignment.employee_id == employee_uid)
            .order_by(EmployeeShiftAssignment.effective_from.desc())
        )
        return list(res.all())

    async def schedule_exempt_employees(
        self, employee_ids: Iterable[uuid.UUID]
    ) -> set[uuid.UUID]:
        """Employees linked to super_admin / property_manager logins —
        management staff work 24×7 by default and carry no shift."""
        ids = list(employee_ids)
        if not ids:
            return set()
        res = await self.session.execute(
            select(User.employee_id).where(
                User.employee_id.in_(ids),
                User.role.in_(
                    [UserRole.SUPER_ADMIN, UserRole.PROPERTY_MANAGER]
                ),
            )
        )
        return {e for e in res.scalars() if e is not None}

    async def list_current_assignments(
        self, user: User, property_id: uuid.UUID | None
    ) -> tuple[list[tuple[EmployeeShiftAssignment, Shift]], set[uuid.UUID]]:
        """(Current assignment, exempt ids) per property employee.

        One query for the board view — employees absent from the result
        have no current assignment. Exempt employees are SA/PM-linked
        accounts: always on duty, never scheduled.
        """
        prop = await self._property(user, property_id)
        emp_ids = list(
            (
                await self.session.execute(
                    select(Employee.id).where(
                        Employee.property_id == prop.id
                    )
                )
            ).scalars().all()
        )
        today = datetime.now(IST).date().isoformat()
        eff = await effective_assignments(self.session, emp_ids, today)
        exempt = await self.schedule_exempt_employees(emp_ids)
        return list(eff.values()), exempt

    async def assign_shift(
        self,
        user: User,
        employee_uid: uuid.UUID,
        *,
        shift_uid: uuid.UUID,
        effective_from: str,
        effective_until: str | None = None,
    ) -> EmployeeShiftAssignment:
        emp = await self._employee(user, employee_uid)
        shift = await self._shift_in_scope(user, shift_uid)
        if shift.property_id != emp.property_id:
            raise ValidationErr(
                "The shift belongs to a different property.",
                field="shift_uid",
            )
        from_key = _validate_op_date(effective_from, "effective_from")
        until_key = (
            _validate_op_date(effective_until, "effective_until")
            if effective_until
            else None
        )
        if until_key is not None and until_key < from_key:
            raise ValidationErr(
                "effective_until must be on or after effective_from.",
                field="effective_until",
            )
        # No overlapping windows for one employee — same convention as the
        # attendance-request overlap check (409, app-level).
        res = await self.session.execute(
            select(EmployeeShiftAssignment).where(
                EmployeeShiftAssignment.employee_id == emp.id,
                EmployeeShiftAssignment.effective_from
                <= (until_key or "9999-12-31"),
                (EmployeeShiftAssignment.effective_until.is_(None))
                | (EmployeeShiftAssignment.effective_until >= from_key),
            )
        )
        if res.scalars().first() is not None:
            raise ConflictErr(
                "An existing assignment overlaps this date range — "
                "end or edit it first.",
                code="OVERLAPPING_ASSIGNMENT",
            )
        a = EmployeeShiftAssignment(
            employee_id=emp.id,
            shift_id=shift.id,
            effective_from=from_key,
            effective_until=until_key,
            created_by_id=user.id,
            created_by_name=user.name,
        )
        self.session.add(a)
        AuditService(self.session).record(
            user,
            entity_type="employee_shift_assignment",
            entity_id=a.id,
            entity_name=emp.name,
            action="shift_assigned",
            property_id=emp.property_id,
            detail={
                "shift_uid": str(shift.id),
                "shift_name": shift.name,
                "effective_from": from_key,
                "effective_until": until_key,
            },
        )
        await self.session.commit()
        return a

    async def update_assignment(
        self,
        user: User,
        assignment_uid: uuid.UUID,
        *,
        effective_until: str | None = None,
        clear_until: bool = False,
    ) -> EmployeeShiftAssignment:
        a = await self.session.scalar(
            select(EmployeeShiftAssignment).where(
                EmployeeShiftAssignment.id == assignment_uid
            )
        )
        if a is None:
            raise NotFoundErr("Assignment not found.")
        emp = await self._employee(user, a.employee_id)  # scope check
        if clear_until:
            a.effective_until = None
        elif effective_until is not None:
            until_key = _validate_op_date(
                effective_until, "effective_until"
            )
            if until_key < a.effective_from:
                raise ValidationErr(
                    "effective_until must be on or after effective_from.",
                    field="effective_until",
                )
            a.effective_until = until_key
        AuditService(self.session).record(
            user,
            entity_type="employee_shift_assignment",
            entity_id=a.id,
            entity_name=None,
            action="shift_assignment_updated",
            property_id=emp.property_id,
            detail={
                "effective_from": a.effective_from,
                "effective_until": a.effective_until,
            },
        )
        await self.session.commit()
        return a

    async def delete_assignment(
        self, user: User, assignment_uid: uuid.UUID
    ) -> None:
        """Remove an assignment that covers no worked history.

        Only assignments starting today or later may be deleted — a
        past-dated window must be closed via effective_until so the
        historical record stays intact.
        """
        a = await self.session.scalar(
            select(EmployeeShiftAssignment).where(
                EmployeeShiftAssignment.id == assignment_uid
            )
        )
        if a is None:
            raise NotFoundErr("Assignment not found.")
        emp = await self._employee(user, a.employee_id)  # scope check
        today = datetime.now(IST).date().isoformat()
        if a.effective_from < today:
            raise ConflictErr(
                "This assignment already covers past days — end it via "
                "effective_until instead of deleting it.",
                code="ASSIGNMENT_HAS_HISTORY",
            )
        AuditService(self.session).record(
            user,
            entity_type="employee_shift_assignment",
            entity_id=a.id,
            entity_name=emp.name,
            action="shift_assignment_deleted",
            property_id=emp.property_id,
            detail={"shift_uid": str(a.shift_id)},
        )
        await self.session.delete(a)
        await self.session.commit()
