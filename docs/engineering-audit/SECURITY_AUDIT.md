# Security Audit

_No credentials, keys or user data are reproduced here. Secrets were checked for presence and
handling, never printed._

## Strengths (verified)

- **AuthN**: argon2 password hashing through a bounded executor (`verify_queue`) that sheds load
  with `503 AUTH_QUEUE_*` + `Retry-After` instead of stalling the event loop. JWT HS256, 30-min
  access, 30-day refresh stored **hashed**. Rate limits on signup (10/5 min), login, refresh
  (30/60 s), upload (30/60 s), media fetch (240/60 s).
- **AuthZ**: every route resolves `User` via Depends; role gates (`require_super_admin`,
  `require_property_manager`) at the router; tenant scoping re-checked per-service
  (`_property_for_write`, `_assert_company_scope`) — not just hidden UI.
- **Transport/headers**: `SecurityHeadersMiddleware` sets `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, HSTS.
- **Uploads**: allowlist content types + magic-byte verification (JPEG/PNG/WebP/HEIC), 10 MB
  bounded read, uuid-keyed flat namespace, traversal-proof object-key regex, rate limited.
- **Secrets**: `Settings.__repr_args__` redacts secret fields; prod boot refuses empty JWT secret /
  missing DB / DEBUG=true / local storage (`production_warnings()` are fatal).
- **Injection**: SQLAlchemy everywhere; the few `text()` usages are static SQL or bound params
  (auth CTE, `lock_timeout`, index DDL). No f-string SQL with user data found.
- **Audit**: `audit_events` with actor/property scope; login events recorded with outcome.

## Findings

| ID | Sev | Finding | Evidence | Mitigation |
|----|-----|---------|----------|------------|
| SEC-01 | High | Refresh tokens never rotate; replay undetectable for 30 d | `test_characterizes_sequential_refresh_reuse_without_rotation` passes by design | Rotate on each refresh (issue new, revoke old, reuse→revoke family). Store token family id for reuse detection. |
| SEC-02 | Medium | Unauthenticated media serve for non-task-referenced objects | `media.py:182` — authz only runs `if tasks:` | Either sign URLs, or extend the reference check to all object owners (employee avatars etc.), or require auth for all fetches and use a signed-img endpoint for `<img>` tags. At minimum document which object classes are intentionally public. |
| SEC-03 | Medium | `JWT_SECRET_KEY=""` default non-fatal outside prod | `config.py:52`, `main.py` fatal only when `is_production` | Fail closed: refuse to sign with empty/short secret in *every* env; generate dev secret locally if convenience matters. |
| SEC-04 | Medium | Rate limiter fails open | `rate_limit.py` docstring | Acceptable trade-off, but log a loud WARN once per window when Redis is down and consider a small in-memory fallback window for auth endpoints only. |
| SEC-05 | Low | Access + refresh tokens in `localStorage` | `client.ts:37–70` | XSS turns into token theft; mitigations are the usual ones (strict CSP on the frontend host, sanitize all injected HTML — React default escaping already covers most). httpOnly-cookie refresh is the stronger pattern but changes the API contract. |
| SEC-06 | Low | No CSP header on API responses | `middleware.py` (nosniff/XFO/Referrer/HSTS only) | API serves JSON — low impact; add `Content-Security-Policy: default-src 'none'` on non-media responses as defense-in-depth; CSP belongs on the Firebase-hosted frontend. |
| SEC-07 | Low | `GET /media/file/{key}` returns 404 vs 403 inconsistently | `media.py` raises `MediaNotFound` for cross-company, `Forbidden` for wrong role | Minor info-leak asymmetry (existence oracle for authorized-but-wrong-role users). Normalize to 404 for all authz failures. |

## Data exposure review

- `repr()` redaction covers all secret fields. Logging never prints passwords/tokens (spot-checked
  auth, media, database modules — credential values are never logged; `database_host_port`
  exists specifically to sanitize).
- Location coordinates are proxied server-to-server and never stored/logged here (by design).
- CORS is env-configured (`CORS_ORIGINS`, no `*` wildcard in defaults).
