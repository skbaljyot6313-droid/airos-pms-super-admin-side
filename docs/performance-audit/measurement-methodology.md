# Measurement Methodology

## Instrumentation added (this audit)

`REQUEST_TIMING_ENABLED` (default **true**; set `false` to revert to
duration-only access logs):

- `core/timing.py` — one `request_timing` contextvar holding a mutable
  `TimingBag` (`db_ms`, `db_queries`, `ext_ms`, `ext_calls`, `notes`);
  `track_external()` sync CM; `install_engine_listeners(engine)`.
- `install_engine_listeners` (called from `app/main.py` when enabled) —
  sync-engine `before_cursor_execute` / `after_cursor_execute` /
  `handle_error` accumulate per-request DB time+count (correct under
  async interleaving because the contextvar is set per request).
- `core/middleware.py` `AccessLogMiddleware` — mints a TimingBag per
  request when enabled and enriches the access line:
  `method=… route=<template> path=… status=… duration_ms=… db_ms=…
  db_queries=… ext_ms=… ext_calls=… user=… company=…`.
  Response headers emitted whenever timing is on: `X-Response-Time`
  (always), `X-DB-Time`, `X-DB-Queries`, and `X-Ext-Time` when the
  request made external calls. `X-Request-ID` comes from
  `RequestIDMiddleware`.
- Timed external call sites: `live_location._get` (EB proxy) and
  `check_rate_limit` Redis ops.
- Bounded labels: the log uses the route path template, never raw path
  params — no IDs, tokens, or SQL parameters are ever logged or labeled.

## Probe scripts (read-only, safe on shared DB)

- `scripts/audit_probe.py` — pg_catalog + pg_stat_statements inventory,
  fresh-connect & warm-RTT latency, session counts → JSON.
- `scripts/api_probe.py` — authenticated endpoint timing; mints a JWT
  with the app's own secret for a known user (super_admin read-only
  endpoints), emits server/client/db/ext per-call stats + the 9-GET
  workspace burst + a bounded concurrency ramp → JSON.

## How to reproduce

```powershell
# backend/
$env:REQUEST_TIMING_ENABLED="true"; $env:TIMING_EXPOSE_HEADERS="true"
uvicorn app.main:app --host 127.0.0.1 --port 8000

# DB inventory + latency (read-only)
python -m scripts.audit_probe --runs 5 > ..\docs\performance-audit\data\db-probe.json

# Endpoint timing (super_admin read endpoints + concurrency ramp)
python -m scripts.api_probe --user admin@example.com --company <company_uuid> --runs 15 `
  --property-uid <uid> --property-id <uuid> --concurrency "1,5,10,20" `
  > ..\docs\performance-audit\data\api-probe.json

# Network RTT
python -c "import socket,time,statistics; h='aws-0-ap-south-1.pooler.supabase.com'; \
 print([round((time.perf_counter()-t)*1000,1) for t in [time.perf_counter()] \
 for s in [socket.create_connection((h,6543),3)] if not s.close()])"
```

## What each number means (and doesn't)

- `client_ms` (probe) = fetch wall time incl. localhost hop — ≈ server_ms
  + a few ms locally.
- `server_ms` = full middleware→response time (app-process view).
- `db_ms` = summed SQL execution+RTT across `db_queries`; may exceed
  server_ms only if queries ran in parallel (they don't here).
- `ext_ms` = summed labeled external calls.
- Gap `server_ms − db_ms − ext_ms` = auth decode, service logic,
  dict serialization, gzip, middleware, pool-checkout waits.
- p50/p90/p95/p99 computed per-endpoint from ≥15 samples; `max` reported
  because pg_stat outlier latencies (locks) matter more than means.

## Environment caveats

- All endpoint numbers: **local app → remote production DB**, read
  endpoints only, one 15-room property. Local loopback hides the
  browser→Vercel→Railway leg (~+40–100 ms typical) — production totals
  are strictly higher.
- pg_stat_statements mixes Employee Backend + scheduled-job traffic;
  attributions are by query text match.
- The audit ran with the B-01 fix active → ~2 RTT/query; a session-pooler
  switch will measurably improve every `db_ms` figure.

## How to obtain the metrics marked unavailable

| Missing | How |
|---|---|
| Prod API→DB RTT | Run `audit_probe` inside the Railway service (SSH/console) or add a `/health` DB-timing field behind `TIMING_EXPOSE_HEADERS` |
| Railway region/CPU/memory | Railway dashboard → service → settings/observability |
| Browser render times | `src/dev/perf.ts` ([RENDER]/[REQ]) + React DevTools Profiler on a real browser session |
| Write-path latency | Repeat api_probe-style script with POST/PUT against a **staging** DB |
| Redis prod latency | Set `REDIS_URL` in a staging env; ext_ms appears automatically on rate-limited endpoints |
| Real-user monitoring | Web Vitals (`onFCP/onLCP/onINP`) → a `/metrics` beacon or RUM tool (post-audit) |
