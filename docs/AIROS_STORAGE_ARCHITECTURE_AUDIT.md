# AiROS Storage Architecture Audit (Stage 1)

**Date:** 2026-11-02 · **Branch:** `development-branch` @ `cc0a4d2` · **Scope:** this repo only — Employee Backend, Employee Frontend, and Mobile app are in separate checkouts → their storage behavior is `INFERRED`/`UNKNOWN` where noted.

## 1. Storage abstraction — `backend/app/core/storage.py` `VERIFIED`

| Component | Detail |
|---|---|
| Interface | `StorageBackend` — `save(data, key, content_type) → url`, `open(key) → (stream, content_type, length)`, `delete(key)` |
| Backends | `LocalStorage` (UPLOAD_DIR → `/uploads/{key}`), `S3Storage` (boto3: AWS/MinIO/Supabase-S3), `SupabaseStorage` (Supabase REST API, **creates a PUBLIC bucket lazily** via `_ensure_bucket`) |
| Selector | `get_storage()` — `STORAGE_BACKEND` env: `s3`/`supabase`/`local`/`auto`; `auto` prefers S3 creds → SUPABASE_SECRET_KEY → local |
| Key convention | `new_object_key()` = `uuid4().hex + ext` — flat, collision-free, extension from **validated MIME only** (client filename never trusted) |
| Limits | `MAX_BYTES = 10MB`; `ALLOWED_CONTENT_TYPES` = jpeg/png/webp/heic/heif |
| URL→key | `storage_key_from_url()` reverses `/uploads/`, `/media/file/`, Supabase, and S3 URL shapes back to the flat key |

**Quirk (`VERIFIED`):** HEIC/HEIF are in `ALLOWED_CONTENT_TYPES` but `_matches_image_signature()` (`app/api/v1/media.py`) only checks jpeg/png/webp magic bytes → **all HEIC/HEIF uploads fail 422** despite the whitelist.

## 2. Serving paths

| Path | Impl | Auth |
|---|---|---|
| `POST /api/v1/media/uploads` | `media.py:79` — MIME+magic-byte check, 10MB stream cap, rate-limit 30/60s, audit event, returns `{url, key}` | `get_current_user` + optional `property_id` scope check |
| `GET /api/v1/media/file/{key}` | `media.py:128` — key whitelist regex `^[0-9a-f]{32}\.[a-z0-9]{2,5}$`, immutable 1y cache | **NONE — public by design** (comment: "unguessable uuid4 names, <img> can't attach JWT") |
| `GET /api/v1/logs/attachments/{source}/{event_id}` | `logs.py:81` — resolves key via `LogsService.attachment_key`, streams, `private, no-store` | `require_super_admin` |
| `GET /uploads/*` | `main.py:296` `StaticFiles` mount — **unconditional**, resolves local-backend URLs | **NONE — public** |

## 3. Writers / readers of stored objects

- Writers: only `POST /media/uploads` (SA app). EB mobile app uploads to the **same shared bucket** via its own API (`INFERRED` — docstring at `media.py:5` + `storage_key_from_url` EB-path branch).
- Readers: `GET /media/file/{key}` (public), `GET /logs/attachments/*` (SA-gated), `StaticFiles /uploads` (local backend).
- Deleters: **none** — `StorageBackend.delete` has zero callers in SA services (`VERIFIED` via grep). DB rows are removed but objects persist → orphan accumulation. `storage_key_from_url` exists precisely to enable future safe deletion.

## 4. Cloud Run compatibility (`VERIFIED` — currently `STORAGE_BACKEND=local` on `airos-sa-api-dev`)

| Workflow | Unsafe on Cloud Run? |
|---|---|
| `POST /media/uploads` | **YES — silently broken.** Writes to container FS; min-instances=1 hides it until a second instance or redeploy, then objects vanish per instance. `/uploads` mount + `/media/file/` read only the *local* instance's disk. |
| `/uploads` static mount | Same — serves only the writing instance's FS |
| Read of EB/cross-app objects | Broken under local — shared-bucket assumption fails |
| Temp files | none — no `tempfile`/`aiofiles`/`shutil` file workflow exists (`VERIFIED` grep) |
| PDF/Excel/report exports | **none exist** in the codebase (`VERIFIED` grep) |

## 5. Database metadata (`VERIFIED`)

| Table | Columns |
|---|---|
| `task_completion_images` | `task_id`, `history_event_id`, `submission_id` FKs · `url` (String1000) · `storage_key` (String512, derived via `storage_key_from_url`) · `file_name` · `created_by_id/name` · `created_at` |
| `maintenance_ticket_attachments` | `ticket_id` FK · `url` (String1000) · `file_name` · `mime_type` · `size_bytes` · `uploaded_by_name` · `kind` (`issue`/`resolution`) · `attempt` · `created_at` |
| `task_history_events.photos` | JSON array of URLs (event log) |
| `audit_events.detail` | JSON — photo uploads log `{"category":"photo","url":…,"size_bytes":…}` |

Schema already stores `storage_key` on completion images — GCS-ready. `maintenance_ticket_attachments` lacks `storage_key` (recoverable via `storage_key_from_url`).

## 6. EB / mobile / employee frontend (`INFERRED`/`UNKNOWN`)

- EB shares the object bucket (`storage_key_from_url` handles `/api/v1/media/file/` paths — `VERIFIED` in SA code).
- EB-side upload/download endpoints, auth model, object-key convention: `UNKNOWN` — EB repo absent. The shared-bucket contract means **any GCS migration must be coordinated across both backends**.
