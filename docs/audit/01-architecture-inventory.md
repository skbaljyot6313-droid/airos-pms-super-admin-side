# AiROS Super Admin: architecture discovery inventory

Date: 2026-11-03

## Status and evidence standard

**Stage 1 discovery checkpoint; not an exhaustive audit or stage-completion report.** Architecture entrypoints and dependencies below were inspected in this checkout. File discovery is not equivalent to reviewing every file. Security remediation, infrastructure verification, financial modelling, business-invariant verification and cleanup remain pending. No claim of production security, capacity or deployment state is made.

Evidence labels:

- **Implementation inspected:** read directly from source/configuration.
- **Located:** filename or symbol found; deeper implementation review pending.
- **Unverified:** requires isolated runtime evidence or read-only infrastructure evidence.

## Scope and working-tree baseline

- Repository: `C:/Users/skbal/Desktop/baljyot/super-admin`.
- Branch: `development-branch`, tracking `origin/development-branch`, initially ahead by one commit.
- Initial worktree HEAD: `cc0a4d2` (short identifier).
- No branch switch, commit, push, deployment, migration, account seeding or cloud mutation performed.
- Existing user changes include backend media/storage, frontend API/client/context/evidence upload work, new upload utilities/tests, Firebase configuration and scripts, a Cloud SQL copy script, and documentation moves from the root/deploy directories into `docs/`.
- These pre-existing changes are preserved. Initial Git status deletions are not audit deletions.
- Local environment files were not opened. Credentials and secret values are intentionally excluded.
- Root `AGENTS.md` was read in full. The Employee application is outside modification scope. Shared database interactions require particular care.

## Repository directory inventory

| Directory | Role | Review state |
|---|---|---|
| `backend/app/api/v1` | FastAPI route aggregator and business endpoints | Aggregator, auth, media and workspace bootstrap read; other endpoint signatures partially inventoried |
| `backend/app/core` | Settings, database pool, security, limiter, Redis, queue, storage, HTTP clients, middleware, realtime, timing and password verification | Most architecture primitives read; full security review pending |
| `backend/app/dependencies` | Bearer identity and role checks | Auth dependency read |
| `backend/app/domain` | Resource states, legal transitions and events | Located; rule-by-rule review pending |
| `backend/app/models` | ORM entities and constraints | Model files located and constraint declarations searched; refresh model read |
| `backend/app/repositories` | SQLAlchemy data access and tenant scoping | Workspace scoping/pagination and refresh-token repository read; remaining paths pending |
| `backend/app/schemas` | Pydantic wire contracts and output serializers | Located; field-by-field review pending |
| `backend/app/services` | Business operations and transaction boundaries | Auth refresh/logout read; resource/allocation/occupancy locking located; deeper review pending |
| `backend/alembic` | Shared-schema migrations | Revision files located; graph and upgrade validation pending |
| `backend/scripts` | API/DB probes, pooler compatibility, Cloud SQL migration/validation/copy/grants and Firebase deployment | Files located only; not executed |
| `backend/tests` | Backend regression suites | 13 test modules located; login fake-session setup inspected |
| `backend/uploads` | Existing local uploaded evidence | Preserve; contents not inspected or deleted |
| `frontend/src/api` | API wrappers and central authenticated client | Client read; wrapper inventory located |
| `frontend/src/components` | Admin, auth, employee, maintenance, property, room, task, template and UI views | Routes and component/test file families inventoried; full component review pending |
| `frontend/src/context` | Session, collection state, mutations and refresh coordination | Workspace and refresh call sites inspected |
| `frontend/src/hooks` | Polling and evidence upload hooks | Located |
| `frontend/src/lib` | Permissions, date/domain utilities, upload queue, image optimisation, safe log display | Located; individual utility review pending |
| `frontend/src/realtime` | Centrifuge client and subscription hooks | Located through imports; protocol/security review pending |
| `frontend/src/dev` | Development request/render instrumentation | Located through imports; bundle behaviour review pending |
| `frontend/public` | Public static assets | Contents review pending |
| `frontend/dist` | Generated production bundle | Rebuilt locally; not deployed |
| `frontend/node_modules` | Installed dependencies | Used for baseline validation; not a reviewed/pinned provenance guarantee |
| `deploy/centrifugo` | Centrifugo Dockerfile/config | Config read; image review pending |
| `.github/workflows` | Production and realtime deployment workflows | Both workflow files read |
| `tests/load` | Opt-in login/post-login load harness, seeder and analysis | Filenames located; no traffic generated |
| `docs/performance-audit` | Prior performance investigation | Markdown inventory located; historical results not adopted as current measurements |
| `docs` | Architecture index, feature notes, cloud/storage migration and deployment reports | Markdown filenames inventoried; content reconciliation pending |
| `.git`, `.vercel`, `frontend/.vercel`, `frontend/.firebase`, pytest caches | Git/provider/local tooling state | Preserve; no cleanup or secret-content inspection |

Root files include `main.py`, `README.md`, `AGENTS.md`, `.gitignore` and `.env.example`. `main.py` has not been executed; project rules warn that its launcher frees development ports.

## Application topology

```text
Browser: React SPA
  -> central apiFetch + bearer access token
  -> FastAPI /api/v1
     -> identity/role dependency
     -> service/repository -> SQLAlchemy async session -> PostgreSQL
     -> media storage adapter -> local disk / S3-compatible store / Supabase
     -> pooled HTTP client -> Employee Backend
     -> post-commit publish -> optional Centrifugo -> browser invalidation
     -> Redis fixed-window rate-limit counters (when configured)

API process embedded scheduler (when enabled)
  -> occurrence expiry -> template generation -> repetitive generation
  -> daily rollover -> periodic read-only reconciliation
  -> shared PostgreSQL
```

This describes supported code paths, not verified running cloud resources.

### Backend request routing

`backend/app/main.py` mounts `api_router` under `settings.API_V1_PREFIX` (default `/api/v1`). `api/v1/router.py` includes auth, workspace, media, work_batches, templates, attendance, shifts, locations, realtime and logs. Entity routes are largely concentrated in `workspace.py`, not the separate future router names in the aggregator's comments.

The application registers CORS, gzip for responses over 500 bytes, request IDs, access timing/logging, security headers and exception handlers. Production hides `/docs` and `/openapi.json` when `APP_ENV` equals the exact lowercase string `production` in the app constructor. The production-warning helper separately lowercases the environment; this discrepancy needs security review.

Startup verifies database connectivity and checks that the stored Alembic revision set equals the local script heads. It then optionally starts generation and initialises the shared Employee Backend HTTP client. Shutdown closes the HTTP, queue, Redis and database resources.

Health routes:

- `/health`: process liveness, not dependency readiness.
- `/health/db`: database `SELECT 1`.
- `/ready` and `/api/v1/health`: database, optional Redis and schema checks.

### Authentication and session flow

Implementation: `core/security.py`, `dependencies/auth.py`, `services/auth.py`, `api/v1/auth.py`, `repositories/refresh_token.py`, `models/refresh_token.py`, `frontend/src/api/client.ts`.

1. Signup creates a company and initial super-admin; login verifies credentials and issues access/refresh tokens.
2. Passwords use `argon2.PasswordHasher()` defaults. Exact installed hashing parameters and rehash policy remain to be verified.
3. Access tokens contain `sub`, `user_id`, `company_id`, `role`, `iat`, `exp` and `type=access`. Default signing is HS256; default expiry is 30 minutes.
4. Decode pins the algorithm to the configured value and checks token type. Mandatory claim presence, issuer/audience policy and key-strength validation need review; no complete JWT validation claim is made.
5. Opaque refresh tokens use `secrets.token_urlsafe(48)` and are stored as SHA-256 hashes. Default expiry is 30 days. Token hashes are unique.
6. **Refresh does not rotate the refresh token.** It reads a valid row, loads the active user, records an audit event and returns a new access token. No family/reuse-detection mechanism was observed in these paths.
7. Logout revokes the supplied refresh row. Existing access JWTs remain valid until expiry, subject to active-user checks.
8. Browser access and refresh tokens are persisted in localStorage. The client coalesces refresh exchanges within one JavaScript runtime and retries a failed authenticated call once. Refresh has no explicit fetch timeout in the inspected implementation.
9. Backend identity is resolved from the JWT subject and user repository/cache, rather than trusting role claims as current permission truth. The process-local identity cache defaults to a 60-second TTL; cross-process deactivation/role-change latency remains a review concern.

### Authorisation and tenancy

`require_role`, `require_super_admin` and `require_property_manager` centralise coarse role checks. The latter permits super-admin and property-manager users. Property/company isolation is additionally applied in services/repositories, not supplied by frontend route guards.

The inspected workspace helper scopes super-admin reads through company ownership, and other roles through the user's assigned property. This is not proof of endpoint-wide object-level isolation: every write and non-workspace read still requires a traced review and negative tests.

The SPA has authentication, role and property guards. Roles without an administrative surface redirect away from property views. Client guards remain usability controls, not the security boundary.

### Workspace and frontend data flow

- `App.tsx` lazy-loads major internal views under Suspense; public landing/auth components are eager imports.
- `AppContext.loadWorkspace()` calls the aggregate `/workspace`; a 404 triggers nine individual requests.
- Backend bootstrap uses `asyncio.gather` with **nine separate pooled sessions**, one per collection. This is parallel I/O, not a single database query or a consistent single-transaction snapshot.
- Default per-process DB capacity is 5 pooled connections plus 5 overflow. Authentication/session overhead and simultaneous bootstraps must be included in capacity tests.
- AppContext maintains collection state directly. The package manifest does not declare React Query.
- Refresh coordination deduplicates in-flight unit refreshes and merges a follow-up scope. Realtime events invalidate relevant collections; the global fallback poll is configured for 120 seconds.
- Full-list repository mode exists when `limit=None`; aggregation/pagination and growing response sizes require measured review before changing contracts.

### Database architecture and transaction flow

- SQLAlchemy async engine and `async_sessionmaker`, using asyncpg for PostgreSQL.
- `expire_on_commit=False`, `autoflush=False`.
- Request dependency rolls back on errors and closes sessions; commits belong to services/routes.
- Default pool: size 5, overflow 5, timeout 30 seconds, recycle 1800 seconds, pre-ping disabled. Actual deployment overrides are unverified.
- Supabase pooler mode is inferred from host/port unless explicitly configured; transaction mode disables prepared-statement caches and uses unique statement names.
- Process-local instrumentation records pool acquisition, DB timings, query counts, external timings and password verification timings.
- A helper sets transaction-local row-lock timeout to 10 seconds where invoked. It is not a global query timeout.
- Post-commit Session listeners dispatch allocation notices and realtime events. Savepoint commits are excluded in those listeners. Delivery is best-effort, not a durable transactional outbox.
- ORM families located: company/user/refresh; property/area/zone/room/dorm/bed/washroom/fixture; employee; task/history/submission/image; maintenance/event/attachment; occupancy; templates/version/generation; allocation state/batch/history/events; attendance/day/break/request; shifts/assignments; notifications; audit and resource-state events.
- Unique/check/partial-index declarations were located for several critical invariants, including occupancy, task attempts/series/open room work, template occurrences and allocation state. Migration-to-model parity and live constraint existence are **unverified**.
- Row locks were located in `ResourceStateService`, work allocation and occupancy. Concurrency correctness is **not yet verified**.
- The shared Employee Backend migration chain requires coordinated schema ownership. Do not stamp over unknown revisions or run migration/copy/grant scripts during discovery.

### Background work and Redis

The implemented embedded scheduler expires occurrences before generation, then generates templates/repetitive tasks, runs rollover and periodically scans reconciliation. Failures use bounded exponential backoff.

`core/queue.py` exposes an arq enqueue helper and separate arq pool. Search found no `WorkerSettings` or executable `generation_tick` implementation in backend Python source. The log message that arq owns ticks when embedded scheduling is disabled is not evidence of an actual worker. A safe external scheduler/worker owner must be demonstrated before disabling the loop or relying on scale-to-zero.

Redis rate limiting uses **fixed-window INCR/PEXPIRE**, despite older descriptions of sliding-window behaviour. The ordinary Redis client and arq helper instantiate separate pools. An in-memory limiter is used when Redis is unconfigured; Redis operation failures currently allow the request. Client-IP extraction directly accepts the first `X-Forwarded-For` element; trusted-proxy behaviour needs security testing. No Redis memory, key-count, TTL distribution, eviction or hit-rate measurements have been collected.

### Media and external dependencies

- Uploads require an authenticated user, optional property validation, MIME allowlisting, a 10 MiB application-level read bound and basic image signature checks.
- FastAPI multipart parsing occurs before the upload function's bounded read; a transport-level body limit has not been established from this inspection.
- New keys are UUID-based, with extensions derived from the declared/validated media type.
- Implemented adapters: local disk, boto3 S3-compatible storage and Supabase REST. No native GCS adapter was observed in the complete `storage.py` read. GCS plans must not be described as implemented storage support.
- `/uploads` is mounted publicly. `/media/file/{key}` is also public by design and rate-limited; it validates a flat UUID-key format, not tenant ownership. UUID unpredictability is not authorisation. Private evidence delivery requires a coordinated compatibility design, not simply adding bearer auth to image tags.
- Each inspected `open()` implementation buffers the object before yielding chunks. Streaming responses do not imply bounded-memory upstream streaming.
- Employee Backend calls support live-location proxying and post-commit allocation notices. Shared secrets stay server-side in the intended API contract. The employee service's own traffic, GPS retention and push-processing cost are outside the inspected implementation.
- Optional Centrifugo channels disallow anonymous/client subscription and client publishing in checked-in config; tokens/server subscription policy still require review.

## Deployment configuration versus deployed reality

| Evidence | What is implemented/configured | What remains unverified |
|---|---|---|
| `.github/workflows/deploy-production.yml` | Push to main/manual Railway backend and Vercel frontend deployment; no test/typecheck jobs or deployment environment approval declared | Whether enabled, actual deployed revision, remote branch protection and environment rules |
| `.github/workflows/deploy-centrifugo.yml` | Manual Railway realtime provisioning/configuration; includes a conditional Employee service variable mutation | Actual resources; cross-product side effects must not be exercised during this Super Admin audit |
| `backend/railway.toml` | Nixpacks, migration-before-serve, liveness healthcheck | Running Railway service values and scheduler ownership |
| `backend/Dockerfile` | Python 3.12 slim, requirements install, copy backend context, migration then uvicorn with configured workers/port | Cloud Run service CPU/memory/concurrency/scaling/network/service account |
| `frontend/firebase.json` | Development-named Hosting site, SPA rewrite and asset/index cache headers | Actual deployment state and header policy at the edge |
| `frontend/vercel.json` | Vite build/install and SPA fallback | Active Vercel settings/domains/headers |
| Existing cloud reports/scripts | Evidence sources to reconcile | Not independent proof of current Cloud SQL, GCS, IAM, Secret Manager or billing state |

No `.dockerignore` was found. The local backend contains `.env`, uploads, caches and a log file, while its Dockerfile uses `COPY . .`. This is a confirmed build-context hazard, not a claim that any particular secret was committed or deployed. Do not build/push an image until exclusions are reviewed.

The Docker command masks migration-command failure before starting the application; Railway instead uses `&&`. The application subsequently performs a strict schema-head check. Failure semantics and single-owner migrations need release-engineering review.

No live cloud, database, Redis, GitHub policy or billing queries were executed. No production configuration was changed.

## Dependency and verification inventory

- Backend has duplicated dependency declarations in `requirements.txt` and `pyproject.toml`, largely open-ended minimum versions. No Python dependency lockfile was located in the initial manifest search.
- Development requirements declare pytest/pytest-asyncio/respx without pins. No Ruff, MyPy, Bandit or dependency-scanner CI gate appears in the two inspected workflows.
- Frontend has `package-lock.json`. Installed manifest versions are not a vulnerability assessment.
- Frontend `lint` runs TypeScript compilation only; it is **not ESLint**. No lint success should be presented as ESLint coverage.
- Backend test modules located: auth login, DB pooler, employee events, employee profile, live locations, logs, media validation, performance regressions, realtime, shifts, task review and verification queue, plus `__init__.py` (13 Python files total; 12 named test modules).
- Load scripts are opt-in and include an account seeder. They were not run.

### Executed local baseline

All commands below ran from `frontend/` against the existing installed dependencies, without dependency upgrades:

| Command | Result |
|---|---|
| `npm run lint` | Passed, exit 0: `tsc --noEmit` only |
| `npm test` | Passed, exit 0: 8 files, 65 tests; Vitest reported 5.30 seconds total |
| `npm run build` | Passed, exit 0: Vite 8.3.0, 1,795 modules; bundler reported 957 ms |

Build observations: main JS chunk 409.41 kB (113.55 kB gzip); EmployeesView JS 272.63 kB (74.16 kB gzip). These are build outputs, not browser latency or load-test results. Commands ran concurrently; reported durations are not a controlled performance benchmark.

Test warnings: Node localStorage warning, a React `act(...)` warning in LogsView and repeated attempted realtime-token requests reporting errors. The suite passes but hermetic network mocking and warning cleanup need investigation. No successful live backend call is demonstrated by these tests.

Selected backend baseline executed with Python 3.12: `py -3.12 -m pytest tests/test_auth_login.py tests/test_verify_queue.py tests/test_db_pooler.py::TestPoolerModeDetection tests/test_db_pooler.py::TestPgbouncerConnectArgs -q` — **22 passed in 3.22 seconds**, exit 0. These use fake sessions/verification queues/configuration inspection; connectivity tests were deliberately excluded. The subprocess received an inert loopback database URL, test signing key, disabled scheduler, and empty Redis/Employee/realtime settings rather than relying on local service targets. This is not a full backend test run or a real database integration result.

The user selected local disposable services for integration/load testing. `docker version` found Docker CLI 29.9.1 but could not connect to the Docker Desktop Linux engine named pipe. No containers were created. Docker Desktop must be started before this path can proceed; credentials or access to the existing shared database are not a substitute.

Not executed: full backend suite/build, integration tests, auth/workspace load tests, DB/Redis stress tests, scanners, Docker image build, migration upgrades, deployed smoke tests. Baseline measurements cannot substantiate before/after improvements because no application code has been changed by this audit.

## Remaining discovery and subsequent stage gates

1. Complete source review for schemas, every route/service/query, domain transitions, migrations, upload deletion ownership and all frontend hooks/components.
2. Review the existing Markdown contents and scripts, distinguish historical/deployed claims, and build a link-aware documentation move proposal. No existing documents or tests are approved for removal by this inventory.
3. Obtain a positively identified isolated development database/Redis/API target before database integration or load testing. Local `.env` is not presumed safe.
4. Obtain read-only infrastructure evidence for current development/staging and production resources, metrics, IAM, backups and billing. Do not request secret values in chat.
5. Verify current asia-south1 pricing and exchange-rate inputs before calculating INR estimates. Employee workload/retention assumptions must be labelled, not inferred from the Super Admin browser alone.
6. Carry confirmed findings into the security reports, write regression tests and remediate only after discovery coverage is sufficient. Shared JWT/schema/media changes need interoperability review.
7. Complete all requested later-stage deliverables; none are silently considered done by this checkpoint.

## Change accounting at this checkpoint

- Added by audit: `docs/audit/01-architecture-inventory.md`.
- Existing source/configuration files modified by audit: none.
- Files deleted by audit: none.
- Local generated build artifacts: `frontend/dist` rebuilt by the verification command; no deployment.
- Stage 1: in progress. Stages 2–10: pending. No vulnerabilities claimed fixed, no cloud savings claimed realised, no 10,000-user capacity claim.

## Continuation: security discovery while Docker is unavailable

This section supersedes the initial checkpoint's change accounting for the continuation only. Detailed evidence and risk classifications are in [Security discovery](../security/SECURITY_AUDIT.md). No existing documentation was moved or removed.

### New verified evidence

- Auth schema and browser refresh implementation confirm that mandatory server-only rotation would break existing web sessions: refresh response contains no replacement refresh token, and the browser saves only the access token. Refresh deduplication is per runtime/tab. Mobile/shared-issuer compatibility remains unverified; no employee repository was changed.
- Six synthetic characterization tests were added in `backend/tests/test_security_discovery.py`. They reproduce sequential refresh reuse, four overlapping mocked refresh readers for one synthetic token/account, anonymous public-cached evidence access, authenticated-log-route denial without credentials, first-forwarded-IP trust and acceptance of a correctly signed access token with no expiry. These are local observations, not database concurrency tests or mitigations.
- Evidence models link files to task submission/history and maintenance issue/resolution records. The minimal attendance model has no photo field; actual shared-bucket attendance image content is unknown. Public key access and the public static mount bypass the separate company-scoped authenticated logs attachment path. Real object contents and deployed ACLs were not inspected.
- Scheduler lifespan starts an embedded loop per process when enabled; no ownership lock exists in the inspected loop. Template generation uses ledger uniqueness/savepoints, but initial due selection has no ownership locking. Deduplicated committed rows do not demonstrate singleton execution. Prevention remains unimplemented pending the review gate.
- The nine workspace sessions are an implementation choice, not a demonstrated business requirement. Sharing one AsyncSession concurrently would be unsafe. Sequential or bounded fan-out experiments must preserve scoping/serialization and measure real pool/tail-latency behaviour before adoption. A cold auth-cache dependency can retain an additional connection until request completion.
- Local Alembic graph command `py -3.12 -m alembic heads` passed with one head: `v9f2b5c8d1e4`. No migration application, DB schema check or database connection occurred.
- `py -3.12 -m pip check` passed; this is dependency consistency only. Bandit, Semgrep, pip-audit, Ruff and MyPy were not installed in the checked Python 3.12 environment.
- `npm audit --audit-level=high` exited 1 with 6 affected packages (1 moderate, 3 high, 2 critical). Advisory matches and dependency paths are recorded in the security report; no forced fixes/upgrades were applied, and deployed exploitability is not claimed.

### Tests executed in this continuation

`py -3.12 -m pytest tests/test_security_discovery.py tests/test_media_validation.py tests/test_auth_login.py tests/test_verify_queue.py -q`: **37 passed in 3.11 seconds**, exit 0. Subprocess environment pinned an inert loopback database URL, synthetic JWT key, disabled embedded scheduler and empty Redis/Employee/realtime settings. The initial new-fixture run had one failure because the mini-app omitted the project's exception handlers; that test fixture was corrected and rerun. No application fix was made.

Frontend build/typecheck/65-test results above remain the previous checkpoint's results, not a new run. No database, Redis or load-test measurement has been collected.

### Docker and isolated services

Repeated Engine checks still fail with the absent `dockerDesktopLinuxEngine` named pipe. The Docker client exists, but image availability could not be listed. PostgreSQL/Redis containers, networks and volumes were not created. SQLAlchemy integration, migrations on fresh PostgreSQL, transaction/pool measurements, Redis verification and real authentication/scheduler concurrency remain **blocked**, not passed. The selected path is local disposable services only; existing development/production databases are not authorised substitutes.

### Narrow build safeguard and continuation change accounting

- Added `backend/.dockerignore`: deny-by-default context with explicit application/Alembic/runtime allowlist and final environment/key/cache/log exclusions. Intended context is `backend/`. Docker-native sentinel/build verification is blocked; this is **not a verified security fix**.
- Added `backend/tests/test_security_discovery.py`: six synthetic characterization tests, not secure-behaviour remediation tests.
- Added `docs/security/SECURITY_AUDIT.md`: incremental discovery report; not a complete security audit.
- Updated this inventory with source/test evidence and blockers.
- Existing application code, migration files, dependency manifests and lockfiles changed by audit in this continuation: none.
- Files deleted/reorganised, existing services migrated, production resources modified, commits/pushes: none.
- Broad remediation remains deferred. Report real isolated-service results and stop for review when that verification becomes possible.
