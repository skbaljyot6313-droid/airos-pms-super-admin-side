"""go2rtc control-plane client — camera ingestion layer.

Role in the pipeline: go2rtc connects to each camera's RTSP source
(including authenticated and quirk-prone cameras), keeps the connection
alive, and republishes it as an internal RTSP stream at
`rtsp://<go2rtc>:8554/cam_<id>` that MediaMTX pulls for distribution.
Camera credentials never leave the server side.

A registered stream pulls its RTSP source **lazily, only while a consumer
(in our case MediaMTX) is attached** — so registering streams starts no
background work, and N viewers of one camera still cost exactly one
upstream connection (verified: go2rtc fans out a single producer to all
consumers).

Stream naming (`cam_<uuid-hex>` — opaque, no credentials):
  cam_<id>      raw primary ingest (camera codec passthrough)
  cam_<id>_rtc  lazy ffmpeg H264+Opus transcode of the primary — ONLY
                registered when the camera opts in (Camera.transcode or
                the VA_TRANSCODE_ENABLED default). Transcoding is the
                exception: H264 cameras serve pure passthrough.
  cam_<id>_sub  raw secondary/substream ingest (when the camera has a
                sub_rtsp_url — used for low-bitrate grid viewing)
  cam_<id>_sub_rtc  transcode of the substream (same rule)

Transport override uses go2rtc's `#transport=tcp|udp` URL fragment.
"""


import asyncio

import httpx

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

_TIMEOUT = httpx.Timeout(5.0)


def _client() -> httpx.AsyncClient:
    auth = None
    if settings.GO2RTC_API_AUTH and ":" in settings.GO2RTC_API_AUTH:
        auth = tuple(settings.GO2RTC_API_AUTH.split(":", 1))
    return httpx.AsyncClient(
        base_url=settings.GO2RTC_API_URL, timeout=_TIMEOUT, auth=auth
    )


def stream_name(camera_id, sub: bool = False) -> str:
    """Deterministic opaque stream id — `cam_<uuid hex>` (no hyphens)."""
    base = f"cam_{getattr(camera_id, 'hex', camera_id)}"
    return f"{base}_sub" if sub else base


def _transcoded_name(name: str) -> str:
    return f"{name}_rtc"


def distribution_name(camera_id, sub: bool, transcode: bool) -> str:
    """The go2rtc stream MediaMTX pulls for a given quality — the transcode
    variant when the camera requires it, else the raw ingest."""
    name = stream_name(camera_id, sub=sub)
    return _transcoded_name(name) if transcode else name


def available() -> bool:
    return bool(settings.GO2RTC_API_URL)


def restream_url(camera_id, sub: bool, transcode: bool) -> str:
    """The internal RTSP URL MediaMTX pulls — reachable from the MediaMTX
    container, so GO2RTC_RTSP_URL must use the docker service name in
    containerised deployments."""
    base = (settings.GO2RTC_RTSP_URL or "").rstrip("/")
    return f"{base}/{distribution_name(camera_id, sub, transcode)}"


def _source_url(rtsp_url: str, transport: str) -> str:
    return f"{rtsp_url}#transport={'udp' if transport == 'udp' else 'tcp'}"


async def _put(c: httpx.AsyncClient, name: str, src: str) -> None:
    """go2rtc's streams API takes the SOURCE in `src=` and the stream name
    in `name=` — PUT replaces all sources for the named stream."""
    r = await c.put("/api/streams", params=[("src", src), ("name", name)])
    r.raise_for_status()


async def ensure_stream(
    camera_id, rtsp_url: str, transport: str, transcode: bool, sub_rtsp_url: str | None = None
) -> None:
    """Register (or replace) the camera's ingest streams so go2rtc pulls
    them on demand. Registers the primary (and its optional transcode
    variant), plus the substream pair when the camera has one. When
    `transcode` is off the raw restream goes to MediaMTX untouched —
    passthrough, zero ffmpeg. PUTs are issued concurrently — each is an
    independent stream entry and go2rtc does not probe on write."""
    name = stream_name(camera_id)
    writes: list[tuple[str, str]] = [(name, _source_url(rtsp_url, transport))]
    if transcode:
        writes.append((_transcoded_name(name), f"ffmpeg:{name}#video=h264#audio=opus"))
    if sub_rtsp_url:
        sub_name = stream_name(camera_id, sub=True)
        writes.append((sub_name, _source_url(sub_rtsp_url, transport)))
        if transcode:
            writes.append((_transcoded_name(sub_name), f"ffmpeg:{sub_name}#video=h264#audio=opus"))
    async with _client() as c:
        await asyncio.gather(*(_put(c, n, s) for n, s in writes))


async def stream_index() -> set[str] | None:
    """Registered stream names — one cheap GET used to verify the
    registration cache after media-server restarts. None when unreachable."""
    if not available():
        return None
    try:
        async with _client() as c:
            r = await c.get("/api/streams")
            r.raise_for_status()
            return set((r.json() or {}).keys())
    except httpx.HTTPError:
        return None


async def remove_stream(camera_id) -> None:
    """Drop every stream the camera may own (primary/sub × raw/rtc).
    go2rtc's DELETE takes the stream NAME in `src=` — verified live."""
    async with _client() as c:
        for sub in (False, True):
            name = stream_name(camera_id, sub=sub)
            await c.delete("/api/streams", params={"src": name})
            await c.delete("/api/streams", params={"src": _transcoded_name(name)})


async def producer_ready(camera_id, sub: bool = False) -> bool | None:
    """True while go2rtc holds an active producer for the stream.
    None when go2rtc is unreachable or the stream isn't registered."""
    if not available():
        return None
    name = stream_name(camera_id, sub=sub)
    try:
        async with _client() as c:
            r = await c.get("/api/streams")
            r.raise_for_status()
            entry = (r.json() or {}).get(name)
            if entry is None:
                return False
            return bool(entry.get("producers"))
    except httpx.HTTPError as exc:
        logger.warning("go2rtc.stream_status_failed stream=%s error=%s", name, exc)
        return None


async def stats() -> dict | None:
    """Lightweight go2rtc stats for the VA dashboard — per-stream producer
    and consumer counts plus received bytes. None when unreachable."""
    if not available():
        return None
    try:
        async with _client() as c:
            r = await c.get("/api/streams")
            r.raise_for_status()
            streams = r.json() or {}
            producers = consumers = 0
            for entry in streams.values():
                # An idle producer is just {"url": ...} — a live pull carries
                # negotiated `medias`/`receivers` and a remote address.
                producers += sum(
                    1 for p in (entry.get("producers") or []) if p.get("medias")
                )
                consumers += len(entry.get("consumers") or [])
            return {
                "streams": len(streams),
                "active_producers": producers,
                "active_consumers": consumers,
            }
    except httpx.HTTPError as exc:
        logger.warning("go2rtc.stats_failed error=%s", exc)
        return None


async def ping() -> bool:
    """go2rtc API reachability — for the media-health diagnostic endpoint."""
    if not available():
        return False
    try:
        async with _client() as c:
            r = await c.get("/api")
            return r.status_code == 200
    except httpx.HTTPError:
        return False
