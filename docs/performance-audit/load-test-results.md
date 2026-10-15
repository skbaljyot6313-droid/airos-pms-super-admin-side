# Load Test Results

## What was run

A bounded, read-only concurrency probe against the locally-running API
(single uvicorn worker) → remote Supabase. `GET /rooms` (3 queries:
auth + list + occupancy stamp), 8 bursts per level. No writes, no
mutations — safe for the shared database. This measures the
**app/pool/event-loop ceiling**, not a production stress test.

| Concurrency | per-req server p50 | per-req p95 | burst p50 | Errors | Throughput |
|---|---|---|---|---|---|
| 1 | 100 ms | 112 ms | 102 ms | 0 | ~10 req/s |
| 5 | 110 ms | 141 ms | 129 ms | 0 | ~29 req/s |
| 10 | 124 ms | 160 ms | 153 ms | 0 | ~53 req/s |
| 20 | **352 ms** | **468 ms** | 492 ms | 0 | ~41 req/s |
| 40 | **380 ms** | **691 ms** | 842 ms | 0 | ~45 req/s |

## Read of the data

- Throughput plateaus at **~45–55 req/s** (single worker, sequential
  per-request DB round trips, ~30 ms/query at 12.5 ms RTT + fresh parse).
- Per-request server time **triples** at concurrency ≥20 — queueing on
  pool checkout + event loop, not DB slowness (db_ms stays ~90–100 ms;
  the added ~250 ms is pool-wait + interleaved awaits).
- Zero errors and no timeouts at these levels.

## The realistic production ceiling

Local numbers use a warm 22-conn pool and a 12.5 ms RTT database. In
production, if the SA API is in a distant Railway region vs Mumbai
Postgres, per-query RTT is higher → **same shape, lower absolute ceiling**.
The pattern that matters: per-request latency ≈ `dbq × 2 × RTT` + pool
wait, and throughput ≈ `pool_size / (queries_per_req × 2 × RTT)`.

## Not run (and why)

- Write-path load tests — shared production database; unsafe.
- >40 concurrency — pointless locally once the plateau is visible;
  would only add load to shared infra.
- A Locust/k6 suite — recommended as the follow-on in a staging
  environment with a cloned database (roadmap phase 2).
