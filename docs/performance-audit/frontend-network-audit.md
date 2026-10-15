# Frontend Network Audit

Source: `src/api/client.ts`, `src/context/AppContext.tsx`, view-level
greps, `vite build` output, existing `src/dev/perf.ts` instrumentation.

## Request volume per journey

| Journey | Requests fired | Notes |
|---|---|---|
| Cold load → login | bundle + POST /auth/login + GET /auth/me + 9 list GETs | 9-way parallel burst (Promise.all) |
| Session restore (warm) | 1 + 9 | same burst; no conditional/partial loads |
| Property layout view | 0 extra (context) | all collections already in memory |
| Tasks view | context + /tasks/today + (Review tab: /tasks/review-queue) | 10 s + 30 s polls while mounted |
| Employees → Live Location | /live-locations every 10 s | ~730–890 ms each; no visibility pause |
| Employees → Attendance | /attendance/status-board every 60 s | no visibility pause (raw setInterval) |
| Mutations | 1 write + refreshUnits scope (1–5 GETs) | dedup'ed via refreshUnitsInFlight union |

## Polling inventory (per signed-in client, all ticks eligible)

| Poller | Interval | Requests/tick | Pauses hidden? |
|---|---|---|---|
| AppContext.refreshUnits | 20 s | 5 (rooms,dorms,washrooms,tasks,maintenance) | yes (usePolling) |
| LiveLocationMap | 10 s | 1 (proxied → EB, ~700 ms) | **no** |
| TodayTasksView | 10 s | 1 | yes |
| AbandonedTodayView | 10 s | 1 | yes |
| TaskReviewPanel | 30 s | 1 | yes |
| AttendanceBoard | 60 s | 1 | **no** |

Worst-case background rate ≈ **36 req/min/client**; typical property page
≈ 15–21 req/min. With N staff per property this multiplies identically —
all clients pull the same full collections independently.

## Findings

1. **Bootstrap burst cost**: 9 parallel full-table GETs; server-side
   concurrency amplification raises per-request times ~5× vs sequential
   (srv p50 341–678 ms vs 62–131 ms). Wall p50 694 ms locally.
2. **No deduplication across views** — the same 5 collections are
   re-pulled every 20 s globally AND any mutation can trigger extra list
   calls (e.g. `createProperty`→employees list, `updateZone`→rooms+dorms,
   deletes→full 9-GET reload).
3. **`/live-locations` is the single most expensive poll** (~0.7–0.9 s)
   and runs while the tab is hidden.
4. **`tasks?limit=500` is decorative** — backend ignores limit in SQL;
   payload already 25 KB @ 16 tasks. Will degrade linearly.
5. No client-side caching/ETag — every poll is a full payload
   (`If-None-Match` would cut most polls to ~304 responses).
6. **Bundle is healthy**: main 303 KB (88 KB gz); EmployeesView
   (Leaflet) 263 KB lazy; route-level React.lazy in place.
7. `apiFetch` does NOT send `X-Request-ID` — request correlation relies
   on minted ids; minor observability gap.
8. Refresh-token retry path is well-formed (single flight, once).

## Opportunities (evidence-ordered)

- Consolidate the 9 list GETs into one `/workspace` aggregate (1 request,
  one DB session, one serialization) — directly attacks measured burst
  amplification.
- Conditional requests on the 20 s unit poll (`ETag`/`If-None-Match`
  per collection hash) — most ticks return identical data.
- Pause LiveLocationMap + AttendanceBoard polls when `document.hidden`
  (reuse `usePolling`).
- Real pagination for `/tasks` + `/maintenance` before tenants grow.
