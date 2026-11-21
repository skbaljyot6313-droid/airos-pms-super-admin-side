# 11 — Detailed Feature Reference (Page-by-Page)

Exhaustive reference of every page, its sections, tabs, modals, and user actions. Read alongside `02-ROUTE_INVENTORY.md` (paths) and `05-API_FEATURE_MAPPING.md` (endpoints).

---

## A. Public pages

### A1. Landing Page — `/`
`components/landing/LandingPage.tsx`
- Marketing/entry page for AiROS.
- CTAs to `/login` and `/signup`.
- No authenticated content.

### A2. Login — `/login`
`components/auth/Login.tsx` + `FormField` + `PasswordInput`
- Email + password form; validation; error display.
- On success → role-based home (SA → `/admin/properties` or property; EMP → blocked).
- `POST /auth/login` → JWT + refresh.

### A3. Signup — `/signup`
`components/auth/Signup.tsx`
- Account registration form.
- `POST /auth/signup`.

---

## B. Admin mode (super_admin only — top nav: Properties | Settings | Logs)

### B1. Properties — `/admin/properties`
`components/properties/PropertiesView.tsx` + `CreatePropertyModal.tsx`

**Sections:**
- Property cards/grid — name, code, location.
- "Create property" button → `CreatePropertyModal`.

**Actions:**
- Create property (name, code, location).
- Click card → enters property workspace (`/property/{uid}/zones`).
- Edit / delete property (service-level `PATCH`/`DELETE /properties/{id}`).

**APIs:** `GET /properties`, `POST /properties`, `GET /companies/{id}`.

### B2. Settings — `/admin/settings`
`components/admin/AdminSettingsView.tsx`

**Panels (icons: Database, Clock3, RefreshCw, Building2):**
- System/database status panel.
- Operational refresh tools.
- Company-level info.

**APIs:** company/property reads; system health.

### B3. Logs — `/admin/logs`
`components/admin/LogsView.tsx` + `ActivityTimeline.tsx`, `ActivityEvent.tsx`, `TaskJourney.tsx`

**Sections:**
- Property picker grid → select a property.
- "View all company logs" toggle (company-level sessions/activity not tied to a property).
- Activity feed — `ActivityTimeline` of `ActivityEvent` rows.
- Task journey drill-in — `TaskJourney` (full lifecycle of a task).
- Attachments viewer (`/logs/attachments/{source}/{event_id}`).

**APIs:** `GET /logs`, `GET /logs/tasks`, `GET /logs/tasks/{id}/journey`, `GET /logs/attachments/…`.

---

## C. Property mode (nav: Zones | Employee Management | Rooms | Tasks | VA | Profile)

### C1. Zones — `/property/:uid/zones`
`components/zones/ZonesView.tsx` + `ZoneWorkspace.tsx` + `CreateZoneModal.tsx` + `CreateAreaModal.tsx`

**Sections:**
- Zone board — visual map of areas → zones → coverage.
- Staff coverage overlay per zone.
- Drill-in `ZoneWorkspace` for a selected zone.

**Modals:** `CreateZoneModal`, `CreateAreaModal`.

**Actions:** create/edit/delete zones & areas; view zone composition; trigger `POST /properties/{id}/fresh-day` (IST rollover) via service.

**APIs:** `GET /zones`, `GET /areas`, `POST/PATCH/DELETE /zones`, `…/areas`, `POST /properties/{id}/fresh-day`.

### C2. Employee Management — `/property/:uid/employees` (dashboard landing)
`components/employees/management/` — `EmployeeManagementNav` gives the **Dashboard | Employees | Departments** sub-nav.

#### C2a. Dashboard — `/employees` — `EmployeeDashboard.tsx`
**Sections:**
- 7 metric cards: total employees, active, inactive, total departments, unassigned employees, departments without head, avg employees/department.
- Department cards — name, head, total/active/inactive staff, distribution bars, "Default" badge on system depts.

**Actions:** click dept card → department detail.

**APIs:** `GET /departments`, `GET /departments/overview`, `GET /employees`.

#### C2b. Employees — `/employees/staff` — `EmployeesView.tsx` (8 tabs)

| Tab | Component | Contents |
|---|---|---|
| Zone Board | `ZoneBoard.tsx` | Drag-drop employee→zone/area allocation; coverage map |
| Directory | `EmployeeDirectory.tsx` + `CreateEmployeeModal.tsx` | Searchable/filterable staff list; create/edit/deactivate/delete |
| Deactivated | (inline) | Inactive staff list; reactivate |
| Live Location | `LiveLocationMap.tsx` | Leaflet map of on-duty staff (10s poll, cluster markers) |
| Leaves | `LeavesPanel.tsx` | Leave/week-off requests — approve/reject |
| Shifts | `ShiftManager.tsx` | Shift CRUD + assign/unassign employees |
| Attendance | `AttendanceBoard.tsx` | Per-day status board (working/on_break/absent/…/needs_review) |
| Analytics | `analysis/TeamAnalytics.tsx` + `PeriodSelector` | Team metrics over a period |

**CreateEmployeeModal fields:** name, job_title, **department picklist (live `/departments` + static fallback)**, email, phone, password, primary zone, shift, start_date → creates employee + auto shift-assignment.

**Directory row actions:** edit (same modal), deactivate, delete; filters by department/zone/status.

**APIs:** `GET /employees`, `POST /employees`, `PATCH /employees/{id}`, `DELETE`, `PATCH …/zone` & `…/allocation`, `POST …/areas`, `DELETE …/areas/{uid}`, `POST …/deactivate` & `…/reactivate`, `GET /live-locations`, `GET /attendance/status-board`, `GET /attendance/requests`, `shifts` suite, `GET /employees/team-analytics`.

#### C2c. Departments — `/employees/departments` — `DepartmentsView.tsx`
`+ DepartmentFormModal.tsx`, `TransferModal.tsx`

**Sections:**
- Searchable/sortable departments table; "show inactive" filter.
- Per-row: name (+"Default" badge for `is_system`), head, staff count, status, actions.

**Actions:**
- Create → `DepartmentFormModal` (name, code, description, status, optional head picker).
- Edit → same modal.
- **Delete** — disabled on system depts & non-empty depts (`ConfirmationDialog`).
- **Assign/change head** — employee picker.
- **Transfer** → `TransferModal` (single/bulk; shows current dept + head flag; destination active-depts only; if head → explicit clear/replace decision; reason field).

**APIs:** `GET /departments`, `POST/PATCH/DELETE /departments/{id}`, `PUT /{id}/head`, `POST /departments/transfer`.

#### C2d. Department Detail — `/employees/departments/:departmentUid` — `DepartmentDetailView.tsx`
**Sections:** info cards (name, code, status, created), head card, roster table (name, title, status, head badge → link to employee), department-scoped transfer history.

**APIs:** `GET /departments/{id}` (roster), `GET /departments/transfers`.

#### C2e. Employee Detail — `/employees/:employeeUid` — `EmployeeDetailView.tsx` (7 tabs)

| Tab | Component | Contents |
|---|---|---|
| Overview | `analysis/OverviewTab.tsx` | Profile, allocation summary |
| Allocations | `analytics/AllocationTimeline.tsx` | Task-allocation history |
| Maintenance | `analysis/MaintenanceTab.tsx` | Maintenance tickets for employee |
| Records | (RecordsSection) | Employee records |
| Attendance | `analysis/AttendanceTab.tsx` | Calendar + day detail |
| Device | `analysis/DevicesTab.tsx` | Registered devices |
| (Locations) | `analysis/LocationsTab.tsx` | Location history |

**APIs:** `GET /employees/{id}/profile|tasks|analytics|records|locations|attendance/calendar|attendance/day|devices`.

### C3. Rooms — `/property/:uid/rooms` — `RoomsDormsView.tsx` (3 tabs)

#### rooms tab
- `CreateRoomModal`, `BulkCreateRoomsModal`, `EditRoomModal`.
- Room cards — status, allocation, `OccupancyToggle` (check-in/check-out).
- `SwitchGuestModal` — move guest between rooms/beds.
- `RequestItemModal`.
- Bulk-delete.

#### dorms tab
- `CreateDormModal`, `BulkCreateDormsModal`, `EditDormModal`.
- Bed tiles — check-in/check-out, guest switch.
- Dorm checkout → `mark-cleaning` → `mark-cleaned` (spawns cleaning task).

#### washrooms tab — `WashroomsView.tsx`
- `WashroomModal`, `BulkCreateWashroomsModal`, `WashroomDetailModal` (per-fixture status).
- `AssignWashroomTaskModal`, `ScheduleWashroomMaintenanceModal`.

**Shared:** `UnitZoneBoard` — zone-grouped unit view; `POST /units/bulk-status`.

**APIs:** rooms/dorms/washrooms CRUD + bulk + `/allocation`; `/rooms/{id}/check-in|check-out`; `/beds/{id}/check-in|check-out`; `/occupancy/switch`; `/dorms/{id}/checkout|mark-cleaning|mark-cleaned`; `/washrooms/{id}`+`/fixtures/{fid}`; `/resources/{t}/{id}/transition|repair`.

### C4. Tasks — `/property/:uid/tasks` — `TasksView.tsx` (7 tabs, `?tab=` deep-link)

| Tab | Component | Contents |
|---|---|---|
| Today | `TodayTasksView.tsx` + `CreateTaskModal.tsx` | Day's tasks; manual create |
| Abandoned | `AbandonedTodayView.tsx` | Auto-abandoned tasks |
| Review | `TaskReviewPanel.tsx` + `CompletionEvidenceLightbox.tsx` | Employee submissions → approve/reject/redo w/ evidence |
| Maintenance | `MaintenanceView.tsx` + `CreateMaintenanceModal.tsx` + `MaintenanceCalendarView.tsx` | Tickets list + calendar |
| Templates | `TemplatesView.tsx` + `TemplateWizard.tsx` + `TemplateDetailDrawer.tsx` | Recurring-work templates: create/edit, pause/resume/activate/archive/duplicate, generate-occurrence, history, generated-work |
| History | `TaskHistoryView.tsx` | Past days → drill to `…/history/:date` |
| Calendar | `TaskCalendarView.tsx` | Month grid of task counts |

**Shared:** `TaskDetailDrawer` — view/edit/reassign/reopen/start/complete + journey; `EvidencePhoto`.

**Drill-ins:** `TaskDayAnalysisView` (`tasks/history/:date`), `MaintenanceDayAnalysisView` (`maintenance/history/:date`).

**APIs:** `tasks` CRUD + `review-queue`, `start/complete/request-redo/assignee/reopen/approve/reject`; `maintenance` CRUD + `calendar`, `history/{day}`, `assign/start/hold/resolve/disapprove/close`; `templates` CRUD + lifecycle + `generate-*`.

### C5. VA (Video Analytics) — `/property/:uid/va/:tab` — `VaView.tsx` (2 tabs)

#### vms tab — `VaVms.tsx`
- Multi-camera live grid (1/4/9/16 tiles).
- Per-tile: main/sub stream quality, fullscreen, first-frame detect, idle cleanup, `[va-perf]` timing logs.
- WebRTC (WHEP) + HLS playback via MediaMTX.

#### camera-settings tab — `VaCameraSettings.tsx`
- Camera CRUD — RTSP URL, substream, name, area/zone assignment.
- Transcode toggle, **warm** keepalive flag.
- Test-connection, stream-session, bulk-move.

**APIs:** `/va/webrtc` (WHEP proxy), `cameras` CRUD, `/cameras/{id}/test-connection|stream-session`, `/stream-sessions/*`, `/media-health`, `/media-stats`.

### C6. Profile — `/property/:uid/profile` — `ProfileView.tsx`
- Own profile card (name, email, role).
- Assigned shift card.
- `PATCH /me` self-update.

---

## D. Redirects / hidden

| Route | Target |
|---|---|
| `/property/:uid` | `…/zones` |
| `/property/:uid/va` | `va/vms` |
| `…/maintenance` | `…/tasks?tab=maintenance` |
| `…/templates` | `…/tasks?tab=templates` |
| `*` | role home |

**Hidden (link/drill-in only):** employee detail, department detail, task/maintenance day views, `va/camera-settings` tab, all in-page tabs.

---

## E. Backend-only capabilities (no UI)

- `GET /properties/{id}/reconciliation` — drift scan.
- `POST /properties/{id}/fresh-day` — IST rollover.
- `POST /templates/generate-due` — scheduler.
- `work-batches` — allocation internals.
- `audit_events` — audit writes (read via `/logs`).
- `employee_events` → EB `/admin/notify-allocation` — post-commit push.
- Resource state engine (`ResourceStateService`) — `transition/derive/repair`.
- Rollover/midnight sweep (`RolloverService`) — `POST /internal/generation-tick`.

---

*Cross-references: routes → `02`, endpoints → `05`, roles → `08`, overlap → `06`, hidden → `07`.*
