# System Flow

## Frontend → backend communication

- All calls go through `apiFetch` (`frontend/src/api/client.ts`): attaches bearer JWT, on 401
  attempts `POST /auth/refresh` **once** then invokes `onUnauthorized` → context logout.
- Wire IDs are `*_uid` strings; backend serializes `UUID → *_uid` in `schemas/*_out()` mappers.
- Errors normalize to `ApiError(status, message, fieldErrors)`.
- `AppContext.loadWorkspace()` calls `GET /api/v1/workspace` — one aggregate request that runs 9
  collection queries on independent pooled sessions (`asyncio.gather`), replacing a 9-request burst.
- Realtime (Centrifugo) events are invalidation hints → refetch; never authoritative payloads.
- Live-location map polls `GET /live-locations` every 10 s while the tab is open.

## Critical business workflows

### Task lifecycle
`pending → assigned → in_progress → completed` (+ `submitted` = employee-app PENDING_CHECK,
`reopened` via reject/request-redo). Staff approve/reject via review queue; decisions write shared
`notifications` rows. Completion requires photo evidence (`TaskCompletionSubmission` +
`TaskCompletionImage`). `RolloverService` sweeps: `expire_due` at `expires_at`
(`NEXT_SCHEDULED_OCCURRENCE`), `run` = midnight-IST abandonment of open tasks anchored to prior
op-days. `series_id` links recurring clones; `uq_tasks_series_due` + `TemplateGeneration` ledger
make generation idempotent.

### Occupancy & unit status
`occupancies` rows (open iff `checked_out_at IS NULL`) are the truth; `occupied` is illegal without
an open row — enforced at the service layer, backed by partial unique indexes on open rows.
Checkout closes the row, flips the unit to `cleaning` (or `available` via `release_to`) and spawns
the housekeeping task atomically. Guest switch = close-source + open-target occupancy in one
transaction. `ResourceStateService.derive()` recomputes unit status from open work + occupancy.

### Work allocation
Zone round-robin with persistent `ZoneAllocationState` pointer (locked `FOR UPDATE`); pools =
primary zone ∪ secondary zone ∪ whole-property employees; area pools as fallback; department
eligibility by work type. `allocate_units()` batches per property. Every allocation audited in
`WorkAllocationHistory`; `record()` also buffers an event on `session.info` → after-commit POST to
the Employee Backend `notify-allocation` (best-effort, timeout-capped, never blocks the commit).

### Attendance & shifts
`status_board()` is the single evaluator: open day → working/on_break; ended day → completed
(on_time/late, early-exit); scheduled-past-cutoff → absent; clock-in w/o assignment → unscheduled;
stale open day → `incomplete + needs_review` (fails closed). Floor map filters to
working/on_break server-side. Attendance never gates work allocation.

### Media
`POST /media/uploads` → signature-validated, bounded read → `StorageBackend.save` → uuid key +
audit row. `GET /media/file/{key}` streams through the origin; whitelist regex on keys; objects
referenced by tasks are company/role-checked before serving; unreferenced objects are served
without auth (documented design decision — see SECURITY_AUDIT SEC-02).

### Boot-time guarantees
Lifespan: DB connect → `check_schema_version` refuses boot when `alembic_version ≠ head` →
`production_warnings()` are fatal in prod (empty JWT secret, no DB, DEBUG=true, local storage).
