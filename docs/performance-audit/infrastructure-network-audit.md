# Infrastructure & Network Audit

## Verified topology & measured RTTs (from this audit machine, India)

| Path | Measurement |
|---|---|
| → Supabase pooler ap-south-1 :6543 | TCP 15 ms; fresh asyncpg connect median 116 ms (TLS+auth+get_auth) |
| → Supabase API `*.supabase.co` | TCP 13 ms, TLS 14 ms (Cloudflare-fronted) |
| → Employee API `*.up.railway.app` | TCP 93 ms, TLS 101 ms; HTTPS GET /health TTFB **634 ms** |
| Railway edge | `x-railway-edge: hkg1` (Hong Kong, anycast 69.46.46.28); `x-hikari-trace: hkg1.hn7d` |

## Region assessment

- **Supabase: ap-south-1 (Mumbai)** — confirmed via host
  `aws-0-ap-south-1.pooler.supabase.com` + storage S3 endpoint region.
- **Employee Backend: Railway, service region unverified.** The hkg1 edge
  is just the nearest ingress; 634 ms cold TTFB on a 22-byte health
  response suggests the service sits far from the edge (consistent with a
  US-region deployment — the earlier "Singapore" assumption is NOT
  confirmed; check the Railway dashboard).
- **SA API region: unverified** — `railway.toml` doesn't declare it.
  If SA API is also non-Indian-region while Postgres is Mumbai, every
  DB round trip inside every request pays inter-region RTT — likely the
  single largest latency term in production (cannot be measured without
  in-service access; see methodology).
- Vercel frontend: CDN-anycast — static assets unaffected by origin region.

## Process & resource configuration

- `railway.toml`: Nixpacks, `alembic upgrade head && uvicorn` — **single
  uvicorn worker** (`--workers` absent). Concurrency ceiling is one event
  loop.
- `healthcheckPath=/health` (process liveness — cheap, correct choice).
- No Dockerfile/compose — Nixpacks-derived image.
- Frontend: static Vite build behind Vercel CDN + SPA rewrite. GZip
  middleware on API (>500 B) — verified headers present.
- HTTP client policy: `apiFetch` 20 s abort, keep-alive via browser HTTP/2
  to Railway edge; EB proxy client creates a **new connection per call**
  (DNS+TCP+TLS ~200 ms each).

## Cold start / restart behavior

- Boot does: 3× retry `SELECT 1` → schema-version check → scheduler task
  start. ~2–4 s typical; `check_schema_version` prevents stale-schema
  deploys (good).
- alembic runs *before* uvicorn in the same startCommand — deploy window
  where old code+new schema may briefly coexist is unaddressed (standard
  Railway trade-off; note, don't fix in audit).

## Dependency performance

- Supabase: healthy (12.5 ms SELECT 1, 9 sessions).
- Railway EB: adds ~430–570 ms to every `/live-locations` call from a
  same-country client (measured ext_ms).
- Storage (Supabase S3): not exercised in this audit — uploads only.

## Unavailable without production access

- SA API ↔ Postgres actual RTT (Railway region needed).
- Railway CPU/memory limits, replica count, cold-start frequency.
- Whether REDIS_URL is set in production (changes rate-limit path +
  enables arq).
