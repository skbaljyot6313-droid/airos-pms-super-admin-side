# Executive Summary — AiROS End-to-End Latency Audit (2026-10-15)

## Verdict

Latency is **distributed**, not concentrated: no slow queries, no missing
indexes, no serialization N+1, no Redis problems, no bundle problem.
Time is spent as `requests_per_action × queries_per_request × ~30 ms
per remote DB round-trip`, plus one expensive external hop
(`/live-locations`) and rare multi-second lock waits on bulk writes.
One **real production bug** was found and fixed during the audit
(pgbouncer prepared-statement 503s).

## Five biggest measured bottlenecks

1. **pgbouncer transaction-mode prepared-statement failures** — random
   `503 DATABASE_ERROR` on ~half of requests before the fix
   (SQLAlchemy's `prepared_statement_cache_size` never disabled).
   *Fixed in `core/database.py`; durable fix = session pooler :5432.*
2. **`/live-locations` proxy, 730–890 ms per call** — fresh TLS to the
   Railway Employee API every poll; ~430–570 ms of it is the
   un-pooled HTTP client, polled every 10 s (even in hidden tabs).
3. **Per-query remote-DB round-trip tax** — every authenticated request
   burns ~30 ms/query × (auth + scope + reads); with transaction pooling
   each statement is ~2 RTT. Session pooler halves every `db_ms`.
4. **Bootstrap & poll request volume** — 9-GET burst (wall p50 694 ms,
   per-req amplified ~5×) + ~15–36 background req/min/client; no
   conditional requests, no pagination enforcement.
5. **Concurrency ceiling ~45–55 req/s (single uvicorn worker)** —
   per-request p50 triples past ~20 concurrent; pool-wait bound, not
   DB bound.

## Slowest endpoints (server p50, measured)

`/live-locations` 730–890 ms · `/tasks/today` 194 ms ·
`status-board` 155 ms · `/dorms` 131 ms · `/tasks?limit=500` 122 ms ·
`/rooms` 112 ms. Worst outliers: bulk-release `FOR UPDATE` sweep 16.4 s
max (lock waits), `zone_allocation_state` lock 2.7 s.

## Immediate roadmap (low-risk first)

Session-pooler :5432 → reusable httpx client for EB proxy →
`usePolling` for map/attendance → auth-user TTL cache →
`/workspace` aggregate endpoint → ETag on unit polls → batch
reconciliation sweeps → real pagination. Details: `optimization-roadmap.md`.

## Evidence base

Live probes against the real Supabase project (pg_stat_statements +
catalogs), authenticated endpoint timing with per-request db/ext
attribution headers, concurrency ramp, TCP/TLS/HTTP measurements to all
dependencies, frontend build + code audit. All raw data in `data/`;
reproduction in `measurement-methodology.md`. Tests: 147 passed,
`npm run build` green.
