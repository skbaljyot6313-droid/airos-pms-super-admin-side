# Management Tool — Frontend Features & Product Documentation

A unified guide to every screen, section, and feature that exists in the
`frontend/` React application. This document describes the product surface
— what users see, what they can do, and how the screens are organized.
It intentionally does not cover backend architecture, database schema, or
API internals.

- Application: multi-tenant property operations platform (React 19 +
  TypeScript + Vite + Tailwind).
- Entry point: `frontend/src/App.tsx` (routing, guards, lazy-loaded views).
- Shared state: `frontend/src/context/AppContext.tsx` exposes session,
  collections, and every mutation through `useApp()`.
- Time display: all operational dates/times render in IST (Asia/Kolkata).

---

## 1. Roles and Access

Two roles have a working surface in this frontend:

| Role | What they see |
|---|---|
| **Super Admin** | Company-level nav (Properties, Settings) plus every property workspace. Can create/delete properties, edit company settings, manage managers. |
| **Property Manager** | Scoped to a single property. Lands directly inside that property's workspace and gets the full operational surface for it (staff, units, tasks, maintenance, templates, attendance, leaves, live location). |

Employee/HR/department-manager accounts exist in the model but have **no
management surface** in this app — the employee experience lives in a
separate application. `frontend/src/lib/permissions.ts` mirrors the role
rules and gates UI accordingly.

Route guards in `App.tsx`:

- `RequireAuth` — unauthenticated visitors are sent to `/login`.
- `RequireRole` — `/admin/*` routes are super-admin-only.
- `WorkspaceGate` — wraps the workspace with loading skeletons, a
  retryable error state, and empty-data handling.
- `PropertyScopedView` — every `/property/:propertyUid/*` route resolves
  and locks the active property before rendering.
- Unknown routes fall back to a role-appropriate redirect (super admin →
  properties list, property manager → their zones page, else `/`).

---

## 2. Public Surface

### 2.1 Landing Page (`/`)

A marketing-style public page composed of sections
(`frontend/src/components/landing/`):

- **LandingHeader** — sticky nav with anchor links (features, operations,
  roles) plus Login / Get Started.
- **HeroSection** — headline "One workspace for every property operation",
  CTAs to `/signup` and `/login`, embeds `ProductPreview`.
- **ProductPreview** — static product mock/screenshot block.
- **FeaturesSection** — platform capability cards.
- **OperationsSection** — operations workflow explainer.
- **RolesSection** — describes the roles the platform supports.
- **CtaSection** — final call to action → signup.
- **LandingFooter** — link columns and company info.

### 2.2 Login (`/login`)

`frontend/src/components/auth/Login.tsx`:

- Email **or username** + password sign-in.
- Password field uses `PasswordInput` (show/hide toggle).
- "Forgot password?" reveals an inline note — resets are handled by the
  company's Super Admin (no self-serve reset flow in the UI).
- Inline error banner for bad credentials; already-signed-in users are
  redirected to their role's workspace.
- Link to `/signup` ("Create your company").

### 2.3 Signup (`/signup`)

`frontend/src/components/auth/Signup.tsx` — registers a **company**
account; the registering user automatically becomes the company's
Super Admin.

- Two-column form: company info (name, brand name, address, 6-digit PIN
  code) and account info (email, phone, password ≥ 8 chars, confirm).
- Client-side validation with per-field errors (PIN format, email, phone,
  password length/match); server field errors are mapped back onto fields.
- On success → routed into the Super Admin workspace.
- Both auth screens use shared `FormField` and `PasswordInput` components
  with Back-to-home links.

---

## 3. Header & Global Chrome

`frontend/src/components/navigation/Header.tsx` renders context-aware
navigation:

- **Outside a property (super admin)**: Properties and Settings links,
  company branding.
- **Inside a property**: Zones, Employees, Rooms, Tasks, Templates,
  Profile — plus a property name breadcrumb and back-to-properties for
  super admins.
- A live IST clock, current user identity with role display, logout, and
  a mobile navigation drawer for small screens.
- `ToastContainer` (global, top-level in `App.tsx`) shows success /
  warning / error notifications for every mutation; toasts auto-dismiss
  and can be closed manually.
- `BackButton` appears on sub-pages (auth, day-analysis, zone workspace)
  for easy return navigation.

---

## 4. Company-Level Surface (Super Admin)

### 4.1 Properties (`/admin/properties`)

`frontend/src/components/properties/PropertiesView.tsx` — the property
portfolio.

- Property cards list name, location, and aggregate counts (zones, rooms,
  washrooms, employees, beds).
- **Open** a property → enters its workspace at `/property/:uid/zones`.
- **Create Property** (`CreatePropertyModal`):
  - Property details: name, address/neighborhood, city, state.
  - Automatically creates a **scoped Property Manager account** with
    name, email, phone, optional username (auto-suggested from name/email
    until manually edited), and a password (≥ 8 chars, confirmed).
- **Edit Property**: rename/relocate; **reassign the manager** to an
  existing employee of that property; edit manager email; **reset manager
  password** (min 8 chars).
- **Delete Property**: guarded by a `ConfirmationDialog` (destructive
  actions always confirm).

### 4.2 Organization Settings (`/admin/settings`)

`frontend/src/components/admin/AdminSettingsView.tsx` (super admin only):

- **Organization & Brand Identity** — legal entity name, hospitality brand
  name, operations email, corporate phone.
- **Operational Day** — the IST time each operational day begins. At this
  moment unfinished work from the previous day is marked *Abandoned*, and
  the task calendar/day-analysis group work by this window. This single
  setting drives the daily rollover semantics visible across Tasks and
  Maintenance.
- **Workspace Data** — live counts (properties, zones, rooms & dorms,
  staff) pulled from loaded collections, plus a **Refresh Data** button
  that re-fetches all workspace collections.

---

## 5. Property Workspace

Every route under `/property/:propertyUid/` resolves the property context
first; `/property/:propertyUid` itself redirects to `zones`. All
collections (areas, zones, rooms, dorms, beds, washrooms, employees,
tasks, tickets) are filtered to the active property via
`currentProperty*` selectors in AppContext.

### 5.1 Areas & Zones (`/property/:uid/zones`)

`frontend/src/components/zones/ZonesView.tsx` — the spatial structure
view.

- **Areas** represent floors/levels; **Zones** are operational sectors
  (wings, sections) that can sit inside an area or be unassigned.
- Toggle between *group by area* and a flat zone grid; filters for a
  specific area or "unassigned zones".
- **Create Area** (`CreateAreaModal`): name a floor/level.
- **Create Zone** (`CreateZoneModal`): name, parent area, optional
  description, and a **zone type** picker:
  - Guest Stay (rooms, dorms & beds)
  - Common Area (lobby, lounge, co-working)
  - Dining / F&B (café, kitchen, restaurant)
  - Amenities (gym, pool, spa, yoga deck)
  - Outdoor (garden, terrace, parking)
  - Back of House (staff, storage, laundry)
  - Only *Guest Stay* zones can contain rooms/dorms/beds; other types
    still carry staff, tasks, washrooms, and maintenance.
- Zones and areas can be edited, opened, and deleted (with confirmation).
- Opening a zone enters the **ZoneWorkspace**.

### 5.2 Zone Workspace

`frontend/src/components/zones/ZoneWorkspace.tsx` — the operational hub
for one zone.

- Shows the zone's units (rooms, dorms, beds, washrooms) with live
  operational status, occupancy, and linked task/maintenance state.
- Zone staff shortcut navigates to the Employees board filtered to the
  zone.
- **Multi-select mode** over units:
  - Toggle multi-select on/off.
  - Quick selections: Select occupied, Select cleaning, Select all,
    Clear.
  - Bulk operations on the selection (e.g., send to cleaning, release to
    available, raise maintenance).

### 5.3 Rooms, Dorms, Beds & Washrooms (`/property/:uid/rooms`)

`frontend/src/components/rooms/RoomsDormsView.tsx` — four tabs:

#### Rooms tab
- Card grid of rooms; each card shows room number, UID, type, square
  footage, bed count, zone, operational status badge, current guest
  ("In-House" strip), and any cleaning note.
- Filters: zone and status.
- Per-card actions: edit (`EditRoomModal`), delete, occupancy toggle,
  Cleaning, Checkout, Maintenance (shows `Maint ●` when a blocking ticket
  exists and opens the ticket instead of a form), and **Request**
  (`RequestItemModal`) — raises a guest amenity request on that room.
- **Guest requests**: the Request form asks "What is the request for?"
  with 12 quick options (Towel, Extra Mattress, Comforter/Blanket, Extra
  Pillow, Bed Linen Change, Toiletries Kit, Drinking Water, Tea/Coffee
  Kit, Laundry Pickup, Iron & Ironing Board, Room Cleaning, Medical
  Assistance) plus an **Other** free-text field, and optional notes.
  The task is allocated through the normal zone round-robin but is
  stamped `origin='guest_request'` and forced to **urgent** priority —
  the top task priority — so the employee app can pin it above all
  regular work. In the dashboard, guest requests sort to the top of
  Today's Tasks with a "Guest Request" badge.
- **Multi-select toolbar**: select-all (with indeterminate state), then
  bulk **assign to zone**, **Send to cleaning**, **Available** (releases
  occupancy + blocking work), **Maintenance** (one ticket per room),
  **Delete** (confirmation lists the rooms).
- **Create Room** (`CreateRoomModal`): room number (with live duplicate
  detection), room type (preset list or custom), area sq ft, bed count,
  zone assignment (only stay zones listed).
- **Bulk Create Rooms** (`BulkCreateRoomsModal`): enter a range like
  `201–209`; the modal previews each room, flags numbers that already
  exist, and batch-creates the valid ones.
- Edit modal also carries a cleaning note field.

#### Dorms tab
- Each dorm card shows name, dorm type (Mixed / Female / Male), bed
  count, area, zone, and aggregate bed counts (occupied / available /
  cleaning / maintenance).
- Beds render as a **visual tile grid** (never a plain table). Each bed
  tile shows bed number, status, guest name or "Vacant", and a compact
  occupancy toggle. Clicking a tile selects it for batch operations.
- Bed batch toolbar: select all in the dorm, then bulk checkout, send to
  cleaning, release to available, or raise maintenance (partial selection
  → one ticket per bed; whole-dorm selection → one dorm-level ticket).
- Attached **washroom facility tiles** appear alongside beds: real
  washroom resources show fixture breakdowns; a dorm that merely declares
  an "Attached Washroom" shows a clickable declared-facility tile that
  opens the detail modal in "not configured" mode with a **Configure
  Washroom** shortcut.
- **Create Dorm** (`CreateDormModal`): name (live duplicate check), bed
  count (auto-generates Bed 01–Bed N), dorm type, washroom facility type
  (Attached / Shared / None), area, zone, description.
- **Edit Dorm** (`EditDormModal`): changing the bed count resizes the bed
  inventory.
- **Bulk Create Dorms** (`BulkCreateDormsModal`): row-per-dorm entry —
  each row generates its beds automatically.
- Delete dorm confirmation warns that all beds inside are deleted too.
- Dorm-level actions: checkout whole dorm, mark dorm cleaned.

#### Washrooms tab
`WashroomsView` + `WashroomModal` + `WashroomDetailModal`:

- Washroom cards show name, type (Male / Female / Unisex), fixture
  counts, status (Operational / Cleaning / Maintenance / Inactive), zone,
  open-task and blocking-maintenance indicators.
- Filters: zone, status, and **attachment** (all / attached to dorms /
  common zone-level).
- Per-card: edit, delete, change zone, view details, maintenance.
- **Create/Edit Washroom** (`WashroomModal`): name (dorm-attached ones
  auto-derive `<Dorm> — Washroom` and update if the dorm is renamed),
  type, zone, and a **fixture inventory** — counters for showers, stalls,
  urinals, sinks, mirrors, bath tubs, jacuzzis, plus arbitrary custom
  fixture types with their own counts.
- **Bulk Create Washrooms**: one row per washroom with zone assignment.
- **Washroom Detail Modal** — the facility window:
  - Facility header (dorm/zone context, live status badge, refresh with
    retry on failure).
  - Active maintenance banner showing the blocking ticket's number,
    issue, assignee, and due date.
  - Action bar: **Assign Task**, **Allocate Maintenance**, release to
    Available.
  - **Facility overview**: per-fixture-type cards with totals and
    operational/attention counts, overall condition summary.
  - **Needs Attention** list of flagged fixtures with quick task and
    maintenance actions.
  - **Fixture board**: clickable fixture cells (multi-select supported)
    with per-fixture status labels; each fixture has a `···` menu —
    View Details, Assign Task, Allocate Maintenance, Mark Operational,
    Mark Inactive.
  - Fixture history timestamps (last cleaned / last maintenance) shown in
    IST-friendly "Today · time" style.
- **Assign Washroom Task** (`AssignWashroomTaskModal`): scope = entire
  washroom or specific fixture(s) — multi-fixture selection creates one
  task per fixture; task type (Cleaning, Inspection, Repair, Restocking,
  Other), assignee, priority, due date, notes.
- **Schedule Washroom Maintenance** (`ScheduleWashroomMaintenanceModal`):
  same scoping; maintenance type list, priority, assignee, due date,
  description, and photo evidence upload. Creates tickets via the work
  batch API (one per fixture) and assigns each when an employee is
  picked.

#### Zones (allocation) tab
`UnitZoneBoard` — a drag-and-drop allocation board (@dnd-kit):

- One column per zone plus an **Unallocated** column.
- Drag rooms, dorms, and washrooms between columns to re-zone them;
  changes persist immediately.
- Non-stay zones reject rooms/dorms (only washrooms allowed) with a
  warning toast.
- Cards show unit kind, name/number, specs, and status badge.

### 5.4 Occupancy & Operational State

A product-level concept surfaced everywhere units appear:

- **Occupancy is its own axis** (`OccupancyToggle`): a two-segment
  Occupied / Un-occupied control. Occupancy means an open stay record —
  an occupied room can simultaneously be "cleaning" or "maintenance".
- Check-in is offered only from Available + unoccupied; check-out only
  while occupied. Check-out runs through a confirmation dialog explaining
  that the unit moves to Cleaning and a housekeeping task is generated.
- Operational status (Available / Occupied / Cleaning / Maintenance /
  Inactive) is derived server-side; the UI never edits status directly —
  it issues commands (cleaning, maintenance, checkout, release).
- Color tints come from the shared `unitVisualState` resolver so rooms,
  beds, and washrooms look consistent across screens.
- When tasks complete or tickets close, `subscribeUnitDeselect` prunes
  stale selections in the boards automatically.

---

## 6. Employees (`/property/:uid/employees`)

`frontend/src/components/employees/EmployeesView.tsx` — seven tabs:
**Board**, **Directory**, **Deactivated**, **Live Location**, **Leaves**,
**Shifts**, **Attendance**.

### 6.1 Staffing Board (`ZoneBoard`)

- Summary strip: active staff, assigned staff, unallocated staff.
- Drag-and-drop staff allocation (@dnd-kit): drag employee cards onto
  area/zone drop targets to allocate them; a separate unallocated pool.
- Employee cards show avatar-initials with a color, name, job title,
  department, leave state, and active task count.
- Cards are not gated by attendance — all assignable employees are
  visible.

### 6.2 Directory (`EmployeeDirectory`)

- Search by name, email, employee ID, role/job title.
- Filters: zone allocation, department, status.
- Row actions: edit profile fields, assign to area/zone, deactivate,
  reactivate, delete (confirmed).

### 6.3 Create Employee (`CreateEmployeeModal`)

- Name, job title, department (7 departments: Front Desk Operations,
  Housekeeping & Cleanliness, Maintenance & Engineering, Food & Beverage,
  Guest Experience & Community, Security & Safety, Accounts &
  Administration), work email (unique-checked with field error), phone,
  initial zone, joining date.
- Optional shift window (start/end in IST — both or neither; an end ≤
  start means overnight). If provided, the modal finds or creates a
  matching shift definition and assigns it from the joining date; a
  failure here warns without failing employee creation.
- Staff login credentials: password + confirm (≥ 8 chars). The employee
  signs in with their work email and this password.
- Each employee gets an auto-generated immutable Employee ID.

### 6.4 Deactivated tab

- Same directory view restricted to deactivated employees, with
  reactivate/delete actions.

### 6.5 Leaves (`LeavesPanel`)

- Staff-only (super admin / property manager) leave request review.
- Pending queue shows employee, leave type (Casual, Sick, Paid, Unpaid,
  Other) or Week Off, date range, day count, and reason.
- **Approve / Reject** with an optional review note; decided requests are
  viewable via a "History" toggle showing status and review comments.
- Non-staff viewers see a restricted message.

### 6.6 Shifts (`ShiftManager`)

- Drag-and-drop **shift board**: an "Employees" (unassigned) pool column
  and one column per shift definition.
- Dragging a card onto a shift assigns it effective today (IST); a
  same-day assignment is replaced, an older one is closed yesterday so
  history stays intact.
- Shift definitions (inline create/edit form): name, start/end time
  (end ≤ start = overnight), grace minutes, early-exit minutes, and a
  Monday-first working-days bitmap (displayed as Daily / Mon–Fri /
  Weekends / custom).
- "Show inactive" toggle reveals retired shift definitions; each column
  header has Edit.
- Management staff linked to admin accounts appear in an "Always on duty
  — 24×7" strip, never shift-bound.

### 6.7 Attendance (`AttendanceBoard`)

- Per-day status board with a date picker (defaults to today, IST) and a
  refresh; auto-refreshes every 60 s while viewing today.
- Metric strip: on floor, absent, late, needs review, and the configured
  operational-day start.
- Table per employee: shift name + scheduled window, status badge
  (Working, On break, Completed, Absent, Awaiting, Scheduled, Off day,
  Incomplete, Not scheduled), clock-in/out times, and flags (Late,
  On time, Early exit, unscheduled clock-in, needs review).

### 6.8 Live Location (`LiveLocationMap`)

- Leaflet map (OpenStreetMap tiles) with marker clustering — co-located
  staff collapse into numbered clusters that spiderfy at max zoom.
- Polls every 10 s (matching the device fix cadence). Markers are keyed
  by employee and smoothly updated, created, or removed — never needlessly
  re-rendered.
- Only clocked-in staff appear; duty state comes from attendance
  (Working / On break / Off duty / Unknown badge), never inferred from
  GPS. Entries the API marks stale/offline render no marker.
- Tooltips show name, zone, and fix age ("Xs ago").
- Filters: employee, zone (property context is implicit). Selecting an
  employee focuses the map; selecting an offline employee triggers a
  single stale-capable lookup for their detail panel.
- The detail panel shows the employee's fix age, coordinates, timestamps,
  GPS **quality badge** (Valid, Low accuracy, Delayed, GPS jump — each
  with an explanatory hint), and work status.
- **History**: pick a from/to window (≤ 31 days) to draw the employee's
  route polyline (green start marker → red end marker); clicking a point
  opens a popup with capture time and quality.
- Viewport behavior: auto-fits live staff on membership changes, yields
  to manual pan/zoom, and a Recenter control restores auto-fit.
- Last-sync timestamp is shown; failures degrade to an error state with
  retry rather than tearing down the map.

---

## 7. Tasks (`/property/:uid/tasks`)

`frontend/src/components/tasks/TasksView.tsx` hosts tabs: **Today's
Tasks**, **Today's Abandoned**, **Review**, **Maintenance**, **Task
History**, and a staff-only **Calendar**.

### 7.1 Today's Tasks (`TodayTasksView`)

- Live list of today's work — mixes *scheduled* occurrences (recurring/
  template-driven work not yet generated) with *generated* task
  instances.
- Search, zone filter, source filter, and an All / Unassigned scope
  toggle.
- **Generate Now** forces immediate generation of due scheduled work.
- Polls every 10 s (`usePolling`) so statuses update live.

### 7.2 Today's Abandoned (`AbandonedTodayView`)

- Everything abandoned *today* — keyed on the abandoned timestamp so
  stale work abandoned by the daily rollover still shows.
- Filters: search (title, ticket number, assignee, room), zone, and
  reason (Occurrence expired / Daily rollover / other).
- Each row shows abandoned-at time, task + ticket number, target, zone,
  assignee, the occurrence time, the reason badge, and the status it was
  abandoned from. **Open** jumps to the task detail drawer.

### 7.3 Review (`TaskReviewPanel`)

- Staff-only review queue for submitted employee completions.
- Each submission shows the task, the employee, submission notes, and
  evidence photos (click → full-size `CompletionEvidenceLightbox` with
  arrow-key navigation, thumbnails, and per-image delete with
  confirmation).
- Actions: **Approve** (task → completed) or **Reject / send back**
  (task → reopened for rework), both with optional review notes.
- Polls for fresh submissions.

### 7.4 Task History (`TaskHistoryView`)

- Server-side search + filters: date presets, zone, employee, status,
  priority, task type, and source; paginated results.
- Rows show title, ticket number, resource, zone, assignee, lifecycle
  timestamps, and status.

### 7.5 Calendar (`TaskCalendarView`, staff only)

- One cell per **operational day** of the month (keyed on the IST
  operational day, not the browser day), rendered by the shared
  `OperationalCalendar`.
- Each day shows generated count plus a colored strip — green completed /
  amber still-active / red abandoned.
- Clicking a day opens the Day Analysis page for that date.

### 7.6 Day Analysis (`/property/:uid/tasks/history/:date`)

`TaskDayAnalysisView` — everything that happened on one operational day:

- Summary stat cards: generated, allocated, completed, abandoned, active,
  completion rate, employees involved, resources processed.
- **Task breakdown** table: title + ticket + originating template,
  resource, zone/area, category, assigned → actually-worked employee,
  lifecycle timestamps (occurrence window, generated, allocated, started,
  done, abandoned + what it was abandoned from), and status with a
  rollover/occurrence-expired marker.
- **Employee performance** cards: per-employee completion rate, zones,
  allocated/done/abandoned/active counts, and their work item list.
- **Aggregates** by Zone, by Area, and by Category (each with
  generated/allocated/completed/abandoned and completion rate).

### 7.7 Create Task (`CreateTaskModal`)

- **Work types**: cleaning, maintenance, inspection, housekeeping, other.
- **Task types**:
  - *Fixed* — one-off task.
  - *Repetitive* — recurrence schedule: hourly, every 2/6/12 hours,
    daily, weekly, monthly, or a custom interval; optional daily time
    window; start/end run dates or run-forever.
  - *Automated* — fires on a trigger: room checked out, bed marked for
    cleaning (checkout), or bed becomes available after checkout
    cleaning; scope pickers for where it applies.
- Assignment: specific employee or supervisor.
- Targets: room, washroom, or zone; priority; due date/time.

### 7.8 Task Detail (`TaskDetailDrawer`)

- Full task metadata: title, ticket number, type, category, priority,
  status, due.
- Assignee + reassign control; lifecycle actions appropriate to status
  (start, complete, request redo, reopen).
- Recurrence/automation details when applicable.
- **Event timeline** of the task's history.
- **Completion evidence**: photo thumbnails per submission attempt,
  opened in the lightbox; images can be deleted (confirmed).
- Evidence upload limits: JPEG/PNG/WebP/HEIC, ≤ 10 MB each, up to 10
  images (`lib/mediaLimits.ts`).

### 7.9 Status vocabulary

Task statuses render with friendly labels: Open, Assigned, In Progress,
Pending Check (submitted), Returned for correction (reopened), Completed,
Cancelled, Abandoned, Overdue, Scheduled. An incomplete task past its due
time displays as *Overdue* without a stored status change
(`getEffectiveTaskStatus`).

---

## 8. Maintenance

Available both as the **Maintenance tab inside Tasks** and the dedicated
route `/property/:uid/maintenance`
(`frontend/src/components/maintenance/MaintenanceView.tsx`).

### 8.1 Live view

- All non-terminal tickets (Open, Assigned, In Progress, On Hold,
  resolved-but-awaiting-check).
- Search + status filter.
- Cards show ticket number (`MT-YYYY-NNNNN`), issue, type, priority
  (Low / Medium / High / Critical), status, location, and assignee.

### 8.2 History view

- Closed and cancelled tickets with the same search/filter surface.

### 8.3 Calendar (`MaintenanceCalendarView`)

- Operational-day month grid. Each cell shows *raised* and *carried*
  counts (tickets raised earlier but still open in that day's window —
  tickets persist across days), plus a resolved/closed vs cancelled strip.
- Clicking a day opens the Maintenance Day Analysis.

### 8.4 Day Analysis (`/property/:uid/maintenance/history/:date`)

`MaintenanceDayAnalysisView`:

- Summary: raised, carried-in, allocated, resolved, closed, cancelled,
  open-at-end, pending review (resolved awaiting close), completion rate
  of allocated work, employees involved, zones affected, average
  resolution time.
- **Ticket breakdown** table: issue + ticket number + "carried in" flag,
  resource, zone/area, type, assigned → worked, full lifecycle timestamps
  and resolution duration, resource state transitions it caused, and
  end-of-day vs current status.
- **Resource impact** cards: which resource each ticket touched and the
  before/after/current states it caused.
- **Employee** cards (tickets/closed/resolved/cancelled/open + avg
  resolution) and **aggregates** by zone, area, and category.

### 8.5 Create Maintenance (`CreateMaintenanceModal`)

- Targets: room, dorm, individual bed, or washroom — bulk multi-target
  selection supported (one ticket per unit, grouped into a work batch).
- Multiple complaints can be added per submission.
- 13 maintenance types (Electrical, Plumbing, Civil, Carpentry, HVAC/AC,
  Painting, Furniture, Appliance, Internet/Network, Water/Drainage,
  Cleaning Equipment, Safety/Security, Other), each with a curated list
  of common issues plus free text.
- Priority, due date, and photo evidence uploads (issue attachments).
- If an active ticket already exists on the target, the modal pivots to
  a view-ticket path instead of creating a duplicate.

### 8.6 Ticket lifecycle

From the ticket drawer in MaintenanceView:

- Assign / reassign to an employee.
- Start, Hold (with note), Resolve (notes + photo evidence), Close
  (approve), Disapprove (reopens with reason), Delete (confirmed).
- Event timeline of everything that happened to the ticket.
- Issue evidence and resolution evidence galleries.
- Room history panel — the target room's maintenance past.

Status flow as labeled in the UI: Open → Assigned → In Progress / On Hold
→ Pending Check (resolved) → Completed (closed) | Cancelled.

---

## 9. Templates (`/property/:uid/templates`)

`frontend/src/components/templates/TemplatesView.tsx` — recurring and
automated work definitions that generate tasks/maintenance on a schedule.

### 9.1 List

- Template cards show name, type, status, location scope, assignment
  summary, schedule summary, generated count, and next run.
- Card actions: view detail, edit, pause/activate, duplicate, archive;
  archived templates can be deleted.
- A premade **"Daily Occupied-Room Cleaning"** template ships ready-made:
  daily at 08:00 IST, targets all occupied rooms, auto-assigns via zone
  round-robin.

### 9.2 Create / Edit — `TemplateWizard`

A 7-step modal wizard (Back/Next with per-step validation and a stepper):

1. **Basics** — name, work type (Cleaning, Maintenance, Inspection,
   Housekeeping, Other — work type drives the category default and staff
   eligibility; legacy types are preserved), description, category,
   priority, duration.
2. **Assignment** — automatic (zone round-robin etc.) or explicit:
   individual employee, employee set, team, or department.
3. **Condition** — what the generated work applies to: resource kind
   (rooms, dorm beds, dorms, washrooms, rooms+beds, or common area),
   scope (whole property / an area / a zone / explicit unit picker), and
   occupancy filter (all / occupied / unoccupied). The wizard renders a
   human summary like "Applies to currently occupied rooms in Zone D —
   resolved against live occupancy when the task is generated."
4. **Schedule** — one-time date, or recurring: frequency (daily, weekly
   with weekday picks, monthly by day-of-month or relative day), time,
   timezone-aware (IST label).
5. **Instructions** — ordered checklist items (required or optional) with
   drag-to-reorder.
6. **Verify** — how completion is verified (checklist required, evidence).
7. **Review** — full summary; save as **Draft** or **Create/Activate**.

Also configurable: overdue behavior (mark overdue, notify supervisor /
property manager, auto-reassign, threshold minutes) and notification
toggles.

### 9.3 Detail Drawer (`TemplateDetailDrawer`)

- Header: name, type, version, creator, status badge.
- Actions: pause/activate/archive and **Run Scheduler** (force-generates
  due work and reports the count).
- Stats: generated count, next run (IST), checklist size.
- Configuration summary (assignment mode, location scope/target,
  schedule, priority, duration) and the checklist.
- **Generated work** feed: the tasks and maintenance tickets this
  template produced (ticket number, title, assignee, status) — up to 30
  shown.

---

## 10. Profile (`/property/:uid/profile`)

`frontend/src/components/profile/ProfileView.tsx`:

- Identity card: initials avatar (dark for super admin, green for staff),
  name, role badge, `@username`, UID.
- Details: name, username, phone, email, and operational **scope** —
  company name for super admin, assigned property for managers,
  property + zone for zone-scoped users.
- **Edit Details** form for name, phone, email (username and scope are
  not editable here).

---

## 11. Shared UI Behaviors

Cross-cutting surface details worth knowing:

- **Lazy loading & skeletons**: heavy workspace views load on demand with
  `React.lazy`; `Suspense` renders skeleton placeholders
  (`components/ui/Skeleton.tsx`), and `WorkspaceGate` shows a retryable
  error card when data fails to load.
- **Polling**: today's tasks, abandoned list, and the review queue refresh
  every 10 s via `usePolling`; the live map polls every 10 s; the
  attendance board refreshes every 60 s on today's view.
- **Confirmation dialogs**: every destructive or state-changing action
  (deletes, checkout, bulk deletes, occupancy release) uses
  `ConfirmationDialog` with an entity-specific impact message.
- **Modals & drawers**: creation/edit flows live in `Modal` shells;
  detail views (task, template) slide in as drawers; evidence opens in a
  keyboard-navigable lightbox.
- **Filters & search**: every list view carries some combination of
  search, zone, status, reason, and date filters; bulk-selection toolbars
  appear contextually.
- **Toasts**: all mutations surface success/error toasts via `addToast`;
  API errors carry server messages through `ApiError`.
- **IST discipline**: dates, times, calendars, "Today/Yesterday" labels
  all render in IST regardless of browser timezone (`lib/datetime.ts`).
- **Media**: evidence images render same-origin via `mediaUrl`; uploads
  are validated for type/size client-side before POSTing.
- **Mobile**: responsive layouts throughout — nav collapses to a drawer,
  grids reflow, tables scroll horizontally.
- **Dev tooling**: `dev/perf.ts` + `React.Profiler` in `App.tsx` provide
  render instrumentation in development.

---

## 12. Route Map

| Path | Surface |
|---|---|
| `/` | Landing page |
| `/login`, `/signup` | Auth |
| `/admin/properties` | Property portfolio (super admin) |
| `/admin/settings` | Organization settings (super admin) |
| `/property/:uid` | → redirects to `zones` |
| `/property/:uid/zones` | Areas & zones + zone workspace |
| `/property/:uid/rooms` | Rooms / Dorms / Washrooms / Allocation tabs |
| `/property/:uid/employees` | Staff board, directory, leaves, shifts, attendance, live map |
| `/property/:uid/tasks` | Today, abandoned, review, maintenance, history, calendar |
| `/property/:uid/tasks/history/:date` | Task day analysis |
| `/property/:uid/maintenance` | Maintenance workspace |
| `/property/:uid/maintenance/history/:date` | Maintenance day analysis |
| `/property/:uid/templates` | Work templates |
| `/property/:uid/profile` | User profile |

---

## Appendix — Component Index

Source: `frontend/src/components/`

| Area | Files |
|---|---|
| Admin | `admin/AdminSettingsView.tsx` |
| Auth | `auth/Login.tsx`, `Signup.tsx`, `FormField.tsx`, `PasswordInput.tsx` |
| Landing | `landing/` — header, footer, hero, features, operations, roles, preview, CTA |
| Navigation | `navigation/Header.tsx` |
| Properties | `properties/PropertiesView.tsx`, `CreatePropertyModal.tsx` |
| Zones | `zones/ZonesView.tsx`, `ZoneWorkspace.tsx`, `CreateAreaModal.tsx`, `CreateZoneModal.tsx` |
| Units | `rooms/RoomsDormsView.tsx`, `UnitZoneBoard.tsx`, `OccupancyToggle.tsx`, `RequestItemModal.tsx`, room/dorm/washroom create·bulk·edit modals, `WashroomsView.tsx`, `WashroomDetailModal.tsx`, `AssignWashroomTaskModal.tsx`, `ScheduleWashroomMaintenanceModal.tsx` |
| Employees | `employees/EmployeesView.tsx`, `ZoneBoard.tsx`, `EmployeeDirectory.tsx`, `CreateEmployeeModal.tsx`, `LiveLocationMap.tsx`, `LeavesPanel.tsx`, `ShiftManager.tsx`, `AttendanceBoard.tsx` |
| Tasks | `tasks/TasksView.tsx`, `TodayTasksView.tsx`, `AbandonedTodayView.tsx`, `TaskReviewPanel.tsx`, `TaskHistoryView.tsx`, `TaskCalendarView.tsx`, `TaskDayAnalysisView.tsx`, `TaskDetailDrawer.tsx`, `CreateTaskModal.tsx`, `CompletionEvidenceLightbox.tsx` |
| Maintenance | `maintenance/MaintenanceView.tsx`, `CreateMaintenanceModal.tsx`, `MaintenanceCalendarView.tsx`, `MaintenanceDayAnalysisView.tsx` |
| Templates | `templates/TemplatesView.tsx`, `TemplateWizard.tsx`, `TemplateDetailDrawer.tsx` |
| Profile | `profile/ProfileView.tsx` |
| Shared UI | `ui/` — Button, Badge, Card, Modal, Drawer, ConfirmationDialog, OperationalCalendar, Skeleton, ToastContainer, BackButton |
