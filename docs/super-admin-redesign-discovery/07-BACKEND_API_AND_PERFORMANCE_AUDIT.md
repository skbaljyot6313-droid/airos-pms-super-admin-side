# 07 — Backend API and Performance Audit

Scope: FastAPI routers, service/repository layers, schemas, query patterns, indexes, frontend fetch patterns, realtime, and polling. **No optimisation was implemented.** Items marked NEEDS VERIFICATION were not measured under load.

## 1. API coverage

- **169** route decorators under `backend/app/api/v1` (`@router.get|post|patch|put|delete`), mounted under `/api/v1` by `api/v1/router.py`.
- Routers: `auth`, `workspace` (aggregator of `bootstrap`, `reads`, `structure`, `occupancy`, `employees`, `departments`, `tasks`, `maintenance`, `properties`), `templates`, `shifts`, `attendance`, `locations`, `logs`, `va`, `media`, `work_batches`, `realtime`.
- Full endpoint-by-endpoint mapping: `docs/super-admin-audit/05-API_FEATURE_MAPPING.md`.

### 1.1 Aggregate endpoints that exist

| Endpoint | What it aggregates | Efficiency |
|---|---|---|
| `GET /workspace` | Nine collections in one request (properties, areas, zones, rooms, dorms, washrooms, employees, tasks, maintenance) via `asyncio.gather` with separate sessions | One round trip, but **unbounded** (see §2.1) |
| `GET /departments/overview` | Totals + per-department counts | Two aggregate queries, no N+1 (per prior report) |
| `GET /attendance/status-board` | Day status for staff | Shift-driven; single evaluator |
| `GET /tasks/today`, `/tasks/history`, `/tasks/calendar`, `/tasks/history/{day}` | Task slices | Per-request |
| `GET /properties/{id}/reconciliation` | Read-only drift scan | Read-only, not used by the UI |

### 1.2 Missing aggregate endpoints (needed by the redesign)

| Proposed endpoint | Purpose | Data sources | Feasibility |
|---|---|---|---|
| `GET /overview/summary?property_id` | KPI strip with deltas | tasks, maintenance, employees, resources | Feasible with composite indexes |
| `GET /overview/trends?days=14` | Completion and occupancy trends | tasks (`completed_at`), occupancies | Feasible; one grouped query per series |
| `GET /workforce/summary` | Headcount, active, unallocated, dept distribution | employees, departments | Feasible; current `/departments/overview` covers most |
| `GET /workforce/attendance-summary?from&to` | Present/absent/leave by day | attendance_days | Feasible; requires date column (VARCHAR today) |
| `GET /operations/summary` | Status counts, abandoned by reason, reviews | tasks, submissions | Feasible; needs status index |
| `GET /operations/completion-trend?days` | Completed per day | tasks | Feasible with `completed_at` index |
| `GET /operations/workload` | Tasks per employee | tasks | Feasible |
| `GET /property/units/state-summary` | State counts per unit type | rooms, dorms, beds, washrooms | Feasible; resource drift must be fixed for correctness |
| `GET /insights/...` | Historical and comparative views | multiple | Feasible after indexes; property comparison needs RBAC decision for SA only |
| `GET /hr/...` | Compensation, payroll, leave balances, documents | new tables | **Not feasible until built** |

Recommendation: **one summary endpoint per destination** (Overview, Workforce, Operations, Property, Insights) returning a typed payload for the whole screen, plus targeted list endpoints for drill-down. This replaces the current pattern of loading everything into `AppContext`.

## 2. Frontend data fetching

### 2.1 Initial load (`AppContext.tsx`)

- On sign-in, the SPA calls `GET /workspace` (fallback: nine parallel GETs if `/workspace` returns 404).
- **Unbounded task load**: `_tasks` in `api/v1/workspace/bootstrap.py` calls `WorkspaceRepository.list_tasks(user)` with **no limit**. The property has 1,805 tasks in the dev database; the payload grows with history.
- **Fallback mismatch**: the nine-GET fallback uses `tasksApi.listTasks({ limit: 500 })` — a **different** result set from the bootstrap. Results differ by environment (NEEDS VERIFICATION of `list_tasks` default behaviour when no limit is passed).
- All collections are held in `AppContext` and metrics are computed client-side (e.g. `OverviewView` filters `currentPropertyTasks` and `currentPropertyMaintenance`). This will not scale to multi-year history.

### 2.2 Per-page fetches

| Page | Calls on mount | Notes |
|---|---|---|
| Overview | `GET /departments/overview`, `GET /tasks/review-queue` + context collections | Two extra calls; errors swallowed |
| Workforce Dashboard | `GET /departments/overview` | Single call |
| Employees (directory) | context + `GET /employees` (through bootstrap) | — |
| Live location | `GET /live-locations` polled every **10 s** (`LiveLocationMap.tsx` L625 `setInterval`) | Polling while map visible; NEEDS VERIFICATION that polling stops when hidden |
| Tasks tabs | `/tasks/today`, `/tasks/history`, `/tasks/calendar` per tab | Tab switching triggers new requests |
| VMS | Sessions + heartbeat `setInterval` (`VaVms.tsx` L137) | Heartbeats per tile |
| Generic | `usePolling` hook (`hooks/usePolling.ts` L47) | Interval refresh; consumers not enumerated |

### 2.3 Duplicate or redundant calls

- Department overview is fetched by Overview, Workforce Dashboard, and department list (three separate calls, same data).
- `taskReviewQueue` is fetched by Overview and by the Review tab independently.
- `GET /logs` for Insights/Audit and Admin/Logs (same screen, two routes).
- Department list is fetched in `CreateEmployeeModal`, `EmployeeDirectory` filter, and Departments page — each independently (NEEDS VERIFICATION whether AppContext caches it).

## 3. Realtime

- **Centrifugo** is integrated. Backend: `core/centrifugo.py` (tokens, post-commit publish); `POST /realtime/subscribe` mints per-channel JWTs.
- Frontend: `realtime/client.ts`, `realtime/useRealtimeChannel.ts`; consumers: `AppContext`, `AttendanceBoard`, `LiveLocationMap`, `AbandonedTodayView`, `TaskReviewPanel`, `TodayTasksView`.
- Events are **invalidation hints**: the SPA refetches or merges, never trusts the payload as truth (per `AGENTS.md`).
- Realtime is **optional** (`CENTRIFUGO_*` unset → disabled). Verify behaviour in environments without it.
- Dashboards should use realtime invalidation for `tasks`, `maintenance`, and `resource` changes instead of polling.

## 4. Query patterns and N+1 risk

- Bootstrap helpers (`rooms_payload`, `dorms_payload`, `_tasks_list_payload`) receive the session and list items — these are batch-style helpers by name. NEEDS VERIFICATION that they issue one query per collection rather than per item (not measured).
- `employee_profile.py` (~1,200+ lines) composes multi-query profile payloads per employee — the highest N+1 risk if used in list views. Current use is per-detail page only.
- `DepartmentService.overview` uses grouped counts (no N+1 per the prior department audit).
- No dashboard endpoint currently joins tasks to departments (no `department_id` on tasks) — any department task metric needs a join through `employees` at query time (cost to be measured).

## 5. Index review (for dashboard predicates)

Existing (from `schema.json` introspection):
- `tasks`: single-column indexes on `property_id`, `employee_id`, `zone_id`, `room_id`, `dorm_id`, `washroom_id`, `template_id`, `series_id`, `expires_at` (partial), `allocation_batch_id`; unique partial on open room title and series due.
- `maintenance_tickets`: single-column on `status`, `property_id`, `zone_id`, `assigned_to`, etc.
- `attendance_days`: **only `property_id`**.
- `employees`: single-column on `property_id`, `company_id`, `zone_id`, `area_id`, `department_id`.
- `audit_events`: `created_at`, `property_id`, `(entity_type, entity_id)`, `action`, `actor_user_id`.
- `resource_state_events`: `resource_type`, `resource_id`, `property_id`.
- `occupancies`: 5 indexes (room, bed, property, …).

**Missing composites for dashboard predicates** (recommended, not created):

| Table | Proposed index | Predicate it serves |
|---|---|---|
| `tasks` | `(property_id, status, completed_at)` | completion trends, status counts |
| `tasks` | `(property_id, operational_date)` | day views |
| `tasks` | `(property_id, abandoned_at)` where abandoned | abandon trends |
| `attendance_days` | `(property_id, attendance_date)` | presence by day |
| `attendance_days` | `(employee_id, attendance_date)` | employee history |
| `maintenance_tickets` | `(property_id, status, created_at)` | queue and trend |
| `employees` | `(property_id, deactivated_at)` | active/inactive counts |
| `occupancies` | `(property_id, checked_in_at)` and partial `(property_id) WHERE checked_out_at IS NULL` | occupancy and open stays |
| `resource_state_events` | `(property_id, created_at)` | state trend |
| `task_completion_submissions` | `(status, submitted_at)` | review queue and turnaround |
| `refresh_tokens` | `(expires_at)` | purge job |

Date columns are `VARCHAR`; range indexes on text ISO dates work but are fragile. Converting to `DATE` is the durable fix (see `03` §5).

## 6. Housekeeping and growth

- `refresh_tokens`: **23,817 rows**, 161 expired; no purge job in the Super Admin backend. Growth is unbounded. Needs a scheduled purge (`expires_at < now() - interval`) and a review of Employee Backend behaviour (NEEDS VERIFICATION).
- `resource_state_events`: 4,194 rows in ~7 weeks; grows with every transition. Retention policy needed before multi-year reporting.
- `task_history_events`: 4,255 rows in ~7 weeks; same.
- `location_tracking_sessions`: 1,178 rows (EB-owned); retention policy needed (privacy-sensitive).
- `template_generations`: 631 rows; idempotency ledger; retention policy needed.
- `notifications`: 1,008 rows; retention policy needed.

## 7. Scalability risks (ranked)

1. **Unbounded `/workspace` task payload** — grows with task history; will degrade login and every page.
2. **Client-side metric computation over full collections** — the Overview and Workforce pages compute from context; should move to server aggregates.
3. **Missing composite indexes** — dashboards will full-scan `tasks` (1,805 rows now; the table grows daily).
4. **`refresh_tokens` growth** — auth table bloat.
5. **Resource state drift** — correctness risk, not performance.
6. **Polling** — live map (10 s) and VMS heartbeats; acceptable but must stop when hidden.
7. **Duplicate fetches** — same department overview in three places.

## 8. Recommended API strategy

1. One summary endpoint per primary destination (5) returning a typed payload.
2. Keep list endpoints for drill-down with server-side pagination (`page`, `limit`, existing envelope `{items,total,page,limit}`).
3. Reduce `/workspace` to the collections needed for shell and property selection (properties, zones, rooms summary); move tasks and employees to paged endpoints.
4. Realtime invalidation over polling for operational data.
5. Server-side date ranges in IST; accept `from`/`to` as `YYYY-MM-DD`.
6. Enforce RBAC inside each summary endpoint (no compensation fields in workforce summary).
7. Cache per-property summaries with short TTL and realtime invalidation (Redis is an accelerator in EB; SA has `redis.py` — verify availability in deployment).

## 9. Security observations (affect the redesign)

- Public media path in the Employee Backend (`GET /media/file/{key}`, public, 240/min) must not serve HR documents.
- `audit_events.detail` is free JSON — verify no sensitive content (salary, bank) is written; add a redaction contract.
- Signup creates or exposes accounts at scale (513 Super Admin accounts) — verify before exposing any user-count metric.
- Leave-approval permission differs between backends (SA: SA+PM; EB: SA only) — align before building HR approvals.
