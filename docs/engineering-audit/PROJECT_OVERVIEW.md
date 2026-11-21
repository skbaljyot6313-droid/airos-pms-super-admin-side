# Project Overview — Management Tool (AiROS / Airco PMS, Super-Admin Side)

_Audit date: 2026-11-17 · Scope: `super-admin` repository (backend + frontend), with the shared-database
contract to the separate `employee` repository noted where it affects risk. Read-only audit; no source
code was modified._

## What the application does

Multi-tenant property operations management SaaS. A `Company` owns `Property`s; staff
(`super_admin`, `property_manager`) manage zones, rooms/dorms/beds, washrooms, employees,
housekeeping/maintenance work, occupancy, attendance review, shift definitions and live location
monitoring. A separate employee-facing application (separate repo + Cloud Run service) shares the
same PostgreSQL database and the same `alembic_version` row.

## Technology stack (verified)

| Layer | Technology |
|---|---|
| Backend | Python 3.12, FastAPI ≥0.115, SQLAlchemy 2 (async), asyncpg, Alembic (43 revisions), Pydantic 2 / pydantic-settings |
| Frontend | React 19.0.1, TypeScript 7 (native toolchain), Vite 8, Tailwind CSS 4, react-router-dom 7, lucide-react, @dnd-kit, centrifuge-js, Leaflet + markercluster |
| Database | PostgreSQL (Cloud SQL `airos-postgres-dev` / Supabase pooler in dev) — single shared DB with the employee backend |
| Auth | JWT HS256 access (30 min) + hashed random refresh tokens (30 d, `refresh_tokens` table), argon2 password hashing, bounded `verify_queue` executor |
| Object storage | Pluggable `StorageBackend`: local / S3-compatible / GCS / Supabase (`STORAGE_BACKEND`, `auto` resolution) |
| Realtime | Optional Centrifugo (channels under `priv` namespace, per-channel JWT) — events are invalidation hints, not truth |
| Queue | `arq` + Redis client exists but `enqueue()` has **zero callers** (dead path in this repo) |
| Scheduling | Embedded asyncio loop (dev) + `POST /internal/generation-tick` (X-Cron-Key) for deployed Cloud Scheduler sweep |
| Hosting | Backend: Cloud Run `airos-sa-api-dev` (asia-south1); frontend: Firebase Hosting `airos-super-admin-dev` |
| Testing | pytest + pytest-asyncio + respx (backend, 18 files / ~249 tests); Vitest + Testing Library (frontend, 12 test files); **no E2E suite** |

## Main modules

- `backend/app/api/v1` — 145 route handlers across 10 routers (`workspace` is the monolith: ~99 routes).
- `backend/app/services` — business logic; largest: `structure.py` (2,217 LOC), `template.py` (1,532), `task.py` (1,515), `employee_profile.py` (1,255), `work_allocation.py` (1,042).
- `backend/app/domain` — pure state-transition rules (resource states, legal transition table).
- `backend/app/core` — config, database (pooling, lock_timeout, after_commit hooks), security, rate limit, storage, middleware (request-id, access log, security headers), centrifugo, queue.
- `frontend/src` — `context/AppContext.tsx` god-context (2,733 LOC), `api/` thin wrappers, `components/` by domain, `realtime/`, `dev/perf.ts` instrumentation.

## Existing capabilities

Zone-based work allocation (round-robin, area fallback, secondary-zone + whole-property coverage),
occupancy lifecycle (check-in/out/switch with cleaning automation), task lifecycle incl. employee-app
review queue, maintenance tickets, shifts + attendance status board, live employee locations
(server-to-server proxy to the employee backend), work templates with idempotent generation ledger,
audit logging, resource-state derivation/repair, day-analysis views.

## Verified strengths

- Disciplined layering (Router → Service → Repository) in most of the backend.
- Consistent tz-aware datetimes (`timezone.utc`, explicit IST via `ZoneInfo`) — no `utcnow()` usage.
- Every API endpoint resolves an authenticated `User`; tenant scoping enforced per-service.
- Upload pipeline: magic-byte signature checks, 10 MB bounded read, traversal-safe uuid keys,
  rate-limited, timed logging.
- Refresh tokens hashed at rest; secrets excluded from `repr()`; prod-misconfig warnings are
  **fatal at boot**.
- Batched serialization (`_tasks_list_payload` uses `IN()` lookups, no per-row queries);
  `/workspace` aggregates 9 collections over pooled parallel sessions.
- 26 `FOR UPDATE` lock sites; partial unique indexes encode invariants
  (`uq_tasks_open_room_title`, `uq_tasks_series_due`, open-occupancy indexes).
- Zero `print()` calls; structured `get_logger` throughout.
