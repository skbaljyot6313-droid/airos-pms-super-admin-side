import uuid

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.dependencies.auth import (
    get_current_user,
    require_role,
)
from app.models.user import User, UserRole
from app.schemas import workspace as ws
from app.schemas.structure import (
    TaskActionRequest,
    TaskCompleteRequest,
    TaskCreateRequest,
    TaskReassignRequest,
    TaskRejectRequest,
    TaskUpdateRequest,
)
from app.services.task import TaskService

from ._common import Staff, _uid

router = APIRouter()


# ------------------------------- Tasks ------------------------------------

@router.post("/tasks", status_code=status.HTTP_201_CREATED)
async def create_task(
    payload: TaskCreateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ws.task_out(await TaskService(session).create_task(user, payload))


@router.get("/tasks/review-queue")
async def tasks_review_queue(
    property_id: str = Query(...),
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    tasks = await TaskService(session).review_queue(user, _uid(property_id))
    return {"items": [ws.task_out(t) for t in tasks]}


@router.get("/tasks/{task_id}")
async def get_task(
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Task detail — history, completion images and submissions eager-loaded.
    The list payload intentionally omits those collections; the Detail
    Drawer calls this endpoint when a task is opened."""
    return ws.task_out(await TaskService(session).get_task(user, task_id))


@router.patch("/tasks/{task_id}")
async def update_task(
    task_id: uuid.UUID,
    payload: TaskUpdateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ws.task_out(
        await TaskService(session).update_task(user, task_id, payload)
    )


@router.delete("/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_task(
    task_id: uuid.UUID,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    await TaskService(session).delete_task(user, task_id)


@router.post("/tasks/{task_id}/start")
async def start_task(
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    return ws.task_out(await TaskService(session).start_task(user, task_id))


@router.post("/tasks/{task_id}/complete")
async def complete_task(
    task_id: uuid.UUID,
    payload: TaskCompleteRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    res = await TaskService(session).complete_task(user, task_id, payload)
    out = {"task": ws.task_out(res["task"])}
    if res.get("generated_task"):
        out["generated_task"] = ws.task_out(res["generated_task"])
    return out


@router.post("/tasks/{task_id}/request-redo")
async def request_redo(
    task_id: uuid.UUID,
    payload: TaskActionRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    return ws.task_out(
        await TaskService(session).request_redo(user, task_id, payload.note)
    )


@router.patch("/tasks/{task_id}/assignee")
async def reassign_task(
    task_id: uuid.UUID,
    payload: TaskReassignRequest,
    user: User = Depends(require_role(
        UserRole.SUPER_ADMIN, UserRole.PROPERTY_MANAGER,
        UserRole.DEPARTMENT_MANAGER)),
    session: AsyncSession = Depends(get_db),
):
    return ws.task_out(
        await TaskService(session).reassign(
            user, task_id, payload.employee_uid,
            emergency_override=payload.emergency_override,
            override_reason=payload.override_reason,
        )
    )


@router.post("/tasks/{task_id}/reopen")
async def reopen_task(
    task_id: uuid.UUID,
    payload: TaskActionRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ws.task_out(
        await TaskService(session).reopen_task(user, task_id, payload.note)
    )


@router.post("/tasks/{task_id}/approve")
async def approve_task(
    task_id: uuid.UUID,
    payload: TaskActionRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    res = await TaskService(session).approve_task(user, task_id, payload.note)
    out = {"task": ws.task_out(res["task"])}
    if res.get("generated_task"):
        out["generated_task"] = ws.task_out(res["generated_task"])
    return out


@router.post("/tasks/{task_id}/reject")
async def reject_task(
    task_id: uuid.UUID,
    payload: TaskRejectRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ws.task_out(
        await TaskService(session).reject_task(user, task_id, payload.reason)
    )


