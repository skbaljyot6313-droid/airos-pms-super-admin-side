"""Department work management — roster, allocation, lists, performance,
and the shared calendar query.

Everything is department-scoped through ``dept_scope``; every work item
is a real ``tasks`` row so it appears identically in the employee task
list, the employee calendar, the department views and the property
calendar.
"""
import uuid
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import Forbidden
from app.models.attendance import AttendanceDay
from app.models.department import Department
from app.models.employee import Employee
from app.models.task import Task, TaskHistoryEvent
from app.models.user import User, UserRole
from app.schemas.structure import TaskCreateRequest
from app.services.dept_scope import department_for_user, employee_in_department
from app.services.structure import ValidationErr

IST = ZoneInfo("Asia/Kolkata")
OPEN_STATUSES = ("pending", "assigned", "in_progress", "reopened", "scheduled")
FINAL_STATUSES = ("completed", "cancelled", "abandoned")


def _today() -> str:
    return datetime.now(IST).date().isoformat()


def _norm_date(value: str | None, field: str) -> str | None:
    if value is None:
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise ValidationErr("Expected YYYY-MM-DD.", field=field)


def _date_overlap(from_d: str, to_d: str):
    """Task touches [from_d, to_d] on any of its scheduling fields —
    scheduled_for (IST), due_date (date prefix) or operational_date."""
    sched_ist = func.timezone("Asia/Kolkata", Task.scheduled_for)
    return or_(
        func.date(sched_ist).between(from_d, to_d),
        func.substr(Task.due_date, 1, 10).between(from_d, to_d),
        Task.operational_date.between(from_d, to_d),
    )


class DeptWorkService:
    def __init__(self, session: AsyncSession):
        self.session = session

    # ------------------------------------------------------------------
    # Roster — dept employees + today's shift + open workload
    # ------------------------------------------------------------------
    async def roster(self, user: User, department_id: uuid.UUID) -> dict:
        dept = await department_for_user(self.session, user, department_id)
        employees = (await self.session.execute(
            select(Employee).where(
                Employee.department_id == dept.id,
                Employee.property_id == dept.property_id,
                func.lower(Employee.status) != "deactivated",
            ).order_by(Employee.name)
        )).scalars().all()
        emp_ids = [e.id for e in employees]
        today = _today()

        from app.services.shifts import effective_assignments, shift_applies_on

        shifts = await effective_assignments(self.session, emp_ids, today)
        attendance = {d.employee_id: d for d in (await self.session.execute(
            select(AttendanceDay).where(
                AttendanceDay.employee_id.in_(emp_ids),
                AttendanceDay.attendance_date == today,
            ))).scalars().all()} if emp_ids else {}
        open_counts = dict(
            (await self.session.execute(
                select(Task.employee_id, func.count()).where(
                    Task.employee_id.in_(emp_ids),
                    Task.status.in_(OPEN_STATUSES),
                ).group_by(Task.employee_id)
            )).all()
        ) if emp_ids else {}

        items = []
        for e in employees:
            pair = shifts.get(e.id)
            shift = pair[1] if pair else None
            att = attendance.get(e.id)
            items.append({
                "employee_uid": str(e.id),
                "name": e.name,
                "role": e.role,
                "is_head": dept.head_employee_id == e.id,
                "shift": (
                    {"name": shift.name,
                     "start_time": shift.start_time.strftime("%H:%M"),
                     "end_time": shift.end_time.strftime("%H:%M"),
                     "scheduled": shift_applies_on(shift, today)}
                    if shift else None
                ),
                "attendance_status": att.status if att else None,
                "on_duty": bool(att and att.started_at and not att.ended_at),
                "open_tasks": int(open_counts.get(e.id, 0)),
            })
        return {
            "department_uid": str(dept.id),
            "name": dept.name,
            "code": dept.code,
            "head_employee_uid": (
                str(dept.head_employee_id) if dept.head_employee_id else None),
            "items": items,
        }

    # ------------------------------------------------------------------
    # Work list — every task belonging to the department
    # ------------------------------------------------------------------
    def _dept_task_pred(self, dept: Department):
        return or_(
            Task.department_id == dept.id,
            Task.employee_id.in_(
                select(Employee.id).where(Employee.department_id == dept.id)),
        )

    async def list_work(self, user: User, department_id: uuid.UUID, *,
                        status: str | None = None,
                        priority: str | None = None,
                        employee_id: uuid.UUID | None = None,
                        from_date: str | None = None,
                        to_date: str | None = None,
                        search: str | None = None,
                        page: int = 1, limit: int = 50) -> dict:
        dept = await department_for_user(self.session, user, department_id)
        q = select(Task).where(
            Task.property_id == dept.property_id, self._dept_task_pred(dept))
        if status:
            q = q.where(Task.status == status)
        if priority:
            q = q.where(Task.priority == priority)
        if employee_id:
            q = q.where(Task.employee_id == employee_id)
        from_d, to_d = _norm_date(from_date, "from"), _norm_date(to_date, "to")
        if from_d and to_d:
            q = q.where(_date_overlap(from_d, to_d))
        elif from_d:
            q = q.where(_date_overlap(from_d, "9999-12-31"))
        elif to_d:
            q = q.where(_date_overlap("0001-01-01", to_d))
        if search:
            q = q.where(Task.title.ilike(f"%{search.strip()}%"))
        total = await self.session.scalar(
            select(func.count()).select_from(q.subquery()))
        rows = (await self.session.execute(
            q.order_by(Task.created_at.desc())
            .offset((page - 1) * limit).limit(limit)
        )).scalars().all()
        return {"items": rows, "total": total or 0, "page": page, "limit": limit}

    # ------------------------------------------------------------------
    # Allocate — one task per assignee sharing one batch id
    # ------------------------------------------------------------------
    async def allocate_work(self, user: User, department_id: uuid.UUID,
                            payload: TaskCreateRequest) -> list[Task]:
        from app.services.task import TaskService

        dept = await department_for_user(self.session, user, department_id)
        if user.role == UserRole.DEPARTMENT_MANAGER:
            # Department managers allocate only inside their department.
            payload = payload.model_copy(update={"department_uid": dept.id})
        assignees = list(dict.fromkeys(payload.employee_uids or []))
        if not assignees and payload.employee_uid:
            assignees = [payload.employee_uid]
        if not assignees:
            raise ValidationErr(
                "Assign the work to at least one employee.", field="employee_uids")
        if len(assignees) > 25:
            raise ValidationErr(
                "Assign to at most 25 employees at once.", field="employee_uids")
        for uid in assignees:
            await employee_in_department(self.session, dept, uid)

        svc = TaskService(self.session)
        payload = payload.model_copy(update={
            "department_uid": dept.id,
            "employee_uids": None,
        })
        batch_id = uuid.uuid4() if len(assignees) > 1 else None
        tasks = []
        for uid in assignees:
            tasks.append(await svc.create_task(
                user, payload, batch_id=batch_id, employee_override=uid))
        return tasks

    # ------------------------------------------------------------------
    # Performance — aggregated over the department's task set
    # ------------------------------------------------------------------
    async def performance(self, user: User, department_id: uuid.UUID, *,
                          from_date: str | None = None,
                          to_date: str | None = None) -> dict:
        dept = await department_for_user(self.session, user, department_id)
        to_d = _norm_date(to_date, "to") or _today()
        from_d = _norm_date(from_date, "from") or (
            date.fromisoformat(to_d) - timedelta(days=27)).isoformat()

        base = select(Task).where(
            Task.property_id == dept.property_id,
            self._dept_task_pred(dept),
            _date_overlap(from_d, to_d),
        )
        tasks = (await self.session.execute(base)).scalars().all()
        today = _today()

        totals: dict[str, int] = defaultdict(int)
        per_emp: dict[uuid.UUID | None, dict] = {}
        weekly: dict[str, dict] = defaultdict(lambda: {"created": 0, "completed": 0})
        durations = []
        for t in tasks:
            totals[t.status] += 1
            overdue = (
                t.status in OPEN_STATUSES and t.due_date
                and t.due_date[:10] < today
            )
            if overdue:
                totals["overdue"] += 1
            slot = per_emp.setdefault(t.employee_id, {
                "employee_uid": str(t.employee_id) if t.employee_id else None,
                "name": t.assigned_to_name or "Unassigned",
                "open": 0, "submitted": 0, "completed": 0, "overdue": 0,
            })
            if t.status == "completed":
                slot["completed"] += 1
            elif t.status == "submitted":
                slot["submitted"] += 1
            elif t.status in OPEN_STATUSES:
                slot["open"] += 1
            if overdue:
                slot["overdue"] += 1
            if t.created_at:
                wk = (t.created_at.astimezone(IST).date()
                      - timedelta(days=t.created_at.astimezone(IST).weekday()))
                weekly[wk.isoformat()]["created"] += 1
            if t.completed_at:
                wk = (t.completed_at.astimezone(IST).date()
                      - timedelta(days=t.completed_at.astimezone(IST).weekday()))
                weekly[wk.isoformat()]["completed"] += 1

        # Average start→submit duration from history events.
        task_ids = [t.id for t in tasks if t.submitted_at]
        if task_ids:
            starts = dict((await self.session.execute(
                select(TaskHistoryEvent.task_id,
                       func.min(TaskHistoryEvent.at)).where(
                    TaskHistoryEvent.task_id.in_(task_ids),
                    TaskHistoryEvent.action == "in_progress",
                ).group_by(TaskHistoryEvent.task_id)
            )).all())
            for t in tasks:
                st = starts.get(t.id)
                if st and t.submitted_at:
                    durations.append(
                        (t.submitted_at - st).total_seconds() / 60)
        avg_minutes = round(sum(durations) / len(durations), 1) if durations else None

        return {
            "from": from_d, "to": to_d,
            "totals": dict(totals),
            "per_employee": sorted(
                per_emp.values(), key=lambda r: r["open"] + r["overdue"],
                reverse=True),
            "avg_start_to_submit_minutes": avg_minutes,
            "weekly": [{"week": k, **weekly[k]} for k in sorted(weekly)],
        }

    # ------------------------------------------------------------------
    # Calendar — shared date-scoped work query
    # ------------------------------------------------------------------
    async def calendar(self, user: User, *, property_id: uuid.UUID,
                       from_date: str, to_date: str,
                       department_id: uuid.UUID | None = None,
                       employee_id: uuid.UUID | None = None,
                       zone_id: uuid.UUID | None = None,
                       status: str | None = None,
                       priority: str | None = None,
                       work_type: str | None = None) -> list[Task]:
        from_d = _norm_date(from_date, "from")
        to_d = _norm_date(to_date, "to")
        if not from_d or not to_d:
            raise ValidationErr("from and to are required.", field="from")
        if (date.fromisoformat(to_d) - date.fromisoformat(from_d)).days > 93:
            raise ValidationErr(
                "Calendar range is capped at 93 days.", field="to")

        dept = None
        if user.role == UserRole.DEPARTMENT_MANAGER:
            # Department managers see only their departments' work — a
            # department filter outside their scope returns nothing.
            from app.services.dept_scope import managed_department_ids
            ids = await managed_department_ids(self.session, user) or set()
            if not ids:
                return []
            if department_id:
                dept = await department_for_user(self.session, user, department_id)
            scoped = select(Task.id).where(self._dept_scope_pred(ids))
            q = select(Task).where(
                Task.property_id == property_id, Task.id.in_(scoped))
        else:
            q = select(Task).where(Task.property_id == property_id)
            if department_id:
                dept = await department_for_user(self.session, user, department_id)
        if dept:
            q = q.where(self._dept_task_pred(dept))

        q = q.where(_date_overlap(from_d, to_d))
        if employee_id:
            q = q.where(Task.employee_id == employee_id)
        if zone_id:
            q = q.where(Task.zone_id == zone_id)
        if status:
            q = q.where(Task.status == status)
        if priority:
            q = q.where(Task.priority == priority)
        if work_type:
            q = q.where(Task.work_type == work_type)
        rows = (await self.session.execute(
            q.order_by(Task.scheduled_for.asc().nulls_last(),
                       Task.due_date.asc().nulls_last())
            .limit(2000)
        )).scalars().all()
        return rows

    def _dept_scope_pred(self, dept_ids: set[uuid.UUID]):
        return or_(
            Task.department_id.in_(dept_ids),
            Task.employee_id.in_(
                select(Employee.id).where(Employee.department_id.in_(dept_ids))),
        )
