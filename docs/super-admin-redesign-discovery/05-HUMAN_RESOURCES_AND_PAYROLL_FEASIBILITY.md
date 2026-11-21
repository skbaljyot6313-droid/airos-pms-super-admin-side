# 05 — Human Resources and Payroll Feasibility

Bottom line first: **the current architecture cannot support payroll.** There is no compensation model, no payroll cycle, no statutory data, and no HR document store. Leave exists only as request records without balances. A proper HR module must be built as new data structures, not by extending the existing leave tab.

Status vocabulary used below: **Existing** (implemented and used), **Data-ready** (fields/tables exist but unpopulated), **Build** (new backend), **New tables**, **External** (third-party integration), **Specialist** (needs compliance validation before implementation).

This document makes no statutory claims beyond general categories. Rates, wage ceilings, filing rules and thresholds **change by notification and by state** and must be confirmed by a qualified payroll/compliance specialist.

---

## A. Employee compensation

| Capability | Status | Evidence |
|---|---|---|
| Basic salary | **Data-ready (unusable)** | `employees.salary` is `VARCHAR(64)` free text. 39/39 null. |
| Gross / net salary | Not present | No columns. |
| Fixed allowances | Not present | — |
| Variable allowances, incentives | Not present | — |
| Deductions | Not present | — |
| Overtime payments | Not present | `attendance_days.work_seconds` exists, but no pay rate and no overtime rule. |
| Salary revisions and effective dates | Not present | No history table. `employees.salary` overwrites. |
| Compensation history | Not present | — |
| Salary structures (templates/components) | Not present | — |
| Department-wise salary expenditure | Not present | Depends on structure above; departments exist. |

**Required new structures**: `compensation_structures` (component master), `employee_compensation` (effective-dated assignments: `effective_from`, `effective_until`, `created_by`, `reason`), `compensation_components` (fixed, variable, incentive, deduction, statutory flags), `compensation_revisions` (append-only). Migrate `employees.salary` text into a note field for audit, then retire it.

**Sensitivity**: compensation must never appear in list payloads, employee directory, Team analytics, exports, audit `detail` JSON (currently `audit_events.detail` is JSON with free content — **verify no salary is written there**), or the Employee Backend's `/employees` responses.

## B. Payroll management

| Capability | Status | Required |
|---|---|---|
| Monthly payroll cycle | Not present | `payroll_runs` (period, status: draft/review/approved/locked, approver, timestamps). |
| Payroll processing (calculation engine) | Not present | Build: pure calculation module (domain layer), deterministic, unit-tested, versioned rule sets. Specialist for rules. |
| Payroll approval | Not present | Two-step approval; approver ≠ preparer; audit. |
| Salary calculation | Not present | Inputs: compensation (effective-dated), attendance days, leave days (paid/unpaid), overtime, adjustments. |
| Payslip generation | Not present | PDF generation (new dependency or service) + secure storage (see E). **External/library decision**. |
| Disbursement tracking | Not present | `payment_batches`, `payment_status` per employee. Bank file generation is **External** (bank-specific formats). |
| Payroll history | Not present | Locked runs are immutable; amendments as new runs. |
| Payroll reports | Not present | Department and employee statements (see `06`). |
| Employee-wise salary statements | Not present | Access-restricted. |
| Department-wise payroll expenditure | Not present | Needs payroll runs + departments (exists). |

**Data that could feed payroll today**: attendance days (11 rows, sparse), leave requests (11), shift assignments (0). **Not sufficient** — attendance must be complete for every paid day before any payroll run is trustworthy.

## C. Indian payroll requirements

Categories only. Each item needs specialist confirmation of current rules before design.

| Requirement | Current support | Data needed | Category |
|---|---|---|---|
| EPF (Provident Fund) — contribution, UAN, wage base | None | UAN, PF-eligible wage components, establishment settings | New tables + Specialist |
| ESI (Employees' State Insurance) — contribution, IP number, wage threshold | None | ESI IP number, ESI-eligible wage, threshold rules | New tables + Specialist |
| Professional Tax — state-specific slabs | None | Employee work state, PT slab table per state | New tables + Specialist |
| TDS on salary — income-tax deduction | None | PAN, declared investments/regime, slab rules, financial year | New tables + External (tax tooling) + Specialist |
| Gratuity — eligibility and computation on exit | None | Date of joining (text today), last drawn wage, service length | New tables + Specialist |
| Statutory deductions and returns (monthly/annual filings) | None | Filing references, challans | External + Specialist |
| Paid vs unpaid leave | Leave types enumerated, no policy | Leave policy, balances, approval | New tables |
| Overtime | Work seconds only | Overtime rules (rate, threshold, approval) | New tables + Specialist (labour-law rules vary) |
| Full-and-final settlement | None | Exit date, dues, recoveries, leave encashment, gratuity | New workflow + Specialist |
| Bank disbursement file | None | Bank account details (sensitive), bank-specific format | External |

**Existing data that can support Indian payroll later**: employee identity (name, email); `start_date` (free text, must become `DATE`); `deactivated_at` (exit date proxy); leave requests; attendance days. **Missing**: PAN, UAN, ESI IP, bank details, state of work, statutory IDs, date of birth, nominee details, bank account.

## D. Leave management

| Capability | Status | Evidence / gap |
|---|---|---|
| Leave types | Partial | Enum in `models/attendance.py`: `casual_leave`, `sick_leave`, `paid_leave`, `unpaid_leave`, `other`. Stored as free `VARCHAR(32)` on requests. No master table. |
| Leave balances | Data-ready (unusable) | `employees.leave_balance_days` null for 39/39. No ledger. |
| Accrual policies | Not present | No rules. |
| Leave applications | **Existing** | `attendance_requests` (11 rows), created from Employee app. |
| Approval hierarchy | **Conflict** | SA backend: approve/reject open to SA and PM. EB: SA only. No configurable hierarchy. |
| Leave history | Existing (records only) | Requests retained with `reviewed_by`, `review_comment`. |
| Paid/unpaid leave | Enum only | No balance deduction, no payroll link. |
| Holiday calendars | Not present | No holiday table. |
| Department leave statistics | Buildable | Join requests → employees → departments. Sparse data. |
| Leave conflicts and staffing availability | Not present | Needs zone coverage (exists) and per-day approved leave (exists) → buildable as a check. |

**Recommendation**: `leave_types` (code, name, paid flag, annual quota, carry-forward rule), `leave_policies` (by department or company), `leave_balances` (ledger: opening, accrued, taken, adjusted, closing; period), `holidays` (company/property, date, name), approval rule table (who may approve by department/request type). Migrate `attendance_requests.leave_type` values into `leave_types` (requires mapping of free text: observed `casual_leave`, `sick_leave`, `other`).

## E. HR documents

| Capability | Status | Evidence |
|---|---|---|
| Employee contracts | Not present | No model. |
| Identity and statutory documents | Not present | No model. |
| Certificates | Not present | No model. |
| Offer letters | Not present | No model. |
| Employment history | Not present (only snapshot `department_transfers`) | — |
| Policy acknowledgements | Not present | — |
| Secure document storage | **Partial, unsafe for HR** | Super Admin `storage.py` (local/S3/Supabase) serves media through `/media/file/{key}`. Employee Backend (`employee/AGENTS.md`) serves `GET /media/file/{key}` **publicly (240/min)** using unguessable keys. HR documents **must not** use either public path. |

**Required design**:
- Private bucket (no public read), short-lived signed URLs issued only after an authorisation check.
- `employee_documents` (owner employee, category, file key, checksum, uploaded_by, visibility, retention until, supersedes_id), append-only versions.
- Document categories with visibility rules (e.g. identity documents: HR and SA only; offer letters: HR and employee).
- Virus scanning and MIME/magic-byte validation (existing pattern in EB `POST /media/uploads`, reusable).
- Access log (`audit_events` with entity `employee_document`, action `view`/`download`).
- Retention policy and deletion workflow.

**Existing mechanisms to reuse**: magic-byte MIME validation (EB), object-store abstraction (SA `storage.py`, EB `storage.py` with GCS/S3), audit service (`AuditService.record`).

## F. HR permissions

### F.1 Current role architecture (verified)

| Role | Current surface | Notes |
|---|---|---|
| super_admin | Full company and property | `require_super_admin` on logs/admin; `require_property_manager` (includes SA) on workspace |
| property_manager | Full property workspace | Property-scoped; cannot reach admin routes |
| human_resource | **None** | `RequireRole` redirects HR to `/`; `require_property_manager` excludes HR. 1 active HR user exists and logged in once. |
| department_manager | **None** | Defined only. Head of department has no permissions. |
| employee | Mobile app (EB) | Cannot use Super Admin UI |

### F.2 Proposed HR permission matrix (recommendation only — no change applied)

| Action | SA | PM | HR | DM | EMP |
|---|---|---|---|---|---|
| View employee directory (no compensation) | ✓ | ✓ | ✓ | Own dept (proposed) | ✗ |
| View own profile and payslips | ✓ | ✓ | ✓ | ✓ | ✓ (own only) |
| View compensation (any employee) | ✓ | ✗ | ✓ (proposed) | ✗ | Own only |
| Edit compensation / revisions | ✓ | ✗ | ✓ (with approval) | ✗ | ✗ |
| Prepare payroll run | ✓ | ✗ | ✓ | ✗ | ✗ |
| Approve payroll run | ✓ | ✗ | ✗ (preparer ≠ approver) | ✗ | ✗ |
| Lock payroll run | ✓ | ✗ | ✗ | ✗ | ✗ |
| Approve leave | ✓ (per policy) | ✓ (per current SA-backend code; **conflicts with EB**) | ✓ (proposed) | Own dept (proposed) | ✗ |
| View identity/statutory documents | ✓ | ✗ | ✓ | ✗ | Own only |
| Upload employee documents | ✓ | ✗ | ✓ | ✗ | Own (proposed) |
| Change department head | ✓ | ✓ | ✗ | ✗ | ✗ |
| Manage HR policies | ✓ | ✗ | ✓ | ✗ | ✗ |

Notes:
- "Proposed" entries are **not** existing permissions. They require explicit approval and a new scoped permission model (not by reusing roles indiscriminately).
- Salary visibility must be enforced **server-side** in the response schema and query, not only in the UI.
- Payroll approval must be separated from preparation (two-person rule).
- Leave approval role must be decided once and enforced identically in both backends.

### F.3 Scoped permission model (for approval)

Options:
1. Add permission strings to roles (`hr.compensation.read`, `hr.payroll.approve`, …) and a `role_permissions` table.
2. Add scoped grants (`user_scope_grants`: user, permission, property or department).
3. Keep roles and add an HR-specific role flag.

Recommendation: option 2 — scoped grants — so HR can be scoped to a property and a Department Manager can be scoped to a department without new global roles. This is a design decision for the user.

## G. Feasibility verdict

| Area | Verdict |
|---|---|
| Compensation master and history | Feasible. New tables; migration of free-text salary is not feasible (values absent). |
| Payroll cycle, calculation, approval, locking | Feasible after compensation and complete attendance. Needs specialist rules. |
| Payslips | Feasible. PDF library/service decision. |
| Disbursement | Partly feasible. Bank file formats are external. |
| Statutory (EPF/ESI/PT/TDS/Gratuity/F&F) | Feasible only with specialist-validated rules and new statutory master data. Not assumed. |
| Leave policy and balances | Feasible. Medium. Prerequisite for payroll unpaid-leave deduction. |
| HR documents | Feasible with private storage and signed URLs. Must not reuse public media endpoints. |
| HR permissions | Feasible via scoped grants; requires decision. |

## H. Required database changes (summary; not applied)

New: `compensation_components`, `employee_compensation`, `compensation_revisions`, `payroll_runs`, `payroll_lines`, `payslips` (or `payroll_documents`), `payment_batches`, `leave_types`, `leave_policies`, `leave_balances`, `holidays`, `employee_documents`, `document_access_log` (or reuse audit), `statutory_settings` (per state/company), `employee_statutory_ids` (restricted columns or separate table with encryption), `scoped_grants`.

Alter: `employees.start_date` → `DATE`; retire `salary`, `leave_balance_days`, `shift`, `department` (text) after migration; `attendance_days.attendance_date` → `DATE`; CHECK constraints on enum-like status columns.

All migrations must be mirrored in both repos (shared `alembic_version`), per `employee/AGENTS.md`.

## I. External integrations required

- Payslip PDF generation (library or service).
- Bank disbursement file formats (bank-specific).
- Statutory filing (EPF/ESI portals) — manual upload or API if available; specialist decision.
- Tax tooling for TDS computation/Form 16 — specialist decision.
- Object storage with private access for documents (existing GCS/S3 abstractions).

## J. Compliance requirements requiring specialist validation

Every item must be confirmed by a qualified payroll and labour-compliance specialist before implementation: statutory rates and wage ceilings; applicability thresholds by establishment size; state-specific Professional Tax slabs; TDS regime and declaration rules; gratuity eligibility and formula; overtime rules; full-and-final settlement sequence; record retention periods; data protection obligations for identity documents and bank details.
