# Stage 4 Report — Super Admin Frontend on Firebase Hosting

**Date:** 2026-11-02 · **Project:** `final-airos-os` (#94363806721) · **Branch:** `development-branch` @ `cc0a4d2`

## Deployment

| Item | Value |
|---|---|
| Firebase association | `projects/final-airos-os:addFirebase` — new association, only Hosting product used (no Auth/Firestore/RTDB/Storage) |
| Site | `airos-super-admin-dev` → **https://airos-super-admin-dev.web.app** |
| Deploy method | `firebase-tools@latest` via `GOOGLE_APPLICATION_CREDENTIALS` (45 files, version finalized + released) |
| Deploy SA | `firebase-deployer@final-airos-os.iam.gserviceaccount.com` — `roles/firebasehosting.admin` only; JSON key at `%TEMP%/fb-deployer-key.json` (dev-only deploy identity; recommend deleting local copy or vaulting if unused) |
| Hosting config | `frontend/firebase.json` — SPA rewrite `** → /index.html`, `/assets/**` immutable 1y cache, `index.html` no-cache intent (see limitation) |
| Build | `VITE_API_URL=https://airos-sa-api-dev-94363806721.asia-south1.run.app/api/v1` inline → `npx vite build` → `frontend/dist/` (45 assets) |
| API | `airos-sa-api-dev` revision `00003-2lj`, CORS_ORIGINS = `https://airos-super-admin-dev.web.app,http://localhost:3000` (exact origins, credentialed) |

## Validation results

| Check | Result |
|---|---|
| Site root | 200 `text/html` (1.5 kB shell) |
| Deep link `/properties` | 200 — SPA rewrite works |
| Hashed asset | `Cache-Control: public, max-age=31536000, immutable` |
| CORS preflight (Origin=web.app) | 200 |
| Login POST over CORS | 401 `INVALID_CREDENTIALS` + `access-control-allow-origin: https://airos-super-admin-dev.web.app`, `allow-credentials: true` — cross-origin auth flow works end-to-end |
| Backend health | unchanged — db:connected, schema:current |
| Auth architecture | untouched — custom JWT + argon2, no Firebase/Supabase Auth |

## Notes & limitations

- `index.html` currently serves `Cache-Control: max-age=3600` (Firebase default) — the `/index.html` source glob didn't override; acceptable for dev, tighten with `**.html` glob if stale-shell issues appear.
- Realtime disabled (no CENTRIFUGO_*) — frontend polls, by design.
- Live-location tab returns 503 (no `EMPLOYEE_API_BASE_URL`) — dev-EB deploy is a separate stage.
- Browser-interactive tests (visual login flow, console audit) not performed headlessly — validated via HTTP-level equivalents. First real login needs a super_admin account: provision via `POST /api/v1/auth/signup` on the dev API.
- Deploy SA key is a long-lived JSON credential — flagged per security policy; rotate/delete when CI replaces it with WIF.

## Rollback

- Frontend: create a new release pinned to the previous version via `firebase hosting:clone`, or redeploy earlier `dist` — site versions retained.
- Backend CORS: `gcloud run deploy` with prior env (CORS=`http://localhost:3000`) or `update-traffic` to `airos-sa-api-dev-00002-sqt`.

## Modified/created files

`frontend/firebase.json`, `frontend/.firebaserc`, `backend/scripts/firebase_deploy.py` (REST deploy attempt — superseded by firebase-tools), `FIREBASE_FRONTEND_PRE_DEPLOYMENT_AUDIT.md`, this report. `.env`, workflows, and `main` untouched.
