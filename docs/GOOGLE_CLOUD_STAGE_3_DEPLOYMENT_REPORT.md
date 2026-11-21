# Stage 3 Report — `airos-sa-api-dev` Cloud Run Deployment

**Date:** 2026-11-02 · **Project:** `final-airos-os` (#94363806721) · **Region:** `asia-south1`

## Source

- Repo `airos-pms-super-admin-side`, branch **`development-branch`**, commit **`cc0a4d2`** (WIP committed so the image carries a traceable SHA; 3 junk `NUL` files removed).
- Build context `backend/`; `backend/Dockerfile` (py3.12-slim → `alembic upgrade head || echo; uvicorn … ${PORT:-8080}`). `.env` excluded from upload (gitignored).

## Image & Artifact Registry

- Repo `airos-dev` (DOCKER, asia-south1, "AiROS dev API images").
- Image `super-admin-api:dev-cc0a4d2`, digest **`sha256:dae25ddc04f08c924f23a0b73eafd6ac3bf24d4eaf497e651fa650d0f5d96cbb`**, built via Cloud Build `b59a343c` (remote — no local Docker needed).

## Cloud Run `airos-sa-api-dev`

| Setting | Value |
|---|---|
| URL | `https://airos-sa-api-dev-94363806721.asia-south1.run.app` |
| Revision serving | `airos-sa-api-dev-00002-sqt` (100%) |
| CPU / Mem / Concurrency | 2 vCPU / 1 GiB / 20 |
| Scaling / timeout | min **1**, max **4**; 60 s |
| Port / workers | 8080; `UVICORN_WORKERS=1` |
| Cloud SQL | `--add-cloudsql-instances` → `airos-postgres-dev` (unix socket) |
| Runtime SA | `airos-sa-dev-runtime@` — `roles/cloudsql.client` + `secretAccessor` on the 3 dev secrets only (no Editor/Owner, no JSON key) |
| Ingress | `--allow-unauthenticated` — required for browser/dev use; **all app routes remain JWT-gated** (verified below). Probes rely on platform default TCP/port startup check. |
| Secrets (refs) | `DATABASE_URL` ← `airos-dev-database-url`, `JWT_SECRET_KEY` ← `airos-dev-jwt-secret` |
| Env | `APP_ENV=production`, `DEBUG=false`, `DB_POOLER_MODE=direct`, `RUN_EMBEDDED_SCHEDULER=false`, `STORAGE_BACKEND=local`, `VERIFY_MAX_WORKERS=2`, pool 5+5, `CORS_ORIGINS=http://localhost:3000`, timing on. `EMPLOYEE_API_BASE_URL`/`LOCATION_SERVICE_API_KEY`/`CENTRIFUGO_*`/`REDIS_URL` deliberately **unset** → no prod EB calls, realtime off, in-memory rate limiting |
| DB budget | 4 inst × (5+5) = **40 conns max ≤ budget** |

## Validation (all against live service)

| Check | Result |
|---|---|
| `/health` | 200 `{status:ok, env:production}` |
| `/ready` + `/api/v1/health` | 200 `{db:connected, schema:current, redis:disabled}` |
| `/health/db` | 200 connected → **`airos_dev` via connector** |
| `/api/v1/auth/me` no token | **401** `UNAUTHENTICATED` (JWT enforced) |
| `/api/v1/auth/login` bad creds | **401** `INVALID_CREDENTIALS` uniform envelope (argon2 verify path works) |
| Credential leak scan | clean — only expected `STORAGE_BACKEND=local` prod warning |
| Prod/external contact | none — no EB URL, no Redis, no Supabase envs |

## Incident & fix

Revision `00001` failed: Git Bash path-mangled `--set-env-vars` values (`API_V1_PREFIX`→`C:\Program Files\Git\api\v1`, `CORS_ORIGINS`→`http;\localhost;3000`). Fixed by deploying with `--env-vars-file` (YAML map) — revision `00002` healthy. **Lesson for CI: never pass slash/colon env values through MSYS args.**

## Blockers remaining

- Media storage is local/ephemeral (uploads vanish on instance recycle) — acceptable for dev; dev bucket needed before real evidence testing.
- Embedded scheduler **disabled** per stage rules — no tick runs yet (Cloud Scheduler/Job stage later).
- Frontend still points at localhost:8000 — deploy/stage frontend or set `VITE_API_URL` to the dev URL.
- Branch protection + WIF wiring for CI deploys still open (remediation plan).

## Rollback

`gcloud run services update-traffic airos-sa-api-dev --to-revisions=airos-sa-api-dev-00001-qgk=0` style split, or redeploy previous image tag `dev-<sha>`; service is disposable — `gcloud run services delete airos-sa-api-dev` removes it entirely without touching data (`airos_dev` persists, deletion-protected instance).
