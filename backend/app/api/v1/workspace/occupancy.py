import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.user import User
from app.schemas import workspace as ws
from app.schemas.structure import (
    CheckInRequest,
    OccupancySwitchRequest,
    ResourceTransitionRequest,
)

from ._common import NotFound, Staff

router = APIRouter()


# --- Occupancy commands — OCCUPIED is a business state backed by an
# `occupancies` row, never a raw status write (spec §11/§26) --------------

@router.post("/rooms/{room_id}/check-in")
async def room_check_in(
    room_id: uuid.UUID,
    payload: CheckInRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    from app.services.occupancy import OccupancyService
    room = await OccupancyService(session).check_in_room(
        user, room_id, payload.guest_name
    )
    return await ws.room_payload(session, room)


@router.post("/rooms/{room_id}/check-out")
async def room_check_out(
    room_id: uuid.UUID,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    from app.services.occupancy import OccupancyService
    res = await OccupancyService(session).check_out_room(user, room_id)
    return {
        **await ws.room_payload(session, res["room"]),
        "generated_tasks": [ws.task_out(t) for t in res["generated"]],
    }


@router.post("/beds/{bed_id}/check-in")
async def bed_check_in(
    bed_id: uuid.UUID,
    payload: CheckInRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    from app.services.occupancy import OccupancyService
    dorm = await OccupancyService(session).check_in_bed(
        user, bed_id, payload.guest_name
    )
    return await ws.dorm_payload(session, dorm)


@router.post("/beds/{bed_id}/check-out")
async def bed_check_out(
    bed_id: uuid.UUID,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    from app.services.occupancy import OccupancyService
    res = await OccupancyService(session).check_out_bed(user, bed_id)
    return {
        **await ws.dorm_payload(session, res["dorm"]),
        "generated_tasks": [ws.task_out(t) for t in res["generated"]],
    }


@router.post("/occupancy/switch")
async def occupancy_switch(
    payload: OccupancySwitchRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    """Move a guest (open occupancy) between any two units — room↔room,
    bed↔bed, or across kinds. `clean_vacated=False` releases the vacated
    unit straight to Available instead of flagging it for cleaning."""
    from app.services.occupancy import OccupancyService
    res = await OccupancyService(session).switch_occupancy(
        user,
        source_type=payload.source_type, source_id=payload.source_uid,
        target_type=payload.target_type, target_id=payload.target_uid,
        clean_vacated=payload.clean_vacated,
    )
    return {
        "guest_name": res["guest_name"],
        "generated_tasks": [ws.task_out(t) for t in res["generated"]],
        "dorms": {
            dorm_id: await ws.dorm_payload(session, dorm)
            for dorm_id, dorm in (res.get("dorms") or {}).items()
        },
        "rooms": {
            room_id: await ws.room_payload(session, room)
            for room_id, room in (res.get("rooms") or {}).items()
        },
    }


@router.post("/resources/{resource_type}/{resource_id}/transition")
async def resource_transition(
    resource_type: str,
    resource_id: uuid.UUID,
    payload: ResourceTransitionRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    """Staff administrative transition — legal-transition validation
    applies; ADMIN_OVERRIDE events are recorded with the mandatory reason.
    Property managers are confined to their own property by the state
    service's scope check."""
    from app.domain.resource_events import SRC_ADMIN_OVERRIDE
    from app.models.property import Property
    from app.services.resource_state import ResourceStateService

    svc = ResourceStateService(session)
    row, prev, new = await svc.transition(
        resource_type, resource_id, payload.to, user=user,
        source=SRC_ADMIN_OVERRIDE, reason=payload.reason,
    )
    prop = await session.get(Property, row.property_id)
    if prop is None or prop.company_id != user.company_id:
        raise NotFound()
    await session.commit()
    return {
        "resource_type": resource_type,
        "resource_id": str(resource_id),
        "previous_state": prev,
        "new_state": new,
    }


@router.post("/resources/{resource_type}/{resource_id}/repair")
async def resource_repair(
    resource_type: str,
    resource_id: uuid.UUID,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    """Super Admin reconciliation-repair — rewrites the materialized
    status to the canonical projection (occupancy + blockers) with a
    `state_reconciliation` audit event. Never deletes occupancy, task or
    ticket records."""
    from app.services.resource_state import ResourceStateService

    result = await ResourceStateService(session).repair(
        resource_type, resource_id, user=user,
    )
    await session.commit()
    return result


