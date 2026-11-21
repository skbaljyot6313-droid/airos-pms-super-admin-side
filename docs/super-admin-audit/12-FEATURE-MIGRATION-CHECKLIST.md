# 12 — Feature Migration Checklist

IA restructure: 5 primary destinations (Overview, Workforce, Property, Operations, Insights) + SA-only Administration. Status verified via tsc, vitest 81/81, vite build.

## Property workspace

| ID | Feature | Old location | New destination | Route | Component | Status |
|---|---|---|---|---|---|---|
| Z1-Z7 | Zones/areas workspace | `…/zones` | Property → Spaces | `…/property/spaces/zones` | ZonesView | Complete |
| R1-R10 | Rooms/dorms/washrooms | `…/rooms` | Property → Units | `…/property/spaces/units` | RoomsDormsView (`?tab=rooms|dorms|washrooms|zones`) | Complete |
| R5-R10 | Occupancy/bed ops, resource transitions | inside rooms | Property → Units (unchanged UI) | `…/property/spaces/units` | room/dorm/bed actions | Complete |
| V1-V4 | VA cameras+VMS | `…/va/:tab` | Property → Video | `…/property/video/:tab` | VaView | Complete |

## Workforce

| ID | Feature | Old location | New destination | Route | Status |
|---|---|---|---|---|---|
| E1 | Employee dashboard | `…/employees` | Workforce → Dashboard | `…/workforce/dashboard` | Complete |
| E2-E11 | Staff views (board/dir/deact/live/leaves/shifts/attendance/analytics) | `…/employees/staff` | Workforce → Employees | `…/workforce/employees?tab=…` | Complete |
| E12-E14 | Depts + transfer | `…/employees/departments*` | Workforce → Departments | `…/workforce/departments[/:uid]` | Complete |
| E15 | Employee detail | `…/employees/:uid` | Workforce → Employees | `…/workforce/employees/:uid` | Complete |
| E16-E17 | Dept routing/provisioning | backend | unchanged | — | Complete |

## Operations

| ID | Feature | Old location | New destination | Route | Status |
|---|---|---|---|---|---|
| T1-T8 | Tasks all tabs | `…/tasks` | Operations → Tasks | `…/operations/tasks?tab=…` | Complete |
| T4 | Maintenance | `…/tasks?tab=maintenance` + `…/maintenance` | Operations → Maintenance | `…/operations/tasks?tab=maintenance` | Complete |
| T5 | Templates | `…/tasks?tab=templates` + `…/templates` | Operations → Templates | `…/operations/tasks?tab=templates` | Complete |
| T9 | Day analyses | `…/tasks|maintenance/history/:date` | Operations → History | `…/operations/history/{tasks|maintenance}/:date` | Complete |
| T2 | Abandoned | `…/tasks?tab` | Operations → Abandoned | `?tab=abandoned` | Complete |
| — | Midnight rollover, generation, review logic | backend | unchanged | — | Complete |

## Insights / Admin / Profile

| Feature | Old | New | Route | Status |
|---|---|---|---|---|
| Insights hub | — | Insights → Overview | `…/insights` | Complete (new) |
| Activity & audit | `/admin/logs` | Insights → Activity & Audit (SA) | `…/insights/audit` | Complete |
| Workforce/Task/Maint analytics | scattered tabs | linked from Insights hub | deep links | Complete |
| Overview dashboard | — | Overview | `…/overview` | Complete (new) |
| Properties/Settings/Logs admin | `/admin/*` nav | Profile menu → Administration (SA) | `/admin/*` unchanged | Complete |
| Profile | `…/profile` | Profile menu | `…/profile` unchanged | Complete |

## Overview (new page)

| Feature | Source |
|---|---|
| Workforce/units/tasks/maintenance/review metrics | context collections + `tasks/review-queue` |
| Department composition | `GET /departments/overview` |
| Occupancy/cleaning/maintenance unit status | context room/dorm/washroom status |

## Legacy redirects (all preserve query params + route params)

`/zones`→`property/spaces/zones` · `/rooms`→`property/spaces/units` · `/employees`→`workforce/dashboard` · `/employees/staff`→`workforce/employees` · `/employees/departments[/:uid]`→`workforce/departments[/:uid]` · `/employees/:uid`→`workforce/employees/:uid` · `/tasks`→`operations/tasks` · `/tasks/history/:date`→`operations/history/tasks/:date` · `/maintenance`→`operations/tasks?tab=maintenance` · `/maintenance/history/:date`→`operations/history/maintenance/:date` · `/templates`→`operations/tasks?tab=templates` · `/va[/:tab]`→`property/video[/:tab]` · `/property/:uid`→`overview`.

## API-only / hidden — disposition

| Capability | Disposition |
|---|---|
| Reconciliation, work-batches, fresh-day, audit writes, EB notify, scheduler | remain backend-only — intentionally not surfaced as UI controls |
| `department_manager`, `human_resource` roles | still no surface — unchanged |
| `GET /media` attachments | used by evidence, not standalone page |

## URL-addressable tabs added

`?tab=` now synced (read+write) in: TasksView (7 tabs), EmployeesView (8 tabs), RoomsDormsView (4 tabs). VaView already route-based.
