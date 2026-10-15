# Real-time audit — polling inventory & classification

Pre-change inventory of every recurring fetch in both repos, and what the
Centrifugo integration does with each. Classifications:

- **R** = replaced by a subscription (poll becomes reconciliation-only)
- **K** = retained (necessary reconciliation/health check)
- **F** = frequency reduced
- **X** = removed

## Super Admin frontend

| Poller | Was | Now | Class | Coverage |
|---|---|---|---|---|
| `AppContext` unit refresh (rooms/dorms/washrooms/tasks/maintenance) | 20 s | 120 s + `tasks`/`units`/`maintenance`/`employees` channels → scoped refetch | R+F | task.*/resource.state_changed/maintenance.*/employee.* events |
| `LiveLocationMap` live positions | 10 s | 30 s + `locations` channel (in-place marker moves) + `attendance` channel (membership) | R+F | `employee.location_updated` throttled ≥8 s/emp server-side; check-in/out events re-pull the on-duty-filtered list |
| `TodayTasksView` | 10 s | 120 s + `tasks` channel | R+F | task.created/updated/assigned/completed incl. EB-side start/submit |
| `AbandonedTodayView` | 10 s | 120 s + `tasks` channel | R+F | same |
| `TaskReviewPanel` | 30 s | 120 s + `tasks` channel | R+F | `task.updated` on EB submit lands in the queue instantly |
| `AttendanceBoard` (today only) | 60 s | 120 s + `attendance` channel | R+F | checked_in/break_started/break_ended/checked_out + leave decisions |

Hidden-tab pause retained on every residual poll (`usePolling`) — an
idle hidden tab issues zero requests; visibility restore still fires one
reconciliation fetch.

## Employee app (Capacitor)

| Poller | Was | Now | Class | Coverage |
|---|---|---|---|---|
| `notificationService` feed poll | 45 s | 45 s + `priv:emp:{uid}` events trigger an immediate poll | R (event-accelerated) | The feed GET *materializes* SA-side assignments server-side, so the poll itself is the sync trigger — it can't be deleted, only event-driven. Allocation popups now arrive in ~1 s instead of ≤45 s. |
| Native `airos_work` OS poll (LocationTrackingService) | 30 s | unchanged | K | OS-level foreground-service channel for notification badges while the WebView may be suspended — a WebSocket can't reliably replace a backgrounded app's OS poll. FCM remains the push path. |

## Backend publish paths (new outbound traffic)

| Path | Transport | Notes |
|---|---|---|
| SA `session.info` → after_commit → `POST /api/publish` | pooled httpx (R-01 client) | rolled-back tx never emits; publish failure can't fail the mutation |
| EB post-commit `publish_bg` | `asyncio.create_task`, module client | same ordering guarantee, zero added request latency |
| EB `session.info` → after_commit | for transitions committed by callers | `resource_state.transition`/`_derive_write` |
| EB location ingest → `locations` channel | throttled `≥ LOCATION_PUBLISH_MIN_INTERVAL_SECONDS` (8 s) per employee, Redis NX or in-memory | only when the fix became the live position |

## Request-volume impact (steady state, one SA tab)

| Screen | Before | After |
|---|---|---|
| Board view open | ~3 req/min (20 s unit poll) | 0.5 req/min + event-driven refetches |
| Live map | 6 req/min | 2 req/min (reconciliation) — updates arrive by push |
| Today's tasks | 6 req/min | 0.5 req/min |
| Employee app idle | ~1.3 req/min | ~1.3 req/min + instant on-event polls |

Event payloads are ≤ ~200 B whitelisted fields (uids + status); the
expensive list payloads moved off the timer and onto demand.

## Not replaced, deliberately

- **Auth cache (60 s TTL)** — unchanged; it's a read-path accelerator,
  not staleness-sensitive transport.
- **`/workspace` bootstrap aggregate** — still one fetch at login/property
  switch; events keep it fresh thereafter.
- **FCM push** — Centrifugo can't reach a killed app; push and realtime
  are complementary channels. No duplicate user-facing notifications:
  Centrifugo events only trigger the *existing* dedup'd feed diff, they
  never render UI by themselves.
