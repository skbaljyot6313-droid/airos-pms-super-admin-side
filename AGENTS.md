# Management Tool — codebase map

Property operations management SaaS (a.k.a. "AiROS" / "Airco PMS"). Multi-tenant:
a `Company` owns `Property`s; non-super-admin users are scoped by
`user.property_id`. Roles exist for `super_admin`, `property_manager`,
`human_resource`, `department_manager`, `employee` — but only super_admin and
property_manager have a surface in this repo; the employee experience lives in
a separate application (employee/HR logins land on `/` with no permissions).

## Layout

```
main.py                 # dev launcher: frees :8000/:3000, runs uvicorn --reload + vite dev
backend/                # FastAPI + SQLAlchemy 2 async + asyncpg + Alembic
  app/main.py           # lifespan, middleware, /health /ready, embedded scheduler
  app/api/v1/           # router.py mounts: auth, workspace, media, work_batches,
                        #   templates, attendance, locations — all under /api/v1
  app/domain/           # pure state-transition rules (resource_states,
                        #   transitions, resource_events)
  app/core/             # config.py (pydantic-settings, single config source), database,
                        #   security (JWT HS256 30min + hashed refresh tokens 30d, argon2),
                        #   redis, queue (arq), rate_limit, storage (local/s3/supabase)
  app/dependencies/auth.py  # get_current_user, require_role; company_id = tenant scope
  app/models/           # see Domain below
  app/services/         # business logic (Router → Service → Repository → SQLAlchemy)
  app/repositories/     # data access; workspace.py holds company/property scoping
  alembic/versions/     # 35 migrations; NEVER hand-edit the schema
frontend/               # React 19 + TS + Vite 8 + Tailwind v4 + react-router-dom 7
  src/App.tsx           # routes + RequireAuth/RequireRole/PropertyScopedView guards
  src/context/AppContext.tsx  # god-context: session, all collections, all mutations, toasts
  src/api/              # thin wrappers over apiFetch (client.ts: bearer, refresh-on-401 once)
  src/lib/permissions.ts      # client-side can() mirror of role rules
```

## Domain model (Postgres is the only source of truth)

- **Structure**: Property → Area (floor levels) → Zone (`zone_type`; only `stay`
  holds rooms/dorms) → Room | Dorm → Bed. Washroom: dorm-attached (`dorm_id`
  set, 1-per-dorm unique) or zone-level. WashroomFixture = real per-fixture
  rows w/ own status (`operational|maintenance|inactive`).
- **Occupancy**: `occupancies` rows are the occupancy truth — open iff
  `checked_out_at IS NULL`; room- or bed-scoped. `occupied` is illegal
  without an open row; checkout closes the row + spawns the cleaning task +
  flips to `cleaning` atomically (`services/occupancy.py`). Dorm occupancy
  is derived from its beds.
- **Task**: `pending → assigned → in_progress → completed`, `reopened` via
  request-redo/reopen. Staff close work directly via `POST /tasks/{id}/complete`
  (photo evidence required) — the employee submit/approve/reject review
  pipeline was removed; `submitted` remains a legacy status in the DB.
  Completion writes a TaskCompletionSubmission attempt + TaskCompletionImage
  evidence (models kept — `complete_task` still records them).
  `task_type`: fixed | repetitive | automated (`automation_rule` JSONB).
  `series_id` links recurring clones. Partial unique index
  `uq_tasks_open_room_title` = one open task per (property, room, title).
  Recurring instances (template- or series-generated) carry
  `scheduled_for`/`expires_at` — the occurrence instant and the NEXT
  scheduled boundary. `RolloverService.expire_due` abandons unfinished
  (non-`submitted`) instances at `expires_at` with reason
  `NEXT_SCHEDULED_OCCURRENCE` BEFORE generation runs (tick order matters:
  an open predecessor must not block its successor). `submitted` survives
  expiry; the daily op-day rollover (`SYSTEM_DAILY_ROLLOVER`) skips
  still-valid instances. `uq_tasks_series_due` = one row per
  (series_id, due_date).
- **MaintenanceTicket**: `open → assigned → in_progress → on_hold → resolved
  → closed | cancelled`; disapprove reopens. Staff-only creation (the
  employee "raise ticket" flow was removed). Exactly one target:
  room | dorm | bed | washroom(+fixture). `MT-YYYY-NNNNN` from PG sequence.
- **Employee**: full management surface — CRUD + zone/area allocation
  (`/property/:uid/employees`, ZoneBoard drag-drop + directory). Employee
  login still has no surface — staff accounts only.
- **Attendance** (`services/attendance.py`, `api/v1/attendance.py`):
  super_admin reviews leave/week-off requests filed in the employee app —
  shared DB tables `attendance_requests`/`attendance_days`. Approve stamps
  every date in the inclusive range with the day status (worked day in
  range → 409; overlapping open request → 409); reject just marks.
- **Live locations** (`services/live_location.py`): server-to-server proxy
  to the Employee Backend — `GET /live-locations` (super_admin, optional
  `employee_id`/`property_id`/`zone_id`/`is_active` filters — all
  company-scope-validated in `api/v1/locations.py` before forwarding),
  `GET /live-locations/{uid}` (live-or-stale single lookup), and
  `GET /live-locations/{uid}/history` (`from`/`to` UTC, ≤31d span,
  `tracking_session_id`, `max_points` 1–100000) forward to
  `{EMPLOYEE_API_BASE_URL}/admin/...` with header
  `X-Location-Service-Key: LOCATION_SERVICE_API_KEY`. Base URL resolution:
  `EMPLOYEE_API_BASE_URL` (full `…/api/v1` base, prod value
  `https://employee-api-production-c0e3.up.railway.app/api/v1`) wins over
  legacy `EMPLOYEE_BACKEND_URL` + `/api/v1`. Key never reaches the browser;
  coordinates are never stored/logged. 400 passes upstream filter/range
  codes through, 502 on auth-reject/malformed, 503 on unreachable/
  unconfigured. Frontend polls every 10s from the Employees → Live
  Location tab (Leaflet + leaflet.markercluster — co-located staff
  cluster and spiderfy at max zoom; auto-fits live bounds, yields to
  manual pan/zoom until Recenter; markers keyed by employee UUID;
  `is_live`/`is_stale` are authoritative — null coords never render a
  marker). Each location also carries `work_status`
  (`services/attendance.py::current_work_statuses`) resolved from the
  shared `attendance_days`/`attendance_breaks` rows: open day →
  working, +open break → on_break, closed/marked op-day → off_duty,
  else unknown. GPS/tracking-session activity is NEVER treated as
  working — attendance is the only source of truth. Both live
  endpoints then filter to on-duty staff only (`working`/`on_break`);
  employees who never clocked in or already clocked out are dropped
  server-side (single lookup → `{"location": null}`), so map bounds,
  clusters, and counts only ever reflect clocked-in staff.
- **Shifts & day metrics** (`services/shifts.py`, `api/v1/shifts.py`,
  `GET /attendance/status-board`): shared tables `shifts` (company/
  property-scoped definitions — `start_time`/`end_time` IST, `end <=
  start` = overnight, `grace_minutes`, `early_exit_minutes`, Monday-first
  `working_days` bitmap, `is_active`) + `employee_shift_assignments`
  (`effective_from`/`effective_until`, overlap prevented, history
  retained — metrics resolve the assignment effective on the evaluated
  date, never the current one). Routes are `require_property_manager`
  + `_assert_company_scope`, so PMs manage only their property's staff.
  `status_board()` in `services/attendance.py` is the ONE authoritative
  evaluator: open day → working/on_break; ended day → completed
  (arrival vs shift start+grace → on_time|late; departure vs end−
  tolerance → on_time|early); scheduled past cutoff → absent;
  pre-shift → awaiting/scheduled; leave/week_off → off_day; clock-in
  with no applicable assignment → unscheduled; open day from a prior
  op-day whose scheduled window has passed → `incomplete` +
  `needs_review` (fail closed — never grants floor presence).
  `floor_eligible` = `working`/`on_break` only. Zone Board cards
  filter to `floor_eligible` via `attendanceApi.statusBoard` (30s
  poll, fails closed); Employees → Shifts/Attendance tabs expose
  `ShiftManager` + `AttendanceBoard` to SA and PM.
- **WorkTemplate**: JSONB config (assignment/location/schedule/checklist/
  verification/overdue/notifications), versioned (WorkTemplateVersion);
  `next_run_at` drives the scheduler; TemplateGeneration ledger
  (`template_id + occurrence_key` unique) makes generation idempotent.
- **Work allocation** (`services/work_allocation.py`): persistent zone
  round-robin (ZoneAllocationState row locked FOR UPDATE), area-level
  employee pool as fallback, department eligibility by work_type
  (cleaning→housekeeping, maintenance→maintenance/engineering).
  WorkAllocationBatch = one POST → N tickets, one employee per unit.
  `allocate_units()` = batched zone-aware path used by template
  generation: one property-wide staff/workload fetch, pools grouped by
  zone in memory, one lock + rotation seed per scope — a unit NEVER
  leaves its zone pool (zone ∪ covering-area fallback only).
  Manual reassign never moves the pointer; everything audited in
  WorkAllocationHistory. `record()` also buffers an allocation event on
  `session.info` — a Session-level `after_commit` hook (in
  `app/core/database.py`, registered on the sync `Session` class;
  `async_sessionmaker` isn't a valid event target) POSTs it to the
  Employee Backend `POST {EMPLOYEE_API_BASE_URL}/admin/notify-allocation`
  with `X-Location-Service-Key` (`services/employee_events.py`). Nested
  savepoint commits/rollbacks are skipped so only the real commit
  dispatches; delivery is best-effort (`LOCATION_SERVICE_TIMEOUT_SECONDS`
  cap, all failures logged+swallowed — allocation never depends on EB),
  and EB's ledger synthesis is the recovery backstop.
- **ResourceStateService** (`services/resource_state.py`): THE authoritative
  status writer for room/bed/dorm/washroom/fixture. All status writes funnel
  through `transition()` / `derive()` / `repair()`; status is DERIVED from
  blocking work (open maintenance → "maintenance", open cleaning task →
  "cleaning") + open occupancy. Rows locked FOR UPDATE; tenant scope checked
  per resource; task completion releases a resource. Canonical
  states + the legal transition table live in `app/domain/`.
- **Reconciliation** (`services/reconciliation.py`): read-only drift scan;
  repair goes through `POST /resources/{type}/{id}/repair` (super_admin).
- **Audit**: `audit_events` (entity lifecycle, actor, property-scoped) +
  `allocation_events` + per-ticket/task event streams.

## Scheduling & infra

- Dev (`RUN_EMBEDDED_SCHEDULER=true`, default): asyncio loop in the API ticks
  `TemplateService.run_due()` + `TaskService.run_due_repetitive()` every 60s.
- Redis: rate limit (sliding window, in-memory fallback), arq queue client.
  Optional in dev.
- Media: `POST /media/uploads` → `STORAGE_BACKEND` local (`/uploads` mounted)
  or S3/Supabase storage (`auto` picks S3 when creds exist).

## Frontend notes

- `apiFetch` throws `ApiError` (status + fieldErrors); on 401 tries
  `/auth/refresh` once then fires `onUnauthorized` → AppContext logout.
- All wire IDs are `*_uid` strings; backend serializes UUID → `*_uid` in
  `schemas/*/…_out()` mappers.
- `WorkspaceGate` shows skeleton/error states; views are React.lazy.
- Mutations update AppContext collections directly; `refreshUnits()`
  re-pulls rooms/dorms/washrooms after complete/reopen (server
  re-derives statuses).

## Commands

```bash
python main.py                                     # dev: backend :8000 + frontend :3000
cd frontend && npx tsc --noEmit && npm run build   # typecheck + build
cd frontend && npm test                          # vitest
cd backend && pytest tests/                      # needs requirements-dev.txt
cd backend && alembic upgrade head               # migrate
```

Env: backend reads `backend/.env` (see `.env.example` files). Required:
`DATABASE_URL` or `SUPABASE_DB_PASSWORD`, `JWT_SECRET_KEY`, `CORS_ORIGINS`,
`STORAGE_BACKEND` (+`S3_*` for object storage).
Live locations: `EMPLOYEE_BACKEND_URL` (e.g. `http://localhost:8001`) +
`LOCATION_SERVICE_API_KEY` — must equal the same key in the employee
backend's env.

## Gotchas

- DB has no hardcoded default — `DATABASE_URL` (or `SUPABASE_DB_*` parts)
  must come from env; boot fails fast otherwise.
- Boot refuses to start if `alembic_version` ≠ script head
  (`check_schema_version` in `app/main.py`) — including a DB migrated by a
  different branch of this codebase.
- The Postgres DB is SHARED with the Employee Backend, whose Alembic chain
  mirrors this repo's through `s5c9e3a7d1f4` and then applies its own
  revisions on the same `alembic_version` row. `u7e1f5a9d3c6` records the
  EB-owned tables (`location_tracking_sessions`, `mobile_releases`) so SA
  can resolve the shared stamp — do not `alembic stamp` over EB
  revisions; extend the chain instead.
- `backend/uploads/` holds dev-uploaded images referenced by the DB —
  gitignored, but do not delete casually.
- Backend route permission shortcut: `Staff = Depends(require_property_manager)`
  (super_admin + property_manager).
