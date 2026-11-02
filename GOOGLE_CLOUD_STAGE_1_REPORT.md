# Stage 1 Report — Fresh GCP Project `final-airos-os`

**Executed:** 2026-11-02 · **Executor:** `baljyotskhokhar@gmail.com` via gcloud SDK 590.0.1
**Scope honored:** only project creation, config defaults, and an approved billing link. No APIs enabled, no resources created, no IAM/credential/external-provider changes, no git changes.

---

## 1. Pre-flight findings

| Check | Result | Command |
|---|---|---|
| Active account | `baljyotskhokhar@gmail.com` (sole credentialed account) | `gcloud auth list` |
| Active project before | `airos-530a5` | `gcloud config list` |
| Accessible projects | `airos-530a5`, `airos-pms`, `gen-lang-client-0631096917`, `project-6cae0b3f-fd66-4d86-a89` — **`final-airos-os` absent** | `gcloud projects list` |
| Project ID availability | `gcloud projects describe final-airos-os` → permission denied/doesn't exist → free (confirmed by successful create) | `gcloud projects describe` |
| Billing accounts | **Exactly one**: `013FAB-CB815B-2E200E` "My Billing Account", `OPEN: True` — same account serving `airos-530a5` | `gcloud billing accounts list` |

## 2. Project creation

| Field | Value |
|---|---|
| Project ID | **`final-airos-os`** |
| Display name | **`Final-airos-os`** — ⚠️ *substitution*: requested `Final_airos_os` was rejected (`display_name` disallows underscores); hyphens used instead |
| Project number | `94363806721` |
| State | `ACTIVE` |
| Created | 2026-11-02T06:56:45Z |

## 3. Project configuration (verified via `gcloud config list`)

```ini
[compute]  region = asia-south1
[core]     account = baljyotskhokhar@gmail.com
           project = final-airos-os
[run]      region = asia-south1
```

- Active project switched to `final-airos-os` ✓
- `run/region = asia-south1` ✓
- `compute/region = asia-south1` ✓ — *note:* property written successfully, but gcloud skipped its validation because the Compute API isn't enabled on the new project (no API was enabled — value stored regardless, verified in `config list`).

## 4. Billing (user-approved action)

| Field | Value |
|---|---|
| Billing account | `billingAccounts/013FAB-CB815B-2E200E` ("My Billing Account") |
| `billingEnabled` | **`true`** — linked after explicit user approval |
| Before linking | `billingEnabled: false` (fresh project) |

## 5. Verification evidence

```
gcloud projects describe final-airos-os
  projectId: final-airos-os        ✓ exact match
  name: Final-airos-os             ✓ (documented substitution)
  projectNumber: '94363806721'     ✓
  lifecycleState: ACTIVE           ✓

gcloud billing projects describe final-airos-os
  billingAccountName: billingAccounts/013FAB-CB815B-2E200E
  billingEnabled: true             ✓
```

## 6. Blockers / notes

- **None blocking.** The display-name underscore substitution is cosmetic and documented above.
- No APIs are enabled on `final-airos-os` (only `cloudapis.googleapis.com` auto-enabled at creation). Every Stage 2+ step will need explicit API enablement.
- The project is completely empty: no services, no service accounts beyond GCP defaults, no secrets, no Artifact Registry, no VPC work — clean isolation from `airos-530a5` as intended.
- The previous active project (`airos-530a5`) is untouched; `gcloud config` now targets the new project for all subsequent commands.

## 7. Exact next steps for Stage 2 (proposal — nothing executed)

1. Enable the minimum API set on `final-airos-os`: `run`, `artifactregistry`, `cloudbuild`, `secretmanager`, `iam`, `iamcredentials`, `logging`, `monitoring` (+`cloudscheduler` when the tick moves, `sqladmin`/`redis`/`vpcaccess`/`compute`/`dns` only if needed later).
2. Create Artifact Registry `airos` (DOCKER) in `asia-south1`.
3. Create runtime SA `airos-sa-dev@` + deploy SA `github-deploy-dev@` (least-privilege per remediation plan §5.2).
4. Create WIF provider pinned to `skbaljyot6313-droid/airos-pms-super-admin-side` + `refs/heads/development-branch`.
5. Create dev secrets (`airos-sa-dev-database-url`, `airos-sa-dev-jwt-secret`, …) — pending the dev-DB decision from the remediation plan's Gate A.
6. Only then: first `airos-sa-api-dev` Cloud Run service deploy.

**Confirmation:** no existing project, resource, external provider, IAM binding, credential, API state, git branch or commit was modified outside the creation of `final-airos-os`, its region defaults, and the approved billing link.
