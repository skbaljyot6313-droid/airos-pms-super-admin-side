# AiROS Storage Schema Impact (design only — no migrations applied)

**Date:** 2026-11-02 · **Branch:** `development-branch` @ `cc0a4d2`

## Current state — mostly GCS-ready already

| Table | Storage columns | GCS-fit |
|---|---|---|
| `task_completion_images` | `url` String1000, `storage_key` String512, `file_name` | ✅ `storage_key` is exactly the GCS object name — `VERIFIED` (`models/task.py:291`) |
| `maintenance_ticket_attachments` | `url` String1000, `file_name`, `mime_type`, `size_bytes`, `kind`, `attempt` | ⚠️ **no `storage_key`** — recoverable via `storage_key_from_url(url)` for uuid-shaped URLs (`VERIFIED`) |
| `task_history_events` | `photos` JSON array of URLs | ⚠️ URLs inside JSON — resolvable only via `storage_key_from_url` per element |
| `audit_events` | `detail` JSON — `url`, `size_bytes`, `category` | ⚠️ same — audit history stores raw URLs |
| `users` / `employees` | no file columns (`VERIFIED`) | — |

## Required schema changes

**Zero strictly required** — existing columns suffice if GCS keeps the flat `uuid4.hex+ext` key convention (the `url` column becomes a resolvable-but-not-persistent pointer; `storage_key` is the durable reference).

## Recommended (non-blocking, standard Alembic — NOT applied)

| Change | Why |
|---|---|
| `maintenance_ticket_attachments.storage_key String512 NULL` + backfill via `storage_key_from_url` | symmetric with completion images; avoids URL-parsing at every read |
| `media_objects` registry table (`key`, `url`, `content_type`, `size_bytes`, `uploaded_by`, `property_id`, `created_at`, `deleted_at`) | optional — enables scope-checked signed-URL auth without per-table lookups, GC of orphans, and real soft-delete. **Design only — evaluate cost vs the scoped-key lookup path** |
| Backfill pass | after flip, normalize old `/uploads/` + Supabase URLs to `storage_key` where recoverable |

**Do NOT store signed URLs in the DB** — they expire; `url` should stay the canonical resolvable path (`/api/v1/media/file/{key}` or the GCS object name), never a signed form.

## EB parity constraint (`INFERRED`)

EB owns rows in the same shared tables/bucket — any `storage_key` backfill or `media_objects` introduction must be coordinated with EB's migration chain (`u7e1f5a9d3c6` shared-stamp rule — extend, don't stamp).
