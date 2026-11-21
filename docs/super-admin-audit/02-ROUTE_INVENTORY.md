# 02 — Route Inventory

All routes from `src/App.tsx`. Legend — Roles: SA=super_admin, PM=property_manager; Nav = linked in Header.

## Public

| Route | Component | Purpose | Nav |
|---|---|---|---|
| `/` | `LandingPage` | Marketing/entry landing | — |
| `/login` | `Login` | Email+password login | — |
| `/signup` | `Signup` | Account creation | — |

## Admin scope (SA only, `RequireRole['super_admin']`)

| Route | Component | Purpose | Nav |
|---|---|---|---|
| `/admin/properties` | `PropertiesView` | Company property list, create, open workspace | ✓ "Properties" |
| `/admin/settings` | `AdminSettingsView` | System settings/admin panels | ✓ "Settings" |
| `/admin/logs` | `LogsView` | Per-property activity-log browser (task journeys, attachments) | ✓ "Logs" (SA) |

## Property scope (`/property/:propertyUid/*`, RequireAuth + scope check)

| Route | View | Component | Tabs / children | Nav |
|---|---|---|---|---|
| `/property/:uid` | — | → `zones` | — | — |
| `…/zones` | zones | `ZonesView` | `ZoneWorkspace` drill-in; create area/zone modals | ✓ Zones |
| `…/rooms` | rooms | `RoomsDormsView` | tabs: rooms / dorms / washrooms (+`UnitZoneBoard`) | ✓ Rooms |
| `…/employees` | employees_dashboard | `EmployeeDashboard` | org metrics, dept cards (EmployeeManagementNav: Dashboard\|Employees\|Departments) | ✓ Employee Mgmt |
| `…/employees/staff` | employees | `EmployeesView` | tabs: board / directory / deactivated / live / leaves / shifts / attendance / analytics | sub-nav |
| `…/employees/departments` | departments | `DepartmentsView` | search/sort/filter, create/edit/delete modals, transfer modal | sub-nav |
| `…/employees/departments/:departmentUid` | department_detail | `DepartmentDetailView` | info cards, roster, head, transfer history | — |
| `…/employees/:employeeUid` | employee_detail | `EmployeeDetailView` | tabs: overview / allocations / maintenance / records / attendance / device (+locations) | — |
| `…/tasks` | tasks | `TasksView` | tabs: today / abandoned / review / maintenance / templates / history / calendar (`?tab=` deep-link) | ✓ Tasks |
| `…/tasks/history/:date` | task_day | `TaskDayAnalysisView` | per-day task analysis | — (SA+PM) |
| `…/maintenance` | — | `MaintenanceRedirect` → `/tasks?tab=maintenance` | legacy deep link | — |
| `…/maintenance/history/:date` | maint_day | `MaintenanceDayAnalysisView` | per-day maintenance analysis | — (SA+PM) |
| `…/templates` | — | `TemplatesRedirect` → `/tasks?tab=templates` | legacy deep link | — |
| `…/profile` | — | `ProfileView` | own profile, shift card, credentials | ✓ Profile |
| `…/va` | — | → `va/vms` | — | ✓ VA |
| `…/va/:tab` | — | `VaView` | tabs: `vms` (multi-camera grid, tiles, fullscreen, quality) / `camera-settings` (CRUD, zones, transcode, warm) | sub-route (SA+PM) |
| `*` | — | `RootRedirect` | role-based home redirect | — |

## Hidden / unlinked routes

- `/admin/logs` — nav-visible only to SA.
- `employees/:employeeUid` — reached via directory/dept roster links.
- `tasks/history/:date`, `maintenance/history/:date` — reached via calendar/history drill-in.
- `va/:tab` — `camera-settings` tab deep-link only.
- `employees/departments/*` — new; reached via sub-nav or dashboard cards.
- Deprecated `/maintenance`, `/templates` — redirect shims kept for old links.

## Notes

- No nested route layouts — `PropertyScopedView` maps `view` prop → component; all property routes are flat siblings.
- Route ordering relies on React Router specificity: `/employees/staff` & `/employees/departments` (static) correctly beat `/employees/:employeeUid` (dynamic).
