# Optimization Roadmap

Phased by risk. Each item names the finding it addresses and the
measurable success check.

## Phase 0 — already done by this audit

- [x] B-01: `_pgbouncer_connect_args` disables BOTH prepared-statement
  caches (asyncpg + SQLAlchemy dialect) and gives statements uuid names.
  **Verify:** zero `prepared statement … does not exist` in logs; 503s gone.
- [x] Timing instrumentation (`REQUEST_TIMING_ENABLED`, X-DB-*/X-Ext-*
  headers, enriched access log) + probe scripts.

## Phase 1 — config & micro-fixes (days, low risk)

1. **B-02 — switch `DATABASE_URL` to session pooler :5432.**
   Removes the ~2-RTT-per-query tax (~30 ms→~15 ms/query) and the
   pgbouncer failure mode entirely. Keep the B-01 guard for safety.
   *Check:* db_ms per request halves in access logs.
2. **B-03 — reuse one `httpx.AsyncClient` for the EB proxy** (module
   singleton w/ timeout + keep-alive). ~200 ms handshake per poll gone.
   *Check:* ext_ms on /live-locations drops toward upstream service time.
3. **B-09 — move LiveLocationMap + AttendanceBoard to `usePolling`**
   (visibility pause). Pure request-volume win.
4. **B-05 — cache the auth user lookup**: claims already carry
   `user_id`/`company_id`/`role`; keep a tiny TTL cache (≤60 s) keyed by
   `sub`+`is_active version`, or accept JWT freshness and check
   `is_active` only on refresh. *Check:* dbq per request −1.
5. **Verify prod `DATABASE_URL` port + `REDIS_URL` presence + Railway
   regions** (read-only dashboard checks; B-10/B-11/B-12).

## Phase 2 — targeted improvements (small PRs)

6. **B-04 — `/workspace` aggregate endpoint**: one request → one session →
   all 9 collections. Frontend keeps the same context shape. Biggest
   bootstrap win: −8 requests and their per-request auth+concurrency tax.
   *Check:* session-restore wall p50 < 300 ms at same data scale.
7. **Conditional GETs on unit polling** (`ETag` per collection: hash of
   max(updated_at, row count)) → 304s for unchanged ticks.
8. **B-06 — batch reconciliation** (one query per blocker family per
   property) + index-gate the per-minute sweeps.
9. **B-08 — real pagination** on `/tasks` + `/maintenance`
   (`LIMIT/OFFSET` + COUNT or keyset), matching `_paged` semantics
   honestly.

## Phase 3 — structural (needs its own plan)

10. **Colocation decision (B-10):** if SA API's Railway region is far
    from Mumbai, either move the service near the DB or the DB near the
    fleet — quantify with in-service probes first.
    **Do not migrate anything as part of the audit.**
11. **Write-path lock hygiene (B-07):** bound the FOR UPDATE sweep
    (per-unit batches, `SKIP LOCKED` where safe), add lock-timeout.
12. **Horizontal scaling (B-11):** `--workers` or replicas only after
    pool math is verified against Supabase connection limits
    (workers × pool_size+overflow ≤ pooler limit).
13. **Real-time transport (only if justified):** current polling ≈
    15–36 req/min/client. If ETag + aggregate + visibility fixes land,
    volume is already low — reassess before considering SSE/Centrifugo.

## Validation procedure for every change

1. Baseline: `python scripts/api_probe.py --user … --company …` → JSON.
2. Change → repeat probe same `--n` → compare p50/p95 per endpoint and
   the workspace burst.
3. Access-log `db_ms/db_queries/ext_ms` before/after on the real routes.
4. `pytest tests/` + `npx tsc --noEmit` + `npm run build` green.
