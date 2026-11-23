"""VA camera service — CRUD, structure assignment, stream sessions,
connectivity.

Owns the cameras/camera_stream_sessions tables. Cameras assign into the
property's existing areas/zones — `zone_id` implies its area for grouping;
`area_id` alone is area-level placement. Coordinates with
`services.go2rtc` so the media server's path registry mirrors the enabled
camera set; go2rtc pulls RTSP lazily per consumer, so a registered path
costs nothing while nobody watches.
"""

import asyncio
import hashlib
import socket
import time
import uuid
from datetime import UTC, datetime
from urllib.parse import quote, urlsplit, urlunsplit

from sqlalchemy import String, and_, case, cast, func, literal, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.exceptions import AppError
from app.core.logging import get_logger
from app.core.secrets_crypto import decrypt_secret, encrypt_secret
from app.models.camera import Camera, CameraStreamSession
from app.models.property import Property
from app.models.structure import Area, Zone
from app.models.user import User, UserRole
from app.schemas.camera import (
    CameraCreateRequest,
    CameraUpdateRequest,
    camera_out,
    session_out,
)
from app.services import go2rtc, mediamtx
from app.services.audit import AuditService
from app.services.structure import NotFoundErr as NotFound
from app.services.structure import StructureService
from app.services.structure import ValidationErr as BadRequest

logger = get_logger(__name__)


class ServiceUnavailable(AppError):
    status_code = 503
    code = "STREAMING_UNAVAILABLE"
    message = "The media server is not configured."


class Conflict(AppError):
    status_code = 409
    code = "CONFLICT"


def full_rtsp_url(c: Camera, url: str | None = None) -> str:
    """Rebuild a connect URL with credentials embedded — server-side only.
    Never serialized to a client. `url` defaults to the primary rtsp_url;
    pass `c.sub_rtsp_url` for the substream (same camera, same creds)."""
    url = url or c.rtsp_url
    if not (c.username or c.password):
        return url
    parts = urlsplit(url)
    userinfo = quote(c.username or "", safe="")
    if c.password:
        try:
            userinfo += ":" + quote(decrypt_secret(c.password), safe="")
        except ValueError:
            pass  # undecryptable creds → try anonymous rather than crash
    netloc = f"{userinfo}@{parts.hostname}"
    if parts.port:
        netloc += f":{parts.port}"
    return urlunsplit(("rtsp", netloc, parts.path, parts.query, ""))


def _transcode_for(cam: Camera) -> bool:
    """Per-camera override wins; NULL follows the global default. Transcode
    is the exception — passthrough is preferred whenever codecs allow."""
    return cam.transcode if cam.transcode is not None else settings.VA_TRANSCODE_ENABLED


def _media_ready() -> bool:
    """Both tiers configured: go2rtc (ingest) AND MediaMTX (distribution)."""
    return go2rtc.available() and mediamtx.available()


def _warm(cam: Camera) -> bool:
    return bool(cam.warm) and settings.VA_WARM_ENABLED


async def _register_media(cam: Camera) -> None:
    """Push the camera through the pipeline: go2rtc ingests the RTSP source
    (and substream, when configured) and restreams it; MediaMTX pulls the
    restream into `cam_<id>`/`cam_<id>_sub` paths. When the camera's codec
    doesn't need transcoding the raw restream goes straight through —
    no ffmpeg is spawned at all. All media-server calls run concurrently."""
    tc = _transcode_for(cam)
    warm = _warm(cam)
    sub_url = full_rtsp_url(cam, cam.sub_rtsp_url) if cam.sub_rtsp_url else None
    coros = [
        go2rtc.ensure_stream(cam.id, full_rtsp_url(cam), cam.transport, tc, sub_url),
        mediamtx.ensure_path(cam.id, sub=False, transcode=tc, warm=warm),
    ]
    if sub_url:
        coros.append(mediamtx.ensure_path(cam.id, sub=True, transcode=tc, warm=warm))
    await asyncio.gather(*coros)


# --------------------------------------------------------------------------
# Registration cache — a stream-session request must never pay the media
# server's config round-trips twice for the same camera configuration.
# Fingerprints cover every input that changes the pushed config; a periodic
# index check (VA_MEDIA_INDEX_TTL_SECONDS) detects media-server restarts
# that wiped registrations. Per-camera locks make concurrent sessions for
# the same camera register exactly once while different cameras proceed
# fully in parallel.
# --------------------------------------------------------------------------
_reg_fp: dict[uuid.UUID, str] = {}
_reg_locks: dict[uuid.UUID, asyncio.Lock] = {}
_session_locks: dict[tuple[uuid.UUID, uuid.UUID, str], asyncio.Lock] = {}
_index_state = {"at": 0.0, "go2rtc": frozenset(), "mtx": frozenset()}
_last_sweep = 0.0


def _registration_fingerprint(cam: Camera) -> str:
    raw = "|".join(
        [
            full_rtsp_url(cam),
            full_rtsp_url(cam, cam.sub_rtsp_url) if cam.sub_rtsp_url else "-",
            cam.transport or "tcp",
            "t" if _transcode_for(cam) else "p",
            "w" if _warm(cam) else "-",
        ]
    )
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _expected_media_names(cam: Camera) -> tuple[set[str], set[str]]:
    """Every go2rtc stream name + MediaMTX path a camera should own."""
    tc = _transcode_for(cam)
    g2 = {go2rtc.stream_name(cam.id)}
    paths = {mediamtx.path_name(cam.id)}
    if tc:
        g2.add(go2rtc.distribution_name(cam.id, sub=False, transcode=True))
    if cam.sub_rtsp_url:
        g2.add(go2rtc.stream_name(cam.id, sub=True))
        paths.add(mediamtx.path_name(cam.id, sub=True))
        if tc:
            g2.add(go2rtc.distribution_name(cam.id, sub=True, transcode=True))
    if _warm(cam) and tc:
        paths.add(mediamtx.warm_path_name(cam.id))
        if cam.sub_rtsp_url:
            paths.add(mediamtx.warm_path_name(cam.id, sub=True))
    return g2, paths


async def _refresh_media_index() -> None:
    """Re-fetch the media-server registrations at most once per TTL —
    detects registrations lost to a media-server restart."""
    now = time.monotonic()
    if now - _index_state["at"] < settings.VA_MEDIA_INDEX_TTL_SECONDS:
        return
    _index_state["at"] = now  # claim first — concurrent callers don't stack fetches
    g, m = await asyncio.gather(go2rtc.stream_index(), mediamtx.path_index())
    if g is not None:
        _index_state["go2rtc"] = frozenset(g)
    if m is not None:
        _index_state["mtx"] = frozenset(m)


async def _registration_missing(cam: Camera) -> bool:
    """True when the camera's expected streams/paths are absent from the
    live indexes. Unreachable servers leave the last-known index in place
    so an outage doesn't trigger a re-register storm."""
    await _refresh_media_index()
    g, p = _expected_media_names(cam)
    return not g <= _index_state["go2rtc"] or not p <= _index_state["mtx"]


async def _ensure_media_registered(cam: Camera) -> None:
    """Fingerprint-cached registration. Hot path: zero media-server calls.
    Cold path: concurrent registration under a per-camera lock so N
    simultaneous sessions for one camera register exactly once."""
    if not _media_ready():
        return
    fp = _registration_fingerprint(cam)
    if _reg_fp.get(cam.id) == fp and not await _registration_missing(cam):
        return
    lock = _reg_locks.setdefault(cam.id, asyncio.Lock())
    async with lock:
        if _reg_fp.get(cam.id) == fp and not await _registration_missing(cam):
            return
        await _register_media(cam)
        _reg_fp[cam.id] = fp
        # keep the shared index current so the next camera doesn't refetch
        g, p = _expected_media_names(cam)
        _index_state["go2rtc"] |= g
        _index_state["mtx"] |= p


def invalidate_registration(camera_id: uuid.UUID) -> None:
    _reg_fp.pop(camera_id, None)


async def warm_start() -> None:
    """Boot-time warm-up: re-register every enabled warm camera so media
    servers that lost state (restart) are repopulated and keepalive pulls
    resume. Bounded concurrency; failures are logged, never fatal."""
    if not (settings.VA_WARM_ENABLED and _media_ready()):
        return
    from app.core.database import AsyncSessionLocal

    try:
        async with AsyncSessionLocal() as s:
            res = await s.execute(
                select(Camera).where(
                    Camera.is_enabled.is_(True),
                    Camera.warm.is_(True),
                    Camera.deleted_at.is_(None),
                )
            )
            cams = list(res.scalars())
    except Exception as exc:
        logger.warning("va.warm_start_query_failed error=%s", exc)
        return
    sem = asyncio.Semaphore(8)

    async def one(c: Camera) -> None:
        async with sem:
            try:
                await _ensure_media_registered(c)
            except Exception as exc:
                logger.warning(
                    "va.warm_register_failed camera=%s error=%s", c.id, exc
                )

    await asyncio.gather(*(one(c) for c in cams))
    logger.info("va.warm_start cameras=%d", len(cams))


class CameraService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.structure = StructureService(session)
        self.audit = AuditService(session)

    async def _property(self, user: User, property_uid: str) -> Property:
        try:
            pid = uuid.UUID(property_uid)
        except ValueError:
            raise NotFound("Property not found.")
        return await self.structure._property_for_write(user, pid)

    async def _camera(self, prop: Property, camera_uid: str) -> Camera:
        try:
            cid = uuid.UUID(camera_uid)
        except ValueError:
            raise NotFound("Camera not found.")
        res = await self.session.execute(
            select(Camera)
            .options(selectinload(Camera.zone), selectinload(Camera.area))
            .where(
                Camera.id == cid,
                Camera.property_id == prop.id,
                Camera.deleted_at.is_(None),
            )
        )
        cam = res.scalar_one_or_none()
        if cam is None:
            raise NotFound("Camera not found.")
        return cam

    async def _zone(self, prop: Property, zone_uid: str) -> Zone:
        try:
            zid = uuid.UUID(zone_uid)
        except ValueError:
            raise NotFound("Zone not found.")
        res = await self.session.execute(
            select(Zone)
            .options(selectinload(Zone.area))
            .where(Zone.id == zid, Zone.property_id == prop.id)
        )
        zone = res.scalar_one_or_none()
        if zone is None:
            raise NotFound("Zone not found.")
        return zone

    async def _area(self, prop: Property, area_uid: str) -> Area:
        try:
            aid = uuid.UUID(area_uid)
        except ValueError:
            raise NotFound("Area not found.")
        res = await self.session.execute(
            select(Area).where(Area.id == aid, Area.property_id == prop.id)
        )
        area = res.scalar_one_or_none()
        if area is None:
            raise NotFound("Area not found.")
        return area

    async def _assign_target(
        self, prop: Property, zone_uid: str | None, area_uid: str | None
    ) -> tuple[uuid.UUID | None, uuid.UUID | None, str | None, str | None]:
        """Resolve a (zone_uid|area_uid) target to (zone_id, area_id,
        zone_name, area_name) — zone implies its area; both-unset means
        unassigned. Names are carried out because camera relationships are
        not loaded on mutation paths."""
        if zone_uid:
            z = await self._zone(prop, zone_uid)
            return z.id, z.area_id, z.name, z.area.name if z.area else None
        if area_uid:
            a = await self._area(prop, area_uid)
            return None, a.id, None, a.name
        return None, None, None, None

    # ------------------------------------------------------------- cameras
    async def _check_warm_cap(self, prop: Property) -> None:
        n = await self.session.scalar(
            select(func.count(Camera.id)).where(
                Camera.property_id == prop.id,
                Camera.warm.is_(True),
                Camera.deleted_at.is_(None),
            )
        )
        if (n or 0) >= settings.VA_WARM_MAX_STREAMS:
            raise Conflict(
                f"Warm stream limit reached ({settings.VA_WARM_MAX_STREAMS}).",
                code="WARM_LIMIT",
            )

    async def list_cameras(
        self,
        user: User,
        property_uid: str,
        *,
        zone_uid: str | None = None,
        area_uid: str | None = None,
        status: str | None = None,
        search: str | None = None,
    ) -> list[dict]:
        prop = await self._property(user, property_uid)
        q = (
            select(Camera)
            .options(selectinload(Camera.zone), selectinload(Camera.area))
            .where(Camera.property_id == prop.id, Camera.deleted_at.is_(None))
            .order_by(Camera.name)
        )
        if zone_uid == "unassigned":
            q = q.where(Camera.zone_id.is_(None), Camera.area_id.is_(None))
        elif zone_uid:
            q = q.where(Camera.zone_id == uuid.UUID(zone_uid))
        if area_uid:
            q = q.where(Camera.area_id == uuid.UUID(area_uid))
        if status:
            q = q.where(Camera.connection_status == status)
        if search:
            like = f"%{search.strip()}%"
            q = q.where(
                or_(
                    Camera.name.ilike(like),
                    cast(Camera.id, String).ilike(like),
                )
            )
        res = await self.session.execute(q)
        return [
            camera_out(
                c,
                zone_name=c.zone.name if c.zone else None,
                area_name=c.area.name if c.area else None,
            )
            for c in res.scalars()
        ]

    async def create_camera(
        self, user: User, property_uid: str, payload: CameraCreateRequest
    ) -> dict:
        prop = await self._property(user, property_uid)
        zone_id, area_id, zname, aname = await self._assign_target(
            prop, payload.zone_uid, payload.area_uid
        )
        if payload.warm:
            await self._check_warm_cap(prop)
        cam = Camera(
            property_id=prop.id,
            zone_id=zone_id,
            area_id=area_id,
            name=payload.name.strip(),
            description=payload.description,
            location=payload.location,
            rtsp_url=payload.rtsp_url,
            sub_rtsp_url=payload.sub_rtsp_url,
            transcode=payload.transcode,
            warm=payload.warm,
            username=payload.username,
            password=encrypt_secret(payload.password) if payload.password else None,
            transport=payload.transport,
            resolution=payload.resolution,
            fps=payload.fps,
            is_enabled=payload.is_enabled,
        )
        self.session.add(cam)
        await self.session.flush()
        if _media_ready() and cam.is_enabled:
            try:
                await _register_media(cam)
                _reg_fp[cam.id] = _registration_fingerprint(cam)
            except Exception as exc:  # config push failure must not block CRUD
                logger.warning(
                    "va.media_registration_failed camera=%s error=%s", cam.id, exc
                )
        self.audit.record(
            user,
            entity_type="camera",
            entity_id=cam.id,
            entity_name=cam.name,
            action="create",
            property_id=prop.id,
        )
        await self.session.commit()
        return camera_out(cam, zone_name=zname, area_name=aname)

    async def update_camera(
        self,
        user: User,
        property_uid: str,
        camera_uid: str,
        payload: CameraUpdateRequest,
    ) -> dict:
        prop = await self._property(user, property_uid)
        cam = await self._camera(prop, camera_uid)
        data = payload.model_dump(exclude_unset=True)
        stream_changed = False
        zname = cam.zone.name if cam.zone else None
        aname = cam.area.name if cam.area else None
        if "zone_uid" in data or "area_uid" in data:
            cam.zone_id, cam.area_id, zname, aname = await self._assign_target(
                prop, data.get("zone_uid"), data.get("area_uid")
            )
            self.audit.record(
                user,
                entity_type="camera",
                entity_id=cam.id,
                entity_name=cam.name,
                action="move_structure",
                property_id=prop.id,
                detail={
                    "zone_uid": data.get("zone_uid"),
                    "area_uid": data.get("area_uid"),
                },
            )
        if "rtsp_url" in data and data["rtsp_url"] is not None:
            cam.rtsp_url = data["rtsp_url"]
            stream_changed = True
        if "sub_rtsp_url" in data:
            cam.sub_rtsp_url = data["sub_rtsp_url"]  # None clears the substream
            stream_changed = True
        if "transcode" in data:
            cam.transcode = data["transcode"]  # None → global default
            stream_changed = True
        if data.get("warm") is not None:
            if data["warm"] and not cam.warm:
                await self._check_warm_cap(prop)
            cam.warm = data["warm"]
            stream_changed = True
        for f_ in (
            "name",
            "description",
            "location",
            "username",
            "transport",
            "resolution",
            "is_enabled",
        ):
            if f_ in data and data[f_] is not None:
                setattr(cam, f_, data[f_])
        if "fps" in data:
            cam.fps = data["fps"]
        if data.get("password"):
            cam.password = encrypt_secret(data["password"])
            stream_changed = True
        if "transport" in data or "username" in data:
            stream_changed = True
        if stream_changed and _media_ready() and cam.is_enabled:
            try:
                await _register_media(cam)
                _reg_fp[cam.id] = _registration_fingerprint(cam)
            except Exception:
                pass
        self.audit.record(
            user,
            entity_type="camera",
            entity_id=cam.id,
            entity_name=cam.name,
            action="update",
            property_id=prop.id,
        )
        await self.session.commit()
        await self.session.refresh(cam)
        return camera_out(cam, zone_name=zname, area_name=aname)

    async def delete_camera(self, user: User, property_uid: str, camera_uid: str) -> None:
        prop = await self._property(user, property_uid)
        cam = await self._camera(prop, camera_uid)
        cam.deleted_at = datetime.now(UTC)
        cam.is_enabled = False
        await self.session.execute(
            update(CameraStreamSession)
            .where(
                CameraStreamSession.camera_id == cam.id,
                CameraStreamSession.status == "active",
            )
            .values(status="ended", ended_at=func.now())
        )
        invalidate_registration(cam.id)
        if _media_ready():
            try:
                await go2rtc.remove_stream(cam.id)
                await mediamtx.remove_path(cam.id)
            except Exception:
                pass
        self.audit.record(
            user,
            entity_type="camera",
            entity_id=cam.id,
            entity_name=cam.name,
            action="delete",
            property_id=prop.id,
        )
        await self.session.commit()

    async def bulk_move(
        self,
        user: User,
        property_uid: str,
        camera_uids: list[str],
        zone_uid: str | None,
        area_uid: str | None,
    ) -> dict:
        prop = await self._property(user, property_uid)
        zone_id, area_id, _, _ = await self._assign_target(prop, zone_uid, area_uid)
        ids = []
        for raw in camera_uids:
            try:
                ids.append(uuid.UUID(raw))
            except ValueError:
                raise BadRequest("Invalid camera id.")
        res = await self.session.execute(
            select(Camera).where(
                Camera.id.in_(ids),
                Camera.property_id == prop.id,
                Camera.deleted_at.is_(None),
            )
        )
        cams = res.scalars().all()
        if len(cams) != len(ids):
            raise NotFound("One or more cameras were not found.")
        for c in cams:
            c.zone_id, c.area_id = zone_id, area_id
        self.audit.record(
            user,
            entity_type="camera",
            entity_id=None,
            entity_name=None,
            action="bulk_move_structure",
            property_id=prop.id,
            detail={
                "camera_count": len(cams),
                "zone_uid": zone_uid,
                "area_uid": area_uid,
            },
        )
        await self.session.commit()
        return {
            "moved": len(cams),
            "zone_uid": zone_uid,
            "area_uid": area_uid,
        }

    # ------------------------------------------------------ test connection
    async def test_connection(self, user: User, property_uid: str, camera_uid: str) -> dict:
        """Best-effort connectivity probe — TCP reachability of host:port plus
        the go2rtc stream's producer state when the media server is live. Never
        marks a camera online just because its config saved."""
        prop = await self._property(user, property_uid)
        cam = await self._camera(prop, camera_uid)
        parts = urlsplit(cam.rtsp_url)
        host, port = parts.hostname, parts.port or 554
        reachable = None
        try:
            conn = asyncio.open_connection(host, port)
            _, w = await asyncio.wait_for(conn, timeout=settings.VA_CONNECT_TEST_TIMEOUT_SECONDS)
            w.close()
            try:
                await w.wait_closed()
            except (AttributeError, OSError):
                pass
            reachable = True
        except (OSError, TimeoutError, socket.gaierror):
            reachable = False

        ingest = await go2rtc.producer_ready(cam.id)
        ready = await mediamtx.path_ready(cam.id)
        if reachable is True:
            cam.connection_status = (
                "online" if ready is True else "unknown"
            )
        elif reachable is False:
            cam.connection_status = "offline"
        cam.last_checked_at = datetime.now(UTC)
        await self.session.commit()
        return {
            "camera_uid": str(cam.id),
            "tcp_reachable": reachable,
            "ingest_ready": ingest,
            "media_server_ready": ready,
            "connection_status": cam.connection_status,
            "last_checked_at": cam.last_checked_at.isoformat(),
        }

    # ------------------------------------------------------ stream sessions
    async def _stream_counts(
        self, user_id: uuid.UUID, camera_id: uuid.UUID, property_id: uuid.UUID
    ) -> dict:
        """All three concurrency counts in ONE round trip — subquery
        scalars in a single SELECT (each remote query costs ~300ms)."""
        res = await self.session.execute(
            select(
                select(func.count(CameraStreamSession.id))
                .where(
                    CameraStreamSession.user_id == user_id,
                    CameraStreamSession.status == "active",
                )
                .scalar_subquery()
                .label("user"),
                select(func.count(CameraStreamSession.id))
                .where(
                    CameraStreamSession.camera_id == camera_id,
                    CameraStreamSession.status == "active",
                )
                .scalar_subquery()
                .label("viewers"),
                select(func.count(CameraStreamSession.id))
                .where(
                    CameraStreamSession.property_id == property_id,
                    CameraStreamSession.status == "active",
                )
                .scalar_subquery()
                .label("property"),
            )
        )
        r = res.one()
        return {"user": r[0] or 0, "viewers": r[1] or 0, "property": r[2] or 0}

    async def _sweep_idle_due(self) -> None:
        """Amortized idle sweep — at most once per VA_SESSION_SWEEP_INTERVAL_SECONDS
        process-wide instead of on every session request."""
        global _last_sweep
        now = time.monotonic()
        if now - _last_sweep < settings.VA_SESSION_SWEEP_INTERVAL_SECONDS:
            return
        _last_sweep = now
        await self._sweep_idle()

    async def create_session(
        self, user: User, property_uid: str, camera_uid: str, protocol: str,
        quality: str = "main",
    ) -> dict:
        """Authorize + lease a viewer session. The hot path is a single
        SELECT (camera + property scope + reusable session in one query)
        plus zero media-server calls (fingerprinted registration cache).

        409 is reserved for genuine conflicts: a disabled camera and the
        configured concurrency ceilings — never for "another viewer is
        already watching", which simply shares the upstream source."""
        t0 = time.monotonic()
        try:
            pid = uuid.UUID(property_uid)
            cid = uuid.UUID(camera_uid)
        except ValueError:
            raise NotFound("Camera not found.")
        # Same (user, camera, quality) requests serialize so remounts and
        # double-clicks can't mint duplicate sessions; different cameras
        # proceed fully in parallel.
        key = (user.id, cid, quality)
        lock = _session_locks.setdefault(key, asyncio.Lock())
        async with lock:
            # Sweep BEFORE the join — the bulk UPDATE expires ORM state
            # and must not end sessions the SELECT is about to load.
            await self._sweep_idle_due()
            # Effective quality in SQL: 'sub' only when the camera
            # actually has a substream, else graceful 'main' fallback —
            # needed up-front so the session join matches.
            eff_quality = (
                case(
                    (Camera.sub_rtsp_url.isnot(None), literal("sub")),
                    else_=literal("main"),
                )
                if quality == "sub"
                else literal("main")
            )
            # ONE round trip: camera row + property scope + the active
            # session to reuse (outerjoin).
            res = await self.session.execute(
                select(Camera, CameraStreamSession, Property.company_id)
                .join(Property, Property.id == Camera.property_id)
                .outerjoin(
                    CameraStreamSession,
                    and_(
                        CameraStreamSession.camera_id == Camera.id,
                        CameraStreamSession.user_id == user.id,
                        CameraStreamSession.status == "active",
                        CameraStreamSession.quality == eff_quality,
                    ),
                )
                .where(
                    Camera.id == cid,
                    Camera.property_id == pid,
                    Camera.deleted_at.is_(None),
                )
            )
            row = res.first()
            cam, sess, company_id = (
                (row[0], row[1], row[2]) if row else (None, None, None)
            )
            scope_ok = (
                (user.role == UserRole.SUPER_ADMIN and company_id == user.company_id)
                or (user.role != UserRole.SUPER_ADMIN and user.property_id == pid)
            )
            if cam is None or not scope_ok:
                raise NotFound("Camera not found.")
            if not cam.is_enabled:
                raise Conflict("Camera is disabled.", code="CAMERA_DISABLED")
            if not _media_ready():
                raise ServiceUnavailable()
            sub = quality == "sub" and bool(cam.sub_rtsp_url)
            reused = sess is not None
            if sess is None:
                counts = await self._stream_counts(user.id, cam.id, pid)
                if counts["user"] >= settings.VA_MAX_STREAMS_PER_USER:
                    raise Conflict(
                        f"Stream limit reached ({settings.VA_MAX_STREAMS_PER_USER}).",
                        code="STREAM_LIMIT",
                    )
                if counts["viewers"] >= settings.VA_MAX_VIEWERS_PER_CAMERA:
                    raise Conflict(
                        f"Viewer limit reached for this camera ({settings.VA_MAX_VIEWERS_PER_CAMERA}).",
                        code="VIEWER_LIMIT",
                    )
                if counts["property"] >= settings.VA_MAX_STREAMS_PER_PROPERTY:
                    raise Conflict(
                        f"Property stream limit reached ({settings.VA_MAX_STREAMS_PER_PROPERTY}).",
                        code="PROPERTY_STREAM_LIMIT",
                    )
                sess = CameraStreamSession(
                    camera_id=cam.id,
                    user_id=user.id,
                    property_id=pid,
                    protocol=protocol,
                    quality="sub" if sub else "main",
                )
                self.session.add(sess)
                await self.session.commit()
            else:
                # Touch activity only when stale — keeps the warm
                # path at a single SELECT, zero writes.
                now = datetime.now(UTC)
                if (now - sess.last_activity_at).total_seconds() > (
                    settings.VA_SESSION_ACTIVITY_TOUCH_SECONDS
                ):
                    sess.last_activity_at = now
                    await self.session.commit()

        # Media work happens AFTER the DB transaction commits — no open
        # transaction is held across media-server communication.
        try:
            await _ensure_media_registered(cam)
        except Exception as exc:
            raise ServiceUnavailable(
                f"Media server rejected the stream registration: {exc}"
            )
        token, exp = mediamtx.mint_stream_token(cam.id, sub=sub)
        urls = mediamtx.playback_urls(cam.id, token, sub=sub)
        ms = round((time.monotonic() - t0) * 1000, 1)
        logger.info(
            "va.session_create camera=%s quality=%s reused=%s server_ms=%s",
            cid, "sub" if sub else "main", reused, ms,
        )
        out = session_out(sess)
        out.update(
            {
                "camera_name": cam.name,
                "quality": "sub" if sub else "main",
                "expires_at": exp.isoformat(),
                "reused": reused,
                "warm": _warm(cam),
                "server_ms": ms,
                **urls,
            }
        )
        return out

    async def end_session(self, user: User, session_uid: str) -> None:
        try:
            sid = uuid.UUID(session_uid)
        except ValueError:
            raise NotFound("Session not found.")
        res = await self.session.execute(
            select(CameraStreamSession).where(CameraStreamSession.id == sid)
        )
        sess = res.scalar_one_or_none()
        if sess is None or (sess.user_id != user.id and user.role != UserRole.SUPER_ADMIN):
            raise NotFound("Session not found.")
        if sess.status == "active":
            sess.status = "ended"
            sess.ended_at = datetime.now(UTC)
            await self.session.commit()

    async def get_session(self, user: User, session_uid: str) -> dict:
        try:
            sid = uuid.UUID(session_uid)
        except ValueError:
            raise NotFound("Session not found.")
        res = await self.session.execute(
            select(CameraStreamSession).where(CameraStreamSession.id == sid)
        )
        sess = res.scalar_one_or_none()
        if sess is None or (sess.user_id != user.id and user.role != UserRole.SUPER_ADMIN):
            raise NotFound("Session not found.")
        if sess.status == "active":
            sess.last_activity_at = datetime.now(UTC)
            await self.session.commit()
        return session_out(sess)

    async def _sweep_idle(self) -> None:
        """End active sessions idle past VA_STREAM_SESSION_IDLE_SECONDS —
        the playback loop must touch the session to stay alive."""
        cutoff = datetime.now(UTC).timestamp() - (settings.VA_STREAM_SESSION_IDLE_SECONDS)
        await self.session.execute(
            update(CameraStreamSession)
            .where(
                CameraStreamSession.status == "active",
                CameraStreamSession.last_activity_at < datetime.fromtimestamp(cutoff, tz=UTC),
            )
            .values(status="ended", ended_at=func.now())
        )
