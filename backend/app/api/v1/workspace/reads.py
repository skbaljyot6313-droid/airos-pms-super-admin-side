import uuid

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.dependencies.auth import (
    get_current_user,
    require_property_manager,
    require_super_admin,
)
from app.models.user import User
from app.repositories.workspace import WorkspaceRepository
from app.schemas import workspace as ws
from app.schemas.property import PropertyCreateRequest
from app.services.property import PropertyService
from app.services.structure import StructureService

from ._common import NotFound, Staff, _tasks_list_payload, _uid

router = APIRouter()


@router.get("/properties")
async def list_properties(
    search: str | None = Query(default=None),
    status_: str | None = Query(default=None, alias="status"),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=20, ge=1, le=100),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    res = await WorkspaceRepository(session).list_properties(
        user, search=search, status=status_, page=page, limit=limit
    )
    res["items"] = [ws.property_out(p) for p in res["items"]]
    return res


@router.post("/properties", status_code=status.HTTP_201_CREATED)
async def create_property(
    payload: PropertyCreateRequest,
    user: User = Depends(require_super_admin),
    session: AsyncSession = Depends(get_db),
):
    """Create a property and its Property Manager account atomically."""
    prop = await PropertyService(session).create_property(user, payload)
    return ws.property_out(prop)


@router.get("/properties/{property_id}/reconciliation")
async def reconcile_resource_state(
    property_id: uuid.UUID,
    user: User = Depends(require_property_manager),
    session: AsyncSession = Depends(get_db),
):
    """Read-only integrity scan — reports orphan/contradictory resource
    states (spec §43/§44). It never repairs; corrections go through the
    transition API."""
    from app.services.reconciliation import reconcile_property

    prop = await StructureService(session)._property_for_write(
        user, property_id
    )
    findings = await reconcile_property(session, prop.id)
    return {"property_id": str(prop.id), "findings": findings}


@router.get("/properties/{property_id}")
async def get_property(
    property_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    prop = await WorkspaceRepository(session).get_property(user, property_id)
    if prop is None:
        raise NotFound("Property not found.")
    return ws.property_out(prop)


@router.get("/areas")
async def list_areas(
    property_uid: str | None = Query(default=None),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    res = await WorkspaceRepository(session).list_areas(
        user, property_id=_uid(property_uid)
    )
    res["items"] = [ws.area_out(a) for a in res["items"]]
    return res


@router.get("/zones")
async def list_zones(
    property_uid: str | None = Query(default=None),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    res = await WorkspaceRepository(session).list_zones(
        user, property_id=_uid(property_uid)
    )
    res["items"] = [ws.zone_out(z) for z in res["items"]]
    return res


@router.get("/rooms")
async def list_rooms(
    property_uid: str | None = Query(default=None),
    zone_uid: str | None = Query(default=None),
    status_: str | None = Query(default=None, alias="status"),
    search: str | None = Query(default=None),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    res = await WorkspaceRepository(session).list_rooms(
        user,
        property_id=_uid(property_uid),
        zone_id=_uid(zone_uid),
        status=status_,
        search=search,
    )
    res["items"] = await ws.rooms_payload(session, res["items"])
    return res


@router.get("/dorms")
async def list_dorms(
    property_uid: str | None = Query(default=None),
    zone_uid: str | None = Query(default=None),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    res = await WorkspaceRepository(session).list_dorms(
        user, property_id=_uid(property_uid), zone_id=_uid(zone_uid)
    )
    res["items"] = await ws.dorms_payload(session, res["items"])
    return res


@router.get("/washrooms")
async def list_washrooms(
    property_uid: str | None = Query(default=None),
    zone_uid: str | None = Query(default=None),
    status_: str | None = Query(default=None, alias="status"),
    search: str | None = Query(default=None),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    res = await WorkspaceRepository(session).list_washrooms(
        user,
        property_id=_uid(property_uid),
        zone_id=_uid(zone_uid),
        status=status_,
        search=search,
    )
    res["items"] = [ws.washroom_out(w) for w in res["items"]]
    return res


@router.get("/employees")
async def list_employees(
    property_uid: str | None = Query(default=None),
    zone_uid: str | None = Query(default=None),
    department: str | None = Query(default=None),
    status_: str | None = Query(default=None, alias="status"),
    search: str | None = Query(default=None),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    res = await WorkspaceRepository(session).list_employees(
        user,
        property_id=_uid(property_uid),
        zone_id=_uid(zone_uid),
        department=department,
        status=status_,
        search=search,
    )
    res["items"] = [ws.employee_out(e) for e in res["items"]]
    return res


@router.get("/tasks")
async def list_tasks(
    property_uid: str | None = Query(default=None),
    zone_uid: str | None = Query(default=None),
    employee_uid: str | None = Query(default=None),
    status_: str | None = Query(default=None, alias="status"),
    task_type: str | None = Query(default=None),
    search: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=20, ge=1, le=500),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    res = await WorkspaceRepository(session).list_tasks(
        user,
        property_id=_uid(property_uid),
        zone_id=_uid(zone_uid),
        employee_id=_uid(employee_uid),
        status=status_,
        task_type=task_type,
        search=search,
        page=page,
        limit=limit,
    )
    res["items"] = await _tasks_list_payload(session, res["items"])
    return res


@router.get("/tasks/today")
async def tasks_today(
    property_uid: str | None = Query(default=None),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Today's operational schedule — generated task instances PLUS
    scheduled template occurrences that haven't generated yet."""
    from app.services.task_ops import TaskOpsService
    return await TaskOpsService(session).today(user, _uid(property_uid))


@router.get("/tasks/history")
async def tasks_history(
    property_uid: str | None = Query(default=None),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    zone_uid: str | None = Query(default=None),
    room_uid: str | None = Query(default=None),
    washroom_uid: str | None = Query(default=None),
    employee_uid: str | None = Query(default=None),
    status_: str | None = Query(default=None, alias="status"),
    priority: str | None = Query(default=None),
    task_type: str | None = Query(default=None),
    source: str | None = Query(default=None),
    template_uid: str | None = Query(default=None),
    search: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Task History — every actual generated instance, with filters."""
    from datetime import date as _date

    from app.services.task_ops import TaskOpsService

    def _d(v):
        try:
            return _date.fromisoformat(v) if v else None
        except ValueError:
            return None

    return await TaskOpsService(session).history(
        user,
        property_id=_uid(property_uid),
        date_from=_d(date_from), date_to=_d(date_to),
        zone_id=_uid(zone_uid), room_id=_uid(room_uid),
        washroom_id=_uid(washroom_uid),
        employee_id=_uid(employee_uid),
        status=status_, priority=priority, task_type=task_type,
        source=source, template_id=_uid(template_uid), search=search,
        page=page, page_size=page_size,
    )


# ===========================================================================
# Mutations — staff only (super_admin / property_manager)
# ===========================================================================

@router.get("/tasks/calendar")
async def tasks_calendar(
    month: str = Query(...),
    property_uid: str | None = Query(default=None),
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    """Task calendar — per-operational-day activity counts for a month
    (YYYY-MM). Dates with any task activity come back in `days`."""
    from app.services.day_analysis import DayAnalysisService
    return await DayAnalysisService(session).calendar(
        user, _uid(property_uid), month
    )


@router.get("/tasks/history/{day}")
async def tasks_day_analysis(
    day: str,
    property_uid: str | None = Query(default=None),
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    """Daily task analysis — full breakdown for one operational day
    (YYYY-MM-DD): summary, per-task lifecycle, employee/zone/area/category
    aggregates."""
    from app.services.day_analysis import DayAnalysisService
    return await DayAnalysisService(session).day(
        user, _uid(property_uid), day
    )


