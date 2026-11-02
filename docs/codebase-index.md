# Codebase Index — super-admin ("AiROS" / Management Tool)

Deep index generated 2026-10-30 by a full-repository scan; refreshed 2026-11-02
(employee-analysis expansion, team analytics, landing-page consolidation +
motion system). `AGENTS.md` remains the curated map of conventions and business
rules; this file is the exhaustive lookup: every endpoint, service, model
column, route, component, test, and env var. Where this file and AGENTS.md
disagree, this file reflects the code as read — see §13 Discrepancies.

Stack: FastAPI + SQLAlchemy 2 async + asyncpg + Alembic (Postgres, Supabase) |
React 19 + TS + Vite 8 + Tailwind v4 + react-router-dom 7.

---

## 1. Repository map

```
main.py                     # dev launcher: frees :8000/:3000, spawns uvicorn --reload + vite dev,
                            #   strips shell-env DB vars so backend/.env is authoritative,
                            #   own process groups for clean taskkill/SIGTERM teardown
backend/
  app/main.py               # FastAPI app, lifespan (DB probe ×3, check_schema_version,
                            #   embedded scheduler, EB http client), middleware, /health /ready
  app/api/v1/               # 10 routers mounted at /api/v1 via router.py
  app/core/                 # config, database, security, verify_queue, redis, queue(arq),
                            #   rate_limit, storage, centrifugo, middleware, logging, timing,
                            #   http_client, auth_cache, exceptions
  app/dependencies/auth.py  # get_current_user, require_role → require_super_admin /
                            #   require_property_manager
  app/domain/               # resource_states, transitions (+SOURCE_GATES), resource_events
  app/models/               # 17 model files on shared Base
  app/repositories/         # company, employee, refresh_token, user, workspace
  app/schemas/              # auth, maintenance, property, structure, template,
                            #   work_allocation, workspace (*_out serializers, *_uid wire IDs)
  app/services/             # 23 business-logic files (Router → Service → Repository)
  alembic/versions/         # 40-revision linear chain (head v9f2b5c8d1e4)
  tests/                    # 11 pytest files — no conftest, fake-session pattern, no real DB
  scripts/                  # audit_probe.py, api_probe.py, pooler_compat.py (read-only probes)
  railway.toml, Dockerfile  # prod deploys
frontend/
  src/App.tsx               # routes + guards (RequireAuth/RequireRole/PropertyScopedView)
  src/context/AppContext.tsx  # god-context ~2537 lines: session, collections, mutations,
                              #   scoped refresh machinery, realtime wiring, toasts
  src/api/                  # 21 thin wrappers over apiFetch (client.ts)
  src/realtime/             # centrifuge-js singleton + useRealtimeChannel
  src/lib/                  # permissions (can() mirror), activityLogs, taskUtils, datetime(IST), ...
  src/components/           # admin, auth, employees(+analytics/+analysis), landing
                          #   (single-file LandingPage), maintenance, navigation, profile,
                          #   properties, rooms, tasks, templates, ui, zones
  vercel.json               # SPA rewrite deploy config
deploy/centrifugo/          # Dockerfile + config.json (priv namespace, JWT-gated channels)
deploy/cloudrun.md          # documented-only staging recommendation
tests/load/                 # opt-in load harness (login burst), NOT part of pytest runs
docs/                       # FRONTEND_FEATURES, aesthetics (design/motion spec),
                            #   codebase-index, employee-analytics, realtime,
                            #   performance-audit/*
.github/workflows/          # deploy-production.yml, deploy-centrifugo.yml
```

## 2. Backend — app construction (`backend/app/main.py`)

- `FastAPI(title=settings.APP_NAME)`; docs/openapi disabled when `APP_ENV=production`.
- Middleware (outer→inner): `RequestIDMiddleware` → `AccessLogMiddleware` →
  `SecurityHeadersMiddleware` → `GZipMiddleware(500)` → `CORSMiddleware`.
- `register_exception_handlers(app)`; `REQUEST_TIMING_ENABLED` installs engine
  listeners → `X-Response-Time/X-DB-Time/X-DB-Queries/X-Ext-Time` headers.
- Static mount `/uploads` → `LocalStorage` dir (always mounted).
- Top-level: `GET /health` (liveness), `GET /health/db`, `GET /ready` AND
  `/api/v1/health` (dual-registered; DB + schema-version + Redis probes).
- Lifespan startup: prod config warnings (JWT/DB → fatal) → `check_database()`
  3×2s → `check_schema_version()` (alembic head vs DB stamp; mismatch = refuse
  boot) → embedded scheduler if `RUN_EMBEDDED_SCHEDULER` (default true) →
  `init_eb_client()`. Shutdown: cancel scheduler → `close_eb_client` →
  `close_queue` → `close_redis` → `close_db`.
- Scheduler tick (60s, own session each, order is load-bearing):
  `RolloverService.expire_due` → `TemplateService.run_due` →
  `TaskService.run_due_repetitive` → `RolloverService.run` → every 15th tick a
  read-only `reconcile_property` scan. Failures: exponential backoff ≤600s.
- `dependencies/auth.py`: `get_current_user` (JWT → auth_cache 60s TTL →
  `UserRepository.get_by_id`; sets `session.info["audit_actor"]`; inactive →
  401). `require_role(*roles)`; `require_super_admin` = SA only;
  `require_property_manager` = SA+PM (aliased `Staff` in route files). Tenant
  scope is `user.company_id`; PM property pinning is per-service, not here.

## 3. Backend — full API surface (`/api/v1`, 100+ endpoints)

Auth legend: **open** = no auth · **auth** = `get_current_user` ·
**staff** = SA+PM (`require_property_manager`) · **SA** = super_admin only.

### 3.1 `/auth` (rate-limited: signup 10/300s, login `LOGIN_RATE_LIMIT`/60s, refresh 30/60s)

| Method | Path | Auth | Service |
|---|---|---|---|
| POST | `/auth/signup` | open | `AuthService.signup` (company + SA user, one tx) |
| POST | `/auth/login` | open | `AuthService.login` (email-or-username; off-loop argon2; uniform 401; CTE single-write) |
| POST | `/auth/refresh` | open | `AuthService.refresh` |
| POST | `/auth/logout` | open | `AuthService.logout` (revoke) |
| GET | `/auth/me` | auth | `MeResponse(user_to_out, company_to_out)` |
| PATCH | `/auth/me` | auth | `update_profile` + `auth_cache.invalidate` |

### 3.2 workspace.py — the unnamespaced mega-router

**Aggregate**: `GET /workspace` (auth) — 9 collections on 9 pooled sessions via
`asyncio.gather` (properties, areas, zones, rooms, dorms, washrooms, employees,
tasks, maintenance tickets).

**Properties**: `GET /properties` auth · `POST /properties` **SA** ·
`GET /properties/{id}` auth · `PATCH /properties/{id}` staff ·
`DELETE /properties/{id}` **SA** ·
`GET /properties/{id}/reconciliation` staff (read-only drift scan).

**Areas**: `GET /areas` auth · `POST /areas` staff · `PATCH /areas/{id}` staff ·
`DELETE /areas/{id}` staff.

**Zones**: `GET /zones` auth · `POST /zones` staff · `PATCH /zones/{id}` staff ·
`DELETE /zones/{id}` staff.

**Rooms**: `GET /rooms` auth · `POST /rooms` staff · `POST /rooms/bulk` staff ·
`POST /rooms/bulk-delete` staff · `PATCH /rooms/{id}` staff ·
`PATCH /rooms/{id}/allocation` staff · `DELETE /rooms/{id}` staff ·
`POST /rooms/{id}/check-in` staff · `POST /rooms/{id}/check-out` staff
(returns `generated_tasks`) · `GET /rooms/{id}/maintenance` auth.

**Dorms**: `GET /dorms` auth · `POST /dorms` staff · `POST /dorms/bulk` staff ·
`PATCH /dorms/{id}` staff · `PATCH /dorms/{id}/allocation` staff ·
`DELETE /dorms/{id}` staff · `POST /dorms/{id}/checkout` staff ·
`POST /dorms/{id}/mark-cleaning` staff · `POST /dorms/{id}/mark-cleaned` staff ·
`POST /beds/{id}/check-in` staff · `POST /beds/{id}/check-out` staff.

**Resource state**: `POST /resources/{type}/{id}/transition` staff ·
`POST /resources/{type}/{id}/repair` staff (AGENTS.md says SA — see §13).

**Washrooms**: `GET /washrooms` auth · `POST /washrooms` staff ·
`POST /washrooms/bulk` staff · `GET /washrooms/{id}` auth ·
`PATCH /washrooms/{id}` staff · `PATCH /washrooms/{id}/allocation` staff ·
`PATCH /washrooms/{id}/fixtures/{fid}` staff · `DELETE /washrooms/{id}` staff ·
`GET /washrooms/{id}/maintenance` auth.

**Bulk**: `POST /units/bulk-status` staff (actions
checkout|cleaning|available|cleaned|maintenance → `{rooms,dorms,washrooms,
generated_tasks,skipped_blocked}`).

**Employees**: `GET /employees` auth · `POST /employees` staff ·
`PATCH /employees/{id}` staff · `PATCH /employees/{id}/zone` staff ·
`PATCH /employees/{id}/allocation` staff · `POST /employees/{id}/deactivate` staff ·
`POST /employees/{id}/reactivate` staff · `DELETE /employees/{id}` staff ·
`GET /employees/{id}/profile` staff (no-store) · `GET /employees/{id}/tasks`
staff (filter: all|allocated|completed|abandoned|rejected|pending_review|
current_open + search/page/date bounds) · `GET /employees/{id}/analytics`
staff (`bucket=day|week|month` + bounds) · `GET /employees/{id}/records` staff
(kind: attendance|leaves|shifts|allocations|submissions|maintenance) ·
`GET /employees/{id}/locations` staff (zone→area→unit task+maintenance rollup) ·
`GET /employees/{id}/attendance/calendar?month=YYYY-MM` staff ·
`GET /employees/{id}/attendance/day?date=YYYY-MM-DD` staff ·
`GET /employees/team-analytics` staff (per-employee rows + team totals) ·
`GET /employees/{id}/devices` staff (reads EB-owned device_registrations/
mobile_releases/location_events/tracking_sessions via Core `table()` defs).
All employee-analysis routes send `Cache-Control: private, no-store` and
validate date ranges.

**Tasks**: `GET /tasks` auth · `GET /tasks/today` auth · `GET /tasks/history` auth ·
`GET /tasks/calendar` staff · `GET /tasks/history/{day}` staff (declared after
`/tasks/history` — ordering matters) · `POST /tasks` staff ·
`GET /tasks/review-queue` staff · `GET /tasks/{id}` auth ·
`PATCH /tasks/{id}` staff · `DELETE /tasks/{id}` staff ·
`POST /tasks/{id}/start` auth · `POST /tasks/{id}/complete` auth ·
`POST /tasks/{id}/request-redo` auth · `PATCH /tasks/{id}/assignee` staff ·
`POST /tasks/{id}/reopen` staff · `POST /tasks/{id}/approve` staff ·
`POST /tasks/{id}/reject` staff.

**Maintenance**: `POST /maintenance` staff · `GET /maintenance` auth ·
`GET /maintenance/calendar` staff · `GET /maintenance/history/{day}` staff ·
`GET /maintenance/{id}` auth · `PATCH /maintenance/{id}` staff ·
`DELETE /maintenance/{id}` staff · `POST /maintenance/{id}/assign` staff ·
`POST /maintenance/{id}/start` auth · `POST /maintenance/{id}/hold` staff ·
`POST /maintenance/{id}/resolve` auth · `POST /maintenance/{id}/disapprove` staff ·
`POST /maintenance/{id}/close` staff.

**Companies**: `GET /companies/{id}` auth (+inline company match) ·
`PATCH /companies/{id}` **SA**.

### 3.3 `/media`

- `POST /media/uploads` auth (rate 30/60s) — JPEG/PNG/WebP, ≤10MB, magic-byte
  check, `property_id` scope → `{url,key}`.
- `GET /media/file/{key}` **open** (rate 240/60s) — key whitelist regex
  `^[0-9a-f]{32}\.[a-z0-9]{2,5}$`; streams via `StorageBackend.open`,
  `immutable` cache headers.

### 3.4 `/work-batches`

- `POST /work-batches` **auth** (any authenticated user; per-item scope inside
  service — see §13) — zone-grouped tickets, one employee per unit.
- `GET /work-batches/{id}` auth · `GET /properties/{id}/work-batches` auth.

### 3.5 `/templates` (all staff except where noted)

`POST /templates` · `GET /templates` auth · `GET /templates/{id}` auth ·
`PATCH /templates/{id}` · `DELETE /templates/{id}` ·
`POST /templates/{id}/{pause|resume|activate|archive}` ·
`POST /templates/{id}/duplicate` · `GET /templates/{id}/history` auth ·
`GET /templates/{id}/generated-work` auth ·
`POST /templates/{id}/generate-occurrence` · `POST /templates/generate-due`
(manual tenant-scoped scheduler tick).

### 3.6 `/attendance` (staff)

`GET /attendance/status-board?property_id&date` → `day_status_board` ·
`GET /attendance/requests?status` ·
`POST /attendance/requests/{uid}/approve|reject` (review_comment).

### 3.7 `/shifts` + `/employees/{id}/shift-assignments` + `/shift-assignments` (staff)

`GET/POST /shifts` · `PATCH /shifts/{uid}` ·
`GET/POST /employees/{uid}/shift-assignments` ·
`GET /shift-assignments?property_id` (→ `exempt_employee_uids`) ·
`PATCH /shift-assignments/{uid}` (effective_until) ·
`DELETE /shift-assignments/{uid}` (future-start only).

### 3.8 `/live-locations` (staff; EB proxy; on-duty filter on the two live endpoints)

`GET /live-locations` (employee_id/property_id/zone_id/is_active) ·
`GET /live-locations/{uid}` · `GET /live-locations/{uid}/history?from&to`
(≤31d, tracking_session_id, max_points ≤100000). Errors: 400 passthrough /
502 auth-reject/malformed / 503 unreachable-unconfigured.

### 3.9 `/realtime`

`GET /realtime/token` auth (503 when CENTRIFUGO_* unset) ·
`POST /realtime/subscribe` auth — channel grammar
`priv:prop:{pid}:{topic}` | `priv:emp:{eid}`; emp channels self-only, prop
channels scoped (SA: company property ids; PM: own property).

### 3.10 `/admin/logs` (**all SA only**)

`GET /admin/logs` (property/category/search/actor/action/task_status/date
range/page) · `GET /admin/logs/tasks` (journey task picker) ·
`GET /admin/logs/tasks/{id}/journey` ·
`GET /admin/logs/attachments/{source}/{event_id}?index` (streams storage;
private/no-store).

## 4. Backend — services index (`backend/app/services/`)

| File (~lines) | Responsibility / key entry points |
|---|---|
| `attendance.py` (~670) | `AttendanceService`: `list_requests`, `review_request` (approve stamps every date in range — worked day or overlapping open request → 409), `_request_for_review` (FOR UPDATE + scope). Module fns: `current_work_statuses` (working/on_break/off_duty/unknown), `day_status_board` (9-state authoritative evaluator; `floor_eligible`=working/on_break; `incomplete`+`needs_review` fail-closed). |
| `audit.py` (~167) | `AuditService.record/list_events`; `capture_mutations` Session `before_flush` hook auto-audits whitelisted tables with field diffs from `session.info["audit_actor"]`. |
| `auth.py` (~283) | `AuthService`: `signup`, `login` (read-tx released before `verify_queue` argon2; `dummy_hash` uniform timing; mark_login CTE), `refresh`, `logout`; errors InvalidCredentials/EmailAlreadyExists/AccountInactive/InvalidRefreshToken. |
| `day_analysis.py` (~447) | `DayAnalysisService.calendar` (per-op-day counts) + `.day` (task detail/employee/zone/area/category buckets); anchors via `rollover._task_anchor_key`. |
| `employee.py` (~403) | `EmployeeService`: CRUD + linked `User(role=EMPLOYEE)` provisioning, `assign` (zone XOR area), `deactivate` (clears allocation, disables logins, cache invalidate), `reactivate`, `delete_employee` (open work → unassigned queue). |
| `employee_events.py` (~94) | `queue_allocation_notice` (session.info `EB_ALLOC_EVENTS`), `dispatch_allocation_notices` → `POST {EB}/admin/notify-allocation`, best-effort. |
| `employee_profile.py` (~1239) | `EmployeeProfileService`: `profile`, `tasks` (filter SQL map incl. allocation-ledger abandonment attribution), `analytics` (durations/review turnaround/shift adherence/previous period, KPI insights), `records` (6 kinds, paginated), `team_analytics` (per-employee rows + team totals over scoped properties), `locations` (zone→area→unit task/maintenance rollup), `attendance_calendar`/`attendance_day` (shared attendance_days/breaks), `devices` (EB-owned tables read via module-level Core `table()` defs — `_device_registrations`, `_location_events`, `_location_tracking_sessions`, `_mobile_releases`; NOT ORM models). All scoped via `properties(user)` (PM pinned to own property). |
| `live_location.py` (~324) | EB proxy: `fetch_live_locations`, `fetch_location_history`; `X-Location-Service-Key`; error map 400→passthrough, 401/403→502, unreachable→503; normalize canonical fields; coords never stored. |
| `logs.py` (~280) | `LogsService`: `list_events` (union_all over 8 sources), `find_tasks`, `task_journey`, `attachment_key`; SA-only. `log_uid = source:event_uid`. |
| `maintenance.py` (~848) | `MaintenanceService` lifecycle open→assigned→in_progress→on_hold→resolved→closed/cancelled; `flag_ticket_resource` (ticket→resource maintenance flagging); `_resolve_target` (exactly one target); `_employee_coverage`; `disapprove`→in_progress; `close`→derive release. `next_ticket_number` (PG sequences). |
| `maintenance_analysis.py` (~554) | `MaintenanceAnalysisService.calendar/.day` — window-based carry-forward; status-at-instant replayed from ticket event stream. |
| `occupancy.py` (~370) | `OccupancyService`: `check_in_room/bed`, `check_out_room/bed`, `checkout_units` (batch-lock open occupancies → close → spawn cleaning tasks → →cleaning → re-derive dorms). |
| `property.py` (~332) | `PropertyService`: `create_property` (Property+manager Employee+PM User atomically, `PROP-NNN`), `update_property` (`_apply_manager_update` demotes/reassigns PMs), `delete_property`. |
| `reconciliation.py` (~366) | `reconcile_property` read-only drift scan; findings: orphan_cleaning/maintenance/occupied, occupancy_status_conflict, occupied_under_work, unflagged_ticket/task, invalid_state. |
| `resource_state.py` (~891) | `ResourceStateService` — THE status writer: `transition` (legal-graph + source-gate; admin_override needs staff+reason; →occupied needs open occupancy), `derive` (release-eligible only: maintenance>cleaning>occupancy→release), `repair` (full recompute), `explain`; per-type blocker queries incl. bed-cover via `Task.bed_ids`. |
| `rollover.py` (~395) | Op-day math (IST, `operational_day_start` default 06:00) + `RolloverService.run` (`SYSTEM_DAILY_ROLLOVER`) / `.expire_due` (`NEXT_SCHEDULED_OCCURRENCE`; `submitted` survives); conditional UPDATEs, race-safe. |
| `shifts.py` (~523) | `ShiftService` CRUD + assignments (`effective_from/until`, overlap 409, history kept); pure fns `shift_applies_on`, `shift_window_utc`, `effective_assignments`; `schedule_exempt_employees` = SA/PM-linked 24×7. |
| `structure.py` (~2088) | Structure CRUD + `bulk_unit_status`; shared errors `NotFoundErr/ConflictErr/ValidationErr`; `_property_for_write`; `_fire_automation`; dorm bed resize; washroom fixture sync; `_generate_cleaning_tasks` (SAVEPOINT-guarded dedup vs `uq_tasks_open_room_title`). |
| `task.py` (~1511) | `TaskService` full lifecycle: create/start/complete (staff-only direct close, evidence rules), review (`approve_task`/`reject_task` on `submitted`), `reassign`, `request_redo`, `reopen_task`, `run_due_repetitive`, `_next_instance` series clones; guards `_require_assignee/_require_reviewer/_require_resource_authority`. |
| `task_location.py` (111) | `resolve_task_location` — canonical zone/area derivation for generated work. |
| `task_ops.py` (~515) | `TaskOpsService.today` (generated + pending-generation union via TemplateGeneration ledger), `history` (paginated), `generate_occurrence` ("Generate Now"). |
| `template.py` (~1532) | `TemplateService` CRUD/versioning/`run_due`/`_generate`/`_expand_targets`; `compute_next_run` (all schedule kinds); idempotency via `(template_id, occurrence_key)` ledger + SAVEPOINTs. |
| `work_allocation.py` (~1024) | `WorkAllocationService` — persistent zone round-robin (`ZoneAllocationState` FOR UPDATE): `allocate`, `allocate_people`, `allocate_units` (batched), `employee_for_assignment` (assignable + dept gate), `record` (history + EB notice buffer). Attendance never gates. |

## 5. Backend — domain rules (`app/domain/`)

- `resource_states.py`: `ROOM/DORM={available,occupied,cleaning,maintenance}`,
  `BED+inactive`, `WASHROOM={available,cleaning,maintenance,inactive}`,
  `FIXTURE={operational,maintenance,inactive}`; `BLOCKING_MAINTENANCE` includes
  `resolved` (still blocks until closed); `BLOCKING_TASK` incl. `submitted`,
  `scheduled`, `overdue`; `RELEASE_ELIGIBLE={cleaning,maintenance}`.
- `transitions.py`: `LEGAL_TRANSITIONS` per resource type + `SOURCE_GATES`
  (e.g. only `occupancy_checkin` may produce `occupied`;
  `occupied→cleaning` allowed for `occupancy_checkout|admin_override|
  task_start|task_queued`). `is_legal(type, from, to, source)`.
- `resource_events.py`: source constants (`task_start`, `task_queued`,
  `ticket_created`, `ticket_resolved`, `ticket_closed`, `occupancy_checkin/out`,
  `admin_override`, `reconciliation`, `derive`, `fixture_restored`, ...).

## 6. Backend — core infra (`app/core/`)

| File | Provides |
|---|---|
| `config.py` | `Settings` singleton — full env catalog in §11. `database_url` assembly (asyncpg), `production_warnings`, `pooler_mode`. |
| `database.py` | `InstrumentedAsyncQueuePool`, `engine`, `AsyncSessionLocal`; `bounded_lock_wait` (10s `lock_timeout`), `get_db`, `check_database`; **Session `after_commit`/`after_rollback` hooks dispatch `session.info` buffers** — `EB_ALLOC_EVENTS` (EB allocation notices) + `RT_EVENTS` (Centrifugo); savepoints skipped. |
| `security.py` | Argon2id hash/verify, HS256 access JWT (30min), opaque refresh (sha256-hash stored, 30d), `slugify_username`. |
| `verify_queue.py` | Bounded argon2 executor (semaphore + queue cap + wait deadline); overload → 503 `AUTH_QUEUE_*` + `Retry-After`; `dummy_hash`. |
| `redis.py` | Optional shared client (`get_redis` tri-state, never raises); key prefix `mt:`. |
| `queue.py` | arq `enqueue` (None when Redis down — inline fallback). |
| `rate_limit.py` | `rate_limit(scope, limit, window)` dep; Redis INCR/PEXPIRE, in-memory fallback, fails open. |
| `storage.py` | `StorageBackend.save/open/delete`; Local/S3/Supabase; `get_storage` auto-order; `MAX_BYTES=10MB`; `storage_key_from_url` reverse-map. |
| `centrifugo.py` | `PRIVATE_NS="priv"`, `prop_channel`/`emp_channel`, connection/subscription HMAC JWTs, `publish`, `queue_event` → `RT_EVENTS`, `dispatch_realtime_events` (≤50). |
| `middleware.py` | RequestID, AccessLog (X-* timing headers + TimingBag), SecurityHeaders (+HSTS prod). |
| `timing.py` | `TimingBag` contextvar; engine listeners for db_ms/db_queries. |
| `http_client.py` | Shared `httpx.AsyncClient` for EB calls (pooled, lifespan-managed). |
| `auth_cache.py` | Detached `User` cache, `AUTH_CACHE_TTL_SECONDS`=60; `invalidate`. |
| `exceptions.py` | `AppError` + `register_exception_handlers` (AppError→`{error:{code,message}}`, 422 field map, SQLAlchemy→503, 500 generic). |

**Cross-cutting patterns**: out-of-scope = 404 not 403 (IDOR-safe) · staff gate =
`role ∈ (SUPER_ADMIN, PROPERTY_MANAGER)` · expire_due runs BEFORE generation
everywhere · post-commit dispatch via `session.info` buffers only on real commit.

## 7. Data layer — tables (`backend/app/models/`)

Conventions: PK `Uuid` default uuid4; `created_at/updated_at` server_default
now(); FKs CASCADE on tenant/ownership edges, SET NULL on references. Wire IDs
serialize to `*_uid` strings via `schemas/*_out` mappers.

| Table | Model file | Key columns / constraints |
|---|---|---|
| `companies` | company.py | company_name, brand_name, address, pin_code, email, phone_number, operational_day_start '06:00', is_active. DB-only (EB geofence, unmapped): latitude, longitude, geofence_radius_m. |
| `users` | user.py | company_id FK, name, email∪, username∪, password_hash, role enum(super_admin|property_manager|human_resource|department_manager|employee — non-native), property_id/employee_id/zone_id (no FK), is_active, last_login_at. |
| `refresh_tokens` | refresh_token.py | user_id FK, token_hash∪, expires_at, revoked. |
| `properties` | property.py | company_id FK, name, code 'PROP-NNN', location/city/state, status(Active\|Maintenance\|Setup), manager_employee_id (no FK), manager_name/email/phone. |
| `areas` | structure.py | property_id FK, name, code, level_number, UC(property_id,name). |
| `zones` | structure.py | property_id FK, area_id FK→areas, name, code, zone_type (only `stay` holds rooms/dorms), display_order; UC(property_id,name). |
| `rooms` | structure.py | property_id FK, zone_id, area_id, room_number, type, status (derived; CHECK 4-state), bed_count, cleaning_note, current_guest; UC(property_id,room_number). |
| `dorms` | structure.py | property_id FK, zone_id, area_id, name, dorm_type, status, is_active. |
| `beds` | structure.py | dorm_id FK, property_id, bed_number, status (5-state CHECK), guest_name; UC(dorm_id,bed_number). |
| `washrooms` | structure.py | property_id FK, zone_id, area_id, dorm_id (attached; UC 1-per-dorm), name, washroom_type, status (4-state CHECK). |
| `washroom_fixtures` | structure.py | washroom_id FK, property_id, fixture_type(+number), status (operational\|maintenance\|inactive), last_cleaned_at/last_maintenance_at; UC(washroom_id,type,number). |
| `employees` | employee.py | company_id+property_id FKs, zone_id/area_id SET NULL (XOR), name, email, phone, username, job_title, department, status(Active\|Deactivated), salary (free-text), leave_status, deactivated_at/reactivated_at. |
| `tasks` | task.py | ~50 cols: property/zone/area FKs, employee_id assignee, ticket_number∪ 'TASK-YYYY-NNNNN', room/dorm/washroom/fixture targets + `bed_ids` JSON, supervisor, template_id+version, allocation_*(batch/status/method/reason), task_type(fixed\|repetitive\|automated), work_type, origin(manual\|checkout\|template\|automation\|guest_request), status(10 states), recurrence fields + series_id self-FK + automation_rule JSON, scheduled_for/expires_at, operational_date, abandoned_*. Indexes: `uq_tasks_open_room_title` partial-unique (property,room,title; excludes completed/cancelled/abandoned), `uq_tasks_series_due` (series_id,due_date), `ix_tasks_expires_at` partial. |
| `task_history_events` | task.py | task_id FK, type, at, actor_name, note, photos JSON. |
| `task_completion_submissions` | task.py | task_id FK, history_event_id∪, employee_id, attempt_number (UC task+attempt), status(pending\|approved\|disapproved), reviewed_* fields. |
| `task_completion_images` | task.py | task_id FK, history_event_id, submission_id, url, storage_key, created_by*. |
| `maintenance_tickets` | maintenance.py | ticket_number∪ 'MT-YYYY-NNNNN', company/property FKs, exactly-one-target (room\|dorm\|bed\|washroom+fixture), reported_by*, maintenance_type, issue, priority, status(7-state), assigned_to, allocation_*, template_id+version, resolved_at/closed_at, resolution_notes. |
| `maintenance_ticket_events` / `_attachments` | maintenance.py | event stream (action, comment); attachments (url, kind issue\|resolution, attempt). |
| `occupancies` | occupancy.py | property_id, room_id XOR bed_id (CHECK, no FK), guest_name nullable, checked_in_at/out_at (NULL=open); partial-unique open-room / open-bed. THE occupancy truth. |
| `resource_state_events` | resource_state_event.py | resource_type/id, property_id, prev→new, source, reason, actor, task/ticket/occupancy ids. |
| `work_templates` | template.py | company/property, name, template_type, config JSONB (assignment/location/schedule/checklist/verification/overdue/notifications), status(draft\|active\|paused\|archived), version, next_run_at idx, last_run_at, generated_count. |
| `work_template_versions` | template.py | template_id FK, version (UC template+version), config JSON. |
| `template_generations` | template.py | template_id, occurrence_key (UC — idempotency ledger), ticket_kind/id/number, target_label. |
| `zone_allocation_state` | work_allocation.py | zone_id UC, last_assigned_employee_id, version — persistent RR pointer (FOR UPDATE). |
| `work_allocation_batches` | work_allocation.py | batch_number∪ 'WB-YYYY-NNNNN', company/property/zone, employee, work_type, allocation_status, created_by*. |
| `work_allocation_history` | work_allocation.py | property/zone/batch, ticket_kind+id, employee + previous_employee, allocation_method(round_robin\|manual\|reassign), actor. |
| `allocation_events` | allocation.py | entity_type/id (employee\|room\|dorm), from/to zone+area, actor — zone-assignment history. |
| `audit_events` | audit.py | property_id, actor, entity_type/id/name, action, detail JSON (before/after). |

### Shared-with-Employee-Backend tables (mapped minimally; EB owns writes)

`attendance_days` (UC employee+date; partial-unique open session), `attendance_breaks`
(partial-unique open), `attendance_requests` (inclusive ranges; PG `leave_range`
generated + EXCLUDE no-overlap), `shifts` (IST times, grace, early_exit,
Mon-first `working_days` bitmap), `employee_shift_assignments` (effective
windows), `notifications` (CHECK'd type vocab; SA writes submission_approved/
disapproved).

**EB-owned, NOT ORM-mapped**: `device_registrations`, `location_events`,
`mobile_releases`, `location_tracking_sessions`. Never add ORM models — but
`employee_profile.py` now declares minimal Core `table()`/`column()` defs for
read-only queries backing `GET /employees/{id}/devices`.
`area_allocation_state` exists in DB but is unmapped + unreferenced — dead
schema. Several constraints live only in migrations (status CHECKs, attendance
uniques/EXCLUDE, `ck_notifications_type`) — a `create_all` schema would lack them.

## 8. Alembic chain (40 revs, linear — head `v9f2b5c8d1e4`)

`e01da4bc153a` companies+users+refresh_tokens → `345d9736662b` structure+employees+tasks+history → `a38d5c90adfd` allocation_events+UCs → `649b374bfc29` maintenance+sequences → `027058f5a060` dorm/bed targets on tickets → `f0ac59d056c6` allocation state+batches+history → `6b2a1a12ad65` tasks.start_time → `db39ee38a729` work_templates+versions+generations → `6920e7a5283e` recurrence fields → `b7f3c21a9e04` series_id → `c4d81e7b2f05` employees.area_id → `d9e2f04a1c33` uq_tasks_open_room_title → `e8b2c4d6f1a7` dorm/bed targets on tasks → `f19a2b3c4d5e` tasks.area_id (+orphaned area_allocation_state) → `a2d4f6b8c0e1` employee deactivation → `b4c6d8e0f2a1` completion_images → `c7e8f1a2b3d4`/`d8e1f2a3b4c5` submissions+backfills → `e9f2a4b6c8d0` washrooms → `f3a8c1d5e7b9`/`d8e4b2f1a7c3` fixture count cols → `c5f7a9b1d3e2` FK rewrite CASCADE → `e2b7d4a8c1f5` washroom_fixtures (drops count cols) → `f3c8e1a2b6d4` washrooms.dorm_id → `g4d9f2b3c7e5` 1-washroom-per-dorm UC → `h5e0a3c4d8f6` audit_events → `i6f1b2d4e8a0` occupancies+resource_state_events+status CHECKs → `j7a2c3e5f9b1` guest_name nullable → `k8b3d4f6a1c2` attachments.attempt → `l2c5d7e9f1a3` tasks.origin → `m5f3a7c9e1b4` tasks.work_type → `n6g4a8c0e2f5` abandoned_*+operational_day_start → `o7h5b9d1f3e6` scheduled_for/expires_at+uq_tasks_series_due → `p8d1f4a7c2e5` attendance tables → `q9e2f5a8c3d7` request ranges+EXCLUDE → `r4b8d2f6a0c3e` request_type rename → **`s5c9e3a7d1f4` shared-DB boundary** (notifications+devices+location_events+property geofence) → `t6d0e4a8f2b5` mobile_releases → **`u7e1f5a9d3c6` location_tracking_sessions (EB mirror — never stamp over)** → `v9f2b5c8d1e4` shifts+assignments (head).

## 9. Frontend index (`frontend/src/`)

### 9.1 Routes (`App.tsx`)

| Path | View | Guards |
|---|---|---|
| `/`, `/login`, `/signup` | LandingPage / Login / Signup | public; authed→role redirect |
| `/admin/properties`, `/admin/settings`, `/admin/logs` | PropertiesView, AdminSettingsView, LogsView | SA only |
| `/property/:uid/zones|rooms|employees|tasks|templates|profile` | ZonesView, RoomsDormsView, EmployeesView(+`/:employeeUid`), TasksView, TemplatesView, ProfileView | staff; PropertyScopedView pins PM / blocks SA foreign uids |
| `/property/:uid/tasks/history/:date` | TaskDayAnalysisView | staff |
| `/property/:uid/maintenance` → redirect `/tasks?tab=maintenance`; `/maintenance/history/:date` → MaintenanceDayAnalysisView | staff |
| `*` | RootRedirect (role-based) | — |

`RequireAuth` → /login; `WorkspaceGate` skeleton/error; all views lazy.

### 9.2 AppContext (~2537 lines) surface

- **State**: `currentUser`, `company`, `activePropertyUid`, `currentRole`,
  `isLoadingData`, `dataError`, `openedZoneUid`, `roomsTab`, `toasts`;
  collections `properties areas zones rooms dorms washrooms employees tasks
  maintenanceTickets`; derived per-property filtered lists + `employeeRecord`.
- **Loaders**: `loadWorkspace` (GET /workspace; 404 → 9-GET fallback);
  `fetchUnitScope`/`refreshUnitsScoped` (scoped refresh + in-flight dedup +
  union follow-up); `refreshUnits` (full scope); `scopeForTarget`;
  `subscribeUnitDeselect`/`emitUnitDeselect` (fires on complete/close +
  watcher diffs); `markSelfUnitEvent` (5s echo suppression vs Centrifugo).
- **Mutations**: ~60 actions 1:1 with api modules — all update collections
  locally + scoped refetches; deletes trigger `loadWorkspace`.
- **Realtime map** (`priv:prop:{uid}:{topic}`): `tasks`→tasks refetch;
  `units`→per-resource-type refetch (self-echo skipped); `maintenance`→tickets;
  `employees`→employees. Residual poll `refreshUnits` **120s**.

### 9.3 API client

`client.ts`: `apiFetch` (bearer from localStorage `mgmt_tool_auth_token`, JSON
or FormData, 20s timeout→ApiError(0), 401→single-flight `/auth/refresh`→retry
once→`onUnauthorized`, 204→undefined, blob support); `ApiError(status, message,
fieldErrors)`; `mediaUrl`. Token keys `mgmt_tool_auth_token` / `_refresh_token`.

Modules (1 fn per endpoint, names match §3): `auth`, `workspace`, `properties`,
`companies`, `areas`, `zones`, `rooms` (+bulk-status, check-in/out,
`transitionResource`), `dorms` (+bed check-in/out), `washrooms` (+fixture
update, allocation), `employees` (+profile/tasks/analytics/records/locations/
attendance-calendar/attendance-day/team-analytics/devices), `tasks`
(+today/history/calendar/day-analysis/review-queue/approve/reject/
generate-occurrence), `maintenance` (+calendar/day-analysis/room+washroom
history, `createWorkBatch`), `attendance` (statusBoard/requests/approve/reject),
`shifts` (CRUD+assignments+listCurrent), `locations` (liveLocations/
liveLocation/locationHistory), `logs` (listLogs/findJourneyTasks/getTaskJourney/
getLogAttachment blob), `media` (uploadPhoto), `templates` (CRUD+actions+
generated-work+generateDue). `types.ts` ~1075 lines of DTOs; `src/types.ts`
domain types incl. **`ResourceStateContract`** (`is_occupied`,
`occupancy_state`, `operational_state`, `visual_state` — server-canonical,
never recomputed client-side).

### 9.4 Components (by dir)

- **admin**: LogsView (property picker → ActivityFeed w/ filters + TaskJourney mode), TaskJourney (debounced search + oldest-first journey), ActivityTimeline (IST groups + recorded-fact strips), ActivityEvent (attachment blobs), AdminSettingsView (company form + `operational_day_start`).
- **auth**: Login, Signup, FormField, PasswordInput.
- **employees**: EmployeesView (tabs: board|directory|live|leaves|shifts|attendance|**analytics**→TeamAnalyticsTab), ZoneBoard (dnd-kit drag→zone/area assign; attendance does NOT gate), EmployeeDirectory (+deactivated tab, links to detail), EmployeeDetailView (profile header + PeriodSelector + tabbed analysis: OverviewTab [embeds LocationsTab.LocationTree], AllocationTimeline, MaintenanceTab, RecordsSection, AttendanceTab, DevicesTab — see §13: only Overview/Allocations buttons currently wired), LiveLocationMap (Leaflet+markercluster; **30s** reconcile poll + `locations`/`attendance` channels; 10s age clock; on-duty-only markers), AttendanceBoard (status_board; poll only while `is_today`), ShiftManager (dnd assign, IST windows, bitmap editor), LeavesPanel (approve/reject), CreateEmployeeModal; analytics/AllocationTimeline, analytics/WorkActivityChart; **analysis/** PeriodSelector(+usePeriod bounds), OverviewTab, AttendanceTab, MaintenanceTab, DevicesTab, LocationsTab, TeamAnalytics(TeamAnalyticsTab), kit(BlockLoading/TabBtn/card).
- **maintenance**: MaintenanceView (live|history|calendar; TicketDrawer w/ full action set + evidence), CreateMaintenanceModal (WorkBatch, per-type issue options), MaintenanceCalendarView, MaintenanceDayAnalysisView.
- **rooms**: RoomsDormsView (tabs rooms|dorms|washrooms|zones; multi-select bulk; all modals), UnitZoneBoard (dnd unit→zone), WashroomsView, WashroomModal, WashroomDetailModal, AssignWashroomTaskModal, ScheduleWashroomMaintenanceModal, OccupancyToggle, RequestItemModal (guest_request urgent), Create/EditRoomModal, BulkCreateRoomsModal, Create/EditDormModal, BulkCreateDormsModal, BulkCreateWashroomsModal.
- **tasks**: TasksView (tabs today|abandoned|review|maintenance|history|calendar; `?tab`/`?ticket` deep links), TodayTasksView (+generation_state badges, generateOccurrence), AbandonedTodayView, TaskReviewPanel (evidence lightbox, reject needs reason), TaskHistoryView (server-paginated, debounced filters), TaskCalendarView, TaskDayAnalysisView, TaskDetailDrawer (getTask on open; evidence picker→completeTask), CreateTaskModal (all target axes + types), CompletionEvidenceLightbox.
- **templates**: TemplatesView (+PREMADE one-click install), TemplateWizard (~1240-line multi-step: assignment/location/schedule/checklist/verification/overdue/notifications), TemplateDetailDrawer (generated-work, Run now).
- **zones**: ZonesView (area-grouped cards→ZoneWorkspace), ZoneWorkspace (unit bulk ops), CreateZoneModal, CreateAreaModal.
- **ui**: BackButton, Badge+status badges+**`unitVisualState`** (consumes `visual_state` directly), Button, Card, ConfirmationDialog, Drawer, Modal, OperationalCalendar (IST month grid), Skeleton, ToastContainer.
- **landing/navigation/profile/properties**: LandingPage is now a single ~812-line self-contained file (the old Hero/Features/Operations/Roles/ProductPreview/Cta/Header/Footer section components were deleted); lp-* scroll-reveal/float/dash/marquee motion classes in index.css. Header (role-scoped nav + ISTClock); ProfileView; PropertiesView+CreatePropertyModal.

### 9.5 lib/

`permissions.ts` `can(action,resource,user,ctx)` — SA always true; PM true
except `manage_all_properties`/`manage_org_settings`/`companies`/foreign
property; employee/HR/DM always false. `activityLogs.ts` (rendering + secret
redaction + IST groups + attachment refs). `taskUtils.ts`
(`getEffectiveTaskStatus` overdue mask, labels). `datetime.ts` — IST-only
helpers (never call toLocale* directly). `zoneUtils`, `employeeUtils`
(`isEmployeeAssignable`), `maintenanceUtils` (blocking statuses incl.
`resolved`), `washroomFixtures`, `mediaLimits`, `utils` (cn, getInitials).

### 9.6 Polling & realtime matrix

| Site | Interval | Condition |
|---|---|---|
| AppContext units reconcile | 120s | authed |
| TodayTasksView / AbandonedTodayView / TaskReviewPanel | 120s | mounted/property |
| AttendanceBoard | 120s | board.is_today |
| LiveLocationMap | 30s (+10s age clock) | mounted |

Channels `priv:prop:{uid}:*`: `tasks`, `units`, `maintenance`, `employees`
(AppContext) + `locations`, `attendance` (LiveLocationMap/AttendanceBoard).
Token flow: `GET /realtime/token` → `POST /realtime/subscribe` per channel;
503 → sticky `unavailable` (poll-only mode).

## 10. Tests

**Backend** (`backend/tests/`, `pytest.ini`: `asyncio_mode=auto`; no conftest —
each file builds fakes; scripted `_Session`s, real SQLite via sync engine for
reads, ASGITransport + dependency_overrides for routes, respx for outbound):

| File | Covers |
|---|---|
| test_auth_login | login CTE single-write, uniform 401, concurrency, audit w/o credentials |
| test_db_pooler | pooler mode classification, pgbouncer connect args, error-path resilience |
| test_employee_events | EB allocation-notice buffer/dispatch/savepoint semantics, failures swallowed |
| test_employee_profile | metrics keyed by employee_id, PM scoping, 403s, escaping, no-store |
| test_live_locations | EB proxy end-to-end (904 lines): error map, PM pinning, on-duty gating |
| test_logs | SA-only guards, filter 422s, compiled-SQL assertions, attachment traversal |
| test_perf_regressions | query-count budgets on occupancy paths |
| test_realtime | channel grammar, JWT claims, publish envelope, channel authz boundary |
| test_shifts | largest (648): IST windows/overnight, bitmap, status-board states, overlap 409, attendance-doesn't-gate-allocation |
| test_task_review | approve/reject workflow, reviewer gates, PM property scoping |
| test_verify_queue | bounded queue: reject/timeout/Retry-After, dummy hash |

**Frontend** (vitest+jsdom, config in `vite.config.ts`): LogsView, TaskJourney,
EmployeeDetailView, EmployeeDirectory, LiveLocationMap, ZoneBoard,
activityLogs.

**Load harness** `tests/load/` (opt-in, `--confirm-load-test`; runners have
`__test__=False`): `load_common` (classification/percentiles/safety caps
≤1000 conc, ≤5000 req), `test_concurrent_login` (burst/stages/sustained,
`--server-pid` psutil, `--db-url` pg_stat_activity), `test_post_login_stability`,
`analyze_results`, `seed_accounts`, `dev_stub` (offline contract server :8899),
`unit/test_load_common`. Production needs `--i-am-sure-production`;
auto-abort >95% failure share.

## 11. Environment variable catalog

Backend `.env.example` (authoritative): `APP_NAME/APP_ENV/DEBUG`,
`API_V1_PREFIX`, `DATABASE_URL` or `SUPABASE_DB_{HOST,PORT,NAME,USER,PASSWORD}`,
`DB_POOL_{SIZE,MAX_OVERFLOW,RECYCLE,TIMEOUT}`, `DB_POOLER_MODE`(auto\|
transaction\|session\|direct), `SUPABASE_{URL,PUBLISHABLE_KEY,SECRET_KEY,
STORAGE_S3_URL,STORAGE_BUCKET}`, `JWT_SECRET_KEY`(required)`/JWT_ALGORITHM/
ACCESS_TOKEN_EXPIRE_MINUTES(30)/REFRESH_TOKEN_EXPIRE_DAYS(30)`, `CORS_ORIGINS`,
`REDIS_URL`+timeouts, `RUN_EMBEDDED_SCHEDULER`(true), `RATE_LIMIT_ENABLED`,
`STORAGE_BACKEND`(local\|auto\|supabase\|s3), `UPLOAD_DIR`,
`MAX_TASK_COMPLETION_IMAGES`(10), `S3_{ENDPOINT_URL,REGION,BUCKET,ACCESS_KEY,
SECRET_KEY,PUBLIC_BASE_URL}`, `EMPLOYEE_API_BASE_URL` (preferred over legacy
`EMPLOYEE_BACKEND_URL`), `LOCATION_SERVICE_API_KEY`, `CENTRIFUGO_{URL,API_KEY,
TOKEN_SECRET,WS_URL}`.

Undocumented-in-example tunables: `SQL_ECHO`, `LOGIN_RATE_LIMIT`(10)+
`_WINDOW_SECONDS`(60), `VERIFY_{MAX_WORKERS,QUEUE_MAX(128),QUEUE_TIMEOUT_S(10),
OVERLOAD_RETRY_AFTER_S(3)}`, `REQUEST_TIMING_ENABLED`,
`LOCATION_SERVICE_TIMEOUT_SECONDS`(8), `AUTH_CACHE_TTL_SECONDS`(60),
`CENTRIFUGO_{CONN,SUB}_TOKEN_TTL_SECONDS`(300/600).

Frontend: `VITE_API_URL`, `VITE_MAX_COMPLETION_IMAGES` (must match backend);
`DISABLE_HMR` honored by vite config. Centrifugo service: `CENTRIFUGO_CLIENT_
TOKEN_HMAC_SECRET_KEY`, `CENTRIFUGO_HTTP_API_KEY`,
`CENTRIFUGO_CLIENT_ALLOWED_ORIGINS`. Load tests: `LOADTEST_*`, `UVICORN_WORKERS`.

## 12. Deploy / CI

- `backend/railway.toml`: Nixpacks; start = `alembic upgrade head && uvicorn
  … --proxy-headers`; `/health` check, restart ×5.
- `backend/Dockerfile` (Cloud Run alt): py3.12-slim; `alembic upgrade head ||
  echo` tolerant of EB-owned stamp + `uvicorn --workers ${UVICORN_WORKERS:-1}`.
- `frontend/vercel.json`: vite build→dist, SPA rewrite.
- `deploy/centrifugo/`: v6 image + config — `priv` namespace,
  `allow_subscribe_for_client:false` (per-channel JWT is the only way in).
- `.github/workflows/deploy-production.yml`: Railway `serviceInstanceDeploy`
  GraphQL + redeploy-on-fail poll; `npx vercel deploy --prod`. **No
  test/typecheck job.**
- `deploy-centrifugo.yml` (manual): provisions service, wires allowed origins
  from Vercel, writes `CENTRIFUGO_*` into SA backend (and employee-api if
  co-located), smoke-tests publish.
- `backend/scripts/`: `audit_probe.py`, `api_probe.py`, `pooler_compat.py` —
  read-only perf probes.

## 13. Discrepancies vs AGENTS.md / drift flags

1. **`POST /resources/{type}/{id}/repair` is `Staff` (SA+PM), not SA-only** —
   workspace.py dep is `Staff`; docstring/AGENTS say super_admin. Consistent
   with the PM-capability rule, but the AGENTS wording is stale.
2. **`POST /work-batches` requires only `get_current_user`** — any authenticated
   account can call it; per-item scoping happens inside the service. AGENTS
   describes staff-only creation.
3. **`GET /media/file/{key}` is intentionally public** (whitelist regex guards).
4. **LiveLocationMap polls at 30s**, not 10s — the 10s figure in AGENTS.md is
   stale (only the "last-seen age" clock ticks at 10s).
5. `area_allocation_state` table exists with no ORM model and zero references —
   dead schema.
6. `properties.latitude/longitude/geofence_radius_m` are real but unmapped
   (EB-owned geofence).
7. `users.role` initial migration allows only 3 enum members; the 5-role vocab
   implies an EB-side change — verify `pg_constraint` on live DB.
8. Tests never touch real Postgres — fake sessions + SQLite; the load harness
   is the only end-to-end coverage. CI has no test gate.
9. Repo root `NUL` and `tests/load/NUL` files (Windows redirect accidents —
   harmless, deletable). `frontend/package.json` name is still `"react-example"`.
10. Many DB constraints exist only in migrations (status CHECKs, attendance
    EXCLUDE, `ck_notifications_type`) — models are intentionally minimal maps;
    `create_all` would not reproduce the schema.
11. **EmployeeDetailView `TABS` literal (line ~36) only lists `overview` and
    `allocations`** — render branches exist for `maintenance`, `records`,
    `attendance`, `device` but no tab buttons reach them. Working-tree WIP or
    dead UI; verify before shipping.
12. `index.css` font is now **Satoshi** (Fontshare import), not Inter; the
    `ea-*` (employee analysis) and `lp-*` (landing) keyframe/utility classes
    live there — see `docs/aesthetics.md` for the design spec driving them.
13. All working-tree content (LogsView, employee detail/analysis, verify_queue,
    load harness, this file) is **uncommitted** on top of HEAD `c1e21e3`
    (2026-10-15) — `git log` does not reflect current surface.
