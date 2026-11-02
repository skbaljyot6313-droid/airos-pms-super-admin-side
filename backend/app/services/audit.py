"""AuditService — append-only record for staff-facing mutations.

`record()` writes an AuditEvent into the caller's transaction — the event
commits/rolls back with the operation it describes. `detail` carries only
non-secret context (no passwords/tokens).
"""

import uuid
from datetime import date, datetime
from enum import Enum

from sqlalchemy import event, inspect
from sqlalchemy.orm import Session

from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import AuditEvent
from app.models.property import Property
from app.models.user import User


class AuditService:
    def __init__(self, session: AsyncSession):
        self.session = session

    def record(
        self,
        actor: User,
        *,
        entity_type: str,
        entity_id: uuid.UUID | None = None,
        entity_name: str | None = None,
        action: str,
        property_id: uuid.UUID | None = None,
        detail: dict | None = None,
    ) -> AuditEvent:
        ev = AuditEvent(
            property_id=property_id,
            actor_user_id=actor.id,
            actor_name=actor.name,
            entity_type=entity_type,
            entity_id=entity_id,
            entity_name=entity_name,
            action=action,
            detail={**(detail or {}), "company_uid": str(actor.company_id)},
        )
        self.session.add(ev)
        return ev

    async def list_events(
        self,
        user: User,
        *,
        entity_type: str | None = None,
        entity_id: uuid.UUID | None = None,
        action: str | None = None,
        actor: str | None = None,
        date_from=None,
        date_to=None,
        page: int = 1,
        limit: int = 50,
    ) -> dict:
        """Property-scoped log query — non-admins see only their own
        property's events."""
        q = select(AuditEvent)
        if user.property_id is not None:
            q = q.where(AuditEvent.property_id == user.property_id)
        elif user.company_id:
            q = q.join(Property, AuditEvent.property_id == Property.id).where(
                Property.company_id == user.company_id
            )
        if entity_type:
            q = q.where(AuditEvent.entity_type == entity_type)
        if entity_id:
            q = q.where(AuditEvent.entity_id == entity_id)
        if action:
            q = q.where(AuditEvent.action == action)
        if actor:
            q = q.where(AuditEvent.actor_name.ilike(f"%{actor}%"))
        if date_from:
            q = q.where(AuditEvent.created_at >= date_from)
        if date_to:
            q = q.where(AuditEvent.created_at < date_to)
        total = await self.session.execute(
            select(func.count()).select_from(q.subquery())
        )
        res = await self.session.execute(
            q.order_by(desc(AuditEvent.created_at))
            .offset((page - 1) * limit).limit(limit)
        )
        return {"items": list(res.scalars()), "total": total.scalar() or 0}


_CAPTURE_TABLES = {
    "companies", "properties", "areas", "zones", "rooms", "dorms", "beds",
    "washrooms", "washroom_fixtures", "employees", "users", "tasks",
    "maintenance_tickets", "work_templates", "shifts", "employee_shift_assignments",
    "attendance_requests", "occupancies",
}
_CAPTURE_FIELDS = {
    "name", "company_name", "brand_name", "code", "title", "ticket_number", "issue",
    "status", "role", "is_active", "property_id", "zone_id", "area_id", "employee_id",
    "assigned_to", "assigned_to_name", "room_id", "room_number", "dorm_id", "bed_id",
    "bed_number", "washroom_id", "task_type", "work_type", "priority", "department",
    "job_title", "due_date", "scheduled_for", "expires_at", "completed_at", "submitted_at",
    "started_at", "ended_at", "checked_in_at", "checked_out_at", "start_time", "end_time",
    "shift_id", "effective_from", "effective_until", "from_date", "to_date", "request_type",
    "reviewed_at", "reviewed_by_name", "operational_day_start", "version", "next_run_at",
}


def _safe_value(value):
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, (uuid.UUID, date, datetime)):
        return str(value)
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    return str(value)


@event.listens_for(Session, "before_flush")
def capture_mutations(session, _flush_context, _instances):
    actor = session.info.get("audit_actor")
    if not actor:
        return
    for action, objects in (("created", list(session.new)), ("updated", list(session.dirty)),
                            ("deleted", list(session.deleted))):
        for obj in objects:
            state = inspect(obj)
            table = state.mapper.local_table.name
            if table not in _CAPTURE_TABLES:
                continue
            changed = {key: state.attrs[key].history for key in _CAPTURE_FIELDS.intersection(state.dict)
                       if state.attrs[key].history.has_changes()}
            if action == "updated" and not changed:
                continue
            entity_id = state.identity[0] if state.has_identity else state.dict.get("id")
            if entity_id is None:
                entity_id = obj.id = uuid.uuid4()
            columns = {column.key: column for column in state.mapper.local_table.columns
                       if column.key in _CAPTURE_FIELDS}
            previous = {}
            if state.has_identity and (set(columns) - state.dict.keys() or
                                       any(not history.deleted for history in changed.values())):
                previous = dict(session.connection().execute(
                    select(*columns.values()).where(state.mapper.local_table.c.id == entity_id)
                ).mappings().one_or_none() or {})
            values = {key: _safe_value(value) for key, value in {**previous, **state.dict}.items()
                      if key in _CAPTURE_FIELDS}
            changes = {
                key: {"before": _safe_value(history.deleted[0]) if history.deleted else _safe_value(previous.get(key)),
                      "after": _safe_value(history.added[0]) if history.added else None}
                for key, history in changed.items()
            } if action == "updated" else {}
            property_id = entity_id if table == "properties" else values.get("property_id")
            name = next((str(values[key]) for key in ("name", "title", "ticket_number", "room_number",
                         "bed_number", "issue", "company_name") if values.get(key)), None)
            session.add(AuditEvent(
                actor_user_id=actor["id"], actor_name=actor["name"],
                entity_type=table, entity_id=entity_id, entity_name=name, action=action,
                detail={"company_uid": str(actor["company_id"]),
                        "property_uid": str(property_id) if property_id else None,
                        "property_name": name if table == "properties" else None,
                        "actor_role": actor["role"], "values": values, "changes": changes},
            ))
