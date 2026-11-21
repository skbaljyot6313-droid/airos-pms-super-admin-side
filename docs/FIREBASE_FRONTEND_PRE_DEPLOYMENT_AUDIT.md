# Firebase Frontend Pre-Deployment Audit (Stage 4, Phase A)

**Date:** 2026-11-02 · **Branch:** `development-branch` @ `cc0a4d2` · **Frontend root:** `frontend/`

## Architecture

| Item | Value | Evidence |
|---|---|---|
| Framework | React `^19.0.1` + react-dom `^19.0.1` | `package.json` |
| Build | Vite `^8.3.0`, `@vitejs/plugin-react`, Tailwind v4 (`@tailwindcss/vite`), TS `^7.0.2` | `package.json`, `vite.config.ts` |
| Package manager | npm (`installCommand` in vercel.json; package-lock present? — npm scripts standard) | `vercel.json` |
| Build cmd / output | `npm run build` → `frontend/dist/` (gitignored) | `package.json`, `vercel.json` |
| Routing | react-router-dom `^7.18.4`, client-side guards (`RequireAuth`/`RequireRole`/`PropertyScopedView`); SPA rewrite needed | `src/App.tsx` |
| API config | `VITE_API_URL` → `BASE_URL` (`client.ts:15`); dev fallback `http://localhost:8000/api/v1`; missing-in-prod → explicit error | `client.ts` |
| Auth | Bearer JWT in `localStorage` (`mgmt_tool_auth_token`, `_refresh_token`); 401→single-flight `/auth/refresh`→retry once→logout | `client.ts` |
| Uploads | multipart `apiFetch` FormData ≤10MB; media via same-origin `/api/v1/media/file/{key}` | `api/media.ts` |
| Realtime | `centrifuge ^5.7.4` to `CENTRIFUGO_WS_URL` — optional; 503→poll-only mode | `src/realtime/` |
| External browser deps | OSM tiles (`{s}.tile.openstreetmap.org`, `LiveLocationMap.tsx:348`), Fontshare fonts (`index.css:1`) | verified |

**Direct DB/Supabase client deps:** NONE — all data flows through `apiFetch` → SA API only. `VERIFIED`.
**Excluded-provider refs in source:** none (no railway/supabase/vercel/mongo strings in `src/`).
**Secrets in frontend:** none — only `VITE_API_URL`, `VITE_MAX_COMPLETION_IMAGES` (non-sensitive).

## Env inventory & deploy plan

- `VITE_API_URL` = `https://airos-sa-api-dev-94363806721.asia-south1.run.app/api/v1` (injected at build — `/api/v1` suffix required, client keeps it as path prefix).
- `VITE_MAX_COMPLETION_IMAGES=10` (matches backend).
- CORS on `airos-sa-api-dev` must add exact origin `https://airos-super-admin-dev.web.app`.

## Risks

| Risk | Mitigation |
|---|---|
| SPA deep-link 404s | Firebase rewrite `** → /index.html` (same as vercel.json) |
| Centrifugo unset → realtime disabled | expected; polling fallback is designed behavior |
| `index.html` caching stale | `Cache-Control: no-cache` on html; immutable caching on hashed `/assets/*` |
| MSYS env mangle | pass VITE_API_URL inline in bash (no gcloud env args) |

**Conclusion:** deployable — SPA + one API base URL, no excluded-provider dependency.
