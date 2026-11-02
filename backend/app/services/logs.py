import uuid
from datetime import datetime

from sqlalchemy import String, case, cast, func, literal, or_, select, union_all
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import Forbidden
from app.core.exceptions import AppError
from app.core.storage import storage_key_from_url
from app.models.structure import Zone
from app.models.allocation import AllocationEvent
from app.models.attendance import AttendanceBreak, AttendanceDay, AttendanceRequest
from app.models.audit import AuditEvent
from app.models.maintenance import MaintenanceTicket, MaintenanceTicketAttachment, MaintenanceTicketEvent
from app.models.property import Property
from app.models.resource_state_event import ResourceStateEvent
from app.models.task import Task, TaskCompletionImage, TaskCompletionSubmission, TaskHistoryEvent
from app.models.user import User, UserRole
from app.models.work_allocation import WorkAllocationHistory


CATEGORIES = ("audit", "session", "task", "photo", "maintenance", "allocation", "resource", "attendance")


def _text(value):
    return cast(literal(value) if value is None or isinstance(value, str) else value, String)


def _detail(**fields):
    args = []
    for key, value in fields.items():
        args.extend((literal(key), value))
    return func.jsonb_build_object(*args)


def activity_query():
    queries = []

    def entry(source, model, at, category, action, actor, entity_type, entity_id,
              entity_name, detail, property_id, *, parent=None, join_on=None, condition=None):
        q = select(
            _text(source).label("source"), _text(model.id).label("event_uid"),
            at.label("occurred_at"), _text(category).label("category"),
            _text(action).label("action"), _text(actor).label("actor_name"),
            _text(entity_type).label("entity_type"), _text(entity_id).label("entity_uid"),
            _text(entity_name).label("entity_name"),
            _text(Property.id).label("property_uid"), Property.name.label("property_name"),
            _text(Property.company_id).label("company_uid"), cast(detail, JSONB).label("detail"),
        ).select_from(model)
        if parent is not None:
            q = q.join(parent, join_on)
        q = q.join(Property, property_id == Property.id)
        if condition is not None:
            q = q.where(condition)
        queries.append(q)

    audit_property = func.coalesce(_text(AuditEvent.property_id), AuditEvent.detail["property_uid"].as_string())
    queries.append(select(
        _text("audit").label("source"), _text(AuditEvent.id).label("event_uid"),
        AuditEvent.created_at.label("occurred_at"),
        func.coalesce(AuditEvent.detail["category"].as_string(), literal("audit")).label("category"),
        AuditEvent.action.label("action"), AuditEvent.actor_name.label("actor_name"),
        AuditEvent.entity_type.label("entity_type"), _text(AuditEvent.entity_id).label("entity_uid"),
        AuditEvent.entity_name.label("entity_name"), audit_property.label("property_uid"),
        func.coalesce(Property.name, AuditEvent.detail["property_name"].as_string()).label("property_name"),
        func.coalesce(_text(Property.company_id), AuditEvent.detail["company_uid"].as_string(),
                      _text(User.company_id)).label("company_uid"),
        cast(AuditEvent.detail, JSONB).label("detail"),
    ).select_from(AuditEvent).outerjoin(Property, _text(Property.id) == audit_property)
      .outerjoin(User, User.id == AuditEvent.actor_user_id))

    entry("task_history", TaskHistoryEvent, TaskHistoryEvent.at, "task", TaskHistoryEvent.type,
          TaskHistoryEvent.actor_name, "task", Task.id, Task.title,
          _detail(ticket_number=Task.ticket_number, note=TaskHistoryEvent.note, photos=TaskHistoryEvent.photos),
          Task.property_id, parent=Task, join_on=TaskHistoryEvent.task_id == Task.id)
    entry("task_submission", TaskCompletionSubmission, TaskCompletionSubmission.submitted_at,
          "task", "evidence_submitted", TaskCompletionSubmission.employee_name, "task", Task.id, Task.title,
          _detail(ticket_number=Task.ticket_number, attempt=TaskCompletionSubmission.attempt_number,
                  employee_uid=_text(TaskCompletionSubmission.employee_id),
                  submission_uid=_text(TaskCompletionSubmission.id),
                  review_status_current=TaskCompletionSubmission.status),
          Task.property_id, parent=Task, join_on=TaskCompletionSubmission.task_id == Task.id)
    entry("task_review", TaskCompletionSubmission, TaskCompletionSubmission.reviewed_at,
          "task", case((TaskCompletionSubmission.status == "approved", "evidence_approved"),
                       else_="evidence_disapproved"), TaskCompletionSubmission.reviewed_by_name,
          "task", Task.id, Task.title,
          _detail(ticket_number=Task.ticket_number, attempt=TaskCompletionSubmission.attempt_number,
                  submission_uid=_text(TaskCompletionSubmission.id), note=TaskCompletionSubmission.review_comment),
          Task.property_id, parent=Task, join_on=TaskCompletionSubmission.task_id == Task.id,
          condition=TaskCompletionSubmission.reviewed_at.is_not(None) &
                    TaskCompletionSubmission.status.in_(("approved", "disapproved")))
    entry("task_photo", TaskCompletionImage, TaskCompletionImage.created_at, "photo", "task_photo_attached",
          TaskCompletionImage.created_by_name, "task", Task.id, Task.title,
          _detail(ticket_number=Task.ticket_number, url=TaskCompletionImage.url,
                  file_name=TaskCompletionImage.file_name, submission_uid=_text(TaskCompletionImage.submission_id)),
          Task.property_id, parent=Task, join_on=TaskCompletionImage.task_id == Task.id)
    entry("maintenance_history", MaintenanceTicketEvent, MaintenanceTicketEvent.created_at,
          "maintenance", MaintenanceTicketEvent.action, MaintenanceTicketEvent.actor_name,
          "maintenance", MaintenanceTicket.id, MaintenanceTicket.issue,
          _detail(ticket_number=MaintenanceTicket.ticket_number, note=MaintenanceTicketEvent.comment),
          MaintenanceTicket.property_id, parent=MaintenanceTicket,
          join_on=MaintenanceTicketEvent.ticket_id == MaintenanceTicket.id)
    entry("maintenance_photo", MaintenanceTicketAttachment, MaintenanceTicketAttachment.created_at,
          "photo", "maintenance_photo_attached", MaintenanceTicketAttachment.uploaded_by_name,
          "maintenance", MaintenanceTicket.id, MaintenanceTicket.issue,
          _detail(ticket_number=MaintenanceTicket.ticket_number, url=MaintenanceTicketAttachment.url,
                  file_name=MaintenanceTicketAttachment.file_name, kind=MaintenanceTicketAttachment.kind,
                  attempt=MaintenanceTicketAttachment.attempt),
          MaintenanceTicket.property_id, parent=MaintenanceTicket,
          join_on=MaintenanceTicketAttachment.ticket_id == MaintenanceTicket.id)
    entry("work_allocation", WorkAllocationHistory, WorkAllocationHistory.created_at, "allocation",
          WorkAllocationHistory.allocation_method, WorkAllocationHistory.actor_name,
          WorkAllocationHistory.ticket_kind, WorkAllocationHistory.ticket_id, WorkAllocationHistory.ticket_number,
          _detail(assigned_to=WorkAllocationHistory.employee_name,
                  previous_assignee=WorkAllocationHistory.previous_employee_name,
                  employee_uid=_text(WorkAllocationHistory.employee_id),
                  reason=WorkAllocationHistory.reason, batch_number=WorkAllocationHistory.batch_number,
                  zone_uid=_text(WorkAllocationHistory.zone_id)), WorkAllocationHistory.property_id)
    entry("allocation", AllocationEvent, AllocationEvent.created_at, "allocation", "location_changed",
          AllocationEvent.actor_name, AllocationEvent.entity_type, AllocationEvent.entity_id, None,
          _detail(from_zone_uid=_text(AllocationEvent.from_zone_id), to_zone_uid=_text(AllocationEvent.to_zone_id),
                  from_area_uid=_text(AllocationEvent.from_area_id), to_area_uid=_text(AllocationEvent.to_area_id)),
          AllocationEvent.property_id)
    entry("resource_state", ResourceStateEvent, ResourceStateEvent.created_at, "resource",
          ResourceStateEvent.source, ResourceStateEvent.actor_name, ResourceStateEvent.resource_type,
          ResourceStateEvent.resource_id, None,
          _detail(previous_state=ResourceStateEvent.previous_state, new_state=ResourceStateEvent.new_state,
                  reason=ResourceStateEvent.reason, task_uid=_text(ResourceStateEvent.task_id),
                  ticket_uid=_text(ResourceStateEvent.ticket_id), occupancy_uid=_text(ResourceStateEvent.occupancy_id)),
          ResourceStateEvent.property_id)
    for action, at in (("clocked_in", AttendanceDay.started_at), ("clocked_out", AttendanceDay.ended_at)):
        entry(f"attendance_{action}", AttendanceDay, at, "attendance", action, AttendanceDay.employee_name,
              "employee", AttendanceDay.employee_id, AttendanceDay.employee_name,
              _detail(attendance_date=AttendanceDay.attendance_date), AttendanceDay.property_id,
              condition=at.is_not(None))
    for action, at in (("break_started", AttendanceBreak.started_at), ("break_ended", AttendanceBreak.ended_at)):
        entry(f"attendance_{action}", AttendanceBreak, at, "attendance", action, AttendanceDay.employee_name,
              "employee", AttendanceDay.employee_id, AttendanceDay.employee_name,
              _detail(attendance_date=AttendanceDay.attendance_date, duration_seconds=AttendanceBreak.duration_seconds),
              AttendanceDay.property_id, parent=AttendanceDay,
              join_on=AttendanceBreak.attendance_day_id == AttendanceDay.id, condition=at.is_not(None))
    entry("attendance_request", AttendanceRequest, AttendanceRequest.created_at, "attendance", "time_off_requested",
          AttendanceRequest.employee_name, "attendance_request", AttendanceRequest.id, AttendanceRequest.employee_name,
          _detail(request_type=AttendanceRequest.request_type, leave_type=AttendanceRequest.leave_type,
                  from_date=AttendanceRequest.from_date, to_date=AttendanceRequest.to_date,
                  reason=AttendanceRequest.reason), AttendanceRequest.property_id)
    return union_all(*queries).subquery("activity")


class LogsService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def list_events(self, user: User, *, property_id: uuid.UUID | None = None,
                          category: str | None = None, search: str | None = None,
                          actor: str | None = None, action: str | None = None,
                          task_id: uuid.UUID | None = None, task_status: str | None = None,
                          date_from: datetime | None = None, date_to: datetime | None = None,
                          page: int = 1, limit: int = 50, ascending: bool = False) -> dict:
        if user.role != UserRole.SUPER_ADMIN or not user.company_id:
            raise Forbidden()
        activity = activity_query()
        q = select(activity).where(activity.c.company_uid == str(user.company_id))
        if property_id:
            q = q.where(activity.c.property_uid == str(property_id))
        if category:
            q = q.where(activity.c.category == category)
        if task_id or task_status:
            tasks = select(_text(Task.id)).join(Property, Task.property_id == Property.id).where(
                Property.company_id == user.company_id)
            if task_id:
                tasks = tasks.where(Task.id == task_id)
            if task_status:
                tasks = tasks.where(Task.status == task_status)
            q = q.where(or_(
                activity.c.entity_type.in_(("task", "tasks")) & activity.c.entity_uid.in_(tasks),
                activity.c.detail["task_uid"].astext.in_(tasks),
            ))
        if actor:
            term = f"%{actor.replace('/', '//').replace('%', '/%').replace('_', '/_')}%"
            q = q.where(activity.c.actor_name.ilike(term, escape="/"))
        if action:
            q = q.where(activity.c.action == action)
        if search:
            term = f"%{search.replace('/', '//').replace('%', '/%').replace('_', '/_')}%"
            q = q.where(or_(*(column.ilike(term, escape="/") for column in (
                activity.c.actor_name, activity.c.entity_name, activity.c.action,
                activity.c.property_name, _text(activity.c.detail), activity.c.entity_uid))))
        if date_from:
            q = q.where(activity.c.occurred_at >= date_from)
        if date_to:
            q = q.where(activity.c.occurred_at < date_to)
        total = (await self.session.execute(select(func.count()).select_from(q.subquery()))).scalar_one()
        result = await self.session.execute(q.order_by(
            activity.c.occurred_at.asc() if ascending else activity.c.occurred_at.desc(), activity.c.source,
            activity.c.event_uid.asc() if ascending else activity.c.event_uid.desc())
                                            .offset((page - 1) * limit).limit(limit))
        items = []
        for row in result.mappings():
            item = dict(row)
            item.pop("company_uid")
            item["log_uid"] = f"{item.pop('source')}:{item.pop('event_uid')}"
            item["occurred_at"] = item["occurred_at"].isoformat()
            item["detail"] = item["detail"] or {}
            items.append(item)
        return {"items": items, "total": total, "page": page, "limit": limit}

    async def attachment_key(self, user: User, source: str, event_id: uuid.UUID, index: int = 0) -> str:
        if user.role != UserRole.SUPER_ADMIN or not user.company_id:
            raise Forbidden()
        activity = activity_query()
        detail = (await self.session.execute(select(activity.c.detail).where(
            activity.c.company_uid == str(user.company_id), activity.c.source == source,
            activity.c.event_uid == str(event_id)
        ))).scalar_one_or_none()
        if not isinstance(detail, dict):
            raise LogAttachmentNotFound("Attachment not found.")
        urls = [detail.get("url"), *(detail.get("photos") if isinstance(detail.get("photos"), list) else [])]
        value = urls[index] if index < len(urls) else None
        key = storage_key_from_url(value) if isinstance(value, str) else None
        if not key:
            raise LogAttachmentNotFound("Attachment not found.")
        return key

    def _task_query(self, user: User):
        if user.role != UserRole.SUPER_ADMIN or not user.company_id:
            raise Forbidden()
        return select(
            _text(Task.id).label("task_uid"), Task.title, Task.ticket_number,
            _text(Task.property_id).label("property_uid"), Property.name.label("property_name"),
            Task.status, Task.assigned_to_name.label("assignee_name"),
            Zone.name.label("zone_name"), Task.created_at, Task.submitted_at,
            Task.completed_at, Task.abandoned_at, Task.abandoned_reason,
        ).join(Property, Task.property_id == Property.id).outerjoin(Zone, Task.zone_id == Zone.id).where(
            Property.company_id == user.company_id)

    @staticmethod
    def _task_summary(row):
        item = dict(row)
        for field in ("created_at", "submitted_at", "completed_at", "abandoned_at"):
            item[field] = item[field].isoformat() if item[field] else None
        return item

    async def find_tasks(self, user: User, *, search: str | None = None,
                         property_id: uuid.UUID | None = None, status: str | None = None,
                         page: int = 1, limit: int = 25) -> dict:
        q = self._task_query(user)
        if property_id:
            q = q.where(Task.property_id == property_id)
        if status:
            q = q.where(Task.status == status)
        if search:
            term = f"%{search.replace('/', '//').replace('%', '/%').replace('_', '/_')}%"
            q = q.where(or_(*(column.ilike(term, escape="/") for column in (
                Task.title, Task.ticket_number, _text(Task.id), Task.assigned_to_name))))
        total = (await self.session.execute(select(func.count()).select_from(q.subquery()))).scalar_one()
        rows = await self.session.execute(q.order_by(Task.created_at.desc(), Task.id).offset((page - 1) * limit).limit(limit))
        return {"items": [self._task_summary(row) for row in rows.mappings()],
                "total": total, "page": page, "limit": limit}

    async def task_journey(self, user: User, task_id: uuid.UUID, *, page: int = 1, limit: int = 50) -> dict:
        row = (await self.session.execute(self._task_query(user).where(Task.id == task_id))).mappings().one_or_none()
        if row is None:
            raise TaskJourneyNotFound("Task not found.")
        history_types = (await self.session.execute(
            select(TaskHistoryEvent.type).where(TaskHistoryEvent.task_id == task_id).distinct()
        )).scalars().all()
        result = await self.list_events(user, task_id=task_id, page=page, limit=limit, ascending=True)
        return {"task": self._task_summary(row), "events": result, "history_types": sorted(history_types)}


class LogAttachmentNotFound(AppError):
    status_code = 404
    code = "ATTACHMENT_NOT_FOUND"


class TaskJourneyNotFound(AppError):
    status_code = 404
    code = "TASK_NOT_FOUND"
