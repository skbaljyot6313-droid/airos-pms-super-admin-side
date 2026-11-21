# 09 — New Features and Roadmap

Each entry: business value · target user · required data · existing support · new DB requirements · new APIs · complexity · priority. Items duplicating existing capabilities are excluded (e.g. department management, live map, team analytics, task review all exist).

Priority: **P0** = blocks correctness or safety of current features; **P1** = high value, data largely available; **P2** = valuable, depends on P0/P1 or new modules; **P3** = later, weak data today.

---

## Data hygiene and correctness (P0 — prerequisites, not features)

| ID | Item | Value | Target | Existing support | New DB | New API | Complexity | Priority |
|---|---|---|---|---|---|---|---|---|
| D-1 | Resource-state reconciliation (cleaning without open task: 15 rooms, 15 dorms, 60 beds) | Trustworthy unit status | SA, PM | `reconciliation` read API + `resource_state.repair` | none (verify logic first) | none new (use existing repair, reviewed) | Medium | **P0** |
| D-2 | Stale submission cleanup (125 pending rows on abandoned/completed tasks) | Correct review metrics | SA | review queue correct already | none | none | Low | **P0** |
| D-3 | Refresh-token purge job | Auth table bounded (23,817 rows) | Platform | — | none | scheduled job | Low | **P0** |
| D-4 | Audit entity-type normalisation | Filterable history | SA | writers exist | migration of values | none | Low | **P1** |
| D-5 | Super Admin account audit (513 accounts) | Access hygiene; clean user metrics | SA | `users` | none | admin list + deactivate (existing?) | Low | **P0** (security) |
| D-6 | Leave approval permission alignment (SA backend PM-allowed vs EB SA-only) | Single policy | SA, EB | both exist | none | none | Low | **P0** (decision) |
| D-7 | Date columns to `DATE` (`attendance_days`, `attendance_requests`, `employees.start_date`, `tasks.operational_date`) | Correct range queries and validation | Platform | — | backfill migration (shared) | none | Medium | **P1** |
| D-8 | CHECK constraints for status enums | DB-level validity | Platform | — | migration after cleanup | none | Low–Medium | **P1** |
| D-9 | Unique `properties.code` per company | Business key integrity | SA | — | constraint | none | Low | **P2** |

## Features

### F-01 Operational overview with trends
- **Business value**: one screen answering "what needs attention now" and "is it getting better".
- **Target**: SA, PM.
- **Required data**: tasks, maintenance, occupancies, employees — all present; trends need `completed_at` index.
- **Existing support**: partial (Overview tiles, `/workspace`).
- **New DB**: composite indexes (see `07` §5).
- **New API**: `GET /overview/summary`, `GET /overview/trends`.
- **Complexity**: Medium. **Priority**: **P1**.

### F-02 Exceptions inbox
- **Value**: surfaces overdue, abandoned spikes, unassigned work, stale maintenance, drift, expiring leave.
- **Target**: PM (daily), SA.
- **Data**: tasks (`due_date`, `status`), maintenance (`status`, `created_at`), resource drift (D-1), attendance (future-dated rows).
- **Existing**: partial via separate pages.
- **New DB**: optional `exceptions` table (materialised) or computed view.
- **New API**: `GET /exceptions?property_id`.
- **Complexity**: Medium. **Priority**: **P1**.

### F-03 Maintenance SLA tracking
- **Value**: response and resolution targets by priority; breach alerts.
- **Target**: PM, SA.
- **Data**: `maintenance_tickets` (created, resolved, closed), `maintenance_ticket_events` (33) — median resolve 16.6 h on 5 tickets. Volume is too low to set statistically meaningful targets.
- **Existing**: resolve timestamps; no SLA definition.
- **New DB**: `sla_policies` (priority → target hours); optional `assigned_at`.
- **New API**: `GET /maintenance/sla-summary`.
- **Complexity**: Low–Medium. **Priority**: **P1** (define policy first).

### F-04 Automated alerts and notifications (operations)
- **Value**: alert PM when reviews wait > X minutes, tasks overdue, maintenance untouched, cameras offline.
- **Target**: PM, SA.
- **Data**: all operational tables; camera `connection_status`.
- **Existing**: employee feed notifications (EB); realtime (Centrifugo) for live UI updates. **No manager-facing alerts.**
- **New DB**: `alert_rules`, `alert_events`, `alert_recipients`.
- **New API**: rule CRUD (SA), `GET /alerts`, acknowledge.
- **Complexity**: Medium. **Priority**: **P1**.

### F-05 Staffing gap and coverage forecast
- **Value**: shows zones and times where demand (tasks per work type per day) exceeds on-duty staff.
- **Target**: PM.
- **Data**: tasks (demand), employees + coverage (supply), attendance and shifts (availability) — **shifts and attendance empty today**.
- **Existing**: coverage model; allocation; no demand model.
- **New DB**: `staffing_targets` (zone × work type × day-part) optional.
- **New API**: `GET /workforce/coverage?date`.
- **Complexity**: High. **Priority**: **P2** (after shifts are used).

### F-06 Shift roster (weekly grid with coverage)
- **Value**: plan and see who is on which shift; swap requests.
- **Target**: PM.
- **Data**: `shifts`, `employee_shift_assignments` (exist, empty).
- **Existing**: `ShiftManager` (list/assign). No roster grid.
- **New DB**: optional `shift_swap_requests`.
- **New API**: `GET /shifts/roster?week`.
- **Complexity**: Medium. **Priority**: **P1** (UX on existing data; value depends on adoption).

### F-07 Leave policy, balances and holidays
- **Value**: correct leave entitlement, deductions and conflict checks — prerequisite for payroll.
- **Target**: HR, SA, PM (view), employee (own balance).
- **Data**: `attendance_requests` (11), `leave_type` enum; **no balances, no holidays**.
- **Existing**: requests and approval only.
- **New DB**: `leave_types`, `leave_policies`, `leave_balances`, `holidays`.
- **New API**: `GET|POST /leave/types`, `GET /leave/balances`, `POST /leave/accruals/run`, `GET|POST /holidays`.
- **Complexity**: Medium. **Priority**: **P1**.

### F-08 Employee onboarding workflow
- **Value**: checklist (documents, equipment, training, induction), start-date tasks, status tracking.
- **Target**: PM (ops), HR.
- **Data**: employees (created), departments, shifts (assignment at start).
- **Existing**: create-employee form only.
- **New DB**: `onboarding_templates`, `onboarding_items`, `employee_onboarding`.
- **New API**: `/onboarding/*`.
- **Complexity**: Medium. **Priority**: **P2**.

### F-09 Offboarding and exit records
- **Value**: exit reason, asset return, access revocation, final settlement trigger.
- **Target**: HR, PM.
- **Data**: `deactivated_at`, `reactivated_at` (4 deactivations).
- **Existing**: deactivate, reactivate.
- **New DB**: `employee_exits` (reason, last working day, notes, checklist state).
- **New API**: `POST /employees/{id}/exit`.
- **Complexity**: Low–Medium. **Priority**: **P2**.

### F-10 HR document management (secure)
- **Value**: contracts, identity/statutory documents, certificates, policy acknowledgements with access control and audit.
- **Target**: HR, employee (own), SA.
- **Data**: none.
- **Existing**: object storage abstractions (SA and EB). **Public media path must not be used.**
- **New DB**: `employee_documents`, `document_versions`, `policy_acknowledgements`.
- **New API**: upload (signed URL), list (permissioned), download (signed, audited).
- **Complexity**: High (security). **Priority**: **P1** (needed before payroll).

### F-11 Compensation structure and history
- **Value**: correct salary records and revisions; prerequisite for payroll and cost analytics.
- **Target**: HR, SA.
- **Data**: none usable (`employees.salary` free text, null).
- **New DB**: `compensation_components`, `employee_compensation` (effective-dated), `compensation_revisions`.
- **New API**: `/hr/compensation/*` (restricted).
- **Complexity**: Medium–High. **Priority**: **P1** (HR foundation).

### F-12 Payroll cycle (calculation, approval, locking, payslips)
- **Value**: monthly run with approval and payslips.
- **Target**: HR (prepare), SA (approve/lock).
- **Data**: F-11, complete attendance (F-07 + attendance completeness), statutory master data.
- **Existing**: none.
- **New DB**: `payroll_runs`, `payroll_lines`, `payslips`, `payment_batches`.
- **New API**: `/hr/payroll/runs/*`.
- **Complexity**: High. Specialist validation required. **Priority**: **P2** (after F-07, F-10, F-11).

### F-13 Statutory compliance pack (EPF, ESI, PT, TDS, Gratuity)
- **Value**: correct deductions and filings.
- **Target**: HR, SA.
- **Data**: statutory IDs (none), wage components (F-11), work state (none).
- **Existing**: none.
- **New DB**: `statutory_settings`, `statutory_rule_versions`, `employee_statutory_ids` (restricted).
- **New API**: rule admin (SA), statutory reports.
- **Complexity**: High. Specialist sign-off required. **Priority**: **P2** (blocked on specialist input).

### F-14 Labour cost analysis
- **Value**: cost per department, per property, per task.
- **Target**: SA.
- **Data**: F-11/F-12 plus task volume.
- **Complexity**: Medium (after payroll). **Priority**: **P2**.

### F-15 Department budgeting
- **Value**: budget vs actual headcount and cost.
- **Target**: SA, department manager (future).
- **Data**: departments (exist); budget (none); cost (F-12).
- **Complexity**: Medium. **Priority**: **P3**.

### F-16 Performance management (operational + reviews)
- **Value**: operational scorecards now; formal reviews later.
- **Target**: PM (operational), HR (reviews).
- **Data**: operational — tasks, reviews, turnaround, allocation (exist); reviews — none.
- **Existing**: employee analytics (operational KPIs).
- **New DB** (reviews only): `performance_cycles`, `performance_reviews`, `review_ratings`.
- **New API**: `/performance/*`.
- **Complexity**: Low (operational scorecard) / Medium (reviews). **Priority**: **P2** (scorecard), **P3** (reviews).

### F-17 Training and certifications
- **Value**: track mandatory training (fire safety, hygiene), expiries.
- **Target**: HR, PM.
- **Data**: none.
- **New DB**: `training_courses`, `employee_certifications` (expiry).
- **New API**: `/training/*`.
- **Complexity**: Medium. **Priority**: **P3**.

### F-18 Compliance management (property)
- **Value**: fire, licence, inspection calendar with due dates and evidence.
- **Target**: SA, PM.
- **Data**: none; evidence storage exists for tasks (`task_completion_images`).
- **New DB**: `compliance_items`, `compliance_checks`.
- **New API**: `/compliance/*`.
- **Complexity**: Medium. **Priority**: **P2**.

### F-19 Property benchmarking
- **Value**: compare properties on normalised KPIs.
- **Target**: SA only.
- **Data**: 10 properties; only 2 with material data → low value today.
- **Existing**: none.
- **Complexity**: Low (after aggregates). **Priority**: **P3** (after more properties are live).

### F-20 Maintenance forecasting
- **Value**: predict upkeep needs by unit type or age.
- **Data**: 10 tickets — insufficient.
- **Complexity**: High. **Priority**: **P3**.

### F-21 Operational forecasting (workload)
- **Value**: forecast next-week task volume from templates and check-ins.
- **Data**: template generations (631), occupancies (39), tasks (1,805) — sufficient for simple forecast; occupancy history thin.
- **Complexity**: Medium. **Priority**: **P2**.

### F-22 Executive reporting (scheduled PDF/CSV pack)
- **Value**: weekly summary to owners.
- **Target**: SA.
- **Data**: after F-01 summaries.
- **New API**: `/reports/schedules`, export.
- **Complexity**: Medium. **Priority**: **P2**.

### F-23 Data export (CSV) for lists
- **Value**: employees, tasks, maintenance exports for audit and finance.
- **Target**: SA, PM (non-HR fields).
- **Existing**: none.
- **Complexity**: Low. **Priority**: **P1**.

### F-24 Attendance regularisation and overtime
- **Value**: correct missing punches and overtime hours.
- **Target**: PM (approve), employee (request).
- **Data**: attendance_days (sparse), shifts (empty).
- **New DB**: `attendance_regularisations`; overtime rules.
- **Complexity**: Medium. **Priority**: **P2** (after shifts in use).

## Duplicates excluded

- Department management, transfers and heads (exist).
- Live locations map (exists).
- Team analytics and employee analytics (exist; redesign only).
- Task review queue and approval (exists).
- Audit log viewer (exists; consolidate routes only).
- Camera management and VMS (exist).

## Suggested sequencing

1. **Now (P0)**: D-1, D-2, D-3, D-5, D-6 — correctness and security.
2. **Next (P1 foundations)**: D-7, D-4, F-01, F-23, F-07, F-11, F-10, F-06.
3. **Then (P1 ops)**: F-02, F-03, F-04.
4. **Then (P2 HR)**: F-12, F-13, F-09, F-08, F-24, F-16 (scorecard).
5. **Later (P2–P3)**: F-05, F-14, F-15, F-17–F-22.
