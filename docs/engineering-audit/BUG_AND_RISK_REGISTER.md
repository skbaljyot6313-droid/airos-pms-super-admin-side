# Bug & Risk Register

Confirmed = observed in code/tests. Potential = plausible failure mode without reproduction.

> **Remediation status (2026-11-17):** BUG-01, BUG-02, BUG-03 and BUG-04 are
> fixed in the working tree — refresh tokens rotate with reuse-detection +
> family revocation (`services/auth.py`, `FOR UPDATE` row lock), orphan media
> objects 404, media authz uses one batched property lookup instead of the
> per-task `_property_for_write` loop, and an empty JWT secret can no longer
> sign tokens outside prod (ephemeral key + loud warning). Phase-0 rails
> landed alongside: `requirements.lock`, ruff config (clean baseline),
> Prettier, and `.github/workflows/ci.yml`.
>
> **Phase 2 — shared-boundary hardening (2026-11-17):** the EB-side half of
> BUG-08 is closed — `employee/backend/app/main.py` now mirrors
> `check_schema_version` (boot-fatal on drift, tolerant of local SQLite dev
> with no `alembic_version`, `/ready` reports `schema`). The EB coverage gap
> behind the secondary-zone/property-wide allocation feature is closed:
> `employees.secondary_zone_id`/`covers_property` are mapped read-only in EB
> and unioned into `_employee_coverage` (maintenance raise + picklist),
> `_eligible_pools` (all allocation paths converge there), and the
> live-locations zone filter. RSK-01 got a degraded-mode alarm (throttled,
> counts fail-opens). Shared-schema contract tests now pin the linear chain,
> mirrored revisions, mapped columns, and shared tables on **both** repos.
> Deferred by design: a DB-outbox for `notify-allocation` — EB's
> ledger-synthesis backstop already recovers missed notices; revisit only if
> missed-notification complaints appear.

## Confirmed issues

| ID | Sev | Loc | Problem | Impact | Pri |
|----|-----|-----|---------|--------|-----|
| BUG-01 | High | `app/services/auth.py` refresh flow; `tests/test_security_discovery.py::test_characterizes_sequential_refresh_reuse_without_rotation` | **Refresh tokens are not rotated and reuse is not detected.** The test characterizes the same refresh token working repeatedly across its 30-day validity. A stolen/exfiltrated refresh token (XSS, log leak, device theft) grants silent access for up to 30 days; revocation is all-or-nothing, with no reuse-detection tripwire. | Session hijack persistence; undetectable replay | P1 |
| BUG-02 | Medium | `app/api/v1/media.py` `get_media_file` | Objects **not referenced by any task** are streamed without authentication (`if tasks:` gates the whole authz block). Design intent is "unguessable uuid keys", but any non-task upload (e.g. employee profile photos, future upload types) is effectively public if the key leaks; keys also appear in URLs in logs/browser history. | Unauthenticated disclosure of non-task media | P1 |
| BUG-03 | Medium | `app/core/config.py` `JWT_SECRET_KEY: str = ""` | Empty default only becomes **fatal when `APP_ENV=production`**; any environment deployed with `APP_ENV` unset/`development` signs tokens with an empty key → trivially forgeable JWTs. Dev/staging exposure depends on deploy hygiene. | Forged tokens on mislabeled envs | P1 |
| BUG-04 | Medium | `app/api/v1/media.py` `get_media_file` → `StructureService._property_for_write` | Read path calls a *write-scoping* helper per matching task in a loop; each call re-queries the property. Bounded by result size but semantically wrong and N+1-shaped. | Confusing authz semantics; extra queries | P2 |
| BUG-05 | Medium | `frontend/src/context/AppContext.tsx` | Single god-context (2,733 LOC): every mutation re-renders the entire subscribed tree; optimistic updates hand-rolled per action with manual rollback — rollback correctness is only as good as each handwritten path. | UI churn; inconsistent-state windows | P2 |
| BUG-06 | Low | `frontend/src/dev/perf.ts` imported by `api/client.ts`, `App.tsx`, `AppContext.tsx`, `TaskDetailDrawer`, `usePolling`, `realtime/client.ts` | Dev instrumentation ships in the production bundle (correlation markers, timing logs). Harmless but dead weight and log noise. | Bundle/log noise | P3 |
| BUG-07 | ~~Medium~~ **done** | ~~`app/core/queue.py` + `requirements.txt: arq>=0.26`~~ | Deleted 2026-11-17 — `queue.py`, the `arq` dep (pyproject/requirements/lock), `close_queue` hook, and stale arq comments removed. No worker ever existed. | Dead dependency surface | ~~P3~~ |
| BUG-08 | High (operational) → **mitigated** | Shared `alembic_version` row between this repo and the employee backend | Two codebases own one migration chain. ~~EB had no check~~ — EB now mirrors `check_schema_version` (boot-fatal on drift) and `/ready` exposes `schema`. Residual: deploys still must keep both repos' chains in sync; contract tests now assert single-head + mirrored revisions on both sides (`y5d8f2a6c4e1` extended coverage, `b4e9f2a7c3d6` multi-area join table). | Cross-service deploy coupling; outage risk | P1 → P2 |
| BUG-09 | Low | `App.tsx` `RequireAuth` + `auth/Login.tsx` already-authed redirect | Deep links do not survive a hard reload: any protected URL bounces to `/login` while the session bootstrap is in-flight, then the login component redirects to the role landing — the requested path is lost (found by the E2E suite; tests use in-app nav instead). | Users sharing/bookmarking deep links land on the wrong view | P3 |

## Potential risks (unproven, worth testing)

| ID | Sev | Loc | Risk | Pri |
|----|-----|-----|------|-----|
| RSK-01 | Medium | `app/core/rate_limit.py` | Limiter **fails open** on Redis error (documented). A Redis outage disables brute-force protection exactly when infra is degraded. | P2 |
| RSK-02 | Medium | `GET /workspace` aggregate | Nine collections each open their own pooled session in `asyncio.gather`. Under pool pressure (small `pool_size` + concurrent users) a bootstrap can hold ~9 connections at once; starvation manifests as slow login rather than error. | P2 |
| RSK-03 | Medium | Optimistic UI + realtime invalidation | Realtime events are hints; if an event is missed (channel resubscribe gap) the collection stays stale until next mutation/poll. No periodic refresh fallback for most collections (live-locations is the exception at 10 s). | P2 |
| RSK-04 | Low | `backend/uploads/` local storage in dev | Dev-uploaded media is referenced by DB rows but lives outside the repo; a fresh clone + shared dev DB shows broken images. Documented in AGENTS.md but unversioned. | P3 |
| RSK-05 | Medium | No lockfile for backend (`requirements.txt` uses `>=` floors everywhere) | Any rebuild/deploy can silently pull newer transitive versions — build reproducibility and "it worked yesterday" regressions. Frontend has `package-lock.json`; backend has none. | P2 |
| RSK-06 | Low | `except Exception` (37 sites) | Mostly logged-and-wrapped correctly; a few (`config.py:271`, `database.py:57/106/157`, `redis.py:54`) swallow deliberately. Each is defensible, but the pattern deserves a lint gate (`ruff BLE001`) to keep intent explicit. | P3 |
| RSK-07 | Medium | `Services commit inside service methods` | Single-commit convention is good, but callers that invoke two services in one request get two transactions — a mid-request failure can leave a committed first half (e.g. switch = checkout pipeline + new occupancy relies on being one txn; it is, but the pattern is fragile for future composite flows). | P2 |
