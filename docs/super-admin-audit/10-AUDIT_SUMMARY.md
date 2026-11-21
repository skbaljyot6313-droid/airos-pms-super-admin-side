# 10 — Audit Summary

Comprehensive inventory of the AiROS Super Admin app (audited 2026-11-19). All counts derived from source (`App.tsx`, `api/v1/*`, components).

## Totals

| Metric | Count |
|---|---|
| Frontend routes (`<Route>`) | 20 (18 concrete + `…/va` redirect + `*` catch) |
| Page-level components | 19 |
| Property-scope routes | 14 |
| Admin-scope routes | 3 |
| Public routes | 3 |
| Top-level nav modules | 7 (property) + 3 (admin) |
| In-page tab systems | 4 (Employees 8 tabs, Tasks 7, Rooms 3, VA 2) |
| Total nested tab views | ~20 |
| Modals/drawers | ~25 |
| Backend routers | 11 (+9 workspace sub-routers) |
| Backend endpoints | 169 |
| Granular features | ~48 blocks, ~120 atomic capabilities |
| Permission-controlled surfaces | ~all property/admin routes (only public 3 exempt) |
| Roles with actual surface | 2 of 5 defined (SA, PM) |
| Overlapping/fragmented groups | ~6 consolidation candidates |
| Hidden/API-only features | ~15 |
| Legacy/transitional | 4 (2 route shims, dept text field, unused roles) |

## Application shape

- React/Vite SPA, flat routes via `PropertyScopedView` switch — no nested layouts.
- Two modes: **admin** (company, SA) and **property** (SA/PM).
- FastAPI monolith, ~169 endpoints under `/api/v1`, Staff (SA+PM) workspace dep + SA-only admin/logs.
- Heavy feature density under **Employee Management** (~15 sub-views) and **Tasks** (~9) — the two biggest modules.

## Navigation hierarchy (actual)

```
Public: / | /login | /signup
Admin (SA): Properties | Settings | Logs
Property: Zones | Employee Management {Dashboard, Employees{board,directory,deactivated,live,leaves,shifts,attendance,analytics}, Departments{detail}} | Rooms{rooms,dorms,washrooms} | Tasks{today,abandoned,review,maintenance,templates,history,calendar} | VA{vms,camera-settings} | Profile
```

## Major structural findings

1. **Feature-dense flat nav** — 7 property nav items hide ~20 tab views; deepest capabilities (shifts, leaves, live map, dept transfers) reachable only via tab + drill-in, not URL.
2. **Maintenance & Templates buried in Tasks** — separate backend domains surfaced only as task tabs; legacy `/maintenance` & `/templates` now redirect shims.
3. **Employee module is a mini-app** — dashboard + 8 staff tabs + dept mgmt + per-employee 7-tab detail ≈ 15 screens under one nav item → strongest consolidation candidate into a structured hub.
4. **Two nav layers, no breadcrumbs** — Header (top) + per-page tab strips; only `BackButton` for hierarchy.
5. **Unused roles** — HR & department_manager defined but have zero surface.
6. **Backend-only tools** — reconciliation, work-batches, fresh-day, audit — no UI.
7. **"VA" label** cryptic vs CCTV/Video Analytics.

## Consolidation opportunities (no deletions)

- Employee hub: unify dashboard + staff tabs + departments + detail.
- Operations hub: group Tasks + Maintenance + Templates + Zones/fresh-day + resource states.
- Insights/Reports: group day analyses + team analytics + employee analytics + logs.
- System/Ops: group admin settings + logs + reconciliation + media health.

## Areas needing verification

- Whether HR/DM roles are intentionally reserved for future surface.
- `GET /media` vs `/media/file/{key}` — two media read paths.
- Completeness of `logs/attachments` coverage across evidence types.
- Company PATCH — no dedicated edit UI located.

## Deliverables

`docs/super-admin-audit/` — 01 architecture, 02 routes, 03 features, 04 navigation, 05 API map, 06 overlap, 07 orphaned, 08 permissions, 09 catalogue, 10 summary.
