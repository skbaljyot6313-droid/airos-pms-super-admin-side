# 10 — Implementation Requirements

This is the plan a separate implementation phase should follow. It is intentionally phased so each step is buildable and reversible. Nothing here has been implemented.

## 0. Preconditions and decisions (block the plan)

| # | Decision | Options | Blocks |
|---|---|---|---|
| DEC-1 | Palette: one system or two? | (a) converge analysis onto warm tokens; (b) keep cool analysis theme; (c) document as data palette | Phase 1 tokens |
| DEC-2 | Canonical shell background | `#FAF8F5` or `#F7F4EE` | Phase 1 |
| DEC-3 | Leave approval role | SA only (EB) · SA + PM (SA backend today) · SA + HR | Phase 4 HR, D-6 |
| DEC-4 | HR visibility | SA only first · scoped grants (recommended) · HR role flag | Phase 4 |
| DEC-5 | Operations item count | 5 items (Reviews as badge) · 6 items | Phase 2 IA |
| DEC-6 | Scheduling as separate item now or later | Now · after shifts are used | Phase 2 IA |
| DEC-7 | Chart library | none (hand-built SVG/CSS) · add a library (decision + bundle impact) | Phase 3 analytics |
| DEC-8 | Data-retention windows | refresh tokens, resource events, task events, location sessions | D-3, storage planning |
| DEC-9 | Statutory scope and specialist | which statutes, which states, who signs off | Phase 5 payroll |

## Phase 0 — Visual and data baseline (no code change)

Goal: convert this discovery's code-inferred UX findings into verified observations.

- Run the app locally against a **copy** of the dev database (or existing dev DB, read-only browsing) and capture screenshots at 1440, 1024, 768 and 390 px for every route in `docs/super-admin-audit/02-ROUTE_INVENTORY.md`.
- Record: text sizes measured in DOM (computed `font-size` distribution), content width utilisation, empty/loading/error states (force API errors), keyboard path through primary nav.
- Acceptance: a screenshot set and a measured type-size table exist under `docs/super-admin-redesign-discovery/` (new files; do not overwrite these 10).
- Also run the existing read-only reconciliation (`GET /properties/{id}/reconciliation`) for P1 and record drift counts.

## Phase 1 — Design foundation (frontend only)

Scope:
1. Add a Tailwind `@theme` block in `index.css` with the tokens in `02` §10; keep existing hex values so visual output is unchanged.
2. Decide DEC-1 and DEC-2; map analysis `C` tokens to the chosen tokens.
3. Define the type scale (11 / 12 / 13 / 14 / 16 / 20 / 24) and replace ≤ 10px usages with 11px minimum (uppercase labels only).
4. Remove the unused Inter font import (or adopt it, per DEC-1).
5. Create shared primitives: `Input`, `Select`, `Textarea`, `Field`, `DataTable` (sortable, filterable, sticky header, empty state), `StatTile`, `SectionHeader`, `FilterBar`, `EmptyState`, `ErrorState`, `StatusChip` (replacing status mapping inside `Badge`).
6. Consolidate radius to 6 / 8 / 12 / full and elevation to two levels.

Acceptance:
- `tsc --noEmit` clean; `vitest` passes (81 existing tests, updated where class assertions change); `vite build` clean.
- No visual regression on untouched pages (screenshot diff against Phase 0 baseline; accept intentional diffs only).
- Hex colour count in `src/**/*.tsx` reduced (measured) without visual change.

Dependencies: none. Risk: low–medium (many files touched by class changes; mechanical).

## Phase 2 — Information architecture and shell

Scope:
1. Implement the proposed tree in `08` (DEC-5, DEC-6 decided).
2. Add routes in `08` §6; keep `LegacyRedirect` for every old path; `/admin/logs` redirects to Insights › Activity & Audit.
3. Split Employees tabs across Workforce items; split Tasks tabs across Operations items; split Units into Property › Spaces / Occupancy / Resources.
4. Add contextual counts to secondary nav (e.g. pending reviews) only from summary endpoints (Phase 3).
5. Breadcrumb: resolve employee and department names via a lightweight lookup (fix "Detail" label).
6. Preserve every existing feature: check against `docs/super-admin-redesign-discovery`'s baseline and `docs/super-admin-audit/12-FEATURE-MIGRATION-CHECKLIST.md`.

Acceptance:
- Every route in the new map renders; every legacy route redirects with query params preserved (automated test per redirect).
- Feature checklist: each audited feature ID has a verified location.
- PM cannot reach SA-only routes (existing `RequireRole` tests extended).
- Keyboard navigation works across primary and secondary navs.

Dependencies: Phase 1 primitives. Risk: medium (routing and deep links).

## Phase 3 — Data foundations (backend, read-only features first)

Order matters: fix correctness before building analytics.

3.1 **Correctness (P0)**
- D-1 resource-state reconciliation: investigate `services/resource_state.py` derive rule vs. task lifecycle for abandoned tasks; propose fix with tests; run repair through existing API with audit. **Do not run repair blindly.**
- D-2 stale submissions: decide cleanup rule (mark `superseded`/`stale`) — requires a migration or a status addition; mirror in EB.
- D-3 refresh-token purge: scheduled job deleting `expires_at < now() - 7d` (decision on window). Verify EB behaviour.
- D-5 Super Admin account audit (read-only report first; deactivation by a human).

3.2 **Schema hygiene (shared DB — migrations mirrored in both repos)**
- Composite indexes from `07` §5 (created `CONCURRENTLY` where supported; verify Alembic env allows it).
- Date columns to `DATE` for `attendance_days.attendance_date`, `attendance_requests.from_date/to_date`, `employees.start_date`, `tasks.operational_date` — backfill with validation; block on any unparseable value.
- CHECK constraints for status columns after cleaning (list in `03` §3).
- `properties(company_id, code)` unique.
- Audit entity-type normalisation (data migration + writer fix).

3.3 **Aggregate endpoints (read-only)**
- `GET /overview/summary`, `GET /overview/trends`, `GET /operations/summary`, `GET /operations/completion-trend`, `GET /workforce/summary`, `GET /property/units/state-summary`.
- Each returns a typed payload, enforces property scope and role, and uses IST date boundaries.
- Performance acceptance: p95 < 300 ms on the largest property in staging with 6 months of synthetic data (to be generated, not invented in production).

3.4 **Payload reduction**
- Reduce `/workspace` to shell collections; move tasks and employees to paged endpoints; update `AppContext` consumers.
- Acceptance: `/workspace` payload size independent of task count (measured).

Dependencies: Phase 2 routes for display. Risk: high for D-1 and date migrations (shared DB).

## Phase 4 — Workforce and HR foundations

4.1 Workforce (no new data model)
- Workforce Dashboard as table + bars; Attendance & Leave page assembling existing leave and attendance; Analytics page with team and department views; Scheduling page for shifts.
- Resolve DEC-3 first. Align both backends' approval rule and add a test that both enforce the same policy.

4.2 HR foundation (new data)
- Migrations: `leave_types`, `leave_policies`, `leave_balances`, `holidays`; `compensation_components`, `employee_compensation`, `compensation_revisions`; `scoped_grants` (if DEC-4 = scoped).
- Backfill `leave_type` values from `attendance_requests` into `leave_types` mapping.
- Server-side field-level redaction: compensation fields excluded from every non-HR response schema (tests assert absence).
- Secure documents (F-10): private bucket, signed URLs, access logging, MIME validation reusing EB pattern; no use of public `/media/file/{key}`.

Acceptance:
- Unauthorised role receives 403 on every HR endpoint (tests for each role in `08` matrix).
- No compensation field appears in any Workforce or Employee list response (snapshot tests).
- Document download requires authorisation and produces an audit event.

Dependencies: DEC-3, DEC-4, Phase 3.2 (dates). Risk: high (security).

## Phase 5 — Payroll (only after Phase 4 and specialist sign-off)

- Specialist validates statutory rules (DEC-9) and produces a rules specification with effective dates.
- Build calculation as a pure domain module with unit tests against specialist-provided worked examples.
- Payroll runs: draft → review → approved → locked; approver ≠ preparer; locked runs immutable.
- Payslips: PDF generation (new dependency decision), stored as private documents.
- Disbursement: export file per bank format (external specification required).

Acceptance: specialist sign-off document; reproducible calculations for agreed test cases; locking enforced at DB level (trigger or status check).

Risk: very high (financial and legal). Do not start before sign-off.

## Phase 6 — Analytics and Insights

- Build charts per `06` status: READY items first (O1, O2, O6, O7, T3–T9, P4, P8, I7).
- PARTIAL items after their prerequisites in `06` (data prerequisites list).
- BLOCKED items remain hidden or show an explicit "insufficient data" state with the reason (not an empty chart).
- Insights destinations replace the link directory.

Acceptance: every chart has documented formula, data window and a data-coverage indicator; no chart rendered from `AppContext` aggregates for more than the current day's data.

## Phase 7 — Responsive and accessibility polish

- Tablet: compact horizontal nav; overflow menu for secondary items; no wrapped nav rows.
- Mobile: drawer with grouped destinations; tables become stacked cards below `md`.
- Accessibility: keyboard paths, focus rings consistent (`#3E6B48/30` vs `#365D78/25` must be unified per DEC-1), colour is never sole signal, reduced-motion respected.
- Acceptance: manual test at 390 / 768 / 1024 / 1440 px; axe automated scan with zero serious violations on primary destinations (tool choice requires dependency decision).

## Testing plan (cross-phase)

| Layer | Tooling (existing) | Required additions |
|---|---|---|
| Backend unit/integration | `pytest` (317 tests existing in SA) | Permission tests per endpoint; redaction tests; aggregate correctness vs. SQL reference; reconciliation tests |
| Frontend unit | `vitest` (81 existing) | Redirect tests; DataTable and FilterBar tests; chart data-coverage states |
| E2E | Playwright (`test:e2e`, existing) | Route map walk; PM scope; HR visibility; document download |
| Data | read-only SQL reconciliation | Dashboard totals vs. SQL (reconcile to the row) |

## Migration and deployment notes (for the implementation phase)

- Repositories stay separate. Schema changes are mirrored in `super-admin/backend/alembic/versions` and `employee/backend/alembic/versions` with identical revision IDs and a single linear chain per `AGENTS.md`.
- Boot refuses to start on `alembic_version` mismatch — deploy the migration to the shared DB exactly once, in an order that keeps both services compatible (expand → migrate → contract).
- Date-type migrations are **expand/contract**: add new `DATE` columns, backfill, dual-write, switch reads, then drop text columns in a later release.
- No deployment or commit is part of this discovery. Use the existing Cloud Run / dev process when the implementation phase is authorised.

## Acceptance criteria (program level)

1. Five primary destinations and Administration preserved; no feature lost (checklist complete).
2. One design token source; no new hex colours introduced outside tokens.
3. Type scale minimum 11px; body text ≥ 13px (measured).
4. Dashboards use server summaries; `/workspace` payload does not grow with task history.
5. Drift and stale rows resolved or explicitly labelled.
6. HR data is restricted server-side and tested per role.
7. Payroll is not built before specialist sign-off.
8. All shared-schema changes are mirrored and verified in both repositories.

## Explicit exclusions

- Changing role permissions without DEC-3/DEC-4 sign-off.
- Using public media endpoints for any HR document.
- Exposing salary, bank, PAN, UAN, ESI or identity data in any list, export, log or analytics payload.
- Presenting unverified user counts (513 SA accounts) or stale states as fact.
