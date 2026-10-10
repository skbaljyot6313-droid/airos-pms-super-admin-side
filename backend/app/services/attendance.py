"""Attendance review — Super Admin decides leave/week-off requests.

Requests are filed by employees in the employee application; this service
is the approval surface on the shared database. Approving stamps every
date in the inclusive [from..to] range with the request's day status so
the allocation pool sees the leave immediately.
"""

import logging
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Iterable

from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.attendance import (
    AttendanceBreak,
    AttendanceDay,
    AttendanceRequest,
    OPEN_REQUEST_STATUSES,
)
from app.models.employee import Employee
from app.models.property import Property
from app.models.user import User, UserRole
from app.services.audit import AuditService
from app.services.rollover import current_operational_day, parse_day_start
from app.services.shifts import (
    ShiftService,
    effective_assignments,
    shift_applies_on,
    shift_window_utc,
)
from app.services.structure import ConflictErr, NotFoundErr, ValidationErr

logger = logging.getLogger(__name__)


def _date_range(from_date: str, to_date: str) -> list[str]:
    """Inclusive IST 'YYYY-MM-DD' keys — ISO strings compare lexically."""
    start = date.fromisoformat(from_date)
    end = date.fromisoformat(to_date)
    if end < start:
        return []
    return [
        date.fromordinal(start.toordinal() + i).isoformat()
        for i in range((end - start).days + 1)
    ]


def request_out(r: AttendanceRequest) -> dict:
    return {
        "request_uid": str(r.id),
        "property_uid": str(r.property_id),
        "employee_uid": str(r.employee_id) if r.employee_id else None,
        "employee_name": r.employee_name,
        "from_date": r.from_date,
        "to_date": r.to_date,
        "request_type": r.request_type,
        "leave_type": r.leave_type,
        "reason": r.reason,
        "requested_days": r.requested_days,
        "status": r.status,
        "reviewed_by": r.reviewed_by_name,
        "reviewed_at": r.reviewed_at.isoformat() if r.reviewed_at else None,
        "review_comment": r.review_comment,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


class AttendanceService:
    def __init__(self, session: AsyncSession):
        self.session = session

    def _require_reviewer(self, user: User) -> None:
        """Leave/week-off review is staff-only: super_admin across the
        company, property_manager scoped to their own property."""
        from app.dependencies.auth import Forbidden

        if user.role not in (
            UserRole.SUPER_ADMIN, UserRole.PROPERTY_MANAGER
        ):
            raise Forbidden()

    async def list_requests(
        self, user: User, *, status: str | None = None
    ) -> list[AttendanceRequest]:
        """Review queue, newest first — company-wide for Super Admin,
        pinned to the manager's own property otherwise."""
        self._require_reviewer(user)
        q = (
            select(AttendanceRequest)
            .join(Property, AttendanceRequest.property_id == Property.id)
            .where(Property.company_id == user.company_id)
            .order_by(
                AttendanceRequest.created_at.desc(),
            )
        )
        if user.role != UserRole.SUPER_ADMIN:
            q = q.where(AttendanceRequest.property_id == user.property_id)
        if status:
            if status not in ("pending", "approved", "rejected", "cancelled"):
                raise ValidationErr("Unknown status filter.")
            q = q.where(AttendanceRequest.status == status)
        res = await self.session.execute(q)
        return list(res.scalars())

    async def _request_for_review(
        self, user: User, request_id: uuid.UUID
    ) -> AttendanceRequest:
        """FOR UPDATE lock + tenant scope. Cross-scope → 404, never a leak."""
        self._require_reviewer(user)
        res = await self.session.execute(
            select(AttendanceRequest)
            .where(AttendanceRequest.id == request_id)
            .with_for_update()
        )
        req = res.scalar_one_or_none()
        if req is None:
            raise NotFoundErr("Request not found.")
        prop = await self.session.get(Property, req.property_id)
        if prop is None or prop.company_id != user.company_id:
            raise NotFoundErr("Request not found.")
        if user.role != UserRole.SUPER_ADMIN \
                and req.property_id != user.property_id:
            raise NotFoundErr("Request not found.")
        return req

    async def _materialize_range(self, req: AttendanceRequest) -> None:
        """Stamp every date in [from..to] with the day status — 'leave' or
        'week_off'. One range SELECT up front (no N+1); existing days are
        updated in place, missing ones inserted. A worked/started day
        anywhere in the range aborts the approval, naming the date."""
        day_status = req.request_type  # 'leave' | 'week_off'
        res = await self.session.execute(
            select(AttendanceDay)
            .where(
                AttendanceDay.employee_id == req.employee_id,
                AttendanceDay.attendance_date >= req.from_date,
                AttendanceDay.attendance_date <= req.to_date,
            )
            .with_for_update()
        )
        by_date = {d.attendance_date: d for d in res.scalars()}
        for dstr in _date_range(req.from_date, req.to_date):
            day = by_date.get(dstr)
            if day is not None and (
                day.started_at is not None or day.status == "present"
            ):
                raise ConflictErr(
                    f"Cannot approve — {dstr} already has a workday on record."
                )
        for dstr in _date_range(req.from_date, req.to_date):
            day = by_date.get(dstr)
            if day is None:
                self.session.add(AttendanceDay(
                    property_id=req.property_id,
                    employee_id=req.employee_id,
                    employee_name=req.employee_name,
                    attendance_date=dstr,
                    status=day_status,
                ))
            else:
                day.status = day_status
        try:
            async with self.session.begin_nested():
                await self.session.flush()
        except IntegrityError as exc:
            # A concurrent workday start or approval won the
            # (employee, date) slot — surface as a conflict, never
            # half-materialize the range.
            raise ConflictErr(
                "Cannot approve — a workday was recorded inside the "
                "requested range."
            ) from exc

    async def review_request(
        self, user: User, request_id: uuid.UUID, *, approve: bool,
        review_comment: str | None = None,
    ) -> AttendanceRequest:
        req = await self._request_for_review(user, request_id)
        if req.status != "pending":
            raise ConflictErr(
                f"Only a pending request can be decided — this one is "
                f"{req.status}."
            )
        if approve:
            if req.employee_id is None:
                raise ConflictErr(
                    "The employee record no longer exists — reject the "
                    "request instead."
                )
            overlap = await self.session.execute(
                select(AttendanceRequest).where(
                    AttendanceRequest.employee_id == req.employee_id,
                    AttendanceRequest.id != req.id,
                    AttendanceRequest.from_date <= req.to_date,
                    AttendanceRequest.to_date >= req.from_date,
                    AttendanceRequest.status.in_(OPEN_REQUEST_STATUSES),
                )
            )
            if overlap.scalars().first() is not None:
                raise ConflictErr(
                    "Another pending or approved request overlaps these "
                    "dates — decide it first.",
                    code="OVERLAPPING_REQUEST",
                )
            await self._materialize_range(req)
        req.status = "approved" if approve else "rejected"
        req.reviewed_by_id = user.id
        req.reviewed_by_name = user.name
        req.reviewed_at = datetime.now(timezone.utc)
        req.review_comment = (review_comment or "").strip() or None
        AuditService(self.session).record(
            user,
            entity_type="attendance_request",
            entity_id=req.id,
            entity_name=req.employee_name,
            action=(
                f"{req.request_type}_approved" if approve
                else f"{req.request_type}_rejected"
            ),
            property_id=req.property_id,
            detail={
                "from_date": req.from_date,
                "to_date": req.to_date,
                "request_type": req.request_type,
                "leave_type": req.leave_type,
                "state": req.status,
            },
        )
        await self.session.commit()
        return req


# ----------------------------------------------------------------------
# Live "is this employee working right now" resolution
# ----------------------------------------------------------------------

# Distinct from GPS/tracking activity: a live location-tracking session
# only proves the app is reporting. Whether the employee is on duty comes
# from the employee-app-owned attendance tables — an open attendance day
# (started, not ended) is a shift in progress; an open break row on that
# day means they are on break; a closed or marked row for the current
# operational day means the shift ended or the day was a day off.
WORK_STATES = ("working", "on_break", "off_duty", "unknown")


async def current_work_statuses(
    session: AsyncSession,
    user: User,
    employee_ids: Iterable[uuid.UUID],
    *,
    now: datetime | None = None,
) -> dict[uuid.UUID, dict]:
    """Resolve the current work status for each given employee UUID.

    Company-scoped via the day row's property; only employees belonging
    to the caller's company are resolved — foreign IDs are simply absent
    from the result so callers can render "Unknown".
    """
    ids = set(employee_ids)
    if not ids or user.company_id is None:
        return {}

    from app.models.company import Company

    company = await session.get(Company, user.company_id)
    start = parse_day_start(
        company.operational_day_start if company else None
    )
    now_utc = now or datetime.now(timezone.utc)
    today = current_operational_day(now_utc, start)

    res = await session.execute(
        select(AttendanceDay)
        .join(Property, AttendanceDay.property_id == Property.id)
        .where(
            Property.company_id == user.company_id,
            AttendanceDay.employee_id.in_(ids),
            or_(
                and_(
                    AttendanceDay.started_at.is_not(None),
                    AttendanceDay.ended_at.is_(None),
                ),
                AttendanceDay.attendance_date == today,
            ),
        )
        .order_by(AttendanceDay.attendance_date.desc())
    )
    days: dict[uuid.UUID, list[AttendanceDay]] = {}
    for day in res.scalars():
        if day.employee_id is not None:
            days.setdefault(day.employee_id, []).append(day)

    open_day_ids = [
        d.id
        for ds in days.values()
        for d in ds
        if d.started_at is not None and d.ended_at is None
    ]
    open_breaks: dict[uuid.UUID, AttendanceBreak] = {}
    if open_day_ids:
        res = await session.execute(
            select(AttendanceBreak).where(
                AttendanceBreak.attendance_day_id.in_(open_day_ids),
                AttendanceBreak.ended_at.is_(None),
            )
        )
        for br in res.scalars():
            open_breaks.setdefault(br.attendance_day_id, br)

    def _iso(dt: datetime | None) -> str | None:
        return dt.isoformat() if dt is not None else None

    # A prior-day row still open is only legitimate when the employee's
    # shift *for that date* runs overnight and the scheduled end (plus a
    # carryover buffer) has not passed. Anything else is a stale
    # unclosed record — fail closed for floor visibility and flag it.
    today_key = today
    overnight_check: dict[uuid.UUID, AttendanceDay] = {}
    for emp_id, emp_days in days.items():
        for d in emp_days:
            if (
                d.started_at is not None
                and d.ended_at is None
                and d.attendance_date != today_key
            ):
                overnight_check[emp_id] = d
    overnight_ok: set[uuid.UUID] = set()
    stale_days: dict[uuid.UUID, AttendanceDay] = {}
    if overnight_check:
        prev_dates = {d.attendance_date for d in overnight_check.values()}
        assignments: dict[uuid.UUID, tuple] = {}
        for d_prev in prev_dates:
            for emp_id, pair in (
                await effective_assignments(
                    session,
                    [e for e, dd in overnight_check.items()
                     if dd.attendance_date == d_prev],
                    d_prev,
                )
            ).items():
                assignments[emp_id] = pair
        for emp_id, day in overnight_check.items():
            pair = assignments.get(emp_id)
            shift = pair[1] if pair else None
            valid = False
            if (
                shift is not None
                and shift_applies_on(shift, day.attendance_date)
                and shift.end_time <= shift.start_time  # overnight
            ):
                _s, end_utc = shift_window_utc(shift, day.attendance_date)
                carryover = timedelta(
                    minutes=max(shift.grace_minutes, 120)
                )
                if now_utc <= end_utc + carryover:
                    valid = True
            if valid:
                overnight_ok.add(emp_id)
            else:
                stale_days[emp_id] = day
                logger.warning(
                    "stale open attendance day flagged for review "
                    "employee=%s attendance_date=%s day_id=%s",
                    emp_id, day.attendance_date, day.id,
                )

    statuses: dict[uuid.UUID, dict] = {}
    for emp_id, emp_days in days.items():
        open_day = next(
            (d for d in emp_days
             if d.started_at is not None and d.ended_at is None),
            None,
        )
        if open_day is not None and emp_id in stale_days:
            # Old unclosed record with no overnight cover — fail closed.
            statuses[emp_id] = {
                "state": "unknown",
                "label": "Unknown",
                "since": None,
                "attendance_date": open_day.attendance_date,
                "attendance_status": open_day.status,
                "needs_review": True,
            }
            continue
        if open_day is not None:
            br = open_breaks.get(open_day.id)
            statuses[emp_id] = {
                "state": "on_break" if br else "working",
                "label": "On break" if br else "Working",
                "since": _iso(br.started_at if br else open_day.started_at),
                "attendance_date": open_day.attendance_date,
                "attendance_status": open_day.status,
            }
            continue
        today_row = next(
            (d for d in emp_days if d.attendance_date == today), None
        )
        if today_row is None or (
            today_row.status == "present" and today_row.ended_at is None
        ):
            # No record today, or a present row that was never clocked
            # into — not enough stored data to claim a duty state.
            statuses[emp_id] = {
                "state": "unknown",
                "label": "Unknown",
                "since": None,
                "attendance_date": (
                    today_row.attendance_date if today_row else None
                ),
                "attendance_status": (
                    today_row.status if today_row else None
                ),
            }
        elif today_row.status == "present":
            statuses[emp_id] = {
                "state": "off_duty",
                "label": "Off duty",
                "since": _iso(today_row.ended_at),
                "attendance_date": today_row.attendance_date,
                "attendance_status": "present",
            }
        else:
            statuses[emp_id] = {
                "state": "off_duty",
                "label": today_row.status.replace("_", " ").capitalize(),
                "since": None,
                "attendance_date": today_row.attendance_date,
                "attendance_status": today_row.status,
            }
    return statuses


# ----------------------------------------------------------------------
# Daily status board — schedule-aware attendance metrics
# ----------------------------------------------------------------------

DAY_BOARD_STATES = (
    "working", "on_break", "completed", "absent", "awaiting",
    "scheduled", "off_day", "incomplete", "not_scheduled",
)


def _validate_op_date_key(value: str) -> str:
    s = (value or "").strip()
    try:
        parsed = datetime.strptime(s, "%Y-%m-%d")
    except (ValueError, TypeError):
        raise ValidationErr("date must be 'YYYY-MM-DD'.", field="date")
    if parsed.strftime("%Y-%m-%d") != s:
        raise ValidationErr("date must be 'YYYY-MM-DD'.", field="date")
    return s


async def day_status_board(
    session: AsyncSession,
    user: User,
    property_id: uuid.UUID | None,
    op_date: str | None = None,
    *,
    now: datetime | None = None,
) -> dict:
    """Per-employee attendance evaluation for one IST operational day.

    Combines the shift assignment effective on `op_date` (never the
    employee's current assignment) with the actual attendance day row.
    Nothing is fabricated: a missing clock-out becomes 'incomplete' +
    needs_review, an unmarked scheduled day becomes 'absent' only after
    the shift's start + grace cutoff has passed.
    """
    from app.models.company import Company

    pid = (
        property_id
        if user.role == UserRole.SUPER_ADMIN
        else user.property_id
    )
    if pid is None:
        raise ValidationErr("property_id is required.", field="property_id")
    prop = await session.scalar(
        select(Property).where(
            Property.id == pid,
            Property.company_id == user.company_id,
        )
    )
    if prop is None:
        raise NotFoundErr("Property not found.")

    company = await session.get(Company, user.company_id)
    day_start = parse_day_start(
        company.operational_day_start if company else None
    )
    now_utc = now or datetime.now(timezone.utc)
    today = current_operational_day(now_utc, day_start)
    op_date = _validate_op_date_key(op_date) if op_date else today

    employees = list(
        (
            await session.execute(
                select(Employee)
                .where(
                    Employee.property_id == prop.id,
                    Employee.company_id == user.company_id,
                    func.lower(Employee.status) != "deactivated",
                )
                .order_by(Employee.name)
            )
        ).scalars()
    )
    emp_ids = [e.id for e in employees]

    days: dict[uuid.UUID, AttendanceDay] = {}
    open_breaks: dict[uuid.UUID, AttendanceBreak] = {}
    if emp_ids:
        res = await session.execute(
            select(AttendanceDay).where(
                AttendanceDay.property_id == prop.id,
                AttendanceDay.employee_id.in_(emp_ids),
                AttendanceDay.attendance_date == op_date,
            )
        )
        days = {d.employee_id: d for d in res.scalars() if d.employee_id}
        day_ids = [d.id for d in days.values()]
        if day_ids:
            res = await session.execute(
                select(AttendanceBreak).where(
                    AttendanceBreak.attendance_day_id.in_(day_ids),
                    AttendanceBreak.ended_at.is_(None),
                )
            )
            for br in res.scalars():
                open_breaks[br.attendance_day_id] = br

    assignments = await effective_assignments(session, emp_ids, op_date)
    # SA/PM-linked staff work 24×7 by default — no schedule applies,
    # they can never be absent.
    exempt = await ShiftService(session).schedule_exempt_employees(emp_ids)

    def _iso(dt: datetime | None) -> str | None:
        return dt.isoformat() if dt is not None else None

    items = []
    for emp in employees:
        pair = assignments.get(emp.id)
        shift = pair[1] if pair else None
        is_exempt = emp.id in exempt
        scheduled = (
            not is_exempt
            and shift is not None
            and shift_applies_on(shift, op_date)
        )
        window = (
            shift_window_utc(shift, op_date) if scheduled else None
        )
        day = days.get(emp.id)

        status = "not_scheduled"
        arrival = departure = None
        unscheduled = False
        needs_review = False
        label = "24×7 duty" if is_exempt else "Not scheduled"

        if day is not None and day.status in ("leave", "week_off"):
            status, label = "off_day", day.status.replace("_", " ").title()
        elif day is not None and day.status == "absent":
            status, label = "absent", "Absent"
        elif day is not None and day.started_at is not None:
            unscheduled = not scheduled
            if window is not None:
                grace_end = window[0] + timedelta(
                    minutes=shift.grace_minutes
                )
                arrival = (
                    "late" if day.started_at > grace_end else "on_time"
                )
            if day.ended_at is None:
                if open_breaks.get(day.id) is not None:
                    status, label = "on_break", "On break"
                else:
                    status, label = "working", "Working"
                if op_date < today:
                    # Still open on a past op-day — legitimate only while
                    # an overnight window is still running.
                    carryover_ok = (
                        scheduled
                        and shift.end_time <= shift.start_time
                        and now_utc
                        <= window[1]
                        + timedelta(
                            minutes=max(shift.grace_minutes, 120)
                        )
                    )
                    if not carryover_ok:
                        status, label = "incomplete", "Needs review"
                        needs_review = True
            else:
                status, label = "completed", "Completed"
                if window is not None:
                    early_end = window[1] - timedelta(
                        minutes=shift.early_exit_minutes
                    )
                    departure = (
                        "early" if day.ended_at < early_end else "on_time"
                    )
                if day.started_at is None:
                    needs_review = True
        elif scheduled:
            cutoff = window[0] + timedelta(minutes=shift.grace_minutes)
            if op_date < today or (op_date == today and now_utc > cutoff):
                status, label = "absent", "Absent"
            elif op_date == today:
                status, label = "awaiting", "Awaiting check-in"
            else:
                status, label = "scheduled", "Scheduled"

        items.append(
            {
                "employee_uid": str(emp.id),
                "name": emp.name,
                "job_title": emp.job_title,
                "status": status,
                "label": label,
                "scheduled": scheduled,
                "schedule_exempt": is_exempt,
                # Floor eligibility: open, non-stale attendance day.
                # 'incomplete'/needs_review rows fail closed.
                "floor_eligible": status in ("working", "on_break"),
                "unscheduled": unscheduled,
                "arrival": arrival,
                "departure": departure,
                "needs_review": needs_review,
                "shift_name": shift.name if shift else None,
                "scheduled_start": (
                    shift.start_time.strftime("%H:%M") if scheduled else None
                ),
                "scheduled_end": (
                    shift.end_time.strftime("%H:%M") if scheduled else None
                ),
                "started_at": _iso(day.started_at) if day else None,
                "ended_at": _iso(day.ended_at) if day else None,
                "work_seconds": day.work_seconds if day else None,
                "attendance_status": day.status if day else None,
            }
        )

    return {
        "date": op_date,
        "property_uid": str(prop.id),
        "operational_day_start": day_start.strftime("%H:%M"),
        "is_today": op_date == today,
        "employees": items,
    }
