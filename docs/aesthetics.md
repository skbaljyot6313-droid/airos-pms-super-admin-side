# AiROS PMS — Employee Analysis & Team Analytics: Aesthetics & Design System

This document describes, in depth, the complete visual and interaction design of the
employee-analysis experience: the per-employee **Employee Analysis** page and the
fleet-level **Team Analytics** tab. It covers the design system (palette, type,
spacing, elevation, radii), every page region, every container, every feed/list,
every form/control, every visualization, every state (loading / empty / error /
partial), responsive behavior, and microinteractions.

Component sources:

```
frontend/src/components/employees/EmployeeDetailView.tsx   — page shell, header, tab nav, preserved records/tasks
frontend/src/components/employees/analysis/kit.tsx         — design tokens + primitives (Panel, Empty, Delta…)
frontend/src/components/employees/analysis/PeriodSelector.tsx — reporting-period dropdown
frontend/src/components/employees/analysis/OverviewTab.tsx — KPI grid, activity chart, quality, breakdown, insights
frontend/src/components/employees/analysis/LocationsTab.tsx— zone → area → unit hierarchy modules
frontend/src/components/employees/analysis/AttendanceTab.tsx (code retained, tab hidden by user request)
frontend/src/components/employees/analysis/MaintenanceTab.tsx (code retained, tab hidden)
frontend/src/components/employees/analysis/DevicesTab.tsx  (code retained, tab hidden)
frontend/src/components/employees/analysis/TeamAnalytics.tsx — fleet analytics tab on the staff page
frontend/src/components/employees/analytics/AllocationTimeline.tsx — allocation ledger + lifecycle stepper
frontend/src/components/employees/EmployeesView.tsx        — staff page; hosts the Analytics tab
frontend/src/api/employees.ts                              — all wire types + API functions
```

---

## 1. Design system

### 1.1 Typography — Satoshi

- Loaded once at the top of `frontend/src/index.css` via Fontshare:
  `@import url('https://api.fontshare.com/v2/css?f[]=satoshi@400,500,600,700&display=swap')`
- Body font stack: `'Satoshi', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
  (applied to `body` and `.font-body`). `.font-display` (Space Grotesk) is retained by the
  global app shell only — the analysis surfaces never use it.
- Type scale actually used on the page:

  | Role | Size / weight / tracking |
  |---|---|
  | Employee name (H1) | `22px`, `font-semibold`, `tracking-[-0.01em]`, tight leading |
  | Section title (H2) | `15px` semibold, `tracking-[-0.01em]` (Panel title); `16px` on Team page header |
  | KPI value | `30px` semibold, `leading-none`, `tabular-nums` |
  | Team KPI value | `28px` semibold, `leading-none`, `tabular-nums` |
  | Body / primary list text | `13px` |
  | Metric labels, table headers | `10–11px`, uppercase, `tracking-[0.05–0.06em]`, `font-medium/semibold` |
  | Supporting / secondary text | `12px` (`text-xs`) |
  | Captions, axis labels, stage labels | `9–11px` |
  | Tooltips | `11px` |

- All numeric values use `tabular-nums` so columns of figures align.

### 1.2 Color palette (canonical tokens — `C` in `kit.tsx`)

| Token | Hex | Role |
|---|---|---|
| `bg` | `#F7F8FA` | app background wash; empty-state wells |
| `surface` | `#FFFFFF` | cards, dropdowns, table cells |
| `text` | `#17212B` | primary text |
| `muted` | `#697586` | secondary text, dim labels, legend text |
| `faint` | `#98A2B3` | tertiary text, axis labels, metadata |
| `hairline` / `border` | `#EEF1F5` / `#E9EDF2` | card borders, separators, chart gridlines |
| `navy` (primary accent) | `#365D78` | tab-active fill, primary bars, focus rings, allocated series |
| `blue` (secondary accent) | `#6686A0` | "submitted" series, maintenance accents, share bars |
| `success` | `#169B72` | completed/approved/on-time |
| `warning` | `#D99532` | pending / redo / pending review / incomplete |
| `danger` | `#D76565` | abandoned / rejected / absent |
| `track` / `mutedSurface` | `#F1F3F6` | progress tracks, skeletons, segmented-control wells |
| `successBg`/`warningBg`/`dangerBg` | `#EAF6F0` / `#FBF4E8` / `#FCEEEE` | tinted status surfaces (14% alpha also used inline, e.g. `${color}14`) |
| Unfilled/muted element | `#C9D0DA`, `#D8DEE6` | pending stepper dots, legend dots, "no record" |

Palette rules in force:

- **Restraint**: no neon, no gradients, at most one hue family per data series
  (blue family for allocated/submitted, green for completed/resolved, coral for abandoned/rejected).
- Negative metrics are **not** auto-red: `Delta` inverts color only where a direction is
  semantically good/bad (see §4.3). Abandoned counts render red **only when > 0**;
  completion-rate text turns red only < 30%, green only ≥ 70%.
- Color is never the only carrier of meaning — every colored element also carries a label.

### 1.3 Spacing scale (4px base)

- Page container: `max-w-[1440px]`, `mx-auto`, `space-y-5` (20px vertical rhythm).
- Card padding: `px-5 py-4` (headers) / `p-5` (panels). Internal list spacing `1.5–3`.
- Grid gaps: `gap-4` (KPI cards), `gap-5` (section grid).
- Segmented controls: `p-0.5–1` well + `px-3–4 py-1–1.5` buttons.

### 1.4 Elevation & radii

- **`card` token** (`kit.tsx`): `rounded-xl border border-[#E9EDF2] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]`
  — a 12px radius, hairline border, and a barely-there shadow. Used for every
  panel, KPI card, timeline container, and table card.
- Nested surfaces drop the shadow and lighten: `bg-[#FAFBFC]` for expanded
  location areas, `bg-[#F7F8FA]` for empty-state wells and stat cells.
- Focus state: `focus-visible:outline-2` or `focus-visible:ring-2` in the accent
  navy (`#365D78` at ~25% alpha on inputs).
- Hover elevation is never added — interaction feedback is a *background* tint
  (`hover:bg-[#FAFBFC]`) or text-darkening (`hover:text-[#17212B]`), not a bigger shadow.

### 1.5 Status & semantic colors (`STATUS_COLORS`)

`present #169B72 · absent #D76565 · leave #6686A0 · week_off #C9D0DA ·
incomplete #D99532 · completed/approved #169B72 · pending/submitted #D99532 ·
disapproved/rejected/abandoned/overdue #D76565 · in_progress/assigned/open #6686A0 ·
resolved/closed #169B72 · on_hold #D99532 · cancelled #C9D0DA`

### 1.6 Shared primitives (`kit.tsx`)

- **`Panel`** — section card: H2 + optional `action` (right-aligned control) +
  `note` (12px faint support text). Every major section is a `Panel`.
- **`Empty`** — compact centered message on the `#F7F8FA` well; *never* a tall
  blank card.
- **`BlockLoading`** — three `h-14` skeleton rows, `animate-pulse`, `#F1F3F6`.
- **`BlockFailure`** — warning icon + message + Retry outline button; never leaks
  raw server errors.
- **`HBar`** — ranked horizontal bar (110px label / track / right-aligned value).
- **`Delta`** — previous-period comparator (§4.3).
- **`TabBtn`** — pill button: active = navy fill `#365D78` + white text; inactive =
  muted text, `hover:bg-white`.
- **`pct(rate)`** — `66.7%` formatting or `—`.

---

## 2. Employee Analysis — page shell (`EmployeeDetailView.tsx`)

### 2.1 Page frame

- Max width 1440px, centered, `space-y-5`.
- Order: **identity header → tab nav + period metadata → active tab body**.
- Loading: full `BlockLoading`. Failure: `Failure` panel — generic copy, no backend
  details, Retry button (re-fires profile fetch).

### 2.2 Employee identity header

- Single `card` row; **left-to-right**: back link (`← Employees`), avatar,
  name block, flexible spacer, contact column, hairline divider, period
  selector, refresh icon-button.
- **Avatar** — 44px circle (`h-11 w-11`), initials (`getInitials`), background =
  `employee.avatar_color || #365D78`.
- **Name row** — `22px` semibold + inline indicators:
  - status as a **1.5px dot** + text (`#169B72` Active / `#98A2B3` otherwise),
  - `· On leave` amber text when `leave_status`,
  - `· N open task(s)` muted text when `current_open > 0`.
- Line 2: `job_title · department · legacy shift label` (13px muted; parts omitted when absent).
- Line 3: `property · zone|area | ID {uid8}` (12px faint; `Unallocated` when no zone/area; ID is
  `font-mono` first 8 chars of `employee_uid`).
- **Contact column** (desktop `lg+` only): email + phone, `11px` icons, right-aligned.
- **Right cluster**: `PeriodSelector` + ghost `RefreshCw` button. Refresh bumps a
  key and refetches profile only.
- The old separate "Reporting period" band is gone — it lives as one
  metadata line beside the tab nav: `Reporting period: Last 30 days · IST`.

### 2.3 Tab navigation

- `Overview | Allocations` (the user removed Maintenance, Records, Attendance,
  Device tabs; their code is retained but unreachable — re-adding is one line in
  `TABS`). Segmented control on a `#F1F3F6` well; `TabBtn` pills.
- Fetches are **per-section, lazy, and keyed by the shared period** — the header
  renders before any analytics resolves.

### 2.4 Reporting-period selector (`PeriodSelector.tsx`)

- Refined dropdown button: calendar icon + active label + chevron (rotates on open).
- Panel: 2-column preset grid — `Today · Last 7 days · Last 30 days · This month ·
  Last month · All time · Custom`.
- Custom region: `date` inputs + IST preview line + inline validation
  (`Start must be on or before end`, `End cannot be in the future`) + disabled
  `Apply` until valid. `date_to` is **exclusive**; IST day boundaries built as
  `YYYY-MM-DDT00:00:00+05:30` and converted to ISO.
- Labels: `Today`, `Last 30 days`, `1 Oct 2026 – 30 Oct 2026`, `All time`.
- `bucketFor(bounds)` auto-picks `day ≤45d · week ≤370d · month` — drives the
  server aggregation for activity charts.

### 2.5 Hidden secondary sections (code retained)

- `AttendanceTab` — month-navigable calendar (status-coded cells, today ring,
  legend, monthly summary strip) + `DayDetail` drill (clock-in/out, breaks,
  shift, approved leave, "no record ≠ absence" notice).
- `MaintenanceTab` — ticket KPIs (allocated/resolved/open/reassigned/currently
  assigned/resolution rate/median resolution time), by-zone bars, paginated history.
- `DevicesTab` — registered devices (platform, app version, active, registered/
  last-seen times) + tracking session stats + `available:false` graceful state;
  **never** renders tokens/coordinates.
- `RecordsSection` — preserved record kinds (tasks history w/ search+filters+
  pagination+lazy `TaskHistory`, submissions, attendance, leaves, shifts,
  allocations, maintenance) using shared `Fields`/`Pager`/`recordLabels`/`recordValue`.
- `ProfileDisclosure` — compact `<details>` disclosure listing *only non-empty*
  profile fields (never shows "Not recorded" walls).

---

## 3. Overview tab (`OverviewTab.tsx`)

Layout: `space-y-5` → KPI grid → `[60/40]` two-column analytics → `[60/40]` breakdown + insights.

### 3.1 KPI grid — `KpiGrid`

- Five **separate** cards (`card` token, `px-5 py-4`), `grid-cols-2 → sm:3 → lg:5`.
- Each card: `11px` uppercase muted label · `30px` semibold `tabular-nums` value ·
  `Delta` line (or `Currently active tasks` for Open now — point-in-time metrics
  show *no* comparison).
- Definitions in `KPI_DEFS`: `Allocated · Completed · Open now · Abandoned ·
  Completion rate`. Whole card carries a `title` tooltip with the metric's exact definition.
- **Delta semantics** (`kit.Delta`): counts → `+N (+P%)` (pct hidden when prev=0);
  rates → `±N pp` percentage points; `invert:true` flips good/bad for Abandoned
  (and other "more is worse" metrics); `±0` renders a neutral `±0`/`no previous`.
  Icons: `TrendingUp/Down` at 12px.

### 3.2 Work activity — `ActivityChart`

- Custom SVG grouped bar chart, `h-[270px]`, `viewBox` scaled to `24px` per bucket.
- Series: **Allocated `#6686A0` · Completed `#169B72` · Abandoned `#D76565`**,
  `rx=2` rounded bars, 3 series per slot.
- Axes: 4 subtle horizontal gridlines `#EEF1F5`, integer y-ticks (`nice` max rounded
  to a multiple of 4), sparse IST x-labels (every ⌈n/12⌉th) in `10px` faint.
- **Interactions**: per-bucket hover — other buckets dim to `opacity .35`, a dashed
  vertical guide `#D8DEE6` marks the slot, and a custom floating tooltip
  (`role="tooltip"`, white card, `0 4px 12px rgba(16,24,40,.10)`) shows
  `date + 3 labeled counts`; it flips to the left of the cursor past mid-chart.
- Legend: inline `12px` items under the chart.
- Aggregation control: `day | week | month` segmented pill in the panel `action`
  slot — switching refetches analytics at that bucket.
- Empty: `No work activity recorded in this period.` (compact well, no fake
  zero-filled series).

### 3.3 Submission & review quality — `QualityPanel`

- Hero: `32px` semibold approval % (`#169B72`; `—` when undecided) +
  `N attempts · M decided` caption. Attempts vs unique tasks is stated in the
  panel note.
- Segmented bar (`h-2` rounded): Approved `#169B72` / Rejected `#D76565` /
  Pending `#D99532` proportional widths, `role="img"` with full counts in
  `aria-label`; three dot+count indicators below.
- Metric list (label-left `13px` muted / value-right semibold tabular, hairline
  `divide-y` separators): `First-attempt approval (% of N decided) · Tasks
  needing rework (n of N) · Median review turnaround · Avg review turnaround`
  — durations via `duration()` (`1h 30m 0s`, `—` when null).
- Empty: `No submission attempts in this period.`

### 3.4 Workload breakdown — `WorkloadBreakdown` + `LocationTree`

- Panel note: *"Task distribution across assigned locations. Expand a zone for
  its areas and units."*
- **Zone module** (`ZoneBlock`): `rounded-lg` border row, chevron (rotates 180°
  on expand, `duration-200`), `MapPin` navy icon + name, then five inline stat
  pairs `value 13px semibold + 10px faint label`: `Allocated · Completed ·
  Abandoned · Open · Completion`; maintenance counts shown as a separate
  `N maint · M resolved` chip (never mixed into task totals).
- Expanded state: `bg-[#FAFBFC]` region w/ top hairline; **areas** indent `pl-8`
  w/ own chevrons + same stat pairs at `medium` weight; **units** (`room|dorm|
  washroom` kind chip + label) indent `pl-[52px]`.
- Non-expandable zones render `disabled` (no chevron, default cursor).
- Data: `GET /employees/{id}/locations` — zone → area → unit with
  allocated/completed/abandoned/open/completion_rate + maintenance per zone.

### 3.5 Operational insights — `Insights`

- Editorial rows in a `divide-y` list (max 3): a `w-16` uppercase **category chip**
  (`Abandonment #D76565 · Completion #169B72 · Workload #365D78 · Quality #6686A0 ·
  Maintenance #D99532 · Location #6686A0` — 14%-alpha tinted bg) + `13px` insight text.
- Every insight is server-generated with its evidence embedded in the sentence
  (`"Abandonments while assigned rose to 54 (from 0 in the previous period). Worth
  reviewing allocation fit or workload."`). `Insufficient data…` empty state when
  nothing meaningful.

### 3.6 Profile disclosure — `ProfileDisclosure`

- `<details>` element styled as a `card`; summary row = `UserRound` icon +
  `Employee profile details` + chevron.
- Expanded: 3-column `Fields` grid of **only non-empty** fields (email, phone,
  username, zone/area, start date, record created, recorded salary, legacy shift,
  leave balance, deactivate/reactivate stamps, pending leave requests, recorded work).

---

## 4. Allocations tab (`AllocationTimeline.tsx`)

### 4.1 Panel header + filters

- `Panel`-style card; title `Allocation History` + supporting text
  *"Complete chronological record of task assignments and transfers · newest first."*
- Right: two groups of **rounded-full filter pills** separated by a hairline —
  `[All | Tasks | Maintenance]` and `[All direction | Assigned to employee |
  Reassigned away]`. Active pill = navy fill; inactive = `#E9EDF2` border,
  `hover:border-[#C9D0DA]` + darker text.

### 4.2 Timeline entries — full-width structured rows

- Rail: `border-l #EEF1F5` at `ml-6`; each event dot is `2.5px` radius-2 ring on
  white — color = **green** (assigned to employee) / **amber** (reassigned away) /
  **blue** (maintenance).
- Each row is a `border-b #F1F3F6` horizontal flex: `hover:bg-[#FAFBFC]`.
  - **Left (w-24)**: `13px` date (`30 Oct`) + `11px` IST time.
  - **Center (flex-1)**: action line — `Assigned to X` / `Reassigned: A → B` /
    `Reassigned away → B` at `13px` semibold + `Task|Maintenance` chip + `#ticket`.
    Second line (12px muted): `method · by actor · reason · property` — any part
    omitted if absent (no fabricated assignees).
  - **Right (lg:w-[280px])**: workflow `Stepper` + outcome chip.

### 4.3 Workflow stepper (`workflow` + `Stepper`)

- Four nodes with connecting hairlines — filled node when a stage is *proven*
  reached, ring node for the in-flight stage, muted outline for pending.
- Tasks: `Allocated → Submitted → Approved/Sent for redo → Completed/Abandoned`.
- Maintenance: `Allocated → In progress → Resolved → Closed/Cancelled`.
- **Data integrity in the stepper** (the rules the user flagged):
  - `admin_closed` tasks: stage 3 = `No review` (muted), stage 4 = `Closed by staff`
    (navy, `by {actor} · {timestamp}`), outcome chip `Closed by staff` — a staff
    override is never rendered as an employee approval.
  - Submitted but abandoned before decision: stage 3 = `Not reviewed`, stage 4 =
    `Abandoned` (red), outcome = `Abandoned before review`.
  - Stage 2 actor caption shows the *reviewer's* name (`by SHAHZEB`); stage 1 shows
    the *submitter's* name — distinct fields, never conflated.
- Outcome chip: `Open / Pending review / Redo requested / Abandoned (before review) /
  Completed / Closed by staff / Resolved / Closed / Cancelled`, each colored via
  `${color}14` tinted bg.
- `aria-label` narrates stage states for screen readers.

### 4.4 Pagination

- Server-paged `records?kind=allocations` (25/page): `{N} records · page X of Y`
  + Prev/Next ghost buttons. Filters reset to page 1 on change.

---

## 5. Team Analytics tab (`TeamAnalytics.tsx` + `EmployeesView.tsx`)

- Registered on the staff page's segmented control between *Attendance* and the
  staff-only group: `BarChart3` icon, active state accent `#365D78`.
- Header row: `Team performance` (16px semibold) + `N employees` support line +
  `PeriodSelector` right-aligned.
- **Team strip**: five `card` modules — `Allocated · Completed · Abandoned · Open now ·
  Completion rate` (28px values, rate null-safe).
- **Sortable table** (`card`, header `sort by …` caption): columns
  `Employee (name + title) · Zone · Allocated · Done · Aband. · Open · Rate · Share`
  — click a header to sort (arrow indicator); `min-w-[720px]` + `overflow-x-auto`.
  - Abandoned red only when >0; Rate green ≥70%, red <30%.
  - Share = employee's allocated ÷ team allocated, shown as a `#6686A0` mini bar + %.
  - Row hover `bg-[#FAFBFC]`, row click → deep-link to `/property/:pid/employees/:uid`.
- Footnote documents exact metric definitions (distinct tasks, approved
  submissions, last-assignee-before-abandonment, open = point-in-time).
- Data: `GET /employees/team-analytics` (staff-only, property-scoped, `no-store`).

---

## 6. Backend surface powering the visuals

| Endpoint | Feeds |
|---|---|
| `GET /employees/{id}/profile` | header, contact, open-task chip, profile disclosure |
| `GET /employees/{id}/analytics` | KPI grid, activity series, quality, breakdown, insights, shift adherence |
| `GET /employees/{id}/locations` | workload breakdown hierarchy |
| `GET /employees/{id}/records?kind=*` | allocation timeline (+`lifecycle` enrichment), records tables |
| `GET /employees/{id}/attendance/calendar` · `…/day` | attendance calendar & drill-down (hidden tab) |
| `GET /employees/{id}/devices` | device diagnostics (hidden tab) |
| `GET /employees/team-analytics` | the Analytics tab on the staff page |

All staff-only (super_admin + property_manager), company/property-scoped,
`Cache-Control: private, no-store`.

---

## 7. States, accessibility & microinteractions

- **Loading**: `BlockLoading` skeleton rows (3× `h-14 animate-pulse`) — panels keep
  their frame so layout doesn't jump.
- **Empty**: compact `Empty` well with a specific message per section; no tall blank charts.
- **Error**: `BlockFailure` (warning icon + generic copy + Retry) — request-scoped,
  never leaks backend text.
- **Partial data**: every metric renders `—`/`Not recorded` per-field; tooltips
  (`title=` on KPI cards / panel `note`s) carry definitions.
- **Motion**: `transition-colors duration-150 ease-out` on pills/rows; chevron
  rotation `duration-200`; tooltip has no animation (positional).
- **A11y**: `aria-label`/`aria-pressed`/`aria-expanded` on all toggles & tabs;
  chart + stepper carry narrating `role="img"` labels; `role="tooltip"`;
  `focus-visible` rings; status is text+color, never color-only.
- **Reduced data promises**: `date_to` exclusive + IST boundaries throughout;
  "Open now" metrics are explicitly point-in-time and show no period comparison;
  missing attendance is never rendered as absence; maintenance counts never
  mix into task counts.

## 8. Responsive behavior

- `lg`: 5 KPI cards / 60-40 analytics split / stepper on the row's right / contact
  column visible.
- `sm–md`: KPIs wrap 2–3 per row; analytics stack; table scrolls horizontally;
  stepper wraps under the event detail.
- Mobile: KPIs 2-col; all sections stack; filter pills wrap; timeline rows
  reflow vertically (no horizontal compression); period dropdown is right-aligned
  and its panel is `w-72` absolute-positioned.

## 9. Honest limitations

- Satoshi loads from Fontshare CDN — no bundler dependency; offline dev shows
  the system fallback stack.
- `AttendanceTab`/`MaintenanceTab`/`DevicesTab`/`Records` components are complete
  and tested but **hidden** (tabs removed per user request) — their endpoints and
  code remain live.
- `admin_closed` staff overrides are surfaced only in the allocation stepper —
  the KPI "Completed" count still follows the schema's task status (documented
  definition, not a silent omission).
- Device diagnostics is read-only and omits anything the shared schema doesn't
  store (no FCM tokens, no raw coordinates, no fabricated "device health").
