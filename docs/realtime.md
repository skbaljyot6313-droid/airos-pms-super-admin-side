# Real-time delivery — Centrifugo

Centrifugo carries **invalidation hints** to connected clients; PostgreSQL
stays the source of truth and the existing reconciliation polls stay in
place (now at longer intervals). A Centrifugo outage degrades the system
to the pre-realtime behavior — nothing depends on delivery succeeding.

## Architecture

```
SA backend ──┐                     ┌── SA frontend (centrifuge-js)
             ├─ POST /api/publish ─┤        ↑ ws
EB backend ──┘   (X-API-Key)   Centrifugo ──┤
                                 ↑         └── Employee app (centrifuge-js)
              GET /realtime/token┘  (each API mints JWTs for its own users)
              POST /realtime/subscribe
```

- **FastAPI** owns business rules + auth. Each backend exposes
  `GET /api/v1/realtime/token` (connection JWT, `CENTRIFUGO_CONN_TOKEN_TTL_SECONDS`,
  default 300 s) and `POST /api/v1/realtime/subscribe` (per-channel JWT,
  `CENTRIFUGO_SUB_TOKEN_TTL_SECONDS`, default 600 s). Tokens are HS256 JWTs
  signed with `CENTRIFUGO_TOKEN_SECRET`; the JS SDK renews them through the
  same endpoints.
- **Centrifugo** verifies the JWTs against the same secret, holds the
  WebSockets, and accepts server publishes via `POST {CENTRIFUGO_URL}/api/publish`
  with header `X-API-Key: CENTRIFUGO_API_KEY`.
- Every subscription requires a per-channel JWT — the Centrifugo config
  (`deploy/centrifugo/config.json`) keeps `allow_subscribe_for_client: false`
  on every namespace, so a token is the *only* way in. The backends'
  `/realtime/subscribe` is the authorization gate.

## Channel grammar — private namespace `priv`

| Channel | Audience | Published by | Gate (server-side) |
|---|---|---|---|
| `priv:prop:{pid}:tasks` | SA staff of property | SA + EB task mutations | SA `/subscribe`: company/property scope |
| `priv:prop:{pid}:units` | SA staff | `ResourceStateService.transition`/`_derive_write` (both backends) | same |
| `priv:prop:{pid}:attendance` | SA staff | EB check-in/break/out, SA leave decisions | same |
| `priv:prop:{pid}:maintenance` | SA staff | SA + EB ticket mutations | same |
| `priv:prop:{pid}:employees` | SA staff | SA employee CRUD | same |
| `priv:prop:{pid}:locations` | SA staff | EB location ingest (throttled) | same |
| `priv:emp:{employee_uid}` | that employee | task/ticket/attendance events | EB `/subscribe`: `user.employee_id` must match; SA: same rule |

No global channels exist. An employee can never mint a token for
another employee's channel or any property channel; a property manager
can never mint one outside their `property_id`.

## Event envelope

```json
{"v": 1, "id": "<uuid>", "type": "task.updated",
 "ts": "<iso8601>", "data": { /* minimal whitelisted fields */ }}
```

Events are hints — clients refetch the affected collection or merge
whitelisted fields. They are **not** the source of truth; duplicates and
reorderings are safe by design (idempotent merges + timestamp checks).

## Delivery guarantees

- SA backend buffers events on `session.info` and publishes them from an
  `after_commit` hook — a rolled-back transaction never emits, and a
  publish failure never fails the committed mutation.
- EB backend publishes fire-and-forget *after* `session.commit()` returns
  (same post-commit ordering), plus the `session.info` hook for code
  paths whose commit happens in a caller (resource-state transitions
  inside occupancy transactions).
- Client recovery: automatic reconnect + token renewal via centrifuge-js;
  on reconnect the residual polls reconcile any missed events. The live
  map additionally coalesces event bursts into a single trailing poll.

## Environment variables

**Centrifugo service** (`deploy/centrifugo/`):

| Var | Purpose |
|---|---|
| `CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY` | verifies connection + subscription JWTs — must equal `CENTRIFUGO_TOKEN_SECRET` on both backends |
| `CENTRIFUGO_HTTP_API_KEY` | authorizes `POST /api/publish` — must equal `CENTRIFUGO_API_KEY` on both backends |
| `CENTRIFUGO_CLIENT_ALLOWED_ORIGINS` | space-separated extra origins (add the Vercel domain); dev + Capacitor origins are in `config.json` |

**SA + EB backends** (all optional — unset = realtime disabled, app unchanged):

| Var | Purpose |
|---|---|
| `CENTRIFUGO_URL` | Centrifugo HTTP base (internal Railway URL), e.g. `http://centrifugo.railway.internal:8000` |
| `CENTRIFUGO_API_KEY` | publish key |
| `CENTRIFUGO_TOKEN_SECRET` | JWT signing secret |
| `CENTRIFUGO_WS_URL` | client-facing `wss://<public-domain>/connection/websocket` — returned by `/realtime/token`; defaults to `CENTRIFUGO_URL` + path |
| `CENTRIFUGO_CONN_TOKEN_TTL_SECONDS` | 300 |
| `CENTRIFUGO_SUB_TOKEN_TTL_SECONDS` | 600 |
| `LOCATION_PUBLISH_MIN_INTERVAL_SECONDS` (EB) | per-employee location fan-out throttle, 8 |

**Nothing** goes into `VITE_*` or the mobile bundle — every secret is
server-side only; the SPA learns `ws_url` from the token endpoint.

## Deployment (Railway)

1. `deploy/centrifugo/` → new Railway service (Dockerfile deploys
   `centrifugo/centrifugo:v6` with `config.json`). Set the two env vars.
   Add the production frontend origin to `allowed_origins`.
2. Generate its public domain; health check `GET /health`.
3. Set `CENTRIFUGO_*` on the SA backend and EB backend services:
   - `CENTRIFUGO_URL` → the internal Railway URL (`*.railway.internal`)
   - `CENTRIFUGO_WS_URL` → `wss://<public-domain>/connection/websocket`
   - matching `CENTRIFUGO_API_KEY` + `CENTRIFUGO_TOKEN_SECRET`
4. Redeploy both backends — token/subscribe endpoints come alive; clients
   connect on next sign-in.
5. Optional HA: switch the engine to Redis (`"engine": {"type": "redis"}`)
   before running >1 replica; single-replica memory engine is the default.

## Rollback

Unset `CENTRIFUGO_URL`/`CENTRIFUGO_API_KEY`/`CENTRIFUGO_TOKEN_SECRET` on a
backend (or all) → `configured()` false → emits no-op, `/realtime/token`
returns `503 REALTIME_UNAVAILABLE`, and both clients latch to polling-only
for the session. No code redeploy needed. Stopping the Centrifugo service
produces the same client-visible state (connection retries + poll
fallback).
