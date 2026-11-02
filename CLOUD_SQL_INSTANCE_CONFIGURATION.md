# Cloud SQL — Proposed Instance Configuration (Phase C)

**Date:** 2026-11-02 · **Project:** `final-airos-os` (#94363806721) · **Region:** `asia-south1`
**Status: PROPOSAL — nothing created. Approval required before Phase D.**

---

## 1. Engine & version

| Decision | Value | Rationale |
|---|---|---|
| Engine | **Cloud SQL for PostgreSQL** | required |
| Major version | **`POSTGRES_15`** | Evidence-based, not "latest": app features (btree_gist EXCLUDE, generated columns, partial unique indexes, JSONB, sequences) exist since PG12+; **Supabase prod runs PG15 generation** → dev/prod behavior parity; PG16/17 offer nothing this codebase uses and would deviate from prod |
| Edition | **Enterprise** (not Enterprise Plus) | dev workload; Plus features unneeded |

## 2. Instance identity & HA

| Field | Proposed value |
|---|---|
| Instance name | **`airos-postgres-dev`** |
| Region / zone | `asia-south1` / **single-zone (ZONAL)** — dev only; no HA replica (HA ~doubles cost) |
| Machine type | **`db-custom-1-3840`** — 1 vCPU dedicated, 3.75 GB RAM |
| Storage | **10 GB SSD (`PD_SSD`)**, `storageAutoResizeEnabled: true` |
| Deletion protection | **enabled** |
| Backups | automated daily (`backupConfiguration.enabled`), start time low-traffic IST |
| Point-in-time recovery | **enabled** (`pointInTimeRecoveryEnabled`, WAL archiving ~7 days retained) |
| Maintenance window | any — dev |
| Database flags | none required (defaults OK; `max_connections` default ~100 ≥ our budget) |
| Insights/query insights | enable Query Insights (free, useful for dev debugging) |

### Sizing math (evidence-based, from `deploy/cloudrun.md` + `core/config.py`)

| Consumer | Pool | Worst-case conns |
|---|---|---|
| SA API on Cloud Run (1 worker/instance × max 4) | 5+5=10/proc | **40** |
| Local dev / migration runs | 10/proc × 2 procs | 20 |
| Alembic during migration | 1 | 1 |
| Headroom | — | ~40 |
| **Total max concurrent** | | **~100 ≤ default `max_connections`** ✅ |

`db-custom-1-3840` comfortably serves ≤100 conns for a dev workload whose hottest statement is the 60 s scheduler sweep. **Budget alternative:** `db-g1-small` (shared-core, 1.7 GB) ~half price — acceptable but tighter under load-test bursts; recommended only if cost is the primary concern.

## 3. Connectivity design (RECOMMENDATION)

**Primary: Public IP + Cloud SQL connector** — the Cloud Run native path:

- Instance gets a public IP but **`authorizedNetworks: []` (zero)** — nothing can TCP-connect directly; only connector-mediated IAM-authenticated access works. No `0.0.0.0/0`, no authorized networks at all.
- Cloud Run mounts the instance via `--add-cloudsql-instances=final-airos-os:asia-south1:airos-postgres-dev`; app connects over Unix socket `/cloudsql/final-airos-os:asia-south1:airos-postgres-dev` — asyncpg supports it: `DATABASE_URL=postgresql+asyncpg://USER@/DB?host=/cloudsql/...`.
- Runtime SA `airos-sa-dev@` gets `roles/cloudsql.client` on the instance only — least privilege.
- Local work (alembic, psql) uses **`cloud-sql-proxy`** (already an installed gcloud component) with the same connector auth — no IP allowlisting ever needed.
- `DB_POOLER_MODE=direct` — no pgbouncer → prepared-statement caches stay ON (~1 RTT saved/query vs prod's transaction pooler).

**Deferred alternative:** private IP + Direct VPC egress — requires `compute`+`vpcaccess` APIs and networking resources; **not created without approval**. Not needed for dev since connector auth is already IAM-gated.

## 4. Users & databases (Phase D/E)

| Object | Name | Notes |
|---|---|---|
| Database | `airos_dev` | single DB, all 40 tables (see §B design — shared schema required by SA reads of EB tables) |
| App user | `airos_sa_app` | generated password; `CONNECT`/`USAGE`/DML+DDL-owning on `airos_dev`; **NOT `postgres`** |
| Migration user | `postgres` (built-in cloudsqlsuperuser) | used once via cloud-sql-proxy for `CREATE EXTENSION` + `alembic upgrade head` |
| Secrets (names only) | `airos-dev-database-url` (full asyncpg socket URL), `airos-dev-postgres-password` | Secret Manager in `final-airos-os` |

## 5. Cost estimate (ESTIMATES — not verified prices; Cloud SQL pricing varies)

| Component | Est. monthly |
|---|---|
| `db-custom-1-3840` dedicated core, ZONAL, asia-south1 | ~US$50–55 |
| 10 GB SSD + autoresize headroom | ~US$2 |
| Backups + 7d PITR WAL | ~US$1–3 |
| Egress to Cloud Run (same-region connector) | ~US$0–1 |
| **Total** | **~US$55–60/mo** |
| Budget alt `db-g1-small` | ~US$25–30/mo total |

## 6. Approval request

Proposed for creation in Phase D on your approval:

> **`airos-postgres-dev`** — Cloud SQL PostgreSQL **15**, `db-custom-1-3840`, 10 GB SSD autoresize, single-zone `asia-south1`, deletion protection ON, daily backups + PITR, public IP with **zero authorized networks**, Cloud SQL connector only, Query Insights on. DB `airos_dev`; app user `airos_sa_app`; creds in Secret Manager; migrations via `postgres` over cloud-sql-proxy.
>
> **Est. ~US$55–60/month** (or `db-g1-small` ~$25–30 if you prefer the budget tier).

**STOP — awaiting your approval before creating any billable resource.**
