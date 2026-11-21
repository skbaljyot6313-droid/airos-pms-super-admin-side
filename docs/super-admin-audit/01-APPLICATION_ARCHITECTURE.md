# 01 — Application Architecture

## Stack

- **Frontend**: React 19 + TypeScript + Vite (rolldown), Tailwind 4, `react-router-dom` v6, `lucide-react` icons. Entry `src/main.tsx` → `App.tsx`.
- **Backend**: FastAPI modular monolith (`Management Tool API`), SQLAlchemy 2 async + asyncpg → PostgreSQL, Alembic linear migration chain **shared with the employee repo** (one `alembic_version` row).
- **Auth**: JWT bearer + refresh tokens (`core/security.py`), Argon2id passwords. `apiFetch` (`api/client.ts`) attaches Bearer, single-flight 401 refresh.
- **State**: `AppContext` (`context/AppContext.tsx`) — user, properties, employees, zones, tasks caches + `addToast`. Per-request `perf` instrumentation (`dev/perf`).
- **Realtime**: Centrifugo — backend mints channel tokens (`/realtime/token`, `/realtime/subscribe`); frontend subscribes for live invalidation.
- **Media (VA)**: go2rtc (RTSP ingest/restream) → MediaMTX (WHEP/HLS) — see VA audit doc.

## Roles (`models/user.py::UserRole`)

| Role | Scope |
|---|---|
| `super_admin` | whole company — all properties, /admin/* views |
| `property_manager` | one property — full property workspace |
| `human_resource` | defined, **no workspace routes grant it** |
| `department_manager` | defined, **no routes grant it** |
| `employee` | mobile app only — blocked from admin UI (`RequireAuth` redirect) |

**Backend guards**: `require_super_admin`, `require_property_manager` (SA+PM) → workspace `Staff` dep; service-layer `_property_for_write` enforces SA=same-company, PM=own-property.

**Frontend guards**: `RequireAuth` (JWT + role blocklist employee/HR/dept_manager), `RequireRole` (per-route), `PropertyScopedView` (URL↔scope check), `WorkspaceGate` (waits context hydration).

## Layout

- `App.tsx` — all routes, lazy page components, `RootRedirect` (`*` → role home).
- `Header.tsx` — top nav: property-scoped items OR admin items; active highlight by path prefix.
- Pages render their own `BackButton` + `EmployeeManagementNav`-style sub-navs; **no nested layout routes** — `PropertyScopedView` is a switch.
- `components/ui/` — shared Modal, Drawer, ConfirmationDialog, Button, Badge, Card, OperationalCalendar, ToastContainer.

## Backend layout (`app/`)

- `api/v1/router.py` — mounts `auth`, `workspace` (aggregates `bootstrap/departments/employees/maintenance/occupancy/properties/reads/structure/tasks`), `media`, `work_batches`, `templates`, `attendance`, `shifts`, `locations`, `realtime`, `logs`, `va`.
- `services/` — business logic (no logic in handlers): `employee`, `employee_profile`, `department`, `structure`, `task`, `work_allocation`, `maintenance`, `attendance`, `shifts`, `camera`/`go2rtc`/`mediamtx` (VA), `audit`, `logs`, `template`, `occupancy`, `employee_events` (EB push), `media`/`storage`.
- `models/` — 19 modules: user, company, property, structure (area/zone/room/dorm/bed/washroom/fixture), employee(+area_assignments), department(+transfers), task, template, work_allocation, maintenance, attendance, shift, occupancy, notifications, audit, resource_state_event, camera, allocation, refresh_token.
- `core/` — config, database (instrumented pool), security, exceptions (dual `detail`+`error` envelopes), middleware (request-id, access log).

## Conventions

- Wire IDs are `*_uid` strings; lists envelope `{items,total,page,limit}`.
- Business dates = IST `YYYY-MM-DD` operational days (06:00 rollover).
- `visual_state` server-computed; `ResourceStateService` sole state writer.
- Employee lifecycle: staff can't self-complete; SA/PM approve/reject.
- Realtime events: post-commit `queue_event` → property topics.
- Audit: `audit_events` append-only via `AuditService.record`.
