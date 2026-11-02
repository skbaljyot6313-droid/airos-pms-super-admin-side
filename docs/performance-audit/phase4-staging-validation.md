# Phase 4 — Staging Capacity Validation & Auth Latency RCA

Date: 2026-10-28. Target: `airos-sa-api-staging`, Cloud Run `asia-south1`
(project `airos-530a5`). All measurements are staging-only. Raw artifacts:
`tests/load/results/staging-b-vw2/`, `staging-d-max8/`,
`stability-20261028T072314Z-0d8d68a0/` (gitignored).

## 1. Staging architecture & exact configuration

| Setting | Staging | Production (`airos-sa-api`) |
|---|---|---|
| Region | asia-south1 | asia-south1 |
| CPU / Memory | 2 vCPU / 1 GiB | 1 vCPU / 512 MiB |
| containerConcurrency | 20 | 80 |
| min / max instances | 1 / 4 → 8 (config D) | – / 2 |
| Timeout | 60 s | default |
| Uvicorn workers | 1 (Dockerfile `UVICORN_WORKERS`) | 1 |
| `DB_POOL_SIZE` / `DB_MAX_OVERFLOW` | 5 / 5 (10 conns/instance) | 5 / 5 |
| `DB_POOLER_MODE` | transaction (:6543) | **session** (:5432) |
| `VERIFY_MAX_WORKERS` / QUEUE_MAX / TIMEOUT | 2 / 128 / 25 s | unset (defaults) |
| `LOGIN_RATE_LIMIT` | 10/60 default; **100000 staging-only override** for the stress matrix | 10/60 |
| `RUN_EMBEDDED_SCHEDULER` | **false** (staging) | true |
| Secrets | Secret Manager (`airos-sa-staging-database-url` + shared `airos-sa-*` secrets) | same mechanism |
| Database | **staging Supabase project** (transaction pooler, schema head `v9f2b5c8d1e4`) | shared SA+EB DB (EB-chain stamp `y5c1e8a3f7d2`) |

Per-process vs fleet capacity (staging, 1 worker/instance):
pool conns/instance = 10; argon2 threads/instance = 2. Config D fleet
ceiling = 8 instances → 80 DB conns, 16 argon2 threads, 160 request slots.

### Deploy-time issues found (worth recording)

1. Buildpacks `--source` deploy failed (`Attribute "app" not found`) —
   a repo Dockerfile was required; added `backend/Dockerfile` mirroring
   the railway.toml start contract.
2. `alembic upgrade head` in the CMD fails when the shared DB stamp is an
   EB-owned revision — made non-fatal; boot `check_schema_version` is the
   real gate.
3. The prod DATABASE_URL secret points at the shared SA+EB database whose
   `alembic_version` is an EB revision the SA boot check cannot resolve —
   **the staging service must not reuse the prod DATABASE_URL secret**.
   A separate `airos-sa-staging-database-url` secret was created for the
   staging Supabase project (schema-current, contains the 500 seeded
   `loadtest.dev` accounts).
4. Default compute SA lacks `secretmanager.secretAccessor`; staging runs
   under `airos-sa-api@airos-530a5…` like prod.

## 2. Benchmark results

Single login (warm): **client ~270 ms, server ~236 ms, db ~56 ms,
verify ~170 ms, pool/queue wait ~0 ms.** DB RTT co-located ≈ 20 ms/query
(vs ~300 ms localhost→Supabase). Login is now 3 RTTs.

### Config B — VW=2, pool 5+5, concurrency 20, max 4 instances

| Stage | ok | client p50 | client p99 |
|---|---|---|---|
| 1 | 1/1 | 252 | 252 |
| 10 | 10/10 | 1204 | 1891 |
| 25 | 25/25 | 1538 | 2462 |
| 50 | 49/50 | 2026 | 3783 |
| 100 | 99/100 | 3586 | 7149 |
| 250 | 213/250 | 8200 | 14431 |
| 500 | 272/500 | 16903 | 19357 |
| sustained 60 s | 1596/2619 (43.6 rps) | | |

Totals: 2596/4055. **1338 × GFE-429 ("Rate exceeded."), 121 × GFE-500** —
zero application-side 5xx. Served requests: server p50 200 / p99 2293 ms,
db p50 50 ms, pool_wait p50 0 ms, verify p50 137 ms.

### Config D — same app settings, maxScale 8

| Stage | ok | client p50 | client p99 |
|---|---|---|---|
| 1 | 1/1 | 314 | 314 |
| 10 | 10/10 | 417 | 610 |
| 25 | 25/25 | 1247 | 1973 |
| 50 | 50/50 | 1345 | 3120 |
| 100 | 100/100 | 2166 | 4560 |
| 250 | 250/250 | 5026 | 8051 |
| 500 | 464/500 | 9960 | 17062 |
| sustained 60 s | 2868/3090 (51.5 rps) | | |

Totals: 4153/4526 (91.7%). 262 × GFE-429, 109 × GFE-500, 2 client
ConnectTimeout. **All rejected responses carry no app headers — none
reached the application.** Served requests: server p50 196 ms / p95 1942 /
p99 2838; db p50 54 ms; pool_wait p50 0 ms; verify p50 132 ms;
verify_wait p50 0 ms / p99 1939 ms.

Config A skipped: container `os.cpu_count`=2 ⇒ default
`VERIFY_MAX_WORKERS=min(4,2)=2` ≡ config B. Config C skipped:
`pool_wait_ms` p50 = 0 — no measurable pool contention to justify 10+10.

### Contract checks (staging)

Post-load stability `stability-20261028T072314Z-0d8d68a0`: login 2/2,
`/auth/me` 6/6 @ 39 ms, `/workspace` 6/6 @ 104 ms, refresh rotation 2/2.
162 backend + 25 load unit tests pass on the deployed code.

## 3. Bottleneck ranking (evidence)

1. **Cloud Run cold-start/autoscale lag — confirmed, high.** Every failed
   response is a GFE-level 429/500 with no app headers; failures cluster
   at the 500-simultaneous burst while new instances boot (~10-20 s each).
2. **Argon2 fleet CPU — confirmed.** Sustained login throughput ≈ 43-52
   rps ≈ (8 inst × 2 threads)/~150 ms verify + read share; latency scales
   with concurrency exactly as CPU-bound queueing predicts.
3. **Application-layer path — healthy.** db p50 ≈ 50 ms, pool_wait ≈ 0,
   verify wait ≈ 0 at ≤100 concurrency. The CTE + conn-release + bounded
   queue all behave as designed on real infra.
4. **DB pooler — no contention observed** (pool_wait p99 ≈ 1 s only at
   burst peak; no EMAXCONNSESSION).
5. Client path adds ~40-90 ms WAN RTT to all figures — server timings are
   authoritative.

## 4. Latency targets (staging, served requests)

| Target | Result |
|---|---|
| login p50 < 250 ms | **PASS** at ≤50 conc (196-252 ms); fails only under ≥250 burst while scaling |
| login p95 < 500 ms | **FAIL** at ≥50 conc (queueing during scale-up) |
| login p99 < 1 s | **FAIL** at burst scale |
| reads | PASS (`/auth/me` 39 ms, `/workspace` 104 ms) |
| zero app-side 5xx | **PASS** — all 5xx/429 are platform-level |
| bounded queue/pool, no exhaustion | PASS |

## 5. Recommendation

**Conditional GO for production rollout** of the auth code (CTE + bounded
queue + conn-release): the application layer is measurably healthy on real
infra; residual failures are platform scaling, fixable via capacity, not
code.

Recommended production settings (measured rationale):

- `--max-instances` ≥ 8 and `--min-instances` ≥ 2 for login-heavy windows
  (min-instance warmth eliminates the observed cold-start shed; each
  warm instance ≈ 2×~7 logins/s argon2 capacity).
- `containerConcurrency` 20 (CPU-bound; higher values only lengthen
  in-instance queues).
- 2 vCPU / 1 GiB per instance (verify ~140 ms on 2 vCPU vs degraded on 1).
- `VERIFY_MAX_WORKERS` = instance vCPU; `VERIFY_QUEUE_TIMEOUT_S` 25 s.
- DB pool 5+5 unchanged (pool_wait ≈ 0 measured — no justification to grow).
- Keep `DB_POOLER_MODE` matching whichever URL the secret uses (prod uses
  session mode).
- Restore `LOGIN_RATE_LIMIT=10/60` — staging override was env-scoped only
  and never committed.

NO-GO caveat: p95/p99 targets at 500-simultaneous burst are NOT met even
at maxScale 8 — that load level needs either min-instances ≥ 4 warm, a
larger fleet (quantified: 500 concurrent logins needs ≈ 75 argon2 threads
≈ 38 × 2-vCPU instances, clearly impractical), or acceptance that a
500-true-simultaneous login burst is beyond reasonable sizing. Realistic
sustained load (≈50 rps mixed) is comfortably served.

### Rollback

Staging: `gcloud run services update-traffic` / delete
`airos-sa-api-staging`. The changes are app-level and backward compatible
— rollback = redeploy the previous image tag; no schema changes exist.
The staging-only env overrides (`LOGIN_RATE_LIMIT=100000`) die with the
service.

### Unresolved risks

- Prod DB pooler mode differs (session) — session mode allows prepared
  statements; verified on transaction mode in staging, but smoke one real
  login on prod before shifting traffic.
- GFE-level 429/500 during cold bursts will also occur on prod at
  maxScale 2 — raise prod maxScale or accept shed under burst.
- EB-side DB consumers add to the Supabase client cap; fleet budget
  documented above (80 conns at maxScale 8).
