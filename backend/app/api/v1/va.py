"""VA (Video Analytics) — camera + structure management, VMS stream sessions.

All endpoints are property-scoped and Staff-gated (super_admin +
property_manager). Stream playback URLs carry short-lived JWTs scoped to
one camera stream — camera RTSP URLs and credentials are never returned.
go2rtc serves WebRTC (`/api/webrtc`) + HLS (`/api/stream.m3u8`) for the
registered `cam_<id>` streams; in production it should sit behind a
token-checking reverse proxy.
"""

import httpx
from fastapi import APIRouter, Depends, Header, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.workspace._common import Staff
from app.core.config import settings
from app.core.database import get_db
from app.core.logging import get_logger
from app.models.user import User
from app.schemas.camera import (
    CameraCreateRequest,
    CameraMoveRequest,
    CameraUpdateRequest,
)
from app.services import go2rtc, mediamtx
from app.services.camera import CameraService

router = APIRouter(prefix="/va", tags=["va"])
logger = get_logger(__name__)


# --------------------------------------------------- webrtc signaling proxy
def _bearer_token(authorization: str | None) -> str:
    return authorization.removeprefix("Bearer ").strip() if authorization else ""


@router.post("/webrtc")
async def webrtc_signal(
    request: Request,
    authorization: str | None = Header(default=None),
):
    """Browser → backend → MediaMTX WHEP exchange.

    The short-lived playback token (Authorization: Bearer) authorizes
    exactly one `cam_<id>` stream for a few minutes after a Staff member
    opened a stream session. Proxying keeps the browser same-origin and
    validates the token before any media-server traffic. The WHEP session
    resource MediaMTX returns is echoed back as `X-WHEP-Resource` so the
    client can DELETE it through this endpoint on teardown."""
    token = _bearer_token(authorization)
    if not token:
        return Response(status_code=401)
    raw_path = mediamtx.stream_path_for_token(token)
    if not raw_path or not raw_path.startswith("cam_"):
        return Response(status_code=401)
    try:
        offer = (await request.body()).decode()
        answer, location = await mediamtx.whep_answer(raw_path, offer)
    except mediamtx.WhepUpstreamError as exc:
        logger.warning(
            "va.webrtc_upstream_error stream=%s upstream_status=%s detail=%s",
            raw_path, exc.status_code, exc.detail[:200],
        )
        return Response(
            status_code=502,
            content=f"media server rejected the WebRTC negotiation ({exc.status_code})",
            media_type="text/plain",
        )
    except httpx.HTTPError as exc:
        logger.warning(
            "va.webrtc_upstream_unreachable stream=%s error=%s", raw_path, exc
        )
        return Response(status_code=502, content="media server unreachable")
    headers = {"X-WHEP-Resource": location} if location else None
    return Response(content=answer, media_type="application/sdp", headers=headers)


@router.delete("/webrtc")
async def webrtc_close(
    request: Request,
    authorization: str | None = Header(default=None),
    resource: str | None = Query(default=None),
):
    """Tear down a WHEP session — frees the MediaMTX reader (and thus the
    go2rtc consumer and camera pull, thanks to demand-chaining)."""
    token = _bearer_token(authorization)
    if not token or not mediamtx.stream_path_for_token(token):
        return Response(status_code=401)
    if resource:
        await mediamtx.whep_close(resource)
    return Response(status_code=204)


@router.get("/media-health")
async def media_health(user: User = Staff):
    """Live connectivity of the streaming tiers — for ops diagnostics."""
    return {
        "go2rtc": await go2rtc.ping(),
        "mediamtx": await mediamtx.ping(),
        "configured": {
            "go2rtc_api": bool(settings.GO2RTC_API_URL),
            "go2rtc_rtsp": bool(settings.GO2RTC_RTSP_URL),
            "mediamtx_api": bool(settings.MEDIAMTX_API_URL),
            "mediamtx_signal": bool(settings.MEDIAMTX_SIGNAL_URL),
            "mediamtx_public": bool(settings.MEDIAMTX_PUBLIC_URL),
        },
    }


@router.get("/media-stats")
async def media_stats(
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    """VA operational dashboard — live media-plane counts plus DB-side
    totals. Lightweight: two control-API calls + two indexed COUNTs."""
    from sqlalchemy import func, select

    from app.models.camera import Camera, CameraStreamSession

    cams = await session.scalar(
        select(func.count(Camera.id)).where(Camera.deleted_at.is_(None))
    )
    active_sessions = await session.scalar(
        select(func.count(CameraStreamSession.id)).where(
            CameraStreamSession.status == "active"
        )
    )
    return {
        "configured_cameras": cams,
        "active_stream_sessions": active_sessions,
        "transcode_default": settings.VA_TRANSCODE_ENABLED,
        "limits": {
            "max_streams_per_user": settings.VA_MAX_STREAMS_PER_USER,
            "max_streams_per_property": settings.VA_MAX_STREAMS_PER_PROPERTY,
            "max_viewers_per_camera": settings.VA_MAX_VIEWERS_PER_CAMERA,
            "source_idle_seconds": settings.VA_SOURCE_IDLE_SECONDS,
            "session_idle_seconds": settings.VA_STREAM_SESSION_IDLE_SECONDS,
        },
        "go2rtc": await go2rtc.stats(),
        "mediamtx": await mediamtx.stats(),
    }


# ------------------------------------------------------------------ cameras
@router.get("/properties/{property_uid}/cameras")
async def list_cameras(
    property_uid: str,
    zone_uid: str | None = None,
    area_uid: str | None = None,
    status: str | None = Query(default=None, pattern="^(unknown|online|offline|error)$"),
    search: str | None = Query(default=None, max_length=120),
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return await CameraService(session).list_cameras(
        user,
        property_uid,
        zone_uid=zone_uid,
        area_uid=area_uid,
        status=status,
        search=search,
    )


@router.post("/properties/{property_uid}/cameras", status_code=201)
async def create_camera(
    property_uid: str,
    payload: CameraCreateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return await CameraService(session).create_camera(user, property_uid, payload)


@router.patch("/properties/{property_uid}/cameras/{camera_uid}")
async def update_camera(
    property_uid: str,
    camera_uid: str,
    payload: CameraUpdateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return await CameraService(session).update_camera(user, property_uid, camera_uid, payload)


@router.delete("/properties/{property_uid}/cameras/{camera_uid}", status_code=204)
async def delete_camera(
    property_uid: str,
    camera_uid: str,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    await CameraService(session).delete_camera(user, property_uid, camera_uid)


@router.post("/properties/{property_uid}/cameras/bulk-move")
async def bulk_move(
    property_uid: str,
    payload: CameraMoveRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return await CameraService(session).bulk_move(
        user, property_uid, payload.camera_uids, payload.zone_uid, payload.area_uid
    )


@router.post("/properties/{property_uid}/cameras/{camera_uid}/test-connection")
async def test_connection(
    property_uid: str,
    camera_uid: str,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return await CameraService(session).test_connection(user, property_uid, camera_uid)


# --------------------------------------------------------------- streaming
@router.post("/properties/{property_uid}/cameras/{camera_uid}/stream-session")
async def create_stream_session(
    property_uid: str,
    camera_uid: str,
    protocol: str = Query(default="webrtc", pattern="^(webrtc|hls)$"),
    quality: str = Query(default="main", pattern="^(main|sub)$"),
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return await CameraService(session).create_session(
        user, property_uid, camera_uid, protocol, quality
    )


@router.get("/stream-sessions/{session_uid}")
async def get_stream_session(
    session_uid: str,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return await CameraService(session).get_session(user, session_uid)


@router.delete("/stream-sessions/{session_uid}", status_code=204)
async def end_stream_session(
    session_uid: str,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    await CameraService(session).end_session(user, session_uid)



