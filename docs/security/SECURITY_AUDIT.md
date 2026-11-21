# AiROS Super Admin security discovery

Date: 2026-11-03. Branch: `development-branch`.

## Scope and status

This is an incremental discovery report, **not a completed application-wide security audit**. No application code was remediated. Existing uncommitted user changes were preserved. No production database, Supabase service, cloud infrastructure or Employee application was accessed or modified. No files were deleted or documentation moved.

The narrow requested build-context safeguard, `backend/.dockerignore`, was added. Its Docker-native context/build verification remains blocked. It is not reported as a verified fix.

Evidence categories:

- **Confirmed local behaviour:** reproduced using synthetic data and in-process tests, with no database/storage service.
- **Confirmed source finding:** visible in implementation, not necessarily exploitable in deployment.
- **Identified risk:** needs environment, policy or concurrency evidence.
- **Scanner finding:** advisory/package match; not proof of exploitable production code.
- **Fixed:** requires implementation plus successful regression and relevant verification. No item currently has this status.

Severity below is provisional application risk, distinct from scanner advisory severity. This investigation covers ASVS authentication/session management, access control, data protection and configuration themes, and OWASP API broken authentication/authorisation and resource-consumption themes. It does not certify ASVS conformance.

## Findings register

| ID | Classification | Provisional severity | Finding | State |
|---|---|---|---|---|
| SEC-01 | Confirmed local anonymous read; confidentiality policy/deployed data unverified | High if evidence is private | Evidence-by-key GET requires no identity/tenant check and returns a one-year public cache policy | Open |
| SEC-02 | Confirmed source finding and mocked-service reproduction | Medium; high impact after refresh-token theft | Refresh tokens remain reusable; no rotation/reuse detection/family state | Open; cross-client design required |
| SEC-03 | Confirmed local primitive behaviour | Medium; deployment exploitability unverified | Limiter key trusts caller-provided first X-Forwarded-For element without checking peer | Open |
| SEC-04 | Confirmed source build-context hazard | High if secrets enter a built/published image | Backend COPY includes unrestricted context; local environment/media/log artifacts present | Exclusion file added; Docker verification pending; not fixed |
| SEC-05 | Confirmed source and synthetic signed-token behaviour | Low hardening gap | JWT decode does not require expiry claim presence | Open; no signature bypass demonstrated |
| SEC-06 | Identified operational/integrity risk | Medium | Embedded scheduler starts per process with no ownership lock; external worker not found | Open; duplicate effects not established |
| SEC-07 | Identified capacity risk | Medium | Workspace fan-out uses nine sessions and potentially a tenth auth connection | Open; no runtime measurements |
| SEC-08 | Scanner finding | Advisory severities up to critical | npm dependency tree contains reported advisories | Open; no upgrades applied |

### SEC-01: public evidence access

Implementation: `backend/app/api/v1/media.py::get_media_file`, `app/main.py` public `/uploads` mount, `core/storage.py` storage adapters, `models/task.py::TaskCompletionImage`, `models/maintenance.py::MaintenanceTicketAttachment`.

Confirmed test: `test_characterizes_anonymous_media_access_with_synthetic_storage` receives HTTP 200 and synthetic image bytes without Authorization. Its response includes `Cache-Control: public, max-age=31536000, immutable`. The test replaces storage with an in-memory stub and disables rate limiting only to isolate the access-control question. No real object was fetched.

The key format whitelist prevents traversal through this route; it does not prove ownership. Possession of a copied/logged/shared image URL permits anonymous retrieval. UUID entropy limits guessing but does not enforce revocation or tenant membership. A cache can retain previously public bytes even after access controls change.

Evidence tables explicitly link images to task submissions/history and issue/resolution tickets. These establish operational sensitivity and potential employee associations; actual image contents, EXIF metadata, attendance selfies and deployed bucket contents were not inspected. The minimal attendance model contains no image field. Do not infer that attendance images are present or absent in the shared bucket solely from these models.

A separate authenticated path already exists: `api/v1/logs.py::log_attachment` requires super-admin and resolves image provenance through `LogsService.attachment_key`, scoped to company, then uses private/no-store responses. Its synthetic negative test returns 401 anonymously. It does **not** protect the same bytes from the public key endpoint or public bucket origin.

Source also shows Supabase adapter bucket creation requests `public=true`. This is confirmed configured behaviour, not evidence of deployed ACLs. S3 bucket policy, object ACLs, CDN caches and provider IAM remain unverified. Native GCS private-bucket integration is not implemented in the inspected adapter.

Access-control requirements to obtain before remediation:

1. Product/data owner confirms whether task, maintenance and attendance evidence is private; default recommendation is private operational data, not bearer-by-URL public content.
2. Authorisation must resolve object -> parent task/ticket/submission -> property/company, and apply reviewer/assignee rules. A valid user alone must not grant bucket-wide access.
3. Unattached uploads need an ownership/provenance record and defined lifetime; task-only joins cannot authorise them yet.
4. Browser evidence can use authenticated blob requests (already used in logs) or short-lived signed URLs issued only after scope checks. Signed URLs are bearer credentials until expiration: redact query signatures, bound lifetimes, limit methods and define revocation semantics.
5. Private origin buckets and blocked public origin access are needed; protecting only the proxy leaves direct URLs exposed.
6. Decide cache policy per evidence class. Avoid long-lived public caching for sensitive evidence. Browser blob URLs must be revoked on unmount.
7. Coordinate Employee Backend and mobile URL consumers before changing shared image paths or bucket policy. No external policy change is authorised by this report.
8. Regression matrix: anonymous/foreign tenant/wrong property denied; authorised staff and permitted assignee allowed; expired link rejected; local/static and origin bypasses denied; retained historical evidence remains accessible to authorised reviewers.

No production data exposure is claimed; anonymous access in this implementation is confirmed, while policy violation and deployed reachability still require confirmation.

### SEC-02: refresh rotation and compatibility

Implementation: `services/auth.py::refresh/logout/_issue_tokens`, `repositories/refresh_token.py`, `models/refresh_token.py`, `schemas/auth.py::TokenRefreshResponse`, `frontend/src/api/client.ts::tryRefreshToken/refreshOnce`, `frontend/src/api/auth.ts`.

Positive controls: cryptographically random opaque tokens, SHA-256 hashes server-side, expiry/revoked filters, active-user lookup on refresh and audit event recording. Login uses bounded password verification and releases its initial read transaction before verification.

Confirmed gaps:

- `refresh()` neither consumes nor replaces the presented refresh row. Repeated calls return access tokens.
- Refresh-token model has no family, parent/replacement, used-at or client capability fields.
- Refresh query does not lock or atomically consume a token.
- Revoked tokens are filtered out before retrieval; replay of a consumed token cannot be attributed to a family using this lookup alone.
- Logout only revokes the supplied refresh row. Access JWTs are not individually revoked; independently issued login sessions remain active.
- Browser stores both tokens in localStorage. An XSS/compromised same-origin script would expose them. No XSS was demonstrated in this review.

Tests reproduce sequential reuse and four overlapping refresh service invocations reading the same synthetic token/account via mocked repositories. These prove service behaviour, **not PostgreSQL isolation, locking or concurrent HTTP correctness**. The test suite intentionally characterizes current insecure/hardening behaviour; passing is not evidence of mitigation. Convert these expectations into rejection/rotation regressions when implementing the agreed design.

Compatibility conclusion: **server-only mandatory rotation is not safe to enable now**. `TokenRefreshResponse` contains no replacement refresh token, and the browser persists only the new access token. `refreshInFlight` coalesces within one tab/runtime; simultaneous tabs can still present the same token. Immediately invalidating the old token would cause existing clients to lose sessions, or a replay policy could falsely revoke the family during benign races.

Mobile compatibility cannot be certified: its source/runtime and shared-key/schema contracts were not inspected. Do not change employee code, shared token semantics, JWT issuer/audience or shared schema unilaterally.

Recommended staged design (not implemented):

1. Inventory token issuance/consumption across both backends; establish whether hashes/sessions are shared in practice, and who owns schema changes.
2. Define explicit client capability/version negotiation or a versioned refresh contract. An optional response field alone does not prove older clients persist it. Ship client persistence first, with downgrade/session-expiry strategy.
3. Add coordinated additive family/consumption metadata. Existing hashes can remain valid legacy sessions until bounded expiry or explicit reauthentication. Do not revoke every old session merely to simplify rollout; also do not let attackers silently opt new rotating sessions into legacy mode.
4. Consume + issue child in one transaction with row lock or conditional update, and unique replacement constraints. Commit before returning success. Preserve audit records without storing raw tokens.
5. On confirmed reuse outside the agreed retry policy, atomically revoke the family rather than all unrelated devices by default. Define access-token invalidation latency separately; refresh revocation alone is not immediate JWT revocation.
6. Specify retry/concurrency behaviour. Options include cross-tab coordination, idempotency keys and a tightly bounded retry policy. A generic grace window accepting a consumed token weakens replay detection; returning the same replacement under retry requires a safe response-recovery design, not storing plaintext tokens casually.
7. Test same-token double refresh, refresh vs logout, transaction rollback, lost response/retry, cross-tab races, stale mobile versions, concurrent independent logins, family revocation and unrelated-device survival on isolated PostgreSQL.

No refresh rotation has been implemented or claimed tested as a working feature.

### SEC-03: limiter identity/proxy trust

Implementation: `core/rate_limit.py::_client_ip/check_rate_limit`; synthetic Starlette request test supplies an arbitrary documentation-range IP in X-Forwarded-For and observes that value become the limiter identity despite a loopback peer.

An attacker able to control the forwarded header on the deployed path could change keys to evade per-IP login/upload limits. This is a confirmed primitive weakness, not a confirmed deployed bypass: reverse-proxy overwrite/append rules, ingress restrictions and uvicorn trusted-proxy handling must be verified. Do not replace it with `request.client.host` blindly before establishing the proxy contract, or all users could share the proxy's limit.

Related source risks to test: Redis INCR and PEXPIRE are separate commands; interruption can leave a counter without expiry. Redis-operation failures allow requests, while unconfigured Redis uses local limits. Local fallback keys have no global eviction. These are identified risks, not measured outages or memory-exhaustion demonstrations.

### SEC-04: Docker context

Inspected backend Dockerfile: broad `COPY . .`, no USER instruction (default image identity), minimum-only Python dependency versions, migration command failure masked before uvicorn startup. Existing backend directory includes local `.env`, uploads, a log and caches. A `.gitignore` is not a Docker build exclusion.

Added `backend/.dockerignore` uses default-deny `**` and explicitly allows the Dockerfile, ignore file, runtime requirements, Alembic config, `app/` and `alembic/`, with final exclusions for environment files, key formats, Git metadata, Python caches and logs. Scripts, tests, uploads, local databases and unrelated build artifacts are omitted by default. No secret contents were read or printed.

This file applies to builds with **backend as context**. It does not validate arbitrary root-context invocation, provider source uploads, remote buildpacks or existing image layers. Those routes need independent review. The app's COPY/requirements layout already assumes backend context.

Pending Docker-native verification: inspect a synthetic sentinel build context using the same ignore rules, assert required application/migration assets remain, assert nested environments/keys/caches and user data are absent, then inspect the built filesystem/layers without exposing secret values. Do not use the real environment file as a sentinel or print its contents. Scanner/build acceptance is not yet established, so SEC-04 remains open.

### SEC-05: mandatory JWT claims

Synthetic test signs a token with a dedicated test key, `sub` and `type=access` but no `exp`; `decode_access_token` accepts it. The normal issuer includes `exp` and decode verifies signatures with the configured algorithm. This is **not algorithm confusion, token forgery or an unsigned-token bypass**. Exploitation needs a validly signed nonstandard token or an upstream issuer mistake/key compromise. Coordinate claim requirements with all shared issuers before tightening them. Regression coverage should later reject missing/invalid exp/iat/sub, wrong token type, wrong signature and expired tokens without breaking supported clients.

### SEC-06: scheduler ownership

`main.py` starts a new embedded loop whenever each process lifespan sees `RUN_EMBEDDED_SCHEDULER=true`. The inspected loop has no cross-process lease/advisory lock. Calling generation APIs can overlap scheduled work. No executable arq WorkerSettings/generation_tick was found in backend Python source. The message that arq owns generation is insufficient evidence.

Template generation has ledger uniqueness and savepoints; task series have unique occurrence protection. These protect some committed effects, not ownership or duplicate CPU/DB scans. `TemplateService.run_due` initially selects due templates without ownership locking. Duplicate loops and partial failure need PostgreSQL tests, including cursor advancement, counts, allocation pointers and post-commit event delivery. `TaskService.run_due_repetitive` broadly rolls back exceptions without emitting failure detail in that path; observability should distinguish failure from no work.

Do not disable the only known scheduler before proving a replacement. Proposed prevention options (not implemented): a dedicated singleton owner plus DB-held advisory lock covering the whole tick, or a carefully designed leader lease. Session-level advisory locks require the same dedicated connection and are not safe to assume through transaction pooling; transaction-scoped locks do not cover a loop whose services commit independently. Retain idempotency constraints even with ownership. Scheduler CPU allocation/scale-to-zero behaviour must be part of Cloud Run design.

### SEC-07: workspace sessions

Confirmed code: aggregate bootstrap uses nine independent AsyncSessionLocal contexts in asyncio.gather. Each repository read generally acquires a connection until its session exits. A cache-miss identity dependency may hold an additional read transaction until the request exits; this must be measured, not assumed released before fan-out. Default per-process pool ceiling is ten connections.

Nine sessions are required by the **current concurrent implementation**, not by business semantics. One AsyncSession must not be shared concurrently across gather tasks. No conclusion that sequential/limited concurrency is faster has been established.

Candidate experiment, not an implemented optimisation:

- Baseline current endpoint with synthetic fixtures and auth cache cold/warm.
- Compare a sequential single-session orchestration and bounded parallelism (e.g. three workers) in an isolated experiment, preserving serializers/scoping and documenting snapshot differences.
- Use the same dataset, pool, PostgreSQL settings and request concurrency; include empty, medium and large property/company fixtures and skewed evidence/history data.
- Record request p50/p95/p99, query counts/time, pool checkout peak/wait/timeouts, pg_stat_activity peaks, CPU and payload bytes. Repeat warmed trials and separate connection-creation costs.
- Test response equivalence and tenant/property isolation; READ COMMITTED single-session reads do not automatically provide a repeatable-read snapshot.
- Keep defaults unchanged until evidence shows a workload-specific improvement without tail-latency or isolation regression.

No database connection or latency measurements are available because Docker Engine is unavailable. Mock timings are not substituted for PostgreSQL measurements.

## Static tooling results

### npm audit

Executed `npm audit --audit-level=high` from `frontend/`: exit 1, **6 affected packages: 1 moderate, 3 high, 2 critical**. These are dependency advisory matches, not six proven application exploits.

| Package | Scanner severity | Reported issue class | Dependency exposure |
|---|---|---|---|
| @vitest/mocker | Moderate | Traversal/arbitrary read, unauthenticated mock registration injection | Vitest test tooling |
| vitest | Critical aggregate | Inherits vulnerable mocker/tinypool | Dev dependency; aggregate entry, not an additional independent RCE |
| tinypool 1.1.1 | Critical | Prototype-pollution gadget to RCE | `npm explain`: dev path via Vitest 3.2.7 |
| source-map-js 1.2.1 | High | Event-loop DoS via indexed source maps | Shared tree through postcss/Vite/Tailwind and dev jsdom |
| undici 7.30.0 | High | Multiple networking/DoS/cache/TLS advisories | `npm explain`: dev path via jsdom 29.1.1 |
| vite 8.3.0 | High | Dev-server/editor/file-serving issues | Declared dependency, used as build/dev tooling; production static Hosting is a different exposure |

Traceable advisory IDs in scan: GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8 (mocker); GHSA-68fv-2mgg-jv7q (source-map-js); GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr (tinypool); GHSA-4qv8-2p9j-2685, GHSA-f72v-6w45-q472, GHSA-xjj6-f33q-929c, GHSA-4w7w-5xrc-9h26, GHSA-2m5v-pch6-74hx, GHSA-qrxm-fqhp-jwvm, GHSA-9fm3-97px-rjf6, GHSA-55wc-3pg8-jfw6 (undici); GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw, GHSA-587h-7wmj-h5pm, GHSA-9jrq-w75r-8gcw, GHSA-rq7h-c2jc-7f22, GHSA-vfpm-58rq-9qcg (Vite).

No audit fix command was run. Suggested Vitest remediation involves a major version; compatibility and release age must be checked before upgrades. Current scanner output alone does not establish a safe target version or production browser exploitability.

### Other static checks

- `py -3.12 -m pip check`: passed; only dependency requirement consistency, **not vulnerability scanning**.
- Installed tools checked: Bandit, Semgrep, pip-audit, Ruff and MyPy are not installed in Python 3.12 environment. No clean scanner result is claimed; no packages were installed globally.
- Source searches found no listed direct unsafe HTML/eval sinks in frontend/src. This is a narrow search, not an XSS proof.
- Source raw-SQL search found f-strings for a constant lock timeout and a sequence name selected between two literals. These findings do not establish SQL injection; client input is not interpolated in the inspected expressions.
- `py -3.12 -m alembic heads`: exit 0, single head `v9f2b5c8d1e4`. This reads the local graph; it is **not migration application, schema validation or an existing DB connection**.

## Test evidence and limitations

Added `backend/tests/test_security_discovery.py`: six tests using synthetic IDs, test-only signing key, in-memory ASGI transport and mocked service/storage repositories. No application lifespan is started and no real object store is accessed.

Executed:

`py -3.12 -m pytest tests/test_security_discovery.py tests/test_media_validation.py tests/test_auth_login.py tests/test_verify_queue.py -q`

Final result: **37 passed in 3.11 seconds**, exit 0. The first run had 36 passes/1 failure because the new mini-app fixture omitted the project's exception handler; registering that handler corrected the fixture. No application change was required. Sequential and concurrent refresh tests characterize existing acceptance, not secure rotation. They must not be labelled passed security mitigation tests.

Test subprocess used an inert `127.0.0.1:1` database URL, synthetic JWT key, disabled embedded scheduler, empty Redis URL and disabled Employee/realtime endpoint settings. No production target was used. Existing frontend build and 65-test baseline were run in the previous checkpoint, not rerun for this documentation/test/build-ignore-only continuation.

## Isolated verification status and stop gate

Docker Client 29.9.1 is installed with context `desktop-linux`. Repeated `docker version`/`docker info` checks fail because `dockerDesktopLinuxEngine` named pipe is absent. The requested image-list check also failed; no PostgreSQL or Redis image availability is verified. No containers, networks or volumes were created.

| Requested output | Result |
|---|---|
| Services successfully started | None; Engine unavailable |
| PostgreSQL/SQLAlchemy integration tests | Not executed |
| Database migration application | Not executed; graph head only checked |
| Transaction/rollback/savepoint verification on PostgreSQL | Not executed |
| Connection-pool measurements | Not collected |
| Redis PING/TTL/concurrency verification | Not executed |
| Refresh rotation / DB concurrent auth | Rotation absent; synthetic mocked acceptance tests only |
| Workspace before/after metrics | Not collected; no proposed code change applied |
| Scheduler duplicate execution prevention | Not implemented; ownership design and integration tests pending |
| Docker context/image verification | Ignore file added; native verification pending |

Once Engine is ready, verify image versions/digests and use only newly named, loopback-bound disposable containers, no host source mounts/production credentials, synthetic data and explicit environment overrides. Bind nondefault free host ports; inspect container identity/port mapping before any migration. Do not start the application with ambient `.env`, because optional storage/service settings may still be loaded unless explicitly neutralised. Apply upgrade only to the fresh audit database; do not stamp or downgrade existing databases. Pin and record image digests used. Inspect migration prerequisites such as btree_gist and PostgreSQL feature support before interpreting failures. Test rerunning upgrade-to-head idempotency and read schema constraints; do not substitute metadata.create_all for migration verification.

Report isolated results, then stop for review before broad remediation. At this checkpoint, Docker availability is the blocker, not permission to use the existing shared database. Production changes, dependency upgrades, documentation restructuring and broader application remediation remain deferred.
