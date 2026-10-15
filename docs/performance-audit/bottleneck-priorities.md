# Bottleneck Priorities — ranked findings register

Confidence: **confirmed** = measured/reproduced; **high** = measured proxy
+ code inspection; **medium** = strong inference pending one more probe.

| ID | Finding | Evidence | Impact | Status | Severity | Confidence |
|---|---|---|---|---|---|---|
| B-01 | **pgbouncer prepared-statement 503s** — SQLAlchemy's asyncpg dialect cache (`prepared_statement_cache_size`, default 100) reuses prepared statements across pgbouncer transaction assignments → intermittent `prepared statement __asyncpg_stmt_N__ does not exist` → 503 on ~half of requests | Reproduced live; fix verified (all endpoints 200 after) | Random request failures + retry-driven latency on any env pointing at :6543 | **FIXED** in `core/database.py` (disables both caches + uuid statement names) | Critical | confirmed |
| B-02 | **Session-pooler alternative restores prepare reuse** — transaction mode now costs ~2 RTT/query (~30 ms each) vs ~1 RTT (~15 ms); port 5432 verified compatible | Timed before/after; session-pooler prepare test passed | ~30–60 ms/request locally; more wherever RTT is higher | Open — config change | High | confirmed |
| B-03 | **/live-locations proxy pays fresh TLS+TCP+edge per call** — `httpx.AsyncClient` created per request; ext 373–571 ms, endpoint 730–890 ms, polled every 10 s | `live_location.py`, ext_ms headers | Worst endpoint; ~6×/min per open map | Open — reuse a module-level client | High | confirmed |
| B-04 | **Concurrency amplification** — 9-GET bootstrap & 5-GET polls amplify: per-req srv p50 341–678 ms in burst vs 62–131 ms solo; ~45–55 req/s plateau, 3× p50 at c≥20 | api_probe burst + concurrency probe | Slower session restore & multi-user contention | Open — aggregate endpoint + fewer polls | High | confirmed |
| B-05 | **Every authenticated request pays a users-table DB hit** (~30–60 ms) — `get_current_user` re-queries per request to check is_active | dbq counts in probe | +1 round trip everywhere | Open — short-TTL user cache or trust-JWT-with-version | Medium | confirmed |
| B-06 | **Scheduler sweep volume** — ~200 k stmt calls dominated by per-minute full open-task scans + ~500-query reconciliation every 15 min; bed/ticket blocker probes return 0 rows 32 k/61 k times | pg_stat_statements | Background DB churn; grows with scale | Open — batch/index-gate sweeps | Medium | confirmed |
| B-07 | **16.4 s FOR UPDATE bulk-release sweep** — `_mark_cleaning_work_done` `tasks…FOR UPDATE` hit lock contention | pg_stat max_exec_time | Rare worst-case multi-second request | Open — bound sweep/batch units | Medium | confirmed |
| B-08 | **No pagination enforcement** — `_paged` ignores LIMIT/OFFSET; all lists return full tenant tables | repo code | Linear degradation as tenants grow | Open — real pagination | Medium | confirmed |
| B-09 | **Polls while hidden** — LiveLocationMap (10 s) & AttendanceBoard (60 s) use raw setInterval | component code | Wasted requests incl. the costliest one | Open — reuse usePolling | Low | confirmed |
| B-10 | **Region mismatch hypothesis** — Supabase Mumbai; Railway service region unverified; EB TTFB 634 ms cold | infra probe | Possibly the dominant prod latency term | Needs Railway dashboard/prod probe | Unknown | medium |
| B-11 | Single uvicorn worker in prod startCommand | railway.toml | Hard concurrency ceiling | Open — verify replica count | Medium | high |
| B-12 | arq worker deployment unverified; Redis unset in dev | config | Prod job ownership unclear | Open — verify | Low | medium |

## Ranking rationale

User-visible impact × frequency: B-01 (failures) > B-03 (worst latency,
every 10 s) > B-02 (universal per-request tax) > B-04 (session feel) >
B-05 (universal +30 ms) > B-06..B-09 (structural).

## Rejected-as-bottleneck (evidence)

- **Query plans/indexes** — hot queries ≤20 ms; no missing-index problem
  on read paths at current scale.
- **Serialization/business logic** — ~10–20 ms/request non-DB time.
- **N+1 in list endpoints** — batched enrichers verified (`IN ()` lookups).
- **Redis** — absent from the hot path entirely.
- **Bundle size / code splitting** — already healthy.
