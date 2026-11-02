import uuid
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import String, and_, case, cast, column, exists, func, or_, select, table
from sqlalchemy.ext.asyncio import AsyncSession

IST = ZoneInfo("Asia/Kolkata")

from app.dependencies.auth import Forbidden
from app.models.attendance import AttendanceBreak, AttendanceDay, AttendanceRequest
from app.models.employee import Employee
from app.models.maintenance import MaintenanceTicket
from app.models.property import Property
from app.models.shift import EmployeeShiftAssignment, Shift
from app.models.structure import Area, Zone
from app.models.task import Task, TaskCompletionImage, TaskCompletionSubmission, TaskHistoryEvent
from app.models.user import User, UserRole
from app.models.work_allocation import WorkAllocationHistory
from app.schemas.workspace import employee_out
from app.services.shifts import shift_applies_on, shift_window_utc
from app.services.structure import NotFoundErr

# Employee-Backend-owned shared tables — read-only, intentionally NOT ORM-mapped
# here. Never select credential columns (push_token) or precise coordinates.
_device_registrations = table(
    "device_registrations",
    column("id"), column("employee_id"), column("user_id"), column("device_id"),
    column("platform"), column("app_version"), column("is_active"),
    column("last_seen_at"), column("created_at"),
)
_location_events = table(
    "location_events",
    column("id"), column("property_id"), column("employee_id"),
    column("source"), column("flagged"), column("recorded_at"),
)
_location_tracking_sessions = table(
    "location_tracking_sessions",
    column("id"), column("employee_id"), column("status"),
    column("started_at"), column("ended_at"), column("point_count"),
)
_mobile_releases = table(
    "mobile_releases",
    column("id"), column("platform"), column("version"), column("version_code"),
    column("minimum_version"), column("force_update"), column("is_active"),
    column("created_at"),
)


class EmployeeProfileService:
    def __init__(self, session: AsyncSession):
        self.session = session

    @staticmethod
    def properties(user: User):
        if user.role not in (UserRole.SUPER_ADMIN, UserRole.PROPERTY_MANAGER) or not user.company_id:
            raise Forbidden()
        q = select(Property.id).where(Property.company_id == user.company_id)
        if user.role == UserRole.PROPERTY_MANAGER:
            if not user.property_id:
                raise Forbidden()
            q = q.where(Property.id == user.property_id)
        return q

    async def employee(self, user: User, employee_id: uuid.UUID, property_id: uuid.UUID | None = None):
        q = select(Employee, Property.name, Zone.name, Area.name).join(
            Property, Employee.property_id == Property.id
        ).outerjoin(Zone, Employee.zone_id == Zone.id).outerjoin(Area, Employee.area_id == Area.id).where(
            Employee.id == employee_id, Employee.company_id == user.company_id,
            Employee.property_id.in_(self.properties(user)),
        )
        if property_id:
            q = q.where(Employee.property_id == property_id)
        row = (await self.session.execute(q)).one_or_none()
        if row is None:
            raise NotFoundErr("Employee not found.")
        return row[0], {"property_name": row[1], "zone_name": row[2], "area_name": row[3]}

    @staticmethod
    def task_matches(employee_id):
        allocated = or_(Task.employee_id == employee_id, exists(select(WorkAllocationHistory.id).where(
            WorkAllocationHistory.ticket_kind == "task", WorkAllocationHistory.ticket_id == Task.id,
            WorkAllocationHistory.employee_id == employee_id,
        )))
        def submitted(statuses=None):
            q = select(TaskCompletionSubmission.id).where(
                TaskCompletionSubmission.task_id == Task.id, TaskCompletionSubmission.employee_id == employee_id)
            if statuses:
                q = q.where(TaskCompletionSubmission.status.in_(statuses))
            return exists(q)
        def assignee_at(at, task_id):
            return select(WorkAllocationHistory.employee_id).where(
                WorkAllocationHistory.ticket_kind == "task", WorkAllocationHistory.ticket_id == task_id,
                WorkAllocationHistory.property_id == Task.property_id, WorkAllocationHistory.created_at <= at,
            ).order_by(WorkAllocationHistory.created_at.desc(), WorkAllocationHistory.id.desc()).limit(1).correlate(Task, TaskHistoryEvent).scalar_subquery()
        historical_abandonment = exists(select(TaskHistoryEvent.id).where(
            TaskHistoryEvent.task_id == Task.id, TaskHistoryEvent.type == "abandoned",
            assignee_at(TaskHistoryEvent.at, TaskHistoryEvent.task_id) == employee_id,
        ))
        abandoned_snapshot = and_(Task.abandoned_at.is_not(None), assignee_at(Task.abandoned_at, Task.id) == employee_id)
        legacy_abandoned = and_(Task.employee_id == employee_id, Task.status == "abandoned",
            ~exists(select(WorkAllocationHistory.id).where(
                WorkAllocationHistory.ticket_kind == "task", WorkAllocationHistory.ticket_id == Task.id)))
        return {
            "all": or_(allocated, submitted()), "allocated": allocated,
            "completed": submitted(("approved",)),
            "rejected": submitted(("disapproved",)),
            "pending_review": submitted(("pending",)),
            "abandoned": or_(historical_abandonment, abandoned_snapshot, legacy_abandoned),
            "current_open": and_(Task.employee_id == employee_id,
                                 Task.status.not_in(("completed", "cancelled", "abandoned"))),
        }

    def _alloc_max_date(self, employee_id):
        return select(func.max(WorkAllocationHistory.created_at)).where(
            WorkAllocationHistory.ticket_kind == "task", WorkAllocationHistory.ticket_id == Task.id,
            WorkAllocationHistory.employee_id == employee_id,
        ).correlate(Task).scalar_subquery()

    def _sub_max_date(self, employee_id, status=None):
        q = select(func.max(TaskCompletionSubmission.submitted_at)).where(
            TaskCompletionSubmission.task_id == Task.id,
            TaskCompletionSubmission.employee_id == employee_id)
        if status:
            q = q.where(TaskCompletionSubmission.status == status)
        return q.correlate(Task).scalar_subquery()

    def task_date_columns(self, employee_id) -> dict:
        abandoned_at = select(func.max(TaskHistoryEvent.at)).where(
            TaskHistoryEvent.task_id == Task.id, TaskHistoryEvent.type == "abandoned"
        ).correlate(Task).scalar_subquery()
        return {
            "all": func.coalesce(self._sub_max_date(employee_id), self._alloc_max_date(employee_id), Task.created_at),
            "allocated": func.coalesce(self._alloc_max_date(employee_id), Task.created_at),
            "completed": self._sub_max_date(employee_id, "approved"),
            "rejected": self._sub_max_date(employee_id, "disapproved"),
            "pending_review": self._sub_max_date(employee_id, "pending"),
            "abandoned": func.coalesce(Task.abandoned_at, abandoned_at, Task.created_at),
            "current_open": Task.created_at,
        }

    @staticmethod
    def in_range(column, date_from, date_to):
        conditions = []
        if date_from is not None:
            conditions.append(column >= date_from)
        if date_to is not None:
            conditions.append(column < date_to)
        return conditions

    @staticmethod
    def ist_key(dt):
        return dt.astimezone(IST).date().isoformat()

    async def profile(self, user: User, employee_id: uuid.UUID, property_id=None,
                      date_from: datetime | None = None, date_to: datetime | None = None):
        employee, context = await self.employee(user, employee_id, property_id)
        properties = self.properties(user)
        matches = self.task_matches(employee.id)
        date_columns = self.task_date_columns(employee.id)
        task_stats = (await self.session.execute(select(*(
            func.count(Task.id).filter(condition, *self.in_range(
                date_columns[key], date_from, date_to)).label(key)
            for key, condition in matches.items()
            if key != "all"
        )).where(Task.property_id.in_(properties)))).mappings().one()
        attendance = (await self.session.execute(select(
            func.count(AttendanceDay.id).label("recorded_days"),
            func.count(AttendanceDay.id).filter(AttendanceDay.status == "present").label("present_days"),
            func.count(AttendanceDay.id).filter(AttendanceDay.status == "absent").label("absent_days"),
            func.count(AttendanceDay.id).filter(AttendanceDay.status == "leave").label("leave_days"),
            func.count(AttendanceDay.id).filter(AttendanceDay.status == "week_off").label("week_off_days"),
            func.sum(case((and_(AttendanceDay.ended_at.is_not(None), AttendanceDay.work_seconds >= 0),
                           AttendanceDay.work_seconds), else_=None)).label("recorded_work_seconds"),
        ).where(AttendanceDay.employee_id == employee.id, AttendanceDay.property_id.in_(properties)))).mappings().one()
        requests = (await self.session.execute(select(
            func.count(AttendanceRequest.id).filter(AttendanceRequest.status == "pending").label("pending_requests"),
            func.count(AttendanceRequest.id).filter(AttendanceRequest.status == "approved").label("approved_requests"),
            func.count(AttendanceRequest.id).filter(AttendanceRequest.status == "rejected").label("rejected_requests"),
        ).where(AttendanceRequest.employee_id == employee.id, AttendanceRequest.property_id.in_(properties)))).mappings().one()
        return {"employee": employee_out(employee), "context": context, "tasks": dict(task_stats),
                "attendance": dict(attendance), "leave_requests": dict(requests)}

    async def page(self, q, *, page, limit, ordering):
        total = (await self.session.execute(select(func.count()).select_from(q.subquery()))).scalar_one()
        rows = (await self.session.execute(q.order_by(*ordering).offset((page - 1) * limit).limit(limit))).mappings().all()
        return {"items": [dict(row) for row in rows], "total": total, "page": page, "limit": limit}

    def _task_rows(self, user: User, employee_id: uuid.UUID, filter, search, date_from, date_to):
        matches = self.task_matches(employee_id)
        latest = select(TaskCompletionSubmission.id).where(
            TaskCompletionSubmission.task_id == Task.id, TaskCompletionSubmission.employee_id == employee_id)
        review_filter = {"completed": "approved", "rejected": "disapproved", "pending_review": "pending"}.get(filter)
        if review_filter:
            latest = latest.where(TaskCompletionSubmission.status == review_filter)
        latest = latest.order_by(TaskCompletionSubmission.attempt_number.desc(), TaskCompletionSubmission.submitted_at.desc(), TaskCompletionSubmission.id.desc()).limit(1).correlate(Task).scalar_subquery()
        def submission_field(column):
            return select(column).where(TaskCompletionSubmission.id == latest).correlate(Task).scalar_subquery()
        submitted_at = submission_field(TaskCompletionSubmission.submitted_at)
        previous_submission = select(func.max(TaskCompletionSubmission.submitted_at)).where(
            TaskCompletionSubmission.task_id == Task.id,
            TaskCompletionSubmission.attempt_number < submission_field(TaskCompletionSubmission.attempt_number)
        ).correlate(Task).scalar_subquery()
        started_at = select(func.max(TaskHistoryEvent.at)).where(
            TaskHistoryEvent.task_id == Task.id, TaskHistoryEvent.type == "started",
            TaskHistoryEvent.at <= submitted_at,
            or_(previous_submission.is_(None), TaskHistoryEvent.at > previous_submission),
        ).correlate(Task).scalar_subquery()
        start_assignee = select(WorkAllocationHistory.employee_id).where(
            WorkAllocationHistory.ticket_kind == "task", WorkAllocationHistory.ticket_id == Task.id,
            WorkAllocationHistory.created_at <= started_at,
        ).order_by(WorkAllocationHistory.created_at.desc(), WorkAllocationHistory.id.desc()).limit(1).correlate(Task).scalar_subquery()
        interrupted = exists(select(WorkAllocationHistory.id).where(
            WorkAllocationHistory.ticket_kind == "task", WorkAllocationHistory.ticket_id == Task.id,
            WorkAllocationHistory.created_at > started_at, WorkAllocationHistory.created_at <= submitted_at,
            or_(WorkAllocationHistory.employee_id.is_(None), WorkAllocationHistory.employee_id != employee_id),
        )).correlate(Task)
        q = select(
            cast(Task.id, String).label("task_uid"), Task.title, Task.ticket_number,
            cast(Task.property_id, String).label("property_uid"), Property.name.label("property_name"),
            Task.status.label("current_status"), Task.assigned_to_name.label("current_assignee"),
            Task.created_at, Task.completed_at, Task.abandoned_at, Task.abandoned_reason,
            cast(latest, String).label("submission_uid"), submitted_at.label("submitted_at"),
            submission_field(TaskCompletionSubmission.status).label("review_status"),
            submission_field(TaskCompletionSubmission.attempt_number).label("attempt_number"),
            submission_field(TaskCompletionSubmission.reviewed_at).label("reviewed_at"),
            submission_field(TaskCompletionSubmission.reviewed_by_name).label("reviewed_by"),
            submission_field(TaskCompletionSubmission.review_comment).label("review_comment"),
            started_at.label("recorded_start_at"), interrupted.label("assignment_changed_during_attempt"),
            (start_assignee == employee_id).label("start_assignment_matches_employee"),
        ).join(Property, Task.property_id == Property.id).where(
            Task.property_id.in_(self.properties(user)), matches[filter],
            *self.in_range(self.task_date_columns(employee_id)[filter], date_from, date_to))
        if search:
            term = f"%{search.replace('/', '//').replace('%', '/%').replace('_', '/_')}%"
            q = q.where(or_(*(column.ilike(term, escape="/") for column in
                             (Task.title, Task.ticket_number, cast(Task.id, String)))))
        return q

    @staticmethod
    def _duration_seconds(row):
        start, end = row.get("recorded_start_at"), row.get("submitted_at")
        seconds = (end - start).total_seconds() if start and end else None
        return (int(seconds) if seconds is not None and seconds >= 0 and
                row.get("start_assignment_matches_employee") and
                not row.get("assignment_changed_during_attempt") else None)

    async def tasks(self, user: User, employee_id: uuid.UUID, *, property_id=None,
                    filter="all", search=None, page=1, limit=25,
                    date_from: datetime | None = None, date_to: datetime | None = None):
        employee, _ = await self.employee(user, employee_id, property_id)
        q = self._task_rows(user, employee.id, filter, search, date_from, date_to)
        result = await self.page(q, page=page, limit=limit, ordering=(Task.created_at.desc(), Task.id))
        for row in result["items"]:
            row["start_to_submission_seconds"] = self._duration_seconds(row)
        return result

    @staticmethod
    def _bucket_key(dt, bucket: str) -> str:
        local = dt.astimezone(IST)
        if bucket == "month":
            return local.strftime("%Y-%m")
        if bucket == "week":
            y, w, _ = local.isocalendar()
            return f"{y}-W{w:02d}"
        return local.date().isoformat()

    async def analytics(self, user: User, employee_id: uuid.UUID, *, property_id=None,
                        date_from: datetime | None = None, date_to: datetime | None = None,
                        bucket: str = "day") -> dict:
        employee, _ = await self.employee(user, employee_id, property_id)
        properties = self.properties(user)
        matches = self.task_matches(employee.id)
        rng = (date_from, date_to)

        stats = (await self.session.execute(
            select(TaskCompletionSubmission.status, func.count()).join(
                Task, TaskCompletionSubmission.task_id == Task.id).where(
                TaskCompletionSubmission.employee_id == employee.id,
                Task.property_id.in_(properties),
                *self.in_range(TaskCompletionSubmission.submitted_at, *rng),
            ).group_by(TaskCompletionSubmission.status))).all()
        submissions = {"total": 0, "approved": 0, "disapproved": 0, "pending": 0}
        for status_key, n in stats:
            submissions["total"] += n
            if status_key in submissions:
                submissions[status_key] = n
        decided = submissions["approved"] + submissions["disapproved"]
        submissions["approval_rate"] = (round(submissions["approved"] / decided, 4)
                                      if decided else None)

        alloc_rows = (await self.session.execute(select(WorkAllocationHistory.created_at).where(
            WorkAllocationHistory.ticket_kind == "task",
            WorkAllocationHistory.employee_id == employee.id,
            WorkAllocationHistory.property_id.in_(properties),
            *self.in_range(WorkAllocationHistory.created_at, *rng)))).scalars().all()
        sub_rows = (await self.session.execute(
            select(TaskCompletionSubmission.submitted_at, TaskCompletionSubmission.status).join(
                Task, TaskCompletionSubmission.task_id == Task.id).where(
                TaskCompletionSubmission.employee_id == employee.id,
                Task.property_id.in_(properties),
                *self.in_range(TaskCompletionSubmission.submitted_at, *rng)))).all()
        abandoned_col = self.task_date_columns(employee.id)["abandoned"]
        abandoned_rows = (await self.session.execute(select(abandoned_col).where(
            Task.property_id.in_(properties), self.task_matches(employee.id)["abandoned"],
            *self.in_range(abandoned_col, *rng)))).scalars().all()

        series: dict[str, dict] = {}
        def bump(at, key):
            if at is None:
                return
            row = series.setdefault(self._bucket_key(at, bucket), {
                "bucket": self._bucket_key(at, bucket), "allocated": 0, "submitted": 0,
                "approved": 0, "disapproved": 0, "pending": 0, "abandoned": 0})
            row[key] += 1
        for at in alloc_rows:
            bump(at, "allocated")
        for at, status_key in sub_rows:
            bump(at, "submitted")
            if status_key in ("approved", "disapproved", "pending"):
                bump(at, status_key)
        for at in abandoned_rows:
            bump(at, "abandoned")

        task_q = self._task_rows(user, employee.id, "all", None, date_from, date_to)
        rows = (await self.session.execute(task_q)).mappings().all()
        durations = [self._duration_seconds(dict(r)) for r in rows if r["submitted_at"]]
        valid = [s for s in durations if s is not None]
        import statistics
        duration_stats = {
            "eligible": len(valid), "unavailable": len(durations) - len(valid),
            "median_seconds": statistics.median(valid) if valid else None,
            "buckets": {
                "under_15_min": sum(1 for s in valid if s < 900),
                "min_15_30": sum(1 for s in valid if 900 <= s < 1800),
                "min_30_60": sum(1 for s in valid if 1800 <= s < 3600),
                "over_60_min": sum(1 for s in valid if s >= 3600),
            },
        }
        # Workload breakdowns over allocated tasks
        alloc_cond = [Task.property_id.in_(properties), matches["allocated"],
                      *self.in_range(self.task_date_columns(employee.id)["allocated"], *rng)]
        breakdown = {"by_priority": {}, "by_type": {}, "by_status": {}}
        for col, key in ((Task.priority, "by_priority"), (Task.task_type, "by_type"),
                         (Task.status, "by_status")):
            rows = (await self.session.execute(select(col, func.count(Task.id.distinct())).where(*alloc_cond).group_by(col))).all()
            breakdown[key] = {str(v or "unspecified"): n for v, n in rows}

        # Review turnaround (reviewer processing time) + first-attempt outcomes
        rev_rows = (await self.session.execute(select(
            TaskCompletionSubmission.task_id, TaskCompletionSubmission.submitted_at,
            TaskCompletionSubmission.reviewed_at,
            TaskCompletionSubmission.attempt_number, TaskCompletionSubmission.status).join(
            Task, TaskCompletionSubmission.task_id == Task.id).where(
            TaskCompletionSubmission.employee_id == employee.id, Task.property_id.in_(properties),
            *self.in_range(TaskCompletionSubmission.submitted_at, *rng)))).all()
        import statistics as _st
        turnaround = [(r.submitted_at, r.reviewed_at) for r in rev_rows if r.submitted_at and r.reviewed_at]
        ta_secs = sorted((rv - sb).total_seconds() for sb, rv in turnaround)
        first = [r for r in rev_rows if r.attempt_number == 1]
        first_decided = [r for r in first if r.status in ("approved", "disapproved")]
        review = {
            "turnaround_median_seconds": _st.median(ta_secs) if ta_secs else None,
            "turnaround_avg_seconds": round(sum(ta_secs) / len(ta_secs)) if ta_secs else None,
            "reviewed": len(ta_secs),
            "first_attempt_decided": len(first_decided),
            "first_attempt_approved": sum(1 for r in first_decided if r.status == "approved"),
        }
        review["first_attempt_approval_rate"] = (round(review["first_attempt_approved"] / len(first_decided), 4)
                                               if first_decided else None)
        per_task_attempts: dict = {}
        for r in rev_rows:
            per_task_attempts[r.task_id] = per_task_attempts.get(r.task_id, 0) + 1
        review["tasks_with_rework"] = sum(1 for n in per_task_attempts.values() if n > 1)
        review["tasks_with_attempts"] = len(per_task_attempts)

        # Maintenance contribution (kept separate from task metrics).
        # Attribution: MaintenanceTicket has no direct employee column — the
        # allocation ledger is the only provable link.
        maint = {"allocated": 0, "resolved": 0, "open": 0, "reassigned_away": 0,
                 "currently_assigned": 0, "resolution_rate": None,
                 "median_resolution_seconds": None, "by_zone": {}}
        maint_ids = select(WorkAllocationHistory.ticket_id).where(
            WorkAllocationHistory.ticket_kind == "maintenance",
            WorkAllocationHistory.employee_id == employee.id,
            WorkAllocationHistory.property_id.in_(properties),
            *self.in_range(WorkAllocationHistory.created_at, *rng))
        maint_sub = maint_ids.subquery()
        maint["allocated"] = (await self.session.execute(
            select(func.count(maint_sub.c.ticket_id.distinct())))).scalar() or 0
        maint["reassigned_away"] = (await self.session.execute(
            select(func.count(WorkAllocationHistory.ticket_id.distinct())).where(
                WorkAllocationHistory.ticket_kind == "maintenance",
                WorkAllocationHistory.previous_employee_id == employee.id,
                WorkAllocationHistory.property_id.in_(properties),
                *self.in_range(WorkAllocationHistory.created_at, *rng)))).scalar() or 0
        mstats = (await self.session.execute(
            select(MaintenanceTicket.status, func.count(MaintenanceTicket.id.distinct())).join(
                maint_sub, MaintenanceTicket.id == maint_sub.c.ticket_id).group_by(
                MaintenanceTicket.status))).all()
        for st_, n in mstats:
            if st_ in ("resolved", "closed"):
                maint["resolved"] += n
            else:
                maint["open"] += n
        maint["resolution_rate"] = (round(maint["resolved"] / maint["allocated"], 4)
                                  if maint["allocated"] else None)
        maint["currently_assigned"] = (await self.session.execute(
            select(func.count(MaintenanceTicket.id)).where(
                MaintenanceTicket.assigned_to == employee.id,
                MaintenanceTicket.property_id.in_(properties),
                MaintenanceTicket.status.not_in(("closed", "cancelled"))))).scalar() or 0
        res_rows = (await self.session.execute(
            select(MaintenanceTicket.created_at, MaintenanceTicket.resolved_at,
                   Zone.name)
            .join(maint_sub, MaintenanceTicket.id == maint_sub.c.ticket_id)
            .outerjoin(Zone, MaintenanceTicket.zone_id == Zone.id))).all()
        res_secs = sorted((r.resolved_at - r.created_at).total_seconds()
                          for r in res_rows if r.resolved_at and r.created_at)
        if res_secs:
            import statistics as _st2
            maint["median_resolution_seconds"] = _st2.median(res_secs)
        for r in res_rows:
            if r[2]:
                maint["by_zone"][r[2]] = maint["by_zone"].get(r[2], 0) + 1

        # Attendance work-hour aggregates + per-day status map for the calendar
        att_rows = (await self.session.execute(select(
            AttendanceDay.attendance_date, AttendanceDay.status, AttendanceDay.work_seconds,
            AttendanceDay.started_at, AttendanceDay.ended_at).where(
            AttendanceDay.employee_id == employee.id, AttendanceDay.property_id.in_(properties),
            *self.in_range(AttendanceDay.attendance_date,
                           self.ist_key(date_from) if date_from else None,
                           self.ist_key(date_to) if date_to else None)))).all()
        att = {"days": {str(r.attendance_date): {
                    "status": r.status,
                    "started_at": r.started_at.isoformat() if r.started_at else None,
                    "ended_at": r.ended_at.isoformat() if r.ended_at else None,
                    "work_seconds": r.work_seconds} for r in att_rows[:500]},
               "truncated": len(att_rows) > 500,
               "present_with_hours": 0, "total_work_seconds": 0, "total_break_seconds": 0,
               "incomplete": 0}
        present_secs = [r.work_seconds for r in att_rows if r.status == "present" and r.work_seconds]
        att["present_with_hours"] = len(present_secs)
        att["total_work_seconds"] = sum(present_secs)
        att["avg_work_seconds"] = round(sum(present_secs) / len(present_secs)) if present_secs else None
        # Incomplete = a present record that was never clocked out (open session),
        # plus any explicit partial/incomplete status if the EB ever writes one.
        att["incomplete"] = sum(1 for r in att_rows if r.status in ("incomplete", "partial") or
                                (r.status == "present" and r.started_at and not r.ended_at))
        att["break_seconds_total"] = (await self.session.execute(
            select(func.coalesce(func.sum(AttendanceDay.break_seconds), 0)).where(
                AttendanceDay.employee_id == employee.id, AttendanceDay.property_id.in_(properties),
                *self.in_range(AttendanceDay.attendance_date,
                               self.ist_key(date_from) if date_from else None,
                               self.ist_key(date_to) if date_to else None)))).scalar() or 0

        # Location workload — join allocated tasks to zone/area names
        location = {"by_zone": {}, "by_area": {}}
        for join_col, model, key in ((Task.zone_id, Zone, "by_zone"), (Task.area_id, Area, "by_area")):
            rows = (await self.session.execute(select(model.name, func.count(Task.id.distinct()))
                .join(model, join_col == model.id).where(*alloc_cond).group_by(model.name))).all()
            location[key] = {n: c for n, c in rows if n}

        # Shift adherence — evaluate attendance days against the shift
        # assignment EFFECTIVE on each date (latest effective_from wins), using
        # the shared helpers so overnight windows + working-days bitmap are
        # honored. Missing data is never classified as late/on-time.
        assigns = (await self.session.execute(
            select(EmployeeShiftAssignment, Shift)
            .join(Shift, EmployeeShiftAssignment.shift_id == Shift.id)
            .where(EmployeeShiftAssignment.employee_id == employee.id)
            .order_by(EmployeeShiftAssignment.effective_from.desc(),
                      EmployeeShiftAssignment.created_at.desc()))).all()

        def _effective(day: str):
            for a, s in assigns:
                if a.effective_from <= day and (a.effective_until is None or day <= a.effective_until):
                    return s
            return None

        adher = {"evaluated": 0, "on_time": 0, "late": 0, "early_departures": 0,
                 "unclassified": 0, "median_late_seconds": None,
                 "avg_late_seconds": None, "days": [], "trend": {}}
        late_secs: list[float] = []
        for r in att_rows:
            day_key = str(r.attendance_date)
            if r.status != "present" or not r.started_at:
                continue
            shift = _effective(day_key)
            if shift is None or not shift_applies_on(shift, day_key):
                adher["unclassified"] += 1
                continue
            start_utc, end_utc = shift_window_utc(shift, day_key)
            started = r.started_at if r.started_at.tzinfo else r.started_at.replace(
                tzinfo=timezone.utc)
            ended = (r.ended_at if r.ended_at.tzinfo else r.ended_at.replace(
                tzinfo=timezone.utc)) if r.ended_at else None
            arr_dev = (started - start_utc).total_seconds()
            dep_dev = (end_utc - ended).total_seconds() if ended else None
            adher["evaluated"] += 1
            on_time = arr_dev <= shift.grace_minutes * 60
            early_dep = dep_dev is not None and dep_dev > shift.early_exit_minutes * 60
            if on_time:
                adher["on_time"] += 1
            else:
                adher["late"] += 1
                late_secs.append(float(arr_dev))
            if early_dep:
                adher["early_departures"] += 1
            trend = adher["trend"].setdefault(self._bucket_key(r.started_at, bucket),
                                              {"on_time": 0, "late": 0})
            trend["late" if not on_time else "on_time"] += 1
            adher["days"].append({
                "date": day_key, "shift_name": shift.name,
                "scheduled_start": start_utc.isoformat(), "scheduled_end": end_utc.isoformat(),
                "actual_start": r.started_at.isoformat(), "actual_end": r.ended_at.isoformat() if r.ended_at else None,
                "arrival_deviation_seconds": int(arr_dev),
                "departure_deviation_seconds": int(dep_dev) if dep_dev is not None else None,
                "arrival": "on_time" if on_time else "late",
                "early_departure": early_dep,
            })
        if late_secs:
            import statistics
            adher["median_late_seconds"] = statistics.median(late_secs)
            adher["avg_late_seconds"] = round(sum(late_secs) / len(late_secs))
        adher["days"].sort(key=lambda d: d["date"], reverse=True)
        adher["trend"] = [{"bucket": k, **v} for k, v in sorted(adher["trend"].items())]

        # Previous-period comparison — symmetric metrics for the same-length
        # window immediately before date_from (exclusive bounds both sides).
        current_metrics = await self._period_metrics(user, employee.id, properties, rng)
        previous_metrics = None
        if date_from and date_to:
            span = date_to - date_from
            previous_metrics = await self._period_metrics(
                user, employee.id, properties, (date_from - span, date_from))
        open_now = (await self.session.execute(select(func.count(Task.id)).where(
            Task.property_id.in_(properties), Task.employee_id == employee.id,
            Task.status.not_in(("completed", "cancelled", "abandoned"))))).scalar() or 0

        def _rate(a, b):
            return round(a / b, 4) if b else None

        def _kpi(cur, prev):
            return {"current": cur, "previous": prev if previous_metrics else None}

        p = previous_metrics or {}
        kpis = {
            "tasks_allocated": _kpi(current_metrics["allocated"], p.get("allocated")),
            "tasks_completed": _kpi(current_metrics["completed"], p.get("completed")),
            "tasks_open": {"current": open_now, "previous": None},
            "tasks_abandoned": _kpi(current_metrics["abandoned"], p.get("abandoned")),
            "rejected_attempts": _kpi(current_metrics["rejected_attempts"],
                                    p.get("rejected_attempts")),
            "completion_rate": _kpi(
                _rate(current_metrics["completed"], current_metrics["allocated"]),
                _rate(p.get("completed", 0), p.get("allocated", 0)) if previous_metrics else None),
            "first_attempt_approval_rate": _kpi(
                _rate(current_metrics["first_attempt_approved"],
                      current_metrics["first_attempt_decided"]),
                _rate(p.get("first_attempt_approved", 0),
                      p.get("first_attempt_decided", 0)) if previous_metrics else None),
            "rework_tasks": _kpi(current_metrics["rework_tasks"], p.get("rework_tasks")),
            "review_turnaround_median_seconds": _kpi(
                current_metrics["review_turnaround_median_seconds"],
                p.get("review_turnaround_median_seconds")),
            "maintenance_allocated": _kpi(current_metrics["maintenance_allocated"],
                                          p.get("maintenance_allocated")),
        }
        insights = self._insights(current_metrics, previous_metrics, breakdown, location, maint)

        # Backward-compatible scalar block used by the older UI + tests.
        previous = None
        if previous_metrics is not None:
            previous = {"allocated": previous_metrics["allocated"],
                        "submissions": previous_metrics["submissions_total"],
                        "abandoned": previous_metrics["abandoned"],
                        "completed": previous_metrics["completed"]}

        return {"series": [series[k] for k in sorted(series)], "bucket": bucket,
                "submissions": submissions, "durations": duration_stats,
                "breakdown": breakdown, "review": review, "maintenance": maint,
                "attendance": att, "previous_period": previous,
                "kpis": kpis, "insights": insights,
                "location": location, "shift_adherence": adher}

    async def _period_metrics(self, user: User, employee_id: uuid.UUID, properties, rng) -> dict:
        """Symmetric per-period metric bundle used for current-vs-previous KPI
        deltas. All counts are distinct task/ticket IDs; submission rows are
        attempts (kept separate by the caller)."""
        matches = self.task_matches(employee_id)
        date_columns = self.task_date_columns(employee_id)
        out: dict = {}
        for key in ("allocated", "completed", "abandoned"):
            out[key] = (await self.session.execute(select(func.count(Task.id.distinct())).where(
                Task.property_id.in_(properties), matches[key],
                *self.in_range(date_columns[key], *rng)))).scalar() or 0
        sub_rows = (await self.session.execute(
            select(TaskCompletionSubmission.task_id, TaskCompletionSubmission.status,
                   TaskCompletionSubmission.attempt_number,
                   TaskCompletionSubmission.submitted_at,
                   TaskCompletionSubmission.reviewed_at).join(
                Task, TaskCompletionSubmission.task_id == Task.id).where(
                TaskCompletionSubmission.employee_id == employee_id,
                Task.property_id.in_(properties),
                *self.in_range(TaskCompletionSubmission.submitted_at, *rng)))).all()
        out["submissions_total"] = len(sub_rows)
        out["approved_attempts"] = sum(1 for r in sub_rows if r.status == "approved")
        out["rejected_attempts"] = sum(1 for r in sub_rows if r.status == "disapproved")
        first = [r for r in sub_rows if r.attempt_number == 1]
        decided = [r for r in first if r.status in ("approved", "disapproved")]
        out["first_attempt_decided"] = len(decided)
        out["first_attempt_approved"] = sum(1 for r in decided if r.status == "approved")
        per_task: dict = {}
        for r in sub_rows:
            per_task[r.task_id] = per_task.get(r.task_id, 0) + 1
        out["tasks_with_attempts"] = len(per_task)
        out["rework_tasks"] = sum(1 for n in per_task.values() if n > 1)
        ta = sorted((r.reviewed_at - r.submitted_at).total_seconds()
                    for r in sub_rows if r.reviewed_at and r.submitted_at)
        out["review_turnaround_median_seconds"] = (
            __import__("statistics").median(ta) if ta else None)
        out["maintenance_allocated"] = (await self.session.execute(
            select(func.count(WorkAllocationHistory.ticket_id.distinct())).where(
                WorkAllocationHistory.ticket_kind == "maintenance",
                WorkAllocationHistory.employee_id == employee_id,
                WorkAllocationHistory.property_id.in_(properties),
                *self.in_range(WorkAllocationHistory.created_at, *rng)))).scalar() or 0
        return out

    @staticmethod
    def _insights(cur: dict, prev: dict | None, breakdown: dict,
                  location: dict, maint: dict) -> list[dict]:
        """Deterministic, evidence-based observations. Every rule names the
        values it compared; nothing fires without a defined baseline."""
        out: list[dict] = []

        def add(id_, severity, text):
            out.append({"id": id_, "severity": severity, "text": text})

        if prev:
            if cur["abandoned"] >= 2 and cur["abandoned"] > prev["abandoned"]:
                add("abandonment_up", "warning",
                    f"Abandonments while assigned rose to {cur['abandoned']} "
                    f"(from {prev['abandoned']} in the previous period). Worth "
                    f"reviewing allocation fit or workload.")
            if prev["completed"] and cur["completed"] > prev["completed"] * 1.5:
                add("completion_up", "positive",
                    f"Completed work rose to {cur['completed']} tasks "
                    f"(from {prev['completed']} in the previous period).")
            if prev["allocated"] and cur["allocated"] > prev["allocated"] * 1.5:
                add("workload_up", "neutral",
                    f"Allocated workload rose to {cur['allocated']} tasks "
                    f"(from {prev['allocated']} previously).")
            cur_rate = (cur["first_attempt_approved"] / cur["first_attempt_decided"]
                        if cur["first_attempt_decided"] else None)
            prev_rate = (prev["first_attempt_approved"] / prev["first_attempt_decided"]
                         if prev["first_attempt_decided"] else None)
            if cur_rate is not None and prev_rate is not None and prev_rate - cur_rate >= 0.10:
                add("approval_down", "warning",
                    f"First-attempt approval fell {round((prev_rate - cur_rate) * 100)} "
                    f"percentage points to {round(cur_rate * 100)}% this period.")
            if prev["rejected_attempts"] is not None and cur["rejected_attempts"] > prev["rejected_attempts"] + 1:
                add("rejections_up", "warning",
                    f"Rejected submission attempts rose to {cur['rejected_attempts']} "
                    f"(from {prev['rejected_attempts']} previously).")
        total_alloc = cur["allocated"]
        by_type = breakdown.get("by_type") or {}
        top_type = max(by_type.items(), key=lambda kv: kv[1], default=None)
        if total_alloc >= 5 and top_type and top_type[1] / total_alloc >= 0.6:
            add("type_concentration", "neutral",
                f"'{top_type[0]}' work makes up {round(top_type[1] / total_alloc * 100)}% "
                f"of allocated tasks this period — workload is concentrated in one type.")
        by_zone = location.get("by_zone") or {}
        top_zone = max(by_zone.items(), key=lambda kv: kv[1], default=None)
        if total_alloc >= 5 and top_zone and top_zone[1] / total_alloc >= 0.5:
            add("zone_concentration", "neutral",
                f"{round(top_zone[1] / total_alloc * 100)}% of allocated tasks were in "
                f"'{top_zone[0]}' — work is concentrated in one zone.")
        work_total = cur["allocated"] + maint["allocated"]
        if work_total >= 5 and maint["allocated"] / work_total >= 0.3:
            add("maintenance_share", "warning",
                f"Maintenance tickets are {round(maint['allocated'] / work_total * 100)}% "
                f"of total allocated work this period ({maint['allocated']} tickets) — "
                f"unusually high maintenance load.")
        if cur["tasks_with_attempts"] >= 3 and cur["rework_tasks"] / cur["tasks_with_attempts"] >= 0.4:
            add("rework_high", "warning",
                f"{cur['rework_tasks']} of {cur['tasks_with_attempts']} submitted tasks "
                f"needed more than one attempt this period.")
        return out

    async def records(self, user: User, employee_id: uuid.UUID, *, kind, property_id=None, page=1, limit=25,
                      date_from: datetime | None = None, date_to: datetime | None = None,
                      direction: str | None = None, ticket_kind: str | None = None):
        employee, _ = await self.employee(user, employee_id, property_id)
        properties = self.properties(user)
        if kind == "attendance":
            q = select(
                cast(AttendanceDay.id, String).label("record_uid"), AttendanceDay.attendance_date,
                AttendanceDay.status, AttendanceDay.started_at, AttendanceDay.ended_at,
                AttendanceDay.work_seconds, AttendanceDay.break_seconds, Property.name.label("property_name"),
            ).join(Property, AttendanceDay.property_id == Property.id).where(
                AttendanceDay.employee_id == employee.id, AttendanceDay.property_id.in_(properties),
                *self.in_range(AttendanceDay.attendance_date, self.ist_key(date_from) if date_from else None,
                               self.ist_key(date_to) if date_to else None))
            ordering = (AttendanceDay.attendance_date.desc(), AttendanceDay.id)
        elif kind == "leaves":
            q = select(
                cast(AttendanceRequest.id, String).label("record_uid"), AttendanceRequest.request_type,
                AttendanceRequest.leave_type, AttendanceRequest.from_date, AttendanceRequest.to_date,
                AttendanceRequest.requested_days, AttendanceRequest.reason, AttendanceRequest.status,
                AttendanceRequest.reviewed_by_name, AttendanceRequest.reviewed_at,
                AttendanceRequest.review_comment, AttendanceRequest.created_at, Property.name.label("property_name"),
            ).join(Property, AttendanceRequest.property_id == Property.id).where(
                AttendanceRequest.employee_id == employee.id, AttendanceRequest.property_id.in_(properties),
                *self.in_range(AttendanceRequest.created_at, date_from, date_to))
            ordering = (AttendanceRequest.created_at.desc(), AttendanceRequest.id)
        elif kind == "shifts":
            q = select(
                cast(EmployeeShiftAssignment.id, String).label("record_uid"), Shift.name,
                Shift.start_time, Shift.end_time, Shift.working_days, Shift.grace_minutes,
                Shift.early_exit_minutes, EmployeeShiftAssignment.effective_from,
                EmployeeShiftAssignment.effective_until, EmployeeShiftAssignment.created_by_name,
                Property.name.label("property_name"),
            ).join(Shift, EmployeeShiftAssignment.shift_id == Shift.id).join(
                Property, Shift.property_id == Property.id).where(
                EmployeeShiftAssignment.employee_id == employee.id, Shift.company_id == user.company_id,
                Shift.property_id.in_(properties),
                *self.in_range(EmployeeShiftAssignment.effective_from,
                               self.ist_key(date_from) if date_from else None,
                               self.ist_key(date_to) if date_to else None))
            ordering = (EmployeeShiftAssignment.effective_from.desc(), EmployeeShiftAssignment.id)
        elif kind == "allocations":
            q = select(
                cast(WorkAllocationHistory.id, String).label("record_uid"), WorkAllocationHistory.ticket_kind,
                WorkAllocationHistory.ticket_number, WorkAllocationHistory.employee_name,
                WorkAllocationHistory.previous_employee_name, WorkAllocationHistory.allocation_method,
                WorkAllocationHistory.reason, WorkAllocationHistory.actor_name, WorkAllocationHistory.created_at,
                cast(WorkAllocationHistory.employee_id, String).label("employee_uid"),
                cast(WorkAllocationHistory.previous_employee_id, String).label("previous_employee_uid"),
                cast(WorkAllocationHistory.ticket_id, String).label("work_uid"),
                Property.name.label("property_name"),
            ).join(Property, WorkAllocationHistory.property_id == Property.id).where(
                or_(WorkAllocationHistory.employee_id == employee.id,
                    WorkAllocationHistory.previous_employee_id == employee.id),
                WorkAllocationHistory.property_id.in_(properties),
                *self.in_range(WorkAllocationHistory.created_at, date_from, date_to))
            if direction == "received":
                q = q.where(WorkAllocationHistory.employee_id == employee.id)
            elif direction == "away":
                q = q.where(WorkAllocationHistory.previous_employee_id == employee.id)
            if ticket_kind in ("task", "maintenance"):
                q = q.where(WorkAllocationHistory.ticket_kind == ticket_kind)
            ordering = (WorkAllocationHistory.created_at.desc(), WorkAllocationHistory.id)
        elif kind == "maintenance":
            alloc_ids = select(WorkAllocationHistory.ticket_id).where(
                WorkAllocationHistory.ticket_kind == "maintenance",
                WorkAllocationHistory.employee_id == employee.id).subquery()
            q = select(
                cast(MaintenanceTicket.id, String).label("record_uid"), MaintenanceTicket.ticket_number,
                MaintenanceTicket.issue, MaintenanceTicket.maintenance_type, MaintenanceTicket.priority,
                MaintenanceTicket.status, MaintenanceTicket.assigned_to_name,
                MaintenanceTicket.resolved_at, MaintenanceTicket.closed_at, MaintenanceTicket.created_at,
                Property.name.label("property_name"),
            ).join(Property, MaintenanceTicket.property_id == Property.id).where(
                MaintenanceTicket.id.in_(select(alloc_ids)),
                MaintenanceTicket.property_id.in_(properties),
                *self.in_range(MaintenanceTicket.created_at, date_from, date_to)).distinct()
            ordering = (MaintenanceTicket.created_at.desc(), MaintenanceTicket.id)
        else:
            q = select(
                cast(TaskCompletionSubmission.id, String).label("record_uid"), Task.title, Task.ticket_number,
                TaskCompletionSubmission.attempt_number, TaskCompletionSubmission.status,
                TaskCompletionSubmission.submitted_at, TaskCompletionSubmission.reviewed_at,
                TaskCompletionSubmission.reviewed_by_name, TaskCompletionSubmission.review_comment,
                Property.name.label("property_name"),
                select(func.count(TaskCompletionImage.id)).where(
                    TaskCompletionImage.submission_id == TaskCompletionSubmission.id
                ).correlate(TaskCompletionSubmission).scalar_subquery().label("evidence_count"),
            ).join(Task, TaskCompletionSubmission.task_id == Task.id).join(
                Property, Task.property_id == Property.id).where(
                TaskCompletionSubmission.employee_id == employee.id, Task.property_id.in_(properties),
                *self.in_range(TaskCompletionSubmission.submitted_at, date_from, date_to))
            ordering = (TaskCompletionSubmission.submitted_at.desc(), TaskCompletionSubmission.id)
        result = await self.page(q, page=page, limit=limit, ordering=ordering)
        if kind == "allocations":
            await self._enrich_allocation_lifecycle(result["items"])
        return result

    async def _enrich_allocation_lifecycle(self, items: list[dict]) -> None:
        """Attach a compact lifecycle summary to each allocation-ledger row so
        the timeline can show how the work item progressed (submitted → decided
        → completed/abandoned) and by whom. Two batched lookups, no N+1."""
        task_ids = [uuid.UUID(i["work_uid"]) for i in items
                    if i.get("ticket_kind") == "task" and i.get("work_uid")]
        maint_ids = [uuid.UUID(i["work_uid"]) for i in items
                     if i.get("ticket_kind") == "maintenance" and i.get("work_uid")]
        lifecycle: dict[str, dict] = {}
        if task_ids:
            tmap = {t.id: t for t in (await self.session.execute(
                select(Task.id, Task.status, Task.abandoned_at, Task.completed_at)
                .where(Task.id.in_(task_ids)))).all()}
            smap: dict = {}
            for s in (await self.session.execute(
                select(TaskCompletionSubmission.task_id, TaskCompletionSubmission.status,
                       TaskCompletionSubmission.submitted_at, TaskCompletionSubmission.reviewed_at,
                       TaskCompletionSubmission.reviewed_by_name,
                       TaskCompletionSubmission.employee_name,
                       TaskCompletionSubmission.attempt_number)
                .where(TaskCompletionSubmission.task_id.in_(task_ids))
                .order_by(TaskCompletionSubmission.submitted_at.desc(),
                          TaskCompletionSubmission.attempt_number.desc()))).all():
                smap.setdefault(s.task_id, s)
            # Staff-side closes bypass the submit→review path; surface them so
            # the timeline doesn't imply an approval that never happened.
            hmap: dict = {}
            for h in (await self.session.execute(
                select(TaskHistoryEvent.task_id, TaskHistoryEvent.actor_name,
                       TaskHistoryEvent.at)
                .where(TaskHistoryEvent.task_id.in_(task_ids),
                       TaskHistoryEvent.type == "admin_closed")
                .order_by(TaskHistoryEvent.at.desc()))).all():
                hmap.setdefault(h.task_id, h)
            for tid, t in tmap.items():
                s = smap.get(tid)
                h = hmap.get(tid)
                lifecycle[str(tid)] = {
                    "kind": "task", "current_status": t.status,
                    "submitted_at": s.submitted_at if s else None,
                    "submitted_by": (s.employee_name if s else None),
                    "submission_status": (s.status if s else None),
                    "reviewed_at": (s.reviewed_at if s else None),
                    "reviewed_by": (s.reviewed_by_name if s else None),
                    "completed_at": t.completed_at, "abandoned_at": t.abandoned_at,
                    "admin_closed_by": (h.actor_name if h else None),
                    "admin_closed_at": (h.at if h else None)}
        if maint_ids:
            for m in (await self.session.execute(
                select(MaintenanceTicket.id, MaintenanceTicket.status,
                       MaintenanceTicket.assigned_to_name, MaintenanceTicket.resolved_at,
                       MaintenanceTicket.closed_at)
                .where(MaintenanceTicket.id.in_(maint_ids)))).all():
                lifecycle[str(m.id)] = {
                    "kind": "maintenance", "current_status": m.status,
                    "assigned_to": m.assigned_to_name,
                    "resolved_at": m.resolved_at, "closed_at": m.closed_at}
        for i in items:
            i["lifecycle"] = lifecycle.get(i.get("work_uid") or "") or None

    # ------------------------------------------------------------------
    # Team-level analytics — one row per employee, same metric definitions
    # as the per-employee analytics (distinct tasks, employee-ID attribution,
    # submission attempts kept separate from unique tasks).
    # ------------------------------------------------------------------
    async def team_analytics(self, user: User, *, property_id: uuid.UUID | None = None,
                             date_from: datetime | None = None,
                             date_to: datetime | None = None) -> dict:
        properties = self.properties(user)
        if property_id is not None:
            ok = (await self.session.execute(
                select(Property.id).where(Property.id == property_id,
                                          Property.id.in_(properties)))).scalar_one_or_none()
            if ok is None:
                raise NotFoundErr("Property not found.")
            properties = select(Property.id).where(Property.id == property_id)
        rng = (date_from, date_to)

        employees = (await self.session.execute(
            select(Employee.id, Employee.name, Employee.job_title, Employee.status,
                   Employee.zone_id, Employee.area_id)
            .where(Employee.property_id.in_(properties))
            .order_by(Employee.name))).all()
        emp_ids = [e.id for e in employees]
        if not emp_ids:
            return {"employees": [], "total": 0,
                    "team": {"allocated": 0, "completed": 0, "abandoned": 0, "open": 0}}

        zone_names = {z.id: z.name for z in (await self.session.execute(
            select(Zone.id, Zone.name).where(Zone.property_id.in_(properties)))).all()}
        area_names = {a.id: a.name for a in (await self.session.execute(
            select(Area.id, Area.name).where(Area.property_id.in_(properties)))).all()}

        allocs = (await self.session.execute(
            select(WorkAllocationHistory.employee_id, WorkAllocationHistory.ticket_id,
                   WorkAllocationHistory.created_at)
            .where(WorkAllocationHistory.property_id.in_(properties),
                   WorkAllocationHistory.ticket_kind == "task",
                   *self.in_range(WorkAllocationHistory.created_at, *rng)))).all()

        tasks = (await self.session.execute(
            select(Task.id, Task.employee_id, Task.status, Task.abandoned_at, Task.created_at)
            .where(Task.property_id.in_(properties)))).all()
        task_by_id = {t.id: t for t in tasks}
        task_ids = set(task_by_id)

        subs = (await self.session.execute(
            select(TaskCompletionSubmission.task_id, TaskCompletionSubmission.employee_id,
                   TaskCompletionSubmission.status, TaskCompletionSubmission.submitted_at)
            .where(TaskCompletionSubmission.task_id.in_(task_ids) if task_ids
                   else TaskCompletionSubmission.id.is_(None)))).all()

        in_rng = lambda d, t: (not d or t >= d) and (not rng[1] or t < rng[1])

        allocated: dict[uuid.UUID, set] = {}
        ledger_all: list = []  # (emp, ticket, at) across ALL history for abandon attribution
        for a in allocs:
            ledger_all.append(a)
            if a.employee_id and a.ticket_id in task_ids and in_rng(rng[0], a.created_at):
                allocated.setdefault(a.employee_id, set()).add(a.ticket_id)
        for t in tasks:
            if t.employee_id and in_rng(rng[0], t.created_at):
                allocated.setdefault(t.employee_id, set()).add(t.id)

        # Abandonment: attribute to the ledger's most recent assignee BEFORE the
        # abandon timestamp, falling back to the task's recorded employee_id.
        sorted_ledger = sorted(ledger_all, key=lambda a: a.created_at)
        abandoned: dict[uuid.UUID, set] = {}
        for t in tasks:
            if not t.abandoned_at or not in_rng(rng[0], t.abandoned_at):
                continue
            holder = next((a.employee_id for a in reversed(
                [x for x in sorted_ledger if x.ticket_id == t.id and x.created_at <= t.abandoned_at])
                if a.employee_id), None) or t.employee_id
            if holder:
                abandoned.setdefault(holder, set()).add(t.id)

        completed: dict[uuid.UUID, set] = {}
        for s in subs:
            if s.employee_id and s.status == "approved" and in_rng(rng[0], s.submitted_at):
                completed.setdefault(s.employee_id, set()).add(s.task_id)

        open_statuses = {"pending", "assigned", "in_progress", "reopened", "submitted", "overdue"}
        open_now: dict[uuid.UUID, int] = {}
        for t in tasks:
            if t.employee_id and t.status in open_statuses:
                open_now[t.employee_id] = open_now.get(t.employee_id, 0) + 1

        rows = []
        for e in employees:
            alloc = len(allocated.get(e.id, set()))
            done = len(completed.get(e.id, set()))
            aband = len(abandoned.get(e.id, set()))
            rows.append({
                "employee_uid": str(e.id), "name": e.name,
                "job_title": e.job_title, "status": e.status,
                "zone_name": zone_names.get(e.zone_id) or area_names.get(e.area_id),
                "allocated": alloc, "completed": done, "abandoned": aband,
                "open": open_now.get(e.id, 0),
                "completion_rate": round(done / alloc, 4) if alloc else None})
        rows.sort(key=lambda r: (-r["allocated"], r["name"]))
        return {"employees": rows, "total": len(rows),
                "team": {
                    "allocated": sum(r["allocated"] for r in rows),
                    "completed": sum(r["completed"] for r in rows),
                    "abandoned": sum(r["abandoned"] for r in rows),
                    "open": sum(r["open"] for r in rows)}}

    # ------------------------------------------------------------------
    # Workload by location — zone → area → unit hierarchy
    # ------------------------------------------------------------------

    async def locations(self, user: User, employee_id: uuid.UUID, *, property_id=None,
                        date_from: datetime | None = None, date_to: datetime | None = None):
        """Historical workload by where the WORK happened — task location
        columns, never the employee's current zone assignment."""
        employee, _ = await self.employee(user, employee_id, property_id)
        properties = self.properties(user)
        matches = self.task_matches(employee.id)
        date_columns = self.task_date_columns(employee.id)
        rng = (date_from, date_to)

        rows = (await self.session.execute(select(
            Task.id, Task.zone_id, Task.area_id, Task.room_id, Task.dorm_id,
            Task.washroom_id, Task.room_number, Task.dorm_name, Task.washroom_name,
            matches["completed"].label("completed"),
            matches["abandoned"].label("abandoned"),
            and_(Task.employee_id == employee.id,
                 Task.status.not_in(("completed", "cancelled", "abandoned"))).label("open"),
            Zone.name.label("zone_name"), Area.name.label("area_name"),
        ).outerjoin(Zone, Task.zone_id == Zone.id)
         .outerjoin(Area, Task.area_id == Area.id)
         .where(Task.property_id.in_(properties), matches["allocated"],
                *self.in_range(date_columns["allocated"], *rng)))).mappings().all()

        # Maintenance counts per zone — ledger attribution, kept separate.
        mrows = (await self.session.execute(
            select(MaintenanceTicket.zone_id, Zone.name,
                   func.count(MaintenanceTicket.id.distinct()),
                   func.count(MaintenanceTicket.id.distinct()).filter(
                       MaintenanceTicket.status.in_(("resolved", "closed"))))
            .join(Zone, MaintenanceTicket.zone_id == Zone.id)
            .where(MaintenanceTicket.id.in_(select(
                WorkAllocationHistory.ticket_id).where(
                    WorkAllocationHistory.ticket_kind == "maintenance",
                    WorkAllocationHistory.employee_id == employee.id)),
                MaintenanceTicket.property_id.in_(properties),
                *self.in_range(MaintenanceTicket.created_at, *rng))
            .group_by(MaintenanceTicket.zone_id, Zone.name))).all()
        maint_by_zone = {r[1] or "No zone": {"allocated": r[2], "resolved": r[3]} for r in mrows}

        zones: dict = {}

        def _bump(bucket, completed, abandoned, open_):
            bucket["allocated"] += 1
            if completed:
                bucket["completed"] += 1
            if abandoned:
                bucket["abandoned"] += 1
            if open_:
                bucket["open"] += 1

        for r in rows:
            zname = r["zone_name"] or "Unspecified location"
            z = zones.setdefault(zname, {
                "name": zname, "tasks": {"allocated": 0, "completed": 0, "abandoned": 0, "open": 0},
                "maintenance": maint_by_zone.get(zname, {"allocated": 0, "resolved": 0}),
                "areas": {}})
            _bump(z["tasks"], r["completed"], r["abandoned"], r["open"])
            aname = r["area_name"] or ("Zone-level" if r["zone_name"] else "Unspecified area")
            a = z["areas"].setdefault(aname, {
                "name": aname, "tasks": {"allocated": 0, "completed": 0, "abandoned": 0, "open": 0},
                "units": {}})
            _bump(a["tasks"], r["completed"], r["abandoned"], r["open"])
            unit_key, unit_label, unit_kind = None, None, None
            if r["room_id"]:
                unit_key, unit_label, unit_kind = f"room:{r['room_id']}", r["room_number"] or "Room", "room"
            elif r["dorm_id"]:
                unit_key, unit_label, unit_kind = f"dorm:{r['dorm_id']}", r["dorm_name"] or "Dorm", "dorm"
            elif r["washroom_id"]:
                unit_key, unit_label, unit_kind = f"washroom:{r['washroom_id']}", r["washroom_name"] or "Washroom", "washroom"
            if unit_key:
                u = a["units"].setdefault(unit_key, {
                    "label": unit_label, "kind": unit_kind,
                    "tasks": {"allocated": 0, "completed": 0, "abandoned": 0, "open": 0}})
                _bump(u["tasks"], r["completed"], r["abandoned"], r["open"])

        def _finish(t):
            t["completion_rate"] = (round(t["completed"] / t["allocated"], 4)
                                    if t["allocated"] else None)
            return t

        zone_list = []
        for z in zones.values():
            area_list = []
            for a in z["areas"].values():
                a["units"] = sorted(
                    ({"label": u["label"], "kind": u["kind"], "tasks": _finish(u["tasks"])}
                     for u in a["units"].values()),
                    key=lambda u: -u["tasks"]["allocated"])
                area_list.append({"name": a["name"], "tasks": _finish(a["tasks"]),
                                  "units": a["units"]})
            area_list.sort(key=lambda a: -a["tasks"]["allocated"])
            zone_list.append({"name": z["name"], "tasks": _finish(z["tasks"]),
                              "maintenance": z["maintenance"], "areas": area_list})
        zone_list.sort(key=lambda z: -z["tasks"]["allocated"])
        # Zones with maintenance but no tasks still surface.
        for name, m in maint_by_zone.items():
            if name not in zones and m["allocated"]:
                zone_list.append({"name": name,
                                  "tasks": {"allocated": 0, "completed": 0, "abandoned": 0,
                                            "open": 0, "completion_rate": None},
                                  "maintenance": m, "areas": []})
        return {"zones": zone_list}

    # ------------------------------------------------------------------
    # Attendance — monthly calendar + per-day drill-down
    # ------------------------------------------------------------------

    async def attendance_calendar(self, user: User, employee_id: uuid.UUID, *,
                                  property_id=None, month: str):
        employee, _ = await self.employee(user, employee_id, property_id)
        properties = self.properties(user)
        rows = (await self.session.execute(select(
            AttendanceDay.attendance_date, AttendanceDay.status, AttendanceDay.started_at,
            AttendanceDay.ended_at, AttendanceDay.work_seconds, AttendanceDay.break_seconds).where(
            AttendanceDay.employee_id == employee.id,
            AttendanceDay.property_id.in_(properties),
            AttendanceDay.attendance_date.like(f"{month}-%")))).all()
        days: dict = {}
        summary = {"present": 0, "absent": 0, "leave": 0, "week_off": 0,
                   "incomplete": 0, "recorded": 0, "total_work_seconds": 0,
                   "total_break_seconds": 0}
        for r in rows:
            status = r.status
            incomplete = bool(status == "present" and r.started_at and not r.ended_at)
            days[str(r.attendance_date)] = {
                "status": status, "started_at": r.started_at.isoformat() if r.started_at else None,
                "ended_at": r.ended_at.isoformat() if r.ended_at else None,
                "work_seconds": r.work_seconds, "break_seconds": r.break_seconds,
                "incomplete": incomplete}
            summary["recorded"] += 1
            if incomplete:
                summary["incomplete"] += 1
            elif status in ("present", "absent", "leave", "week_off"):
                summary[status] += 1
            if r.work_seconds:
                summary["total_work_seconds"] += r.work_seconds
            if r.break_seconds:
                summary["total_break_seconds"] += r.break_seconds
        return {"month": month, "days": days, "summary": summary}

    async def attendance_day(self, user: User, employee_id: uuid.UUID, *,
                             property_id=None, day: str):
        employee, _ = await self.employee(user, employee_id, property_id)
        properties = self.properties(user)
        record = (await self.session.execute(select(AttendanceDay).where(
            AttendanceDay.employee_id == employee.id,
            AttendanceDay.property_id.in_(properties),
            AttendanceDay.attendance_date == day).limit(1))).scalar_one_or_none()
        breaks = []
        if record is not None:
            breaks = (await self.session.execute(select(
                AttendanceBreak.started_at, AttendanceBreak.ended_at,
                AttendanceBreak.duration_seconds).where(
                AttendanceBreak.attendance_day_id == record.id)
                .order_by(AttendanceBreak.started_at))).all()
        # Effective shift on that date (latest effective_from wins).
        assign = (await self.session.execute(
            select(EmployeeShiftAssignment, Shift)
            .join(Shift, EmployeeShiftAssignment.shift_id == Shift.id)
            .where(EmployeeShiftAssignment.employee_id == employee.id,
                   EmployeeShiftAssignment.effective_from <= day,
                   or_(EmployeeShiftAssignment.effective_until.is_(None),
                       EmployeeShiftAssignment.effective_until >= day))
            .order_by(EmployeeShiftAssignment.effective_from.desc(),
                      EmployeeShiftAssignment.created_at.desc()))).first()
        shift_out = None
        if assign is not None:
            _, shift = assign
            if shift_applies_on(shift, day):
                start_utc, end_utc = shift_window_utc(shift, day)
                shift_out = {"name": shift.name, "start": start_utc.isoformat(),
                             "end": end_utc.isoformat(),
                             "grace_minutes": shift.grace_minutes,
                             "early_exit_minutes": shift.early_exit_minutes}
            else:
                shift_out = {"name": shift.name, "start": None, "end": None,
                             "not_scheduled": True}
        leave = (await self.session.execute(select(AttendanceRequest).where(
            AttendanceRequest.employee_id == employee.id,
            AttendanceRequest.property_id.in_(properties),
            AttendanceRequest.from_date <= day, AttendanceRequest.to_date >= day,
            AttendanceRequest.status == "approved"))).scalars().first()
        return {
            "date": day,
            "record": (None if record is None else {
                "status": record.status,
                "started_at": record.started_at.isoformat() if record.started_at else None,
                "ended_at": record.ended_at.isoformat() if record.ended_at else None,
                "work_seconds": record.work_seconds,
                "break_seconds": record.break_seconds,
                "incomplete": bool(record.status == "present" and record.started_at
                                   and not record.ended_at)}),
            "breaks": [{"started_at": b.started_at.isoformat() if b.started_at else None,
                        "ended_at": b.ended_at.isoformat() if b.ended_at else None,
                        "duration_seconds": b.duration_seconds} for b in breaks],
            "shift": shift_out,
            "leave": (None if leave is None else {
                "request_type": leave.request_type, "leave_type": leave.leave_type,
                "status": leave.status, "reason": leave.reason}),
        }

    # ------------------------------------------------------------------
    # App & device diagnostics — read-only over EB-owned shared tables.
    # Never returns push tokens, credentials, or precise coordinates.
    # ------------------------------------------------------------------

    async def devices(self, user: User, employee_id: uuid.UUID, *, property_id=None):
        employee, _ = await self.employee(user, employee_id, property_id)
        properties = self.properties(user)
        result: dict = {
            "devices": [], "latest_release": None,
            "tracking": {"sessions": 0, "active_session": False,
                         "last_session_started": None, "last_session_ended": None,
                         "last_event_at": None, "last_event_source": None},
        }
        try:
            rows = (await self.session.execute(
                select(_device_registrations.c.device_id,
                       _device_registrations.c.platform,
                       _device_registrations.c.app_version,
                       _device_registrations.c.is_active,
                       _device_registrations.c.last_seen_at,
                       _device_registrations.c.created_at)
                .where(_device_registrations.c.employee_id == employee.id)
                .order_by(_device_registrations.c.last_seen_at.desc()))).all()
            result["devices"] = [{
                "device_id": str(r.device_id), "platform": r.platform,
                "app_version": r.app_version, "is_active": bool(r.is_active),
                "registered_at": r.created_at.isoformat() if r.created_at else None,
                "last_seen_at": r.last_seen_at.isoformat() if r.last_seen_at else None,
            } for r in rows]
            platforms = [r.platform for r in rows if r.platform]
            if platforms:
                rel = (await self.session.execute(
                    select(_mobile_releases.c.platform, _mobile_releases.c.version,
                           _mobile_releases.c.force_update)
                    .where(_mobile_releases.c.platform.in_(platforms),
                           _mobile_releases.c.is_active == True)  # noqa: E712
                    .order_by(_mobile_releases.c.version_code.desc()).limit(1))).first()
                if rel:
                    result["latest_release"] = {
                        "platform": rel.platform, "version": rel.version,
                        "force_update": bool(rel.force_update)}
            last_event = (await self.session.execute(
                select(_location_events.c.recorded_at, _location_events.c.source)
                .where(_location_events.c.employee_id == employee.id,
                       _location_events.c.property_id.in_(properties))
                .order_by(_location_events.c.recorded_at.desc()).limit(1))).first()
            if last_event:
                result["tracking"]["last_event_at"] = (
                    last_event.recorded_at.isoformat() if last_event.recorded_at else None)
                result["tracking"]["last_event_source"] = last_event.source
            sessions = (await self.session.execute(
                select(func.count(),
                       func.count().filter(
                           _location_tracking_sessions.c.ended_at.is_(None)),
                       func.max(_location_tracking_sessions.c.started_at),
                       func.max(_location_tracking_sessions.c.ended_at))
                .select_from(_location_tracking_sessions)
                .where(_location_tracking_sessions.c.employee_id == employee.id))).one()
            result["tracking"]["sessions"] = sessions[0] or 0
            result["tracking"]["active_session"] = bool(sessions[1])
            result["tracking"]["last_session_started"] = (
                sessions[2].isoformat() if sessions[2] else None)
            result["tracking"]["last_session_ended"] = (
                sessions[3].isoformat() if sessions[3] else None)
            result["available"] = True
        except Exception:
            # Shared-EB tables may not exist (fresh dev DB, migrations pending)
            # — report unavailability, never fabricate device state.
            try:
                await self.session.rollback()
            except Exception:
                pass
            result["available"] = False
        return result

