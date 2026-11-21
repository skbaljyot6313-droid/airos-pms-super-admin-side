# AiROS Storage Inventory — every file workflow

**Date:** 2026-11-02 · **Branch:** `development-branch` @ `cc0a4d2`

## Super Admin Backend (`VERIFIED`)

| # | Workflow | Endpoint | Frontend caller | Object key | DB row | Delete |
|---|---|---|---|---|---|---|
| 1 | Generic photo upload | `POST /api/v1/media/uploads` (`media.py:79`) | `src/api/media.ts::uploadPhoto` — FormData | `uuid4.hex+ext` via `new_object_key` | none directly (caller stores url) | n/a |
| 2 | Task completion evidence | submission `urls[]` → `TaskCompletionImage` rows (`task.py:485`) | `TaskDetailDrawer` (staff complete), EB mobile (submit-for-review) | same uuid keys | `task_completion_images` | none — orphan |
| 3 | Maintenance issue/resolution photos | `POST /media/uploads` then ticket link | `CreateMaintenanceModal`, `ScheduleWashroomMaintenanceModal`, `MaintenanceView` | same | `maintenance_ticket_attachments` (kind, attempt) | none — orphan |
| 4 | Evidence download (any object) | `GET /api/v1/media/file/{key}` (`media.py:128`) | `mediaUrl()` + `<img>` in `TaskReviewPanel`, `CompletionEvidenceLightbox`, `TaskDetailDrawer` | whitelist regex enforced | — | — |
| 5 | Admin log attachment view | `GET /api/v1/logs/attachments/{source}/{event_id}` (`logs.py:81`) | `LogsView`, `activityLogs.ts` | resolves via `LogsService.attachment_key` | reads task_photo/maintenance/audit/task_history rows | — |
| 6 | Local static serving | `GET /uploads/*` (`main.py:296`) | relative URLs stored pre-S3 era | — | — | — |
| 7 | Task history photo audit | `task_history_events.photos` JSON | `TaskJourney` | — | JSON col | — |
| 8 | Audit event photo log | `audit_events.detail.url` | `LogsView` | — | JSON col | — |

**Non-existent workflows (`VERIFIED` absent):** PDF generation, Excel/report exports, employee documents/ID uploads, profile pictures, attendance selfies, file imports, background file processing, `tempfile`/`aiofiles` usage.

## Employee Backend / Employee Frontend / Mobile (`INFERRED`/`UNKNOWN`)

| # | Workflow | Evidence |
|---|---|---|
| E1 | EB upload endpoint writing same shared bucket | `storage_key_from_url` handles `/api/v1/media/file/` + docstring "employee-app evidence stored in the SAME shared bucket" — `VERIFIED` contract, `INFERRED` impl |
| E2 | EB media proxy `GET /api/v1/media/file/{key}` | same docstring — `INFERRED` |
| E3 | Mobile submit-for-review photo flow | produces `task_completion_images` rows readable by SA review tab — `VERIFIED` consumer side |
| E4 | EB object deletion | `UNKNOWN` |

## Frontend-only file handling (`VERIFIED`)

- `uploadPhoto(file, propertyUid)` — `FormData`, `apiFetch` (bearer), returns `{url,key}`.
- `mediaUrl(url)` resolves relative `/uploads/*` and `/api/v1/media/file/*` against `BASE_URL` origin — **the frontend assumes files are same-origin through the API**; signed-URL migration must keep this contract or teach `mediaUrl` to return absolute GCS URLs directly.
- No client-side caching layer beyond browser cache (immutable 1y header on `/media/file/`).
