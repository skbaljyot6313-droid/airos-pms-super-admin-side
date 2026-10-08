# AiROS Super Admin

Property operations management platform — Super Admin / Property Manager surface.
Monorepo: `backend/` (FastAPI + SQLAlchemy async + PostgreSQL) and `frontend/`
(React 19 + TypeScript + Vite + Tailwind).

## Production architecture

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

Pushing to `main` automatically deploys the backend on Railway and the
frontend on Vercel — no manual deploy step is required.

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

Railway runs `alembic upgrade head` at container start, before uvicorn
(see `backend/railway.toml`). Locally: `cd backend && alembic upgrade head`.
The API refuses to boot if `alembic_version` ≠ the script head.

## Deploying changes

```bash
git add . && git commit -m "…" && git push origin main
```

GitHub → Railway rebuilds and redeploys the API; GitHub → Vercel rebuilds
and redeploys the web app.

## Rollback

- Vercel: promote a previous deployment in the dashboard.
- Railway: redeploy a previous deployment, or `git revert` and push.
- Database: `alembic downgrade` only with an explicit backup plan — the
  production database is shared with the AiROS employee platform.

## Secrets

Secrets live only in Railway/Vercel environment variables and local `.env`
files — never in the repository. Deployment tokens are used by CI/CLI only
and must never be committed or exposed to the browser.
