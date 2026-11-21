# AiROS VA — dedicated media server

Independent Docker deployment of the AiROS VA media plane. The AiROS
FastAPI backend remains the control plane (auth, RBAC, camera config,
session minting); these containers own **all** media work: RTSP ingest,
upstream connection reuse, WebRTC/WHEP, HLS.

```
IP camera --RTSP--> go2rtc :8554 (ingest/restream) --RTSP--> MediaMTX
                        (viewer fan-out) --WHEP :8889 / HLS :8888--> browser
AiROS backend ------API----> go2rtc :1984  (localhost only)
                     ------API----> MediaMTX :9997 (localhost only)
Prometheus (opt)  ---------> MediaMTX :9998 metrics
```

## Responsibility split

- **go2rtc** owns the physical camera: RTSP dial, reconnect, credentials,
  main+substream, optional ffmpeg transcode. N viewers = **1 upstream
  connection** — MediaMTX pulls the restream, never the camera.
- **MediaMTX** owns viewers only: WHEP/WebRTC sessions, HLS, reader
  lifecycle, per-path `sourceOnDemand` pull from go2rtc.
- **FastAPI** never touches media payloads: it registers streams/paths,
  mints scoped JWTs, proxies only the SDP offer/answer.

## Deploy

```sh
cp .env.example .env          # set API passwords + PUBLIC_MEDIA_HOST
mkdir -p config && docker compose up -d
docker compose up -d --profile monitoring   # + Prometheus on :9090 (localhost)
```

Backend env (matching credentials):

```
GO2RTC_API_URL=http://<media-host>:1984     GO2RTC_API_AUTH=<user>:<pass>
GO2RTC_RTSP_URL=rtsp://go2rtc:8554          # or rtsp://<media-host>:8554 if remote
MEDIAMTX_API_URL=http://<media-host>:9997   MEDIAMTX_API_AUTH=<user>:<pass>
MEDIAMTX_SIGNAL_URL=https://media.example.com:8889
MEDIAMTX_PUBLIC_URL=https://media.example.com:8888
```

If backend runs on the same host, use `http://localhost:…` — the API ports
are bound to `127.0.0.1` already. If remote, publish the ports on a private
interface or firewall-allowlist the backend IP; **never expose :1984/:9997
publicly**.

## Ports & firewall

| Port | Proto | Exposed to | Purpose |
|---|---|---|---|
| 8889 | TCP | **public** | WHEP signalling + ICE-TCP mux |
| 8888 | TCP | **public** | HLS fallback |
| 8189 | UDP | **public** | WebRTC ICE media (primary path) |
| 1984 | TCP | localhost/firewall-only | go2rtc control API |
| 9997 | TCP | localhost/firewall-only | MediaMTX control API |
| 9998 | TCP | localhost/monitoring | MediaMTX Prometheus metrics |
| 8554 | TCP | docker network only | go2rtc→MediaMTX restream |

UDP 8189 unreachable → ICE falls back to the 8889 TCP mux (higher latency,
still functional). `PUBLIC_MEDIA_HOST` must be the address browsers
resolve — never a docker-internal or NAT-private IP, or ICE fails.

TURN fallback: if symmetric NATs block even TCP-mux ICE, add a coturn
container and set `MTX_WEBRTCICESERVERS2=[{"urls":["turn:…"],…}]`.

## Health, restart, persistence

- `restart: unless-stopped` on both; `healthcheck` sidecar polls both APIs
  every 15s (scratch images have no shell for native HEALTHCHECK).
- Stream/path registrations persist into `config/go2rtc.yaml` /
  `config/mediamtx.yml` (API-written, mounted writable) — restarts keep
  camera registrations; even if lost, the backend's stale-index check
  re-registers lazily (verified: <1s recovery).
- Resource ceilings: MediaMTX capped at 2 CPU / 1 GiB in compose; go2rtc
  bounded by `VA_WARM_MAX_STREAMS` (default 16 persistent camera dials) +
  on-demand pull semantics.

## Monitoring

- `docker stats` — CPU/RAM/net per container.
- MediaMTX `:9998/metrics` → Prometheus (`monitoring/prometheus.yml`,
  profile-gated). Path readiness, reader counts, per-protocol sessions,
  bytes in/out.
- Backend `GET /api/v1/va/media-stats` — one call: active sessions, go2rtc
  live producers/consumers, MediaMTX paths/readers/WHEP/HLS sessions.
- go2rtc has no Prometheus exporter — its producer/consumer counts surface
  through `/va/media-stats`.

## Rollback / migration

Dev stack (`deploy/media/docker-compose.yml`, unauthenticated localhost)
and this stack are interchangeable — the backend speaks the same APIs.

- **Migrate**: deploy this stack, point backend env at it, restart backend.
  Streams re-register lazily per camera on first session — no bulk import.
- **Rollback**: repoint backend env at the previous media host, restart
  backend. No DB or camera-config changes are involved on either side.
- **Backup**: `config/go2rtc.yaml` + `config/mediamtx.yml` are the entire
  media state — copy the directory. Credentials live in the DB, not here.

## Multi-site scale-out

Each property/site can run its own copy of this stack. Camera→media-server
association is via the backend's `GO2RTC_*`/`MEDIAMTX_*` env set (one stack
per backend deployment today); a per-camera media-cluster field is the
documented roadmap for shared-backend multi-site — no schema blocker.
