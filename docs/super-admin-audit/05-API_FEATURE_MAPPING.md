# 05 — API Feature Mapping

`/api/v1` surface. Roles: Staff = SA+PM workspace dep; SA = super_admin only. Used-by = frontend consumer (api/*.ts or component); BG = background/service.

## auth.py (public/authed)

| Method+Route | Purpose | Used by |
|---|---|---|
| POST /auth/login | login | auth.ts |
| POST /auth/refresh | token refresh | client.ts |
| POST /auth/signup | register | Signup |
| POST /auth/logout | logout | context |
| GET/PATCH /auth/me | profile | context, ProfileView |

## workspace/reads.py (Staff)

| Route | Purpose | Used by |
|---|---|---|
| GET /properties, POST /properties | list/create property | properties.ts, PropertiesView |
| GET /properties/{id} | property detail | context |
| GET /properties/{id}/reconciliation | reconcile | API-only (no direct UI) |
| GET /areas /zones /rooms /dorms /washrooms /employees /tasks | entity lists | workspace.ts, api/*, views |
| GET /tasks/today /history /calendar /history/{day} | task reads | tasks.ts, TasksView, day views |

## workspace/structure.py (Staff)

areas CRUD; zones CRUD; rooms CRUD+bulk+bulk-delete+allocation; dorms CRUD+bulk+allocation+checkout+mark-cleaning/cleaned; washrooms CRUD+bulk+detail+fixtures+allocation; `/units/bulk-status`; `/properties/{id}/fresh-day`. → structure/rooms/washrooms/zones.ts; ZonesView, RoomsDormsView, UnitZoneBoard.

## workspace/employees.py (Staff)

`employees/{id}/profile|tasks|analytics|records|locations|attendance/calendar|attendance/day|devices`, `employees/team-analytics`; POST/PATCH/DELETE employees; `/zone`, `/allocation`, `/areas` add/remove, deactivate/reactivate. → employees.ts; EmployeeDirectory, EmployeeDetailView tabs, ZoneBoard, TeamAnalytics.

## workspace/departments.py (Staff)

list/overview/transfers/transfer POST/CRUD/detail/PATCH/DELETE/`PUT /{id}/head`. → departments.ts; EmployeeDashboard, DepartmentsView, DepartmentDetailView, TransferModal, CreateEmployeeModal picklist.

## workspace/tasks.py (Staff)

POST/GET/PATCH/DELETE tasks; review-queue; start/complete/request-redo/assignee/reopen/approve/reject. → tasks.ts; TasksView tabs, TaskDetailDrawer, TaskReviewPanel.

## workspace/maintenance.py (Staff)

CRUD + calendar + history/{day} + assign/start/hold/resolve/disapprove/close; `/washrooms/{id}/maintenance`, `/rooms/{id}/maintenance`. → maintenance.ts; MaintenanceView, modals, MaintenanceTab.

## workspace/occupancy.py (Staff)

`/rooms/{id}/check-in|check-out`, `/beds/{id}/check-in|check-out`, `/occupancy/switch`, `/resources/{t}/{id}/transition|repair`. → OccupancyToggle, SwitchGuestModal, room/bed actions.

## workspace/properties.py (Staff)

PATCH/DELETE /properties/{id}; GET/PATCH /companies/{id}. → properties.ts, companies.ts (PropertiesView edits).

## workspace/bootstrap.py (Staff)

`GET /workspace` — consolidated bootstrap payload. → AppContext load.

## templates.py (Staff)

CRUD + pause/resume/activate/archive/duplicate/history/generated-work/generate-occurrence/generate-due. → templates.ts; TemplatesView, wizard, drawer.

## shifts.py (Staff)

`/shifts` CRUD; `/employees/{uid}/shift-assignments` GET/POST; `/shift-assignments` list/PATCH/DELETE. → shifts.ts; ShiftManager, ProfileView, CreateEmployeeModal (auto-assign).

## attendance.py (PM dep)

`status-board`, `/requests`, approve/reject. → attendance.ts; AttendanceBoard, LeavesPanel.

## locations.py (PM dep)

`/live-locations`, `/{employee_uid}`, `/history`. → locations.ts; LiveLocationMap, LocationsTab.

## logs.py (SA only)

`/logs`, `/logs/tasks`, `/logs/tasks/{id}/journey`, `/logs/attachments/{src}/{id}`. → logs.ts; LogsView, TaskJourney.

## realtime.py (authed)

`/token`, `/subscribe` — Centrifugo. → realtime client (live invalidation).

## media.py (authed)

`POST /media/uploads`? (POST+GET — file upload/serve) → media.ts, evidence photos, attachments.

## work_batches.py (Staff)

POST /work-batches; GET list + detail. → backend allocation flow; **no dedicated UI** (consumed via task list).

## va.py (Staff)

`/webrtc` POST/DELETE (WHEP proxy); `/media-health`, `/media-stats`; cameras CRUD/bulk-move/test-connection/stream-session; stream-sessions GET/DELETE. → va.ts; VaVms, VaCameraSettings.

## Backend-only / no direct UI

- `/properties/{id}/reconciliation` — reconciliation data, no dedicated screen.
- `/work-batches` — allocation engine internals; visible only via tasks.
- `/tasks/generate-due` (templates) — BG trigger.
- `fresh-day` rollover — BG/admin.
- Audit writes — service-internal (no query API except logs feed).
