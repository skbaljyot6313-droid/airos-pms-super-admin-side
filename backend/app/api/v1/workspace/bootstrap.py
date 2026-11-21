import asyncio

from fastapi import APIRouter, Depends

from app.core.database import AsyncSessionLocal
from app.dependencies.auth import (
    get_current_user,
)
from app.models.user import User
from app.repositories.workspace import WorkspaceRepository
from app.schemas import workspace as ws
from app.schemas.maintenance import (
    ticket_out,
)
from app.services.maintenance import MaintenanceService

from ._common import _tasks_list_payload

router = APIRouter()


@router.get("/workspace")
async def workspace_bootstrap(
    user: User = Depends(get_current_user),
):
    """Aggregate bootstrap — every collection the SPA's loadWorkspace()
    pulls on sign-in, in ONE request (B-04).

    Each collection runs on its OWN pooled session inside asyncio.gather:
    the 9 parallel queries interleave exactly like the former 9-request
    burst, but pay ONE auth lookup, ONE serialization, and ONE network
    round trip instead of nine. Per-collection response shapes are
    identical to the individual list endpoints; scoping rules are the
    same repository paths, so tenant isolation is unchanged."""
    async def _properties(s):
        res = await WorkspaceRepository(s).list_properties(user)
        res["items"] = [ws.property_out(p) for p in res["items"]]
        return res

    async def _areas(s):
        res = await WorkspaceRepository(s).list_areas(user)
        res["items"] = [ws.area_out(a) for a in res["items"]]
        return res

    async def _zones(s):
        res = await WorkspaceRepository(s).list_zones(user)
        res["items"] = [ws.zone_out(z) for z in res["items"]]
        return res

    async def _rooms(s):
        res = await WorkspaceRepository(s).list_rooms(user)
        res["items"] = await ws.rooms_payload(s, res["items"])
        return res

    async def _dorms(s):
        res = await WorkspaceRepository(s).list_dorms(user)
        res["items"] = await ws.dorms_payload(s, res["items"])
        return res

    async def _washrooms(s):
        res = await WorkspaceRepository(s).list_washrooms(user)
        res["items"] = [ws.washroom_out(w) for w in res["items"]]
        return res

    async def _employees(s):
        res = await WorkspaceRepository(s).list_employees(user)
        res["items"] = [ws.employee_out(e) for e in res["items"]]
        return res

    async def _tasks(s):
        res = await WorkspaceRepository(s).list_tasks(user)
        res["items"] = await _tasks_list_payload(s, res["items"])
        return res

    async def _maintenance(s):
        tickets = await MaintenanceService(s).list_tickets(user)
        return {"items": [ticket_out(t) for t in tickets],
                "total": len(tickets)}

    async def _collect(fn):
        async with AsyncSessionLocal() as s:
            return await fn(s)

    (properties, areas, zones, rooms, dorms, washrooms,
     employees, tasks, maintenance) = await asyncio.gather(
        _collect(_properties), _collect(_areas), _collect(_zones),
        _collect(_rooms), _collect(_dorms), _collect(_washrooms),
        _collect(_employees), _collect(_tasks), _collect(_maintenance),
    )
    return {
        "properties": properties,
        "areas": areas,
        "zones": zones,
        "rooms": rooms,
        "dorms": dorms,
        "washrooms": washrooms,
        "employees": employees,
        "tasks": tasks,
        "maintenance": maintenance,
    }


