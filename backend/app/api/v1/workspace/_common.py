"""Shared helpers for the workspace API modules — error types, UID
parsing, and the batched task-list serializer."""
import uuid

from fastapi import Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppError
from app.dependencies.auth import require_property_manager
from app.schemas import workspace as ws


class NotFound(AppError):
    status_code = status.HTTP_404_NOT_FOUND
    code = "NOT_FOUND"
    message = "The requested resource was not found."


class BadRequest(AppError):
    status_code = status.HTTP_400_BAD_REQUEST
    code = "BAD_REQUEST"
    message = "Invalid request."


# Route-permission shortcut: super_admin + property_manager.
Staff = Depends(require_property_manager)


def _uid(v: str | None) -> uuid.UUID | None:
    if not v:
        return None
    try:
        return uuid.UUID(v)
    except ValueError:
        raise NotFound()


async def _tasks_list_payload(session: AsyncSession, tasks: list) -> list[dict]:
    """Shared /tasks list serialization — resolves each task's
    _resolved_area_id from its zone or unit plus the department label
    with five batched IN() lookups (no per-row queries). Used by
    list_tasks, the /workspace aggregate and the work calendars."""
    from app.models.department import Department
    from app.models.structure import Dorm, Room, Washroom, Zone
    zone_ids = {t.zone_id for t in tasks if t.zone_id}
    room_ids = {t.room_id for t in tasks if t.room_id}
    dorm_ids = {t.dorm_id for t in tasks if t.dorm_id}
    washroom_ids = {t.washroom_id for t in tasks if t.washroom_id}
    dept_ids = {t.department_id for t in tasks if t.department_id}
    departments = {
        d.id: d.name for d in (await session.execute(
            select(Department).where(Department.id.in_(dept_ids))
        )).scalars()
    } if dept_ids else {}
    for task in tasks:
        task._department_name = departments.get(task.department_id)
    zones = {
        z.id: z for z in (await session.execute(
            select(Zone).where(Zone.id.in_(zone_ids))
        )).scalars()
    } if zone_ids else {}
    rooms = {
        r.id: r for r in (await session.execute(
            select(Room).where(Room.id.in_(room_ids))
        )).scalars()
    } if room_ids else {}
    dorms = {
        d.id: d for d in (await session.execute(
            select(Dorm).where(Dorm.id.in_(dorm_ids))
        )).scalars()
    } if dorm_ids else {}
    washrooms = {
        w.id: w for w in (await session.execute(
            select(Washroom).where(Washroom.id.in_(washroom_ids))
        )).scalars()
    } if washroom_ids else {}
    for task in tasks:
        zone = zones.get(task.zone_id)
        unit = rooms.get(task.room_id) or dorms.get(task.dorm_id) \
            or washrooms.get(task.washroom_id)
        task._resolved_area_id = zone.area_id if zone and zone.area_id else (
            unit.area_id if unit else None
        )
    return [ws.task_out(t) for t in tasks]
