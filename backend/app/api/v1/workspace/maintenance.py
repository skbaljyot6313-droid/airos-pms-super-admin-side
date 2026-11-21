import uuid

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.dependencies.auth import (
    get_current_user,
)
from app.models.user import User
from app.schemas.maintenance import (
    MaintenanceActionRequest,
    MaintenanceAssignRequest,
    MaintenanceCreateRequest,
    MaintenanceDisapproveRequest,
    MaintenanceResolveRequest,
    MaintenanceUpdateRequest,
    ticket_out,
)
from app.services.maintenance import MaintenanceService

from ._common import Staff, _uid

router = APIRouter()


# ------------------------------- Maintenance tickets ------------------------

@router.post("/maintenance", status_code=status.HTTP_201_CREATED)
async def create_maintenance_ticket(
    payload: MaintenanceCreateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ticket_out(
        await MaintenanceService(session).create_ticket(user, payload)
    )


@router.get("/maintenance")
async def list_maintenance(
    property_uid: str | None = Query(default=None),
    room_uid: str | None = Query(default=None),
    washroom_uid: str | None = Query(default=None),
    assigned_to: str | None = Query(default=None),
    status_: str | None = Query(default=None, alias="status"),
    priority: str | None = Query(default=None),
    search: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    limit: int | None = Query(default=None, ge=1, le=500),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Ticket list — opt-in pagination. ``limit`` omitted keeps the
    historical full-list contract (the maintenance board filters
    client-side); when supplied it is hard-capped at 500."""
    tickets = await MaintenanceService(session).list_tickets(
        user,
        property_id=_uid(property_uid),
        room_id=_uid(room_uid),
        washroom_id=_uid(washroom_uid),
        assigned_to=_uid(assigned_to),
        status_=status_,
        priority=priority,
        search=search,
        limit=limit,
        offset=(page - 1) * limit if limit is not None else 0,
    )
    return {"items": [ticket_out(t) for t in tickets], "total": len(tickets)}


@router.get("/maintenance/calendar")
async def maintenance_calendar(
    month: str = Query(...),
    property_uid: str | None = Query(default=None),
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    """Maintenance calendar — per-operational-day ticket activity for one
    month (YYYY-MM)."""
    from app.services.maintenance_analysis import MaintenanceAnalysisService
    return await MaintenanceAnalysisService(session).calendar(
        user, _uid(property_uid), month
    )


@router.get("/maintenance/history/{day}")
async def maintenance_day_analysis(
    day: str,
    property_uid: str | None = Query(default=None),
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    """Daily maintenance analysis — tickets raised/carried/resolved/closed
    during one operational day (YYYY-MM-DD) with employee/zone/area/
    category/resource-impact breakdowns."""
    from app.services.maintenance_analysis import MaintenanceAnalysisService
    return await MaintenanceAnalysisService(session).day(
        user, _uid(property_uid), day
    )


@router.get("/maintenance/{ticket_id}")
async def get_maintenance_ticket(
    ticket_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    return ticket_out(
        await MaintenanceService(session).get_ticket(user, ticket_id)
    )


@router.patch("/maintenance/{ticket_id}")
async def update_maintenance_ticket(
    ticket_id: uuid.UUID,
    payload: MaintenanceUpdateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ticket_out(
        await MaintenanceService(session).update_ticket(user, ticket_id, payload)
    )


@router.delete("/maintenance/{ticket_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_maintenance_ticket(
    ticket_id: uuid.UUID,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    await MaintenanceService(session).delete_ticket(user, ticket_id)


@router.post("/maintenance/{ticket_id}/assign")
async def assign_maintenance_ticket(
    ticket_id: uuid.UUID,
    payload: MaintenanceAssignRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ticket_out(
        await MaintenanceService(session).assign(
            user, ticket_id, payload.employee_uid,
            emergency_override=payload.emergency_override,
            override_reason=payload.override_reason,
        )
    )


@router.post("/maintenance/{ticket_id}/start")
async def start_maintenance_ticket(
    ticket_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    return ticket_out(await MaintenanceService(session).start(user, ticket_id))


@router.post("/maintenance/{ticket_id}/hold")
async def hold_maintenance_ticket(
    ticket_id: uuid.UUID,
    payload: MaintenanceActionRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ticket_out(
        await MaintenanceService(session).hold(user, ticket_id, payload.note)
    )


@router.post("/maintenance/{ticket_id}/resolve")
async def resolve_maintenance_ticket(
    ticket_id: uuid.UUID,
    payload: MaintenanceResolveRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    return ticket_out(
        await MaintenanceService(session).resolve(user, ticket_id, payload)
    )


@router.post("/maintenance/{ticket_id}/disapprove")
async def disapprove_maintenance_ticket(
    ticket_id: uuid.UUID,
    payload: MaintenanceDisapproveRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ticket_out(
        await MaintenanceService(session).disapprove(
            user, ticket_id, payload.reason
        )
    )


@router.post("/maintenance/{ticket_id}/close")
async def close_maintenance_ticket(
    ticket_id: uuid.UUID,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ticket_out(await MaintenanceService(session).close(user, ticket_id))


@router.get("/washrooms/{washroom_id}/maintenance")
async def washroom_maintenance_history(
    washroom_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    tickets = await MaintenanceService(session).washroom_history(
        user, washroom_id
    )
    return {"items": [ticket_out(t) for t in tickets], "total": len(tickets)}


@router.get("/rooms/{room_id}/maintenance")
async def room_maintenance_history(
    room_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    tickets = await MaintenanceService(session).room_history(user, room_id)
    return {"items": [ticket_out(t) for t in tickets], "total": len(tickets)}


