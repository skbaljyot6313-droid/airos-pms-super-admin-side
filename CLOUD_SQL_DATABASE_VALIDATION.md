# Cloud SQL — Database Validation Report (Phase H)

**Date:** 2026-11-02 · **Instance:** `airos-postgres-dev` · **DB:** `airos_dev` · **Method:** Cloud SQL connector (IAM), app user `airos_sa_app` — no production or external DB touched.

| Check | Result | Evidence |
|---|---|---|
| PostgreSQL connectivity (connector, app user) | ✅ PASS | `pg_database` listing: `airos_dev` present; roles `postgres`/`airos_sa_app` loginable |
| Alembic head | ✅ PASS | `alembic_version = v9f2b5c8d1e4` (expected head) |
| Tables | ✅ PASS | **40/40 expected app tables** — zero missing, zero extra (+`alembic_version`) |
| btree_gist extension | ✅ PASS | present (`plpgsql`, `btree_gist`) |
| Ticket sequences | ✅ PASS | `maintenance_ticket_seq`, `task_ticket_seq`, `work_batch_seq` |
| EXCLUDE constraint (attendance_requests overlap) | ✅ PASS | `pg_constraint contype='x'` count = 1 |
| Indexes | ✅ | **187** |
| Foreign keys | ✅ | **97** |
| Unique constraints | ✅ | **16** |
| Check constraints | ✅ | **322** |
| Commit visibility | ✅ PASS | inserted row readable post-commit |
| Rollback behavior | ✅ PASS | forced-rollback insert discarded (count unchanged) |
| Unexpected tables | ✅ none | exact set match |
| Privileges after grant step | ✅ PASS | `airos_sa_app` has ALL on tables/sequences + default privileges |

**Outcome: VALIDATION PASSED.** The dev database is a complete, self-consistent replica of the AiROS schema as defined by the codebase's own migration chain — no manual DDL, no external data, no production connectivity.
