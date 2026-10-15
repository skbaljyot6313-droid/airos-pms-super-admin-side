# Critical User Journeys & API Dependencies

Measured values come from `latency-baseline.md` (local app → remote DB,
small tenant). "Reqs" counts HTTP calls; "DB q" counts SQL statements
per request.

## J1 — Cold login → usable dashboard

| Step | Trigger | Reqs |
|---|---|---|
| Static shell | Vite bundle + lazy route chunks | main 303 KB (88 KB gz) + view chunks |
| `POST /auth/login` | credentials | 1 (bcrypt/argon2 verify + 2 DB q) |
| `GET /auth/me` | session hydrate | 1 (1 DB q) |
| `loadWorkspace()` | 9 parallel GETs: properties, areas, zones, rooms, dorms, washrooms, employees, tasks?limit=500, maintenance | 9 (2–4 DB q each) |

Measured: burst wall p50 ~694 ms, p95 ~1.29 s; per-req srv p50
341–678 ms under the burst (vs 62–131 ms solo — B-04 amplification).
**Controllable part:** request count + per-query RTT (B-02) + auth query
(B-05).

## J2 — Session restore (refresh)

`GET /auth/me` + same 9-GET burst. No conditional requests — identical
cost to cold login minus the credential step.

## J3 — Property layout view

Zero new requests (all collections in context). Renders instantly;
freshness guaranteed only by the 20 s `refreshUnits` poll (5 GETs/tick:
rooms, dorms, washrooms, tasks, maintenance).

## J4 — Tasks tab

- Mount: `GET /tasks/today?property_uid=…` (srv p50 194 ms, 7 q) +
  10 s poll while mounted.
- Review tab: `GET /tasks/review-queue?property_id=…` (91 ms, 3 q) +
  30 s poll.
- Approve/reject mutations → write + `refreshUnits` scope.

## J5 — Live Location map

`GET /live-locations` every 10 s, **no hidden-tab pause**.
Each call: auth + scope DB (~57 ms) + **fresh TLS→Railway EB call
(~430–570 ms)** = 730–890 ms. Highest per-request cost in the app (B-03).

## J6 — Attendance board

`GET /attendance/status-board?property_id=…` (155 ms, 6 q) every 60 s —
also a raw `setInterval`, runs while hidden (B-09).

## J7 — Employee list / details

Served from context (the 2 KB `/employees` list). Detail views add no
requests — fast path already.

## J8 — Mutations (create/update/delete, assignments)

One write request + a `refreshUnits` scope (1–5 GETs) or full 9-GET
reload for structural deletes. Mutation→refresh attribution exists via
`m*` correlation ids in `perf.ts`.

## API dependency map

```
Browser ─┬─ GET /api/v1/{properties,areas,zones,rooms,dorms,washrooms,
         │                employees,tasks,maintenance}          → Postgres
         ├─ GET /api/v1/auth/me                                 → Postgres (users)
         ├─ GET /api/v1/tasks/{today,history,calendar,review-queue} → Postgres
         ├─ GET /api/v1/attendance/{status-board,requests}       → Postgres (shared w/ EB)
         ├─ GET /api/v1/shifts                                   → Postgres (shared w/ EB)
         ├─ GET /api/v1/live-locations[/*]                       → Postgres (scope check)
         │                                                       └→ Railway Employee API
         │                                                          (fresh TLS each call)
         └─ POST /api/v1/media/...                               → Supabase Storage S3

Background (same process): scheduler tick 60 s →
   expire_due + template.run_due + run_due_repetitive + rollover.run
   (every 15th tick: reconcile_property per property — ~400–600 q)
Post-commit hook: allocation notify → EB /admin/notify-allocation
   (fire-and-forget, timeout-capped, never blocks response)
```

**Synchronous dependency chain per request:**
browser → Vercel CDN → Railway edge → uvicorn → auth(JWT+users table) →
service → repository → asyncpg pool → pgbouncer :6543 → Postgres.
Only `/live-locations*` adds a second service hop.
