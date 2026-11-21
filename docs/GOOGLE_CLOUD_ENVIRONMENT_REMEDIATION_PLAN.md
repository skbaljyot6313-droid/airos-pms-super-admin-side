# Google Cloud Development Environment — Remediation Plan

**Date:** 2026-11-02 · **Status:** PLAN ONLY — no action taken or authorized
**Basis:** `GOOGLE_CLOUD_PRE_MIGRATION_AUDIT.md` + `GOOGLE_CLOUD_ENVIRONMENT_AUDIT.md` + `GOOGLE_CLOUD_MIGRATION_DISCOVERY.md` (all same-day, evidence-linked)
**Goal:** `development-branch` becomes the exclusive source for dev deployments to Cloud Run `asia-south1` in project `airos-530a5`, without touching `main` or existing production behavior.

**Fact labels:** `VERIFIED` · `INFERRED` · `UNKNOWN` · `RISK` · `RECOMMENDATION` — assumptions are marked, never asserted as fact.

---

## 1. Git Safety

### 1.1 Categorization of the 72 uncommitted files (VERIFIED via `git status --porcelain`)

| Category | Files | Notes |
|---|---|---|
| **Backend application changes** (~20) | `backend/app/api/v1/{auth,media,router,workspace}.py` + new `logs.py`; `backend/app/core/{config,database,exceptions,middleware,timing}.py` + new `verify_queue.py`; `backend/app/dependencies/auth.py`; `backend/app/services/{audit,auth}.py` + new `employee_profile.py`, `logs.py`; `backend/alembic/versions/649b374bfc29_*.py` (M) | Logs API, employee analysis endpoints, verify-queue, timing/audit hardening — this is what the deployed image `bfc9c93` almost certainly contains |
| **Frontend application changes** (~30) | `App.tsx`, `context/AppContext.tsx`, `api/{client,employees,media}.ts` + new `logs.ts`; `components/employees/*` incl. new `analysis/`, `analytics/`, `EmployeeDetailView*`; new `components/admin/{LogsView,TaskJourney,ActivityTimeline,ActivityEvent}*`; `components/{maintenance,navigation,rooms}/*` (M); `index.css`, `lib/datetime.ts` + new `activityLogs.ts*`; `landing/LandingPage.tsx` rewrite + **8 deleted section components** | Employee analysis + admin logs + landing redesign |
| **Tests** (~11 new + harness) | `backend/tests/test_{auth_login,db_pooler,employee_profile,logs,verify_queue}.py` (new); `tests/load/*` entire load harness (untracked dir) | `tests/load/credentials*.json|csv` + `results/` are **gitignored** — verified |
| **Infrastructure/deploy config** | `backend/Dockerfile` (new), `deploy/cloudrun.md` (new), `.gitignore` (M), `main.py` (M), `frontend/vercel.json`? (not modified — was already committed) | Dockerfile is Cloud-Run-shaped already |
| **Documentation** | `AGENTS.md` (M), `docs/{aesthetics,codebase-index,employee-analytics,performance-audit/phase4-staging-validation}.md`, 3 root audit MDs (new) | — |
| **Junk/accidental** | `NUL`, `backend/nul`, `tests/load/NUL` — 0-byte Windows redirect artifacts | **Exclude from commit (delete or ignore)** |

### 1.2 Secret scan of uncommitted files (VERIFIED)

- `git ls-files --others` scanned for `postgresql://`, `BEGIN … PRIVATE KEY`, `password=`, `api_key=`, `secret=` literals: **no embedded credentials found.** Hits were keyword mentions in code/docs only.
- `tests/load/seed_accounts.py` takes `--password` as a CLI arg (or generates random), writes creds to gitignored `credentials*.json` — safe.
- `tests/load/credentials.json` exists locally but is gitignored and untracked-by-git — **it will not be committed** (VERIFIED `git check-ignore`).
- **Recommendation:** still run a scanner (e.g. `gitleaks`) in the future CI gate — cheap insurance, no evidence of a current leak.

### 1.3 Safe commit strategy (RECOMMENDATION)

Commit on `development-branch` in 4 logical commits (or squash to one if preferred):

1. `feat(api): admin activity logs, employee analysis, auth verify queue + timing` — all backend app + test files.
2. `feat(web): employee detail analysis, admin logs view, landing redesign` — frontend + tests.
3. `chore(infra): Cloud Run Dockerfile, cloudrun.md, load-test harness` — Dockerfile, deploy/, tests/load/ (**excluding** `NUL` files and gitignored creds/results).
4. `docs: codebase index, audits, aesthetics spec` — all docs incl. the three audit MDs.

Pre-commit: `del NUL backend\nul tests\load\NUL` (or add to .gitignore), run `pytest tests/` + `npx tsc --noEmit && npm run build` + `npm test`.

### 1.4 Branch protection (RECOMMENDATION — set in GitHub UI/API, not done here)

| Branch | Rules |
|---|---|
| `main` | Require PR; ≥1 approval; status checks (pytest + tsc); no force-push; no deletion; require linear history optional |
| `development-branch` | Require status checks; no force-push; no deletion (approvals optional — it's a dev integration branch) |

`RISK` today: both unprotected → `deploy-production.yml` fires on **any** `main` push (typos included) straight to Railway+Vercel.

---

## 2. Production Source-of-Truth

| Question | Finding | Label |
|---|---|---|
| What produces `airos-sa-api`'s live image `super-admin-api:ee2e24b…` / `@bfc9c93`? | Deployed 10-26 by `github-deploy@` — tag `ee2e24b1943fd310180f8a1f7e3601da2464112f` is a git SHA **absent from this repo** | `VERIFIED` |
| Which repo is allowed to deploy? | WIF `github-pool/providers/github` `attributeCondition` = `['baljyotskhokhar-byte/Final_super_admin_aide', 'skbaljyot6313-droid/Airos-PMS-employee-side']` — **this repo is not listed** | `VERIFIED` |
| Most likely truth | `Final_super_admin_aide` (on the user's *other* GitHub account `baljyotskhokhar-byte`, which is also authenticated in `gh`) is the actual SA prod source — probably a copy/fork of this codebase | `INFERRED` |
| `airos-eb-api` image source | `Airos-PMS-employee-side` per WIF list | `INFERRED` |
| `airos-sa-api-staging` source | local `gcloud run deploy --source` by `baljyotskhokhar@gmail.com` 10-28 (source zip in `gs://run-sources-…`) — deployed from **someone's working tree**, not CI | `VERIFIED` |

**Evidence still needed to fully establish prod source:**
1. Access to `baljyotskhokhar-byte/Final_super_admin_aide` — confirm it contains this codebase + a GCP deploy workflow producing `ee2e24b`.
2. Cloud Build history (`gcloud builds list`) — shows which repo/commit `bfc9c93` was built from.
3. GitHub Actions run history on that repo.

**Consequence:** until resolved, **two repos can both "own" `airos-sa-api`** — any remediation must explicitly declare one source-of-truth before wiring this repo's CI to prod. For the *dev* environment this is less critical (dev service is ours to define), but it must be flagged at every approval checkpoint.

---

## 3. WIF & GitHub Actions Design

### 3.1 Existing (VERIFIED — do not overwrite)

- Pool `projects/732720607924/locations/global/workloadIdentityPools/github-pool`, provider `github`, issuer `token.actions.githubusercontent.com`.
- Condition: `assertion.repository in ['baljyotskhokhar-byte/Final_super_admin_aide','skbaljyot6313-droid/Airos-PMS-employee-side']` — maps `repository`, `ref`, `actor`.
- `github-deploy@` roles: `artifactregistry.writer`, `cloudbuild.builds.editor`, `iam.serviceAccountUser`, `run.developer` (project-wide), `serviceusage.serviceUsageConsumer`.

### 3.2 Required change (RECOMMENDATION — not executed)

**Option A (minimal):** extend the existing provider's `attributeCondition` to include `'skbaljyot6313-droid/airos-pms-super-admin-side'`. Simple — but prod and dev then share one deploy identity (`RISK`: a `main` push in *this* repo could technically deploy prod if a workflow asked it to).

**Option B (preferred):** create a **second WIF provider or dedicated dev SA**:
- New SA `github-deploy-dev@airos-530a5.iam.gserviceaccount.com`
- New provider `github-dev` (same pool OK) with `attributeCondition`: `assertion.repository == 'skbaljyot6313-droid/airos-pms-super-admin-side' && assertion.ref == 'refs/heads/development-branch'` — **repository AND branch pinned**.
- `github-deploy-dev` roles, scoped to *dev only*: `artifactregistry.writer`, `run.developer` **on `airos-sa-api-dev` service only** (`gcloud run services add-iam-policy-binding`), `iam.serviceAccountUser` on `airos-sa-dev@` runtime SA, `serviceusage.serviceUsageConsumer`.
- This guarantees: dev workflows physically **cannot** deploy to `airos-sa-api`/`airos-eb-api` (no service-level binding), and `main` cannot deploy dev (ref pinned to `development-branch`).

### 3.3 Proposed workflow `deploy-dev.yml` (design only)

```yaml
on:
  push: { branches: [development-branch] }
  workflow_dispatch:
permissions: { id-token: write, contents: read }
jobs:
  deploy-dev:
    steps:
      - checkout
      - auth via WIF → github-dev provider → github-deploy-dev SA
      - docker build backend/Dockerfile → tag asia-south1-docker.pkg.dev/airos-530a5/airos/super-admin-api:dev-$GITHUB_SHA (+ :dev-latest)
      - docker push
      - gcloud run deploy airos-sa-api-dev --image …:dev-$GITHUB_SHA --region asia-south1
      - smoke: curl -fsS $URL/ready
```

Guards: `environment: development` (optional approval), no `main` in filters, concurrency group `deploy-dev`, `if: github.ref == 'refs/heads/development-branch'` belt-and-suspenders. `deploy-production.yml` stays untouched — it targets Railway/Vercel and can't reach GCP.

---

## 4. Environment Isolation Map

| Dependency | Dev target (current) | Prod target | Shared? | Cross-write risk | Required separation |
|---|---|---|---|---|---|
| Compute | `airos-sa-api-staging` | `airos-sa-api` | project only | code only | dev service OK — recommend rename `airos-sa-api-dev` semantics |
| PostgreSQL | `airos-sa-staging-database-url` → **target UNKNOWN** | Supabase `postgres` (shared w/ EB) | **UNKNOWN — possibly same DB** | **CRITICAL: if same DB, dev's embedded scheduler + rollover + generation ticks write prod rows; dev checkouts/tasks pollute prod data; alembic_version shared too** | dedicated DB: separate Supabase project/DB (`airos_dev`), fresh `alembic upgrade head`, seed minimal fixtures |
| MongoDB | none | none | — | — | n/a |
| Redis | none | none visible | — | — | skip for dev (in-memory fallback exists) |
| Object storage | same Supabase creds + bucket | same | **YES** | dev uploads/evidence land in prod bucket | separate bucket `uploads-dev` or separate prefix + dev S3 creds |
| JWT | `airos-sa-jwt-secret` shared | same | **YES** | dev-issued tokens valid on prod | new `airos-sa-dev-jwt-secret` |
| Employee API | prod `airos-eb-api` (via `EMPLOYEE_API_BASE_URL`) | same | **YES** | dev SA calls prod EB — live-location reads are read-mostly; allocation notices POST to prod EB on dev commits | acceptable for dev reads; if dev allocation flows are exercised, stand up `airos-eb-api-dev` or gate `LOCATION_SERVICE_API_KEY` off in dev |
| Supabase project | same | same | YES | cascade of the above | separate Supabase project for dev ideal; at minimum separate DB+bucket |
| Centrifugo | unset | unset | — | — | skip |
| Firebase | shared project | shared | YES | dev frontend on same Firebase project | acceptable — hosting sites isolate; push creds stay EB-only |

**Explicit investigation required (gate for all dev work):**
1. `airos-sa-staging-database-url` — its value determines whether dev ticks already endanger prod. *Read the value in console (authorized), or check `airos-sa-api-staging` logs for its connected host.*
2. Whether `airos-sa-api-staging` currently has `RUN_EMBEDDED_SCHEDULER=true` — if yes AND it shares the prod DB, **it is mutating production data every 60 s right now.** `RISK` — highest-priority check.
3. `EMPLOYEE_API_BASE_URL` on staging — which EB it points to.

---

## 5. Secrets & IAM Plan

### 5.1 Secret → consumer map + proposed dev set

| Existing secret | Consumers | Shared envs? | Dev proposal |
|---|---|---|---|
| `airos-sa-database-url` | airos-sa-api | prod-only | unchanged |
| `airos-sa-staging-database-url` | staging | dev-ish | **repoint or supersede** with `airos-sa-dev-database-url` → dedicated dev DB |
| `airos-sa-jwt-secret` | sa-api + staging | **prod+dev shared** | new `airos-sa-dev-jwt-secret` for dev |
| `airos-eb-database-url`, `airos-eb-jwt-secret` | eb-api | EB prod | untouched |
| `airos-s3-{access,secret}-key` | all 3 | **shared everywhere** | new `airos-s3-dev-{access,secret}-key` scoped to dev bucket |
| `airos-location-service-key` | all 3 | shared | dev may reuse read-only OR EB issues a dev key |
| `airos-supabase-secret-key` | sa-api + staging | shared | dev gets its own Supabase project's key if separate project |
| `airco-pms-dev-*` (in `airos-pms` project) | nothing | orphan | leave; cleanup decision later |

### 5.2 Service accounts → least privilege (RECOMMENDATION)

| SA | Today | Proposal |
|---|---|---|
| `airos-sa-api@` | prod runtime; secret-level access presumably | keep; dev may reuse or get `airos-sa-dev@` (preferred — revocable independently) |
| `airos-eb-api@` | EB runtime | untouched |
| `github-deploy@` | project-wide deployer + JSON key | keep for prod (foreign repo owns it); **do not reuse for dev** |
| **new `github-deploy-dev@`** | — | service-scoped `run.developer` on `airos-sa-api-dev` + `artifactregistry.writer` + `serviceAccountUser` on dev SA only |
| `732720607924-compute@` | `roles/editor`, probable staging runtime | **stop using for staging/dev**; leave binding alone for now (INVESTIGATE what else uses it) |
| `firebase-adminsdk-fbsvc@` | EB Firebase | untouched |

### 5.3 Long-lived keys (VERIFIED — do not rotate yet)

| Key holder | Expiry | Consumer (best guess) | Plan |
|---|---|---|---|
| `airos-sa-api` `97c3acab` | 2028-10-25 | UNKNOWN — maybe held locally/CI | locate consumer; delete once confirmed unused |
| `airos-eb-api` `0d0ec7c1` | 2028-10-25 | UNKNOWN | same |
| `github-deploy` `ed525de8` | 2028-10-25 | possibly legacy CI | delete after WIF verified working |
| `firebase-adminsdk` `47642ae9` | 2028-10-09 | probably EB local dev | verify with EB repo |
| `firebase-adminsdk` `d1f09447` | **9999-12-31 (never)** | UNKNOWN | **priority rotate — immortal credential** |

Sequence (later, not now): confirm consumers → add WIF/ADC path → verify deploys → disable key → observe → delete.

---

## 6. Authentication & Network Access

| Service | Ingress | IAM | App auth | Assessment |
|---|---|---|---|---|
| `airos-sa-api` | `all` | `allUsers` invoker | JWT on all `/api/v1` routes; only `/health`, `/ready`, `/auth/{signup,login,refresh,logout}`, `/media/file/{key}`(whitelisted key regex) are open | **Public ingress is correct** — browsers must reach it; auth enforced at app layer. Keep `allUsers`; optionally add Cloud Armor later |
| `airos-sa-api-staging` | `all` | `allUsers` | same | Acceptable for dev; consider `--ingress=internal-and-cloud-load-balancing` + IAP only if dev must be hidden (breaks SPA dev use otherwise) |
| `airos-eb-api` | `all` | `allUsers` | EB's own auth + `X-Location-Service-Key` on `/admin/*` | untouched |
| `airos-sa-api-dev` (proposed) | `all` + `allUsers` | same app-layer auth | fine — endpoints already gate everything sensitive |

Intentionally public endpoints (`VERIFIED`): `/health`, `/ready`, `/api/v1/health`, `/auth/*`, `GET /media/file/{key}` (unguessable keys, 240/min rate limit), `/uploads/*`. Everything else requires JWT + role checks + tenant scoping (404 on foreign-tenant objects).

**Recommendation:** no IAM change needed for function; the meaningful control is **secret separation** (a leaked dev JWT secret must not mint prod-valid tokens — covered in §5).

---

## 7. Billing & Cleanup

- **Billing:** `billingAccounts/013FAB-CB815B-2E200E`, `billingEnabled: true` — `VERIFIED`.
- **Cost drivers:** `airos-sa-api-staging` **min 1 always-on** (~1 vCPU/512Mi continuous ≈ the only 24/7 billed compute — `INFERRED` ~US$25–40/mo order of magnitude, not measured); sa-api/eb-api scale-to-zero + per-request; AR ~676 MB total; Secret Manager 9 secrets; Firebase idle.
- **Unused/unreferenced (evidence):** `super-admin-api@d844ab3` (`latest` tag pointing at superseded digest), `super-admin-api-staging@1bf2ff3` untagged, 4 failed staging revisions, `airos-pms` project (0 services, 2 orphan secrets), dead `DB_POOL_PRE_PING` env, `NUL` files, Google-default projects.

| Resource | Class |
|---|---|
| All 3 Cloud Run services + their secrets + runtime SAs | **KEEP/PROTECTED** |
| `airos` + `cloud-run-source-deploy` AR repos | KEEP |
| `github-deploy@` + WIF pool | KEEP (add dev provider separately) |
| `super-admin-api-staging@1bf2ff3` | CLEANUP CANDIDATE (untagged, superseded) |
| `super-admin-api@d844ab3` + `latest` tag | INVESTIGATE — retag `latest`→live digest or keep as rollback |
| `airos-pms` project + `airco-pms-dev-*` secrets | CLEANUP CANDIDATE — **requires owner confirmation; may hold historical state** |
| `DB_POOL_PRE_PING` env | CLEANUP (cosmetic — remove at next deploy) |
| SA JSON keys ×5 | INVESTIGATE → rotate/delete after WIF verified |
| default-compute `roles/editor` | INVESTIGATE — tighten after staging moved off it |
| Firebase adminsdk 9999-key | **priority INVESTIGATE** — never expires |
| Railway/Vercel/Centrifugo/Redis | **PROTECTED — presumed live prod** |

---

## 8. Final Implementation Sequence

```
PHASE 0 — DECISIONS & READ-ONLY VERIFICATION (no changes)
  0.1 Read value of airos-sa-staging-database-url in console → dev DB shared or not?    [GATE A]
  0.2 Check RUN_EMBEDDED_SCHEDULER + EMPLOYEE_API_BASE_URL values on staging
  0.3 Inspect gcloud builds list + Final_super_admin_aide repo → confirm prod source   [GATE B]
  0.4 Decide: dev = repurpose staging service, or new airos-sa-api-dev

PHASE 1 — GIT (this repo only)
  1.1 Clean NUL files; commit WIP in 4 commits on development-branch; push
  1.2 Verify: pytest + tsc + vitest green locally
  1.3 Enable branch protection: main (PR+approval+checks), development-branch (checks+no-force-push)

PHASE 2 — DEV DATA PLANE (needs approval of Phase 0 outcome)
  2.1 Provision dev Postgres (separate Supabase project/DB) → airos-sa-dev-database-url
  2.2 Create airos-sa-dev-jwt-secret (+ dev S3 creds if separating storage)
  2.3 alembic upgrade head on dev DB; minimal seed (1 company/property/SA user)

PHASE 3 — DEPLOY IDENTITY (needs Phase 0-B resolution first)
  3.1 Create github-deploy-dev@ SA + WIF provider/condition
       (repo + refs/heads/development-branch pinned)
  3.2 Grant service-scoped run.developer on the dev service ONLY
  3.3 Grant secret-level secretAccessor on dev secrets ONLY

PHASE 4 — DEV SERVICE
  4.1 gcloud run deploy airos-sa-api-dev (or redeploy staging):
       1vCPU/512Mi, concurrency 20, min 0, max 4, timeout 300,
       SA airos-sa-dev@, RUN_EMBEDDED_SCHEDULER=true,
       env=dev DB/JWT/S3, EMPLOYEE_API_BASE_URL=prod EB (read-mostly)
       drop DB_POOL_PRE_PING; VERIFY_MAX_WORKERS=2
  4.2 Smoke: /ready → 200; /api/v1/health → db+schema OK

PHASE 5 — CI WIRING
  5.1 Add .github/workflows/deploy-dev.yml (on push development-branch)
  5.2 First CI deploy; confirm github-deploy-dev used, image tagged dev-<sha>
  5.3 Confirm NO workflow can target airos-sa-api/eb-api (service-scoped role proof:
      attempt a dry-run/permission check)

PHASE 6 — VALIDATION & CLEANUP DECISIONS
  6.1 End-to-end dev flow: login → workspace load → task ops → verify prod unaffected
  6.2 Decide DB_POOL_PRE_PING / stale images / airos-pms / key rotations (separate approvals)
  6.3 Frontend dev: Firebase preview channel or dev site (optional later)
```

**Rollback:** every phase is independently revertible — dev service/secrets/SA/WIF provider are additive; `gcloud run services update-traffic` reverts revisions; workflow file deletion un-wires CI; nothing in phases 1–5 touches prod.

**Validation gates:** A = staging DB identified as non-prod before any scheduler runs · B = prod source repo confirmed before claiming this repo's CI owns prod · C = after Phase 5, verify a `main` push triggers zero GCP activity.

**Expected impact:** dev iteration deploys to `airos-sa-api-dev`/`staging` on every `development-branch` push; prod surface untouched; total added monthly cost ≈ one scale-to-zero Cloud Run service + dev Supabase tier.

---

## Assumption register (not facts)

- `Final_super_admin_aide` mirrors this codebase — `INFERRED` from WIF + SHA tag, unconfirmed.
- Staging DB separation — `UNKNOWN` until secret value read.
- Staging runs as default compute SA — `INFERRED` (no explicit SA in describe).
- EB's repo/ownership of `airos-eb-api` deploys — `INFERRED` from WIF list.
- Prod still serves Railway/Vercel to real users — `UNKNOWN`.

**Nothing was modified, created, deleted, deployed, enabled, disabled, rotated or committed during the production of this plan.**
