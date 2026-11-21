# 04 — Workforce Module Audit

Scope: employees, departments, heads, allocation, transfers, attendance, shifts, leave, live location, devices, performance, analytics, deactivation. Each feature lists the component, API, tables, permission, data reality, gaps and improvements.

Permission baseline (verified in code): workspace routes use `Staff = Depends(require_property_manager)` → **super_admin and property_manager only**. Attendance/leave routes in the Super Admin backend also use `require_property_manager`. Live-location routes use `require_property_manager`. Logs are `require_super_admin`. HR and department_manager have no workspace access.

## 1. Feature-by-feature assessment

### 1.1 Employee directory
- **Component**: `EmployeeDirectory.tsx` (+ `EmployeesView` tab `directory`).
- **API**: `GET /employees` (workspace reads), `PATCH /employees/{id}`, `POST /employees`, `DELETE /employees/{id}`, `POST …/deactivate|reactivate`.
- **Tables**: `employees`, `departments` (for label), `employee_area_assignments`.
- **Permission**: SA + PM (property-scoped).
- **Data**: 39 employees (35 active).
- **Gaps**: no bulk actions; no export; no column choice; no employment-type field; no emergency contacts; no status history view; `phone` missing for 12.
- **Improvements**: table with saved views, bulk deactivate/transfer (transfer exists in Departments only), CSV export, status chips with reason.

### 1.2 Employee creation (onboarding)
- **Component**: `CreateEmployeeModal.tsx` (name, job title, department picklist live with static fallback, email, phone, password, primary zone, shift, start date).
- **API**: `POST /employees` → creates employee and resolves `department_id` from the name (property-scoped).
- **Gaps**: no onboarding checklist, no document collection, no probation/contract fields, no onboarding status, no welcome/credential delivery tracking, `start_date` is free text, shift assignment in the form does not persist (shifts table is empty — **verify**).
- **Improvements**: onboarding workflow (see `09`), structured start date, role/department required rules, invite instead of password entry.

### 1.3 Employee profile and detail
- **Component**: `EmployeeDetailView.tsx` + analysis tabs.
- **API**: `GET /employees/{id}/profile|tasks|analytics|records|locations|attendance/calendar|attendance/day|devices` (+ tabs hidden for attendance, maintenance, devices).
- **Gaps**: "Recorded salary" field displayed on the profile (text, unused, sensitive); attendance/maintenance/device tabs hidden by request (code kept); no contract, documents, or history of role/department/zone changes beyond audit feed.
- **Improvements**: separate sensitive HR fields into a permissioned HR section; reinstate device and attendance in a "Work history" group.

### 1.4 Employee lifecycle (deactivate, reactivate, delete)
- **API**: `POST /employees/{id}/deactivate`, `POST …/reactivate`, `DELETE /employees/{id}`. `deactivated_at`/`reactivated_at` timestamps exist.
- **Data**: 4 inactive; 2 with `reactivated_at` history not present in analysed columns (NEEDS VERIFICATION).
- **Gaps**: no exit reason, no exit interview, no final settlement, no asset return; delete is hard-delete (no soft-delete flag).
- **Improvements**: offboarding checklist, exit reason, retention policy; restrict hard-delete.

### 1.5 Zone board and allocation
- **Component**: `ZoneBoard.tsx` (`@dnd-kit`).
- **API**: `PATCH /employees/{id}/zone`, `PATCH /employees/{id}/allocation` (primary/secondary/area/covers_property), `POST|DELETE /employees/{id}/areas`.
- **Tables**: `employees` (zone_id, secondary_zone_id, area_id, covers_property), `employee_area_assignments` (0 rows), `zones`, `areas`, `zone_allocation_state`, `allocation_events`.
- **Data**: 25 of 39 unallocated; allocation events 252; round-robin history 1,966.
- **Gaps**: no capacity or shift awareness; no keyboard-accessible alternative verified (NEEDS VERIFICATION); allocation coverage rules are complex (primary, secondary, area, property-wide) and not explained in UI.
- **Improvements**: coverage legend, unallocated panel with counts by zone, capacity bars (tasks per employee per zone).

### 1.6 Departments, heads and transfers
- **Components**: `DepartmentsView.tsx`, `DepartmentDetailView.tsx`, `DepartmentFormModal.tsx`, `TransferModal.tsx`.
- **API**: `GET/POST/PATCH/DELETE /departments…`, `PUT /departments/{id}/head`, `POST /departments/transfer` (bulk), `GET /departments/transfers`, `GET /departments/overview`.
- **Tables**: `departments` (unique name per property, `is_system`, `head_employee_id`), `department_transfers` (append-only snapshot history), `employees.department_id`, legacy `employees.department` (dual-written).
- **Rules (verified)**: head must be active and in the same property; one head per employee; head change does not move the employee; transfers lock employee rows `FOR UPDATE`; head-as-member transfer requires `head_action` (`clear` | `replace`); delete only when empty; system departments cannot be deleted (409 `SYSTEM_DEPARTMENT`); all changes audited.
- **Data**: 16 system rows (2 properties × 8); 2 transfers; 1 head.
- **Gaps**: no department budget, no department KPIs (only counts); system department list is fixed in code (8 names) and is not configurable; provisioning is lazy per property; `departments.code` is optional and unused.
- **Improvements**: department KPIs (headcount trend, active %, open tasks by department — requires `department_id` on tasks or join through employee), head succession view, transfer history chart.

### 1.7 Department head management
- Covered above. Head carries **no extra permissions** (by design). The head is an org attribute only. Recommendation: keep it that way until a scoped `department_manager` permission model is approved (see `05`).

### 1.8 Attendance (status board, day records)
- **Component**: `AttendanceBoard.tsx`.
- **API**: `GET /attendance/status-board` (PM dep, SA backend); attendance writes come from the Employee Backend (`/attendance/today|start|break|resume|end`).
- **Tables**: `attendance_days`, `attendance_breaks` (shared; written by EB).
- **Data**: 11 day rows, 1 break — effectively **no attendance data**. Five rows are future-dated.
- **Logic**: status board computes `working`, `on_break`, `completed` (on_time/late, early departure), `absent`, `awaiting`, `off_day`, `unscheduled`, `incomplete` (needs_review). Shift-driven logic depends on `shifts` (0 rows) → **most computed statuses will not be produced**. Verify behaviour with no shift assigned.
- **Gaps**: no monthly summary, no present/absent trend, no overtime, no regularisation workflow.
- **Improvements**: attendance summary per period, present/absent by department, regularisation requests, overtime computed from `work_seconds` vs shift end.

### 1.9 Shift management
- **Component**: `ShiftManager.tsx`. **API**: `GET|POST /shifts`, `PATCH /shifts/{id}`, `GET|POST /employees/{id}/shift-assignments`, `GET /shift-assignments`, `PATCH|DELETE /shift-assignments/{id}`.
- **Tables**: `shifts` (0), `employee_shift_assignments` (0).
- **Data**: none. The feature is fully built but never used in data.
- **Gaps**: no roster grid (week view), no swap workflow, no coverage check against zone demand, no shift-to-task linkage.
- **Improvements**: weekly roster grid with coverage (staff on shift vs open tasks per zone) — needs data first.

### 1.10 Leave management
- **Component**: `LeavesPanel.tsx`. **API**: `GET /attendance/requests`, `POST …/approve|reject` (SA backend, **PM dep**). Employee app creates requests (`POST /attendance/requests`, cancel).
- **Tables**: `attendance_requests` (11 rows).
- **Enum (model)**: leave types `casual_leave`, `sick_leave`, `paid_leave`, `unpaid_leave`, `other`; request types `leave`, `week_off`.
- **Data**: leave 4, week_off 7. Leave type null on 7 (week_off). Only 3 leave requests with a type.
- **Conflict found**: **approve/reject permission differs by backend.** Super Admin backend `attendance.py` lines ~59–78 use `require_property_manager` (SA **and** PM). Employee backend `attendance.py` lines ~162–186 use `require_super_admin`. The same `attendance_requests` table is shared. **Decision required**: which role approves leave.
- **Gaps**: no leave balances (all 39 `leave_balance_days` null), no accrual, no holiday calendar, no policy per leave type, no carry-forward, no paid/unpaid enforcement, no department leave-conflict view.
- **Improvements**: leave policy table, balances ledger, holiday calendar, conflict check (min staff per zone per day) — see `05`.

### 1.11 Live locations
- **Component**: `LiveLocationMap.tsx` (Leaflet, markercluster, auto-fit, 10 s poll).
- **API**: `GET /live-locations`, `GET /live-locations/{uid}`, `GET /live-locations/{uid}/history` → proxied to the Employee Backend `/admin/...` with `X-Location-Service-Key`. Server returns only clocked-in staff.
- **Tables (EB-owned)**: `location_tracking_sessions` (1,178 rows, 2026-10-26 → 11-05), `location_events` (2). Redis hot path (EB).
- **Data**: location data is **not current** — last session 2026-11-05 (14 days before the discovery date). Live map will often be empty.
- **Privacy**: coordinates are not stored/logged by design (EB AGENTS) except `location_tracking_sessions` — NEEDS VERIFICATION of what is persisted.
- **Improvements**: route-history replay (exists via API but not in UI beyond locations tab), zone heat map, freshness indicator.

### 1.12 Devices
- **Component**: `DevicesTab.tsx` (hidden). **API**: `GET /employees/{id}/devices`. **Tables**: `device_registrations` (EB-owned, 10 rows).
- Hidden by request. Keep behind the employee profile in a "Work history / Devices" section if reinstated.

### 1.13 Employee performance
- **No performance model exists.** Proxies available: tasks completed per employee, review approval rate (approved 115 / disapproved 9), median completion time (62.5 min), review turnaround (47.8 min), allocation history.
- `OverviewTab` (employee analysis) shows KPI tiles derived from tasks — this is the closest existing "performance" view.
- **Gaps**: no goals, no reviews, no ratings, no competency model. Recommend "Operational performance" (computed) distinct from "Performance reviews" (HR, new module).

### 1.14 Employee analytics and team analytics
- **Components**: `analysis/OverviewTab.tsx`, `analysis/TeamAnalytics.tsx`, `PeriodSelector.tsx`, `analytics/AllocationTimeline.tsx`.
- **API**: `GET /employees/{id}/analytics`, `GET /employees/team-analytics`.
- **Quality**: the most visually developed screens in the module (KPI grid, activity chart, hover interactions, status colours).
- **Palette**: cool slate (see `02` §9).

### 1.15 Deactivated employees
- Tab `deactivated` (inline list). 4 records. Reactivate action. Fine as a filter; should become a status filter in the directory rather than a separate tab.

---

## 2. Data flows and dependencies

```
Employee Backend (EB, separate repo, same DB)
  ├─ writes attendance_days, attendance_breaks, attendance_requests (create)
  ├─ writes location_tracking_sessions, location_events (EB-owned)
  ├─ writes device_registrations, notifications
  └─ reads shifts, employee_shift_assignments, employees (coverage fields)

Super Admin Backend
  ├─ owns employees, departments, department_transfers, shifts, employee_shift_assignments
  ├─ approves/rejects attendance_requests (PM dep)
  └─ proxies live locations to EB (X-Location-Service-Key)
```

Implication: any new HR table (payroll, documents, leave balances) must be owned by one repo and mirrored in migrations; the other repo must only read it through an agreed contract.

## 3. Proposed structure — evaluation

The brief proposes Workforce → Overview, Employees, Departments, Human Resources, Analytics.

| Proposed item | Exists today? | Assessment |
|---|---|---|
| Workforce Overview | Partly — Workforce Dashboard exists (dept-centric) | Rename to Overview; add present/absent/on-leave tiles (data blocked; see `06`) |
| Employees (directory, profiles, onboarding, lifecycle, records, status, allocation, history) | Directory, profile, allocation, deactivate exist; onboarding, records, history are thin | Keep; add onboarding and offboarding as sub-flows |
| Departments (management, heads, distribution, performance, staffing, transfers) | All exist except department performance | Keep |
| Human Resources (payroll, salary, compensation, leave, attendance mgmt, shifts, documents, onboarding/offboarding, contracts, reviews, policies, lifecycle) | Only leave requests and shifts (shifts unused) | **Mostly new**; see `05` |
| Workforce Analytics (attendance, department, utilisation, availability, staffing, overtime, leave, costs) | Team analytics exists; others blocked by data | Keep as one destination with honest "data coverage" banners |

**Overlaps identified**
1. **Attendance and Leave** appear in three places: Workforce → Employees tabs (Leaves, Attendance), proposed HR (leave management), and Scheduling. Recommend one "Attendance & Leave" area, with HR owning policies and balances only.
2. **Shifts** sit in Employees tabs but belong to "Scheduling". Recommend "Scheduling" as its own secondary item.
3. **Employee analytics** appears in Employee detail, Team analytics, and Workforce Analytics. Recommend a single analytics area with per-employee drill-down.
4. **Department headcount** appears on Overview, Dashboard, Departments, and Insights.

**Recommended final organisation (Workforce)**

```
Workforce
├── Overview            (KPIs, composition, staffing gaps, attendance today when data exists)
├── Employees           (directory · zone allocation · live map · deactivated [as filter])
├── Departments         (directory · detail · heads · transfers)
├── Attendance & Leave  (day status · requests · balances [new] · holiday calendar [new])
├── Scheduling          (shifts · roster · coverage)  — keep shifts, promote to its own area
├── Analytics           (team · department · attendance · utilisation · overtime [new])
└── HR  [restricted]    (compensation · payroll · documents · lifecycle · policies)
```

The HR group should be **visible only to roles explicitly authorised** (see `05` §F) and hidden entirely otherwise.

## 4. Permissions summary for this module

| Capability | SA | PM | HR | DM | EMP |
|---|---|---|---|---|---|
| View directory and profile | ✓ | ✓ | ✗ (no surface) | ✗ | ✗ (mobile app only) |
| Create/edit/deactivate employee | ✓ | ✓ | ✗ | ✗ | ✗ |
| Department admin, heads, transfers | ✓ | ✓ | ✗ | ✗ | ✗ |
| Approve leave | ✓ (SA backend) | ✓ (SA backend) / ✗ (EB: SA only) | ✗ | ✗ | ✗ |
| Live location | ✓ | ✓ | ✗ | ✗ | ✗ |
| Shifts | ✓ | ✓ | ✗ | ✗ | Read own shift (EB) |

Permission changes are **not** part of this discovery; this table records current state.

## 5. Missing functionality summary

- Leave balances, accrual, types policy, holiday calendar.
- Compensation structure and history (see `05`).
- Documents and contracts.
- Onboarding and offboarding workflows.
- Performance reviews (distinct from operational metrics).
- Overtime model.
- Attendance regularisation.
- Department budget and labour cost.
- Attrition and joining/exit analytics (partial: `created_at` and `deactivated_at` only).
