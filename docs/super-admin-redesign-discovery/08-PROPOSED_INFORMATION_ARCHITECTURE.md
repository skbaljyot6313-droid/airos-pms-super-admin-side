# 08 — Proposed Information Architecture

Builds on the current five-destination shell (Overview · Workforce · Property · Operations · Insights, plus Administration). Changes are proposals for review; nothing is applied.

## 1. Principles applied

1. Keep five primary destinations; do not add a sixth at the top level.
2. Every secondary item must answer one question for one role.
3. Put sensitive HR surfaces behind explicit authorisation, not behind hidden links.
4. Move analytics out of the "directory of links" Insights page into real analysis, with Audit as a tab.
5. Remove duplicate entry points (e.g. two Logs routes, three department summaries).
6. Limit each secondary bar to ≤ 6 items; move overflow into a page-level tab row.

## 2. Proposed tree

```
Overview                              (Super Admin, Property Manager)
  └ Overview                          KPI strip · today's exceptions · completion trend · staffing gaps

Workforce                             (SA, PM)
  ├ Dashboard                         workforce composition, department distribution
  ├ Employees                         directory · zone allocation · live map   [tabs]
  ├ Departments                       directory · detail · heads · transfers
  ├ Attendance & Leave                day status · requests · balances*  · holidays*
  ├ Scheduling                        shifts · roster · coverage*
  ├ Analytics                         team · department · attendance* · utilisation*
  └ HR                                compensation* · payroll* · documents* · lifecycle*   [restricted]

Property                              (SA, PM)
  ├ Spaces                            zones & areas · units (rooms/dorms/washrooms)   [tabs]
  ├ Occupancy                         check-in/out · beds · guest switch              (currently inside Units)
  ├ Resources                         states · cleaning lifecycle · fixtures · repairs (currently inside Units)
  └ Video                             live grid · cameras · settings                   [tabs]

Operations                            (SA, PM)
  ├ Tasks                             board (today) · abandoned · history · calendar  [tabs]
  ├ Reviews                           queue · turnaround · decisions
  ├ Maintenance                       tickets · calendar · day analysis
  └ Templates                         templates · lifecycle · generation log

Insights                              (SA, PM; audit SA-only)
  ├ Operations                        completion · abandon · turnaround · maintenance trends
  ├ Workforce                         department comparison · attendance trend · distribution
  ├ Activity & Audit                  activity feed · task journeys · attachments     (SA only)
  └ System                            reconciliation · camera health · data-quality checks (SA only)

Administration                        (SA only, profile menu)
  ├ Properties                        table with status and activity
  ├ Settings                          company profile · operational day · system health
  └ Logs                              → redirects to Insights › Activity & Audit
```

`*` = new capability, dependent on data work in `06` / `09`.

## 3. Where each current item lands

| Current location | Proposed location | Change |
|---|---|---|
| Overview tiles | Overview › Overview | Add trends; remove duplicated department list |
| Workforce › Dashboard | Workforce › Dashboard | Convert cards to table + bars |
| Employees › Board/Directory/Live/Deactivated | Workforce › Employees | Keep tabs; deactivated becomes a status filter |
| Employees › Leaves | Workforce › Attendance & Leave | Moved |
| Employees › Attendance | Workforce › Attendance & Leave | Moved |
| Employees › Shifts | Workforce › Scheduling | Promoted |
| Employees › Analytics | Workforce › Analytics | Moved; team view kept |
| Employee detail (6 tabs) | Workforce › Employees › [person] | Sensitive fields moved to HR section |
| Departments (list/detail) | Workforce › Departments | Unchanged placement |
| Units (Rooms/Dorms/Washrooms/Zones) | Property › Spaces and Property › Occupancy and Property › Resources | Split by purpose |
| Video (VMS, camera settings) | Property › Video | Add health summary |
| Tasks (7 tabs) | Operations › Tasks / Reviews / Maintenance / Templates / History | Split into four destinations |
| Maintenance tab (in Tasks) | Operations › Maintenance | Own destination |
| Templates tab (in Tasks) | Operations › Templates | Own destination |
| Insights (link directory) | Insights › Operations / Workforce | Replace with analysis |
| Logs (`/admin/logs`) | Insights › Activity & Audit (SA) | Single screen; old route redirects |
| Properties / Settings | Administration | Keep |

## 4. Note on Operations split

The Tasks page currently mixes board, review, maintenance and templates. Splitting into four secondary items adds one more item to the bar. To stay within six items, **History and Calendar** should merge into a single "History" with a view toggle, and **Reviews** should appear as a count badge on the Tasks item rather than as a separate item if the team prefers five items. Decision required (`09` lists it).

## 5. Where HR sits and why

- HR is a **Workforce** child, not a sixth top-level destination, because it shares the employee record, departments and attendance.
- Visibility: the HR item is rendered only when the user holds an HR scope (see `05` §F). Super Admin sees it by default.
- Compensation fields are never rendered in Employees or Analytics; they appear only in HR.
- If HR grows beyond ~6 pages, promote it to its own top-level destination; design the route prefix `/workforce/hr/…` now so it can move without redirects in the URLs users have bookmarked.

## 6. Route map (proposal)

| Route | Destination |
|---|---|
| `/property/:uid/overview` | Overview |
| `/property/:uid/workforce/dashboard` | Workforce › Dashboard |
| `/property/:uid/workforce/employees[/:uid]` | Employees |
| `/property/:uid/workforce/departments[/:uid]` | Departments |
| `/property/:uid/workforce/attendance` | Attendance & Leave (`?tab=day|requests|balances`) |
| `/property/:uid/workforce/scheduling` | Scheduling |
| `/property/:uid/workforce/analytics` | Analytics |
| `/property/:uid/workforce/hr[/…]` | HR (restricted) |
| `/property/:uid/property/spaces` | Spaces |
| `/property/:uid/property/occupancy` | Occupancy |
| `/property/:uid/property/resources` | Resources |
| `/property/:uid/property/video[/:tab]` | Video |
| `/property/:uid/operations/tasks` | Tasks (`?tab=board|abandoned|history|calendar`) |
| `/property/:uid/operations/reviews` | Reviews |
| `/property/:uid/operations/maintenance[/history/:date]` | Maintenance |
| `/property/:uid/operations/templates` | Templates |
| `/property/:uid/insights/operations` | Insights › Operations |
| `/property/:uid/insights/workforce` | Insights › Workforce |
| `/property/:uid/insights/audit` | Activity & Audit (SA) |
| `/property/:uid/insights/system` | System (SA) |
| `/admin/properties`, `/admin/settings` | Administration |
| `/admin/logs` | Redirect → `/property/:uid/insights/audit` |

Legacy routes from the current shell remain as redirects (the existing `LegacyRedirect` pattern preserves params and query strings).

## 7. Navigation problems this resolves

- Eight tabs in Employees → split across Employees, Attendance & Leave, Scheduling, Analytics.
- Seven tabs in Tasks → four destinations.
- Logs reachable from two routes → one screen.
- Insights as a link list → analytical destinations.
- Sensitive fields on general profile → HR section.

## 8. Open decisions

1. Five or six secondary items under Operations (Reviews as a separate item or a badge on Tasks).
2. Whether Scheduling is its own item or stays under Workforce › Attendance & Leave until shifts are populated (current data: 0 shifts).
3. Whether Occupancy and Resources are separate items or one "Units" destination.
4. HR visibility rule: role-based (SA only at first) or scoped grant.
