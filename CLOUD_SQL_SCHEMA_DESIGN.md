# Cloud SQL — Schema Design (Phase B)

**Date:** 2026-11-02 · **Target:** fresh dev database `airos_dev` on Cloud SQL `airos-postgres-dev` (proposed)
**Source of truth:** the existing 40-revision Alembic chain — the design IS the migration chain; nothing is invented and nothing is hand-drawn. `alembic upgrade head` reproduces everything below.

---

## 1. Design overview

- **One database** `airos_dev` on `public` schema — SA and EB share one schema in production; the SA chain builds all 40 tables, so a single dev DB is complete and self-sufficient.
- **35 ORM-mapped tables + 5 non-ORM** (`device_registrations`, `location_events`, `location_tracking_sessions`, `mobile_releases` — EB-owned, read by SA via Core `table()` defs; `area_allocation_state` — dead).
- **Auth model preserved:** `users` (argon2id `password_hash`, role enum, company/property scoping) + `refresh_tokens` (sha256 `token_hash`, 30-day `expires_at`, `revoked` flag) — custom JWT, no Supabase Auth.
- **Tenant isolation:** `companies` root; `properties.company_id`; nearly every row carries `property_id` or `company_id` and is filtered in services, not RLS.

## 2. Table-by-table design (condensed — full column detail lives in `docs/codebase-index.md` §7 and the migrations)

### Identity & tenancy

| Table | Purpose | PK | Key constraints/indexes | Owner |
|---|---|---|---|---|
| `companies` | tenant root | uuid PK | — | SA |
| `users` | staff+employee accounts | uuid PK | `email`∪, `username`∪, role CHECK, `company_id` FK→companies | SA |
| `refresh_tokens` | JWT refresh | uuid PK | `token_hash`∪, `user_id` FK, `expires_at`, `revoked` | SA |
| `properties` | managed sites | uuid PK | `company_id` FK, `code` 'PROP-NNN'∪ | SA |

### Structure hierarchy (Property→Area→Zone→units)

| Table | Purpose | Key constraints | Owner |
|---|---|---|---|
| `areas` | floor levels | UC(property_id,name); FKs CASCADE | SA |
| `zones` | functional zones | UC(property_id,name); `zone_type` gates stay-units | SA |
| `rooms` | guest rooms | UC(property_id,room_number); status CHECK (4) | SA |
| `dorms` | shared rooms | status CHECK | SA |
| `beds` | dorm beds | UC(dorm_id,bed_number); 5-state CHECK | SA |
| `washrooms` | dorm-attached or zone washrooms | **UC 1-per-dorm** (g4d9f2b3c7e5); 4-state CHECK | SA |
| `washroom_fixtures` | per-fixture status | UC(washroom_id,type,number); 3-state CHECK | SA |
| `employees` | staff records | zone_id/area_id SET NULL XOR; status; leave_status | SA/EB read |

### Occupancy & resource state

| Table | Purpose | Key constraints | Owner |
|---|---|---|---|
| `occupancies` | occupancy truth | `room_id XOR bed_id` CHECK (no FK); partial-UC `open room`/`open bed`; `checked_out_at IS NULL`=open | SA |
| `resource_state_events` | status transition log | FK-free resource_type+id | SA |

### Work domain

| Table | Purpose | Key constraints | Owner |
|---|---|---|---|
| `tasks` | unit of work | **`uq_tasks_open_room_title`** partial-UC; **`uq_tasks_series_due`** (series_id,due_date); `ix_tasks_expires_at` partial; `series_id` self-FK; `bed_ids`/JSON, `automation_rule` JSONB; `ticket_number`∪ via `task_ticket_seq` | SA |
| `task_history_events` | task audit | task FK | SA |
| `task_completion_submissions` | review attempts | UC(task_id,attempt_number); status 3-state | SA |
| `task_completion_images` | evidence | task/submission/history FKs | SA |
| `maintenance_tickets` | maintenance | `ticket_number`∪ 'MT-YYYY-NNNNN' (`maintenance_ticket_seq`); exactly-one-target; 7-state | SA |
| `maintenance_ticket_events` / `_attachments` | ticket audit/evidence | ticket FKs | SA |
| `work_templates`/`_versions`/`template_generations` | recurring work | UC(template_id,version); **`(template_id,occurrence_key)` UC** ledger; `next_run_at` idx | SA |
| `zone_allocation_state` | RR pointer | `zone_id` UC — **FOR UPDATE lock target** | SA |
| `work_allocation_batches`/`_history` | allocation audit | `batch_number`∪ (`work_batch_seq`) | SA |
| `allocation_events` | reassignment audit | — | SA |
| `audit_events` | cross-entity audit | property-scoped JSON detail | SA |

### Attendance & scheduling (shared SA↔EB)

| Table | Purpose | Key constraints | Owner |
|---|---|---|---|
| `attendance_days` | one row per employee-day | UC(employee_id,date); partial-UC open day | **EB writes, SA reads** |
| `attendance_breaks` | breaks within a day | partial-UC open break | shared |
| `attendance_requests` | leave/week-off | generated `leave_range daterange` + **EXCLUDE USING gist** (btree_gist) no-overlap | shared |
| `shifts` | shift defs | company/property scope; IST cols; bitmap | shared |
| `employee_shift_assignments` | shift windows | overlap prevented; history kept | shared |
| `notifications` | employee feed | `ck_notifications_type` CHECK | EB feed, SA writes decisions |

### EB-owned (created by SA chain, read-only to SA)

| Table | Purpose | Owner |
|---|---|---|
| `device_registrations` | employee app devices | EB |
| `location_events` | GPS points | EB |
| `location_tracking_sessions` | tracking sessions | EB |
| `mobile_releases` | app release registry | EB |
| `area_allocation_state` | **dead schema** — created but unreferenced | — |

## 3. Integrity & concurrency design (as built — verified in migrations/code)

- **Cascades:** tenant/ownership FKs `ON DELETE CASCADE`; reference FKs `SET NULL` (employee zone/area).
- **Locking:** `zone_allocation_state` FOR UPDATE (round-robin); occupancy+resource rows FOR UPDATE on checkout/transition; `_request_for_review` FOR UPDATE.
- **Idempotency:** `template_generations` ledger + SAVEPOINT dedup vs `uq_tasks_open_room_title`; `uq_tasks_series_due`; sequences for ticket numbers.
- **Blocking semantics enforced by CHECKs + exclusion constraint + partial unique indexes** — all present in the chain; nothing additional is designed here.
- **Indexes are evidence-based:** partial indexes on `expires_at`, open-room/open-bed, series-due, `next_run_at` — all have real query callers. No speculative indexes added.

## 4. What a dev DB gets vs prod reality

- `alembic upgrade head` → 40 tables, all constraints, 3 sequences, `alembic_version=v9f2b5c8d1e4`.
- `btree_gist` pre-created (see audit §G-1).
- `users.role` CHECK may allow only 3 roles on a fresh chain — SA only needs `super_admin`/`property_manager` (`VERIFIED` roles used in code) — acceptable for dev.
- Zero rows everywhere except `alembic_version` — the app's `POST /auth/signup` is the provisioning path (creates company + SA user atomically).
