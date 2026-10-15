# AiROS Performance Audit — October 2026

Evidence-based audit of the Super Admin stack (frontend, FastAPI backend,
Supabase Postgres, Redis, background jobs, Employee-Backend integration).

**Measurement context (read this first):** Unless marked otherwise, numbers
were captured on 2026-10-15 from a Windows dev machine in India running the
API locally (`uvicorn`, single worker) against the **real shared Supabase
database** (`aws-0-ap-south-1.pooler.supabase.com:6543`, transaction pooler,
~12–15 ms RTT from this machine). They are *local measurements against
production data* — representative of query/round-trip cost, NOT of
production browser→Railway latency. Items only observable in production
(Railway service region, real browser waterfall, prod concurrency) are
explicitly marked *unavailable*.

## Documents

| File | Contents |
|---|---|
| `executive-summary.md` | **Start here** — verdict, top-5 bottlenecks, roadmap |
| `architecture-overview.md` | Verified topology, service inventory, request flows (A) |
| `latency-baseline.md` | Measured endpoint + journey latencies (B) |
| `database-audit.md` | pg_stat_statements findings, pool behavior, index audit (C) |
| `frontend-network-audit.md` | Request volume, polling, waterfalls, bundle (D) |
| `redis-and-background-jobs.md` | Redis usage + scheduler/tick analysis (E) |
| `infrastructure-network-audit.md` | Regions, RTTs, cold starts, limits (F) |
| `load-test-results.md` | Concurrency probe results (G) |
| `bottleneck-priorities.md` | Ranked findings register (H) |
| `optimization-roadmap.md` | Phased remediation plan (I) |
| `measurement-methodology.md` | How to reproduce every number (J) |
| `observability-inventory.md` | Existing tooling + what the audit added |
| `user-journeys-api-map.md` | J1–J8 journeys, request counts, dependency map |
| `root-cause-analysis.md` | Where the time actually goes, per layer |
| `data/` | Machine-readable probe output (JSON) |

## Reproduce

```bash
cd backend
python -m uvicorn app.main:app --port 8000
python scripts/audit_probe.py              # DB catalog + hot-read timing
python scripts/api_probe.py --user <uid> --company <cid> --n 15
```

## Instrumentation added by this audit

- `app/core/timing.py` — per-request TimingBag (contextvar) accumulating
  DB time/query count (SQLAlchemy cursor events) and external-call time.
- `AccessLogMiddleware` now logs `route`, `db_ms`, `db_queries`, `ext_ms`,
  `ext_calls` and emits `X-DB-Time`/`X-DB-Queries`/`X-Ext-Time` headers.
  Disable via `REQUEST_TIMING_ENABLED=false`.
- `scripts/audit_probe.py`, `scripts/api_probe.py` — repeatable probes.
- **Bug fix** in `app/core/database.py::_pgbouncer_connect_args` — see
  `bottleneck-priorities.md` B-01.
