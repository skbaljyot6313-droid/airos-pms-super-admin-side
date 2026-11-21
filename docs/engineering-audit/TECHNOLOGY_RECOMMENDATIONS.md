# Technology Recommendations

Evaluation of the current stack against requirements (single-team SaaS, 50–60 users, shared
Postgres, GCP hosting). Recommendations are deliberately conservative — no rewrites, no new infra
without measurable need.

## Keep as-is (justified)

- **FastAPI + SQLAlchemy 2 async + asyncpg + Alembic + Pydantic 2.** Right-sized, actively
  maintained, well-used here (typed models, async sessions, real constraint discipline).
- **Postgres as single source of truth.** Correct choice at this scale; the domain's
  state-derivation model depends on transactional consistency that a document store would weaken.
- **React 19 + Vite + Tailwind 4.** Modern, fast enough; component style is consistent.
- **Pluggable `StorageBackend`.** Three concrete backends is mild over-engineering but cheap; keep.
- **Embedded scheduler + external cron tick.** Already pragmatic: cron-tick endpoint exists
  because Cloud Run CPU scheduling makes in-process loops unreliable — keep the Cloud Scheduler
  path, keep embedded only for dev.

## Recommended changes

| Area | Now | Recommendation | Why | Complexity | Risk |
|------|-----|----------------|-----|------------|------|
| Backend deps | floating `>=` floors, no lockfile | `uv pip compile requirements.in > requirements.lock` (or pip-tools) | Reproducible builds; deploy rollbacks mean something | Low | Low |
| Refresh tokens | never rotate | Rotation + reuse detection in `AuthService.refresh` | Standard practice; kills the 30-day silent-replay window | Medium | Low (single endpoint; test exists to invert) |
| Frontend lint | none | ESLint (typescript-eslint + react-hooks) + Prettier + pre-commit (husky/lint-staged or `lefthook`) | Catches the class of bugs a 2,733-line context breeds; normalizes style | Low | Low |
| Backend lint | none | Ruff (E/F/W/I/UP/BLE/ASYNC) | Fast, consolidates flake8+isort+pyupgrade; `BLE001` audits broad excepts | Low | Low |
| Frontend state | god-context | Split `AppContext` into session / collections / actions providers; or adopt Zustand for collections | Bounded re-renders, testable stores; do it incrementally per collection | Medium | Medium (touches all consumers — do it collection-by-collection) |
| Error tracking | logs only | Sentry (backend `sentry-sdk[fastapi]` + frontend `@sentry/react`) — or GCP Error Reporting (free, native) | "Recurring bugs" without error tracking is flying blind; GCP Error Reporting needs zero SDK work via structured logs | Low | Low |
| Tests | pytest + vitest, no e2e | Playwright smoke suite (5–8 critical journeys) | Highest-value regression net for the money | Medium | Low |
| CI | GHA workflows exist for legacy deploys | Add a `ci.yml`: backend pytest + ruff, frontend tsc + vitest, alembic heads check across both repos | Catches shared-chain drift mechanically | Low | Low |
| Queue | arq dep, zero callers | Remove arq+worker scaffolding OR implement the intended worker — decide within one sprint | Dead deps are attack surface + install cost | Low | Low |
| Migrations | mirrored chains by convention | Keep single linear chain; add the CI check above rather than tooling changes | The convention works; enforcement is the gap | Low | Low |

## Explicitly not recommended

- **Microservices** — a second service boundary already exists (employee backend); splitting the
  monolith further adds deploy/migration coordination cost with no scaling justification at 60
  users.
- **Redis-everywhere caching** — Redis is already optional infra for rate limiting; adding a cache
  layer before measuring query latency is premature. `selectinload` discipline is doing the work.
- **ORM replacement / raw SQL migrations** — no evidence of ORM bottleneck.
- **Kubernetes** — Cloud Run already matches the workload shape.
