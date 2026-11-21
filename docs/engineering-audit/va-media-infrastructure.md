# AiROS VA — Media Infrastructure Audit & Redesign

## Root cause: "Stream limit reached" (HTTP 409)

Confirmed by reproduction (16 parallel stream-session POSTs → 7× 409, log
`db_queries=6`, `duration_ms` up to 15s). **Two compounding causes:**

1. **`VA_MAX_STREAMS_PER_USER=8`** — a 9- or 16-tile grid legitimately
   exceeds it. Genuine cap, not a leak — but sized for single-feed use.
   Sessions also counted *viewer leases*, so a user watching 16 cameras
   consumed 16 of 8 slots.
2. **9–16s latency = WAN DB serialization, not media stack.** Each
   `create_session` ran ~8 sequential queries (property authz → camera →
   idle sweep UPDATE → 3 COUNTs → reuse SELECT → insert → commit) against
   the Supabase pooler (~300ms RTT) through a 10-conn pool. 16 parallel
   requests × ~8 RTTs → ~15s tail. Media calls were **10ms** (go2rtc PUT)
   and **7ms** (MediaMTX) — never the bottleneck. Additionally the WHEP
   proxy cold-pulled streams: `duration_ms=3812` observed on `/va/webrtc`
   while MediaMTX waited for go2rtc to dial the camera.

Not the cause: MediaMTX limits, go2rtc limits, NVR connection limits,
leaked WHEP sessions (verified none — reader counts match viewers).

## Problems found in existing architecture

- Session endpoint held DB work + media calls in one sequential path.
- No idempotency: N parallel requests → N duplicate sessions.
- `sourceOnDemand` + `sourceOnDemandCloseAfter=15s` → cold RTSP dial +
  ffmpeg spin-up on every tile open.
- `pc.ontrack` wrote `videoRef.current!.srcObject` — null after unmount.
- Dev media stack: `latest` images, open control APIs, no health checks,
  no metrics, no resource limits.
- Default transcode → ~40% CPU/camera in ffmpeg.

## Resolution implemented

**Session path** — single combined SELECT (camera+scope+reuse join), one
collapsed counts query only when inserting, amortized idle sweep,
keyed asyncio locks per (user,camera,quality), media calls after commit,
fingerprinted registration cache + 15s stale-index self-heal. 409 only for
real limits with structured `code` (`STREAM_LIMIT`/`VIEWER_LIMIT`/
`PROPERTY_STREAM_LIMIT`/`CAMERA_DISABLED`/`WARM_LIMIT`). Limits raised to
console scale: 32 user / 16 per-camera / 128 property.

**Warm cameras** — `cameras.warm` + `_warm` MediaMTX keepalive paths that
pull the raw go2rtc restream (camera dial hot, ffmpeg unpinned), bounded
by `VA_WARM_MAX_STREAMS=16`, restored at boot via `warm_start()`.
Verified: `_warm` paths ready with real bytes flowing.

**Frontend** — generation-guarded player (pending MediaStream until
element exists → null-srcObject impossible), AbortController on WHEP
POST, `keepalive` teardown, first-frame via `loadeddata`+`rVFC`,
per-stage `onStage` timings, 8-way session limiter, 60s heartbeat,
15s no-frame watchdog.

**Dedicated media server** — `infrastructure/media-server/`:
pinned `alexxit/go2rtc:1.9.15` + `bluenviron/mediamtx:1.21.4-ffmpeg`,
authenticated control APIs (`GO2RTC_API_AUTH`/`MEDIAMTX_API_AUTH`),
loopback-bound control/metrics ports, ICE `additionalHosts` from env,
RTMP/SRT disabled, healthcheck sidecar, resource limits, Prometheus
profile (MediaMTX `:9998/metrics` + backend `/va/media-stats`),
persistent stream/path config, rollback = repoint backend env.

## Measured results

| Metric | Before | After |
|---|---|---|
| 16 parallel sessions | 15.06s, 7×409 | **1.56s, 0 errors** |
| Session reuse (warm path) | ~2s | **47–98ms** |
| 8 parallel same-cam | dup sessions | 1 session, all 200 |
| 4-cam WHEP proxy | worked | ICE completed ×4, 0 loss |
| go2rtc restart recovery | — | all sessions 200 in <1s |
| 10× open/close cycles | — | no leaked sessions |
| 4 transcoded cams | 164% CPU | **35–41%** (substream) |

## Not yet executed (honest gaps)

- 9-cam and browser-driven 16-cam grids (API-level 16 verified).
- Tab-visibility/refresh behavior (heartbeat + keepalive-DELETE cover it;
  not browser-observed).
- TURN fallback (documented; not deployed — needed only for strict NATs).
- Per-camera media-cluster column (roadmap for multi-site).
