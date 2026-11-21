# AiROS VA media pipeline — go2rtc + MediaMTX

```
IP camera ──RTSP──▶ go2rtc ──RTSP restream──▶ MediaMTX ──WHEP/HLS──▶ browser
                 :1984 api     :8554          :9997 api  :8889 WHEP
                                              :8888 HLS  :8189/udp ICE
```

## Responsibilities

| Tier | Does | Does not |
|---|---|---|
| **go2rtc** | RTSP dial/auth/quirks, reconnects, lazy pull, per-camera `cam_<id>` restream on :8554, optional ffmpeg transcode (`VA_TRANSCODE_ENABLED`) | Browser playback |
| **MediaMTX** | Pulls each restream into a `cam_<id>` path (`sourceOnDemand` — lazy), WHEP distribution, HLS fallback, multi-viewer fan-out | Camera auth |
| **Backend** | Registers both tiers, mints path-scoped stream JWTs, proxies the WHEP SDP exchange (`POST /va/webrtc`), enforces RBAC | Decodes/transcodes media |
| **Browser** | WHEP via backend proxy (token in `Authorization`), HLS direct, RTCPeerConnection lifecycle | Sees RTSP URLs/creds |

Demand chains end-to-end: reader detaches → MediaMTX drops the go2rtc pull
→ go2rtc drops the camera dial.

## Backend env

| Var | Dev value | Notes |
|---|---|---|
| `GO2RTC_API_URL` | `http://localhost:1984` | control — backend only |
| `GO2RTC_RTSP_URL` | `rtsp://go2rtc:8554` | **resolved by MediaMTX** — use docker DNS inside containers, never `localhost` |
| `MEDIAMTX_API_URL` | `http://localhost:9997` | control — backend only |
| `MEDIAMTX_SIGNAL_URL` | `http://localhost:8889` | where the backend POSTs browser SDP |
| `MEDIAMTX_PUBLIC_URL` | `http://localhost:8888` | browser-facing HLS base — HTTPS in prod |
| `VA_STREAM_TOKEN_SECRET` | random | HS256 playback tokens |
| `VA_TRANSCODE_ENABLED` | `false` | **default** only — `Camera.transcode` (null/true/false) overrides per camera. When off for a camera, its restream is pure passthrough — no ffmpeg at all. Needed only for browser-incompatible codecs (H265). |
| `VA_MAX_STREAMS_PER_USER` | `32` | concurrent active sessions per staff user — must exceed the largest VMS grid (4×4 = 16) |
| `VA_MAX_STREAMS_PER_PROPERTY` | `128` | concurrent active sessions per property |
| `VA_MAX_VIEWERS_PER_CAMERA` | `16` | concurrent viewers per camera (upstream is shared — this caps API sessions, not camera connections) |
| `VA_SOURCE_IDLE_SECONDS` | `60` | upstream stays alive this long after the last viewer leaves — absorbs layout switching/reconnect churn without pinning connections |
| `VA_WARM_ENABLED` | `true` | master switch for warm-camera keepalives |
| `VA_WARM_MAX_STREAMS` | `16` | max warm-flagged cameras per property (409 `WARM_LIMIT` beyond) |
| `VA_SESSION_SWEEP_INTERVAL_SECONDS` | `30` | idle-session sweep runs at most this often per process |
| `VA_MEDIA_INDEX_TTL_SECONDS` | `15` | how often stream-session creation re-verifies its media-registration cache against live go2rtc/MediaMTX indexes — bounds staleness after a media-server restart |
| `CAMERA_CREDENTIAL_KEY` | Fernet key | stored RTSP password encryption |

## Dual-stream / quality

Cameras may have `sub_rtsp_url` (secondary RTSP substream — e.g. Hikvision
`/Streaming/channels/<n>02`). Sessions request `quality=sub` for the
substream or `quality=main` for primary; when no substream is configured
the session silently uses the primary. go2rtc registers
`cam_<id>_sub` (+ `_sub_rtc` when transcoding); MediaMTX mirrors both as
paths. The VMS uses `sub` on 3×3/4×4 grids and `main` on 1×1/2×2 and
fullscreen — preferring real camera substreams over any server-side
scaling.

## Network / ICE

- All inter-service traffic rides the `media` docker network using service
  DNS (`go2rtc`, `mediamtx`) — control APIs stay container/localhost-scoped.
- Browser media path: `POST /va/webrtc` (signaling, same-origin) → ICE to
  MediaMTX on UDP `8189` or TCP `8889`.
- Dev advertises `127.0.0.1` as the ICE host candidate
  (`MTX_WEBRTCICEHOSTNAT1TO1IPS`). Production must advertise the real
  public IP and open UDP 8189 (or rely on ICE-TCP :8889); add STUN/TURN
  via `webrtcICEServers2` for NAT-restricted clients.

## Security

- Stream JWTs are path-scoped, ≤5 min, sent in `Authorization` headers for
  WebRTC — never in URLs. HLS keeps `?token=` (media elements can't send
  headers); front it with a token-checking proxy in prod.
- Control APIs (:1984, :9997) are not browser-facing — bind/publish
  accordingly in production.
- Camera creds live only in the encrypted `cameras.password` column; the
  credentialed URL goes only backend→go2rtc.

## Diagnostics

`GET /api/v1/va/media-health` (Staff) → `{go2rtc, mediamtx, configured{…}}`.
Backend logs `va.webrtc_upstream_error` with stream id + upstream status —
no credentials or tokens logged.

## Prod checklist

- Separate services/containers for both tiers on one private network.
- `MEDIAMTX_PUBLIC_URL` → HTTPS origin behind a proxy that checks `token=`
  on `/{path}/index.m3u8` + segments, or keep HLS internal and serve
  WebRTC only.
- Real public ICE IP + UDP 8189 open + TURN for hostile NATs.
- Writable mounted configs for both services (API persists registrations).
- `GO2RTC_RTSP_URL` points at the go2rtc service name as seen by MediaMTX.
