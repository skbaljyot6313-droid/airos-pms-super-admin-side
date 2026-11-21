# AiROS Storage Security Audit

**Date:** 2026-11-02 · **Branch:** `development-branch` @ `cc0a4d2` · Audit only — nothing modified.

| # | Severity | Finding | Evidence |
|---|---|---|---|
| S1 | **HIGH** | `GET /api/v1/media/file/{key}` is **public** — any evidence photo is retrievable by anyone holding its URL. "Unguessable" uuid keys are the only control; URLs leak via screenshots, shared links, browser history, audit JSON, log streams | `media.py:128-158` explicit "Public by design" comment |
| S2 | **HIGH** | `/uploads` StaticFiles mount serves the whole local dir **unauthenticated** — same exposure class as S1 under the local backend | `main.py:287-296` |
| S3 | **MEDIUM** | `SupabaseStorage._ensure_bucket` creates a **public bucket** — all objects fetchable unauthenticated at the Supabase URL | `storage.py` SupabaseStorage |
| S4 | **MEDIUM** | Orphan accumulation: `StorageBackend.delete` has **zero callers** — DB rows deletable (task/ticket CASCADE) but objects persist forever; privacy/data-retention exposure | grep: no `get_storage().delete` callers in `app/services/` |
| S5 | **MEDIUM** | HEIC/HEIF whitelisted in `ALLOWED_CONTENT_TYPES` but magic-byte check only covers jpeg/png/webp → upload path inconsistently enforced (functional bug; slight security relevance as a validation gap) | `storage.py` vs `media.py:_matches_image_signature` |
| S6 | **LOW** | `POST /media/uploads` authenticated+property-scoped+rate-limited 30/60s, MIME **and** magic-byte validated, 10MB cap, uuid keys — upload path is solid (`VERIFIED`) | `media.py:79-126` |
| S7 | **LOW** | `GET /logs/attachments/*` = correct pattern — `require_super_admin` + private no-store — but it's SA-only, so property-managers can't view evidence via that route | `logs.py:81-101` |
| S8 | **LOW** | `storage_key_from_url` restricts deletes to uuid-key patterns (traversal-safe); `LocalStorage.delete` additionally requires `Path(key).name == key` | `storage.py` |
| S9 | **MEDIUM** | `task_history_events.photos` + `audit_events.detail.url` store raw URLs in JSON — any GCS/signed-URL migration must keep resolving historical URLs or normalize them | models/migrations |
| S10 | **INFO** | Cross-tenant object isolation is **URL-secrecy only** — no property/company check on `/media/file/` fetch. The logs endpoint does check scope; media proxy does not | `media.py` vs `logs.py` |

## Remediation recommendation (design only)

- Keep `POST /media/uploads` as-is (already solid).
- Replace public `/media/file/{key}` with **authenticated + scoped** streaming (or short-lived GCS signed URLs minted after `require_property_manager`/`_assert_company_scope`-style checks) — the `<img>` limitation is solved by a thin authenticated endpoint that 302s to a signed URL, same pattern the logs endpoint already proves.
- Enforce `private` GCS bucket + `uniform bucket-level access` + public-access prevention (S3-equivalent of today's Supabase public bucket must NOT be replicated).
- Wire `StorageBackend.delete` into task/ticket delete paths (with `storage_key_from_url` guard already present).
- Extend `ALLOWED_CONTENT_TYPES`/signature check consistently (drop heic or add its detection).
