# AiROS Upload Performance — Implementation

**Date:** 2026-11-02 · **Branch:** `development-branch` · No commits, no deploys, no infra changes.

## New pipeline (what changed)

**Before:** `select files → [submit] → N× serial upload of RAW originals → final POST`
**After:** `select files → compress (async, ~main-thread canvas) → upload immediately (bounded parallel) → [submit] → final POST with pre-uploaded URLs`

Submit is now one API call — uploads already finished while the user was typing.

## Files created

| File | Purpose |
|---|---|
| `frontend/src/lib/imageOptimize.ts` | Canvas resize → max edge 1920px, WebP (JPEG fallback) q0.82; skips files <0.7MB, undecodable, or non-raster (HEIC passthrough); flattens alpha→white; bakes EXIF orientation; keeps original if recompressing enlarges it |
| `frontend/src/lib/uploadQueue.ts` | `runUploads()` — bounded concurrency (3), per-item exponential backoff retry (max 2 retries + jitter), AbortSignal cancellation, per-item results (a failed sibling never re-uploads finished ones) |
| `frontend/src/lib/uploadQueue.test.ts` | 6 tests: order, concurrency cap, retry, sibling isolation, progress, cancellation |
| `frontend/src/hooks/useEvidenceUploads.ts` | React state machine `compressing→uploading→ready|error`; upload-at-selection; dedupe by name+size+mtime; per-item retry/remove/reset; `readyUrls`/`busy`/`progress` API |
| `backend/tests/test_media_validation.py` | 16 tests: magic-byte checks incl. new HEIC `ftyp`, object-key whitelist regex |

## Files modified

| File | Change |
|---|---|
| `frontend/src/api/client.ts` | `RequestOptions.signal?: AbortSignal` → chained into fetch's controller; listener cleaned up |
| `frontend/src/api/media.ts` | `uploadPhoto(file, propertyUid, signal?)` — passes signal through |
| `frontend/src/context/AppContext.tsx` | `completeTask(task_uid, photo_urls, note)` — takes pre-uploaded URLs (was `File[]`); removed unused `mediaApi` import |
| `frontend/src/components/tasks/TaskDetailDrawer.tsx` | evidence state → `useEvidenceUploads`; submit sends `readyUrls`; per-photo status overlays + inline retry; disabled while busy |
| `frontend/src/components/maintenance/CreateMaintenanceModal.tsx` | same hook; sequential loop deleted; accept restricted to raster types; status column in list |
| `frontend/src/components/rooms/ScheduleWashroomMaintenanceModal.tsx` | same pattern |
| `frontend/src/components/maintenance/MaintenanceView.tsx` | resolution photos → hook; `doResolve` reuses URLs |
| `backend/app/api/v1/media.py` | HEIC/HEIF signature (`ftyp` box @offset 4) — fixes a broken-end-to-end path; structured per-upload timing log |
| `backend/app/core/storage.py` | `SupabaseStorage` uses shared lifecycle httpx client (`get_eb_client`) + `timeout=30` — removes per-upload DNS/TCP/TLS setup |

## Guarantees preserved / added

- Backend contract unchanged — `photo_urls`/`attachment_urls` were already the API shape; zero endpoint changes.
- Authorization unchanged — same auth + property-scope check + magic-byte + 10MB + rate-limit on every upload.
- Submit waits for `evidence.busy === false` → never references an un-uploaded file; `readyUrls` only contains verified `{url,key}` pairs.
- Idempotency: same file can't be added twice (dedupe); failed items retry in place; double-submit guarded by `isSubmitting`/`isCompleting`.
- No new npm dependencies (canvas + fetch + AbortController only). No migrations. No schema change.

## GCS direct-upload — PENDING (by design)

Bucket/adapter not provisioned (separate stage). Interface prepared: `uploadPhoto` is the single upload seam — a future `generate_signed_upload_url` step fits behind `useEvidenceUploads` by swapping `uploadPhoto` for `getUploadUrl→PUT→finalize` with identical item-state semantics. Private bucket + short-lived PUT URLs + backend-minted uuid keys per the storage audit plan.

## Known limitations

- Compression is main-thread canvas (no worker) — bounded by ~2-4 parallel images, fine at 10-image cap.
- `<img>`-level progress is per-file status, not byte-level (fetch lacks upload progress; XHR needed — not added).
- Orphan objects from abandoned uploads exist (pre-existing — no delete path; see security audit S4).
- HEIC now passes signature check but can't be compressed browser-side — uploads original (correct, just larger).
