# 07 — Orphaned & Hidden Features

Capabilities not reachable through standard nav — require URL, tab, row action, or API.

## Backend-only (no UI surface)

| Capability | Endpoint | Status |
|---|---|---|
| Property reconciliation scan | `GET /properties/{id}/reconciliation` | API-only; drift detection, no screen |
| Work batches | `POST/GET /work-batches*` | allocation engine internals; results surface via tasks |
| Template due-generation tick | `POST /templates/generate-due` | scheduler/admin trigger |
| Fresh-day rollover | `POST /properties/{id}/fresh-day` | BG/admin |
| Audit event writes | `audit_events` | internal; read only via `/logs` feed |
| EB allocation-notice push | post-commit hook | invisible infrastructure |
| Employee attendance day/calendar detail | `/employees/{id}/attendance/*` | exists; partial UI (employee detail tabs) |
| Washroom maintenance endpoints | `/washrooms/{id}/maintenance`, `/rooms/{id}/maintenance` | surfaced via washroom detail modal |
| Resource transition/repair | `/resources/{t}/{id}/transition|repair` | contextual only, no list UI |
| Company PATCH | `PATCH /companies/{id}` | no dedicated edit screen found |
| `/media` upload/serve | POST/GET | used by evidence/attachments, not standalone |

## Hidden behind tabs/drill-ins (URL-deep only)

- `…/employees/:employeeUid` — link-only from directory/roster.
- `…/departments/:departmentUid` — link-only.
- `…/tasks/history/:date`, `…/maintenance/history/:date` — calendar/history drill-ins.
- `va/camera-settings` tab — deep-link.
- EmployeesView tabs (board/directory/deactivated/live/leaves/shifts/attendance/analytics) — not URL-addressable; state-driven.
- TasksView tabs — URL-addressable via `?tab=` only.

## Conditionally rendered / role-gated

- `/admin/*` — SA only; invisible to PM.
- `va/*` — SA+PM; PM sees it but not admin logs.
- Delete-dept hidden for `is_system` rows.
- Head clear/replace UI appears only when transferring a head.

## Legacy / transitional

- `…/maintenance`, `…/templates` — redirect shims (kept for old links).
- `Employee.department` free-text — retained for employee-app compat; superseded by `department_id`.
- `human_resource`, `department_manager` roles — defined, **no surface** grants them workspace access.
- Static dept picklist fallback in staff form — dead code unless `/departments` unreachable.

## Needs verification

- Whether `logs/attachments/{source}/{event_id}` covers all evidence types (test exists for delivery).
- Whether any PM-only screens exist that SA shouldn't see (currently PM ⊆ SA surface).
- `GET /media` response contract vs `GET /media/file/{key}` — two media paths present.
