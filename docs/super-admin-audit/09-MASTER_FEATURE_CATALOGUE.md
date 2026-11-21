# 09 — Master Feature Catalogue

Consolidated registry. Cat: A=Core Mgmt, B=Workforce, C=Ops/Tasks, D=Analytics, E=Admin/Access, F=SysConfig, G=Comms, H=Infra/Integrations, I=Utils, J=Unclassified.

| ID | Feature | Cat | Route | Component | API | Perm | Status |
|---|---|---|---|---|---|---|---|
| Z1-Z7 | Zones/areas workspace | A | /zones | ZonesView, ZoneWorkspace | areas,zones,fresh-day | Staff | Impl |
| R1-R10 | Rooms/dorms/washrooms + occupancy | A | /rooms | RoomsDormsView + modals | structure,occupancy | Staff | Impl |
| E1 | Employee dashboard | B,D | /employees | EmployeeDashboard | departments/overview | Staff | Impl |
| E2 | Staff zone board | B | /employees/staff | ZoneBoard | employees/allocation | Staff | Impl |
| E3-E6 | Directory/create/edit/deactivate | B | /employees/staff | EmployeeDirectory, CreateEmployeeModal | employees | Staff | Impl |
| E7 | Live location | B,H | /employees/staff | LiveLocationMap | live-locations | PM | Impl |
| E8 | Leaves | B | /employees/staff | LeavesPanel | attendance/requests | PM | Impl |
| E9 | Shifts | B | /employees/staff | ShiftManager | shifts | PM | Impl |
| E10 | Attendance board | B | /employees/staff | AttendanceBoard | status-board | PM | Impl |
| E11 | Team analytics | D | /employees/staff | TeamAnalytics | team-analytics | Staff | Impl |
| E12-E14 | Depts list/detail/transfer | B,E | /employees/departments* | DepartmentsView + modals | departments | Staff | Impl |
| E15 | Employee detail | B,D | /employees/:uid | EmployeeDetailView | employees/{id}/* | Staff | Impl |
| E16 | Dept routing (work alloc) | C | — | work_allocation.py | — | backend | Impl |
| T1-T3 | Tasks today/abandoned/review | C | /tasks?tab= | TasksView, TaskReviewPanel | tasks,review-queue | Staff | Impl |
| T4 | Maintenance | C | /tasks?tab=maintenance | MaintenanceView | maintenance | Staff | Impl |
| T5 | Templates | C | /tasks?tab=templates | TemplatesView, TemplateWizard | templates | Staff | Impl |
| T6-T7 | History/calendar | D | /tasks?tab= | TaskHistoryView, TaskCalendarView | tasks/history,calendar | Staff | Impl |
| T8 | Task detail | C | — | TaskDetailDrawer | tasks/{id}/* | Staff | Impl |
| T9 | Day analyses | D | /tasks|maintenance/history/:date | *DayAnalysisView | tasks/history/{day} | SA+PM | Impl |
| V1-V4 | VA VMS+cameras | H | /va/:tab | VaView, VaVms, VaCameraSettings | va | SA+PM | Impl |
| A1-A2 | Properties mgmt | E | /admin/properties | PropertiesView | properties,companies | SA | Impl |
| A3 | Settings | F | /admin/settings | AdminSettingsView | — | SA | Impl |
| A4 | Logs/journey | D,E | /admin/logs | LogsView, TaskJourney | logs | SA | Impl |
| P1-P3 | Profile/auth | I | /profile,/login | ProfileView, Login | auth | authed | Impl |
| X1 | Realtime | H | — | realtime client | realtime | authed | Impl |
| X2 | Audit | E | — | audit_events svc | — | backend | Impl |
| X3 | EB notify | H | — | employee_events | — | backend | Impl |
| X4 | Media up/serve | H | — | media.ts | media | authed | Impl |
| X5 | Work batches | C | — | work_allocation | work-batches | Staff | API-only |
| X6 | Reconciliation | E,I | — | reconciliation svc | properties/{id}/reconciliation | Staff | API-only |
| — | Dept transfers history | B | dept detail | DepartmentDetailView | departments/transfers | Staff | Impl |
| — | Dept auto-provision (8 system) | B | — | DepartmentService | — | backend | Impl |
| — | Resource state engine | C | — | ResourceStateService | resources/* | Staff | Impl (API) |
| — | Task generation scheduler | C | — | TemplateService, run_due | generate-due | backend | Impl |
| — | Rollover/midnight sweep | C | — | RolloverService | generation-tick | backend | Impl |
| — | Evidence images | C | tasks | EvidencePhoto, Lightbox | media/file | Staff | Impl |

Feature blocks: ~48 granular features across 9 modules.
