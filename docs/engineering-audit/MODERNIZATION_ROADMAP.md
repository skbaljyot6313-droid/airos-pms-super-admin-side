# Modernization Roadmap

Phased, reversible, sized for an actively-used production system. Each phase is independently
deployable; nothing requires a big-bang cutover.

## Phase 0 — Safety rails (1–2 days, zero behavior change)

1. Backend lockfile via `uv pip compile` — pin the tree that is actually running in prod.
2. `ruff` (backend) + `eslint`+`prettier` (frontend) with *report-only* baseline; ratchet rules on
   new code only.
3. CI: `pytest`, `tsc`, `vitest`, alembic-single-head check in this repo; matching check that the
   employee repo's chain resolves the same head.
4. Error tracking: structured logs → GCP Error Reporting (zero code), or Sentry SDK if richer
   grouping/alerts wanted.

**Outcome**: reproducible builds, mechanical drift checks, visibility into the "recurring bugs".

## Phase 1 — Auth hardening (2–4 days, contained)

1. Refresh-token rotation + reuse detection (revoke family on replay). The existing
   characterization test inverts into the security regression test.
2. JWT secret: fail closed in all envs (remove `is_production` gate on the empty-secret check;
   dev auto-generates a local secret).
3. Media authz: define the public/unpublic matrix explicitly; fix `if tasks:` gap per SEC-02;
   collapse per-task `_property_for_write` loop while in the file.

**Outcome**: the two P1 security findings closed; media semantics documented in code.

## Phase 2 — Reliability of the shared boundary (3–5 days) — **done 2026-11-17**

1. ~~Schema-snapshot contract tests in both repos~~ → `tests/test_shared_schema_contract.py` on
   both sides (single head, mirrored revisions, mapped columns, shared tables) + EB coverage
   regression tests (`tests/unit/test_extended_coverage.py`).
2. ~~Boot-time schema-head check on EB~~ → mirrored `check_schema_version`; boot-fatal on drift,
   tolerant of local SQLite dev, `/ready` reports `schema`.
3. ~~Durable outbox for `notify-allocation`~~ → **consciously deferred**: EB ledger synthesis is
   the recovery backstop; revisit only if missed notifications surface.
4. ~~Rate-limiter degraded-mode alarm~~ → throttled ERROR with cumulative fail-open count.
5. Follow-on fix found during verification: EB never read the SA-written coverage columns —
   `secondary_zone_id`/`covers_property` are now mapped and unioned into maintenance coverage,
   allocation pools, and the live-locations zone filter.

**Outcome**: deploy-order fragility becomes detectable; the two services stop silently diverging.

## Phase 3 — Structure (incremental, alongside feature work)

1. ~~Split `api/v1/workspace.py` by domain~~ → **done 2026-11-17**: now a package
   `app/api/v1/workspace/` — 8 domain routers (`bootstrap`, `reads`, `structure`,
   `occupancy`, `employees`, `tasks`, `maintenance`, `properties`) + `_common.py`
   helpers, aggregated in `__init__.py`. Identical 99-route URL surface (verified
   by decorator diff + live OpenAPI).
2. ~~Extract shared employee-coverage fragment~~ → **done 2026-11-17**:
   `app/domain/coverage.py` (`covers_zone` / `covers_area` / `covers_area_direct`),
   mirrored verbatim in the employee backend; 6 sites consolidated across both
   repos (allocation pools, employee directory zone filters ×2, live-locations
   filter). One place now owns the union semantics.
3. Split `AppContext`: start with session provider; then pull `tasks` and `employees` collections
   into their own context/store. No big-bang — one collection at a time. *(deferred —
   incremental frontend work, do alongside the next UI feature)*
4. ~~Strip `src/dev/perf` behind build flag; delete arq~~ → perf.ts was already gated on
   `import.meta.env.DEV` (compile-time); **arq deleted** (`core/queue.py`, dep from
   pyproject/requirements/lock, `close_queue` hook, stale comments).
5. ~~Pagination caps~~ → `/maintenance` now accepts `page`/`limit` (limit ≤500, pushed
   into the SQL query) with full-list default preserved for the client-filtered board;
   `/tasks` was already capped at 500; structure entities are bounded by domain.

**Outcome**: merge-risk concentration reduced; UI render cost bounded; dead surface removed.

## Phase 4 — E2E confidence ✅ (done 2026-11-17)

1. ~~Playwright suite: login → bootstrap → task lifecycle → occupancy switch → review decision.~~
   Done — `frontend/e2e/smoke.spec.ts`, 4 specs covering login+workspace bootstrap,
   pending-task listing, review-queue approve, and the occupancy-switch modal
   (all through the real FastAPI stack; serial workers against one fixture DB).
2. ~~Seedable dev fixtures so the suite runs deterministically against the dev DB.~~
   Done — `backend/scripts/e2e_seed.py`: sqlite mode (create_all + stamped head)
   or Postgres mode (`alembic upgrade head` + idempotent fixture reset). Seed
   inserts company/property/zone/rooms/PM user/pending+submitted tasks/open
   occupancy. Verified end-to-end on a throwaway `postgres:16-alpine` container —
   the full migration chain applies cleanly and login/CTEs run on the real dialect.
3. ~~Add to CI as a required check on `development-branch`.~~
   Done — `e2e` job in `.github/workflows/ci.yml` (postgres service → migrate+seed
   → `npx playwright test`; traces uploaded on failure).

## Sequencing rationale

Safety rails first because every later change is cheaper with them. Auth hardening second because
BUG-01/BUG-03 are the highest-severity confirmed findings. Shared-boundary work third because the
operational risk is asymmetric (EB boots on stale schema). Structure work deliberately last — it
pays off over quarters, not weeks, and is safest after tests exist.
