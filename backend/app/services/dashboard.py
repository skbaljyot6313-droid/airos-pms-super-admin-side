"""Property Dashboard — one bounded, read-only aggregate for the Dashboard screen.

Design rules (discovery reports 03, 06, 07; redesign brief §3–§15):

* Occupancy truth = ``occupancies`` rows (open iff ``checked_out_at IS NULL``),
  never the room/bed resource-state column. Resource state is shown separately.
* Cleaning is only reported as *verified* when an open cleaning task exists for
  the unit. A ``cleaning`` state without an open task is reported as *unverified*.
  Nothing is reconciled or written here.
* Abandoned tasks are split into expiry-by-design (rollover / next-occurrence /
  midnight / fresh-day reset) and other abandonment, using the same reason set
  that ``day_analysis`` already uses for auto-abandonment.
* Business days are operational days: the day runs from the company's
  ``operational_day_start`` (default 06:00 IST) to the next day's start.
* Every metric carries a data-quality state so the UI never shows a misleading
  zero or an unexplained empty chart.
* Query count is fixed (independent of rows): one query per source, grouped in
  SQL where possible. Duration medians use small capped samples.
"""

from __future__ import annotations

import statistics
import uuid
from collections import Counter, defaultdict
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.allocation import AllocationEvent
from app.models.attendance import AttendanceDay, AttendanceRequest
from app.models.company import Company
from app.models.department import Department
from app.models.employee import Employee
from app.models.maintenance import MaintenanceTicket, MaintenanceTicketEvent
from app.models.occupancy import Occupancy
from app.models.structure import Bed, Dorm, Room, Zone
from app.models.task import Task, TaskCompletionSubmission, TaskHistoryEvent
from app.models.user import User
from app.services.structure import StructureService

IST = ZoneInfo("Asia/Kolkata")

OPEN_TASK = ("pending", "assigned", "in_progress", "reopened", "submitted")
OPEN_TICKET = ("open", "assigned", "in_progress", "on_hold")
CRITICAL_PRIORITIES = ("high", "critical", "urgent")
EXPIRY_REASONS = (
    "SYSTEM_DAILY_ROLLOVER",
    "NEXT_SCHEDULED_OCCURRENCE",
    "MIDNIGHT_EXPIRY",
    "FRESH_DAY_RESET",
)
CLEANING_WORK = ("cleaning", "housekeeping")
SAMPLE_CAP = 2000
MAX_RANGE_DAYS = 366
TREND_RELIABLE_DAYS = 14
PERIOD_KEYS = (
    "today", "yesterday", "last_7_days", "last_30_days", "last_90_days",
    "this_month", "last_month", "last_6_months", "custom",
)


# ----------------------------------------------------------------- time helpers


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def _op_time(value: str | None) -> time:
    try:
        h, m = (value or "06:00").split(":")
        return time(int(h), int(m))
    except (ValueError, TypeError):
        return time(6, 0)


def _op_day(ts: datetime, op: time) -> date:
    """Operational date a UTC/aware timestamp belongs to."""
    local = _aware(ts).astimezone(IST)
    return (local - timedelta(hours=op.hour, minutes=op.minute)).date()


def _day_bounds(d: date, op: time) -> tuple[datetime, datetime]:
    start = datetime.combine(d, op, tzinfo=IST).astimezone(UTC)
    end = datetime.combine(d + timedelta(days=1), op, tzinfo=IST).astimezone(UTC)
    return start, end


def _iso(dt: datetime | None) -> str | None:
    return _aware(dt).astimezone(UTC).isoformat().replace("+00:00", "Z") if dt else None


def _pct(part: int | float, whole: int | float) -> float | None:
    return round(100.0 * part / whole, 1) if whole else None


def _median_minutes(pairs: list[tuple[datetime | None, datetime | None]]) -> float | None:
    vals = []
    for a, b in pairs[:SAMPLE_CAP]:
        if a and b:
            vals.append((_aware(b) - _aware(a)).total_seconds() / 60.0)
    return round(statistics.median(vals), 1) if vals else None


def resolve_period(
    key: str,
    today: date,
    custom_from: date | None = None,
    custom_to: date | None = None,
) -> tuple[date, date, str]:
    """Return inclusive (from, to) operational dates and a label."""
    if key == "today":
        return today, today, "Today"
    if key == "yesterday":
        y = today - timedelta(days=1)
        return y, y, "Yesterday"
    if key == "last_7_days":
        return today - timedelta(days=6), today, "Last 7 days"
    if key == "last_30_days":
        return today - timedelta(days=29), today, "Last 30 days"
    if key == "last_90_days":
        return today - timedelta(days=89), today, "Last 90 days"
    if key == "last_6_months":
        m = today.month - 5
        y = today.year + (m - 1) // 12
        m = (m - 1) % 12 + 1
        return date(y, m, 1), today, "Last 6 months"
    if key == "this_month":
        return today.replace(day=1), today, "This month"
    if key == "last_month":
        first_this = today.replace(day=1)
        last_prev = first_this - timedelta(days=1)
        return last_prev.replace(day=1), last_prev, "Last month"
    if key == "custom":
        if custom_from is None or custom_to is None:
            raise ValueError("custom period needs from and to")
        if custom_to < custom_from:
            raise ValueError("'to' must be on or after 'from'")
        if (custom_to - custom_from).days + 1 > MAX_RANGE_DAYS:
            raise ValueError(f"range may not exceed {MAX_RANGE_DAYS} days")
        return custom_from, custom_to, f"{custom_from:%d %b %Y} – {custom_to:%d %b %Y}"
    raise ValueError(f"unknown period '{key}'")


def _bucket_key(d: date, granularity: str) -> str:
    if granularity == "week":
        monday = d - timedelta(days=d.weekday())
        return monday.isoformat()
    if granularity == "month":
        return d.replace(day=1).isoformat()
    return d.isoformat()


# ----------------------------------------------------------------- service


def dorm_breakdown(dorms, beds, open_beds: set, verified_dorm_cleaning: set) -> dict:
    """Dorm and bed occupancy from the ledger (open bed rows), not bed state.

    A bed is occupied only when it has an open occupancy row. A dorm is
    occupied when at least one of its beds is occupied. Cleaning is verified
    only when the dorm (or the bed's dorm) has an open cleaning task.
    """
    bed_cat: Counter = Counter()
    occ_by_dorm: Counter = Counter()
    total_by_dorm: Counter = Counter()
    for b in beds:
        total_by_dorm[b.dorm_id] += 1
        if b.id in open_beds:
            cat = "occupied"
        elif b.status == "maintenance":
            cat = "maintenance"
        elif b.status == "cleaning":
            cat = "cleaning_verified" if b.dorm_id in verified_dorm_cleaning else "cleaning_unverified"
        elif b.status == "available":
            cat = "available"
        else:
            cat = "other"
        bed_cat[cat] += 1
        if cat == "occupied":
            occ_by_dorm[b.dorm_id] += 1

    dorms_occupied = sum(1 for d in dorms if occ_by_dorm.get(d.id, 0) > 0)
    dorm_cleaning_v = sum(1 for d in dorms if d.status == "cleaning" and d.id in verified_dorm_cleaning)
    dorm_cleaning_u = sum(1 for d in dorms if d.status == "cleaning" and d.id not in verified_dorm_cleaning)

    by_type: dict = defaultdict(Counter)
    for d in dorms:
        t = by_type[d.dorm_type or "Unspecified"]
        t["dorms"] += 1
        t["beds"] += total_by_dorm.get(d.id, 0)
        t["beds_occupied"] += occ_by_dorm.get(d.id, 0)
        if occ_by_dorm.get(d.id, 0) > 0:
            t["dorms_occupied"] += 1

    by_dorm = sorted(
        (
            {
                "dorm_name": d.name,
                "dorm_type": d.dorm_type or "Unspecified",
                "status": d.status,
                "beds_occupied": occ_by_dorm.get(d.id, 0),
                "beds_total": total_by_dorm.get(d.id, 0),
                "occupancy_pct": _pct(occ_by_dorm.get(d.id, 0), total_by_dorm.get(d.id, 0)),
            }
            for d in dorms
        ),
        key=lambda r: (-r["beds_occupied"], r["dorm_name"]),
    )
    total_beds = len(beds)
    occupied_beds = bed_cat["occupied"]
    return {
        "beds": {
            "total": total_beds,
            "occupied": occupied_beds,
            "available": bed_cat["available"],
            "maintenance": bed_cat["maintenance"],
            "cleaning_verified": bed_cat["cleaning_verified"],
            "cleaning_unverified": bed_cat["cleaning_unverified"],
            "occupancy_pct": _pct(occupied_beds, total_beds),
        },
        "dorms": {
            "total": len(dorms),
            "occupied": dorms_occupied,
            "vacant": len(dorms) - dorms_occupied,
            "maintenance": sum(1 for d in dorms if d.status == "maintenance"),
            "cleaning_verified": dorm_cleaning_v,
            "cleaning_unverified": dorm_cleaning_u,
            "occupancy_pct": _pct(dorms_occupied, len(dorms)),
        },
        "by_dorm_type": [
            {"type": t, "dorms": c["dorms"], "dorms_occupied": c["dorms_occupied"],
             "beds": c["beds"], "beds_occupied": c["beds_occupied"],
             "occupancy_pct": _pct(c["beds_occupied"], c["beds"])}
            for t, c in sorted(by_type.items(), key=lambda kv: -kv[1]["beds"])
        ],
        "by_dorm": by_dorm[:50],
    }


class DashboardService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.structure = StructureService(session)

    async def summary(
        self,
        user: User,
        property_id: uuid.UUID,
        *,
        period: str = "today",
        custom_from: date | None = None,
        custom_to: date | None = None,
        granularity: str = "day",
    ) -> dict:
        prop = await self.structure._property_for_write(user, property_id)
        company = await self.session.get(Company, prop.company_id)
        op = _op_time(company.operational_day_start if company else None)

        now = datetime.now(UTC)
        today = _op_day(now, op)
        d_from, d_to, label = resolve_period(period, today, custom_from, custom_to)
        p_start, _ = _day_bounds(d_from, op)
        _, p_end = _day_bounds(d_to, op)
        if granularity not in ("day", "week", "month"):
            granularity = "day"

        pid = prop.id
        rooms = (await self.session.execute(
            select(Room.id, Room.zone_id, Room.status, Room.type, Room.room_number)
            .where(Room.property_id == pid)
        )).all()
        dorms = (await self.session.execute(
            select(Dorm.id, Dorm.zone_id, Dorm.status, Dorm.name, Dorm.dorm_type)
            .where(Dorm.property_id == pid)
        )).all()
        beds = (await self.session.execute(
            select(Bed.id, Bed.dorm_id, Bed.status).join(Dorm, Dorm.id == Bed.dorm_id)
            .where(Dorm.property_id == pid)
        )).all()
        zones = {z.id: z.name for z in (await self.session.execute(
            select(Zone).where(Zone.property_id == pid))).scalars()}

        # ---- occupancy ledger ---------------------------------------
        occ_rows = (await self.session.execute(
            select(Occupancy.room_id, Occupancy.bed_id, Occupancy.checked_in_at, Occupancy.checked_out_at)
            .where(
                Occupancy.property_id == pid,
                Occupancy.checked_in_at < p_end,
                (Occupancy.checked_out_at.is_(None)) | (Occupancy.checked_out_at >= p_start),
            )
        )).all()
        open_ledger = await self._open_occ(pid)
        first_ledger_at = (await self.session.execute(
            select(func.min(Occupancy.checked_in_at)).where(
                Occupancy.property_id == pid, Occupancy.room_id.isnot(None),
            )
        )).scalar_one()
        first_ledger_day = _op_day(first_ledger_at, op) if first_ledger_at else None
        open_rooms = {r.room_id for r in open_ledger if r.room_id}
        open_beds = {r.bed_id for r in open_ledger if r.bed_id}

        # ---- open cleaning tasks (verification of cleaning state) ----
        clean_tasks = (await self.session.execute(
            select(Task.room_id, Task.dorm_id).where(
                Task.property_id == pid,
                Task.status.in_(OPEN_TASK),
                Task.work_type.in_(CLEANING_WORK),
            )
        )).all()
        verified_room_cleaning = {t.room_id for t in clean_tasks if t.room_id}
        verified_dorm_cleaning = {t.dorm_id for t in clean_tasks if t.dorm_id}

        # ---- tasks in period ----------------------------------------
        created_by_status = dict((await self.session.execute(
            select(Task.status, func.count()).where(
                Task.property_id == pid,
                Task.created_at >= p_start, Task.created_at < p_end,
            ).group_by(Task.status)
        )).all())
        completed_in_period = (await self.session.execute(
            select(func.count()).where(
                Task.property_id == pid,
                Task.completed_at >= p_start, Task.completed_at < p_end,
            )
        )).scalar_one()
        completed_rows = (await self.session.execute(
            select(Task.created_at, Task.completed_at)
            .where(
                Task.property_id == pid,
                Task.completed_at >= p_start, Task.completed_at < p_end,
            ).limit(SAMPLE_CAP)
        )).all()
        aband_rows = (await self.session.execute(
            select(Task.abandoned_reason, func.count()).where(
                Task.property_id == pid,
                Task.status == "abandoned",
                Task.abandoned_at >= p_start, Task.abandoned_at < p_end,
            ).group_by(Task.abandoned_reason)
        )).all()
        open_now = dict((await self.session.execute(
            select(Task.status, func.count()).where(
                Task.property_id == pid, Task.status.in_(OPEN_TASK),
            ).group_by(Task.status)
        )).all())
        carried_over = (await self.session.execute(
            select(func.count()).where(
                Task.property_id == pid, Task.status.in_(OPEN_TASK),
                Task.operational_date < today.isoformat(),
            )
        )).scalar_one()
        created_by_zone = (await self.session.execute(
            select(Task.zone_id, Task.status, func.count()).where(
                Task.property_id == pid, Task.created_at >= p_start, Task.created_at < p_end,
            ).group_by(Task.zone_id, Task.status)
        )).all()
        open_by_employee = (await self.session.execute(
            select(Task.employee_id, func.count()).where(
                Task.property_id == pid, Task.status.in_(OPEN_TASK), Task.employee_id.isnot(None),
            ).group_by(Task.employee_id).order_by(func.count().desc()).limit(10)
        )).all()
        task_dept = (await self.session.execute(
            select(Employee.department_id, Task.status, func.count())
            .join(Employee, Employee.id == Task.employee_id)
            .where(
                Task.property_id == pid,
                Task.created_at >= p_start, Task.created_at < p_end,
            ).group_by(Employee.department_id, Task.status)
        )).all()

        review_rows = (await self.session.execute(
            select(TaskCompletionSubmission.submitted_at, TaskCompletionSubmission.reviewed_at,
                   TaskCompletionSubmission.status)
            .join(Task, Task.id == TaskCompletionSubmission.task_id)
            .where(
                Task.property_id == pid,
                TaskCompletionSubmission.reviewed_at >= p_start,
                TaskCompletionSubmission.reviewed_at < p_end,
            ).limit(SAMPLE_CAP)
        )).all()
        awaiting_review = open_now.get("submitted", 0)

        # ---- maintenance --------------------------------------------
        tickets_all = (await self.session.execute(
            select(MaintenanceTicket.status, MaintenanceTicket.priority, MaintenanceTicket.zone_id,
                   MaintenanceTicket.created_at, MaintenanceTicket.resolved_at,
                   MaintenanceTicket.maintenance_type, MaintenanceTicket.ticket_number,
                   MaintenanceTicket.issue, MaintenanceTicket.room_number,
                   MaintenanceTicket.dorm_name, MaintenanceTicket.washroom_name,
                   MaintenanceTicket.closed_at)
            .where(MaintenanceTicket.property_id == pid)
        )).all()
        now_utc = datetime.now(UTC)
        open_tickets = [t for t in tickets_all if t.status in OPEN_TICKET]
        ageing = Counter()
        for t in open_tickets:
            age_h = (now_utc - _aware(t.created_at)).total_seconds() / 3600
            ageing["under_1d" if age_h < 24 else "1_to_3d" if age_h < 72
                   else "3_to_7d" if age_h < 168 else "over_7d"] += 1
        in_period_tickets = [t for t in tickets_all if p_start <= _aware(t.created_at) < p_end]
        resolved_in_period = [t for t in tickets_all if t.resolved_at and p_start <= _aware(t.resolved_at) < p_end]
        last_ticket = max((_aware(t.created_at) for t in tickets_all), default=None)

        # ---- attendance / workforce ---------------------------------
        employees = (await self.session.execute(
            select(Employee.id, Employee.department_id, Employee.zone_id, Employee.area_id,
                   Employee.covers_property, Employee.deactivated_at)
            .where(Employee.property_id == pid)
        )).all()
        active = [e for e in employees if e.deactivated_at is None]
        unallocated = [e for e in active if not (e.zone_id or e.area_id or e.covers_property)]
        today_iso = today.isoformat()
        att_today = (await self.session.execute(
            select(AttendanceDay.employee_id, AttendanceDay.status).where(
                AttendanceDay.property_id == pid, AttendanceDay.attendance_date == today_iso,
            )
        )).all()
        att_period = (await self.session.execute(
            select(AttendanceDay.attendance_date, AttendanceDay.status, AttendanceDay.employee_id)
            .where(
                AttendanceDay.property_id == pid,
                AttendanceDay.attendance_date >= d_from.isoformat(),
                AttendanceDay.attendance_date <= d_to.isoformat(),
            )
        )).all()
        att_dates_total = (await self.session.execute(
            select(func.count(func.distinct(AttendanceDay.attendance_date)))
            .where(AttendanceDay.property_id == pid)
        )).scalar_one()
        att_rows_total = (await self.session.execute(
            select(func.count()).where(AttendanceDay.property_id == pid)
        )).scalar_one()
        leave_req = (await self.session.execute(
            select(AttendanceRequest.employee_id, AttendanceRequest.from_date,
                   AttendanceRequest.to_date, AttendanceRequest.request_type)
            .where(
                AttendanceRequest.property_id == pid,
                AttendanceRequest.status == "approved",
                AttendanceRequest.from_date <= today_iso,
                AttendanceRequest.to_date >= today_iso,
            )
        )).all()
        on_leave_ids = {r.employee_id for r in leave_req if r.employee_id}
        present_today_ids = {a.employee_id for a in att_today if a.status == "present"}
        marked_today_ids = {a.employee_id for a in att_today}
        active_ids = {e.id for e in active}
        not_marked = len((active_ids - marked_today_ids) - on_leave_ids)

        leave_period = (await self.session.execute(
            select(AttendanceRequest.employee_id, AttendanceRequest.from_date, AttendanceRequest.to_date)
            .where(
                AttendanceRequest.property_id == pid,
                AttendanceRequest.status == "approved",
                AttendanceRequest.request_type == "leave",
                AttendanceRequest.from_date <= d_to.isoformat(),
                AttendanceRequest.to_date >= d_from.isoformat(),
            )
        )).all()
        cleaning_created = (await self.session.execute(
            select(Task.status, func.count()).where(
                Task.property_id == pid, Task.work_type.in_(CLEANING_WORK),
                Task.created_at >= p_start, Task.created_at < p_end,
            ).group_by(Task.status)
        )).all()
        cleaning_done = (await self.session.execute(
            select(Task.created_at, Task.completed_at).where(
                Task.property_id == pid, Task.work_type.in_(CLEANING_WORK),
                Task.completed_at >= p_start, Task.completed_at < p_end,
            ).limit(SAMPLE_CAP)
        )).all()
        created_times = (await self.session.execute(
            select(Task.created_at).where(
                Task.property_id == pid,
                Task.created_at >= p_start, Task.created_at < p_end,
            )
        )).scalars().all()
        created_by_bucket = Counter(
            _bucket_key(_op_day(t, op), granularity if period not in ("today", "yesterday") else "day")
            for t in created_times
        )
        cleaning_zone_open = (await self.session.execute(
            select(Task.zone_id, func.count()).where(
                Task.property_id == pid, Task.work_type.in_(CLEANING_WORK),
                Task.status.in_(OPEN_TASK),
            ).group_by(Task.zone_id)
        )).all()

        # ---- departments --------------------------------------------
        depts = (await self.session.execute(
            select(Department.id, Department.name, Department.status, Department.head_employee_id)
            .where(Department.property_id == pid)
        )).all()

        # ---- activity feed (real events only) -----------------------
        activity = await self._activity(pid, p_start, p_end, zones)

        # ================================================================
        # Assemble
        # ================================================================
        room_cat: dict[str, list] = defaultdict(list)
        zone_rooms: dict = defaultdict(lambda: Counter())
        type_rooms: dict = defaultdict(lambda: Counter())
        state_mismatch = 0
        for r in rooms:
            occupied = r.id in open_rooms
            if occupied:
                cat = "occupied"
            elif r.status == "maintenance":
                cat = "maintenance"
            elif r.status == "cleaning":
                cat = "cleaning_verified" if r.id in verified_room_cleaning else "cleaning_unverified"
            elif r.status == "available":
                cat = "vacant"
            else:
                cat = "other"
            if (r.status == "occupied") != occupied:
                state_mismatch += 1
            room_cat[cat].append(r)
            zone_rooms[r.zone_id][cat] += 1
            zone_rooms[r.zone_id]["total"] += 1
            type_rooms[r.type or "Unspecified"]["total"] += 1
            if occupied:
                type_rooms[r.type or "Unspecified"]["occupied"] += 1

        n_rooms = len(rooms)
        occ_cnt = {k: len(v) for k, v in room_cat.items()}
        unavailable = occ_cnt.get("cleaning_verified", 0) + occ_cnt.get("cleaning_unverified", 0)
        segments = [
            {"key": "occupied", "label": "Occupied", "count": occ_cnt.get("occupied", 0),
             "pct": _pct(occ_cnt.get("occupied", 0), n_rooms), "drill": "rooms:occupied"},
            {"key": "vacant", "label": "Vacant", "count": occ_cnt.get("vacant", 0),
             "pct": _pct(occ_cnt.get("vacant", 0), n_rooms), "drill": "rooms:available"},
            {"key": "maintenance", "label": "Under maintenance", "count": occ_cnt.get("maintenance", 0),
             "pct": _pct(occ_cnt.get("maintenance", 0), n_rooms), "drill": "rooms:maintenance"},
            {"key": "unavailable", "label": "Unavailable (cleaning)", "count": unavailable,
             "pct": _pct(unavailable, n_rooms), "drill": "rooms:cleaning",
             "unverified": occ_cnt.get("cleaning_unverified", 0)},
        ]

        unit = dorm_breakdown(dorms, beds, open_beds, verified_dorm_cleaning)
        beds_occupied = unit["beds"]["occupied"]
        beds_maint = unit["beds"]["maintenance"]

        trend_gran = "hour" if period in ("today", "yesterday") else granularity
        trend = self._occupancy_trend(
            occ_rows, d_from, d_to, op, n_rooms, trend_gran,
            p_start=p_start, p_end=p_end, now=now, first_record=first_ledger_day,
        )
        attendance_series = self._attendance_series(
            att_period, leave_period, active_ids, d_from, d_to, op
        )
        stays = [
            (_aware(o.checked_out_at) - _aware(o.checked_in_at)).total_seconds() / 86400
            for o in occ_rows
            if o.room_id and o.checked_out_at and p_start <= _aware(o.checked_out_at) < p_end
        ]
        checkins = sum(1 for o in occ_rows if o.room_id and p_start <= _aware(o.checked_in_at) < p_end)
        checkouts = sum(1 for o in occ_rows if o.room_id and o.checked_out_at
                        and p_start <= _aware(o.checked_out_at) < p_end)

        # task summary
        created_total = sum(created_by_status.values())
        aband_expiry = sum(c for r, c in aband_rows if r in EXPIRY_REASONS)
        aband_other = sum(c for r, c in aband_rows if r not in EXPIRY_REASONS)
        # Completion rate: tasks created in the period that were completed, over
        # tasks created in the period excluding those expired by design.
        rate_base = created_total - sum(
            c for r, c in aband_rows if r in EXPIRY_REASONS
        )
        completed_from_created = created_by_status.get("completed", 0)
        completion_rate = _pct(completed_from_created, rate_base) if rate_base > 0 else None
        completed_by_day = Counter(
            _bucket_key(_op_day(c.completed_at, op), granularity) for c in completed_rows
        )
        zone_stats: dict = defaultdict(lambda: Counter())
        for zid, status, cnt in created_by_zone:
            zone_stats[zid]["created"] += cnt
            if status == "completed":
                zone_stats[zid]["completed"] += cnt
            if status in OPEN_TASK:
                zone_stats[zid]["open"] += cnt
        dept_stats: dict = defaultdict(lambda: Counter())
        for did, status, cnt in task_dept:
            dept_stats[did]["created"] += cnt
            if status == "completed":
                dept_stats[did]["completed"] += cnt
            if status in OPEN_TASK:
                dept_stats[did]["open"] += cnt
        completion_minutes = _median_minutes([(c.created_at, c.completed_at) for c in completed_rows])
        review_minutes = _median_minutes([(r.submitted_at, r.reviewed_at) for r in review_rows])

        attendance_period = self._attendance_period(att_period, active_ids, d_from, d_to)
        cleaning_unverified = occ_cnt.get("cleaning_unverified", 0)
        data_quality = self._data_quality(
            trend, att_dates_total, att_rows_total, state_mismatch, cleaning_unverified,
            aband_other, last_ticket, n_rooms, len(active), aband_expiry + aband_other,
        )

        return {
            "property": {"property_uid": str(prop.id), "name": prop.name},
            "period": {
                "key": period, "label": label,
                "from": d_from.isoformat(), "to": d_to.isoformat(),
                "days": (d_to - d_from).days + 1,
                "granularity": granularity,
                "compares_previous": False,
            },
            "generated_at": now_utc.isoformat().replace("+00:00", "Z"),
            "current": {
                "as_of_operational_date": today_iso,
                "operational_day_start": op.strftime("%H:%M"),
            },
            "occupancy": {
                "rooms": {
                    "total": n_rooms,
                    "occupied": occ_cnt.get("occupied", 0),
                    "vacant": occ_cnt.get("vacant", 0),
                    "maintenance": occ_cnt.get("maintenance", 0),
                    "unavailable_cleaning": unavailable,
                    "cleaning_verified": occ_cnt.get("cleaning_verified", 0),
                    "cleaning_unverified": occ_cnt.get("cleaning_unverified", 0),
                    "other_state": occ_cnt.get("other", 0),
                    "occupancy_pct": _pct(occ_cnt.get("occupied", 0), n_rooms),
                    "state_ledger_mismatch": state_mismatch,
                },
                "beds": unit["beds"],
                "dorms": unit["dorms"],
                "by_dorm_type": unit["by_dorm_type"],
                "by_dorm": unit["by_dorm"],
                "segments": segments,
                "trend": trend,
                "period_activity": {"check_ins": checkins, "check_outs": checkouts},
                "stay": {
                    "closed_stays": len(stays),
                    "avg_nights": round(statistics.mean(stays), 1) if stays else None,
                    "reliable": len(stays) >= 5,
                },
                "by_zone": [
                    {"zone_name": zones.get(zid, "Unassigned"), "rooms": c["total"],
                     "occupied": c.get("occupied", 0), "vacant": c.get("vacant", 0),
                     "occupancy_pct": _pct(c.get("occupied", 0), c["total"]),
                     "unverified_cleaning": c.get("cleaning_unverified", 0)}
                    for zid, c in sorted(zone_rooms.items(), key=lambda kv: -kv[1]["total"])
                ],
                "by_room_type": [
                    {"type": t, "rooms": c["total"], "occupied": c.get("occupied", 0),
                     "occupancy_pct": _pct(c.get("occupied", 0), c["total"])}
                    for t, c in sorted(type_rooms.items(), key=lambda kv: -kv[1]["total"])
                ],
            },
            "conditions": {
                "units_under_maintenance_now": sum(1 for r in rooms if r.status == "maintenance")
                + sum(1 for d in dorms if d.status == "maintenance")
                + beds_maint,
                "cleaning_verified": occ_cnt.get("cleaning_verified", 0),
                "cleaning_unverified": occ_cnt.get("cleaning_unverified", 0),
                "ready_for_occupancy": occ_cnt.get("vacant", 0),
                "rooms_unavailable": unavailable,
            },
            "workforce": {
                "active": len(active),
                "inactive": len(employees) - len(active),
                "present_today": len(present_today_ids & active_ids),
                "absent_today": sum(1 for a in att_today if a.status == "absent" and a.employee_id in active_ids),
                "on_leave_today": len(on_leave_ids & active_ids),
                "not_yet_marked_today": not_marked,
                "unallocated": len(unallocated),
                "assigned_to_department": sum(1 for e in active if e.department_id),
                "assigned_to_operational_work": sum(1 for e in open_by_employee if e[0] in active_ids),
                "attendance_period": attendance_period,
                "attendance_series": attendance_series,
            },
            "departments": [
                {
                    "department_name": d.name,
                    "department_uid": str(d.id),
                    "status": d.status,
                    "employees": sum(1 for e in active if e.department_id == d.id),
                    "present_today": sum(1 for e in active
                                         if e.department_id == d.id and e.id in present_today_ids),
                    "on_leave_today": sum(1 for e in active
                                          if e.department_id == d.id and e.id in on_leave_ids),
                    "tasks_created": dept_stats[d.id]["created"],
                    "tasks_completed": dept_stats[d.id]["completed"],
                    "open_now": dept_stats[d.id]["open"],
                    "completion_pct": _pct(dept_stats[d.id]["completed"], dept_stats[d.id]["created"]),
                }
                for d in depts
            ],
            "tasks": {
                "created_in_period": created_total,
                "completed_in_period": completed_in_period,
                "open_now": sum(open_now.values()),
                "open_by_status": {s: open_now.get(s, 0) for s in OPEN_TASK},
                "carried_over": carried_over,
                "awaiting_review": awaiting_review,
                "abandoned_expiry_by_design": aband_expiry,
                "abandoned_other": aband_other,
                "abandoned_reasons": [{"reason": r or "UNSPECIFIED", "count": c,
                                       "class": "expiry" if r in EXPIRY_REASONS else "other"}
                                      for r, c in aband_rows],
                "completion_rate_pct": completion_rate,
                "completion_rate_base": rate_base,
                "median_completion_minutes": completion_minutes,
                "median_review_minutes": review_minutes,
                "reviewed_in_period": len(review_rows),
                "approved_in_period": sum(1 for r in review_rows if r.status == "approved"),
                "rejected_in_period": sum(1 for r in review_rows if r.status == "disapproved"),
                "generated_trend": sorted(
                    [{"bucket": k, "generated": v} for k, v in created_by_bucket.items()],
                    key=lambda x: x["bucket"]),
                "completion_trend": sorted(
                    [{"bucket": k, "completed": v} for k, v in completed_by_day.items()],
                    key=lambda x: x["bucket"]),
                "by_status": [{"status": s, "count": c} for s, c in created_by_status.items()],
                "by_zone": [
                    {"zone_name": zones.get(zid, "Unassigned"), "created": c["created"],
                     "completed": c.get("completed", 0), "open": c.get("open", 0)}
                    for zid, c in sorted(zone_stats.items(), key=lambda kv: -kv[1]["created"])
                ],
                "workload_top": [{"employee_uid": str(eid) if eid else None, "open": c}
                                 for eid, c in open_by_employee],
            },
            "cleaning": {
                "created_in_period": sum(c for _, c in cleaning_created),
                "by_status": {st: c for st, c in cleaning_created},
                "completed_in_period": len(cleaning_done),
                "pending_now": sum(c for _, c in cleaning_zone_open),
                "median_turnaround_minutes": _median_minutes(
                    [(c.created_at, c.completed_at) for c in cleaning_done]),
                "by_zone": [{"zone_name": zones.get(zid, "Unassigned"), "pending": c}
                            for zid, c in sorted(cleaning_zone_open, key=lambda kv: -kv[1])],
                "note": "Cleaning tasks only. Resource state 'cleaning' is not used as evidence.",
            },
            "maintenance": {
                "table": [
                    {
                        "ticket_number": t.ticket_number,
                        "unit": t.room_number or t.dorm_name or t.washroom_name or "—",
                        "zone": zones.get(t.zone_id, "Unassigned"),
                        "issue": t.issue,
                        "status": t.status,
                        "created": _iso(t.created_at),
                        "duration_hours": round(
                            ((_aware(t.resolved_at or t.closed_at or now_utc) - _aware(t.created_at))
                             .total_seconds() / 3600), 1),
                    }
                    for t in sorted(tickets_all, key=lambda t: _aware(t.created_at), reverse=True)[:50]
                ],
                "open_now": len(open_tickets),
                "critical_open": sum(1 for t in open_tickets if t.priority in CRITICAL_PRIORITIES),
                "ageing": {k: ageing.get(k, 0)
                           for k in ("under_1d", "1_to_3d", "3_to_7d", "over_7d")},
                "created_in_period": len(in_period_tickets),
                "resolved_in_period": len(resolved_in_period),
                "median_resolution_hours": (
                    round(statistics.median(
                        (_aware(t.resolved_at) - _aware(t.created_at)).total_seconds() / 3600
                        for t in resolved_in_period[:SAMPLE_CAP]), 1)
                    if resolved_in_period else None),
                "by_status": dict(Counter(t.status for t in tickets_all)),
                "by_zone": [{"zone_name": zones.get(zid, "Unassigned"), "open": c}
                            for zid, c in Counter(t.zone_id for t in open_tickets).most_common()],
                "by_category": [{"category": c, "count": n} for c, n in
                                Counter(t.maintenance_type for t in in_period_tickets).most_common(8)],
                "last_ticket_created": _iso(last_ticket),
            },
            "zones": [
                {"zone_name": zones.get(zid, "Unassigned"), "rooms": c["total"],
                 "occupied": c.get("occupied", 0), "vacant": c.get("vacant", 0),
                 "open_maintenance": sum(1 for t in open_tickets if t.zone_id == zid),
                 "cleaning_verified": c.get("cleaning_verified", 0),
                 "cleaning_unverified": c.get("cleaning_unverified", 0)}
                for zid, c in sorted(zone_rooms.items(), key=lambda kv: -kv[1]["total"])
            ],
            "activity": activity,
            "data_quality": data_quality,
        }

    # ------------------------------------------------------------ helpers

    async def _open_occ(self, pid: uuid.UUID):
        return (await self.session.execute(
            select(Occupancy.room_id, Occupancy.bed_id).where(
                Occupancy.property_id == pid, Occupancy.checked_out_at.is_(None),
            )
        )).all()

    def _occupancy_trend(self, occ_rows, d_from: date, d_to: date, op: time,
                         n_rooms: int, granularity: str, *, p_start: datetime,
                         p_end: datetime, now: datetime, first_record: date | None = None) -> dict:
        """Occupancy from the ledger only (room rows; never room state).

        hour       : rooms occupied at each whole hour (instant snapshot), up to now.
        day        : rooms with any stay overlapping the operational day.
        week/month : mean of the daily values in the bucket.
        Denominator: current room inventory (n_rooms). Historical inventory is not
        recorded, so rooms added later are counted in earlier periods as well.
        """
        room_rows = [o for o in occ_rows if o.room_id]
        if first_record is None:
            first_record = min((_op_day(o.checked_in_at, op) for o in room_rows), default=None)
        covers_range = first_record is not None and first_record <= d_from
        if granularity == "hour":
            points = []
            t = p_start.replace(minute=0, second=0, microsecond=0)
            if t < p_start:
                t += timedelta(hours=1)
            end = min(p_end, now)
            while t < end:
                occ = {o.room_id for o in room_rows
                       if _aware(o.checked_in_at) <= t
                       and (o.checked_out_at is None or _aware(o.checked_out_at) > t)}
                points.append({
                    "bucket": t.isoformat().replace("+00:00", "Z"),
                    "label": t.astimezone(IST).strftime("%H:%M"),
                    "date": _op_day(t, op).isoformat(),
                    "occupied_rooms": len(occ),
                    "total_rooms": n_rooms,
                    "occupancy_pct": _pct(len(occ), n_rooms),
                })
                t += timedelta(hours=1)
            daily = []
            series_days = points
        else:
            days = [d_from + timedelta(days=i) for i in range((d_to - d_from).days + 1)]
            occupied_by_day: dict[date, set] = {d: set() for d in days}
            for o in room_rows:
                start_d = max(_op_day(o.checked_in_at, op), d_from)
                end_d = min(_op_day(o.checked_out_at, op) if o.checked_out_at else d_to, d_to)
                d = start_d
                while d <= end_d:
                    occupied_by_day[d].add(o.room_id)
                    d += timedelta(days=1)
            daily = [
                {"date": d.isoformat(), "bucket": d.isoformat(), "label": d.strftime("%d %b"),
                 "occupied_rooms": len(occupied_by_day[d]), "total_rooms": n_rooms,
                 "occupancy_pct": _pct(len(occupied_by_day[d]), n_rooms)}
                for d in days
            ]
            series_days = daily
            buckets: dict[str, list] = defaultdict(list)
            for p in daily:
                buckets[_bucket_key(date.fromisoformat(p["date"]), granularity)].append(p)
            points = [
                {"bucket": k,
                 "label": (date.fromisoformat(k).strftime("%d %b") if granularity == "day"
                           else date.fromisoformat(k).strftime("%d %b") if granularity == "week"
                           else date.fromisoformat(k).strftime("%b %Y")),
                 "occupied_rooms": round(statistics.mean(x["occupied_rooms"] for x in v), 1),
                 "total_rooms": n_rooms,
                 "occupancy_pct": round(statistics.mean(x["occupancy_pct"] or 0 for x in v), 1)
                 if n_rooms else None,
                 "peak_occupied_rooms": max(x["occupied_rooms"] for x in v),
                 "days": len(v)}
                for k, v in sorted(buckets.items())
            ]
        days_with_records = sum(1 for p in series_days if p["occupied_rooms"] > 0)
        peak = max(series_days, key=lambda p: p["occupied_rooms"]) if series_days else None
        low = min(series_days, key=lambda p: p["occupied_rooms"]) if series_days else None
        avg = (round(statistics.mean(p["occupied_rooms"] for p in series_days), 2)
               if series_days else None)
        if first_record is None:
            reason = "No occupancy ledger records exist for this property."
        elif not covers_range:
            reason = (f"Occupancy is recorded from {first_record:%d %b %Y}. "
                      "Earlier days in this period have no records and are not shown as zero.")
        else:
            reason = None
        return {
            "granularity": granularity,
            "points": points,
            "daily": daily,
            "reliable": covers_range,
            "reason": reason,
            "first_record_date": first_record.isoformat() if first_record else None,
            "average_occupied_rooms": avg,
            "peak": ({"date": peak.get("date", peak.get("bucket")), "occupied_rooms": peak["occupied_rooms"]}
                     if peak else None),
            "low": ({"date": low.get("date", low.get("bucket")), "occupied_rooms": low["occupied_rooms"]}
                    if low else None),
            "days_with_records": days_with_records,
        }

    def _attendance_series(self, rows, leave_rows, active_ids: set, d_from: date,
                           d_to: date, op: time) -> dict:
        """Per-day attendance. Expected = active headcount minus approved leave that
        day (leave is not absence). Days without any attendance record are returned
        with state 'no_records' and no percentage, never as zero attendance."""
        by_day: dict[str, dict] = defaultdict(lambda: {"present": set(), "absent": set(), "marked": set()})
        for r in rows:
            if r.employee_id not in active_ids:
                continue
            bucket = by_day[r.attendance_date]
            bucket["marked"].add(r.employee_id)
            if r.status == "present":
                bucket["present"].add(r.employee_id)
            elif r.status == "absent":
                bucket["absent"].add(r.employee_id)
        headcount = len(active_ids)
        points = []
        for i in range((d_to - d_from).days + 1):
            d = d_from + timedelta(days=i)
            key = d.isoformat()
            on_leave = {lr.employee_id for lr in leave_rows
                        if lr.employee_id in active_ids and lr.from_date <= key <= lr.to_date}
            b = by_day.get(key, {"present": set(), "absent": set(), "marked": set()})
            expected = max(headcount - len(on_leave), 0)
            has_marks = bool(b["marked"])
            points.append({
                "date": key,
                "label": d.strftime("%d %b"),
                "state": "available" if has_marks else "no_records",
                "expected": expected,
                "present": len(b["present"]) if has_marks else None,
                "absent": len(b["absent"]) if has_marks else None,
                "on_leave": len(on_leave),
                "not_marked": max(expected - len(b["present"]) - len(b["absent"]), 0) if has_marks else None,
                "attendance_pct": _pct(len(b["present"]), expected) if (has_marks and expected) else None,
            })
        return {
            "points": points,
            "recorded_days": sum(1 for p in points if p["state"] == "available"),
            "period_days": len(points),
            "denominator_note": "Expected = active staff minus approved leave that day, using current headcount for every day.",
        }

    def _attendance_period(self, rows, active_ids: set, d_from: date, d_to: date) -> dict:
        counts = Counter(r.status for r in rows if r.employee_id in active_ids)
        recorded_days = len({r.attendance_date for r in rows})
        span = (d_to - d_from).days + 1
        return {
            "status_counts": dict(counts),
            "recorded_days": recorded_days,
            "period_days": span,
            "attendance_pct": _pct(counts.get("present", 0),
                                   counts.get("present", 0) + counts.get("absent", 0))
            if (counts.get("absent", 0) > 0) else None,
            "late_arrivals": None,
            "late_reason": "Shift schedules are not populated; late arrivals cannot be computed.",
            "trend_reliable": recorded_days >= TREND_RELIABLE_DAYS,
        }

    def _data_quality(self, trend, att_dates_total, att_rows_total, state_mismatch,
                      cleaning_unverified, aband_other, last_ticket, n_rooms,
                      active_n, aband_total) -> list[dict]:
        def item(key, label, state, detail):
            return {"key": key, "label": label, "state": state, "detail": detail}

        out = []
        out.append(item(
            "occupancy_history", "Occupancy trend",
            "available" if trend["reliable"] else ("insufficient" if not trend["first_record_date"] else "limited"),
            trend["reason"] or f"Ledger history from {trend['first_record_date']}.",
        ))
        out.append(item(
            "attendance", "Attendance",
            "insufficient" if att_rows_total < TREND_RELIABLE_DAYS else "available",
            f"{att_rows_total} attendance records across {att_dates_total} dates. "
            "Attendance trends are shown only when enough dates exist.",
        ))
        out.append(item(
            "cleaning_state", "Cleaning status",
            "unverified" if cleaning_unverified else "available",
            f"{cleaning_unverified} of {n_rooms} rooms show 'cleaning' without an open cleaning task. "
            "Counted as unverified, not as cleaning activity." if cleaning_unverified else
            "All rooms in cleaning state have an open cleaning task.",
        ))
        out.append(item(
            "state_mismatch", "Room state vs occupancy ledger",
            "unverified" if state_mismatch else "available",
            f"{state_mismatch} rooms disagree between recorded state and occupancy ledger."
            if state_mismatch else "Recorded state and occupancy ledger agree.",
        ))
        out.append(item(
            "abandoned", "Abandoned tasks",
            "available" if aband_total else "no_records",
            f"{aband_other} abandoned outside expiry-by-design reasons in the period."
            if aband_total else "No abandonment records in the period.",
        ))
        if last_ticket is None:
            out.append(item("maintenance", "Maintenance", "no_records",
                            "No maintenance tickets recorded for this property."))
        else:
            stale = (datetime.now(UTC) - last_ticket).days > 14
            out.append(item("maintenance", "Maintenance", "limited" if stale else "available",
                            f"Most recent ticket created {last_ticket:%d %b %Y}."
                            + (" No recent tickets — absence of tickets is not evidence of no problems."
                               if stale else "")))
        out.append(item(
            "workforce", "Workforce",
            ("limited" if active_n < 5 else "available") if active_n else "no_records",
            f"{active_n} active employees." + (" Small team: rates are not comparable." if 0 < active_n < 5 else "")
            if active_n else "No active employees recorded.",
        ))
        return out

    async def _activity(self, pid: uuid.UUID, p_start: datetime, p_end: datetime,
                        zones: dict) -> list[dict]:
        events: list[dict] = []
        task_events = (await self.session.execute(
            select(TaskHistoryEvent.type, TaskHistoryEvent.at, TaskHistoryEvent.actor_name, Task.title,
                   Task.id)
            .join(Task, Task.id == TaskHistoryEvent.task_id)
            .where(
                Task.property_id == pid,
                TaskHistoryEvent.at >= p_start, TaskHistoryEvent.at < p_end,
                TaskHistoryEvent.type.in_(("completed", "approved", "rejected", "allocated",
                                           "reassigned", "started", "reopened")),
            ).order_by(TaskHistoryEvent.at.desc()).limit(25)
        )).all()
        labels = {"completed": "Task completed", "approved": "Review approved",
                  "rejected": "Review rejected", "allocated": "Task assigned",
                  "reassigned": "Task reassigned", "started": "Task started",
                  "reopened": "Task reopened"}
        for ev in task_events:
            events.append({"kind": "task", "label": labels.get(ev.type, ev.type),
                           "detail": ev.title, "at": _iso(ev.at), "actor": ev.actor_name,
                           "href": "operations/tasks?tab=today" if ev.type != "completed"
                           else "operations/history/tasks"})
        ticket_events = (await self.session.execute(
            select(MaintenanceTicketEvent.action, MaintenanceTicketEvent.created_at,
                   MaintenanceTicketEvent.actor_name, MaintenanceTicket.issue)
            .join(MaintenanceTicket, MaintenanceTicket.id == MaintenanceTicketEvent.ticket_id)
            .where(
                MaintenanceTicket.property_id == pid,
                MaintenanceTicketEvent.created_at >= p_start,
                MaintenanceTicketEvent.created_at < p_end,
                MaintenanceTicketEvent.action.in_(("created", "assigned", "resolved", "closed")),
            ).order_by(MaintenanceTicketEvent.created_at.desc()).limit(25)
        )).all()
        m_labels = {"created": "Maintenance created", "assigned": "Maintenance assigned",
                    "resolved": "Maintenance resolved", "closed": "Maintenance closed"}
        for ev in ticket_events:
            events.append({"kind": "maintenance", "label": m_labels.get(ev.action, ev.action),
                           "detail": ev.issue, "at": _iso(ev.created_at), "actor": ev.actor_name,
                           "href": "operations/tasks?tab=maintenance"})
        occ = (await self.session.execute(
            select(Occupancy.checked_in_at, Occupancy.checked_out_at, Occupancy.guest_name)
            .where(
                Occupancy.property_id == pid,
                ((Occupancy.checked_in_at >= p_start) & (Occupancy.checked_in_at < p_end))
                | ((Occupancy.checked_out_at >= p_start) & (Occupancy.checked_out_at < p_end)),
            ).limit(25)
        )).all()
        for o in occ:
            if p_start <= _aware(o.checked_in_at) < p_end:
                events.append({"kind": "occupancy", "label": "Checked in", "detail": "Unit occupancy",
                               "at": _iso(o.checked_in_at), "actor": None,
                               "href": "property/spaces/units?tab=rooms&status=occupied"})
            if o.checked_out_at and p_start <= _aware(o.checked_out_at) < p_end:
                events.append({"kind": "occupancy", "label": "Checked out", "detail": "Unit occupancy",
                               "at": _iso(o.checked_out_at), "actor": None,
                               "href": "property/spaces/units?tab=rooms"})
        alloc = (await self.session.execute(
            select(AllocationEvent.created_at, AllocationEvent.actor_name, AllocationEvent.to_zone_id)
            .where(
                AllocationEvent.property_id == pid,
                AllocationEvent.created_at >= p_start, AllocationEvent.created_at < p_end,
            ).order_by(AllocationEvent.created_at.desc()).limit(25)
        )).all()
        for a in alloc:
            events.append({"kind": "allocation", "label": "Employee allocation changed",
                           "detail": zones.get(a.to_zone_id, "Unassigned zone"),
                           "at": _iso(a.created_at), "actor": a.actor_name,
                           "href": "workforce/employees?tab=board"})
        events.sort(key=lambda e: e["at"] or "", reverse=True)
        seen, unique = set(), []
        for e in events:  # identical source rows (e.g. duplicate allocation writes) shown once
            key = (e["kind"], e["label"], e["detail"], e["at"])
            if key not in seen:
                seen.add(key)
                unique.append(e)
        return unique[:25]
