# Root-Cause Analysis — where the time actually goes

Every claim below names its evidence. Test conditions: local uvicorn →
Supabase ap-south-1 transaction pooler (12.5 ms warm RTT), small tenant
(587 tasks, 87 rooms, 42 employees). Production adds the browser→Vercel→
Railway leg and possibly a larger API↔DB RTT.

## The single-sentence answer

**No single layer is the bottleneck.** Latency is a *sum of many small,
correctly-implemented but multiply-repeated costs*: ~30 ms per SQL
statement (post-fix: ~2 × 12.5 ms RTT + parse), multiplied by 2–7 queries
per request, multiplied by 9–15 requests per user action — plus one
genuinely expensive dependency (the EB proxy) and occasional severe lock
waits on write paths.

## Anatomy of a typical list request (e.g. GET /rooms, 112 ms srv)

```
 34 ms  auth: JWT decode + SELECT users … (1 query, ~30 ms RTT)
 60 ms  payload: SELECT rooms (2 rt) + SELECT occupancies IN(…) (2 rt)
 ~15 ms service logic + dict serialization + gzip + middleware
≈110 ms server total   — matches measured 112 ms
```

Non-DB work is only ~10–20 ms. **The dominant term is `queries × RTT`,
and queries-per-request is set by auth + scope checks + the real read.**

## Why the 9-GET bootstrap feels slow (694 ms wall / 341–678 ms per req)

Nine concurrent requests × 2–4 queries each ≈ 30 remote round-trips
sharing one event loop and one pool. Each request still costs its own
`~30 ms × dbq`, but they interleave — so per-request server time rises
~5× while wall time stays under the slowest member. Fixes attack
request count (aggregate endpoint), queries/request (auth cache),
and RTT (session pooler).

## Why /live-locations is the worst endpoint (730–890 ms)

Two measured terms: DB ~60 ms; **external ~430–570 ms** —
`live_location.py` constructs a new `httpx.AsyncClient` per call, paying
DNS+TCP+TLS (~200 ms to Railway) on every 10-second poll, on top of the
upstream service's own latency. Pure fixable overhead ≈ the handshake.

## Why bulk "mark cleaned/available" can stall (up to 16.4 s measured)

`StructureService._mark_cleaning_work_done` runs
`SELECT … FOR UPDATE` over all open tasks in a property's rooms. When it
contends with another writer (task generation, a checkout spawning a
cleaning task, another bulk op), the query waits on row locks — the
16,393 ms pg_stat max is lock-wait time, not scan time. Same signature
for `zone_allocation_state … FOR UPDATE` (2.7 s max).

## Why the DB sees ~200 k statements despite low traffic

The 60 s scheduler tick re-scans *all* open tasks (rollover candidate
scan, 87 k calls) and all repetitive templates; every 15 min the
reconciliation sweep probes blockers *per resource* (~32 k bed-scoped
task checks + ~61 k maintenance checks, ~all returning 0 rows). Individually
0.02–0.5 ms, but volume × RTT × parse churn is real load — and each tick
holds a pool connection for its full duration.

## Why concurrency ≥20 degrades sharply

Throughput plateau ~45–55 req/s, per-request p50 triples to ~350–380 ms:
pool-checkout waits + event-loop serialization of many concurrent
queries each needing ~2 remote RTT. Not a DB limit (pg_stat_activity:
9 sessions, 1 active). Lever order: fewer queries/request → shorter
holds → higher ceiling; then replicas/`--workers` after pool math.

## What is NOT the cause (measured negatives)

| Hypothesis | Evidence against |
|---|---|
| Missing indexes on read paths | Hot queries ≤20 ms; all FKs indexed |
| ORM N+1 in list endpoints | Batched `IN ()` enrichers verified |
| Response serialization | ~10–20 ms/request non-DB total |
| Redis | Not on any read path; unset in dev |
| Bundle size | 88 KB gz main, lazy views already |
| Database CPU/plans | All means sub-ms; pg healthy |

## Unresolved root causes (need one more measurement)

- **B-10 region mismatch** — if the SA API's Railway region is distant
  from Mumbai Postgres, every `db_ms` figure here is optimistic by the
  inter-region RTT and becomes the dominant term in production.
  Resolve via `audit_probe` run inside the Railway service.
- Whether prod runs embedded scheduler + arq cron concurrently
  (duplicate sweeps) — needs Railway env/service listing.
