# Management Tool — codebase map

Exhaustive lookup index (every endpoint, service, model, route, test, env var):
`docs/codebase-index.md` — generated 2026-10-30, refreshed 2026-11-02.

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
                        #   templates, attendance, locations, realtime — all under /api/v1
  app/domain/           # pure state-transition rules (resource_states,
                        #   transitions, resource_events)
  app/core/             # config.py (pydantic-settings, single config source), database,
                        #   security (JWT HS256 30min + hashed refresh tokens 30d, argon2),
                        #   verify_queue (bounded argon2 executor — login verify runs
                        #   off-loop; overload → 503 AUTH_QUEUE_* + Retry-After),
                        #   redis, queue (arq), rate_limit, storage (local/s3/supabase),
                        #   centrifugo (realtime tokens + post-commit publish)
  app/dependencies/auth.py  # get_current_user, require_role; company_id = tenant scope
  app/models/           # see Domain below
  app/services/         # business logic (Router → Service → Repository → SQLAlchemy)
  app/repositories/     # data access; workspace.py holds company/property scoping
  alembic/versions/     # 35 migrations; NEVER hand-edit the schema
frontend/               # React 19 + TS + Vite 8 + Tailwind v4 + react-router-dom 7
  src/App.tsx           # routes + RequireAuth/RequireRole/PropertyScopedView guards
  src/context/AppContext.tsx  # god-context: session, all collections, all mutations, toasts
  src/api/              # thin wrappers over apiFetch (client.ts: bearer, refresh-on-401 once)
  src/realtime/         # centrifuge-js client + useRealtimeChannel; events are
                        #   invalidation hints that refetch/merge — never the truth
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
  (photo evidence required). Employee-app work is instead **submitted for
  review** (`submitted` = PENDING_CHECK): staff decide it via the Tasks →
  Review tab → `GET /tasks/review-queue` (submissions+images eager-loaded)
  and `POST /tasks/{id}/approve` (→ `completed`, submission.approved) /
  `POST /tasks/{id}/reject` (→ `reopened`, submission.disapproved).
  Reviewers are staff-only (`_require_reviewer` — an employee, even the
  assignee, can never review); resource-targeted tasks additionally require
  `super_admin` (`_require_resource_authority`). Decisions write shared
  `notifications` rows (`submission_approved`/`_disapproved`) for the
  employee feed. Evidence images live in the SHARED object bucket and are
  serialized as `/api/v1/media/file/<key>` — SA serves that same path
  (`GET /media/file/{key}` streams via `StorageBackend.open`) so the
  frontend renders evidence same-origin.
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
  `floor_eligible` = `working`/`on_break` only — a display flag on the
  Attendance board. Zone Board shows ALL assignable employees;
  attendance does not gate floor visibility or allocation.
  Employees → Shifts/Attendance tabs expose `ShiftManager` +
  `AttendanceBoard` to SA and PM.
- **WorkTemplate**: JSONB config (assignment/location/schedule/checklist/
  verification/overdue/notifications), versioned (WorkTemplateVersion);
  `next_run_at` drives the scheduler; TemplateGeneration ledger
  (`template_id + occurrence_key` unique) makes generation idempotent.
- **Work allocation** (`services/work_allocation.py`): persistent zone
  round-robin (ZoneAllocationState row locked FOR UPDATE), area-level
  employee pool as fallback, department eligibility by work_type
  (cleaning→housekeeping, maintenance→maintenance/engineering). Attendance
  does NOT gate allocation — an assignee needs only
  `employee_is_assignable` (active + not on leave); clock-in state is
  ignored for both auto and manual assignment.
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
- Realtime (optional — `CENTRIFUGO_*` unset = disabled): Centrifugo service
  (`deploy/centrifugo/`), channels in private `priv` namespace gated by
  per-channel JWTs from `POST /realtime/subscribe`; services queue events on
  `session.info` → `after_commit` dispatch (see `docs/realtime.md`).
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
  (super_admin + property_manager). Property managers get every capability a
  super_admin has INSIDE their own property — task review incl. resource
  release, ticket close/disapprove, attendance leave decisions, live
  locations, calendars/day-analysis, resource repair, shifts. Company-level
  surface stays `require_super_admin`: create/delete property, PATCH
  /companies, /admin/settings. PM scoping is enforced per-service
  (`_property_for_write`, `_request_for_review`, `_assert_company_scope`
  pinning, `_scoped`) — never by hiding UI.

## Source-of-truth indexing notes (2026-10-29)

- Historical `docs/performance-audit/architecture-overview.md` describes an
  older baseline, not current behavior. `AppContext.loadWorkspace()` now uses
  `GET /workspace` (nine independent pooled sessions gathered server-side),
  falling back to nine GETs only on 404. Global reconciliation polling is
  120 seconds, visibility-aware and non-overlapping; realtime invalidations
  use scoped, coalesced refreshes. Employee Backend HTTP calls share the
  lifespan-managed client in `app/core/http_client.py`.
- Authentication reads use a detached, process-local user cache (default
  `AUTH_CACHE_TTL_SECONDS=60`); cross-process role/deactivation changes can
  remain stale until TTL expiry. Current login releases its read transaction
  before bounded off-loop password verification, then writes login timestamp
  and refresh-token hash together through a PostgreSQL CTE.
- Code/config reference an arq scheduler worker, but this checkout has no
  `WorkerSettings` or `generation_tick` implementation. Before disabling
  `RUN_EMBEDDED_SCHEDULER`, verify who actually runs scheduled work externally.
- `.github/workflows/deploy-production.yml` deploys Railway and Vercel but
  defines no test/typecheck job. Test presence is not evidence of a CI gate.
- Test inventory: backend regression suites cover auth, pooler compatibility,
  verification queue, task review, shifts, live locations, employee notices,
  realtime, and query-count regressions. Frontend Vitest configuration lives
  in `vite.config.ts`; tests currently cover ZoneBoard and LiveLocationMap.
  `tests/load/` is a separate opt-in load harness; do not execute its traffic
  generators or account seeder as ordinary unit tests.

## Super-admin activity logs

- `/admin/logs` (SPA) opens a property-card directory; clicking a property
  opens its scoped timeline, and Back to properties restores the directory.
  Filters/pagination retain the selected property unless explicitly cleared.
  Activity Timeline uses IST date groups, individual containers and horizontal
  recorded-fact strips (not estimated completion percentages). Task Journey
  searches `/admin/logs/tasks` and reads `/admin/logs/tasks/{id}/journey` in
  oldest-first pages; its summary comes from authoritative Task columns,
  never inferred from event titles. A separate all-company view preserves
  access to unlinked authentication events. Attachment previews use the
  company-scoped `/admin/logs/attachments/{source}/{event_id}` endpoint and
  bearer-authenticated blobs, not public-URL fallbacks. Failed sign-ins and
  refreshes record safe reason/status metadata; unverified attempts must not
  be presented as performed by the targeted account. Unattributed attempts
  have no company scope and are excluded from tenant-visible queries.
  The SPA and `GET /api/v1/admin/logs` are super-admin-only;
  `services/logs.py` unions shared task/evidence, maintenance, allocation,
  resource-state, attendance, and audit histories. Filtering, counting, and
  pagination run in SQL with an authoritative company scope. Date filters
  require timezones; the UI converts inclusive IST dates to UTC boundaries.
- `services/audit.py::capture_mutations` captures allowlisted management-side
  ORM changes in the same transaction via a Session `before_flush` listener.
  Actor context comes from `get_current_user`; passwords/tokens are excluded.
  Persistent identity must come from `inspect(obj).identity` when attributes
  are expired. Snapshots use JSON company/property identifiers so generic
  deletion events do not depend on the deleted entity's foreign keys.
- AuthService records successful login, explicit logout, signup, and refresh;
  media uploads record actor/property after scope validation. These new
  events cannot reconstruct past unrecorded actions. Employee Backend
  login/logout needs instrumentation in that separate application. Shared
  clock-in/out records are attendance events, not authentication events.
- On this Windows installation, verify backend work with
  `py -3.12 -m pytest tests/ -q` from `backend/`; default `python` resolves
  to 3.15, whose SQLAlchemy extension is blocked by Application Control.

## Employee detail pages

- Directory cards/names and Zone Board name buttons open
  `/property/:propertyUid/employees/:employeeUid`. Interactive directory
  controls do not trigger navigation; name buttons on the board do not
  initiate dragging.
- `services/employee_profile.py` serves staff-only `/employees/{id}/profile`,
  `/employees/{id}/tasks`, and `/employees/{id}/records` reads. Profile access
  validates the employee's current property against the URL property.
  All history queries are company-scoped, additionally restricted to the
  manager's property for PMs. Responses are private/no-store.
- Task metrics count distinct task IDs, not loaded-page rows. Allocations
  use current employee IDs and the allocation ledger; completion/rejection
  credit uses employee IDs on approved/disapproved submission attempts,
  never actor-name matching or the latest task assignee. Abandonment uses
  assignment-at-event records, with a current abandoned-assignment fallback
  only when no allocation ledger exists. Counts overlap across outcomes.
- Per-task filters show the latest matching employee submission attempt;
  authoritative current task status is separate. Start-to-submission elapsed
  requires a recorded employee allocation at the start and no intervening
  reassignment. Starts from earlier attempts are not reused. This is elapsed
  time including pauses, not measured active labor or payroll time.
- Attendance, leave/week-off requests, dated shift assignments, submissions,
  and allocation history are paginated server-side. Recorded salary is a
  nullable free-text field; do not invent a currency, pay period, payment
  history, deductions, or payslips. Missing attendance is not absence.
