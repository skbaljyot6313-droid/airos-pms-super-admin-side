# 01 — Current UI/UX Audit (page by page)

Scope: every Super Admin destination — Overview, Workforce, Property, Operations, Insights, Administration, plus Profile and public pages.

## Method and limits (read first)

- This assessment is **code-inferred**: layout, component use, class-level typography, and state handling were read from `frontend/src`. The app was **not visually rendered or screenshot** during this discovery, so statements about "cramped", "whitespace", or "hierarchy" are judgements from the class structure and must be confirmed in a visual pass (see `10-IMPLEMENTATION_REQUIREMENTS.md`, Phase 0).
- Source of truth for routes and features: `docs/super-admin-audit/02-ROUTE_INVENTORY.md`, `03-FEATURE_INVENTORY.md`, `11-DETAILED_FEATURE_REFERENCE.md`.
- Live data observations come from `03-DATABASE_SCHEMA_AND_DATA_AUDIT.md` (anonymised).

## Shell-level findings (apply to every page)

| # | Finding | Evidence |
|---|---|---|
| S1 | Main content is capped at 1600px but many views self-limit narrower: `max-w-[1320px]` (13 uses), `max-w-[720px]` (5), `max-w-2xl/lg/md` (~16). Wide tables and dashboards therefore leave side gutters. | grep over `src/**/*.tsx` |
| S2 | Typography is small. ≤11px sizes (`text-[11px]` 284, `text-[10px]` 155, `text-[9px]` 35, `text-[9.5px]` 10, `text-[10.5px]` 21) total **~505 usages**, versus **482** uses of `text-xs` (12px) and **256** of `text-sm` (14px). Body copy is frequently 12–13px. | grep counts |
| S3 | Two shell backgrounds: `body` is `#FAF8F5` (`index.css`) while `AppContent` wraps pages in `#F7F4EE` (`App.tsx`). | `index.css` L8; `App.tsx` AppContent |
| S4 | Header is compact (h-14 after rewrite) with horizontal primary nav and contextual secondary nav. Good density; secondary nav is text-only with no counts or badges (e.g. pending reviews count is not shown in the Operations sub-nav). | `components/navigation/Header.tsx` |
| S5 | Breadcrumbs derive from URL segments. Employee/department segments show the generic label **"Detail"** because only the employee roster is in context; department names are not resolved in breadcrumbs. | `Header.tsx` `Breadcrumbs` |
| S6 | Two design languages co-exist: warm earth tokens (shell and most pages) and a cool slate palette in `employees/analysis/kit.tsx` (`C` tokens) used by employee analysis and team analytics. See `02-DESIGN_SYSTEM_AUDIT.md`. | `kit.tsx` L5-10; `docs/aesthetics.md` §1.2 |
| S7 | Mobile: primary nav collapses into a hamburger drawer; secondary nav is hidden below `md`. Property selector is hidden on small screens only in part (truncation at 190px). | `Header.tsx` |
| S8 | Loading/error: `WorkspaceGate` renders skeletons and a retryable error card for every property view. Empty states are inconsistent across pages (analysis `Empty` primitive vs bespoke empty text). | `App.tsx` WorkspaceGate |

---

## 1. Overview — `/property/:uid/overview` (`components/overview/OverviewView.tsx`)

- **Layout**: page title, 6 metric tiles (2/3/6-column grid), two panels (departments list, operational status list), quick links.
- **Components**: local `MetricCard`; `Skeleton`; context collections; `departmentOverview()`, `taskReviewQueue()`.
- **Data shown**: active/inactive/unallocated workforce; open and completed tasks; pending reviews; open maintenance tickets; unit count; zone count; department list (top 6); rooms occupied; units in maintenance/cleaning.
- **Data available not shown**: task completion trend (`completed_at` exists), occupancy trend (`occupancies`), maintenance response time, operational exceptions (overdue/abandoned spikes), notifications feed, resource drift flags.
- **Interactions**: each tile navigates to its destination; department rows open detail.
- **UX problems**: no time dimension (everything is "now" snapshot); "Units in cleaning" counts (16 rooms, 15 dorms in cleaning state) are **resource-state values that have drifted** — only 1 room has an open cleaning task (see `03`). The tile would present stale state as fact. No exceptions panel.
- **Navigation problems**: Overview is a snapshot hub with no secondary nav of its own.
- **Redundant**: "Zones" tile duplicates the zones page count; department list duplicates Workforce → Departments.
- **Visualisation opportunities**: task completion trend (14-day), workforce composition bar, department headcount bars, occupancy strip. See `06`.
- **Suggested layout**: 3-band layout — (1) KPI strip with deltas vs prior period, (2) two-column "Today" (tasks due/overdue, staffing gaps, reviews) and "Trends" (completion 14d, occupancy 14d), (3) exceptions list + recent activity timeline.
- **States**: loading skeleton on departments and reviews; errors swallowed (`.catch(() => {})`) — the tile silently shows the skeleton forever on failure. **Defect to fix in redesign.**

## 2. Workforce → Dashboard — `/workforce/dashboard` (`components/employees/management/EmployeeDashboard.tsx`)

- **Layout**: 7 metric cards, department cards with head, active/inactive split, CSS distribution bars, "Default" badge for system departments.
- **Data shown**: total/active/inactive employees; total departments; unassigned employees; departments without head; average employees per department; per-department counts. Source: `GET /departments/overview` (single aggregate).
- **Data available not shown**: department creation dates (`created_at` exists), transfers last 30 days (`department_transfers`), attendance by department (no data), leave by department.
- **UX problems**: 7 cards of equal weight (no hierarchy); department cards are oversized relative to content; the "distribution" is CSS bars without axis or totals.
- **Redundancy**: overlaps with Overview's department list and Workforce → Departments table.
- **Suggested layout**: one KPI row of 4 (headcount, active %, unassigned, departments w/o head), then a dense department table with inline bars for headcount and an active/inactive stacked bar. Replace cards with a sortable table.

## 3. Workforce → Employees — `/workforce/employees` (`EmployeesView.tsx`, tabs via `?tab=`)

Eight tabs in a single strip; each tab is a separate component:

| Tab | Component | Layout/UX notes |
|---|---|---|
| Zone Board (`board`) | `ZoneBoard.tsx` (`@dnd-kit`) | Drag employees onto zones/areas. Strong interaction; no keyboard alternative is documented; coverage model is complex (primary/secondary zone, area, property-wide). |
| Directory (`directory`) | `EmployeeDirectory.tsx`, `CreateEmployeeModal.tsx` | Search, department/zone/status filters, edit modal. Department dropdown is live (`/departments`) with static fallback. Columns are dense; no bulk actions. |
| Deactivated (`deactivated`) | inline | List of inactive staff with reactivate. Thin. |
| Live Location (`live`) | `LiveLocationMap.tsx` (Leaflet + markercluster, 10 s poll) | Map-first. Shows only clocked-in staff (server filter). Good but isolated from the list. |
| Leaves (`leaves`) | `LeavesPanel.tsx` | Approve/reject list. Only 11 requests exist; leave types are free text (see `03`). |
| Shifts (`shifts`) | `ShiftManager.tsx` | CRUD + assign. **Zero shifts exist** — empty state is the only real experience. |
| Attendance (`attendance`) | `AttendanceBoard.tsx` | Status board (working/on_break/absent/…). Data is near-empty (11 day rows). |
| Analytics (`analytics`) | `analysis/TeamAnalytics.tsx` + `PeriodSelector` | Cool slate palette; period selector; the most visually developed screen in the module. |

- **Cross-cutting UX problems**: eight tabs in one strip is too many for a single nav group (see `08`); tabs mix list, map, board and analytics; "Create employee" sits in the header of all tabs.
- **Missing**: onboarding checklist, bulk actions, export, column customisation, employee status history view.

## 4. Employee detail — `/workforce/employees/:uid` (`EmployeeDetailView.tsx`)

- **Layout**: header (name, title, status), tab row, 22px H1, Overview with profile fields and allocation summary.
- **Tabs**: Overview (`analysis/OverviewTab.tsx` — KPI grid, activity chart, quality, breakdown, insights); Allocations (`analytics/AllocationTimeline.tsx`, lifecycle stepper); Maintenance, Attendance, Device (code retained, **tabs hidden by user request** per `aesthetics.md`); Records (`RecordsSection`); Locations (`LocationsTab.tsx` zone→area→unit).
- **Data available not shown**: shift assignment history (none), leave balance (null for all 39 staff), device registrations (10 rows exist in shared DB, tab hidden), recorded salary text (`employee.salary` shows as "Recorded salary" when set — always empty in data).
- **UX problems**: hidden tabs leave dead code paths; "Recorded salary" as a free-text field on a staff profile is a **sensitive-data risk** in the redesign (see `05`).
- **Redesign**: move sensitive fields behind a permissioned "Compensation" section; keep the allocation timeline (strongest existing visual).

## 5. Workforce → Departments — `/workforce/departments` (`DepartmentsView.tsx`) and detail (`DepartmentDetailView.tsx`)

- **Layout**: sortable table (name, head, staff count, status), show-inactive filter, per-row edit/transfer/delete (delete disabled with tooltip when members exist), create/edit modal (`DepartmentFormModal.tsx`), transfer modal (`TransferModal.tsx`, single/bulk, head clear/replace decision).
- **Detail**: info cards, head card, roster table (head badge, links to employees), department-scoped transfer history.
- **UX problems**: transfer modal is a multi-decision form with no step indicator; detail page has no activity chart and no staffing vs. shift coverage; "Default" badge is the only signal that a department is protected (rule is not explained inline).
- **Data reality**: 8 system departments provisioned for 2 of 10 properties; each has 1 or 0 staff except one head assignment; transfer history has 2 rows. The screen will look empty in most properties.

## 6. Property → Spaces: Zones & Areas — `/property/spaces/zones` (`ZonesView.tsx`, `ZoneWorkspace.tsx`)

- **Layout**: zone board grouped by area; drill-in workspace per zone; create zone/area modals (`CreateZoneModal.tsx`, `CreateAreaModal.tsx`).
- **Data**: 27 zones (all `stay`, all active), 12 areas.
- **Data not shown**: zone coverage (staff covering), zone-level task backlog, zone occupancy.
- **Navigation**: `ZoneWorkspace` links to Tasks, Units, Workforce (updated in the nav refactor) — good cross-links.
- **Redesign opportunity**: zone × status heatmap (rooms/beds by state).

## 7. Property → Spaces: Units — `/property/spaces/units` (`RoomsDormsView.tsx`, 4 tabs via `?tab=`)

- **Tabs**: Rooms (88 rooms), Dorms (20), Washrooms (16 + 63 fixtures), Zones board (`UnitZoneBoard`).
- **Layout**: filter bar (zone, status), grid/cards, bulk create modals (rooms, dorms, washrooms), edit modals, occupancy toggle, guest switch, washroom detail with fixtures, washroom maintenance scheduling.
- **Strength**: the richest operational UI in the product; status chips are clear.
- **UX problems**: no status summary at the top (count per state is only implicit); 9 modals for CRUD + bulk, no unified "bulk create" pattern; occupancy and cleaning state are shown in two places (card and zone board) with no single legend; state drift is invisible (67 beds shown as "cleaning" with no open task).
- **Suggested layout**: summary strip per state (available/occupied/cleaning/maintenance) that doubles as filter; one table view + card view toggle; a single "Create" menu with single/bulk.

## 8. Property → Video Monitoring — `/property/video/:tab` (`VaView.tsx`, `VaVms.tsx`, `VaCameraSettings.tsx`)

- **Tabs**: VMS grid (1/4/9/16 tiles, quality toggle, fullscreen); camera settings (CRUD, substream, transcode, warm, bulk move, test connection).
- **Data**: 54 cameras (52 live), 201 stream sessions.
- **UX problems**: operational viewer and configuration live under one nav item with only a two-tab bar; camera health (`connection_status`, `last_checked_at`) is not summarised anywhere; "VA" label is cryptic (Video Analytics vs CCTV).
- **Suggested layout**: Video → Live (grid), Cameras (table with health chips), Settings. Health summary strip (online/offline/warm).

## 9. Operations → Tasks — `/operations/tasks` (`TasksView.tsx`, 7 tabs via `?tab=`)

- **Tabs**: Today, Abandoned, Review, Maintenance, Templates, History, Calendar. Maintenance and Templates are sub-views of Tasks (legacy routes redirect here).
- **Components**: `TodayTasksView`, `AbandonedTodayView`, `TaskReviewPanel` (+ `CompletionEvidenceLightbox`), `MaintenanceView` + `CreateMaintenanceModal` + `MaintenanceCalendarView`, `TemplatesView` + `TemplateWizard` + `TemplateDetailDrawer`, `TaskHistoryView`, `TaskCalendarView`, `TaskDetailDrawer`, `CreateTaskModal`.
- **Data reality**: 1,805 tasks in total; **84% are abandoned** (1,519), 284 completed, 2 assigned. The "Today" tab for a typical day is near-empty; "Abandoned" is the largest tab by count. Abandon reasons: next-occurrence expiry (912), daily rollover (601), midnight expiry (6).
- **UX problems**: "Abandoned" is presented as a peer tab of "Today" though it is dominant in volume; Review tab shows no backlog (queue = 0) while 125 submission rows are stale; 7 tabs in one pill strip; Maintenance inside Tasks hides a separate domain.
- **Suggested layout**: Operations → Board (today, by status and zone, with overdue and abandoned as exception lanes), Reviews (queue with turnaround), Maintenance (own page), Templates (own page), History & Calendar (one page with view toggle).

## 10. Operations → Maintenance day analysis and Task day analysis — `/operations/history/{tasks,maintenance}/:date`

- `TaskDayAnalysisView.tsx`, `MaintenanceDayAnalysisView.tsx`. Per-day drill-ins from calendars.
- Breadcrumb now resolves the date segment as "Detail"-style generic text; the date should be a readable label.
- Redesign: a day header with prev/next day controls and a summary strip.

## 11. Insights — `/insights` (`InsightsView.tsx`) and `/insights/audit` (`LogsView.tsx`)

- **Insights** is a **directory of links** (6 cards), not analytics. It fails the stated requirement of "meaningful overview". Links point to Workforce analytics, Task history, Maintenance, Calendar, Audit (SA), and Reviews.
- **Audit/Logs**: property picker grid → activity timeline (`ActivityTimeline`, `ActivityEvent`), task journey (`TaskJourney`), attachments. Entity type labels are inconsistent in the data (`employee` vs `employees`, `user` vs `users`), so filters will split the same entity.
- **Redesign**: Insights should be a real analytics area with charts (see `06`), with Audit as a tab.

## 12. Administration — `/admin/properties`, `/admin/settings`, `/admin/logs`

- **Properties** (`PropertiesView.tsx`, `CreatePropertyModal.tsx`): card grid of 10 properties. Eight are empty smoke-test shells with the same code (`PROP-001` on every property) — the list shows no way to distinguish them. Redesign: table with status, staff count, rooms, last activity.
- **Settings** (`AdminSettingsView.tsx`): database/ops/company panels. Thin; mostly informational. Redesign: company profile, operational day start (IST 06:00), system health, refresh-token housekeeping status.
- **Logs** (`LogsView.tsx`): same as Insights → Audit; duplicated route (`/admin/logs` and `/insights/audit`) — two entry points to one screen.
- **Role**: all three are Super Admin-only; the Header exposes them via the profile menu.

## 13. Profile — `/property/:uid/profile` (`ProfileView.tsx`)

- Own profile, shift card (`shifts` empty), password/self update (`PATCH /auth/me`). Very thin; redesign as account settings.

## 14. Public and auth — `/`, `/login`, `/signup` (`LandingPage.tsx`, `Login.tsx`, `Signup.tsx`)

- Landing is a marketing page with reveal and float motion (`lp-*` keyframes in `index.css`). Motion respects `prefers-reduced-motion`.
- Signup creates a company account — 513 SUPER_ADMIN users exist in the database (see `03`); worth verifying whether signup is exposed publicly.

---

## Cross-page UX problems (summary)

1. **Snapshot without time** — almost every metric is "now"; no trends, deltas, or comparisons.
2. **Dense tab strips** — Employees (8 tabs), Tasks (7 tabs), Units (4 tabs) in single pill strips.
3. **Tiny type** — roughly half of text classes are ≤11px.
4. **Data-state mismatch** — UI shows resource states that have drifted from open tasks.
5. **Silent failures** — Overview swallows API errors.
6. **Duplicated entry points** — Logs (two routes), department summaries (three places), pending reviews (Overview, Tasks, Insights).
7. **Sensitive fields on general profiles** — "Recorded salary" on employee detail.
8. **Two design languages** — warm shell vs cool analysis palette.
