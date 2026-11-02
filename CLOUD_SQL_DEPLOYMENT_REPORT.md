# Cloud SQL — Deployment Report (Stage 2, Phases D–G)

**Date:** 2026-11-02 · **Executor:** `baljyotskhokhar@gmail.com` · **Project:** `final-airos-os` (#94363806721)

## Instance (created after explicit approval)

| Field | Value |
|---|---|
| Instance | `airos-postgres-dev` |
| Connection name | `final-airos-os:asia-south1:airos-postgres-dev` |
| Engine / version | PostgreSQL **15** (ZONAL, `asia-south1-c`) |
| Machine | `db-custom-1-3840` (1 vCPU, 3.75 GB) |
| Storage | 10 GB SSD, autoresize enabled |
| Deletion protection | **enabled** |
| Backups | daily @02:00, 7 retained, **PITR enabled** |
| Insights | Query Insights enabled |
| Connectivity | public IP assigned, **zero authorized networks — connector-only** |
| Status | RUNNABLE |

## Databases & users

| Object | Name | Notes |
|---|---|---|
| Database | `airos_dev` | sole app DB (besides system `postgres`/`cloudsqladmin`) |
| Migration user | `postgres` | cloudsqlsuperuser — used once for btree_gist + `alembic upgrade head` |
| App user | `airos_sa_app` | granted ALL on all tables/sequences + default privileges (grants applied post-migration — Cloud SQL users are NOT auto-privileged on postgres-owned objects) |

## Secrets (names only — values never exposed)

`airos-dev-postgres-password`, `airos-dev-app-db-password` — auto-replicated, version 1, project `final-airos-os`.

## Schema applied

- `CREATE EXTENSION btree_gist` (pre-created before migration — required by `q9e2f5a8c3d7` EXCLUDE constraint).
- `alembic upgrade head` — full 40-revision chain applied cleanly, **no destructive ops, no prod-data assumptions triggered**.
- Result: `alembic_version = v9f2b5c8d1e4`, **40 app tables**, 3 ticket sequences.
- The `t6d0e4a8f2b5` revision seeds one `mobile_releases` row (1.0.0 APK registry entry) — migration-owned system record, not fake data.

## Initial data (Phase F)

**None needed beyond the migration-seeded `mobile_releases` row.** No system roles/config records exist in the codebase — `POST /auth/signup` (AuthService.signup) is the provisioning mechanism (company + SA user, atomic). No fake rows were created.

## Dev connection config (Phase G — documented, not applied to .env)

`backend/.env` was left untouched (local dev still uses its own DB). To point dev at Cloud SQL:

```
# via cloud-sql-proxy (final-airos-os:asia-south1:airos-postgres-dev --port 5433):
DATABASE_URL=postgresql+asyncpg://airos_sa_app:<secret>@127.0.0.1:5433/airos_dev
DB_POOLER_MODE=direct          # no pgbouncer — prepared-statement caches stay ON
# on Cloud Run (instance-attached): use unix socket
DATABASE_URL=postgresql+asyncpg://airos_sa_app:<secret>@/airos_dev?host=/cloudsql/final-airos-os:asia-south1:airos-postgres-dev
```

Note: `backend/.env.cloudsql.example` could not be written — `.env.*` is gitignored; this section carries the equivalent content.

## Files created/modified (dev tooling only)

| File | Change |
|---|---|
| `backend/scripts/cloudsql_migrate.py` | NEW — connector-based Alembic runner (gcloud token → connector creds, btree_gist, per-loop engine injection, `to_thread` for nested `asyncio.run`) |
| `backend/scripts/cloudsql_grant.py` | NEW — postgres-side grants for `airos_sa_app` |
| `backend/scripts/cloudsql_validate.py` | NEW — schema validation harness |
| `backend/scripts/` +3 dev scripts | no application code modified |
| Local tooling | `cloud-sql-python-connector[asyncpg]` pip-installed into `py -3.12` |

## Unresolved issues

1. `users.role` CHECK on a fresh chain allows only 3 role labels (`INFERRED` — EB extends to 5 elsewhere); SA needs only super_admin/property_manager — acceptable for dev.
2. `area_allocation_state` table created but unused (dead schema — matches prod).
3. Local dev still needs `cloud-sql-proxy` binary or the connector approach to reach the instance (zero authorized networks by design — verified working via the scripts above).
4. `RUN_EMBEDDED_SCHEDULER`/app deployment intentionally not done — Stage 2 is DB-only.
