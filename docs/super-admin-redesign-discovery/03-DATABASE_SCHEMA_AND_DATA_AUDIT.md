# 03 — Database Schema and Data Audit

Evidence: SQLAlchemy metadata introspected in-process from `backend/app/models` (`Base.metadata`, read-only), plus aggregate queries against the **dev database** run in `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`. No writes were executed. No personal data (names, emails, phones, credentials, salary values, identity documents) was selected or reported. Properties are labelled **P1–P10** (creation order).

Alembic head in the database: `e6a3c9f1b8d4` (matches the Super Admin script head).

## 1. Inventory

| Measure | Value |
|---|---|
| Public tables in the database | 47 (incl. `alembic_version`) |
| Tables in Super Admin SQLAlchemy metadata | 40 (534 columns) |
| Tables in DB but not in Super Admin models | 6: `area_allocation_state`, `device_registrations`, `employee_preferences`, `location_events`, `location_tracking_sessions`, `mobile_releases` — written by the Employee Backend (per `employee/AGENTS.md`) except `area_allocation_state` (owner unverified) |
| CHECK constraints | 1 (`occupancies.ck_occupancies_one_target`). **All status columns are unconstrained `VARCHAR`.** |
| Unique constraints (business) | `users.email`, `users.username`, `departments(property_id,name)`, `rooms(property_id,room_number)`, `zones(property_id,name)`, `areas(property_id,name)`, `beds(dorm_id,bed_number)`, `washrooms(dorm_id)`, `washrooms(property_id,name)`, `employee_area_assignments(employee_id,area_id)`, `zone_allocation_state(zone_id)`, `task_completion_submissions(task_id,attempt_number)`, `tasks.ticket_number`, `maintenance_tickets.ticket_number` |
| Partial unique indexes | `tasks(property_id,room_id,title)` where open; `tasks(series_id,due_date)` where recurring |
| **Missing uniqueness** | `properties.code` — **not unique** (all 10 properties carry `PROP-001`). |
| JSON columns | `tasks.bed_ids`, `tasks.automation_rule`, `audit_events.detail` |
| Soft delete | `cameras.deleted_at` only. Employees use `deactivated_at` (no delete flag). Other entities hard-delete. |
| Audit fields | `created_at`/`updated_at` on most tables; `audit_events` append-only. |

## 2. Table catalogue (Super Admin metadata)

Row counts are from the dev database. "Historical" = contains time-series rows usable for trends.

| Table | Rows | Business function | Module | Key relations | Historical | Analytics-ready |
|---|---|---|---|---|---|---|
| `companies` | 12 | Tenant | Admin | → properties, users | No | Low |
| `properties` | 10 | Property (8 empty shells) | Admin | → areas, zones, rooms… | No | Low |
| `users` | 555 | Login accounts (SA 513, EMPLOYEE 30, PM 11, HR 1) | Auth | → company, employee | `last_login_at` | Low — see §5 |
| `refresh_tokens` | 23,817 | Session refresh tokens (161 expired) | Auth | → users | Grows unbounded | No (housekeeping) |
| `areas` | 12 | Floor levels | Spaces | → property | No | Low |
| `zones` | 27 | Zones (all `stay`) | Spaces | → area | No | Low |
| `rooms` | 88 | Rooms; state, current guest | Units | → zone, area | Via `resource_state_events` | Medium |
| `dorms` | 20 | Dormitories | Units | → zone, area | Via events | Medium |
| `beds` | 109 | Dorm beds | Units | → dorm | Via events | Medium |
| `washrooms` | 16 | Washrooms | Units | → dorm/zone | Via events | Low |
| `washroom_fixtures` | 63 | Fixtures and status | Units | → washroom | No | Low |
| `occupancies` | 39 | Check-in/out records (open 2) | Occupancy | → room/bed | **Yes** (2026-10-01 → 11-19) | Medium |
| `resource_state_events` | 4,194 | Resource state ledger | Resources | → property | **Yes** (Oct 1 → Nov 19) | High |
| `employees` | 39 | Staff (35 active, 4 inactive) | Workforce | → property, zone, area, department | `created_at` only | Medium |
| `employee_area_assignments` | 0 | Extra area coverage | Workforce | → employee, area | No | — |
| `employee_shift_assignments` | 0 | Shift assignment history | Scheduling | → employee, shift | Designed for history | — (empty) |
| `shifts` | 0 | Shift definitions | Scheduling | → property | No | — (empty) |
| `departments` | 16 | Departments (all system; 8 for P1, 8 for P10) | Workforce | → property, head employee | No | Low |
| `department_transfers` | 2 | Transfer history (append-only) | Workforce | → employee, departments | **Yes** (2 rows) | Low |
| `attendance_days` | 11 | Daily attendance (EB-written) | Attendance | → property, employee | 9 distinct dates | Low |
| `attendance_breaks` | 1 | Breaks | Attendance | → attendance_day | — | — |
| `attendance_requests` | 11 | Leave/week-off requests | Leave | → employee, reviewer | Yes (sparse) | Low |
| `tasks` | 1,805 | Work items | Operations | → property, zone, employee, room, dorm, washroom, template, batch | **Yes** (2026-09-26 → 11-19) | High, with caveats (§4) |
| `task_history_events` | 4,255 | Task lifecycle events | Operations | → task | **Yes** | High |
| `task_completion_submissions` | 249 | Completion attempts | Review | → task, employee, reviewer | Yes | Medium (stale rows) |
| `task_completion_images` | 768 | Evidence images | Review | → submission/task | — | Low |
| `work_templates` | 3 | Recurring templates | Templates | → property | No | Low |
| `work_template_versions` | 5 | Template versions | Templates | → template | — | — |
| `template_generations` | 631 | Idempotent generation ledger | Templates | → template | **Yes** | Medium |
| `work_allocation_batches` | 1,549 | Allocation batches | Allocation | → property, employee, zone | **Yes** | Medium |
| `work_allocation_history` | 1,966 | Allocation ledger (round_robin, reassign, manual, none) | Allocation | → property | **Yes** (Sep 26 → Nov 19) | High |
| `zone_allocation_state` | 6 | Round-robin pointer per zone | Allocation | → zone | No | — |
| `allocation_events` | 252 | Zone/area move events | Allocation | → property | Yes | Medium |
| `maintenance_tickets` | 10 | Maintenance tickets (3 open, 2 assigned, 5 closed) | Maintenance | → property, resource, employee | Last created 2026-10-26 | Low (volume) |
| `maintenance_ticket_events` | 33 | Ticket lifecycle | Maintenance | → ticket | Yes | Medium |
| `maintenance_ticket_attachments` | 7 | Ticket attachments | Maintenance | → ticket | — | Low |
| `cameras` | 54 (52 live, 1 warm, 51 transcode) | Camera config | Video | → property, zone, area | `last_checked_at` | Medium |
| `camera_stream_sessions` | 201 | Viewer sessions | Video | → camera, user | Yes | Medium |
| `audit_events` | 909 | Audit trail | Audit | → property | **Yes** (Oct 1 → Nov 19) | High (inconsistent entity names) |
| `notifications` | 1,008 | Employee feed notifications | Notifications | → property, employee | Yes | Medium |
| `alembic_version` | 1 | Shared migration head | Infra | — | — | — |

Employee-Backend-owned tables in the same database (not in SA models): `location_tracking_sessions` 1,178 rows (2026-10-26 → 11-05), `location_events` 2, `device_registrations` 10, `employee_preferences` 0, `mobile_releases` 1, `area_allocation_state` 0.

## 3. Relationships and integrity

- **FK coverage** is broad. Employee ↔ department via `employees.department_id` (SET NULL); `departments.head_employee_id` (SET NULL); `department_transfers` snapshot names (immutable history).
- **Denormalisation**: names are copied into rows (`employee_name`, `room_number`, `dorm_name`, `washroom_name`, `assigned_to_name`, `reviewed_by_name`, `entity_name`). Good for history, but reporting by current name will be wrong after renames.
- **Legacy duplication**: `employees.department` (free text), `employees.shift` (free text, unpopulated), `employees.salary` (free text), `employees.leave_balance_days` (unpopulated), `employees.leave_status` (boolean) coexist with proper tables.
- **Date typing**: business dates are `VARCHAR`, not `DATE`: `employees.start_date` (32), `attendance_days.attendance_date` (10), `attendance_requests.from_date/to_date` (10), `employee_shift_assignments.effective_from/until` (10), `tasks.due_date` (64), `tasks.operational_date` (10), `tasks.recurrence_*` (64/16), `tasks.start_time` (16). ISO-8601 strings sort correctly but cannot be range-indexed efficiently or validated by the database.
- **Status fields**: `VARCHAR` with no CHECK constraint on `tasks.status`, `maintenance_tickets.status`, `rooms.status`, `beds.status`, `dorms.status`, `attendance_days.status`, `attendance_requests.status`. Invalid values are possible at the DB level.
- **Inconsistent entity naming in `audit_events.entity_type`**: observed `employee` (99) and `employees` (16); `user` (1) and `users` (14); `rooms`, `beds`, `dorms`, `zones`, `areas`, `properties`, `tasks`, `maintenance_tickets`, `attendance_day`, `attendance_request`, `department`, `notification`, `camera`, `session`. Filtering by entity type will split history.
- **Orphans**: 0 employees pointing to missing properties; 0 tasks pointing to missing properties.

## 4. Data completeness and quality

### 4.1 Workforce (`employees`, 39 rows)

| Field | Null/empty | Notes |
|---|---|---|
| `department_id` | 38 of 39 | Only 1 employee assigned to a department |
| `department` (text) | 0 empty | Legacy field still populated for all |
| `salary` | **39 of 39 null** | Free text; never populated |
| `shift` (text) | **39 of 39 null** | Legacy; never populated |
| `leave_balance_days` | **39 of 39 null** | No leave-balance data exists |
| `phone` | 12 of 39 null | |
| `start_date` | 17 of 39 null | Free text (`VARCHAR(32)`) |
| `username` | 0 null | |
| Zone/area coverage | 25 of 39 unallocated (no zone, area, or property-wide) | |

Status: 35 active, 4 inactive. Created 2026-09-26 → 2026-11-18.

Per property: P1 16 (14 active), P9 5, P4/P5/P6 2 each, P7/P8 3 each, P2 4, P3 1, P10 1.

### 4.2 Departments (16 rows across 2 properties)

- Eight system departments for each of P1 and P10. **No duplicates within a property** (`UNIQUE(property_id,name)` holds; the apparent duplicates in an earlier aggregate came from grouping by the non-unique property code).
- Only **1 employee** is assigned to a department across the whole database (in one system department on P10), and that department has 1 head.
- Custom departments: 0.
- Provisioning is lazy: 8 of 10 properties have no department rows because nothing has requested their department list yet.

### 4.3 Attendance and leave

- `attendance_days`: 11 rows across 9 dates (2026-10-06 → 2027-04-06). Status: leave 5, week_off 3, present 3. **5 rows are dated in the future** relative to the IST date (data quality issue — possibly pre-entered leave; needs verification).
- `attendance_breaks`: 1 row.
- `attendance_requests`: 11 rows — leave 4 (approved 2, pending 1, rejected 1); week_off 7 (approved 2, pending 2, cancelled 2, rejected 1).
- `leave_type` (leave only): `casual_leave` 2, `sick_leave` 1, `other` 1, null 7 (week_off has no type). The model enum also defines `paid_leave` and `unpaid_leave`, unused so far.
- `shifts`: 0. `employee_shift_assignments`: 0.
- Conclusion: **attendance and scheduling are not yet exercised in the data**. Any attendance trend chart would be built on 9 dates.

### 4.4 Tasks (1,805 rows)

| Dimension | Values (count) |
|---|---|
| Status | abandoned 1,519 (84.2%), completed 284 (15.7%), assigned 2 |
| Task type / origin | fixed·manual 806, fixed·template 638, repetitive·manual 341, fixed·checkout 17, fixed·guest_request 3 |
| Work type | cleaning 1,456, inspection 308, housekeeping 35, null 6 |
| Abandon reason | NEXT_SCHEDULED_OCCURRENCE 912, SYSTEM_DAILY_ROLLOVER 601, MIDNIGHT_EXPIRY 6 |
| By month | Sep 6 abandoned / 35 completed; Oct 928 / 163; Nov 585 / 86 (+2 assigned) |

- **Completed rows with null `operational_date`: 236 of 284 (83%).** Any daily completion trend must use `completed_at` (IST-converted), not `operational_date`.
- Null employee on non-abandoned rows: 2.
- Completed with null `completed_at`: 0 (good).
- Timing (medians): submitted → completed **62.5 min**; submission → review **47.8 min**; maintenance created → resolved **16.6 h**.
- Interpretation: the 84% abandonment rate is **a property of how recurring work expires** (next-occurrence and daily rollover). It is not necessarily a failure, but dashboards must not present "abandoned" as a failure rate without this context. This needs business confirmation.

### 4.5 Task reviews (`task_completion_submissions`, 249 rows)

- Status: approved 115, disapproved 9, **pending 125**.
- Pending rows belong to **abandoned tasks (120)** and **completed tasks (5)**. None belongs to a `submitted` task.
- The review queue (`TaskService.review_queue`) filters `tasks.status = 'submitted'` → currently **0 items**, which is correct for live work but means the 125 pending submission rows are stale and must be cleaned or excluded from any "pending review" metric that reads submission status.

### 4.6 Maintenance

- 10 tickets: closed 5, open 3, assigned 2. Created between 2026-09-26 and **2026-10-26** — **no tickets in the last ~3.5 weeks**.
- Priority/type spread is wide (10 different types across 10 tickets); too few to trend.

### 4.7 Resources (rooms, beds, dorms, washrooms)

| Resource | Total | State distribution |
|---|---|---|
| Rooms | 88 | available 68, cleaning 16, maintenance 3, occupied 1 |
| Beds | 109 | cleaning 67, available 40, occupied 1, maintenance 1 |
| Dorms | 20 | cleaning 15, available 5 |
| Washrooms | 16 | available 16 |
| Washroom fixtures | 63 | operational 63 |

**State drift (verified, read-only):**
- Rooms in `cleaning`: **16**, of which **1** has an open cleaning-type task → **15 without an open task**.
- Dorms in `cleaning`: **15**, of which **0** have an open task.
- Beds in `cleaning` whose dorm is also `cleaning`: 60.
- Open tasks in the whole property: **2**.

The resource state engine's derivation rule (open cleaning task → `cleaning`) does not match the data. Possible causes: abandoned tasks not releasing state, rollover not re-deriving, or `task_queued` events (2,025) without matching release. **Needs verification** by running the existing read-only reconciliation (`GET /properties/{id}/reconciliation`) and reading `services/resource_state.py` before any dashboard relies on unit state.

### 4.8 Occupancy

- 39 occupancy records (2026-10-01 → 2026-11-19), **2 open**. Consistent with 1 occupied room and 1 occupied bed in state tables.
- Low volume: the occupancy trend will be sparse.

### 4.9 Cameras and video

- 54 cameras: 52 live, 52 enabled, 1 warm, 51 transcode-enabled. 201 stream sessions.
- Camera credentials are stored encrypted (`cameras.password` VARCHAR(1024)); values not inspected.

### 4.10 Audit and notifications

- `audit_events`: 909 rows, 2026-10-01 → 2026-11-19. Largest: notifications 546, employee 99, camera 70, session 55, rooms 30.
- `notifications`: 1,008 rows — task_assigned 875, submission_approved 95, task_reassigned 35, submission_disapproved 3.
- `task_history_events`: 4,255 rows; the best-populated lifecycle source.

### 4.11 Users and access

| Role | Active | Inactive | Logged in at least once (active) |
|---|---|---|---|
| SUPER_ADMIN | **513** | 0 | 507 |
| EMPLOYEE | 28 | 2 | 20 |
| PROPERTY_MANAGER | 10 | 1 | 3 |
| HUMAN_RESOURCE | 1 | 0 | 1 |

- **513 Super Admin accounts across 12 companies** is anomalous for a production tenant base. Likely self-service signup or smoke-test accounts. **Needs verification** before any user-count metric is shown; do not present "513 admins".
- Only 1 HR account exists, and it has no surface (see `05`).

### 4.12 Companies and properties

- 12 companies; 10 properties, all with status string `Active` (no enum, no CHECK).
- `properties.code` = `PROP-001` on all 10 — non-unique; cannot be used as a business key.
- 8 of 10 properties hold no operational data (≤ 5 employees, ≤ 2 tasks).

### 4.13 Growth and housekeeping

- `refresh_tokens`: **23,817 rows**, of which only **161 are expired**. No purge job was found in `super-admin/backend/app` (grep for purge/prune/cleanup/expire returned only config). Unbounded growth with a 30-day TTL implies 30 days of logins are retained. **Verify** the Employee Backend's handling of the same table before concluding.

## 5. Table-level findings to fix (for the redesign plan)

1. `employees.salary` (free text, unused) — replace with structured compensation (see `05`); never display on general profile.
2. `employees.shift`, `employees.leave_balance_days`, `employees.department`, `employees.leave_status` — legacy; migrate then retire.
3. Date columns stored as `VARCHAR` — convert to `DATE` in a backfill migration (shared with Employee Backend; see `10`).
4. Add CHECK constraints for status enums (after cleaning existing values).
5. `properties.code` — add a unique constraint per company, or `(company_id, code)`.
6. Entity-type normalisation in `audit_events` (one spelling per entity).
7. Composite indexes for dashboard predicates (see `07`).
8. `refresh_tokens` retention job.
9. Stale submission rows (125 pending) — reconcile.
10. Resource-state drift — reconcile before analytics.

## 6. Appendix — remaining column notes

- `tasks` has 52 columns, of which 27 are denormalised names/labels and 9 are recurrence fields stored as text. Consider splitting recurrence config into a child table in the redesign phase (not required for dashboards).
- `maintenance_tickets` has 36 columns; allocation metadata is duplicated with `work_allocation_*`.
- Shared-DB consumers: the Employee Backend reads and writes `attendance_*`, `shifts`, `employee_shift_assignments`, `employees` (coverage fields), `tasks` and `notifications`. Any schema change must be mirrored in both repos.
