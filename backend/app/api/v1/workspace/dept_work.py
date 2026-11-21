"""Department work management + the shared work calendar.

Mounted by the workspace aggregator. Department managers are scoped
inside the service layer — every endpoint returns their departments'
data or NotFound, never a different department's rows.
"""
import uuid

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.dependencies.auth import require_role
from app.models.user import User, UserRole
from app.schemas.structure import TaskCreateRequest
from app.schemas import workspace as ws
from app.services.dept_work import DeptWorkService

from ._common import _tasks_list_payload, _uid

router = APIRouter(tags=["department-work"])

DeptStaff = Depends(require_role(
    UserRole.SUPER_ADMIN, UserRole.PROPERTY_MANAGER, UserRole.DEPARTMENT_MANAGER))


@router.get("/departments/{department_id}/roster")
async def department_roster(
    department_id: uuid.UUID,
    user: User = DeptStaff,
    session: AsyncSession = Depends(get_db),
):
    return await DeptWorkService(session).roster(user, department_id)


@router.get("/departments/{department_id}/work")
async def department_work(
    department_id: uuid.UUID,
    status: str | None = None,
    priority: str | None = None,
    employee_id: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
    search: str | None = Query(None, max_length=200),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    user: User = DeptStaff,
    session: AsyncSession = Depends(get_db),
):
    svc = DeptWorkService(session)
    res = await svc.list_work(
        user, department_id, status=status, priority=priority,
        employee_id=_uid(employee_id), from_date=from_date, to_date=to_date,
        search=search, page=page, limit=limit)
    return {**res, "items": await _tasks_list_payload(session, res["items"])}


@router.post("/departments/{department_id}/work", status_code=status.HTTP_201_CREATED)
async def allocate_work(
    department_id: uuid.UUID,
    payload: TaskCreateRequest,
    user: User = DeptStaff,
    session: AsyncSession = Depends(get_db),
):
    tasks = await DeptWorkService(session).allocate_work(
        user, department_id, payload)
    return {"items": await _tasks_list_payload(session, tasks)}


@router.get("/departments/{department_id}/performance")
async def department_performance(
    department_id: uuid.UUID,
    from_date: str | None = None,
    to_date: str | None = None,
    user: User = DeptStaff,
    session: AsyncSession = Depends(get_db),
):
    return await DeptWorkService(session).performance(
        user, department_id, from_date=from_date, to_date=to_date)


@router.get("/tasks/calendar")
async def tasks_calendar(
    property_id: str = Query(...),
    from_date: str = Query(...),
    to_date: str = Query(...),
    department_id: str | None = None,
    employee_id: str | None = None,
    zone_id: str | None = None,
    status: str | None = None,
    priority: str | None = None,
    work_type: str | None = None,
    user: User = DeptStaff,
    session: AsyncSession = Depends(get_db),
):
    """Date-scoped work for the property/department calendar — real task
    rows overlapping the window on scheduled_for, due_date or
    operational_date. Department managers are auto-scoped to their
    departments."""
    tasks = await DeptWorkService(session).calendar(
        user, property_id=_uid(property_id),
        from_date=from_date, to_date=to_date,
        department_id=_uid(department_id), employee_id=_uid(employee_id),
        zone_id=_uid(zone_id), status=status, priority=priority,
        work_type=work_type)
    return {"items": await _tasks_list_payload(session, tasks)}
