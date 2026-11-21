# Technical Debt Register

## Code quality debt

| ID | Sev | Location | Debt |
|----|-----|----------|------|
| TD-01 | Medium | `frontend/src/context/AppContext.tsx` (2,733 LOC) | God-context: session + all collections + all mutations + toasts + perf markers. Every new feature grows it further; merge conflicts and re-render cost compound. |
| TD-02 | Medium | `backend/app/services/structure.py` (2,217 LOC) | Property/area/zone/room/dorm/washroom/bed/washroom-fixture lifecycle in one service. Split by aggregate (structure, units, washrooms) when next touched. |
| TD-03 | ~~Medium~~ **done** | ~~`backend/app/api/v1/workspace.py` (1,640 LOC, ~99 routes)~~ | Now `app/api/v1/workspace/` package — 8 domain routers + `_common.py`; identical URL surface. |
| TD-04 | ~~Medium~~ **done** | ~~Employee coverage computed in ≥4 places~~ | `app/domain/coverage.py` owns `covers_zone`/`covers_area`/`covers_area_direct`, mirrored in the employee backend; 6 predicate sites consolidated. `maintenance._employee_coverage` (set-expansion, not a predicate) stays local by design. |
| TD-05 | Low | `app/core/queue.py` + `arq` dep | Dead queue path (zero `enqueue` callers) still installed/initialized. Either remove or implement the worker it was built for. |
| TD-06 | Low | `frontend/src/dev/perf.ts` | Dev-only perf markers imported by 6 production modules. Gate behind build flag. |
| TD-07 | Low | Legacy deploy surface | `deploy/centrifugo/`, `railway.toml`, `vercel.json`, `main`-push GHA workflows — kept per ops decision but documented as legacy; candidates for removal once GCP-only path is confirmed permanent. |
| TD-08 | Low | 37 `except Exception` sites | Mostly logged correctly; adopt `ruff BLE001` to force deliberate broad catches. |
| TD-09 | Medium | No backend lockfile | `requirements.txt` is all `>=` floors → non-reproducible builds. Adopt `uv pip compile` / pip-tools to produce `requirements.lock`. |
| TD-10 | Low | In-function imports | `workspace.py` lazily imports structure models inside functions — symptom of layering tension; resolve when workspace.py splits. |
| TD-11 | Low | TypeScript `^7.0.2` (native/Go toolchain) | Bleeding-edge; pin behavior and verify plugin/test-runner compatibility over time. Frontend `lint` script is `tsc --noEmit` only — no ESLint/Prettier configured at all. |
| TD-12 | Medium | Zero frontend lint/format toolchain | No ESLint, no Prettier, no pre-commit hooks. Style drift is already visible (mixed quote/spacing patterns). |

## Architectural debt

- **Shared `alembic_version` across two repos.** The mirror-revision convention works but is
  enforced only by convention + docstrings. A CI check that both repos' chains resolve to the same
  head (and that revision IDs match file-for-file) would make it mechanical.
- **Boot-time schema check is asymmetric**: this repo refuses to boot on stale schema; the
  employee backend has no such check and will run against newer schema silently.
- **Status derivation is centralized** (good) but repair tooling is manual (`POST
  /resources/{t}/{id}/repair`, super_admin only) — a scheduled drift scan/alarm would close the
  loop.
- **Notifications/events are fire-and-forget** (`session.info` buffers + after-commit POST).
  Best-effort is intentional; a durable outbox table would remove the "missed on crash between
  commit and dispatch" gap.
