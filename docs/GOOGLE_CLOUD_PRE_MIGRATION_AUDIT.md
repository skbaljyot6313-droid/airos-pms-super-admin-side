# Google Cloud + GitHub Pre-Migration Audit — Phase 0

**Audit date:** 2026-11-02 · **Auditor identity:** `baljyotskhokhar@gmail.com` (GCP) / `skbaljyot6313-droid` (GitHub, via `gh`)
**Scope:** Read-only discovery for an isolated `development-branch` → Cloud Run (`asia-south1`) deployment.
**Prior report:** `GOOGLE_CLOUD_ENVIRONMENT_AUDIT.md` (same day — resource inventory); this report adds IAM/WIF depth, revision history, image provenance and isolation analysis.

**Labels:** `VERIFIED` · `INFERRED` · `UNKNOWN` · `RISK` · `RECOMMENDATION`

---

## Executive Summary

1. `development-branch` exists locally and on origin (created today from `main`, both at `c1e21e3`), but **nothing currently deploys it anywhere** — and nothing deploys this repo to GCP at all.
2. **`RISK`: The GCP production deploy pipeline does not come from this repository.** The WIF provider's `attributeCondition` only allows `baljyotskhokhar-byte/Final_super_admin_aide` and `skbaljyot6313-droid/Airos-PMS-employee-side`. The live `super-admin-api` image is tagged with git SHA `ee2e24b…` — a commit absent from this repo. Production is fed by a foreign repo checkout (almost certainly a copy of this codebase under another account).
3. Three Cloud Run services already run in `airos-530a5`: **`airos-sa-api` (prod), `airos-sa-api-staging` (de-facto dev/staging), `airos-eb-api` (Employee Backend prod)** — all public (`allUsers` invoker), all in `asia-south1`.
4. `airos-sa-api-staging` is the obvious substrate for the dev environment (own DB secret, env overrides), but it was deployed manually from local source — not CI.
5. No branch protection on `main` or `development-branch`. `deploy-production.yml` fires on `main` pushes → Railway+Vercel — it cannot touch GCP, but `main` pushes DO auto-deploy to the *legacy* providers.
6. `RISK`: long-lived service-account JSON keys exist for every SA (one never-expiring Firebase key) alongside WIF.

---

## PART 1 — GitHub Repository Audit

| Check | Result | Evidence |
|---|---|---|
| Remote | `origin → https://github.com/skbaljyot6313-droid/airos-pms-super-admin-side.git` | `git remote -v` |
| Current branch | `development-branch` | `git branch --show-current` |
| Local branches | `development-branch`*, `main` | `git branch` |
| Remote branches | `origin/main`, `origin/development-branch` | `git branch -a` |
| Latest commits | all four refs = `c1e21e3` (2026-10-15) | `git log -1`, `git rev-parse` |
| `development-branch` exists | local ✓ remote ✓ (pushed today, tracking `origin/development-branch`) | `git config branch.development-branch.*` |
| Branched from `main`? | `VERIFIED` — created via `git checkout -b` off `main` in this session; merge-base = `c1e21e3` | `git rev-list --left-right --count main...development-branch` → `0 0` |
| Divergence | none (0 ahead / 0 behind) | same |
| Uncommitted changes | **72 files** — all work is uncommitted WIP | `git status --short` |
| Branch protection (`main`, `development-branch`) | **NONE — GitHub API 404 "Branch not protected" on both** | `gh api repos/…/branches/{main,development-branch}/protection` |
| gh auth | `skbaljyot6313-droid` active (repo+workflow scopes); second account `baljyotskhokhar-byte` also logged in (inactive) | `gh auth status` |

### Workflows (`VERIFIED` — only two files)

| File | Triggers | Branch filter | Targets | Auto-deploys? |
|---|---|---|---|---|
| `.github/workflows/deploy-production.yml` | `push` + `workflow_dispatch` | **`main` only** | Railway (`serviceInstanceDeploy`) + Vercel (`--prod`) | **Yes — pushes to `main` auto-deploy to Railway/Vercel** |
| `.github/workflows/deploy-centrifugo.yml` | `workflow_dispatch` | none | Railway Centrifugo service | Manual only |

**Boundary assessment:**
- `development-branch` pushes → **trigger nothing** (no workflow matches). ✓ safe.
- `main` pushes → auto-deploy to Railway/Vercel only; **cannot reach GCP** from this repo. ✓ for GCP isolation, but legacy prod is still trigger-happy — `RISK` (no branch protection, no approval gates).
- **No workflow deploys on all branches or every push.**

---

## PART 2 — Google Cloud CLI Audit

| Item | Value | Command |
|---|---|---|
| SDK | 590.0.1 (latest 591.0.0 — update available) | `gcloud version` |
| Install path | `C:\Users\skbal\AppData\Local\Google\Cloud SDK\google-cloud-sdk` | `gcloud info` |
| Accounts | `baljyotskhokhar@gmail.com` only | `gcloud auth list` |
| Configurations | single `default` (active): account above, project `airos-530a5`, `run/region=asia-south1`, no compute zone/region | `gcloud config configurations list` |
| Components | incl. `beta`, `cloud-sql-proxy`, `cloud-run-proxy`, `kubectl`, `docker-credential-gcr` | `gcloud components list` |

One account, one configuration — no ambiguity locally. `VERIFIED`.

---

## PART 3 — Google Cloud Project Audit

| Project | # | Contents | Verdict |
|---|---|---|---|
| **`airos-530a5`** ("Airos", active project) | 732720607924 | All Cloud Run/AR/secrets/SA/Firebase infra | **Intended project — VERIFIED by content** |
| `airos-pms` ("Airos-pms") | 70245811554 | 31 APIs, 0 services, secrets `airco-pms-dev-{database-url,jwt-secret}` (10-23) | Earlier attempt — `INFERRED` abandoned |
| `gen-lang-client-0631096917` | 528142803424 | auto Gemini project | ignore |
| `project-6cae0b3f-fd66-4d86-a89` | 1061759840419 | "My First Project" default | ignore |

**Billing (VERIFIED):** `billingAccounts/013FAB-CB815B-2E200E`, `billingEnabled: true` — `gcloud beta billing projects describe airos-530a5`.

**Enabled APIs on airos-530a5 (VERIFIED, 55):** run, artifactregistry, containerregistry, cloudbuild, secretmanager, iam(+credentials), logging, monitoring, cloudtrace, pubsub, storage(+api/component), sql-component, datastore, runtimeconfig, firebase* (10 APIs incl. identitytoolkit/fcm/hosting), bigquery* (9), dataplex, dataform, appengine, apphub, recommender, cloudasset, telemetry, testing, cloudaicompanion, geminicloudassist, agentregistry, apptopology, appoptimize, analyticshub, designcenter, securetoken, servicemanagement, serviceusage.

**Disabled → cannot exist:** `cloudscheduler`, `compute`, `vpcaccess`, `sqladmin`, `redis`, `dns` (`VERIFIED` — API errors on list calls).

---

## PART 4 — Cloud Run Audit

### Services (all `asia-south1`, all `ingress: all` + `allUsers` → `roles/run.invoker` = **publicly accessible**, `VERIFIED` via `get-iam-policy`)

| | `airos-sa-api` | `airos-sa-api-staging` | `airos-eb-api` |
|---|---|---|---|
| Image | `airos/super-admin-api@sha256:bfc9c93` (tag `ee2e24b…` — git SHA **not in this repo**) | `airos/super-admin-api-staging:latest` (buildpacks source deploy, `build-id 74d2910d`, source zip in `run-sources` bucket) | `airos/employee-api:latest` |
| CPU / Mem | 1 / 512 Mi | (buildpacks default) | 1 / 512 Mi |
| Concurrency | 80 | 20 | 80 |
| Min / Max | 0* / 2 (svc annotation says 20 — revision wins) | **1** / 8 | 0* / **1** |
| Timeout | 300 s | default | 300 s (container 240 s) |
| Port / probes | 8000, startupProbe Default | 8000 (implied) | 8000, startupProbe |
| Revisions | 5 — all created 10-26, 100% traffic → `00006-nop` | 7 (4 inactive/failed builds 10-28), 100% → `00007-chq` | 1 (`00001-9bc`, 10-26) |
| Runtime SA | `airos-sa-api@` | default compute (`INFERRED`) | `airos-eb-api@` |
| Last modifier | **`github-deploy@` (CI) — creator `baljyotskhokhar@`** | `baljyotskhokhar@` manual | `baljyotskhokhar@` manual |
| VPC | none (vpcaccess API disabled) | none | none |
| Env names | APP_ENV, DEBUG, CORS_ORIGINS, RUN_EMBEDDED_SCHEDULER, DB_POOLER_MODE, DB_POOL_SIZE, DB_MAX_OVERFLOW, **DB_POOL_PRE_PING** ⚠, SUPABASE_*, S3_*, STORAGE_BACKEND, EMPLOYEE_API_BASE_URL | same + VERIFY_MAX_WORKERS, VERIFY_QUEUE_MAX, VERIFY_QUEUE_TIMEOUT_S, LOGIN_RATE_LIMIT | core set + PUSH_PROVIDER, RUN_EMBEDDED_SCHEDULER |
| Secrets (names) | airos-sa-database-url, airos-sa-jwt-secret, airos-s3-access/secret-key, airos-location-service-key, airos-supabase-secret-key | airos-sa-staging-database-url + same shared 5 | airos-eb-database-url, airos-eb-jwt-secret, airos-s3-access/secret-key, airos-location-service-key |

\* minScale annotation absent → 0 (`INFERRED` default).

**Cloud Run Jobs:** **0** (`gcloud run jobs list` — all regions empty).

**Findings:** `airos-sa-api` is de-facto production; `airos-sa-api-staging` is de-facto dev/staging but **manually source-deployed** and always-on (min 1 → continuous billing). No jobs → the 60 s generation tick runs inside whichever services have `RUN_EMBEDDED_SCHEDULER=true` (`UNKNOWN` value per service).

---

## PART 5 — Artifact Registry Audit

`asia-south1` region, both DOCKER, Google-managed encryption, STANDARD_REPOSITORY:

| Repo | Images (digest → tags) | Referenced by | Verdict |
|---|---|---|---|
| `airos` (~336 MB, created 10-26) | `employee-api` `a8a69dd` → `latest` | `airos-eb-api` live | KEEP |
| | `super-admin-api` `bfc9c93` → **`ee2e24b1943fd310180f8a1f7e3601da2464112f`** (git-SHA tag; commit **absent from this repo** — `VERIFIED` `git cat-file` fails) | `airos-sa-api` live revision | KEEP — but provenance is foreign-repo (see §Exec #2) |
| | `super-admin-api` `d844ab3` → `latest` | **unreferenced** (older supplanted image) | INVESTIGATE — rollback asset; `latest` tag is misleading (points at the OLD digest) |
| | `super-admin-api-staging` `7268794` → `latest`; `1bf2ff3` → **untagged** | `7268794` = staging live | `1bf2ff3` CLEANUP CANDIDATE |
| `cloud-run-source-deploy` (~340 MB) | staging source-deploy artifacts | staging build path | REUSE if source deploys continue |

---

## PART 6 — Secret Manager Audit

All 9 secrets: **automatic replication, version 1 = enabled, no labels**, created 10-26 (staging DB 10-28). `VERIFIED` via `secrets describe` + `versions list`. **No payloads accessed.**

| Secret | Used by | Overlap |
|---|---|---|
| `airos-sa-database-url` | airos-sa-api | prod-only |
| `airos-sa-staging-database-url` | airos-sa-api-staging | **separate staging DB — target/value UNKNOWN** (may still point at shared Supabase) |
| `airos-sa-jwt-secret` | sa-api + staging | **shared prod+staging** — RISK: staging can mint prod-valid JWTs |
| `airos-eb-database-url` | airos-eb-api | EB prod |
| `airos-eb-jwt-secret` | airos-eb-api | EB prod |
| `airos-s3-access-key`, `airos-s3-secret-key` | **all three services** | shared dev+prod — `RISK` dev writes land in same bucket creds |
| `airos-location-service-key` | sa-api, staging, eb-api | shared all envs |
| `airos-supabase-secret-key` | sa-api, staging | shared prod+staging |

**Dev/prod secret separation exists only for the DB URL and is partial** — JWT, S3, Supabase, and location keys are shared across environments. `RISK`.

---

## PART 7 — IAM & Service Account Audit

### Service accounts

| SA | Purpose | Keys (metadata only) | Risk |
|---|---|---|---|
| `airos-sa-api@` | sa-api runtime | 1 key, expires 2028-10-25 | User-managed key unnecessary (runtime identity) — `RISK` |
| `airos-eb-api@` | eb runtime | 1 key, expires 2028-10-25 | same |
| `github-deploy@` | CI deployer | **1 key, expires 2028-10-25** — coexists with WIF | `RISK` key defeats WIF's no-key benefit |
| `firebase-adminsdk-fbsvc@` | EB Firebase Admin | **2 keys — one expires `9999-12-31` (never)** | `RISK` highest: immortal credential |
| `732720607924-compute@developer` | default compute | — | **`roles/editor` project-wide — excessive** `RISK` |

### Workload Identity Federation (VERIFIED)

- Pool `github-pool` (global, ACTIVE) → provider `github` (issuer `token.actions.githubusercontent.com`).
- **`attributeCondition: assertion.repository in ['baljyotskhokhar-byte/Final_super_admin_aide','skbaljyot6313-droid/Airos-PMS-employee-side']`** — this repo `airos-pms-super-admin-side` is **NOT allowed** → no workflow here can mint GCP tokens today. `RISK`/`VERIFIED`.

### Project IAM bindings (filtered, `gcloud projects get-iam-policy`)

- `user:baljyotskhokhar@gmail.com` → `roles/owner`
- `github-deploy@` → `artifactregistry.writer`, `cloudbuild.builds.editor`, `iam.serviceAccountUser`, `run.developer`, `serviceusage.serviceUsageConsumer` — plausible deploy role; `run.developer` at **project scope** means it can deploy/alter ANY service incl. EB (`RISK` — scope to service-level for least privilege).
- Default compute SA → `roles/editor` (`RISK` above).
- No project-level `secretAccessor` visible → secret access is per-secret IAM (`INFERRED`) or via default compute agent roles.
- Service-level: all 3 Cloud Run services bind `allUsers → run.invoker` (public).

---

## PART 8 — Networking & Connectivity Audit

| Item | Status |
|---|---|
| VPC networks/subnets/firewall/NAT/connectors/PSA | **None manageable** — `compute` + `vpcaccess` APIs disabled (`VERIFIED` via API errors) |
| Direct VPC egress on services | none configured |
| Cloud NAT / static outbound IP | none → outbound IPs are ephemeral Google IPs (relevant for any IP allowlisting at Supabase/EB) |
| Cloud SQL connectivity | n/a — `sqladmin` disabled |
| Memorystore | n/a — `redis` disabled |
| Load balancers / URL maps / certs | none |
| Custom domain mappings | **0** — all `*.run.app` URLs |
| DNS | `dns` API disabled |
| **Effective topology** | **Everything rides public internet + TLS** — Cloud Run → Supabase pooler/EB over public egress (`VERIFIED`) |

---

## PART 9 — Database & External Infrastructure Audit

| Dependency | Provider | Region | Connection | Used by | Dev/prod separated? | Referenced by Cloud Run? | Allowlisting? |
|---|---|---|---|---|---|---|---|
| Postgres `postgres` | **Supabase** `wlxqdsnjiayxeqpejeih` | ap-south-1 | pooler :6543 txn / :5432 session via `DATABASE_URL` | sa-api (prod), eb-api (prod), **staging via separate secret** | Partially — staging has own secret; actual DB target `UNKNOWN` | yes — secrets | No IP allowlist today (public); Cloud Run ephemeral egress IPs would break any future allowlist unless VPC+NAT added |
| Object storage | Supabase Storage (S3 API) | ap-south-1 | boto3 via `S3_*`/`SUPABASE_SECRET_KEY` | all services | **No — same creds everywhere** | yes | — |
| MongoDB | **none** | — | — | — | — | — | — (`VERIFIED` absent) |
| Redis | Railway (env-only) | ? | `REDIS_URL` | sa-api rate-limit/arq-dead | — | env not visible in deployed specs → likely unset | — |
| Firebase | GCP `airos-530a5` | global | Admin SDK + hosting site | EB (`PUSH_PROVIDER`), empty hosting site | n/a | EB env | — |
| Employee API | `airos-eb-api` (in-project) | asia-south1 | `EMPLOYEE_API_BASE_URL` + `X-Location-Service-Key` | sa-api, staging | no dev EB exists — **dev SA would still hit prod EB** `RISK` | yes | — |
| Centrifugo | Railway | ? | HTTP API + WS | sa-api | — | env unset on all services → realtime off (`INFERRED`) | — |
| OSM tiles, Fontshare | public CDNs | — | browser | SPA | — | — | — |

---

## PART 10 — CI/CD Audit

Repo workflows re-verified (`VERIFIED`):

| Workflow | Trigger | GCP? | Prod blast radius |
|---|---|---|---|
| `deploy-production.yml` | push `main` / dispatch | **No GCP** — Railway GraphQL `serviceInstanceDeploy` + `npx vercel deploy --prod` | Railway+Vercel prod on every `main` push; no tests/approvals |
| `deploy-centrifugo.yml` | manual | No GCP — Railway Centrifugo provisioning via CLI+GraphQL | manual only |

**GCP-side CI (`VERIFIED` from GCP metadata, not repo):**
- `github-deploy@` deployed `airos-sa-api` 10-26 via image `…/super-admin-api:ee2e24b…` — the tag is a git SHA belonging to a **different repository**. The WIF allowlist confirms: `baljyotskhokhar-byte/Final_super_admin_aide` is the prod deployer.
- **This repo cannot deploy to GCP** until its repo name is added to the WIF `attributeCondition` (or a different credential path is used).

**Cross-branch blast radius assessment:**
- `development-branch` → production: **impossible today** (no triggers, WIF denies this repo). ✓
- `main` → development env: impossible; `main` → legacy prod: automatic.
- `RISK`: the *other* repo (`Final_super_admin_aide`) can redeploy `airos-sa-api` at any time — any dev environment using shared secrets/DB can be affected by it.

---

## PART 11 — Dev/Prod Isolation Assessment

| Resource | Development (today) | Production (today) | Isolation? |
|---|---|---|---|
| Git branch | `development-branch` | `main` (+ foreign repo) | ✓ nominal |
| Cloud Run service | `airos-sa-api-staging` | `airos-sa-api` | ✓ separate services |
| Region | asia-south1 | asia-south1 | shared (fine) |
| Artifact Registry | shared `airos` repo | shared | partial — images isolated by name |
| Env vars | own set (+VERIFY_*/LOGIN overrides) | own set | ✓ |
| Secret Manager | own `*-staging-database-url`; **shared JWT/S3/Supabase/location keys** | prod secrets | **✗ partial — shared credentials** `RISK` |
| PostgreSQL | `airos-sa-staging-database-url` target `UNKNOWN` | Supabase shared w/ EB | **✗ UNKNOWN — likely same Supabase project; if same DB, dev ticks/rollovers touch prod data** `RISK` |
| MongoDB | — | — | n/a |
| Redis | none | none | n/a |
| Object storage | same Supabase creds | same | **✗ shared bucket creds** `RISK` |
| Service accounts | default compute (`INFERRED`) | `airos-sa-api@` | ✗ staging runs as editor-powerful default SA `RISK` |
| Deploy workflows | none for this repo | foreign-repo CI + legacy Railway/Vercel | **✗ prod owned by another repo's pipeline** `RISK` |
| Domains | `*.run.app` | `*.run.app` + Railway/Vercel | shared pattern |
| Employee API | **points at prod EB** | prod EB | **✗ dev calls prod EB** `RISK` |

**Verdict: NO genuine dev/prod isolation exists today.** The staging service is a separate compute surface but shares JWT material, storage credentials, the location key, probably the database, and definitely the prod Employee Backend.

---

## PART 12 — Cleanup Candidate Register

| Resource | Type | Usage | Referenced by | Classification |
|---|---|---|---|---|
| `airos-sa-api` + 6 secrets + runtime SA | Cloud Run | live prod | all clients | **PROTECTED** |
| `airos-eb-api` + secrets + SA | Cloud Run | live prod (other repo) | mobile app, sa-api | **PROTECTED** |
| `airos-sa-api-staging` | Cloud Run | manual dev/staging | its own secret | KEEP — natural dev target |
| `super-admin-api@d844ab3` (tag `latest`) | AR image | superseded | nothing | INVESTIGATE — `latest` tag misleading vs live `ee2e24b`-tagged digest |
| `super-admin-api-staging@1bf2ff3` | AR image | superseded, untagged | nothing | CLEANUP CANDIDATE |
| `airos-sa-api-staging` failed revisions ×4 | revisions | dead | nothing | auto-retained; no action needed |
| `airos-pms` project | GCP project | nothing | 2 orphan `airco-pms-dev-*` secrets | CLEANUP CANDIDATE — needs owner sign-off |
| `DB_POOL_PRE_PING` env on sa-api/staging | env var | ignored by app (`extra=ignore`) | — | CLEANUP CANDIDATE (config drift) |
| `firebase-adminsdk` never-expiring key | SA key | EB firebase ops? | possibly EB | INVESTIGATE — rotate/verify before removal |
| `github-deploy` SA JSON key | SA key | redundant with WIF | maybe legacy CI | INVESTIGATE |
| default-compute `roles/editor` | IAM binding | staging runtime? | staging service | `RISK` — recommend tightening, not deleting |
| `gen-lang-client-*`, `project-6cae0b3f-*` | GCP projects | nothing | — | leave alone |
| Railway/Vercel/Centrifugo/Redis | external | legacy prod | real traffic `INFERRED` | **PROTECTED until cutover verified** |

**Nothing was deleted.**

---

## PART 13 — Proposed Development Environment (proposal only)

### Option A (recommended): formalize `airos-sa-api-staging` → the dev environment

| Resource | Proposed name / config | Notes |
|---|---|---|
| Cloud Run | **reuse `airos-sa-api-staging`** (rename not possible — keep name or recreate as `airos-sa-api-dev`) | 1 vCPU/512Mi, concurrency 20, min 0 (cost) or 1, max 4, timeout 300 |
| Secrets | **new** `airos-sa-dev-database-url`, `airos-sa-dev-jwt-secret`, `airos-sa-dev-s3-{access,secret}-key` (or keep Supabase key but a **separate bucket/prefix**) | stops JWT/token overlap with prod |
| Runtime SA | `airos-sa-api@` (reuse — already least-priv) or new `airos-sa-dev@` | stop using default compute editor SA |
| Database | dedicated Supabase DB/schema or separate project instance — **must not be the shared prod DB**; alembic chain must tolerate EB stamps if shared DB is reused | verify what `airos-sa-staging-database-url` already points to first |
| Scheduler | `RUN_EMBEDDED_SCHEDULER=true` is acceptable on dev (single owner) until Cloud Scheduler API is enabled | dev tick must not write prod rows — depends on DB answer above |
| Employee Backend | keep pointing at prod EB (read-only calls) or stand up `airos-eb-api-dev` only if write paths get tested | dev SA→prod EB calls are read-mostly (`INFERRED`) |
| Frontend dev | Firebase Hosting **preview channel** on `airos-530a5.web.app` (or second site `airos-530a5-dev.web.app`) | `VITE_API_URL` → staging/dev URL |
| CI/CD | new workflow `deploy-dev.yml`: `on: push: branches: [development-branch]` → `google-github-actions/auth` (WIF) → `gcloud builds submit`/`docker build` → push `airos/super-admin-api:dev-<sha>` → `gcloud run deploy airos-sa-api-staging --image` | **requires adding `skbaljyot6313-droid/airos-pms-super-admin-side` to WIF `attributeCondition`** — blocker |
| Deploy identity | reuse `github-deploy@` (roles already sufficient); consider scoping `run.developer` to the dev service only | — |
| Logging/monitoring | enabled; add log-based alert on `AUTH_QUEUE_*`/scheduler errors; uptime check on `/ready` | — |
| Rollback | `gcloud run services update-traffic` to previous revision; AR retains images | built-in |
| Centrifugo dev | skip (realtime optional) | — |

### Option B: dedicated `airos-sa-api-dev` service — same shape, keeps "staging" semantics separate. Choose if staging should keep mirroring prod.

---

## Migration Blockers

| # | Blocker | Evidence |
|---|---|---|
| B1 | **WIF `attributeCondition` excludes this repo** — `development-branch` pushes cannot authenticate to GCP until the repo is added (or keys used — not recommended) | WIF provider `attributeCondition` |
| B2 | **Prod deploys come from a foreign repo** (`Final_super_admin_aide`) — its CI can overwrite `airos-sa-api` anytime; dev work here could diverge silently | image tag `ee2e24b`, WIF list, `lastModifier github-deploy@` |
| B3 | **Staging DB target unknown** — if it shares the prod DB, dev scheduler ticks (rollover/expiry generation) will mutate production rows | `airos-sa-api-staging` runs same code w/ `RUN_EMBEDDED_SCHEDULER` env |
| B4 | No branch protection on `main`; legacy workflow auto-deploys `main` → Railway/Vercel | `gh api …/protection` 404; `deploy-production.yml` |
| B5 | Shared secrets across envs (JWT/S3/location) | Part 6 table |
| B6 | Deployed code ≠ committed code — image built from uncommitted tree; any CI deploy from a branch must first have that work committed | repo status vs image date |
| B7 | Scheduler ownership unaddressed (no Cloud Scheduler API; embedded loop per service) | Part 4/5 |

---

## Unknowns & Inaccessible

- Content/target of `airos-sa-staging-database-url` (value never read — `UNKNOWN` by design).
- Whether Railway SA API/Vercel still serve real traffic (external dashboards) — `UNKNOWN`.
- `RUN_EMBEDDED_SCHEDULER`, `APP_ENV`, `DEBUG` values on deployed services (env values suppressed) — `INFERRED` prod posture for sa-api.
- The `Final_super_admin_aide` repo (foreign repo — not accessible from this workspace) — `UNKNOWN`.
- Whether secret-level IAM grants are scoped per-service (not visible via project policy) — `UNKNOWN`.
- Firebase Hosting release history (empty site verified via REST; no `firebase` CLI installed) — `VERIFIED` empty.

## Recommended Next Actions (no action taken)

1. Decide staging DB truth first — read `airos-sa-staging-database-url` in console (out of scope here) before any dev scheduler runs.
2. Add `skbaljyot6313-droid/airos-pms-super-admin-side` to WIF `attributeCondition` when ready to wire dev deploys.
3. Commit working-tree work on `development-branch` before building any deployable image (reproducibility).
4. Create dev-scoped secrets (db/jwt/s3) before first dev deploy.
5. Add branch protection + environment approval to `main`.
6. Reconcile the foreign-repo deploy pipeline — one repo should own `airos-sa-api`.
7. Rotate/drop SA JSON keys once WIF path is confirmed working.

---

## Confirmation

**No infrastructure, source code, Git branches, databases, secrets, IAM bindings, APIs, or deployment configurations were created, modified, deleted, deployed or migrated during this audit.** All commands were observational (`list`, `describe`, `get-iam-policy`, `version`, `auth list`, `config list`, REST GETs). The only side effect: the `beta` gcloud component auto-installed locally when `beta run domain-mappings` was invoked (client-side tooling, not infrastructure).
