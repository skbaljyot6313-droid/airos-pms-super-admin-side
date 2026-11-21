# Performance Audit

## Strengths (verified)

- `/workspace` bootstrap replaces a 9-request burst with one request running 9 pooled
  `asyncio.gather` queries (api/v1/workspace.py:141–219).
- `_tasks_list_payload` resolves per-task area via four batched `IN()` queries — no row-level N+1
  (workspace.py:102–138).
- Eager loading is used deliberately: `selectinload`/`joinedload` in maintenance (16 sites),
  structure (13), task (9), template (7).
- `SET LOCAL lock_timeout` is configured on sessions (`core/database.py:294`) — runaway lock
  waits fail fast instead of queueing.
- Login path was already optimized: last-login UPDATE + refresh INSERT merged into a single CTE
  round trip (`services/auth.py:95–111`).
- GZip middleware; media responses bypass gzip (`Content-Encoding: identity`) so Content-Length
  survives for progress UI.
- Upload pipeline logs stage timings (read/validate vs storage vs audit-commit).

## Findings

| ID | Sev | Finding | Evidence | Recommendation |
|----|-----|---------|----------|----------------|
| PERF-01 | Medium | Bootstrap holds up to ~9 pool connections concurrently | `/workspace` `_collect` opens one `AsyncSessionLocal` per collection | Right-size pool for expected concurrency (50–60 users → measure `checkout` wait); consider merging low-cardinality collections into fewer queries or sequential batches of 3. |
| PERF-02 | Medium | Media fetch does per-task `_property_for_write` loop | `media.py:182–187` | Resolve once — fetch task→property ids in the same query, check company/role against the set. |
| PERF-03 | Medium | `AppContext` re-renders whole app tree on any mutation | single context value object | Split contexts (session / collections / actions) or move hot collections to keyed stores; memoize the value. |
| PERF-04 | Low | Live-location polling 10 s/tab regardless of activity | `LiveLocationMap` | Fine at current scale; add visibility-based pause (`document.hidden`) if tab counts grow. |
| PERF-05 | Low | Unbounded `list` payloads | Several `list_*` endpoints return all rows (`items` + `total` only) | Add pagination limits before tables grow (tasks, audit/events are the growth tables). |
| PERF-06 | Low | `dev/perf.ts` in prod bundle | imports across 6 modules | Strip via build-time flag or conditional import. |
| PERF-07 | Info | Bundle size unmeasured | no bundle budget/analysis in CI | Add `vite build --report`/rollup-plugin-visualizer once; Leaflet+markercluster+dnd-kit+centrifuge are the heavy deps — all lazy-loaded views already help. |

## Database efficiency notes

- Growth tables to watch: `tasks`, `task_history_events`, `audit_events`,
  `allocation_events`, `notifications`. Confirm indexes cover the hot filters
  (property_id + status + due_date/occurred_at). Partial unique indexes already guard the
  important invariants.
- Rollover sweep uses conditional UPDATE-per-row inside a loop — fine at current volume; if task
  counts reach tens of thousands per property, convert to set-based UPDATE.
- No evidence of per-row awaits inside serialization hot paths in the audited list endpoints.
