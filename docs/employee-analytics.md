# Employee Analytics — Feature & API Reference

Last updated: 2026-10-30. Documents the employee detail/analysis surface shipped on the
management frontend plus the three staff-only read endpoints behind it.

**Files:** `backend/app/services/employee_profile.py`,
`backend/app/api/v1/workspace.py` (Employee section),
`frontend/src/components/employees/EmployeeDetailView.tsx`,
`frontend/src/api/employees.ts`,
tests `backend/tests/test_employee_profile.py`,
`frontend/src/components/employees/EmployeeDetailView.test.tsx`,
`EmployeeDirectory.test.tsx`.

---

## 1. Navigation & page

- Employee directory cards/names and Zone Board name buttons navigate to
  `GET /property/:propertyUid/employees/:employeeUid` (SPA).
- Interactive controls (zone dropdowns, kebab menus, drag handle) do **not**
  trigger navigation; name buttons on the board do not initiate dragging.
- Page sections: header (name, title, department, property, status, open-task count),
  date-range tab, four metric cards, **Task outcome distribution** bars,
  **Attendance split** stacked bar, employment/compensation panel,
  attendance & leave summary, and six record tabs:
  Task history · Submissions & reviews · Attendance · Leaves & week-offs ·
  Shift history · Allocation history.

## 2. Endpoints (all `require_property_manager` i.e. staff only)

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/employees/{id}/profile` | Employee record + context + aggregate metrics |
| `GET /api/v1/employees/{id}/tasks` | Paginated task history with per-filter date semantics |
| `GET /api/v1/employees/{id}/records` | Paginated histories: attendance / leaves / shifts / allocations / submissions |

Shared params: `property_id` (required by the UI — employee must belong to it),
`date_from`, `date_to` (ISO datetimes, **must include timezone**;
`date_from >= date_to` → 422 `INVALID_DATE_RANGE`; `date_to` is exclusive =
start of next IST day), `page` (≤100000), `limit` (≤100, default 25).
Responses are `Cache-Control: private, no-store`.

`/tasks` extra params: `filter` ∈ `all | allocated | completed | abandoned |
rejected | pending_review | current_open`, `search` (title/ticket/task ID,
`%`/`_`/`/` escaped). `/records` requires `kind`.

## 3. Metric semantics (distinct task IDs; all-time or in-range)

| Metric | Truth source |
|---|---|
| **Allocated** | `tasks.employee_id == emp` OR an allocation-ledger row (`ticket_kind='task'`) assigning them |
| **Completed / approved** | a `task_completion_submissions` row for this employee with `status='approved'` |
| **Submitted, then rejected** | a submission row with `status='disapproved'` |
| **Pending review** | a submission row with `status='pending'` |
| **Abandoned while assigned** | assignment-at-event evidence (allocation ledger / `abandoned_at` snapshot); legacy fallback = currently abandoned + assigned with **no** ledger rows |
| **Current open** | `employee_id == emp` and status not in completed/cancelled/abandoned |

Counts **overlap** (a rejected attempt can later be approved). Credit is by
**employee ID on records — never actor-name matching**; staff can submit on an
employee's behalf. Maintenance tickets are excluded from task counts (they
appear in allocation history).

## 4. Per-task row fields

`current_status`/`current_assignee` are authoritative-task fields, separate
from `review_status`/`attempt_number`/`submitted_at`/`reviewed_*` which come
from the **latest matching submission attempt** (ordered by attempt number).
`recorded_start_at` pairs the latest `started` history event within the
matching attempt window; `start_to_submission_seconds` is computed only when
the recorded assignee at that start was this employee **and** no intervening
reallocation occurred — otherwise `null`. Elapsed time includes pauses; it is
not measured active labor or payroll time. Reassignment-away does not count
as "allocated" in a later range but does appear in allocation history.

## 5. Date-range semantics

- Metrics map to per-metric date columns: allocated→latest alloc (else
  created), completed/rejected/pending→submission submitted_at,
  abandoned→coalesce(abandoned_at, abandoned history, created),
  current_open→created_at.
- `/tasks` uses the date column matching `filter`; `all` uses the first
  available of submission/alloc/created.
- `/records`: attendance→`attendance_date`, leaves→`created_at`,
  shifts→`effective_from`, allocations→`created_at`,
  submissions→`submitted_at`. String `YYYY-MM-DD` columns compare against
  IST-converted keys.

## 6. Frontend behaviors

- Date tab: All time · Today · Last 7 days · Last 30 days · Month — native
  `<input type="month">` plus **Browse months** collapsible strip (last 18
  months as chips). IST day boundaries → UTC instants (`dateBounds` helper).
- Metric cards are clickable → jump to the matching `/tasks` filter.
- Task rows: expandable "View full task history" (lazy `GET /tasks/{id}` —
  all actors, oldest first); review fields shown as labeled values, not JSON.
- Visualizations: `MetricBars` (distribution) + `AttendanceSplit`
  (present/absent/leave/week-off stacked bar, role="img" summary + legend).
- Search debounced 350 ms; stale requests ignored; safe error/retry states;
  `aria-pressed`/`aria-selected` on controls; `private, no-store` responses.

## 7. Known limitations (displayed, never fabricated)

- `salary` is a free-text nullable field — no currency/pay period/payslips.
- Missing attendance ≠ absence; "incomplete" days excluded from work-time sums.
- Historical name-only events cannot be attributed to an employee ID.
- Employee-app authentication (login/logout) is not in these endpoints —
  needs instrumentation in the separate Employee Backend.
- Photo previews on logs use `/admin/logs/attachments/...` (bearer blob);
  task-history evidence counts are shown without embedded images.
- Page-level metrics cover every property the caller can access; a
  `property_id` only validates the employee's home property.

## 8. Verification

- `backend/tests/test_employee_profile.py` — 13 tests: counts attribution,
  manager scoping, cross-tenant 404, employee-role 403, search escaping,
  pagination, attempt-duration pairing, missing-start honesty, date-range
  filtering, route permission, no-store caching.
- Frontend: `EmployeeDetailView.test.tsx` (9), `EmployeeDirectory.test.tsx` (2).
- Full suite verified: 209 backend tests, 60 frontend tests, `tsc`, `vite build`.
