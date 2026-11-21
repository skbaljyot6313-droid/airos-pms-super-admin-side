# AiROS GCS Migration Plan (design only — no resources created)

**Date:** 2026-11-02 · **Project:** `final-airos-os` · **Region:** `asia-south1`

## 1. Target architecture

| Item | Recommendation |
|---|---|
| Bucket | `final-airos-os-dev-objects-94363806721` (proposed — **not created**) |
| Location | `asia-south1` (same as Cloud SQL/Run — latency + egress free same-region) |
| Storage class | `STANDARD` (dev evidence is small+frequent; lifecycle can demote later) |
| Access | **Uniform bucket-level access ON**, **public access prevention ENFORCED** — no per-object ACLs, nothing public |
| IAM | `airos-sa-dev-runtime` → `roles/storage.objectAdmin` on **this bucket only** (`resource`-scoped condition). No `storage.admin`. |
| Naming | keep existing flat `uuid4.hex+ext` keys (collision-free, already in DB). Optionally prefix per env: `dev/{uuid}.jpg` if prod bucket later shares the project |
| Signed URLs | **V4 signed GET, 15-min expiry** minted by API after authorization — NOT persisted. Uploads stay API-proxied (server already validates+streams); optionally `generate_signed_upload_url` later to offload >2MB files |
| Secrets | none — Cloud Run SA uses ADC; no keys in env |
| Versioning | **OFF** for dev (evidence is immutable uuid-keyed; versioning doubles storage cost) |
| Lifecycle | `delete` objects >90 days in dev (optional — cost control for throwaway env) |
| One bucket or many | **ONE** — SA+EB share one object store contract today (`storage_key_from_url` proves it); bucket-per-backend would break the shared `/media/file/` proxy assumption |

## 2. Storage abstraction — extend, don't rewrite

`StorageBackend` interface already exists (`storage.py`). Add **`GCSStorage`** implementing `save`/`open`/`delete` via `google-cloud-storage` (async-wrapped like S3Storage), selected by `STORAGE_BACKEND=gcs`. Extend `get_storage()`: `auto` → prefer GCS when `GCS_BUCKET` env set (ADC always present on Cloud Run). Keep `local` for laptop dev — with the honest caveat: **local is never persistent production storage** (already true).

- Do NOT share one adapter file between backends — EB is a separate repo; replicate the ~120-line adapter there instead of a shared lib (repos don't share a package).

## 3. Download workflow change (the real work)

Today `GET /media/file/{key}` is public + streams through the API. With a private bucket the safe pattern is:

1. `GET /media/file/{key}` → `require_property_manager`-class auth → resolve owning record via `storage_key`→task/ticket company/property scope → mint 15-min V4 signed GET → **302 redirect** (or stream fallback if signing unavailable).
2. Frontend unchanged — `mediaUrl()` still points at the API path; the redirect is transparent to `<img>` tags.
3. `GET /logs/attachments/*` — same storage.open works unchanged against GCS.

## 4. Steps (ordered, approval-gated)

| Step | Action | Depends on |
|---|---|---|
| 1 | Enable `storage.googleapis.com` + `iamcredentials.googleapis.com` (signed-URL signing needs `iam.serviceAccounts.signBlob` on the runtime SA) | approval |
| 2 | Create bucket `final-airos-os-dev-objects-94363806721` — UBLA+public-access-prevention, `asia-south1`, STANDARD | 1 |
| 3 | Grant `storage.objectAdmin` on bucket → `airos-sa-dev-runtime`; `iam.serviceAccounts.signBlob` on SA → itself (for signed URLs) | 2 |
| 4 | `pip install google-cloud-storage` → `GCSStorage` adapter in `storage.py`; `STORAGE_BACKEND=gcs`, `GCS_BUCKET` env | 3 |
| 5 | Auth-gate `/media/file/{key}` + signed-URL 302 (with company/property scope check via `storage_key`→record lookup) | 4 |
| 6 | Wire `delete` into task/ticket delete paths | 5 |
| 7 | Deploy new image to `airos-sa-api-dev`, flip `STORAGE_BACKEND=local→gcs`, `GCS_BUCKET` env, redeploy | 5 |
| 8 | Backfill dev objects (the copied `task_completion_images` rows point at Supabase/local URLs — dev bucket starts empty; known limitation unless Supabase objects are exported — **separate decision**) | — |
| 9 | EB parity — replicate adapter in EB repo before prod cutover (blocker for prod, not dev) | EB repo access |

## 5. Rollback

`STORAGE_BACKEND=gcs→local` + redeploy; bucket retained (no data loss — new uploads after flip land local and vanish on redeploy, dev-acceptable).
