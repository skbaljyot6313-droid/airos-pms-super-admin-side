# 06 — Duplication & Overlap

Fragmented/related capabilities — consolidation candidates only, **no deletions proposed**.

## High-confidence overlaps

| A | B | Where | Verdict |
|---|---|---|---|
| Maintenance tab (Tasks) | `/maintenance` route | TasksView tab vs legacy route→redirect | Same feature; route now a shim — consolidate under Tasks |
| Templates tab (Tasks) | `/templates` route | same pattern | Same feature; shim — consolidate |
| Task History tab | `tasks/history/:date` day view | tab drills into route | Complementary (list↔detail) — keep |
| Maintenance tab | `maintenance/history/:date` day view | tab + day route | Complementary — keep |
| Employee dept text field | `departments` table + `department_id` FK | legacy `Employee.department` vs real FK | Dual-write kept for compat — canonical is `department_id`; text field is transitional |
| Custom vs system dept names | free-text dept picklist fallback | static list vs live `/departments` | Static list is fallback-only; canonical = system dept rows |
| Employees Directory | Staff board | two tabs both showing staff | Complementary (grid manage vs map/zone assign) — keep, different axes |
| Employee analytics | Employee detail tabs vs Team analytics | per-employee vs team | Complementary scopes |
| Task evidence review | Task detail + review queue | lightbox in both | Same capability, two entry points — fine |
| Zones (nav page) | zone filter inside staff board | zone CRUD vs zone allocation | Complementary — structure vs assignment |

## Cross-module scattering worth grouping

- **Employee-centric surfaces are split across**: Employees tab strip (board/directory/deactivated/live/leaves/shifts/attendance/analytics), dept mgmt sub-nav (dashboard/departments), per-employee detail tabs. ~15 sub-views under one nav item → strong candidate for an Employee Mgmt module hub.
- **Operations work is split**: Tasks (today/review/calendar/templates) vs Maintenance (own tab + day view) vs Zones (fresh-day, state) vs Rooms (occupancy/checkout spawning cleaning). Task generation, review, and resource-state are one operational lifecycle spread across 4 nav items.
- **Admin/system surfaces**: `/admin/settings` + `/admin/logs` + property reconciliation + media health — scattered system-introspection tools could group under a System/Ops module.
- **Reports**: TaskDayAnalysis, MaintenanceDayAnalysis, TeamAnalytics, EmployeeDetail analytics, Logs — five distinct "history/insight" surfaces in different places → candidate Analytics/Reports group.

## Genuinely distinct (not duplicates)

- Departments (org structure) vs Zones (physical space) vs Areas — three different domain axes; do not merge.
- Occupancy (who's in a bed) vs Task cleaning (post-checkout work) vs Resource state (derived status) — one lifecycle, distinct concerns.
