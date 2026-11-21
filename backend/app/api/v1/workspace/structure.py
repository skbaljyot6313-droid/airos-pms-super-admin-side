import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import get_db
from app.dependencies.auth import (
    get_current_user,
)
from app.models.user import User
from app.schemas import workspace as ws
from app.schemas.structure import (
    AllocationRequest,
    AreaCreateRequest,
    AreaUpdateRequest,
    BulkUnitStatusRequest,
    DormBulkCreateRequest,
    DormCreateRequest,
    DormUpdateRequest,
    RoomBulkCreateRequest,
    RoomBulkDeleteRequest,
    RoomCreateRequest,
    RoomUpdateRequest,
    WashroomBulkCreateRequest,
    WashroomCreateRequest,
    WashroomFixtureUpdateRequest,
    WashroomUpdateRequest,
    ZoneCreateRequest,
    ZoneUpdateRequest,
)
from app.services.structure import StructureService

from ._common import Staff

router = APIRouter()


# ------------------------------- Areas -----------------------------------

@router.post("/areas", status_code=status.HTTP_201_CREATED)
async def create_area(
    payload: AreaCreateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ws.area_out(await StructureService(session).create_area(user, payload))


@router.patch("/areas/{area_id}")
async def update_area(
    area_id: uuid.UUID,
    payload: AreaUpdateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ws.area_out(
        await StructureService(session).update_area(user, area_id, payload)
    )


@router.delete("/areas/{area_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_area(
    area_id: uuid.UUID,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    await StructureService(session).delete_area(user, area_id)


# ------------------------------- Zones -----------------------------------

@router.post("/zones", status_code=status.HTTP_201_CREATED)
async def create_zone(
    payload: ZoneCreateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ws.zone_out(await StructureService(session).create_zone(user, payload))


@router.patch("/zones/{zone_id}")
async def update_zone(
    zone_id: uuid.UUID,
    payload: ZoneUpdateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ws.zone_out(
        await StructureService(session).update_zone(user, zone_id, payload)
    )


@router.delete("/zones/{zone_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_zone(
    zone_id: uuid.UUID,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    await StructureService(session).delete_zone(user, zone_id)


# ------------------------------- Rooms -----------------------------------

@router.post("/rooms", status_code=status.HTTP_201_CREATED)
async def create_room(
    payload: RoomCreateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return await ws.room_payload(
        session, await StructureService(session).create_room(user, payload)
    )


@router.post("/rooms/bulk", status_code=status.HTTP_201_CREATED)
async def bulk_create_rooms(
    payload: RoomBulkCreateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    res = await StructureService(session).bulk_create_rooms(user, payload)
    return {
        "created": await ws.rooms_payload(session, res["created"]),
        "errors": res["errors"],
    }


@router.post("/rooms/bulk-delete")
async def bulk_delete_rooms(
    payload: RoomBulkDeleteRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return await StructureService(session).bulk_delete_rooms(user, payload)


@router.patch("/rooms/{room_id}")
async def update_room(
    room_id: uuid.UUID,
    payload: RoomUpdateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return await ws.room_payload(
        session,
        await StructureService(session).update_room(user, room_id, payload),
    )


@router.patch("/rooms/{room_id}/allocation")
async def allocate_room(
    room_id: uuid.UUID,
    payload: AllocationRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    from app.models.structure import Room

    room = await StructureService(session).allocate_unit(
        user, Room, room_id, payload.area_uid, payload.zone_uid
    )
    return await ws.room_payload(session, room)


@router.delete("/rooms/{room_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_room(
    room_id: uuid.UUID,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    await StructureService(session).delete_room(user, room_id)


# ------------------------------- Dorms / Beds -----------------------------

@router.post("/dorms", status_code=status.HTTP_201_CREATED)
async def create_dorm(
    payload: DormCreateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return await ws.dorm_payload(
        session, await StructureService(session).create_dorm(user, payload)
    )


@router.post("/dorms/bulk", status_code=status.HTTP_201_CREATED)
async def bulk_create_dorms(
    payload: DormBulkCreateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    res = await StructureService(session).bulk_create_dorms(user, payload)
    return {
        "created": await ws.dorms_payload(session, res["created"]),
        "errors": res["errors"],
    }


@router.patch("/dorms/{dorm_id}")
async def update_dorm(
    dorm_id: uuid.UUID,
    payload: DormUpdateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return await ws.dorm_payload(
        session,
        await StructureService(session).update_dorm(user, dorm_id, payload),
    )


@router.patch("/dorms/{dorm_id}/allocation")
async def allocate_dorm(
    dorm_id: uuid.UUID,
    payload: AllocationRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    from app.models.structure import Dorm

    dorm = await StructureService(session).allocate_unit(
        user, Dorm, dorm_id, payload.area_uid, payload.zone_uid
    )
    return await ws.dorm_payload(session, dorm)


@router.delete("/dorms/{dorm_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dorm(
    dorm_id: uuid.UUID,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    await StructureService(session).delete_dorm(user, dorm_id)


@router.post("/dorms/{dorm_id}/checkout")
async def dorm_checkout(
    dorm_id: uuid.UUID,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    res = await StructureService(session).dorm_checkout(user, dorm_id)
    return {
        **await ws.dorm_payload(session, res["dorm"]),
        "generated_tasks": [ws.task_out(t) for t in res["generated"]],
    }


@router.post("/dorms/{dorm_id}/mark-cleaning")
async def dorm_mark_cleaning(
    dorm_id: uuid.UUID,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return await ws.dorm_payload(
        session,
        await StructureService(session).dorm_mark_cleaning(user, dorm_id),
    )


@router.post("/dorms/{dorm_id}/mark-cleaned")
async def dorm_mark_cleaned(
    dorm_id: uuid.UUID,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return await ws.dorm_payload(
        session,
        await StructureService(session).dorm_mark_cleaned(user, dorm_id),
    )


# ------------------------------- Washrooms --------------------------------

@router.post("/washrooms", status_code=status.HTTP_201_CREATED)
async def create_washroom(
    payload: WashroomCreateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ws.washroom_out(
        await StructureService(session).create_washroom(user, payload)
    )


@router.post("/washrooms/bulk", status_code=status.HTTP_201_CREATED)
async def bulk_create_washrooms(
    payload: WashroomBulkCreateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    res = await StructureService(session).bulk_create_washrooms(user, payload)
    return {
        "created": [ws.washroom_out(w) for w in res["created"]],
        "errors": res["errors"],
    }


@router.get("/washrooms/{washroom_id}")
async def get_washroom(
    washroom_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    from app.models.structure import Washroom

    washroom, _ = await StructureService(session)._get(
        Washroom, washroom_id, user,
        options=[selectinload(Washroom.fixtures)],
    )
    return ws.washroom_out(washroom)


@router.patch("/washrooms/{washroom_id}")
async def update_washroom(
    washroom_id: uuid.UUID,
    payload: WashroomUpdateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ws.washroom_out(
        await StructureService(session).update_washroom(
            user, washroom_id, payload
        )
    )


@router.patch("/washrooms/{washroom_id}/allocation")
async def allocate_washroom(
    washroom_id: uuid.UUID,
    payload: AllocationRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    washroom = await StructureService(session).allocate_washroom(
        user, washroom_id, payload.area_uid, payload.zone_uid
    )
    return ws.washroom_out(washroom)


@router.patch("/washrooms/{washroom_id}/fixtures/{fixture_id}")
async def update_washroom_fixture(
    washroom_id: uuid.UUID,
    fixture_id: uuid.UUID,
    payload: WashroomFixtureUpdateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ws.washroom_out(
        await StructureService(session).update_fixture(
            user, washroom_id, fixture_id, payload.status
        )
    )


@router.delete("/washrooms/{washroom_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_washroom(
    washroom_id: uuid.UUID,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    await StructureService(session).delete_washroom(user, washroom_id)


@router.post("/units/bulk-status")
async def bulk_unit_status(
    payload: BulkUnitStatusRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    res = await StructureService(session).bulk_unit_status(user, payload)
    return {
        "rooms": await ws.rooms_payload(session, res["rooms"]),
        "dorms": await ws.dorms_payload(session, res["dorms"]),
        "washrooms": [ws.washroom_out(w) for w in res["washrooms"]],
        "generated_tasks": [ws.task_out(t) for t in res["generated_tasks"]],
        "skipped_blocked": res["skipped_blocked"],
    }


@router.post("/properties/{property_id}/fresh-day")
async def fresh_day(
    property_id: uuid.UUID,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    """'Fresh day' — abandon every open task in the property and release all
    unblocked cleaning/maintenance units to available. Occupied units stay
    occupied; open maintenance tickets keep their hold."""
    return await StructureService(session).fresh_day(user, property_id)


