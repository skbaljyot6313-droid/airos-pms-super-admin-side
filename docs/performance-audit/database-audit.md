# Database Audit

Source: live read-only probes (`scripts/audit_probe.py` →
`data/db-probe-20261015-065019.json`) + `pg_stat_statements` (enabled on
the project). Stats include BOTH the SA backend and the Employee Backend
(shared database) — attribution noted per query.

## Connection path

- URL: `…pooler.supabase.com:6543` → **transaction-mode pooler**.
- App pool: `pool_size=12, max_overflow=10, recycle=300, timeout=30`
  (dev `.env`; defaults 5/5/1800/30). `pool_pre_ping=False` (correctly
  avoids a per-checkout RTT).
- Fresh connect cost: median **116 ms** (p95 279 ms) — TLS+auth+pooler
  `get_auth` (44 k calls observed server-side). Every pool-growth event
  and every 300 s recycle pays this per new connection.
- Warm `SELECT 1`: median **12.5 ms**.
- pg_stat_activity at probe time: 9 sessions total, 1 active — headroom is
  fine; no exhaustion observed.
- **Verified alternative:** session pooler :5432 accepts connections AND
  named prepared statements (tested live) — it is the compatible mode for
  this stack (see B-01/B-02).

## pg_stat_statements — top by total time

| calls | mean | max | what |
|---|---|---|---|
| 87,445 | 0.1 ms | 4.7 | `tasks JOIN properties … status IN (6 open) AND expires_at<=now` — `RolloverService._roll_company` candidate scan (per company × 60 s tick; EB runs an equivalent) |
| 44,042 | 0.5 ms | 49.9 | `pgbouncer.get_auth` — per new physical connection auth |
| 32,514 | 0.02 ms | 1.7 | `SELECT tasks.bed_ids WHERE dorm_id AND status IN(3)` — `_bed_blockers` / reconciliation per-bed check |
| 61,521 | 0.02 ms | 3.1 | `SELECT maintenance_tickets.id WHERE status IN(3) AND <resource>` — resource-blocker check per derive/reconcile |
| 20,274 | 0.1 ms | 34.6 | `expire_due` sweep (expires_at<=now, expirable statuses) |
| 10,137 | 0.3 ms | 10.0 | `tasks WHERE task_type='repetitive' AND recurrence IS NOT NULL` — `run_due_repetitive` full scan each 60 s |
| 98 | **66 ms** | **2727** | `zone_allocation_state … FOR UPDATE` — round-robin lock waits under allocation |
| **7** | **3997 ms** | **16393** | `tasks WHERE property_id AND room_id IN(25) AND status NOT IN(3) FOR UPDATE` — `_mark_cleaning_work_done` (bulk mark-cleaned/available) — **lock waits**, not scan cost |
| 2 | 1047 ms | 2093 | same query, 16-room variant |

## Interpretation

1. **Hot-path reads are cheap** (all measured list queries ≤ ~20 ms at
   current scale: 587 tasks, 87 rooms, 115 beds, 42 employees). There is
   no indexing emergency — every FK column observed is `index=True`.
2. **Volume, not cost, is the DB story:** ~200 k app-level statement
   calls accumulated, dominated by scheduler sweeps and per-resource
   blocker probes that each return 0 rows almost always. Cheap × huge
   count still = real load + connection churn (each query = RTT + fresh
   parse since B-01).
3. **Lock-wait outliers exist on write paths:** the FOR UPDATE task sweep
   hit 16.4 s — a bulk release contended with another transaction holding
   task rows (probably a generation/allocate or another bulk op).
   `zone_allocation_state FOR UPDATE` max 2.7 s similar.
4. **Unindexed FKs (low risk):** `attendance_requests.reviewed_by_id`,
   `employee_shift_assignments.created_by_id`, `occupancies.checked_*_by`,
   `resource_state_events.actor_user_id`,
   `task_completion_submissions.reviewed_by_id` — audit/actor columns
   rarely used in joins today; add only if a query needs them.
5. **`_paged()` never applies LIMIT/OFFSET** — `list_*` repos return the
   entire tenant-scoped table; `page`/`limit` params only relabel the
   response. Harmless now (≤587 rows), a cliff at ~10⁴ rows per company.

## Recommendations (evidence-ranked)

- Switch `DATABASE_URL` to the **session pooler :5432** → restores
  prepared-statement reuse (~1 RTT/query saved) AND removes the pgbouncer
  failure mode. Verify `DB_POOL_RECYCLE` ≥ backend idle timeout.
- Add index `(property_id, status)` or partial
  `… WHERE status IN (blocking)` on `maintenance_tickets` and
  `(dorm_id, status)` on `tasks` ONLY if blocker-probe volume justifies —
  currently 0.02 ms mean: **do not add** (would slow writes for nothing).
- Batch the reconciliation sweep (one grouped query per blocker type per
  property instead of per-resource) — cuts ~400 queries/sweep to ~6.
- Keep `FOR UPDATE` sweeps but bound them (`LIMIT` + per-unit batches) to
  cap worst-case lock windows.
