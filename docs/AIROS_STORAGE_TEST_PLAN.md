# AiROS Storage Test Plan

**Date:** 2026-11-02 · **Branch:** `development-branch` @ `cc0a4d2`

## Existing coverage (`VERIFIED` — none)

`backend/tests/` contains **zero file/media tests** — no upload, download, permission, or deletion coverage. `test_db_pooler.py` + `tests/test_auth_login.py` etc. exercise auth/db only.

## Required tests (recommended — not written)

| Area | Test | Asserts |
|---|---|---|
| Adapter | `GCSStorage.save/open/delete` vs emulator or dev bucket | round-trip bytes, content_type preserved, missing→None, delete idempotent |
| Adapter | `get_storage()` selection | `gcs`→GCSStorage, `local`→LocalStorage, `auto`+GCS_BUCKET→GCS |
| Upload | `POST /media/uploads` happy path | 201, uuid key, magic-byte validation, 10MB+1B→422, wrong-MIME→422, heic current-quirk documented |
| Upload | unauthenticated request | 401 |
| Download | `GET /media/file/{key}` with valid JWT + own-company object | 302→signed URL or stream 200 |
| Download | unauthenticated | **401** (new behavior — currently 200, regression test locks the fix) |
| Download | cross-company key | 403/404 (no existence leak) |
| Download | traversal key `../x` | 404 (whitelist regex — existing guard) |
| Signed URL | expired URL fetch | GCS 403 after 15-min TTL |
| Signed URL | persistence | URL never lands in DB rows (assert `url`/`storage_key` columns contain canonical form only) |
| Delete | task/ticket delete | object gone from bucket + row cascade; `storage_key_from_url` guards foreign URLs (EB-object safety) |
| Consistency | upload commit→visible | row + object both present; session rollback→no orphan object (or compensating delete) |
| Cloud Run | restart survival | upload → `gcloud run revisions delete`/new instance → object still fetchable (the local-FS bug this fixes) |
| Scale | concurrent uploads (N=20) | no key collisions (uuid4), no rate-limit starvation beyond 30/min cap |
| Logs endpoint | `GET /logs/attachments/*` | super_admin 200, PM 403, nonexistent→404, private no-store header |
| Frontend | `mediaUrl()` under signed-302 mode | `<img>` resolves through redirect without code change |

## Test data

Use a **dedicated `dev-test` object prefix or separate scratch bucket** for test uploads — never prod data. `tests/load/` harness (`load_common.py`, `seed_accounts.py`) can drive the concurrent-upload case.

## Dev-file migration note (`VERIFIED`)

`backend/uploads/` is gitignored; dev-box files referenced by copied DB rows won't exist on Cloud Run anyway — post-flip, old-URL rows (local `/uploads/` + Supabase paths) are expected 404s in dev unless objects are separately exported from the source bucket (outside this stage).
