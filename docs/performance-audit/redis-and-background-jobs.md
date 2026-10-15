# Redis & Background Jobs Audit

## Redis usage classification

| Purpose | Where | Notes |
|---|---|---|
| Rate limiting | `core/rate_limit.py` — `INCR mt:rl:*` + `PEXPIRE`, fail-open | only used on auth/upload-sensitive endpoints; **not on the hot list paths** |
| arq queue | `core/queue.py` enqueue client | worker code not in this repo's runtime path (embedded scheduler owns ticks in dev) |
| Cache | none | **no application caching exists** — every read hits Postgres |
| Live locations | EB-owned (SA only proxies) | SA adds a fresh httpx call per poll |

Dev `.env` has **no REDIS_URL** → in-memory rate limiting, embedded
scheduler, no queue. Production Redis presence can't be verified from the
repo (env-only). `get_redis()` pings on first call then caches
availability — bounded timeouts (5 s) prevent hangs.

`check_rate_limit` is now timed via `track_external` — when Redis is
configured its latency will appear as `ext_ms` on auth endpoints.

## Background jobs — embedded scheduler (60 s tick)

Per tick, 4 sequential sessions:

| Step | Query behavior |
|---|---|
| `expire_due` | full-column SELECT of all expirable tasks (company join), then conditional UPDATE + history insert per row — 20 k calls logged |
| `TemplateService.run_due` | `next_run_at <= now` filter (indexed) — cheap |
| `run_due_repetitive` | SELECT **all** repetitive tasks (no due filter), Python-side grid walk — 10 k calls logged |
| `RolloverService.run` | per company: SELECT all open tasks (6 statuses), Python op-day math, conditional UPDATE each — 87 k calls logged |

Every 15th tick: `reconcile_property` per property — **~3–4 sequential
queries × every resource** (rooms/dorms/beds/washrooms/fixtures). At
current scale (~200 resources) ≈ 400–600 sequential queries ≈ 5–7 s of
remote round-trips, sharing the same pool as foreground requests. This is
the source of the 32 k `tasks.bed_ids` + 61 k `maintenance_tickets`
blocker-probe counts in pg_stat_statements (0-row results each — pure
polling overhead).

## Observed impacts

- No queue backlog data available (arq worker unverified; enqueue path
  only used opportunistically).
- The tick is serialized in the API event loop in dev; each sweep holds a
  session (pool connection) for its duration — during the ~5–7 s
  reconciliation window, 1 of ≤22 pool slots is occupied. Not a latency
  spike source at this scale, but it scales with resource count.
- `dispatch_allocation_notices` (post-commit EB webhook) is correctly
  fire-and-forget with a timeout cap — never on the request path.

## Recommendations

- Batch reconciliation queries (group by resource type, one query per
  blocker family per property) → ~6 queries per sweep.
- Move `run_due_repetitive`/`_roll_company` candidate scans to
  indexed predicates (`series_id`/`operational_date`-aware WHERE) or add
  `expires_at`/`next_run_at`-style gating so ticks touch ~0 rows when
  idle.
- Confirm whether prod runs BOTH the embedded scheduler AND an arq cron —
  the tick runs once per process either way, but verify only one owner is
  configured.
