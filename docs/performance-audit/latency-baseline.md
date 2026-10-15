# Latency Baseline (measured 2026-10-15)

Test conditions: local uvicorn (1 worker) → Supabase transaction pooler
:6543 (~12.5 ms warm RTT, ~116 ms median fresh-connect from this
machine). 15 runs/endpoint unless noted; medians reported; full percentiles
in `data/api-probe-20261015-070528.json`. Super-admin session, company
`7646dbe4…`, property `159247f6…` (≈15 rooms, 16 tasks, 3 employees — small
tenant; latency scales with row counts).

## Endpoint table (sequential calls)

| Endpoint | status | server p50 | server p95 | db_ms p50 | dbq | payload |
|---|---|---|---|---|---|---|
| GET /auth/me | 200 | 48 | 321* | 34 | 1 | 0.6 KB |
| GET /properties | 200 | 75 | 117 | 61 | 2 | 0.5 KB |
| GET /areas | 200 | 77 | 279 | 62 | 2 | 0.3 KB |
| GET /zones | 200 | 62 | 97 | 51 | 2 | 0.6 KB |
| GET /rooms | 200 | 112 | 336 | 93 | 3 | 7.6 KB |
| GET /dorms | 200 | 131 | 201 | 120 | 4 | 2.2 KB |
| GET /washrooms | 200 | 110 | 604 | 97 | 3 | 1.7 KB |
| GET /employees | 200 | 70 | 895* | 58 | 2 | 2.0 KB |
| GET /tasks?limit=500 | 200 | 122 | 286 | 109 | 4 | 25 KB |
| GET /maintenance | 200 | 118 | 151 | 103 | 4 | 2.9 KB |
| GET /tasks/today?property_uid | 200 | 194 | — | 180 | 7 | — |
| GET /tasks/history?property_uid | 200 | 139 | — | 126 | 5 | — |
| GET /tasks/calendar?property_uid&month | 200 | 108 | — | 94 | 3 | — |
| GET /tasks/review-queue?property_id | 200 | 91 | — | 80 | 3 | — |
| GET /attendance/status-board?property_id | 200 | 155 | — | 143 | 6 | — |
| GET /shifts?property_id | 200 | 75 | — | 64 | 3 | — |
| GET /attendance/requests | 200 | 78 | — | 65 | 2 | — |
| **GET /live-locations** | 200 | **727–886** | 1001 | 57–63 | 2 | **ext 373–571** |

*p95 outliers are first-call/pool-growth artifacts at n=15; medians are
steady-state.

## Per-query cost anatomy

`db_ms ≈ dbq × ~30 ms` — each SQL statement currently costs ~2 remote
round-trips (fresh `Parse` + `Bind/Describe/Execute` on every query; see
B-01). Before the B-01 fix, prepared-statement reuse made statements ~1
RTT (~12–15 ms) but intermittently 503'd.

Non-DB server time (auth decode, service logic, dict serialization,
gzip) is ~10–20 ms per request — small vs the DB term.

## User-journey baselines (local client → local API → remote DB)

| Journey | Requests | Measured |
|---|---|---|
| Session restore | 1 (auth/me) + 9 parallel lists | burst wall p50 694 ms, p95 1286 ms; per-req server p50 341–678 ms under concurrency |
| Open property layout | served from context (0 extra) + 20 s polls | 5 GETs/tick |
| Task list view | context + /tasks/today (10 s poll) | today: 194 ms srv |
| Live location map | /live-locations ×6/min | 730–890 ms each |
| Attendance board | /attendance/status-board (60 s poll) | 155 ms srv |
| Review queue | /tasks/review-queue (30 s poll) | 91 ms srv |

## Latency attribution — GET /live-locations (typical)

| Stage | ms |
|---|---|
| JWT decode + auth query | ~34 |
| Scope validation queries | ~25 |
| **SA→EB call (fresh TLS+TCP+Railway edge)** | **~430–570** |
| Serialize + gzip + response | ~5–10 |
| Server total | ~730–890 |
| Client-side delta (fetch, JSON parse) | ~2–5 |

## Verification re-run (2026-10-15 10:29Z)

Re-probed the same endpoints (n=10, warm pool, same super_admin/company):
all core list endpoints within ±20% of the table above (`/rooms` 109 ms,
`/dorms` 146, `/tasks?limit=500` 168, `/maintenance` 192.5,
`/live-locations` 705.5 — still the outlier). Workspace burst wall
median dropped to **207 ms** (p95 675) with a fully warm pool — the
earlier 694 ms figure includes cold-connection growth. Property-scoped
endpoints (`/tasks/today`, `review-queue`, `status-board`, `/shifts`)
were not re-run (probe needs explicit property args). Data:
`data/api-probe-20261015-102925.json`,
`data/db-probe-20261015-102742.json` (fresh-connect 76 ms median,
warm RTT 17.7 ms, 8 sessions; pg_stat lock-wait outliers unchanged —
they are cumulative server stats).

## Unavailable measurements

- Browser→Vercel→Railway production path latency (SA API public URL is
  configured in Vercel env, not the repo).
- Production DB RTT from the Railway service (needs an in-service probe).
- React render/commit times — `src/dev/perf.ts` Profiler hooks exist
  ([RENDER] lines) but need a browser session to capture.
- Write-path latency (mutations were not executed against the shared
  production database).
