import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.exceptions import AppError
from app.core.storage import get_storage
from app.dependencies.auth import require_super_admin
from app.models.user import User
from app.services.logs import LogAttachmentNotFound, LogsService

router = APIRouter(prefix="/admin/logs", tags=["logs"])
TaskStatus = Literal["pending", "assigned", "in_progress", "submitted", "reopened", "completed", "cancelled", "abandoned", "overdue", "scheduled"]


class InvalidLogFilter(AppError):
    status_code = 422
    code = "INVALID_LOG_FILTER"


@router.get("")
async def list_logs(
    user: User = Depends(require_super_admin),
    session: AsyncSession = Depends(get_db),
    property_id: uuid.UUID | None = None,
    category: Literal["audit", "session", "task", "photo", "maintenance", "allocation", "resource", "attendance"] | None = None,
    search: str | None = Query(None, max_length=200),
    actor: str | None = Query(None, max_length=200),
    action: str | None = Query(None, max_length=64),
    task_status: TaskStatus | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    page: int = Query(1, ge=1, le=100000),
    limit: int = Query(50, ge=1, le=100),
):
    if any(value is not None and value.utcoffset() is None for value in (date_from, date_to)):
        raise InvalidLogFilter("Date filters must include a timezone.")
    if date_from and date_to and date_from >= date_to:
        raise InvalidLogFilter("The end date must be after the start date.")
    return await LogsService(session).list_events(
        user, property_id=property_id, category=category, search=search, actor=actor, action=action,
        date_from=date_from, date_to=date_to, page=page, limit=limit, task_status=task_status,
    )


@router.get("/tasks")
async def find_tasks(
    user: User = Depends(require_super_admin),
    session: AsyncSession = Depends(get_db),
    search: str | None = Query(None, max_length=200),
    property_id: uuid.UUID | None = None,
    status: TaskStatus | None = None,
    page: int = Query(1, ge=1, le=100000),
    limit: int = Query(25, ge=1, le=100),
):
    return await LogsService(session).find_tasks(
        user, search=search, property_id=property_id, status=status, page=page, limit=limit)


@router.get("/tasks/{task_id}/journey")
async def task_journey(
    task_id: uuid.UUID,
    user: User = Depends(require_super_admin),
    session: AsyncSession = Depends(get_db),
    page: int = Query(1, ge=1, le=100000),
    limit: int = Query(50, ge=1, le=100),
):
    return await LogsService(session).task_journey(user, task_id, page=page, limit=limit)


class LogAttachmentUnavailable(AppError):
    status_code = 503
    code = "ATTACHMENT_UNAVAILABLE"


@router.get("/attachments/{source}/{event_id}")
async def log_attachment(
    source: Literal["task_photo", "maintenance_photo", "audit", "task_history"],
    event_id: uuid.UUID,
    index: int = Query(0, ge=0, le=100),
    user: User = Depends(require_super_admin),
    session: AsyncSession = Depends(get_db),
):
    key = await LogsService(session).attachment_key(user, source, event_id, index)
    try:
        opened = await get_storage().open(key)
    except Exception as exc:
        raise LogAttachmentUnavailable("Attachment is temporarily unavailable.") from exc
    if opened is None:
        raise LogAttachmentNotFound("Attachment not found.")
    stream, content_type, _length = opened
    if content_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise LogAttachmentNotFound("Image preview is not available.")
    return StreamingResponse(stream, media_type=content_type, headers={
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    })
