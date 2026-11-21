# 11 — Implementation Changelog

Traceability: each entry references the discovery report that motivates it (`01`–`10`). Status values: **Done** (implemented and verified here), **Partial**, **Deferred** (not started, reason given), **Blocked** (needs a decision).

Nothing in this log has been committed, pushed, or deployed. Working-tree state was preserved throughout (see Phase 0 preflight).

---

## Phase 0 — Baseline and design foundation

### 0.1 Preflight (Done)

| Repo | Branch | HEAD | Working tree at start |
|---|---|---|---|
| super-admin | `development-branch` | `274d7eb feat(tasks): collapsible feeds…` | 149 modified tracked, 88 untracked, 13 deleted |
| employee | `development-branch` | `595cbdf release: bump android to 1.0.19…` | 74 modified, 15 untracked |

- CRLF warnings were checked: the modified count is identical with `--ignore-cr-at-eol`, so the changes are real edits, not line-ending noise.
- **Snapshot taken** (non-destructive) at `_phase0_backups/` (outside both repos):
  - `super-admin-tracked-20261119-121102.patch` (binary diff, tracked changes)
  - `super-admin-untracked-20261119-121102.tar` (145 untracked entries)
  - `super-admin-status-…txt`
  - `employee-tracked-…patch`, `employee-untracked-…tar` (15 entries), `employee-status-…txt`
- **Pre-existing deletions (not made in this phase; not restored):** `CLOUD_SQL_*.md` (5), `GOOGLE_CLOUD_*.md` (5), `deploy/cloudrun.md`, `backend/app/api/v1/workspace.py` (superseded by the `workspace/` package), `backend/app/core/queue.py`. **Action for the owner:** confirm these deletions are intended before the next commit.
- Shared-file overlap: `frontend/src/components/navigation/Header.tsx`, `App.tsx`, `index.css` already carried uncommitted work. Edits were made surgically on top of it.
- `frontend/src/context/SessionContext.tsx` is **untracked** (new auth-session layer from earlier uncommitted work). See Risk R1.

### 0.2 Baseline screenshots (Done)

- 14 routes × 4 widths (390 / 768 / 1024 / 1440), authenticated as a super-admin of the Morjim company, against the dev database.
- Output: `_phase0_backups/screenshots/baseline/{390,768,1024,1440}/*.png` plus `report.json` (overflow, `<12px` text count, final URL, h1).
- Script (outside repo): `%TEMP%/shots.mjs` using the existing `@playwright/test` Chromium (`chromium-1255`). No new dependency added.

Measured baseline (selected):

| Route | 390px horizontal overflow | Text < 12px (elements) |
|---|---|---|
| Workforce › Employees | **yes** | 118 (1440: 118) |
| Property › Units | **yes** | 163 |
| Property › Video | **yes** | 34 |
| Operations › Tasks | **yes** | 2 |
| Overview | no | 17 |
| Workforce › Dashboard | no | 26 |

Horizontal overflow by width (from `report.json`, all 14 routes captured at every width):

| Width | Routes with horizontal overflow |
|---|---|
| 390 | Workforce › Employees, Property › Units, Property › Video, Operations › Tasks (4) |
| 768 | Workforce › Employees, Property › Units, Operations › Tasks (3) |
| 1024 | Property › Units (1) |
| 1440 | none |

### 0.3 Design tokens (Done — additive, no visual change)

- `frontend/src/index.css`: added a single `@theme` block containing the approved warm palette (brand, ink, canvas, surface, line, hover, danger, warning, info tokens) and a type scale (`micro` 11px, `meta` 12px, `body` 13px, `body-lg` 14px, `section` 16px, `title` 20px, `kpi` 24px).
- **Collision check:** no existing class uses any proposed token name (grep count 0 for each).
- **Deliberately not overridden:** radius scale (would change 66 `rounded-lg` and other defaults) and font families (`.font-display` already exists).
- **Not migrated yet:** existing hex classes remain. Migration is a separate, mechanical sweep to be done per page in Phases 2–5, so each visual change is reviewable.

### 0.4 Verification (Done)

- `npx tsc --noEmit` — clean.
- `npm run build` — built.
- `npx vitest run` — 11 files, **81/81 tests pass**.

---

## Phase 1 — Application shell (partial)

### 1.1 Breadcrumb trail (Done)

Motivation: `08` §5 and the brief §5 (remove the redundant `Property › Morjim › …` chain).

- `components/navigation/Header.tsx` `Breadcrumbs`:
  - Trail is now computed relative to `/property/:uid`, so it starts at the section: `Workforce › Departments`, `Operations › Tasks`, `Property › Spaces › Units`.
  - The Overview page shows no trail (single crumb hides it).
  - Crumb links were dead (`href="#…"` with `preventDefault`). They now call `navigate()`. Verified: clicking `Workforce` returns to `…/workforce/dashboard`.
  - Removed the unused `propertyName` prop (call site updated).
- Checks: `tsc` clean, build clean, 81/81 tests, and a browser probe for the four trails and the crumb click.

**Still open in Phase 1:** employee and department detail crumbs show the generic label `Detail` (needs a name lookup for departments); header polish, property selector refinement, and tablet/mobile nav work.

---

## Phases not started

| Phase | Status | Reason |
|---|---|---|
| 2 — Overview operational dashboard | **Deferred** | Requires the summary endpoints in `07` §8 (`/overview/summary`, `/overview/trends`) and the composite indexes in `07` §5. Starting the UI before those exist would mean dashboards computed from `AppContext` aggregates, which `07` §7 ranks as a scalability risk. Needs approval of the backend additions (see Decisions). |
| 3 — Workforce | **Deferred** | Depends on Phase 2 summary work; Workforce Overview needs attendance and leave endpoints. |
| 4 — HR foundation | **Blocked** | Compensation, payroll and documents need specialist-reviewed specifications and migrations (`05`, `10` Phase 4–5). Leave foundations need migrations (`leave_types`, `leave_balances`, `holidays`) and a decision on the leave-approval role conflict (R3). Not started, by instruction. |
| 5 — Property and Operations polish | **Deferred** | Mobile overflow fixes are the first candidates; sequenced after the shell is settled. |
| 6 — Insights | **Blocked** | Requires a chart-library decision (DEC-7). No library is installed; no chart was built with mock data. |
| 7 — Verification | **Partial** | Build, type-check and unit tests run. Responsive screenshots taken for baseline only. Permission and property-isolation testing not yet executed for the new surfaces. |

---

## Risks and defects found

| ID | Risk | Evidence | Status / proposed action |
|---|---|---|---|
| **R1** | **Deep links break on cold load.** Opening any authenticated URL directly (e.g. `/admin/settings`, `/property/:uid/operations/tasks`) redirects to `/admin/properties` or the home page instead of the requested route. | Observed: a direct `goto` to `/admin/settings` ends on `/admin/properties`. The API calls succeed (`/auth/me` 200, `/workspace` 200). Cause: `SessionContext.tsx` sets `isAuthenticated = !!currentUser` and `currentRole` defaults to `'super_admin'`, and `currentUser` is populated only after `/auth/me` returns. `RequireAuth` / `RequireRole` therefore evaluate before the session restores. There is no "restoring" state. | **Not fixed (needs approval).** Proposed fix: add `isSessionRestoring` to `SessionContext`, and have `RequireAuth` / `RequireRole` render a loading state while it is true. No change to authentication semantics or permissions. Affects the untracked `SessionContext.tsx`. Baseline screenshots were captured by client-side navigation to work around this. |
| R2 | Resource-state drift: 16 rooms and 15 dorms show `cleaning` with no open cleaning task for most. | `03` §4.7. Verified read-only. | Not reconciled (per brief). Overview hides or labels the cleaning metric as unverified. |
| R3 | Leave approval conflict: SA backend allows SA+PM; employee backend allows SA only. | `04` §1.10, `05` §D. Verified in code. | **Not changed** (explicit policy decision required). |
| R4 | 125 stale pending submission rows (on abandoned/completed tasks). | `03` §4.5. Verified. | Not counted as pending reviews; not deleted. |
| R5 | 513 Super Admin accounts across 12 companies. | `03` §4.11. Verified. | Not displayed as a metric; account audit recommended (owner action). |
| R6 | 23,817 refresh-token rows, no purge job found. | `03` §4.13. | Not changed. Needs a retention decision (DEC-8). |
| R7 | Local media services (go2rtc, MediaMTX) are not running; VA camera warm-start warnings appear in the dev log. | `devstack.log`. | Environmental; unrelated to this redesign. |
| R8 | 13 pre-existing deletions in super-admin (see 0.1). | `git status`. | Owner to confirm intent before commit. |

---

## Decisions required (blocking the next phases)

1. **Approve R1 fix** (`SessionContext` restore state + route guards wait). Small, but touches the session layer.
2. **Approve the summary/index backend additions** from `07` §5 and §8 (read-only endpoints and indexes; migrations mirrored in both repos).
3. **Chart library (DEC-7):** add one dependency (e.g. a React chart library, with bundle-size impact), or keep hand-built SVG/CSS.
4. **Operations item count (DEC-5):** five items with Reviews as a badge (recommended), or six.
5. **HR visibility (DEC-4):** Super Admin only for the first release (recommended), or a scoped grant model.

---

## Files changed in this phase

| File | Change |
|---|---|
| `frontend/src/index.css` | Added `@theme` design tokens (additive) |
| `frontend/src/components/navigation/Header.tsx` | Breadcrumb trail relative to property; working crumb links; removed unused prop |
| `docs/super-admin-redesign-discovery/11-IMPLEMENTATION_CHANGELOG.md` | This file (new) |

Outside the repositories: `_phase0_backups/` (patches, tarballs, status files, screenshots).

No backend, schema, migration, API, or permission file was modified.

---

## Dashboard (formerly Overview) — property intelligence build

Route `/property/:uid/overview` is retained (no broken URLs); the user-facing label is now **Dashboard** (header, breadcrumbs, page title).

**Backend (new):** `GET /api/v1/properties/{id}/dashboard?period=&from=&to=&granularity=` — one bounded read-only aggregate, `Staff` dependency, `Cache-Control: private, no-store`. Service: `app/services/dashboard.py`; route: `app/api/v1/workspace/dashboard.py`. No migrations, no schema changes.

**Frontend (new):** `api/dashboard.ts`, `components/dashboard/{DashboardView,charts,period}.tsx|ts`. Hand-built SVG charts (no new dependency). Replaced `components/overview/OverviewView.tsx` (removed). Units page now accepts `?status=` for drill-downs.

**Definitions** (traceable to source fields):
- Occupancy: open `occupancies` rows (`checked_out_at IS NULL`); room state is secondary.
- Cleaning verified vs unverified: rooms/dorms in `cleaning` state with/without an open cleaning-type task. Nothing reconciled.
- Abandoned split: `SYSTEM_DAILY_ROLLOVER`, `NEXT_SCHEDULED_OCCURRENCE`, `MIDNIGHT_EXPIRY`, `FRESH_DAY_RESET` = expiry by design; any other reason = other.
- Completion rate: completed ÷ (created in period − expiry-abandoned created in period).
- Business days: operational day from company `operational_day_start` (06:00 IST).
- Median durations: capped samples of 2,000 rows.

**Verification:**
- Backend: `tests/test_dashboard.py` 27 pass; full suite 333 pass.
- Reconciliation: busiest property, 9 metrics compared against independent SQL — all match.
- Frontend: tsc clean, production build clean, vitest 89/89 (incl. 8 new period tests).
- Browser: 1440/1024/768/390 — no horizontal overflow; period switch and Vacant drill-down verified; PM isolation (own property 200, other 404).

**Deferred / limitations:**
- Previous-period comparison not implemented (`compares_previous: false`).
- Attendance trend shows insufficient-data state (11 records); late arrivals not computable (no shifts).
- Occupancy history begins 1 Oct; trend flagged limited.
- Cleaning figures shown as unverified until the state drift is reconciled (separate approved plan).
- Realtime token endpoint returns 503 locally (optional Centrifugo not configured) — unrelated.
- "Dashboard" also names the Workforce sub-tab; labels should be disambiguated in a later pass.

### Dashboard request fix (StrictMode duplicate requests)
- Cause: the Dashboard load effect ran twice under React StrictMode in development, and the superseded request was ignored but not aborted. Each filter change therefore held two database connections on a 5-connection pool.
- Fix: `getPropertyDashboard` accepts an `AbortSignal`; `DashboardView` aborts the superseded request in the effect cleanup.
- Verified in browser: one dashboard request per filter change; the superseded request is aborted; no page errors.
- Solo backend latency for the busiest property: 0.8–1.5 s. The 12–20 s seen in the console came from contention with the page's other workspace requests.
- Not reproduced: `POST /auth/login` 503 (likely the dev launcher restarting during a reload). Realtime `GET /realtime/token` 503 is expected, because Centrifugo is not configured locally.

### Dashboard analytics rebuild (occupancy-first, KPI cards removed)
- KPI tiles removed from the Dashboard. Sections now: occupancy trend (primary), occupancy breakdown, zone and room-type occupancy, property condition and maintenance (with ticket table), workforce and attendance, operational performance, activity and data quality.
- Periods: today, yesterday, last 7/30/90 days, this month, last month, last 6 months, custom (max 366 days). Hourly series for today and yesterday; daily, weekly or monthly otherwise. Longer ranges default to weekly.
- Trend source: occupancy ledger only (open or closed stays). Days before the first recorded stay are marked "no record", never zero.
- First-record date now comes from the whole property ledger, so a short window is not mistaken for missing history.
- Attendance: per-day series; expected = active headcount minus approved leave that day; days without records have no percentage.
- Cleaning metrics come from cleaning-type tasks only. Resource state is not used as evidence.
- Maintenance ticket table: unit, zone, issue, status, created, duration.
- Verified: backend suite 363 passed; trend reconciled against SQL for 30 days (0 mismatches); tsc clean; vitest 89/89; production build passes; no horizontal overflow at 390, 768, 1024 or 1440 px.
- Known gaps: no previous-period comparison; zone and room-type clicks open the Zones or Units page unfiltered, not a filtered room list; maintenance table rows are not clickable; trend denominator is current room inventory (no historical inventory is recorded).

## Product-wide redesign — Phases 1–3 (2026, local only)

**Phase 1 — design system.** Canonical AiROS palette applied across ~140 SA files (background `#F7F8FA`, ink `#20292C`, brand `#33B059`/`#218A42`, semantic danger/warn/info + softs). Manrope (interface/headings) + Inter (numbers). `recharts` added as the chart dependency. Legacy heading green `#176B33` and secondary `#454E53` swept to ink/secondary everywhere.

**Phase 2 — application shell.** New `components/navigation/Sidebar.tsx` (grouped IA: Workspace / Operations / People / Insights, role-gated, collapsible with persisted state, property switcher near top), `CommandMenu.tsx` (search/command surface), slim `Header.tsx` (breadcrumbs, search trigger, IST clock, notifications, user menu). `App.tsx` rewired: authenticated routes render inside the shell; landing/auth pages stay full-width. All existing routes and legacy redirects preserved.

**Phase 3 — dashboards.**
- `dashboard/charts.tsx` rebuilt on Recharts (AreaChart trends with null-gap handling, BarChart columns, PieChart donut; DOM StackBar/HBarList retained as compact non-chart primitives). Shared tooltip shells; every chart carries an accessible `role="img"` label.
- `DashboardView.tsx` restructured to the spec's six questions: (1) occupancy trend primary with current % inline, (2) space distribution with rooms/beds/dorms segmented control + units links, (3) new "Attention required" exception list (overdue work, critical tickets itemised, unassigned work, pending reviews, unverified cleaning states, attendance exceptions; positive empty state), (4) workforce performance (duty-status distribution + attendance trend + departments), (5) operational performance behind a tabbed metric selector (Tasks / Maintenance / Reviews / Cleaning) + department performance table, (6) recent activity + data quality. All real API fields; no fabricated metrics.
- `employees/management/EmployeeDashboard.tsx` (route `/workforce/dashboard`) rebuilt: duty-status distribution, 30-day attendance trend, staff-by-department, tasks-completed-by-department, open-workload — each with drill-down. Data: `getPropertyDashboard` + `departmentOverview`, one request each.
- `insights/InsightsView.tsx` rebuilt as grouped index (Occupancy / Workforce / Tasks / Maintenance / Attendance / Audit & activity), SA-only audit gated.
- Stragglers: `#176B33`/`#454E53` swept repo-wide (33 files).

**Employee app (Phase 5 start).** `employee/frontend` tokens remapped to the canonical palette in place (`index.css` `--color-*` kept; 615 inline hexes normalised); Space Grotesk → Manrope in `index.html` + all `font-['Space_Grotesk']` class references; body font-family set. No structural screen changes yet.

**Verification.** SA: `tsc --noEmit` clean, `vite build` clean, vitest 12 files / 92 tests pass. Employee: `tsc --noEmit` clean, `vite build` clean (chunk-size warnings only). Nothing staged, committed, pushed or deployed.

## Brand colour direction — burgundy/charcoal rebrand (local only)

Green is no longer the brand colour. Canonical palette now: burgundy `#800020` (primary action/brand), charcoal `#303841` (ink), warm neutrals (`#F7F5F4` canvas, `#E9E4E3` line, `#6D686B` secondary, `#9A9193` muted), supporting accents (dusty rose `#B34A68`, mauve `#C18B9B`, gold `#D6A354`, steel `#426B83`, slate `#687C91`, violet `#8B6B9A`), semantic set — success `#367A61`, warning `#D6A354`, danger `#B83245`, info `#426B83`, pending `#8B6B9A`.

- Central tokens updated in both apps (`super-admin/frontend/src/index.css` `@theme` block gains `--color-accent-*`, `--color-success*`, `--color-pending*`; `employee/frontend/src/index.css` token values remapped in place — `--color-acc` is the brand alias there).
- ~4,200 inline hexes remapped across both `src/` trees. Green literals were context-aware: lines carrying success semantics (completed/approved/occupied/present/resolved/…) → success `#367A61`; everything else → burgundy `#800020`. Zero old-green hexes remain.
- Charts: `CHART` palette moved to burgundy primary trend + `accents` array (burgundy/rose/gold/steel/violet/slate/mauve) for multi-series; occupied/on-duty/completed parts use `CHART.success` so positive status is never confused with brand.
- Fixes after sweep: `Badge` `sage` variant → success softs; success toast icon/border → success; `analysis/kit.tsx` `successBg`; `MaintenanceView` resolved chip; STATE_STYLE `available` → success tokens.
- Verified: SA `tsc` clean, vitest 92/92, build clean; employee `tsc` clean, build clean. Nothing staged/pushed/deployed.

## Rich dark semantic colour system (local only)

Pastel semantic accents replaced by dark, saturated operational colours. Surfaces stay light — the saturated colour carries status on text, icons, dots, borders and chart series; tinted backgrounds are supporting only.

- Canonical semantic set (tokens in both apps' index.css): available/completed `#245B45`, occupied/critical `#8A2635`, cleaning/in-progress `#A34B13`, assigned/info `#244C78`, pending/review `#69418A`, maintenance/warning `#76521D`, unavailable/inactive `#46515E`, scheduled `#14616B`. Brand remains `#800020`; charcoal `#303841`; accents gain midnight `#172554` and deep violet `#4C1D5F`.
- Each semantic token ships `*-ink`/`*-soft`/`*-line` variants so chips, badges and borders share one source.
- ~950 old semantic hexes remapped across both repos. `Badge.tsx` central `UNIT_VISUAL_TINT/DOT/TEXT` resolver updated — Zones, Rooms/Dorms (per-bed grids), Washrooms (per-fixture) all inherit: available→forest, occupied→crimson, cleaning→burnt orange, maintenance→dark amber, inactive→steel slate; selection ring stays burgundy `#800020`. Server-derived `visual_state` logic untouched.
- Employee app `RESOURCE_STATE_STYLES` (UnitTile) updated to the same mapping; stale violet/gold literals removed.
- `CHART` palette: burgundy primary + semantic series + accent array (midnight/violet/rose/steel/teal/slate); no library defaults.
- Verified: SA tsc clean, vitest 92/92, build clean; employee tsc clean, build clean. Nothing staged/pushed/deployed.

## 2026-11-24 — Burgundy / Midnight Navy / Vibrant Orange identity

- Token layer (`frontend/src/index.css` + employee `src/index.css`): brand `#800020`, ink → navy `#0D1C42`, canvas `#FFFCFA` warm white, accent `#FF9137` orange; semantic set per spec — success `#16865B`, warning `#E99A23`, danger `#D64545`, info `#3478D4`, pending/in-progress `#7554C8`, neutral `#7A8495` (each with ink/soft/line variants). New light-tint tokens: burgundy `#F7E9EE`, navy `#E9EDF5`, orange `#FFF1E4`.
- ~3,700 inline hexes remapped repo-wide (charcoal → navy, old semantic set → new, green accents → burgundy). User-mandated resource-state colors preserved: available `#1E3B2F`, occupied `#1B365D`, cleaning `#FBF5DD`, maintenance `#790D16`, washroom `#3C3D37`.
- Typography: Satoshi (Fontshare) as primary face in both apps; Inter retained for tabular numerics.
- Shared components: `Button` primary = burgundy → navy hover; `Badge` gains `info` variant (`#3478D4`); sidebar active = burgundy ink on `#F7E9EE` tint; tab bar selected = solid burgundy.
- Tasks page: KPI chips now per-status tinted with icons (planned navy / generated burgundy / pending orange / assigned info / in-progress violet / completed green / abandoned red / overdue deep `#790D16`); group sections get colored left accent + tinted count badges; table header tinted, rows get hover treatment; WORK_BADGE remap (assigned→info, in-progress→lavender).
- Verified: SA tsc clean, 92/92 tests, vite build clean; employee tsc clean. Local only — nothing staged/committed/pushed.

## 2026-11-24 — Sections layer (Property → Section → Area → Zone)

- New `sections` table + `areas.section_id` (FK, SET NULL) — migration `z6f1c8a4d2e5`, mirrored into the employee repo's chain per the shared-DB convention; applied to dev DB (head confirmed).
- Backend: `Section` model, `SectionCreate/UpdateRequest` + `section_uid` on area payloads, `section_out`/`area_out`, `StructureService.create/update/delete_section` (delete detaches areas, never cascades), POST/PATCH/DELETE `/sections`, GET `/sections`, `list_sections` repo — all company/property-scoped via existing `_company_scope`.
- Employee repo: mirrored migration + `Area.section_id` mapped read-only for schema parity.
- Frontend: `sectionsApi` + `Section` type, `AppContext.currentPropertySections` + CRUD; Zones page reworked — filter chips and Group-By toggle removed; Property bar with zone switcher (dropdown opens any zone's workspace); sections render as top-level groups containing their areas; "Add Section" + CreateSectionModal; section picker on create/edit area; edit/delete section with ungroup-not-delete semantics.
