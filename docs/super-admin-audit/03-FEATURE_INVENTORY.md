# 03 — Feature Inventory (granular)

IDs: Z=Zones, R=Rooms, E=Employee Mgmt, T=Tasks, M=Maintenance, V=VA, A=Admin, P=Profile/Auth, X=Cross-cutting.

## Zones (`…/zones` — ZonesView + ZoneWorkspace)

| ID | Feature | Access |
|---|---|---|
| Z1 | Zone board — visual per-area/zone layout | SA+PM, nav |
| Z2 | Create zone (`CreateZoneModal`) | page |
| Z3 | Create area (`CreateAreaModal`) | page |
| Z4 | Zone drill-in workspace (`ZoneWorkspace`) | click |
| Z5 | Edit/delete zones & areas (service) | API |
| Z6 | Zone→staff coverage display | board |
| Z7 | `POST /properties/{id}/fresh-day` — IST rollover | API |

## Rooms/Dorms/Washrooms (`…/rooms` — RoomsDormsView)

| ID | Feature | Access |
|---|---|---|
| R1 | Rooms tab — list, create (`CreateRoomModal`), bulk (`BulkCreateRoomsModal`), edit, delete, bulk-delete | tab |
| R2 | Room allocation assignment (`/rooms/{id}/allocation`) | row action |
| R3 | Dorms tab — create/bulk (`CreateDormModal`,`BulkCreateDormsModal`), edit, allocation | tab |
| R4 | Dorm checkout / mark-cleaning / mark-cleaned | actions |
| R5 | Beds — check-in / check-out, guest switching (`SwitchGuestModal`, `/occupancy/switch`) | bed tiles |
| R6 | Rooms — check-in / check-out (`OccupancyToggle`) | cards |
| R7 | Washrooms tab — CRUD, bulk, detail (`WashroomDetailModal`), fixtures, allocation | tab |
| R8 | Washroom maintenance scheduling (`ScheduleWashroomMaintenanceModal`), task assign (`AssignWashroomTaskModal`) | actions |
| R9 | Unit status board (`UnitZoneBoard`, `/units/bulk-status`) | tab |
| R10 | Resource state transitions (`/resources/{t}/{id}/transition`, `/repair`) | contextual |

## Employee Management (`…/employees*`)

| ID | Feature | Access |
|---|---|---|
| E1 | Dashboard — 7 org metrics + dept cards (`EmployeeDashboard`) | nav landing |
| E2 | Staff board tab — zone/area drag-drop allocation (`ZoneBoard`) | /staff |
| E3 | Directory tab — list, search, dept/zone/status filters, edit modal (`EmployeeDirectory`) | /staff |
| E4 | Create staff (`CreateEmployeeModal`: name, job_title, dept picklist, email, phone, password, zone, shift, start_date) | header btn |
| E5 | Deactivate / reactivate / delete employee | row menu |
| E6 | Deactivated staff tab | /staff |
| E7 | Live-location map tab (`LiveLocationMap`) | /staff |
| E8 | Leave requests tab (`LeavesPanel` — approve/reject) | /staff |
| E9 | Shift management tab (`ShiftManager` — CRUD shifts, assign, unassign) | /staff |
| E10 | Attendance tab (`AttendanceBoard` — day status board) | /staff |
| E11 | Team analytics tab (`analysis/TeamAnalytics` + `PeriodSelector`) | /staff |
| E12 | Departments view — list/search/sort/inactive, CRUD, head assign, safe delete (is_system protected) | sub-nav |
| E13 | Department detail — metrics, head, roster, transfer history | click |
| E14 | Department transfer — single + bulk, head clear/replace decision (`TransferModal`) | actions |
| E15 | Employee detail — overview, allocations timeline, maintenance, records, attendance, devices (`analysis/*Tab`) | row click |
| E16 | Employee zone/area/property-wide + secondary-zone allocation (PATCH endpoints) | board |
| E17 | System dept auto-provisioning (8 canonical, non-deletable) | backend |

## Tasks (`…/tasks` — TasksView)

| ID | Feature | Access |
|---|---|---|
| T1 | Today tab — day's task list, manual create (`CreateTaskModal`) | default |
| T2 | Abandoned tab (`AbandonedTodayView`) | tab |
| T3 | Review queue tab (`TaskReviewPanel` — approve/reject/redo, evidence `CompletionEvidenceLightbox`) | tab |
| T4 | Maintenance tab (`MaintenanceView` + `CreateMaintenanceModal`, `MaintenanceCalendarView`) | tab |
| T5 | Templates tab (`TemplatesView`, `TemplateWizard`, `TemplateDetailDrawer` — pause/resume/activate/archive/duplicate/generate) | tab |
| T6 | History tab (`TaskHistoryView` — day drill-in → `tasks/history/:date`) | tab |
| T7 | Calendar tab (`TaskCalendarView`) | tab |
| T8 | Task detail drawer (`TaskDetailDrawer` — edit, reassign, reopen, start, complete, journey) | row |
| T9 | Day analyses (`TaskDayAnalysisView`, `MaintenanceDayAnalysisView`) | drill |

## VA (`…/va/:tab`)

| ID | Feature | Access |
|---|---|---|
| V1 | VMS grid — multi-camera live tiles (1/4/9/16), sub/main quality, fullscreen | tab (SA+PM) |
| V2 | WebRTC(WHEP)/HLS playback, first-frame detect, idle cleanup | tile |
| V3 | Camera settings — CRUD, zones/areas, substream, transcode, warm flag | tab |
| V4 | Stream sessions, media health/stats | API |

## Admin (`/admin/*`)

| ID | Feature | Access |
|---|---|---|
| A1 | PropertiesView — company property list, create (`CreatePropertyModal`), open | SA nav |
| A2 | Property PATCH/DELETE (service) | SA |
| A3 | AdminSettingsView — system panels (DB, refresh, ops) | SA nav |
| A4 | LogsView — per-property activity feed, `TaskJourney`, `ActivityTimeline`, attachments | SA nav |
| A5 | Company PATCH (service) | SA |

## Profile/Auth

| ID | Feature | Access |
|---|---|---|
| P1 | ProfileView — own profile + shift | nav |
| P2 | Login/signup/logout, refresh | public |
| P3 | `PATCH /me` self-update | authed |

## Cross-cutting

| ID | Feature | Access |
|---|---|---|
| X1 | Realtime — Centrifugo token mint + subscribe, live invalidation | backend |
| X2 | Audit events (`audit_events`) on all sensitive mutations | backend |
| X3 | EB allocation-notice push (`employee_events` → EB `/admin/notify-allocation`) | post-commit |
| X4 | Media uploads/serve (`/media`) | authed |
| X5 | Work batches (`/work-batches` create/list/detail) | backend |
| X6 | Property reconciliation (`/properties/{id}/reconciliation`) | API |
