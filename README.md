# AiROS Super Admin

Property operations management platform — Super Admin / Property Manager surface.
Monorepo: `backend/` (FastAPI + SQLAlchemy async + PostgreSQL) and `frontend/`
(React 19 + TypeScript + Vite + Tailwind).

## Development deployment (current — `development-branch`)

The active deployment is the **dev environment on GCP project `final-airos-os`
(asia-south1)**, deployed **manually via gcloud/firebase CLI** — no GitHub
workflow deploys it:

| Piece | Where |
|---|---|
| Super Admin API | Cloud Run `airos-sa-api-dev` (`asia-south1-docker.pkg.dev/final-airos-os/airos-dev/super-admin-api`, built via Cloud Build from `backend/Dockerfile`) |
| Web SPA | Firebase Hosting site `airos-super-admin-dev` (`frontend/firebase.json`, deployed by `backend/scripts/firebase_deploy.py`) |
| Database | Cloud SQL `airos-postgres-dev` / `airos_dev` — **shared with the Employee Backend** (`airos-eb-api-dev`); both Alembic chains extend the same `alembic_version` row |
| Scheduler | Cloud Scheduler `airos-generation-tick` → `POST /internal/generation-tick` |

## Production architecture (legacy — `main` branch)

```
GitHub: airos-pms-super-admin-side
   │
   │  push / merge to main
   │
   ├──▶ Railway                    └──▶ Vercel
   │      Super Admin API                Super Admin Web (HTTPS)
   │      + Redis
   │
   └──▶ Shared AiROS PostgreSQL database (Supabase)
```

`.github/workflows/deploy-production.yml` still targets Railway (backend) +
Vercel (frontend) on pushes to `main`; `backend/railway.toml` and
`frontend/vercel.json` remain in-tree.

## Local development

```bash
python main.py            # backend :8000 + frontend :3000 together
```

Or separately:

```bash
cd backend && uvicorn app.main:app --reload        # API on :8000
cd frontend && npm run dev                         # web on :3000
```

## Environment variables

Copy `backend/.env.example` → `backend/.env` and
`frontend/.env.example` → `frontend/.env`. Never commit real secrets.

Backend (Railway service environment):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Async Postgres URL (`postgresql+asyncpg://…`) — or use `SUPABASE_DB_*` parts |
| `JWT_SECRET_KEY` | Token signing secret (required, production-only value) |
| `CORS_ORIGINS` | Comma-separated allowed origins — production = Vercel domain(s) |
| `REDIS_URL` | Railway Redis reference — rate limiting + queue |
| `APP_ENV` / `DEBUG` | `production` / `false` in production |
| `API_V1_PREFIX` | `/api/v1` |
| `STORAGE_BACKEND` + `S3_*` / `SUPABASE_*` | Media storage (object storage in prod) |
| `EMPLOYEE_BACKEND_URL`, `LOCATION_SERVICE_API_KEY` | Live-location proxy to the employee backend |
| `RUN_EMBEDDED_SCHEDULER` | `true` — in-process template/repetitive generation tick |

Frontend (Vercel environment):

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | `https://<railway-domain>/api/v1` |
| `VITE_MAX_COMPLETION_IMAGES` | Should match backend `MAX_TASK_COMPLETION_IMAGES` (10) |

## Health endpoints

- `GET /health` — liveness (process up).
- `GET /ready` and `GET /api/v1/health` — readiness (DB + Redis + schema head).

## Migrations

The Cloud Run image runs `alembic upgrade head` at container start (see
`backend/Dockerfile` — failures are non-fatal because the shared DB's
`alembic_version` row may be at an Employee-Backend revision; boot's own
`check_schema_version` validates the stamp). Locally:
`cd backend && alembic upgrade head`. The API refuses to boot if
`alembic_version` ≠ the script head.

## Deploying changes (dev)

```bash
git push origin development-branch          # code only — no auto-deploy
gcloud builds submit backend/ --tag <ar-tag> # build API image
gcloud run deploy airos-sa-api-dev ...       # rollout (see docs/)
cd frontend && npm run build && firebase deploy --only hosting:airos-super-admin-dev
```

## Rollback

- Vercel: promote a previous deployment in the dashboard.
- Railway: redeploy a previous deployment, or `git revert` and push.
- Database: `alembic downgrade` only with an explicit backup plan — the
  production database is shared with the AiROS employee platform.

## Secrets

Secrets live only in GCP Secret Manager (dev), Railway/Vercel environment
variables (legacy prod), and local `.env` files — never in the repository.
Deployment tokens are used by CI/CLI only and must never be committed or
exposed to the browser. `gcloud builds submit`/`run deploy --source` uploads
respect `backend/.gcloudignore` — keep it in sync with `backend/.dockerignore`
so `backend/.env` can never reach the build context.

<!-- deployment pipeline: dev = development-branch -> gcloud CLI -> Cloud Run + Firebase Hosting; legacy prod = main -> GitHub Actions -> Railway + Vercel -->
