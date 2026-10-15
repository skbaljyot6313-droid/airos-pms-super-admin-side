# Observability Inventory (pre-audit + what this audit added)

## Existing tooling found in the repo

| Tool | Location | Status before audit |
|---|---|---|
| `frontend/src/dev/perf.ts` | dev-only console instrumentation | Present but passive — emits `[REQ]`, `[REFRESH]`, `[POLL]`, `[RENDER]`, `[DETAIL]` records; wraps apiFetch timings; mutation→refresh correlation ids (`m1`…) |
| `prometheus-fastapi-instrumentator` | `requirements.txt` | **Installed, never wired** — no `/metrics` exposure |
| `AccessLogMiddleware` | `app/core/middleware.py` | Basic access log: method/path/status/ms — no attribution |
| `X-Request-ID` echo | middleware | Present (echoes inbound or mints uuid) |
| `/health` `/ready` | `app/main.py` | Liveness + DB reachability (pooler ping) |
| Structured logging | stdlib `logging` | App logs to stdout; no JSON formatter, no central sink in repo |
| Error handling | `app/core/exceptions.py` + handlers | Normalized `ApiError` responses; no error-rate metrics |
| Test fixtures | `backend/tests/` | 114 tests, none performance-oriented |
| No tracing | — | **Zero** OpenTelemetry/Sentry/Datadog anywhere |
| No APM | — | Railway provides only infra-level metrics (CPU/mem/net) |

## What this audit added (all flag-gated)

| Capability | File | Gated by |
|---|---|---|
| Per-request DB time + query count | `app/core/timing.py`, `app/core/database.py` engine events | `REQUEST_TIMING_ENABLED` |
| Per-request external-call time (EB proxy, Redis) | `track_external()` at call sites | same |
| Response timing headers `X-Response-Time`, `X-DB-Time`, `X-DB-Queries`, `X-Ext-Time` | `AccessLogMiddleware` | emitted whenever timing is on |
| Enriched access log (`route= db_ms= db_queries= ext_ms= ext_calls=`) | `AccessLogMiddleware` | `REQUEST_TIMING_ENABLED` (default true) |
| DB inventory/latency probe | `scripts/audit_probe.py` | — (read-only) |
| Endpoint timing + burst + concurrency probe | `scripts/api_probe.py` | — (read-only endpoints) |

No new dependencies were installed; no third-party telemetry was sent
anywhere. Metrics use bounded labels only (route path templates);
no property/employee IDs, tokens, or SQL parameters are recorded.

## Still missing (recommended, not added)

- `/metrics` endpoint via the already-installed
  `prometheus-fastapi-instrumentator` (one line: `.instrument(app)
  .expose(app)`) — cheap histograms per route, bounded labels.
- OTel traces spanning middleware→service→SQL (existing headers give the
  data; a tracer would give the flame graph).
- Web-Vitals RUM on the frontend (`onLCP`/`onINP` beacon to a
  `/metrics` sink).
- Error-rate/timeout-rate counters — currently derivable only by
  grepping logs.
- Redis command latency (auto-covered by `track_external` once
  `REDIS_URL` is set).
