# 06 — Analytics and Visualisations

Status legend
- **READY** — existing data and an existing API or query are sufficient.
- **PARTIAL** — data exists but needs calculation, a new aggregate, or cleanup first.
- **BLOCKED** — the required data is missing or unpopulated.
- **NEW MODULE** — requires new data structures or workflows.

Data facts referenced below come from `03-DATABASE_SCHEMA_AND_DATA_AUDIT.md`. "Sufficient history" means enough distinct periods to show a trend (rule of thumb used here: ≥ 14 operational days with non-trivial volume).

Charting: no chart library is installed. Any chart requires either a new dependency (decision needed) or hand-built SVG/CSS consistent with the existing approach.

---

## Overview

| # | Visualisation | Business question | Source tables | Columns | API today | Calculation | Period | History sufficient? | Backend work | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| O1 | Workforce composition | How is headcount split across departments and status? | `employees`, `departments` | `department_id`, `deactivated_at`, `status` | `GET /departments/overview` | count by dept, active vs inactive | Snapshot | Snapshot only | none | **READY** (but only 1 employee assigned to a department today → most bars are 0) |
| O2 | Department distribution | Which departments carry the load? | `employees`, `departments` | as above | `/departments/overview` | stacked bar | Snapshot | — | none | **READY** (data-poor) |
| O3 | Daily attendance | How many staff were present today/this week? | `attendance_days` | `attendance_date`, `status`, `started_at` | `GET /attendance/status-board` (today only) | count by status for a date | Day | **9 distinct dates**, 11 rows | range endpoint | **BLOCKED** (adoption) |
| O4 | Task completion trend | Is throughput rising or falling? | `tasks` | `completed_at`, `status`, `operational_date` | `GET /tasks/history`, `/tasks/calendar` | daily count of completed by IST date of `completed_at` (not `operational_date`: null for 236 of 284 completed) | 14–60 days | Yes (Sep 26 → Nov 19), uneven | aggregate endpoint | **PARTIAL** |
| O5 | Occupancy trend | How full are rooms and beds over time? | `occupancies`, `resource_state_events` | `checked_in_at`, `checked_out_at`, `new_state` | none | daily occupied-count from open/close intervals | 14–60 days | 39 records; 2 open | new aggregate | **PARTIAL** (sparse) |
| O6 | Maintenance status | What is open and where? | `maintenance_tickets` | `status`, `priority`, `zone_id` | `GET /maintenance` | group by status | Snapshot | 10 tickets, none since 2026-10-26 | none | **READY** (volume too low to trend) |
| O7 | Operational activity timeline | What happened recently? | `audit_events`, `task_history_events` | `created_at`, `action`, `entity_type` | `GET /logs` (SA) | merged, sorted | Last N | Yes | normalise entity names | **PARTIAL** |
| O8 | Property health summary | Is the property operating normally? | multiple | resource states, open tasks, overdue, camera status, staffing gaps | none (reconciliation API exists) | composite score — **avoid a single score**; show components | Snapshot | — | new aggregate + drift fix | **PARTIAL** (drift in resource state, see `03` §4.7) |

Additional Overview candidates:
- **Overdue and abandoned spikes** — `tasks.abandoned_at`, `abandoned_reason`: **READY** (1,519 abandons; reasons available). Show as exception trend, not as failure rate, because 84% abandonment reflects expiry semantics (confirm with business).
- **Review turnaround** — `task_completion_submissions.submitted_at/reviewed_at`: **READY** (median 47.8 min, 124 reviewed rows).
- **Staffing gaps** — employees on floor vs. zones needing coverage: **PARTIAL** (coverage model exists; shift data absent).

## Workforce

| # | Visualisation | Question | Sources | API today | Status | Notes |
|---|---|---|---|---|---|---|
| W1 | Employees by department | Who sits where? | `employees.department_id`, `departments` | `/departments/overview` | **READY** | Only 1 of 39 assigned — needs assignment campaign before it is informative |
| W2 | Active vs inactive | Workforce health | `employees.deactivated_at` | `/departments/overview`, `/employees` | **READY** | 35 / 4 |
| W3 | Attendance trends | Attendance rate over time | `attendance_days` | none | **BLOCKED** | 9 dates; future-dated rows must be excluded |
| W4 | Present vs absent | Today's presence | `attendance_days.status` | `/attendance/status-board` | **BLOCKED** | Requires shifts for `absent` logic; shifts table empty |
| W5 | Leave utilisation | How much leave is taken vs entitled? | `attendance_requests`, `leave_balances` (missing) | `/attendance/requests` | **BLOCKED** | No balances or entitlements |
| W6 | Employee allocation | Where are staff assigned? | `employees.zone_id/area_id/covers_property`, `zones` | `/employees` | **READY** | 25 of 39 unallocated — the most informative workforce fact today |
| W7 | Workforce availability | How many staff are free to take work? | allocation + attendance + leave | none | **PARTIAL** | Needs attendance and leave to be populated |
| W8 | Department staffing | Coverage per department vs need | `employees`, `departments`, `tasks.work_type` | none | **PARTIAL** | Needs demand model (tasks per work type per day) |
| W9 | Overtime trends | Hours over shift | `attendance_days.work_seconds` + shift end | none | **BLOCKED** | No shifts, no overtime rule |
| W10 | Joining and exit trends | Hiring and attrition | `employees.created_at`, `deactivated_at`, `reactivated_at` | none | **PARTIAL** | Only 39 employees; no exit reason |

## Human Resources

| # | Visualisation | Question | Status | Reason |
|---|---|---|---|---|
| H1 | Monthly payroll expenditure | What do we spend per month? | **NEW MODULE** | No payroll |
| H2 | Salary distribution | How are salaries spread? | **BLOCKED** | `salary` is unpopulated free text |
| H3 | Department salary expenditure | Which departments cost most? | **NEW MODULE** | Needs compensation |
| H4 | Payroll trends | Is cost rising? | **NEW MODULE** | Needs payroll runs |
| H5 | Leave utilisation | Leave by type and month | **BLOCKED** | Leave types free text, no balances; 11 requests |
| H6 | Leave type distribution | Which leave types are used? | **PARTIAL** | Observed casual 2, sick 1, other 1 — too few; buildable from `attendance_requests.leave_type` |
| H7 | Overtime expenditure | Overtime cost | **NEW MODULE** | No pay rules |
| H8 | Compensation changes | Revision frequency and size | **NEW MODULE** | No history table |
| H9 | Employee retention | Share of staff retained over period | **PARTIAL** | Needs `created_at` and exit dates; only 4 exits |
| H10 | Attrition trends | Exit rate by month | **PARTIAL** | Same as H9 |

## Property

| # | Visualisation | Question | Sources | API today | Status | Notes |
|---|---|---|---|---|---|---|
| P1 | Room occupancy trend | Occupancy over time | `occupancies` | none | **PARTIAL** | 39 records; 2 open |
| P2 | Bed utilisation | Beds occupied vs available | `beds.status`, `occupancies` | `/dorms` | **PARTIAL** | Status shows 67 beds "cleaning" against 2 open tasks — **state drift**; show only after reconciliation |
| P3 | Cleaning status | Cleaning backlog by unit | `rooms.status`, `dorms.status`, `tasks` (cleaning) | `/rooms`, `/dorms`, `/tasks` | **PARTIAL** | Requires drift fix; current counts are misleading |
| P4 | Resource state distribution | Current state mix | `rooms`, `beds`, `dorms`, `washrooms` | list endpoints | **READY** (shows drift) | Label as "recorded state" until reconciled |
| P5 | Maintenance frequency | Tickets per unit or per month | `maintenance_tickets` | `/maintenance` | **BLOCKED** | 10 tickets; none since Oct 26 |
| P6 | Zone-wise occupancy | Occupancy per zone | `rooms.zone_id`, `occupancies` | `/rooms` | **PARTIAL** | Few occupancies |
| P7 | Resource state transitions over time | How often do units change state | `resource_state_events` | none | **READY** | 4,194 events (Oct 1 → Nov 19); needs aggregate endpoint |
| P8 | Camera health | Online/offline cameras | `cameras.connection_status`, `last_checked_at` | `/va/properties/{id}/cameras` | **READY** | 54 cameras; check freshness of `last_checked_at` |

## Operations

| # | Visualisation | Question | Sources | API today | Status | Notes |
|---|---|---|---|---|---|---|
| T1 | Daily task completion | Throughput per day | `tasks.completed_at` | `/tasks/history` | **PARTIAL** | Use `completed_at` in IST, not `operational_date` |
| T2 | Tasks by department | Which department does the work? | `tasks.work_type` + employee → `department_id` | none | **PARTIAL** | `tasks` has no `department_id`; derive via employee (current assignee), which changes after reassign. Options: snapshot `department_id` onto task at assignment (new column). |
| T3 | Tasks by status | Current queue shape | `tasks.status` | `/tasks/today` | **READY** | Abandoned dominates — present as a stacked bar with "expired" distinct from "failed" |
| T4 | Abandoned task trend | Expiry patterns | `tasks.abandoned_at`, `abandoned_reason` | `/tasks/history` | **READY** | 912 next-occurrence, 601 daily rollover, 6 midnight |
| T5 | Review turnaround time | Reviewer responsiveness | `task_completion_submissions` | `/tasks/review-queue` | **READY** | Median 47.8 min |
| T6 | Maintenance response time | Time to resolve | `maintenance_tickets.created_at/resolved_at`, `maintenance_ticket_events` | `/maintenance` | **PARTIAL** | Median 16.6 h on 5 tickets; use events for "assigned" time (no `assigned_at` column) |
| T7 | Employee workload distribution | Tasks per employee | `tasks.employee_id`, `work_allocation_history` | `/tasks` | **READY** | Good for fairness analysis; 2 unassigned non-abandoned tasks |
| T8 | Allocation method mix | Round-robin vs reassign vs manual | `work_allocation_history.allocation_method` | none | **READY** | round_robin 1,824; reassign 65; manual 40; none 23 |
| T9 | Template generation volume | Recurring work generated | `template_generations` | none | **READY** | 631 generations |

## Insights

| # | Visualisation | Question | Status | Notes |
|---|---|---|---|---|
| I1 | Historical operational trends (multi-metric) | Are operations improving? | **PARTIAL** | Requires aggregate endpoint and ≥ 90 days (currently ~54 days) |
| I2 | Department comparison | Which departments perform? | **BLOCKED** | Needs `tasks.department_id` (see T2) and attendance |
| I3 | Workforce productivity | Output per employee per shift | **BLOCKED** | Needs shifts/attendance |
| I4 | Operational efficiency | Completion time vs target | **PARTIAL** | Targets not defined; completion time exists (median 62.5 min) |
| I5 | Maintenance trends | Ticket volume and resolution | **PARTIAL** | Volume too low |
| I6 | Property comparison | Compare properties | **PARTIAL** | Only P1 and P10 have meaningful data; others are shells — show data-coverage flags |
| I7 | Audit activity | Who changed what | **READY** | Normalise entity names first |

---

## Formulas (to be used consistently)

- **Completion rate (daily)**: completed in IST day ÷ tasks scheduled for that IST day, excluding abandoned-by-expiry. Requires confirming "scheduled" (`scheduled_for`, `operational_date`).
- **Abandon share**: abandoned ÷ (all tasks with `scheduled_for` in window). Always show reason split beside it.
- **Review turnaround**: `reviewed_at − submitted_at` (median and p90), excluding `pending`.
- **Maintenance resolve time**: `resolved_at − created_at` (median); alternate: `closed_at − created_at`.
- **Occupancy rate**: occupied unit-nights ÷ available unit-nights per day; derived from `occupancies` intervals, not current state.
- **Active rate**: active employees ÷ total employees (exclude inactive from denominators).
- **Coverage**: employees with any of zone/area/covers_property ÷ active employees.

## Data prerequisites (ordered)

1. Reconcile resource state (`cleaning` without open task) — blocks P2, P3, O1 tiles on units.
2. Clear 125 stale pending submission rows — blocks any review-pending metric that reads submissions.
3. Normalise `audit_events.entity_type` — blocks O7 and I7 filters.
4. Snapshot `department_id` onto tasks at assignment — blocks T2, I2.
5. Populate or confirm shifts and attendance — blocks W3, W4, W9, I3.
6. Leave types and balances — blocks H5, W5.
7. Compensation — blocks all H-series money charts.
8. Add composite indexes (see `07`) before adding aggregate charts over `tasks`.
