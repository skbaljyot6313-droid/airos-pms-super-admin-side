# Cloud Run deployment config — Super Admin API (documented, not deployed)

Current deploy is **Railway** (`backend/railway.toml`): Nixpacks, single
uvicorn process (1 worker), `/health` healthcheck. No Cloud Run config
exists in the repo — this is the recommended config for a
production-equivalent staging deployment in **Mumbai (asia-south1)**.

## Recommended service config

| Setting | Value | Rationale |
|---|---|---|
| Region | `asia-south1` | Spec requirement; co-locate with the Supabase project (ap-south-1 pooler — the measured ~300 ms/query RTT is the DB latency floor) |
| CPU | 2 vCPU (staging baseline) | Argon2id verify ≈ 140 ms/core measured; 2 vCPU ⇒ ~14 verifies/s/instance |
| Memory | 1 GiB | Argon2 uses 64 MiB per concurrent hash (t=3,p=4,m=64MiB defaults); VERIFY_MAX_WORKERS × 64 MiB + app baseline ~400 MiB |
| Concurrency | 20 req/instance | Login is CPU-bound; higher concurrency only lengthens queues |
| Min / Max instances | 1 / 4 (staging) | Autoscale handles bursts; DB pool ceiling below bounds max |
| Timeout | 60 s | Covers queue timeout (10s) + retries |
| Startup probe | `/ready` (initialDelay 10s, period 10s) | Boot does DB + schema check — must pass before traffic |
| Liveness | `/health` | Cheap liveness only |

## ASGI workers on Cloud Run

Prefer `--workers 1` and let **Cloud Run instance autoscaling** provide
parallelism (the platform's own model). Per-process pools are per worker;
multiple workers per instance multiply DB connections without a matching
vCPU. Benchmarks should compare:

- **1 worker/instance × N instances** (recommended production shape)
- **4 workers/instance** only on 4+ vCPU (our localhost test showed
  ~2× throughput on an 8-core box — CPU-bound, not worker-count-bound)

## Verification queue sizing (per process)

Defaults: `VERIFY_MAX_WORKERS=min(4, cpu_count)`, `VERIFY_QUEUE_MAX=128`,
`VERIFY_QUEUE_TIMEOUT_S=10`.

Total argon2 concurrency = `VERIFY_MAX_WORKERS × workers/instance ×
max_instances`. **Measured on localhost:** oversubscribing argon2
threads inflates `verify_ms` — 16 threads (4/proc × 4 procs) pushed
verify p50 from ~140 ms to ~470 ms; cutting to 2/proc (8 total ≈ core
count) restored ~230 ms and let the queue drain cleanly. Size
`VERIFY_MAX_WORKERS` so that **total fleet argon2 threads ≈ total
vCPUs**, not per-process cores — argon2id already uses p=4 internally.
With 2 vCPU, 1 worker, 4 max instances: `VERIFY_MAX_WORKERS=2` → max 8
concurrent verifies fleet-wide (~8×64MiB argon2 memory) and ~57
logins/s theoretical at 140 ms/verify. Under burst the queue depth
absorbs the tail; raise `VERIFY_QUEUE_TIMEOUT_S` (e.g. 25 s on staging)
if measured verify-wait p99 approaches the default 10 s deadline —
timed-out requests get a clean 503 `AUTH_QUEUE_TIMEOUT`, never a fake
401.

## DB connection budget (measured: pooler showed 26–38 active conns)

`DB_POOL_SIZE=5 + DB_MAX_OVERFLOW=5` ⇒ **10 conns/worker**. Worst case:
login now does **3 remote RTTs** (SELECT user+company join → CTE
UPDATE+INSERT → COMMIT), down from 4 after the single-statement merge.

| Config | Max conns to Supabase pooler |
|---|---|
| 1 worker × 4 instances | 40 |
| 4 workers × 4 instances | 160 |
| + Employee Backend share | + EB pool (separate service, same project) |

The Supabase pooler also has its own client cap — keep fleet totals
documented and under it. Do not raise `DB_POOL_SIZE` without the
`X-DB-Pool-Time` evidence showing pool wait is the binding constraint
(it is, at burst scale — but only *after* verify offload).

## Load-test-specific env (staging only, never defaults)

```
LOGIN_RATE_LIMIT=100000        # staging benchmark override only
LOGIN_RATE_LIMIT_WINDOW_SECONDS=60
VERIFY_MAX_WORKERS=2           # match instance vCPU
RUN_EMBEDDED_SCHEDULER=false   # arq worker owns ticks in prod
```

Production `LOGIN_RATE_LIMIT` stays **10/60s per IP** — unchanged.
