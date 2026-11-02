# Google Cloud Migration Discovery Audit — AiROS Super Admin ("Management Tool")

**Repository:** `super-admin` (local workspace `C:\Users\skbal\Desktop\baljyot\super-admin`)
**Audit date:** 2026-11-02 · **Audited state:** working tree on `development-branch` (HEAD `c1e21e3` + ~71 uncommitted files)
**Target region under consideration:** `asia-south1` (Mumbai)
**Scope:** Investigation & documentation only. No code/config was modified; no secrets are reproduced.

**Label convention:** `VERIFIED` = confirmed in code/config · `INFERRED` = strongly suggested by implementation · `UNKNOWN` = not establishable from the repo · `RECOMMENDATION` = proposed decision.

---

## 1. Executive Summary

This repo contains **exactly two deployable components** plus config for a third:

1. **SA API** — FastAPI + SQLAlchemy 2 async + asyncpg + Alembic (`backend/`), currently on **Railway** (Nixpacks). A `backend/Dockerfile` already exists and is Cloud-Run-shaped (`${PORT:-8080}`, `--proxy-headers`).
2. **SA Frontend** — React 19 SPA built by Vite 8 to static `dist/` (`frontend/`), currently on **Vercel** with an SPA rewrite. Purely static → Firebase Hosting / GCS+CDN is a drop-in.
3. **Centrifugo realtime service** — a stock `centrifugo/centrifugo:v6` container with one config file (`deploy/centrifugo/`), currently a separate Railway service. Fits Cloud Run (WebSockets supported).

**Hard dependencies outside the repo:** Supabase Postgres (ap-south-1, **shared with a separate Employee Backend repo/service**), optional Redis, Supabase/S3 object storage, the Employee Backend API (Railway), OpenStreetMap tiles, Fontshare CDN.

**MongoDB: not present anywhere** (`VERIFIED` — zero matches for mongo/pymongo/motor in code or manifests).

**Biggest migration-specific constraints:**

- The Postgres DB and its **alembic version chain are shared with the Employee Backend** — `alembic_version` is a single row advanced by *two* repos. Boot refuses to serve on stamp mismatch (`check_schema_version`, `backend/app/main.py`). Any DB move must be coordinated with the EB repo, which is **not in this repository**.
- The only scheduler is an **in-process asyncio loop** inside the API (`_start_template_scheduler`). Under multi-instance Cloud Run it would tick once *per instance* — work is idempotent (ledgers/conditional UPDATEs) so it's safe but wasteful; a Cloud Run Job + Cloud Scheduler is the cleaner target.
- The **arq/Redis job-queue pathway is dead code** in this repo — `enqueue()` has zero callers and no `WorkerSettings`/worker exists (`VERIFIED`). Do not plan a worker migration for code that doesn't run.

**Overall verdict (RECOMMENDATION):** The API is stateless, health-check-equipped, and already container-defined — a straightforward Cloud Run fit. The stateful question is entirely "Postgres + Redis + object storage", not compute.

---

## 2. Complete Repository Inventory

| Component | Directory | Technology / version | Purpose | Current provider | Entry point | Deploy type | Port | Requires |
|---|---|---|---|---|---|---|---|---|
| SA API | `backend/` | Python 3.12, FastAPI ≥0.115, uvicorn ≥0.30, SQLAlchemy ≥2.0 async, asyncpg ≥0.29, Alembic ≥1.13 (`backend/requirements.txt`, `backend/Dockerfile`) | All business REST under `/api/v1` (~140 routes, 10 routers) + embedded scheduler | Railway (Nixpacks) | `app.main:app` | Web service | `${PORT:-8000}` (Railway) / `${PORT:-8080}` (Dockerfile) | Postgres, Redis(opt), EB API, object storage, Centrifugo(opt) |
| SA Frontend | `frontend/` | React ^19.0.1, Vite ^8.3.0, TS ^7.0.2, Tailwind ^4.3.3, react-router-dom ^7.18.4, centrifuge ^5.7.4, leaflet ^1.9.4 (`frontend/package.json`) | Super-admin / property-manager SPA | Vercel | `src/main.tsx` → `npm run build` → `dist/` | Static site | 3000 (dev only) | SA API, Centrifugo WS (opt), OSM tiles, Fontshare |
| Centrifugo | `deploy/centrifugo/` | `centrifugo/centrifugo:v6` image + `config.json` | Private-channel WebSocket fan-out (realtime invalidation hints) | Railway (separate service) | `centrifugo -c config.json` | Web service | 8000 | API key + HMAC secret shared with SA API |
| Dev launcher | `main.py` (root) | Python script | Kills :8000/:3000, spawns uvicorn --reload + vite dev | local only | `python main.py` | n/a | 8000/3000 | — |
| Load harness | `tests/load/` | Python (httpx, pytest, psutil, matplotlib) | Opt-in login-burst load tests — **not** part of pytest runs | local/manual | `pytest tests/load/test_concurrent_login.py --confirm-load-test` | n/a | targets 8000/8899 | running API |
| Backend probes | `backend/scripts/` | Python | `audit_probe.py`, `api_probe.py`, `pooler_compat.py` — read-only perf probes | local/manual | — | n/a | — | DB access |

**Not present (VERIFIED):** no mobile app, no Celery/RQ/BullMQ/APScheduler, no email/SMS/push provider, no payment gateway, no AI/OCR service, no MongoDB, no GraphQL, no SSR/serverless functions, no docker-compose, no IaC (Terraform/Pulumi/Cloud Build configs absent).

**Shared libraries:** none published; layering convention is `Router → Service → Repository → SQLAlchemy` inside the single backend.

---

## 3. Frontend Architecture

| Item | Value | Evidence |
|---|---|---|
| Framework / version | React `^19.0.1`, react-dom `^19.0.1` | `frontend/package.json` |
| Build system | Vite `^8.3.0` + `@vitejs/plugin-react` + `@tailwindcss/vite` | `package.json`, `vite.config.ts` |
| Package manager | npm (`installCommand: npm install`) | `frontend/vercel.json` |
| Build command | `npm run build` (vite build) | `package.json` scripts |
| Prod serve | static — `vercel.json` framework `vite`, `outputDirectory: dist` | `frontend/vercel.json` |
| Output dir | `frontend/dist/` (gitignored) | `vercel.json`, `.gitignore` |
| Routing | react-router-dom 7; SPA rewrite `/(.*) → /index.html` | `vercel.json`, `src/App.tsx` |
| Env vars | `VITE_API_URL` (required in prod; dev fallback `http://localhost:8000/api/v1`), `VITE_MAX_COMPLETION_IMAGES` (must equal backend `MAX_TASK_COMPLETION_IMAGES`), `DISABLE_HMR` (vite config) | `src/api/client.ts:15`, `frontend/.env.example`, `vite.config.ts` |
| API base config | `BASE_URL` from `import.meta.env.VITE_API_URL`; missing in prod → explicit error | `client.ts:15-23,197` |
| Auth integration | Bearer JWT in `localStorage` (`mgmt_tool_auth_token`, `_refresh_token`); 401 → single-flight `/auth/refresh` → retry once → `onUnauthorized` logout | `client.ts`, index §9.3 |
| CORS assumptions | Browser calls API cross-origin directly; origins configured server-side via `CORS_ORIGINS` | `core/config.py`, `middleware` |
| File upload | multipart `POST /media/uploads` via `apiFetch` FormData; ≤10 MB; evidence rendered same-origin via `GET /api/v1/media/file/{key}` | `api/media.ts`, `api/v1/media.py` |
| WebSocket | `centrifuge ^5.7.4` client to `CENTRIFUGO_WS_URL` (fetched via `GET /realtime/token` + `POST /realtime/subscribe`); **optional — 503 → sticky poll-only mode** | `src/realtime/`, index §9.6 |
| Static assets | Built assets + `/uploads/*` media URLs resolved against API origin (`mediaUrl`) | `client.ts:18-23` |
| CDN/external deps at runtime | `api.fontshare.com` (Satoshi font CSS import in `index.css`), `{s}.tile.openstreetmap.org` map tiles (`LiveLocationMap.tsx:348`) | `index.css:1`, `LiveLocationMap.tsx` |
| SSR/serverless | None — pure client SPA | `VERIFIED` |

**Migration fit:** `VERIFIED` — a static export with one env var. Firebase Hosting or GCS + Cloud CDN + a `/api` path re-route (or separate API domain) works with zero code change. Only migration touchpoints: rebuild with the new `VITE_API_URL`, update backend `CORS_ORIGINS`, repoint DNS. `package.json` name `"react-example"` is cosmetic.

---

## 4. Backend Architecture

| Item | Value | Evidence |
|---|---|---|
| Language / runtime | Python (prod image `python:3.12-slim`) | `backend/Dockerfile` |
| Framework | FastAPI ≥0.115, uvicorn ≥0.30[standard] | `requirements.txt` |
| Entry point | `app.main:app` | `railway.toml`, `Dockerfile` |
| Startup command | Railway: `alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers` · Dockerfile: `alembic upgrade head || echo … ; exec uvicorn … --port ${PORT:-8080} --workers ${UVICORN_WORKERS:-1} --proxy-headers` | `railway.toml`, `Dockerfile` |
| Workers | **1 uvicorn worker** (no `--workers` flag on Railway; default 1 in Dockerfile) | `railway.toml`; perf audit B-11 |
| Port | `${PORT}` env (Railway injects; Dockerfile defaults 8080) | both files |
| API structure | `API_V1_PREFIX=/api/v1`; `router.py` mounts 10 routers: auth, workspace (mega-router), media, work_batches, templates, attendance, shifts, locations, realtime, logs | `api/v1/router.py` |
| Middleware (outer→inner) | `RequestIDMiddleware` → `AccessLogMiddleware` → `SecurityHeadersMiddleware` → `GZipMiddleware(500)` → `CORSMiddleware` | `app/main.py:266-283` |
| AuthN | HS256 JWT access (30 min) + opaque refresh (sha256-hashed, 30 d); argon2id hashing | `core/security.py`, `core/config.py` |
| AuthN hot path | `get_current_user` → 60 s detached user cache (`AUTH_CACHE_TTL_SECONDS`) → `UserRepository` | `dependencies/auth.py`, `core/auth_cache.py` |
| AuthZ | `require_role`; `require_super_admin` / `require_property_manager` (aliased `Staff`); tenant scope `user.company_id`; PM property-pinning per-service | `dependencies/auth.py` |
| Sessions | Stateless JWT — **no server-side session storage** | `VERIFIED` |
| DB layer | SQLAlchemy 2 `create_async_engine` + `async_sessionmaker`, `get_db` dependency | `core/database.py:162-177,314` |
| Pool | `InstrumentedAsyncQueuePool` (AsyncAdaptedQueuePool + `_do_get` wait timing): `pool_size=5`, `max_overflow=5`, `recycle=1800`, `timeout=30`, `pool_pre_ping=False` | `core/config.py`, `core/database.py` |
| Pooler compat | `pooler_mode()` auto-detects pgbouncer transaction (:6543) vs session (:5432) vs direct; transaction mode disables asyncpg + dialect prepared-statement caches and UUID-names statements | `core/database.py:40-107` |
| Async model | Fully async (asyncpg, httpx, redis.asyncio); argon2 offloaded to bounded thread pool | `verify_queue.py` |
| Password verify | `verify_queue.py`: bounded executor — `VERIFY_MAX_WORKERS` (0=auto min(4,cpu)), `VERIFY_QUEUE_MAX=128`, `VERIFY_QUEUE_TIMEOUT_S=10`, overload → 503 `AUTH_QUEUE_*` + `Retry-After` | `core/config.py`, `core/verify_queue.py` |
| Background work | In-process asyncio scheduler loop (see §6); post-commit `after_commit` Session hooks dispatch EB allocation notices + Centrifugo publishes buffered in `session.info` | `app/main.py:171-258`, `core/database.py:202-258` |
| External HTTP | Shared lifespan-managed `httpx.AsyncClient` (`core/http_client.py`): limits 20 conn/10 keep-alive/45 s keep-alive expiry; timeout `LOCATION_SERVICE_TIMEOUT_SECONDS=8`, connect 4 s | `core/http_client.py` |
| Webhooks | Outbound only: `POST {EB}/admin/notify-allocation` after commit (`services/employee_events.py`); **no inbound webhook handlers** | `VERIFIED` |
| WebSocket | None server-side (Centrifugo is a separate service) | `VERIFIED` |
| SSE | None | `VERIFIED` |
| Health | `GET /health` (cheap liveness), `GET /health/db`, `GET /ready` **and** `GET /api/v1/health` (readiness: DB + alembic stamp + Redis probe) | `app/main.py:299-340` |
| Boot/shutdown | Lifespan: prod config fatals (JWT/DB) → `check_database()` 3×2 s → `check_schema_version()` (refuse boot on stamp mismatch) → start scheduler if `RUN_EMBEDDED_SCHEDULER` → warm EB client. Shutdown: cancel scheduler → close EB client → queue → redis → engine | `app/main.py:78-169` |
| Static mount | `/uploads` → `UPLOAD_DIR` always mounted (LocalStorage serving) | `app/main.py:288-296` |
| Docs | OpenAPI disabled when `APP_ENV=production` | `app/main.py` |

**In-process services that could be separated:** only the **scheduler loop** — everything else is request-path or post-commit fire-and-forget. `RECOMMENDATION`: extract the tick into a Cloud Run Job (or keep `min-instances=1` semantics — see §11/§13).

---

## 5. Database Inventory

| Field | Value | Evidence / label |
|---|---|---|
| Type | PostgreSQL | `VERIFIED` |
| Provider | **Supabase** | `VERIFIED` — `.env.example`, probe docs |
| Project ref | `wlxqdsnjiayxeqpejeih` | `docs/performance-audit/architecture-overview.md` |
| DB name | `postgres` | `.env.example` `SUPABASE_DB_NAME` |
| Region | **ap-south-1 (Mumbai)** — `aws-0-ap-south-1.pooler.supabase.com` | `VERIFIED` via audit docs |
| Connection method | Public-internet pooler: `:6543` transaction mode, `:5432` session mode; direct `db.<ref>.supabase.co` is IPv6-only | `.env.example` comments |
| ORM / driver | SQLAlchemy 2.x async + asyncpg | `requirements.txt` |
| Pool config | size 5 + overflow 5 = **10 conns/worker**; recycle 1800 s; timeout 30 s; no pre-ping | `core/config.py`, `database.py` |
| Transaction mode | asyncpg via SQLAlchemy; `autoflush=False`, `expire_on_commit=False` | `database.py:176-181` |
| SSL | TLS implicit through Supabase pooler (fresh connect measured ~116 ms incl. TLS+auth) | `INFERRED`/audit doc |
| Persistence | Required — sole source of truth for both backends | `VERIFIED` |
| Backups | Supabase-managed; **no repo-owned backup scripts** | `UNKNOWN` beyond provider defaults |
| Migration tooling | **Alembic** — 40-revision linear chain, head `v9f2b5c8d1e4`; `alembic/env.py` builds URL from `settings` (no credentials in `alembic.ini`) | `alembic/versions/`, `alembic.ini` |

**Critical sharing constraint (VERIFIED):** `alembic_version` is a single row on a DB shared with the Employee Backend. SA chain covers through `v9f2b5c8d1e4`; EB extends the same row. `backend/Dockerfile` deliberately tolerates `alembic upgrade head` failure ("shared schema stamp"), and `check_schema_version` in `app/main.py` resolves EB-owned heads via revision `u7e1f5a9d3c6`. Any migration *tooling or hosting* change must be replicated in the EB repo.

**Redis**

| Field | Value |
|---|---|
| Type | Redis (any compatible; arq protocol usage) |
| Provider | Railway-hosted per docs; `REDIS_URL` env-only — **not set in dev `.env`** (`VERIFIED`) |
| Usage | Rate-limit counters (`mt:rl:*`, INCR+PEXPIRE sliding window, fail-open + in-memory fallback); arq `ArqRedis` client pool (**dead path — no worker/callers**); **no application caching exists** |
| TTLs | Explicit per key; rate-limit window keys |
| Persistence | Not required — "accelerator, never a source of truth" (`core/redis.py` docstring) |

**Files/objects**

| Field | Value |
|---|---|
| Stores | `LocalStorage` (dev, `/uploads` static mount), `S3Storage` (boto3, S3-compatible incl. Supabase Storage `*.storage.supabase.co/storage/v1/s3`), `SupabaseStorage` — selected by `STORAGE_BACKEND` (`auto` prefers S3 creds else Supabase key else local) |
| Content | Task/maintenance evidence images; JPEG/PNG/WebP ≤10 MB, magic-byte validated, hex key `^[0-9a-f]{32}\.[a-z0-9]{2,5}$` |
| Access | Public `GET /api/v1/media/file/{key}` streams via `StorageBackend.open` (240 req/min rate limit); private `GET /admin/logs/attachments/…` streaming for logs |

**MongoDB:** `VERIFIED` — none.

---

## 6. Background Workers & Scheduled Jobs

Only **one** background mechanism actually runs: the embedded asyncio scheduler inside the API process.

| Process | Entry point | Trigger | Frequency | Continuous? | Persistent conn? | Retryable? | Idempotent? | Survives restart? | Concurrency-safe? | Interruptible? |
|---|---|---|---|---|---|---|---|---|---|---|
| Generation tick | `_start_template_scheduler` → `_loop` in `app/main.py:171-258` | `RUN_EMBEDDED_SCHEDULER` (default true) at lifespan startup | 60 s + exponential backoff ≤600 s on failure | Yes, while process runs | Uses pool sessions (4 sequential per tick) | Self-retrying next tick | **Yes** — `template_generations` (template_id+occurrence_key UC), `uq_tasks_series_due`, SAVEPOINT-guarded dedup vs `uq_tasks_open_room_title`, conditional UPDATEs | Missed ticks self-heal on next run (ledger prevents doubles; `generate-occurrence`/`generate-due` endpoints allow manual catch-up) | Safe vs itself (ledgers); wasteful ×N replicas | Yes — `scheduler.cancel()` on shutdown |
| ├ `RolloverService.expire_due` | per-tick step | — | 60 s | — | 1 session | — | conditional UPDATE + NEXT_SCHEDULED_OCCURRENCE | — | — | — |
| ├ `TemplateService.run_due` | per-tick step | — | 60 s (`next_run_at` indexed) | — | 1 session | — | ledger | — | — | — |
| ├ `TaskService.run_due_repetitive` | per-tick step | — | 60 s | — | 1 session | — | series UC | — | — | — |
| ├ `RolloverService.run` | per-tick step | — | 60 s | — | 1 session | — | SYSTEM_DAILY_ROLLOVER reason | — | — | — |
| └ `reconcile_property` sweep | every 15th tick (~15 min), per property | — | ~15 min | — | 1 session; ~3–4 queries **per resource** (~400–600 sequential queries ≈ 5–7 s at current scale) | — | read-only scan | — | — | — |
| EB allocation notices | `after_commit` hook → `employee_events.dispatch_allocation_notices` | post-commit, buffered in `session.info` | per commit | No | shared httpx pool, ≤8 s cap | Fire-and-forget; EB ledger synthesis is backstop | N/A | Best-effort (lost if process dies mid-dispatch — EB backstop covers) | Yes | — |
| Centrifugo publishes | `after_commit` hook → `centrifugo.dispatch_realtime_events` (≤50/commit) | post-commit | per commit | No | httpx to CENTRIFUGO_URL | Best-effort; clients also poll | N/A | No (hints only) | Yes | — |
| arq worker | — | — | — | **Does not exist** (`VERIFIED`: no `WorkerSettings`, zero `enqueue()` callers) | — | — | — | — | — | — |
| Load harness | `tests/load/test_concurrent_login.py` | manual `--confirm-load-test` | manual | No | targets a running API | — | — | — | — | — |

**Recommended GCP classification (RECOMMENDATION):**

- Generation tick → **Cloud Scheduler (`* * * * *`) → Cloud Run Job** `airos-generation-tick` (same image, e.g. `python -m app.jobs.generation_tick`), because the tick must run exactly once fleet-wide and its 4-session sweep is self-contained. Alternative: keep the embedded loop but run the API at `min=1,max=1` — not recommended.
- Reconciliation sweep → same Job behind a second schedule (`*/15 * * * *`) or a `--mode=reconcile` flag.
- EB notices + Centrifugo publishes → keep in-process (post-commit, sub-second, fire-and-forget). Cloud Tasks is a possible hardening option, not a requirement.
- Manual `POST /templates/generate-due` endpoint already exists as the catch-up escape hatch (`VERIFIED`).

---

## 7. External Integrations & API Connections

| Service | Used by | Purpose | Protocol | Auth | Config location | Network | Migration impact |
|---|---|---|---|---|---|---|---|
| **Supabase Postgres** | SA API + EB (shared) | Sole persistent store | postgresql+asyncpg via pooler | DB user/password in `DATABASE_URL`/`SUPABASE_DB_*` | `core/config.py` | Public internet (TLS) | **High** — shared DB + shared alembic row; see §14 |
| **Supabase Storage (S3-compatible)** | SA API media | Evidence images (`uploads` bucket) | HTTPS/S3 (boto3 `S3Storage`) | `SUPABASE_SECRET_KEY` or `S3_*` | `core/storage.py`, env | Public | Medium — or switch to GCS (code change needed; no GCS adapter exists) |
| **Employee Backend API** | SA API | Live locations proxy; allocation notices | HTTPS REST | `X-Location-Service-Key` header | `EMPLOYEE_API_BASE_URL` / `EMPLOYEE_BACKEND_URL`, `LOCATION_SERVICE_API_KEY`; prod value `https://employee-api-production-c0e3.up.railway.app/api/v1` | Public internet; measured ~93 ms TCP / ~634 ms cold TTFB from India | Medium — stays external (separate repo/team); keep key in Secret Manager |
| **Centrifugo** | SA API → publish; browsers → WS | Realtime invalidation | HTTP `/api/publish` + WSS | `X-API-Key`; HMAC JWT secrets | `CENTRIFUGO_{URL,API_KEY,TOKEN_SECRET,WS_URL}` | Public | Medium — redeploy on Cloud Run; secrets must match both backends |
| **Vercel** | hosting | Frontend CDN | HTTPS | `VERCEL_TOKEN` (CI secret) | workflow env | — | Low — replaced by Firebase/GCS |
| **Railway** | hosting + Redis + EB | Compute + queue/Redis | HTTPS/GraphQL API, redis:// | `RAILWAY_TOKEN` (CI secret) | workflows | — | Low (SA side); EB remains |
| **OpenStreetMap tiles** | browser | Live-location map tiles | HTTPS `https://{s}.tile.openstreetmap.org` | none | `LiveLocationMap.tsx:348` (hardcoded) | Public | Low — note OSM tile-usage policy at production volume |
| **Fontshare CDN** | browser | Satoshi font stylesheet | HTTPS `api.fontshare.com` | none | `index.css:1` (CSS `@import`) | Public | Low |
| **GitHub** | CI | Deploy orchestration | HTTPS | `GITHUB_TOKEN`/repo secrets (`RAILWAY_TOKEN`, `VERCEL_*`, `CENTRIFUGO_*`) | `.github/workflows/` | — | Low — workflows need rewrite to Cloud Build/`gcloud run deploy` |

**No** email/SMS/push/payment/AI/analytics/error-tracking integrations exist (`VERIFIED`). Logging is stdout-only (`core/logging.py`); no Sentry/Datadog.

---

## 8. Environment Variables & Secrets Audit

Secrets present only in env/CI — none committed (`VERIFIED`: `.env*` gitignored; `tests/load/credentials*.json|csv` gitignored). `backend/.env` exists locally (dev): sets `DATABASE_URL`, `SUPABASE_*` storage keys, `S3_*`, JWT, CORS — **no** `REDIS_URL`, `EMPLOYEE_*`, `CENTRIFUGO_*` in dev.

| Variable | Used by | Purpose | Secret? | Required in prod? | Target location |
|---|---|---|---|---|---|
| `APP_NAME`/`APP_ENV`/`DEBUG`/`API_V1_PREFIX` | API | app config | No | Yes (`APP_ENV=production`) | env/Cloud Run var |
| `SQL_ECHO` | API | SQL logging | No | No | var |
| `DATABASE_URL` **or** `SUPABASE_DB_{HOST,PORT,NAME,USER}` + `SUPABASE_DB_PASSWORD` | API, Alembic | Postgres connection | **Yes** (password) | Yes (one form) | Secret Manager |
| `DB_POOL_{SIZE,MAX_OVERFLOW,RECYCLE,TIMEOUT}` | API | pool tuning | No | Recommended | var |
| `DB_POOLER_MODE` | API | pgbouncer mode (auto\|transaction\|session\|direct) | No | If pooler used | var |
| `SUPABASE_{URL,PUBLISHABLE_KEY,SECRET_KEY,STORAGE_S3_URL,STORAGE_BUCKET}` | API media | Supabase storage path | **Yes** (secret key) | If supabase/auto backend | Secret Manager |
| `JWT_SECRET_KEY`/`JWT_ALGORITHM`/`ACCESS_TOKEN_EXPIRE_MINUTES`/`REFRESH_TOKEN_EXPIRE_DAYS` | API | token signing | **Yes** | Yes — **fatal if empty in prod** | Secret Manager |
| `CORS_ORIGINS` | API | allowed origins (CSV) | No | Yes — update for new frontend domain | var |
| `REDIS_URL`/`REDIS_{CONNECT,SOCKET}_TIMEOUT` | API | rate limit + arq client | **Yes** | Optional | Secret Manager/var |
| `RATE_LIMIT_ENABLED`/`LOGIN_RATE_LIMIT(+_WINDOW_SECONDS)` | API | auth throttle | No | Yes | var |
| `VERIFY_{MAX_WORKERS,QUEUE_MAX,QUEUE_TIMEOUT_S,OVERLOAD_RETRY_AFTER_S}` | API | argon2 queue sizing | No | Tune per vCPU | var |
| `REQUEST_TIMING_ENABLED` | API | X-*-Time headers | No | Optional | var |
| `AUTH_CACHE_TTL_SECONDS` | API | user cache TTL | No | Optional | var |
| `RUN_EMBEDDED_SCHEDULER` | API | in-process tick | No | Yes (false once Job exists) | var |
| `STORAGE_BACKEND`/`UPLOAD_DIR`/`MAX_TASK_COMPLETION_IMAGES` | API | media | No | Yes (`local` is a prod warning) | var |
| `S3_{ENDPOINT_URL,REGION,BUCKET,ACCESS_KEY,SECRET_KEY,PUBLIC_BASE_URL}` | API | S3/Supabase storage | **Yes** | If S3 backend | Secret Manager |
| `EMPLOYEE_API_BASE_URL`/`EMPLOYEE_BACKEND_URL` | API | EB upstream base | No (URL) / — | Yes for live locations | var |
| `LOCATION_SERVICE_API_KEY` | API | EB auth header | **Yes** | Yes for live locations | Secret Manager |
| `LOCATION_SERVICE_TIMEOUT_SECONDS` | API | EB call cap | No | Optional | var |
| `CENTRIFUGO_{URL,API_KEY,TOKEN_SECRET,WS_URL}` | API | realtime publish/signing | **Yes** (api key, token secret) | Optional feature | Secret Manager |
| `CENTRIFUGO_{CONN,SUB}_TOKEN_TTL_SECONDS` | API | token TTLs | No | Optional | var |
| `CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY`/`CENTRIFUGO_HTTP_API_KEY`/`CENTRIFUGO_CLIENT_ALLOWED_ORIGINS` | Centrifugo svc | must equal SA `CENTRIFUGO_*` | **Yes** | Yes | Secret Manager |
| `UVICORN_WORKERS` | API container | worker count | No | Default 1 | var |
| `PORT` | platform | injected by Railway/Cloud Run | No | auto | — |
| `VITE_API_URL`/`VITE_MAX_COMPLETION_IMAGES`/`DISABLE_HMR` | frontend build | API base / upload cap / dev flag | No | `VITE_API_URL` required | build-time env |
| `RAILWAY_TOKEN`/`VERCEL_{TOKEN,PROJECT_ID,ORG_ID}`/`CENTRIFUGO_*` (CI) | GitHub Actions | deploy auth | **Yes** | Replaced by GCP deploy creds | repo secrets → Secret Manager/WIF |
| `LOADTEST_*`, `--db-url`, `--server-pid` | load harness | test config | **Yes** (targets real API+DB) | Never in prod | local only |

**Findings:**
- `VERIFIED` no hardcoded credentials in source; DB URL built via `URL.create` (password quoting handled); `${SUPABASE_DB_PASSWORD}` placeholder expansion supported.
- Undocumented-in-`.env.example` tunables (present in `config.py` only): `SQL_ECHO`, `LOGIN_RATE_LIMIT*`, `VERIFY_*`, `REQUEST_TIMING_ENABLED`, `LOCATION_SERVICE_TIMEOUT_SECONDS`, `AUTH_CACHE_TTL_SECONDS`, `CENTRIFUGO_*_TOKEN_TTL_SECONDS`.
- Frontend prod env is injected at **build** time only (no runtime env story) — standard for static hosting.
- `INFERRED` prod Redis presence unverifiable from repo (env-only); `deploy/cloudrun.md` documents `RUN_EMBEDDED_SCHEDULER=false` as the intended prod posture, but no arq worker exists — **flag: who owns the prod tick today is UNKNOWN** (presumably embedded=true in prod too).

---

## 9. Existing Deployment & Infrastructure Configuration

| File | What it does |
|---|---|
| `backend/railway.toml` | Nixpacks build; `alembic upgrade head && uvicorn … :${PORT:-8000} --proxy-headers`; healthcheck `/health` 300 s; restart ON_FAILURE ×5 |
| `backend/Dockerfile` | py3.12-slim; `pip install requirements.txt`; CMD `alembic upgrade head || echo 'shared stamp' ; exec uvicorn … :${PORT:-8080} --workers ${UVICORN_WORKERS:-1} --proxy-headers` — **already Cloud-Run-compatible** |
| `frontend/vercel.json` | framework vite; build→dist; SPA rewrite |
| `deploy/centrifugo/Dockerfile`+`config.json` | stock v6 image; `priv` namespace, all client ops JWT-gated; health+prometheus enabled; EXPOSE 8000 |
| `.github/workflows/deploy-production.yml` | push to `main` (or dispatch): Railway `serviceInstanceDeploy` GraphQL + redeploy-on-fail poll; `npx vercel deploy --prod`. **No test/typecheck gate** |
| `.github/workflows/deploy-centrifugo.yml` | manual: provision Centrifugo Railway service + domain + write `CENTRIFUGO_*` onto SA service (and EB if co-located); smoke-test publish |
| `deploy/cloudrun.md` | Existing internal Cloud Run sizing notes (asia-south1, 2 vCPU/1 GiB, concurrency 20, min1/max4, verify-queue sizing, DB budget) — documentation only |
| `main.py` | dev launcher only |
| `tests/load/` | opt-in harness; `dev_stub.py` offline contract server :8899 |

**Deploy triggers:** `main` push → backend+frontend parallel jobs. Centrifugo changes → manual workflow. **Rollback:** Railway redeploy + Vercel promote (implicit; no scripted rollback). **Environments:** production only in CI; staging config exists only as docs + load-test env overrides. Railway-specific bits to replace: GraphQL `serviceInstanceDeploy`, Railway domain provisioning, `${PORT}` contract (Cloud Run also injects `PORT` — compatible), Nixpacks build (→ Dockerfile already present → Cloud Build/Artifact Registry).

---

## 10. Networking & Communication Architecture

```mermaid
flowchart LR
  subgraph Browser
    SPA[React SPA<br/>localStorage JWT]
  end

  SPA -->|HTTPS REST /api/v1<br/>Bearer JWT| VER[Vercel CDN → origin]
  SPA -->|WSS + per-channel JWT| CF[Centrifugo svc<br/>Railway :8000]
  SPA -->|HTTPS tiles| OSM[tile.openstreetmap.org]
  SPA -->|CSS/font| FS[api.fontshare.com]

  subgraph Railway
    API[SA API<br/>uvicorn :PORT<br/>+ embedded 60s tick]
    CF
    EB[Employee Backend API<br/>separate Railway svc]
    RDS[(Redis optional<br/>rate-limit + arq client)]
  end

  subgraph Supabase ap-south-1
    PG[(Postgres postgres<br/>pooler :6543 txn / :5432 sess)]
    S3[(Storage uploads bucket<br/>S3-compatible)]
  end

  API -->|asyncpg pool 5+5<br/>prepared-cache OFF on :6543| PG
  EB -->|shared DB + shared alembic_version| PG
  API -->|INCR/PEXPIRE mt:rl:* (opt)| RDS
  API -->|httpx keep-alive pool<br/>X-Location-Service-Key| EB
  API -->|boto3 S3| S3
  API -->|POST /api/publish X-API-Key| CF
  GH[GitHub Actions] -->|GraphQL deploy / CLI| API
  GH -->|vercel deploy --prod| VER
```

- **Public endpoints:** all API routes; `/uploads/*` static; `/api/v1/media/file/{key}` (intentionally public, whitelist-regex keys); Centrifugo WS+HTTP API.
- **Private/server-only:** `LOCATION_SERVICE_API_KEY`, `CENTRIFUGO_API_KEY`/`TOKEN_SECRET`, JWT secret, DB creds — never reach the browser (`VERIFIED` by code comments + usage).
- **CORS:** `CORSMiddleware` with `settings.cors_origins` list — must add new frontend origin on migration.
- **TLS:** terminated at provider edge (Railway/Vercel/Centrifugo domain); `--proxy-headers` already set (Cloud Run compatible).
- **Timeouts:** apiFetch 20 s; EB client 8 s (connect 4 s, pool 5 s); Redis 5 s; DB pool 30 s; verify queue 10 s; uvicorn default request handling (no explicit timeout).
- **VPC/IP needs:** none currently — everything rides public internet. `RECOMMENDATION`: Cloud Run → Supabase can stay public-egress (TLS); if a static outbound IP is ever needed (Supabase allowlisting / EB allowlisting), add a Serverless VPC Access connector + Cloud NAT — **not required today**.
- **Measured RTTs (from India dev machine, audit docs):** →Supabase pooler 15 ms TCP / 116 ms fresh connect / 12.5 ms warm SELECT; →EB Railway 93 ms TCP / ~634 ms cold TTFB; Railway edge `hkg1`. SA API service region `UNKNOWN` (likely dominant prod latency term — perf audit B-10).

---

## 11. Google Cloud Deployment Feasibility

| Existing | Recommended GCP service | Reason | Complexity |
|---|---|---|---|
| Railway SA API | **Cloud Run** (`asia-south1`) | Stateless, health endpoints exist, Dockerfile ready, `--proxy-headers` set, `PORT` contract same | **Low** |
| Embedded 60 s tick | **Cloud Scheduler → Cloud Run Job** (same image) | Exactly-once-per-fleet semantics; keeps API replicas clean; tick is idempotent and self-healing | Low-Medium (needs a job entrypoint — thin main calling the 4 services) |
| Reconcile sweep (every 15 min) | Same Job, second schedule or `--mode` flag | Read-only, longer-running | Low |
| Redis (optional) | **Memorystore Redis** — *or none* | Only rate-limit counters + dead arq path use it; in-memory fallback already exists. If rate limiting across replicas matters → Memorystore (basic). Otherwise skip initially | Low |
| arq "worker" | **Nothing** | Dead code — no worker/callers. Don't provision | — |
| Supabase Postgres | **Stay on Supabase** (short-term) *or* Cloud SQL (long-term) | Shared with EB — moving requires EB coordination; pooler already exists; region already Mumbai. If Cloud SQL later: `DB_POOLER_MODE=direct`, prepared caches back on, private IP via VPC connector | High (deferred) |
| Supabase/S3 storage | **Cloud Storage** (new adapter ~100 lines: `StorageBackend.save/open/delete`) *or* keep Supabase storage | Evidence bucket is small; GCS fits Cloud CDN + uniform IAM; media/file endpoint already abstracts URL generation | Medium |
| Centrifugo service | **Cloud Run** (own service) | WS supported on Cloud Run; stateless broker; needs `min-instances≥1` (idle cost) and request-timeout awareness (WS limited by service timeout ≤60 min) | Low-Medium |
| Vercel frontend | **Firebase Hosting** or **GCS+Cloud CDN+Load Balancer** | Pure static; Firebase Hosting is the simplest SPA path (rewrite to index.html, single-command deploy) | Low |
| Secrets | **Secret Manager** (+ `--set-secrets`) | Replaces scattered provider env | Low |
| Images | **Artifact Registry** + **Cloud Build** (or GitHub Actions + `gcloud run deploy`) | Existing Dockerfile builds as-is | Low |
| Observability | **Cloud Logging/Monitoring** | App already logs structured access lines + emits `X-*-Time` headers; stdout → automatic | Low |
| Load balancer | Only if multi-service under one domain (e.g. `/api` + static) or WAF needed | Optional |
| Cloud Tasks/Pub/Sub | Not needed now (no queue consumers) | — |

**Cloud Run lifecycle incompatibilities — `VERIFIED` none blocking; watch:**
- Ephemeral FS: `STORAGE_BACKEND=local` is already a prod warning — must be object storage (already true in prod, presumably).
- `min-instances=0` + embedded scheduler = **no ticks while idle** → scheduler must move to Job, or keep min=1.
- Request timeout ≤60 min default 5 min — longest request is media upload ≤10 MB, fine.
- WS on Centrifugo service: connections count against instance concurrency; set high concurrency + timeout 3600 s on that service only.
- Concurrency per instance: CPU-bound argon2 makes high concurrency counterproductive on the API (audit: verify p50 inflates under oversubscription).

---

## 12. Performance & Scalability Audit

Primary source: `docs/performance-audit/` (Oct 2026, measured against the **real** Supabase DB; figures cited as measured there). No new runtime measurements were taken in this audit.

| Issue | Evidence | Why it matters | Fix | Migration blocker? |
|---|---|---|---|---|
| pgbouncer txn-mode prepared-statement 503s | `database.py::_pgbouncer_connect_args` (B-01, **FIXED**) | Intermittent 503s on :6543 | Already fixed; on Cloud SQL/direct, set `DB_POOLER_MODE=direct` → caches back on (~1 RTT/query saved) | No |
| Transaction pooler costs ~2 RTT/query | B-02, audit doc | ~30–60 ms/request tax vs session mode | Prefer session :5432 or direct Cloud SQL | No |
| EB proxy latency | B-03 — was fresh TLS/call; **now pooled client** (`http_client.py`, limits 20/10/45 s) | Worst endpoint (~370–570 ms upstream) | Already remediated | No |
| Bootstrap amplification | B-04 — `GET /workspace` aggregate now exists (9 pooled sessions server-side) | Session-restore burst | Already remediated | No |
| Per-request users-table hit | B-05 — now 60 s `auth_cache` | +1 RTT everywhere | Already remediated | No |
| Scheduler sweep volume | B-06 — `run_due_repetitive` selects ALL repetitive tasks (Python-side grid walk); reconcile = ~3–4 queries/resource; 87 k/32 k/61 k pg_stat calls | DB churn grows with tenants; tick shares foreground pool | Index-gate candidate scans; batch reconcile (~6 queries/sweep) | No — but **size Job CPU accordingly** |
| 16.4 s `FOR UPDATE` bulk-release sweep | B-07 — `_mark_cleaning_work_done` lock contention | Rare multi-second stall | Bound/batch sweep | No |
| No pagination enforcement | B-08 — `_paged` ignores LIMIT/OFFSET; lists return full tenant tables | Linear degradation with growth; response-size unbounded | Real pagination | No |
| Polls while hidden | B-09 — raw `setInterval` in a few views | Wasted requests incl. costliest | usePolling/visibility gate (partially done — index shows 120 s/30 s) | No |
| Railway region vs Mumbai DB | B-10 `UNKNOWN` — SA API region unverified | Possibly dominant prod latency | **asia-south1 Cloud Run co-locates with the DB — likely a migration *win*** | — |
| Single uvicorn worker | B-11 | Concurrency ceiling | Cloud Run autoscaling replaces worker scaling | No |
| Argon2 CPU-bound under burst | `verify_queue.py`, `deploy/cloudrun.md` measured: verify p50 ~140 ms→470 ms when argon2 threads oversubscribe cores | Login burst = the scaling case (load harness exists for it) | Size `VERIFY_MAX_WORKERS` ≈ instance vCPU (e.g. 2 on 2 vCPU); concurrency ~20/instance | No |
| No app caching | redis doc — every read hits Postgres | Cold-start + burst sensitivity | Acceptable now; Memorystore cache later if needed | No |
| Media uploads buffered fully in memory | `media.py::_read_bounded` reads ≤10 MB into RAM | 10 MB × concurrent uploads ≈ bounded but real RAM | Acceptable at 10 MB cap; stream to GCS later if sizes grow | No |
| Pool ceiling math | `cloudrun.md` — 10 conns/worker × workers × instances vs Supabase pooler cap (shared with EB!) | Max-instance × pool oversubscribes shared DB | Keep `DB_POOL_SIZE` small; budget: instances×10 + EB pool < pooler cap | **Yes — must size before scaling out** |

**DB session-pooler caveat (`VERIFIED` via `.env.example` note):** on :5432 session mode, each pooled client pins a real backend — total clients across ALL services must fit Supabase pool_size. Direct Cloud SQL removes this class of issue.

---

## 13. Cloud Run Configuration Recommendations (asia-south1)

| Setting | API service | Scheduler Job | Centrifugo service | Rationale |
|---|---|---|---|---|
| CPU | 1–2 vCPU (start 1, raise if verify-heavy) | 1 vCPU | 1 vCPU | Argon2 is the only CPU hog; audit: oversubscription inflates verify p50 |
| Memory | 1 GiB | 512 MiB | 256–512 MiB | argon2 64 MiB × `VERIFY_MAX_WORKERS` + ~400 MiB baseline |
| Concurrency | 20–40 | n/a (job) | 200+ | CPU-bound login favors low API concurrency; Centrifugo is I/O-bound WS |
| Min instances | 1 (avoid cold boots; also keeps EB client warm) | n/a | 1 (WS needs a live broker) | Boot is ~2–4 s incl. DB+schema probe |
| Max instances | Start 4 — **bounded by DB pool budget: 4×10=40 conns + EB share < Supabase pooler cap** | n/a | 2–4 | B-11/§12 |
| Request timeout | 60 s | job timeout ≥10 min | 3600 s (WS) | Covers verify-queue deadline + uploads |
| Probes | startup `/ready` (failureThreshold high — boot does DB probe+schema check), liveness `/health` | — | health endpoint enabled in config | `check_schema_version` can legitimately refuse boot |
| Workers | `--workers 1`; scale via instances (matches Dockerfile + cloudrun.md guidance) | — | — | Multi-worker multiplies pool × argon2 without vCPU |
| `VERIFY_MAX_WORKERS` | 2 (on 2 vCPU) — total fleet argon2 ≈ fleet vCPUs | — | — | audit-measured sweet spot |
| VPC | none initially (public egress to Supabase/EB over TLS); add VPC connector + Cloud NAT only if static egress IP required | — | — | §10 |
| Secrets | Secret Manager: `DATABASE_URL`, `JWT_SECRET_KEY`, `SUPABASE_SECRET_KEY`, `S3_*`, `LOCATION_SERVICE_API_KEY`, `CENTRIFUGO_*` | same | `CENTRIFUGO_*` | §8 |
| `RUN_EMBEDDED_SCHEDULER` | **false** once Job deployed | n/a | — | prevents N-replica ticks |
| Deploy | Cloud Build → Artifact Registry → `gcloud run deploy --image` (GitHub Actions can invoke via WIF — no long-lived keys) | same pipeline | same image source (`centrifugo/centrifugo:v6` + config COPY) | replace Railway/Vercel workflow steps |
| Frontend | Firebase Hosting (simplest) or GCS+CDN; rewrite `** → /index.html`; set `VITE_API_URL` to new API domain at build | — | — | §3 |

---

## 14. Migration Risk Register

| Risk | Component | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| Shared `alembic_version` with EB — stamp mismatch → boot refusal | API ↔ DB | **Critical** | Medium | Coordinate with EB repo before any DB move; keep `check_schema_version`; Dockerfile already tolerates shared stamps; migrate DB only with EB in lockstep (same window, dual-chain awareness) |
| Pool exhaustion at scale-out (instances×pool + EB share > Supabase pooler cap) | API ↔ DB | High | Medium | Cap `max-instances` to budget; keep `DB_POOL_SIZE=5`; monitor `pg_stat_activity`; prefer session :5432→direct later |
| Cold start misses scheduler ticks (min=0) | scheduler | Medium | Medium | Move tick to Cloud Scheduler+Job (recommended) |
| Duplicate ticks across replicas | scheduler | Low | High (if embedded left on with N>1) | Idempotent by design, but wasteful — set `RUN_EMBEDDED_SCHEDULER=false` when Job exists |
| Lost post-commit notices during scale-in | EB notices / Centrifugo | Low | Medium | Already best-effort + EB ledger backstop; Cloud Run SIGTERM→graceful drain reduces window |
| Local-storage uploads orphaned on instance recycle | media | High if misconfigured | Medium | `STORAGE_BACKEND≠local` in prod (already a boot warning); migrate `backend/uploads/` dev files if needed |
| Media URL origin change breaks stored `url` fields | media | Medium | Medium | `/media/file/{key}` is origin-relative — keep serving through API; `storage_key_from_url` reverse-maps |
| CORS rejections after domain move | frontend↔API | Medium | Medium | Update `CORS_ORIGINS` + Centrifugo `allowed_origins` + EB CORS in same change |
| JWT/session invalidation | auth | Low | Low | Secrets unchanged → sessions survive; only `localStorage` origin changes if domain changes (re-login) |
| Centrifugo WS on Cloud Run — idle connection cost / timeout | realtime | Medium | Medium | min=1 instance; timeout 3600 s; frontend already degrades to polling |
| Public `/media/file/{key}` exposure | security | Low | Low | Whitelist-regex + unguessable 128-bit keys; rate-limited; acceptable |
| Rate-limit cross-instance inconsistency w/o Redis | security | Medium | Medium | In-memory fallback is per-instance → limits ×N instances; use Memorystore if parity needed |
| DNS cutover / TTL | all | Medium | Medium | Lower TTL pre-migration; run parallel during soak |
| Region availability (asia-south1) | all | Low | Low | All target services GA in asia-south1 |
| EB latency stays high (US-region EB?) | live locations | Medium | High | `UNKNOWN` EB region — co-migration or regional placement is a follow-up; SA-side fix already shipped (pooled client) |
| Rollback | deploy | Medium | Medium | Keep Railway service frozen (not deleted) during soak; revert DNS; Cloud Run revisions make app rollback instant |
| Load-test credentials file | tests | Low | Low | gitignored, but `tests/load/credentials.json` exists locally — keep it that way |
| No CI test gate today | CI | Low | Medium | Migration is a good point to add `pytest` + `tsc` steps |

---

## 15. Migration Roadmap (recommended sequence)

1. **Foundations** — GCP project, Artifact Registry, Secret Manager; seed all §8 secrets; Cloud Build trigger or GH Action via Workload Identity Federation.
2. **API to Cloud Run (asia-south1)** — build `backend/Dockerfile` → deploy with `RUN_EMBEDDED_SCHEDULER=true` initially (keeps today's exact behavior, incl. ticks) → smoke `/ready`, `/api/v1/health`.
3. **Frontend to Firebase Hosting** — build with new `VITE_API_URL`; SPA rewrite; update `CORS_ORIGINS`; keep Vercel deployment frozen as instant rollback.
4. **Scheduler extraction** — add Job entrypoint (`RUN_EMBEDDED_SCHEDULER=false` on API), Cloud Scheduler `* * * * *` tick + `*/15` reconcile.
5. **Centrifugo to Cloud Run** — redeploy image+config; update `CENTRIFUGO_URL/WS_URL` + allowed origins; verify `priv` JWT flow; EB side vars updated by its own repo (coordination).
6. **Optional Redis (Memorystore basic)** — only if cross-instance rate limiting is required; otherwise defer.
7. **Storage to GCS** (optional) — implement `GCSStorage(StorageBackend)`; migrate bucket objects; flip `STORAGE_BACKEND`.
8. **Postgres decision point** — *recommended:* stay on Supabase initially (shared with EB; already Mumbai; pooler solves fan-out). Revisit Cloud SQL only with EB repo owners — shared alembic chain makes a unilateral move unsafe.
9. **Decommission** — Railway SA service last, after soak; update GH workflows to GCP deploy path; delete Railway/Vercel secrets from repo settings.

---

## 16. Open Questions & Unknowns

| # | Question | Status |
|---|---|---|
| 1 | **Where does the prod generation tick actually run?** `RUN_EMBEDDED_SCHEDULER=false` is documented intent ("arq worker owns ticks") but no arq worker exists anywhere — if prod sets false, ticks may not run at all | `UNKNOWN` — check Railway env today |
| 2 | Is `REDIS_URL` set in production? | `UNKNOWN` (env-only; changes rate-limit consistency + enables dead arq path) |
| 3 | Railway SA API service region? (B-10 — possibly the dominant latency term) | `UNKNOWN` — Railway dashboard |
| 4 | Employee Backend repo, region, and its alembic revisions beyond `u7e1f5a9d3c6`? | `UNKNOWN` — separate repo, required for DB-migration planning |
| 5 | Actual `STORAGE_BACKEND` in prod + whether evidence objects live in Supabase bucket | `INFERRED` supabase/S3 (local would warn); verify env |
| 6 | Supabase plan's pool_size cap (governs max-instances)? | `UNKNOWN` — dashboard |
| 7 | EB `notify-allocation` endpoint contract + its ledger-synthesis backstop semantics | `INFERRED` from `employee_events.py` — contract lives in EB repo |
| 8 | Are `CENTRIFUGO_*` vars set in prod (realtime enabled)? | `UNKNOWN` |
| 9 | Railway Redis — is it shared with EB? | `INFERRED` yes per audit doc; unverified |
| 10 | OSM tile-usage policy compliance at expected map-poll volume | `RECOMMENDATION`: evaluate Google Maps / tile cache if volume grows |

---

## Appendix — Audit completeness checklist

- [x] All major dirs inspected: `backend/app/{api,core,dependencies,domain,models,repositories,schemas,services}`, `alembic/`, `backend/{scripts,tests}`, `frontend/src/{api,components,context,lib,realtime}`, `deploy/`, `tests/load`, `.github/workflows`, `docs/`
- [x] Dependency manifests: `requirements.txt`, `requirements-dev.txt`, `package.json`, `tests/load/requirements.txt`
- [x] Deploy/CI: `railway.toml`, `Dockerfile`, `vercel.json`, `deploy/centrifugo/*`, `deploy/cloudrun.md`, both workflows
- [x] DB init points: `create_async_engine` (`database.py:162`), `get_db` (:314), `check_database` (:334), `check_schema_version` (`main.py:47`), `alembic/env.py`
- [x] All background work accounted: embedded tick (4 steps + 15-tick reconcile), 2 post-commit dispatch hooks, dead arq path, manual load harness
- [x] No secrets printed — only variable names, non-sensitive hosts/URLs already public in docs/config
- [x] Inaccessible: EB repository, Railway/Supabase/Vercel dashboards (items flagged `UNKNOWN` above)

**Bottom line:** compute migrates cleanly (API→Cloud Run, SPA→Firebase/GCS, Centrifugo→Cloud Run, tick→Scheduler+Job). The genuinely hard dependency is the **Supabase Postgres shared with the Employee Backend** — treat it as a joint-systems decision, not a lift-and-shift.
