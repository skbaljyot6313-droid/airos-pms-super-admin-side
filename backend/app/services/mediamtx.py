"""MediaMTX control-plane + WHEP client — media distribution layer.

Role in the pipeline: MediaMTX pulls go2rtc's per-camera RTSP restreams
(`rtsp://<go2rtc>:8554/<stream>`) into `cam_<id>`/`cam_<id>_sub` paths and
serves them to browsers over WebRTC (WHEP at :8889) and HLS (:8888).
`sourceOnDemand` keeps pulls lazy and `sourceOnDemandCloseAfter` keeps the
upstream alive briefly after the last viewer leaves — so one viewer
closing their tab doesn't bounce the camera connection while others (or a
returning viewer) still need it. go2rtc in turn only dials the camera
while MediaMTX has a reader: the whole chain is demand-driven end to end.

Browser WebRTC never talks to MediaMTX directly: it POSTs its SDP offer to
`POST /va/webrtc` with a short-lived path-scoped token in the Authorization
header; the backend forwards the offer here (`whep_answer`) and returns the
SDP answer. WHEP session resources are torn down via `whep_close`.
"""

import asyncio
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

import httpx
import jwt

from app.core.config import settings
from app.core.logging import get_logger
from app.services import go2rtc

logger = get_logger(__name__)

_TIMEOUT = httpx.Timeout(8.0)


def _client(base: str) -> httpx.AsyncClient:
    auth = None
    if settings.MEDIAMTX_API_AUTH and ":" in settings.MEDIAMTX_API_AUTH:
        auth = tuple(settings.MEDIAMTX_API_AUTH.split(":", 1))
    return httpx.AsyncClient(base_url=base, timeout=_TIMEOUT, auth=auth)


def path_name(camera_id, sub: bool = False) -> str:
    """MediaMTX path mirrors the logical stream id — `cam_<id>` or
    `cam_<id>_sub`. Its SOURCE is go2rtc's distribution stream for the
    camera (raw or `_rtc` transcode variant)."""
    return go2rtc.stream_name(camera_id, sub=sub)


def available() -> bool:
    return bool(
        settings.MEDIAMTX_API_URL
        and settings.MEDIAMTX_SIGNAL_URL
        and settings.MEDIAMTX_PUBLIC_URL
        and settings.GO2RTC_RTSP_URL
    )


def warm_path_name(camera_id, sub: bool = False) -> str:
    """Keepalive path for warm transcode cameras — constantly pulls the RAW
    go2rtc restream so the camera dial + go2rtc producer stay hot without
    keeping an ffmpeg transcode running."""
    return f"{path_name(camera_id, sub)}_warm"


def _path_body(source: str, on_demand: bool = True) -> dict:
    body = {
        "source": source,
        "sourceOnDemand": on_demand,
    }
    if on_demand:
        # Keep the upstream pull briefly alive after the last reader leaves —
        # protects cameras from reconnect churn when viewers switch layouts
        # or briefly drop, without pinning upstreams forever.
        body["sourceOnDemandCloseAfter"] = f"{settings.VA_SOURCE_IDLE_SECONDS}s"
    return body


async def _upsert_path(c: httpx.AsyncClient, name: str, body: dict) -> None:
    r = await c.post(f"/v3/config/paths/add/{quote(name)}", json=body)
    if r.status_code == 400 and "already exists" in r.text:
        r = await c.patch(f"/v3/config/paths/patch/{quote(name)}", json=body)
    r.raise_for_status()


async def ensure_path(camera_id, sub: bool, transcode: bool, warm: bool = False) -> None:
    """Register (or re-register) the camera path pulling the go2rtc restream.
    Upsert semantics: PATCH the existing path when present, else POST.

    Warm cameras: passthrough cameras flip their serving path to a
    permanent pull — first-frame never waits on a cold source. Transcode
    cameras keep the serving path on-demand (a permanent pull would pin
    ffmpeg forever) and get a `_warm` keepalive path that pulls the raw
    restream — camera dial and go2rtc producer stay hot, ffmpeg still
    spins up only while watched."""
    name = path_name(camera_id, sub)
    serving_warm = warm and not transcode
    keepalive = warm and transcode
    async with _client(settings.MEDIAMTX_API_URL) as c:
        tasks = [
            _upsert_path(
                c,
                name,
                _path_body(go2rtc.restream_url(camera_id, sub, transcode), on_demand=not serving_warm),
            )
        ]
        if keepalive:
            tasks.append(
                _upsert_path(
                    c,
                    warm_path_name(camera_id, sub),
                    _path_body(go2rtc.restream_url(camera_id, sub, False), on_demand=False),
                )
            )
        else:
            tasks.append(
                _delete_path(c, warm_path_name(camera_id, sub), ignore_errors=True)
            )
        await asyncio.gather(*tasks)


async def _delete_path(c: httpx.AsyncClient, name: str, ignore_errors: bool = False) -> None:
    try:
        await c.delete(f"/v3/config/paths/delete/{quote(name)}")
    except httpx.HTTPError:
        if not ignore_errors:
            raise


async def remove_path(camera_id, sub: bool | None = None) -> None:
    """Remove the camera's path(s), including warm keepalive paths.
    sub=None removes both primary and sub."""
    subs = (False, True) if sub is None else (sub,)
    async with _client(settings.MEDIAMTX_API_URL) as c:
        for s in subs:
            await c.delete(f"/v3/config/paths/delete/{quote(path_name(camera_id, sub=s))}")
            await c.delete(f"/v3/config/paths/delete/{quote(warm_path_name(camera_id, sub=s))}")


async def path_index() -> set[str] | None:
    """Registered path names — one cheap GET used to verify the
    registration cache after media-server restarts. None when unreachable."""
    if not settings.MEDIAMTX_API_URL:
        return None
    try:
        async with _client(settings.MEDIAMTX_API_URL) as c:
            r = await c.get("/v3/paths/list")
            if r.status_code != 200:
                return None
            items = (r.json() or {}).get("items") or []
            return {i.get("name") for i in items if i.get("name")}
    except httpx.HTTPError:
        return None


async def path_ready(camera_id, sub: bool = False) -> bool | None:
    """True while MediaMTX has an active source for the path.
    None when unreachable or the path isn't registered."""
    if not settings.MEDIAMTX_API_URL:
        return None
    name = path_name(camera_id, sub)
    try:
        async with _client(settings.MEDIAMTX_API_URL) as c:
            r = await c.get(f"/v3/paths/get/{quote(name)}")
            if r.status_code != 200:
                return False
            return bool(r.json().get("ready"))
    except httpx.HTTPError as exc:
        logger.warning("mediamtx.path_status_failed path=%s error=%s", name, exc)
        return None


async def ping() -> bool:
    """MediaMTX control API reachability — for the media-health endpoint."""
    if not settings.MEDIAMTX_API_URL:
        return False
    try:
        async with _client(settings.MEDIAMTX_API_URL) as c:
            r = await c.get("/v3/paths/list")
            return r.status_code == 200
    except httpx.HTTPError:
        return False


async def stats() -> dict | None:
    """Live MediaMTX counts for the VA dashboard: registered paths, ready
    paths, readers, WebRTC sessions, HLS muxers, RTSP sessions."""
    if not settings.MEDIAMTX_API_URL:
        return None
    out: dict = {}
    try:
        async with _client(settings.MEDIAMTX_API_URL) as c:
            r = await c.get("/v3/paths/list")
            items = (r.json() or {}).get("items") or []
            out["paths"] = len(items)
            out["paths_ready"] = sum(1 for i in items if i.get("ready"))
            out["readers"] = sum(len(i.get("readers") or []) for i in items)
            out["bytes_received"] = sum(i.get("bytesReceived") or 0 for i in items)
            out["bytes_sent"] = sum(i.get("bytesSent") or 0 for i in items)
            for key, ep in (
                ("webrtc_sessions", "/v3/webrtcsessions/list"),
                ("hls_muxers", "/v3/hlsmuxers/list"),
                ("rtsp_sessions", "/v3/rtspsessions/list"),
            ):
                rr = await c.get(ep)
                out[key] = (rr.json() or {}).get("itemCount", 0) if rr.status_code == 200 else None
            return out
    except httpx.HTTPError as exc:
        logger.warning("mediamtx.stats_failed error=%s", exc)
        return None


class WhepUpstreamError(Exception):
    """MediaMTX rejected the SDP exchange — carries status + body so the
    proxy can log the real reason instead of a bare 502."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(f"whep upstream {status_code}: {detail[:200]}")
        self.status_code = status_code
        self.detail = detail


async def whep_answer(path: str, offer_sdp: str) -> tuple[str, str | None]:
    """Forward a browser SDP offer to MediaMTX WHEP for `path`
    (`cam_<id>` / `cam_<id>_sub`).

    Returns (answer_sdp, session_location). The session_location is the
    WHEP resource URL MediaMTX assigns — pass it to `whep_close` on
    teardown. Raises WhepUpstreamError on non-2xx upstream responses."""
    base = settings.MEDIAMTX_SIGNAL_URL.rstrip("/")
    async with _client(base) as c:
        r = await c.post(
            f"/{quote(path)}/whep",
            content=offer_sdp.encode(),
            headers={"Content-Type": "application/sdp"},
        )
        if r.status_code >= 400:
            raise WhepUpstreamError(r.status_code, r.text[:300])
        return r.text, r.headers.get("Location")


async def whep_close(session_location: str) -> None:
    """Best-effort WHEP session teardown — MediaMTX frees the reader."""
    if not session_location:
        return
    loc = session_location.lstrip("/")
    base = settings.MEDIAMTX_SIGNAL_URL.rstrip("/")
    try:
        async with _client(base) as c:
            await c.delete(f"/{loc}")
    except httpx.HTTPError:
        pass


def _secret() -> str:
    return settings.VA_STREAM_TOKEN_SECRET or settings.MEDIA_MTX_JWT_SECRET or "dev-only-insecure"


def mint_stream_token(camera_id, sub: bool = False) -> tuple[str, datetime]:
    """Short-lived read-only JWT scoped to one camera stream path."""
    exp = datetime.now(UTC) + timedelta(seconds=settings.VA_STREAM_TOKEN_TTL_SECONDS)
    token = jwt.encode(
        {
            "exp": exp,
            "iat": datetime.now(UTC),
            "stream_permissions": [{"action": "read", "path": path_name(camera_id, sub)}],
        },
        _secret(),
        algorithm="HS256",
    )
    return token, exp


def stream_path_for_token(token: str) -> str | None:
    """Decode a playback token and return the stream path it authorizes."""
    try:
        claims = jwt.decode(token, _secret(), algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    for p in claims.get("stream_permissions", []):
        if p.get("action") == "read" and p.get("path"):
            return p["path"]
    return None


def playback_urls(camera_id, token: str, sub: bool = False) -> dict[str, str]:
    """Browser-facing playback info for one authorized reader.

    webrtc_url is backend-relative — the browser POSTs its SDP offer to
    `POST /va/webrtc` with the token in `Authorization: Bearer` (kept out
    of URLs/logs). HLS is direct to MediaMTX — media fetches can't carry
    headers, so it stays a token-query URL (documented compromise).
    `stream_token` is returned once, in the JSON body.
    """
    base = (settings.MEDIAMTX_PUBLIC_URL or "").rstrip("/")
    name = quote(path_name(camera_id, sub))
    return {
        "webrtc_url": "/api/v1/va/webrtc",
        "hls_url": f"{base}/{name}/index.m3u8?token={quote(token)}",
        "stream_token": token,
    }
