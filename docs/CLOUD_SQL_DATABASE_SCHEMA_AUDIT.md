# Cloud SQL — Database Codebase Audit (Phase A)

**Date:** 2026-11-02 · **Scope:** `super-admin` repo only (Employee Backend repo not present — EB findings marked INFERRED)
**Verified active project:** `final-airos-os` (#94363806721), billing enabled — `gcloud config list` + `billing projects describe`
**Rule compliance:** no GCP resources created; no external DB touched; no credentials printed.

---

## A. Architecture verification

`VERIFIED` — this repo's data layer is: **FastAPI + SQLAlchemy 2.x async + asyncpg + Alembic + PostgreSQL**, custom JWT auth (HS256 access + opaque hashed refresh), Argon2id password hashing (`argon2-cffi`). No ORM other than SQLAlchemy; no MongoDB; no Supabase Auth anywhere.

## B. Database model inventory

**40 physical tables** are created by the Alembic chain (`VERIFIED` — `op.create_table` extraction across `backend/alembic/versions/*.py`). 35 have ORM models in `backend/app/models/`; 5 are migration-created only (`device_registrations`, `location_events`, `location_tracking_sessions`, `mobile_releases` — EB-owned; `area_allocation_state` — dead schema).

| Table | Model file | Creating revision | Owning backend | Key columns / constraints |
|---|---|---|---|---|
| `companies` | company.py | e01da4bc153a | SA (EB reads geofence cols) | company_name, operational_day_start '06:00', +DB-only latitude/longitude/geofence_radius_m (EB) |
| `users` | user.py | e01da4bc153a | SA | email∪, username∪, password_hash, role enum(5), company_id FK, property_id/employee_id/zone_id (no FK), is_active, last_login_at |
| `refresh_tokens` | refresh_token.py | e01da4bc153a | SA | user_id FK, token_hash∪, expires_at, revoked |
| `properties` | property.py | 345d9736662b | SA | company_id FK, code 'PROP-NNN', manager fields, status |
| `areas` | structure.py | 345d9736662b | SA | property FK, UC(property_id,name), level_number |
| `zones` | structure.py | 345d9736662b | SA | property+area FK, UC(property_id,name), zone_type |
| `rooms` | structure.py | 345d9736662b | SA | UC(property_id,room_number), status CHECK 4-state, bed_count |
| `dorms` | structure.py | 345d9736662b | SA | property/zone/area FKs, status |
| `beds` | structure.py | 345d9736662b | SA | UC(dorm_id,bed_number), 5-state CHECK, guest_name |
| `washrooms` | structure.py | e9f2a4b6c8d0 (+f3c8e1a2b6d4 dorm_id, g4d9f2b3c7e5 UC) | SA | dorm-attached 1-per-dorm UC or zone-level, 4-state CHECK |
| `washroom_fixtures` | structure.py | e2b7d4a8c1f5 | SA | UC(washroom_id,type,number), operational\|maintenance\|inactive |
| `employees` | employee.py | 345d9736662b (+c4d81e7b2f05, a2d4f6b8c0e1) | SA (EB reads for mobile app) | company+property FKs, zone/area XOR, status, leave_status, deactivated_at |
| `tasks` | task.py | 345d9736662b (+~12 later revs) | SA | ~50 cols; `uq_tasks_open_room_title` partial-UC, `uq_tasks_series_due`, `ix_tasks_expires_at` partial, bed_ids JSON, series_id self-FK, automation_rule JSONB |
| `task_history_events` | task.py | 345d9736662b | SA | task FK, type/at/actor/note/photos |
| `task_completion_submissions` | task.py | d8e1f2a3b4c5 | SA | UC(task_id,attempt_number), status pending\|approved\|disapproved |
| `task_completion_images` | task.py | b4c6d8e0f2a1 | SA | task/submission/history FKs, url, storage_key |
| `maintenance_tickets` | maintenance.py | 649b374bfc29 (+027058f5a060 dorm/bed) | SA | ticket_number∪ 'MT-YYYY-NNNNN' (PG seq), exactly-one-target, 7-state status |
| `maintenance_ticket_events` | maintenance.py | 649b374bfc29 | SA | event stream |
| `maintenance_ticket_attachments` | maintenance.py | 649b374bfc29 (+k8b3d4f6a1c2 attempt) | SA | url, kind issue\|resolution |
| `occupancies` | occupancy.py | i6f1b2d4e8a0 (+j7a2c3e5f9b1) | SA | room XOR bed CHECK (no FK), partial-UC open-room/open-bed, `checked_out_at IS NULL` = open |
| `resource_state_events` | resource_state_event.py | i6f1b2d4e8a0 | SA | resource_type/id, prev→new, source, actor |
| `work_templates` / `_versions` / `template_generations` | template.py | db39ee38a729 | SA | config JSONB, version UC, (template_id,occurrence_key) UC idempotency ledger, next_run_at idx |
| `zone_allocation_state` | work_allocation.py | f0ac59d056c6 | SA | zone_id UC, last_assigned_employee_id — RR pointer FOR UPDATE |
| `work_allocation_batches` / `_history` | work_allocation.py | f0ac59d056c6 | SA | batch 'WB-YYYY-NNNNN' seq, method, actor |
| `allocation_events` | allocation.py | a38d5c90adfd | SA | employee/room/dorm zone reassignment history |
| `audit_events` | audit.py | h5e0a3c4d8f6 | SA | property-scoped entity lifecycle + field diffs |
| `attendance_days` | attendance.py | p8d1f4a7c2e5 | **shared — EB writes, SA reads** | UC(employee,date), partial-UC open session |
| `attendance_breaks` | attendance.py | p8d1f4a7c2e5 | shared | partial-UC open break |
| `attendance_requests` | attendance.py | p8d1f4a7c2e5 (+q9e2f5a8c3d7, r4b8d2f6a0c3e) | shared | inclusive ranges, generated `leave_range` daterange + **EXCLUDE USING gist** (needs btree_gist) |
| `shifts` | shift.py | v9f2b5c8d1e4 | shared | IST times, grace, Mon-first working_days bitmap |
| `employee_shift_assignments` | shift.py | v9f2b5c8d1e4 | shared | effective windows, overlap prevented |
| `notifications` | notifications.py | s5c9e3a7d1f4 | shared — SA writes submission_approved/disapproved; EB owns feed | CHECK'd type vocab |
| `device_registrations` | — (Core table() in employee_profile.py) | s5c9e3a7d1f4 | **EB-owned, SA read-only** | device_id, platform, app_version, is_active |
| `location_events` | — (Core table()) | s5c9e3a7d1f4 | **EB-owned, SA read-only** | employee/property/source/flagged/recorded_at |
| `location_tracking_sessions` | — (Core table()) | u7e1f5a9d3c6 | **EB-owned, SA read-only** | employee, status, started/ended, point_count |
| `mobile_releases` | — (Core table()) | t6d0e4a8f2b5 | **EB-owned, SA read-only** | platform/version/version_code/force_update |
| `area_allocation_state` | — | f19a2b3c4d5e | **dead schema** — no ORM, zero references | orphaned at creation |

Conventions (`VERIFIED`): PK `Uuid` default uuid4 (app-side); `created_at/updated_at` server_default now(); FKs CASCADE on tenant edges / SET NULL on references; wire IDs serialized `*_uid`.

## C. Alembic migration audit (`VERIFIED` via scripted graph walk)

| Property | Value |
|---|---|
| Total revisions | **40 — single linear chain** |
| Root | `e01da4bc153a` (companies+users+refresh_tokens) |
| Head | **`v9f2b5c8d1e4`** (shifts+assignments) — single head, no branches |
| Chain integrity | 40-node path root→head verified; no missing parents |
| `alembic.ini` | URL built from `app.core.config.settings` — no credentials in config |
| Raw SQL ops | `CREATE SEQUENCE` (`maintenance_ticket_seq`, `task_ticket_seq`, `work_batch_seq`), `CREATE EXTENSION IF NOT EXISTS btree_gist` (q9e2f5a8c3d7), generated-column + EXCLUDE constraint DDL |
| Data migrations | Backfill UPDATEs only: `b7f3c21a9e04` (series_id=id), `f19a2b3c4d5e` (tasks.area_id), `a2d4f6b8c0e1` (employee lifecycle), `i6f1b2d4e8a0` (status normalization), `j7a2c3e5f9b1` (guest_name ''), `c7e8f1a2b3d4`/`d8e1f2a3b4c5` (submission backfills) — **all no-ops on an empty DB** |
| Destructive ops in upgrade | Column drops only: `e2b7d4a8c1f5` (washroom count cols — superseded by fixtures), `q9e2f5a8c3d7` (attendance_requests.attendance_date/request_type → replaced by range cols) — **no `DROP TABLE` in upgrade path** |
| Prod-data assumptions | **None** — every data migration tolerates empty tables (`VERIFIED` by reading the UPDATEs: all are UPDATE...WHERE on existing rows) |
| Privilege requirement | `CREATE EXTENSION btree_gist` inside `q9e2f5a8c3d7` **requires a role with extension-create rights** — on Cloud SQL, `postgres` (cloudsqlsuperuser) can create it; a least-privilege app user CANNOT → migrations must run as `postgres` or the extension must be pre-created |
| Multiple heads | None |
| `check_schema_version` | `app/main.py:47` compares DB stamp vs script head, resolves EB-owned stamps via `u7e1f5a9d3c6` — a fresh DB at `v9f2b5c8d1e4` passes cleanly |

## D. Application database dependencies (ownership map)

| Fact | Evidence |
|---|---|
| SA and EB share **one Postgres database** and **one `alembic_version` row** | AGENTS.md gotchas; `u7e1f5a9d3c6` EB-mirror revision; audit docs |
| The SA migration chain **itself creates all 40 tables** including EB-owned (`device_registrations`, `location_events`, `location_tracking_sessions`, `mobile_releases`) and shared (`attendance_*`, `shifts`, `employee_shift_assignments`, `notifications`) | `VERIFIED` — create_table extraction above |
| EB applies its *own* revisions **beyond** `u7e1f5a9d3c6` on the shared stamp (EB repo absent) | `INFERRED` from AGENTS.md — EB-owned tables exist in SA chain so a SA-only dev DB is fully self-sufficient |
| **Dev decision (RECOMMENDATION):** ONE database `airos_dev` containing all 40 SA-chain tables. Do NOT create separate SA/EB databases — the SA code reads EB-owned tables (devices endpoint, attendance board, notifications writes) and would break on a split schema | codebase evidence |
| No schemas other than `public` | `VERIFIED` — no schema-qualified names |

## E. Background processes → table access map

| Process | Trigger | Reads | Writes | Locking |
|---|---|---|---|---|
| `RolloverService.expire_due` | 60 s tick | tasks (open recurring) | tasks (abandon), task_history_events | conditional UPDATE |
| `TemplateService.run_due` | 60 s tick | work_templates(next_run_at idx), zones/areas/employees | tasks, maintenance_tickets, template_generations (ledger UC), work_allocation_* | SAVEPOINT dedup |
| `TaskService.run_due_repetitive` | 60 s tick | tasks (all repetitive — Python grid walk) | tasks (series clones) | uq_tasks_series_due |
| `RolloverService.run` | 60 s tick | tasks (all open, per company), companies | tasks (abandon + history) | conditional UPDATE |
| `reconcile_property` | every 15th tick | rooms/dorms/beds/washrooms/fixtures/tasks/tickets/occupancies (~3-4 q/resource) | none (read-only) | — |
| `OccupancyService.checkout*` | request | occupancies, resources | occupancies, tasks, resource status | FOR UPDATE on occupancy+resource rows |
| `WorkAllocationService` | request/template | employees, workloads, zone_allocation_state | work_allocation_* | **FOR UPDATE on zone_allocation_state row** |
| `ResourceStateService` | many paths | blocker queries per resource | resource status + resource_state_events | FOR UPDATE per resource |
| `verify_queue`/auth | login | users | refresh_tokens, users.last_login_at (CTE single-write) | — |
| `capture_mutations` hook | every flush | — | audit_events | before_flush |
| `after_commit` hooks | every commit | — | EB HTTP call + Centrifugo publish (no DB writes) | session.info buffers |

## F. Database-related environment variables (names + purpose only)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | full async URL (asyncpg); may embed `${SUPABASE_DB_PASSWORD}` placeholder |
| `SUPABASE_DB_{HOST,PORT,NAME,USER,PASSWORD}` | URL assembly parts when DATABASE_URL absent — **dev will use DATABASE_URL directly** |
| `DB_POOL_{SIZE=5, MAX_OVERFLOW=5, RECYCLE=1800, TIMEOUT=30}` | pool tuning |
| `DB_POOLER_MODE` | pgbouncer mode; **`direct` for Cloud SQL** (prepared-statement caches stay on) |
| `SQL_ECHO` | SQL logging |
| `DB_POOL_PRE_PING` | set on deployed services but **dead** — not in Settings (`extra=ignore`) |

## G. Blocking findings for Phase D/E

1. `btree_gist` extension must exist before `q9e2f5a8c3d7` completes — run migrations as `postgres` (cloudsqlsuperuser) **or** pre-create extension (`RECOMMENDATION`: pre-create during provisioning, then migrations can run as app user too — but `CREATE EXTENSION IF NOT EXISTS` still needs the privilege at migrate-time only if missing → pre-creating solves it).
2. `users.role` CHECK on live DB allows 5 roles but initial migration only 3 — constraint evolved outside migrations (`INFERRED` EB-side). Fresh dev DB gets whatever the chain produces; only `super_admin`/`property_manager` are used by SA anyway.
3. `area_allocation_state` is dead schema — will be created (harmless) but is unused.
4. Alembic must run as a DB user able to CREATE EXTENSION (see #1) — plan migration runs under `postgres` via cloud-sql-proxy, then app connects as least-privilege `airos_sa_app` user.
