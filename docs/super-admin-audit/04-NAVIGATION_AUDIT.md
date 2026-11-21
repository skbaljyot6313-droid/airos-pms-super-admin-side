# 04 — Navigation Audit

## Actual hierarchy (extracted from `Header.tsx` + in-page sub-navs)

```
AiROS Super Admin
├── Public
│   ├── / (LandingPage)
│   ├── /login
│   └── /signup
│
├── Admin mode (super_admin, no active property)
│   ├── Properties          /admin/properties          [nav]
│   ├── Settings            /admin/settings            [nav]
│   └── Logs                /admin/logs                [nav, SA-only]
│
└── Property mode (/property/:uid — SA or PM)
    ├── Zones               …/zones                    [nav]
    │   └── ZoneWorkspace (drill-in, create area/zone)
    ├── Employee Management …/employees                [nav] → EmployeeDashboard
    │   ├── Dashboard       …/employees                [sub-nav]
    │   ├── Employees       …/employees/staff          [sub-nav]
    │   │   ├── Zone Board (tab)
    │   │   ├── Directory (tab) — create/edit/deactivate/delete
    │   │   ├── Deactivated (tab)
    │   │   ├── Live Location (tab)
    │   │   ├── Leaves (tab)
    │   │   ├── Shifts (tab)
    │   │   ├── Attendance (tab)
    │   │   └── Analytics (tab)
    │   ├── Departments     …/employees/departments    [sub-nav]
    │   │   └── …/departments/:uid (detail: roster, head, transfers)
    │   └── …/employees/:employeeUid (detail: overview/allocations/
    │         maintenance/records/attendance/device)   [link-only]
    ├── Rooms               …/rooms                    [nav]
    │   ├── rooms tab (CRUD, bulk, allocation, check-in/out)
    │   ├── dorms tab (CRUD, bulk, allocation, checkout, beds)
    │   └── washrooms tab (CRUD, fixtures, maintenance)
    ├── Tasks               …/tasks                    [nav]
    │   ├── Today / Abandoned / Review / Maintenance /
    │   │   Templates / History / Calendar (tabs, ?tab= deep-link)
    │   └── …/tasks/history/:date (day drill-in)       [link-only]
    ├── VA                  …/va                       [nav] → va/vms
    │   ├── vms (live grid)                            [tab]
    │   └── camera-settings                            [tab]
    └── Profile             …/profile                  [nav]
```

## Redirects / legacy

- `/property/:uid` → `…/zones`; `/property/:uid/va` → `va/vms`.
- `…/maintenance` → `…/tasks?tab=maintenance`; `…/templates` → `…/tasks?tab=templates` (shims).
- `*` → role home.

## Entry-point visibility conditions

- Admin nav shows only when no `activePropertyUid` + SA.
- Property nav shows inside property for SA/PM.
- `Logs` item appended only for SA.
- `Employees`/`Tasks`/`Rooms`/`VA` hidden from employee-role users (they're redirected).
- Sub-navs (`EmployeeManagementNav`, Va tab bar, EmployeesView tab strip, TasksView tab strip) are in-page, not the header.

## Observations

- Two nav layers: flat Header (7 items) + per-page tab strips (up to 8 tabs) — no breadcrumb beyond `BackButton`.
- Deep features reachable only via in-page tabs/row actions, not URL (e.g. Shifts, Leaves, Live Location).
- Maintenance & Templates live *inside* Tasks as tabs — no top-level entry despite separate backend domains.
- "VA" nav label is cryptic vs "Video Analytics/CCTV".
