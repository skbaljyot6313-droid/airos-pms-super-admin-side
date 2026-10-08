"""Live employee locations — Super Admin only.

GET /live-locations proxies the Employee Backend's server-to-server
endpoint; LOCATION_SERVICE_API_KEY never leaves this process — the
browser only ever sees this route's response.
"""

from fastapi import APIRouter, Depends

from app.dependencies.auth import require_super_admin
from app.models.user import User
from app.services import live_location

router = APIRouter(tags=["live-locations"])


@router.get("/live-locations")
async def get_live_locations(
    user: User = Depends(require_super_admin),
):
    return await live_location.fetch_live_locations()
