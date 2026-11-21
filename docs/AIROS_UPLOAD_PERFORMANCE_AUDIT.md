# AiROS Upload Performance Audit (Phase A+B)

**Date:** 2026-11-02 · **Branch:** `development-branch` · Scope: SA repo only (EB/mobile INFERRED).

## Upload workflows found

| Workflow | Path | Evidence |
|---|---|---|
| Task completion evidence | `TaskDetailDrawer` → `AppContext.completeTask` → `POST /media/uploads` per file → `POST /tasks/{uid}/complete` | `AppContext.tsx:2095` |
| Maintenance issue photos | `CreateMaintenanceModal` → sequential `uploadPhoto` loop → `createMaintenanceBatch` | modal ~L136 |
| Washroom maintenance photos | `ScheduleWashroomMaintenanceModal` — same loop | ~L112 |
| Resolution photos | `MaintenanceView.doResolve` — same loop | ~L135 |

## Root causes of the reported latency (VERIFIED)

| # | Bottleneck | Where | Impact |
|---|---|---|---|
| 1 | **Raw multi-MB files** — no client compression; phone photos ship at 3–8MB | all 4 call sites | dominant cost: network transfer ∝ size |
| 2 | **Sequential uploads** — `for (f of photos) await uploadPhoto(f)` in all 4 flows | `AppContext.tsx:2100`, 3 modals | N× (upload + RTT) serialized |
| 3 | **Upload at submit time** — nothing uploads until the user clicks submit; then ALL network work happens inside the "submit" wait | all 4 call sites | submit feels slow regardless of backend speed |
| 4 | **Per-upload backend cost** — auth + property query + 10MB read + magic-byte check + storage write + audit + commit | `api/v1/media.py:79` | ~50–300ms × N files (small vs network) |
| 5 | **Fresh `httpx.AsyncClient` per storage call** — DNS+TCP+TLS per upload on the Supabase path | `storage.py` SupabaseStorage | ~200ms per upload on prod path |
| 6 | **HEIC end-to-end broken** — whitelisted client+server, rejected by signature check | `storage.py` vs `media.py` | every HEIC upload fails 422 |
| 7 | **LocalStorage on dev Cloud Run** — writes ephemeral FS (documented, separate stage) | `STORAGE_BACKEND=local` | correctness, not latency |

## What was NOT the problem

- DB writes: single audit insert + commit per upload — negligible.
- Image processing: backend does none (nothing to remove).
- General API performance: healthy (matches user's observation).

## Instrumentation added (Phase B)

- Backend `upload_media` logs `read_validate_ms / storage_ms / audit_ms` per upload (no PII, no file contents).
- Frontend `apiFetch` already emits dev request-timing via `reqLog`; `useEvidenceUploads` records per-item status/attempts/bytes so network-vs-backend splits are visible in devtools + logs.
- Correlation: existing request-id middleware + `perfCorr` in `apiFetch`.
