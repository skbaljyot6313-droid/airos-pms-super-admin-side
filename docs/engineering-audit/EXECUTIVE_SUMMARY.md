# Executive Summary — Engineering Audit

_Audit date: 2026-11-17 · `super-admin` repo · read-only; docs only under `docs/engineering-audit/`._

## Overall assessment

This is **not** a typical vibe-coded codebase. The backend is disciplined: layered
router→service→repository, a pure domain transition table, a single authoritative status writer,
consistent tz-aware datetimes, hashed refresh tokens, magic-byte upload validation, per-service
tenant scoping, batched serializers, lock timeouts, ~249 backend tests, and prod-fatal
misconfiguration checks. Someone engineered defensively — the problem is **concentration and a few
unclosed gaps**, not pervasive sloppiness.

Grade: **B− engineering health.** Ship-shape core, three confirmed security/reliability gaps worth
closing now, and well-understood scaling debt in the frontend state layer and two backend monolith
files.

## Top 10 findings (by priority)

| # | ID | Severity | Finding |
|---|-----|----------|---------|
| 1 | BUG-01/SEC-01 | **High** | Refresh tokens never rotate; reuse undetectable for 30 days (characterized by an existing test). |
| 2 | BUG-08 | **High** | Shared `alembic_version` across two repos enforced only by convention; employee backend has no boot-time schema check — asymmetric failure surface. |
| 3 | BUG-02/SEC-02 | Medium | `GET /media/file/{key}` serves objects **without auth** when the key isn't referenced by a task row. |
| 4 | BUG-03/SEC-03 | Medium | `JWT_SECRET_KEY=""` default is fatal only when `APP_ENV=production` — mislabeled envs sign forgeable tokens. |
| 5 | BUG-05/TD-01 | Medium | `AppContext.tsx` 2,733-LOC god-context — every mutation re-renders the tree; optimistic rollback is hand-rolled per action. |
| 6 | TD-02/TD-03 | Medium | `structure.py` (2,217) + `workspace.py` (1,640, ~99 routes) concentrate merge/coupling risk. |
| 7 | TD-04 | Medium | Employee coverage logic duplicated across 4 services — already caused a 4-site touch for secondary-zone/property-wide. |
| 8 | TD-09/RSK-05 | Medium | No backend lockfile — `>=` floors everywhere; builds aren't reproducible. |
| 9 | RSK-02 | Medium | `/workspace` bootstrap holds ~9 pool connections concurrently — fine at current scale, starves under pool pressure. |
| 10 | TESTING | Medium | Zero E2E coverage and zero lint/format toolchain — the daily critical journeys are unprotected. |

## Top 10 improvement opportunities

1. Refresh-token rotation + reuse detection (closes #1 with a contained endpoint change).
2. Fail-closed JWT secret in every environment (one-line gate change, big blast-radius reduction).
3. Explicit media-public matrix + fix the unauthenticated-serve gap.
4. Backend lockfile + `ruff` + frontend `eslint/prettier` + pre-commit — cheap, permanent hygiene.
5. GCP Error Reporting (zero-code) or Sentry — turns "recurring bugs" into grouped, alerted data.
6. Playwright smoke suite on the 5–8 critical journeys — highest-value regression net.
7. Shared-chain CI check + EB boot-time schema check — converts the shared-DB convention into an
   enforced invariant.
8. Split `AppContext` per-collection — incremental, no big-bang.
9. Extract shared employee-coverage fragment — kills live 4-way drift.
10. Remove or implement the dead arq queue; strip `dev/perf` from the prod bundle.

## What's healthy (don't touch)

Domain transition table + `ResourceStateService` single-writer model; timezone discipline; upload
pipeline; per-service tenant scoping; hashed refresh storage + fatal prod warnings; batched
serialization and `/workspace` aggregation; the 26-site `FOR UPDATE` + partial-unique-index
invariant strategy; backend test culture.

## Recommended next step

Approve **Phase 0 + Phase 1** of `MODERNIZATION_ROADMAP.md` (safety rails + auth hardening —
~1 week total, no user-visible change) before any structural refactoring. The audit produced zero
changes to application code; awaiting your go-ahead for Phase 2 (controlled refactoring).
