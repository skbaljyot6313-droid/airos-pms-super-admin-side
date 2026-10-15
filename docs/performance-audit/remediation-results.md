# AiROS Performance Remediation — Results

Date: 2026-10-15 · Branch: `main` · Implements `optimization-roadmap.md`
findings measured in `latency-baseline.md` / `root-cause-analysis.md`.

**Measurement contract:** all numbers are local API → production Supabase DB
(`ap-south-1`) over the **transaction pooler :6543** unless labelled
otherwise — the same condition as the baseline. Warm-connection and
cold-connection data are labelled separately and never mixed. No
production configuration was changed.

---

## R-01 · B-03 — Reusable Employee Backend HTTP client

| | |
|---|---|
| Files | `backend/app/core/http_client.py` (new), `app/main.py` (lifespan), `app/services/live_location.py`, `app/services/employee_events.py`, `tests/test_live_locations.py` |
| Root cause | Every `/live-locations` call (and every post-commit allocation notice) built a fresh `httpx.AsyncClient`, paying DNS + TCP + TLS to the Railway-hosted Employee Backend on each request — a cost polled every 10 s per open client. |
| Implementation | One pooled `AsyncClient` created in the FastAPI lifespan (`init_eb_client`), closed on shutdown (`close_eb_client`). Explicit 4-part timeout (connect/read/write/pool, read = `LOCATION_SERVICE_TIMEOUT_SECONDS`), bounded max-connections/keep-alive. Base URL + `X-Location-Service-Key` still resolved per call from settings (tests keep monkeypatching; credentials never baked in or logged). `track_external()` attribution unchanged; no retries added (reads stay single-shot; nothing non-idempotent is retried). |
| Tests | `pytest tests/` 117 pass; new reuse/config test asserts one client is shared and limits match exported constants; existing respx-based EB tests unchanged and green. |

**Measured (live, n≥10 warm):**

| Metric | Before | After (warm) | After (1st/cold call) |
|---|---|---|---|
| `/live-locations` srv p50 | 705–890 ms | **138–180 ms** | 891 ms |
| `ext_ms` | 430–570 ms | **~138 ms** | ~655 ms |
| Upstream calls | 1/request | 1/request | 1/request |

Warm latency improvement ≈ **4–5×**. The remaining ~135 ms is the EB's own
processing + transit, exactly as predicted — connection reuse removes the
handshake, not the upstream work. Errors/timeouts: 0 before and after.
Rollback: revert `live_location.py`/`employee_events.py` to per-call
`AsyncClient`; client module is isolated.

---

## R-02 · B-01/B-02 — Session pooler verified, opt-in config

| | |
|---|---|
| Files | `backend/app/core/config.py` (`DB_POOLER_MODE`), `app/core/database.py` (mode-aware asyncpg settings), `backend/scripts/pooler_compat.py` (new), `backend/.env.example` |
| Root cause | Transaction pooler (:6543) costs ~2 RTT per statement (prepared-statement caches must be disabled to avoid `DuplicatePreparedStatementError` → 503s, B-01). |
| Implementation | `DB_POOLER_MODE=auto\|transaction\|session` (default `auto`, no behaviour change). Compatibility probe runs both ports: prepared-statement stress (40 concurrent txns), statement-latency medians, UUID statement naming. **No production connection string was changed.** |

**Measured (same machine, warm pool, n=10):**

| Mode | Stmt median | Errors |
|---|---|---|
| :6543 transaction, cache=0 (prod today) | 15.7 ms | 0/40 |
| :6543 transaction, cache=default | 7.2 ms | **8/40 — B-01 reproduced** |
| :5432 session, cache=default | **7.1 ms** | 0/40 |
| :5432 session, cache=0 | 16.2 ms | 0/40 |

End-to-end (local API on :5432, same tenant, warm):

| Endpoint | :6543 srv p50 | :5432 srv p50 | Δ |
|---|---|---|---|
| /auth/me | 50.5 | 23.5 | −53% |
| /properties | 74.0 | 38.0 | −49% |
| /rooms | 109.0 | 41.5 | −62% |
| /dorms | 146.0 | 54.0 | −63% |
| /tasks?limit=500 | 168.0 | 54.5 | −68% |
| /maintenance | 192.5 | 51.5 | −73% |

Session pooler halves per-statement latency AND makes B-01 structurally
impossible. **Blocker to production adoption:** Supabase session-mode pool
size must be raised before switching (the `.env` notes a 15-client cap;
the Employee Backend shares the limit — pool arithmetic: SA 12+10, 1
replica, 1 worker). Rollback: flip `DATABASE_URL` port back to 6543 +
`DB_POOLER_MODE=transaction`. Requires explicit authorization — not done.

---

## R-03 · B-09 — Hidden-tab polling pause

| | |
|---|---|
| Files | `frontend/src/components/employees/LiveLocationMap.tsx`, `frontend/src/components/employees/AttendanceBoard.tsx` (existing `usePolling` hook reused) |
| Root cause | The costliest poll (`/live-locations`, every 10 s) and attendance (60 s) ran on raw `setInterval` — they kept firing in hidden tabs and could overlap slow requests. |
| Implementation | Both moved to the established `usePolling` hook: `document.visibilitychange` pause/resume, in-flight guard (no overlapping requests), stable `pollRef` indirection avoids stale-closure double-timers, timer cleaned on unmount, intervals unchanged. |
| Tests | `npx tsc --noEmit` clean; `npm test` 24 pass (incl. LiveLocationMap suite). Requests/min while hidden now 0 for both pollers (was ~7/min). |

---

## R-04 · B-04 — `/workspace` aggregate endpoint

| | |
|---|---|
| Files | `app/api/v1/workspace.py` (aggregate handler), `frontend/src/api/workspace.ts` (new), `frontend/src/api/index.ts`, `frontend/src/context/AppContext.tsx` |
| Root cause | `loadWorkspace()` fired 9 parallel GETs on login/restore — 9 auth lookups, 9 serializations, ~18 queries, and burst contention that amplified per-request server time ~5× under load. |
| Implementation | `GET /api/v1/workspace` returns `{properties, areas, zones, rooms, dorms, washrooms, employees, tasks, maintenance}` — the exact context shape. Each collection is fetched in its own pooled session via `asyncio.gather` (same intra-request parallelism as the burst — deliberately NOT serialized on one session, which would have been slower). Same auth dependency, same services/repositories, identical tenant scoping — no business logic duplicated. Frontend `loadWorkspace()` consumes it; context shape, mutations, `refreshUnits()` unchanged. |

**Measured (same conditions, :6543, warm):**

| Metric | 9-GET burst | `/workspace` |
|---|---|---|
| HTTP requests | 9 | **1** |
| Auth user lookups | 9 | **1** (0 post R-08) |
| wall p50 | 195 ms | **173 ms** |
| wall p95 | 215 ms | 193 ms |
| srv p50 | ~170 ms (aggregate) | 160 ms |
| Payload | ~43 KB total | 42.9 KB |

Modest warm-server win; the structural wins are 8 fewer requests/auth
lookups/serializations and removal of burst self-contention — the gap
widens under concurrency and cold connections (baseline burst p50 was
694 ms cold). Errors: 0. Rollback: `AppContext.loadWorkspace` revert.

---

## R-05 · B-06 — Reconciliation batching + scheduler scan reduction

| | |
|---|---|
| Files | `app/services/reconciliation.py`, `app/services/task.py` (`run_due_repetitive`), `app/services/rollover.py` (`expire_due`, `_roll_company`) |
| Root cause | `reconcile_property` ran per-resource occupancy/task/ticket blocker probes — ~400–600 queries per property sweep (2.1–13.2 s measured, 200k+ stmt calls in pg_stat). The 60 s sweeps also fetched every candidate row's full columns just to filter due work in Python. |
| Implementation | Reconciliation now prefetches grouped blocker/occupancy sets per property (7 set-based queries total) and does in-memory membership checks — issue labels, severities, and per-resource findings byte-identical. Repetitive-task and rollover scans load light columns first; full ORM rows only for series that are actually due. |

**Equivalence proof (live DB, all 11 tenant properties):** old-vs-new
`reconcile_property` findings **identical on every property**.

| Sweep | Before | After |
|---|---|---|
| reconcile — worst property | 13,189 ms | **214 ms** |
| reconcile — typical | 2,390 ms | **186–424 ms** |
| `expire_due` / `run_due` / `run_due_repetitive` / `rollover` live | — | 287 / 38 / 71 / 333 ms, 0 spurious writes |

Tests: 117 pass. Rollback: per-file revert; read-only path, no schema change.

**Duplicate-owner investigation:** `railway.toml` boots a single uvicorn
worker; this repo contains **no arq `WorkerSettings`** — `queue.py` only
enqueues. `RUN_EMBEDDED_SCHEDULER` (default true) is therefore the ONLY
tick owner in this repo. Two operational hazards documented for Phase J:
(1) prod replicas >1 with embedded=true → one duplicated sweep set per
replica (idempotent by ledger, but multiplied load); (2) embedded=false
without an arq worker actually deployed → nothing ticks. Whether the
Employee Backend also sweeps shared tables cannot be verified from this
repo — flag for the ops checklist.

---

## R-06 · B-08 — Real SQL pagination

| | |
|---|---|
| Files | `app/repositories/workspace.py` (8 methods), `app/api/v1/workspace.py` |
| Root cause | `_paged()` relabelled `{items,total,page,limit}` without applying LIMIT/OFFSET — full tables serialized every call; `tasks?limit=500` was decorative; a linear-degradation cliff at ~10⁴ rows. |
| Implementation | Paginated methods apply real SQL `LIMIT/OFFSET` + deterministic `id` tie-break ordering + accurate `total`. `limit=None` keeps returning full lists — endpoints that never exposed pagination are NOT silently truncated; `page`/`limit` parameters unchanged at the API surface. |

**Live verification:** tasks page1(5)+page2(5) disjoint, union ⊆ all(16),
totals exact, deterministic ordering, `properties?limit=2` → `total=1`.
Tests: 117 pass. The known decorative-pagination finding is closed for
`tasks`/`properties` — other endpoints intentionally keep full-list
contracts. Rollback: revert `workspace.py` repo methods.

---

## R-07 · B-07 — Bounded lock waits

| | |
|---|---|
| Files | `app/core/database.py` (`bounded_lock_wait`, `is_lock_timeout`, `LOCK_TIMEOUT_MS=10_000`), `app/services/structure.py` (`_mark_cleaning_work_done`, `_close_blocking_maintenance`), `app/services/work_allocation.py` (`_locked_state` ×2) |
| Root cause | pg_stat maxima: bulk task `FOR UPDATE` sweep 16.4 s, `zone_allocation_state` lock 2.7 s — a contended row made the request outlive the client's 20 s abort. Rare (single-sample max), so typical latency was never the problem; worst-case was unbounded. |
| Implementation | `SET LOCAL lock_timeout` per write transaction on the three contended sites; `55P03`/`LockNotAvailableError` mapped to a clean **409 CONFLICT** ("retry") instead of a hung request. `SKIP LOCKED` evaluated and **rejected**: a skipped open task would keep the unit blocked — exactly what the release exists to clear. Lock scope/order and transactional atomicity unchanged; bounds are transaction-local. |

Tests: 117 pass (all state-transition suites). Frequency note: these are
tail events — the change converts a >16 s hang+client-abort into a
bounded ≤10 s wait + actionable error; it does not claim to lower p50.
Rollback: revert helper call sites; Postgres default (no timeout) returns.

---

## R-08 · B-05 — Auth-user TTL cache (implemented — safe invalidation verified)

| | |
|---|---|
| Files | `app/core/auth_cache.py` (new), `app/core/config.py` (`AUTH_CACHE_TTL_SECONDS=60`, 0 disables), `app/dependencies/auth.py`, `app/api/v1/auth.py` (`PATCH /me` re-fetch), `app/services/employee.py` (deactivate/reactivate invalidate), `app/services/auth.py` (login invalidate) |
| Root cause | Every authenticated request paid a full remote RTT re-loading the same users row (+joinedload company). |
| Implementation | Process-local TTL cache of **detached** User snapshots (expunged; `company` eager-load survives). On hit the dependency returns the detached user directly — never `merge()`, which would risk stale write-back of all attributes on an unrelated flush. Only mutation site (`PATCH /me`) re-fetches `session.get(User, id)` before writing and invalidates post-commit. All in-process `is_active`/`role`/`property` writers invalidate; a 10k-entry bound prevents unbounded growth. |

**Consistency window (documented):** in-process auth changes propagate
immediately; changes by OTHER processes on the shared DB (e.g. Employee
Backend deactivation) propagate within `AUTH_CACHE_TTL_SECONDS` (60 s) —
far inside the 30-min access-token lifetime. `login`/`refresh` still read
the DB directly for the password/is_active decision.

**Measured (live):** `/auth/me` warm — `dbq 1→0`, `db_ms 35→0`,
`srv 90→1 ms`. Every other endpoint drops one query (probe `dbq`
columns all −1). Tests: 117 pass incl. auth/tenant suites.
Rollback: `AUTH_CACHE_TTL_SECONDS=0` (env flag, no deploy).

---

## R-09 · Phase I — Conditional requests: **evaluated, deliberately not implemented**

| Polled endpoint | Interval | Verdict |
|---|---|---|
| `/live-locations` | 10 s | External proxy — upstream processing is the cost, not serialization; GPS data volatile. ETag can't help. |
| `/attendance/status-board` | 60 s | **Semantically unsafe** — status derives from `now()` vs shift cutoffs; `MAX(updated_at)` validators would serve stale states. Rejected. |
| tasks/today, review-queue, units | 10–30 s | Payloads 1.7–25 KB at current scale; validator query ≈ endpoint query cost (~1 RTT each); representation mutates frequently during active hours — most polls return 200 anyway, paying the extra query for nothing. |

Measured payload sizes (`data/api-probe-*.json`): tasks 24.9 KB, rooms
7.6 KB, dorms 2.2 KB, washrooms 1.7 KB, maintenance 2.9 KB. Conclusion:
validator overhead ≥ saved work at current scale — implementation not
justified by measurement. Revisit if row counts grow 10× or polling
density increases.

---

## R-10 · Phase J — Production configuration (documented unknowns)

| Item | Status |
|---|---|
| SA Railway region | Unverified — `railway.toml` gives no region; observed edge `hkg1`. If far from `ap-south-1`, API↔DB RTT is the dominant prod term — needs Railway dashboard check. |
| EB Railway region | Unverified — cold TTFB 634 ms suggests non-Indian region. |
| Replicas / uvicorn workers | 1 replica assumed; `startCommand` = single-worker uvicorn (~45–55 req/s ceiling measured in baseline). |
| Redis | Unset in dev; prod presence unverified (rate-limit/arq depend on it). |
| Scheduler ownership | Embedded loop is the only tick owner **in this repo** — see R-05 hazards. |
| API↔DB prod RTT | 12.5–17.7 ms from this network; in-service RTT needs a prod probe. |

**No production writes, migrations, connection-string, or infrastructure
changes were made.** Session-pooler switch and replica/worker tuning
require approval + the pool-arithmetic checklist in R-02.

---

## Cumulative before/after (same machine → prod DB, :6543, warm)

| Endpoint | Baseline srv p50 | Now srv p50 | Driver |
|---|---|---|---|
| /live-locations | 705 ms | **138 ms** | R-01 |
| /auth/me | 50 ms | **1 ms** | R-08 |
| /maintenance | 192 ms | **110 ms** | R-08 (−1 q) |
| /dorms | 146 ms | **90 ms** | R-08 (−1 q) |
| /tasks?limit=500 | 168 ms | **154 ms** | R-08 (−1 q) |
| bootstrap | 9 req / 195 ms | **1 req / 173 ms** | R-04 |
| reconcile (worst) | 13,189 ms | **214 ms** | R-05 |
| lock-wait worst case | 16.4 s hang | ≤10 s → 409 | R-07 |

Error rate: 0 across all probes, before and after.

## Ranked next three highest-value improvements

1. **Switch `DATABASE_URL` to session pooler :5432** (R-02) — halves every
   `db_ms` figure (~49–73% srv-p50 drop measured end-to-end) and removes
   the B-01 failure mode. Requires Supabase pool-limit raise + approval.
2. **Verify + co-locate the SA Railway region with `ap-south-1`** (R-10) —
   if the API is far from Mumbai, region placement dominates every other
   term combined; a pure config decision once verified.
3. **Scheduler ownership hardening** (R-05) — pin `RUN_EMBEDDED_SCHEDULER`
   policy vs replica count (or deploy the arq worker) before scaling past
   one replica; prevents silent duplicate sweeps as load grows.
