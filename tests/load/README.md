# AiROS PMS — Concurrent Login Load Test Suite

Repeatable, async (httpx + asyncio) load tests for the AiROS PMS backend
auth path. Simulates up to 500 simultaneous `POST /api/v1/auth/login`
requests, measures latency/reliability/backend timing, and emits
machine-readable artifacts + a diagnostic report.

## What it measures

- Per-request: status code, latency, response size, error category, and
  the backend's own timing headers (`X-Response-Time`, `X-DB-Time`,
  `X-DB-Queries`, `X-Ext-Time`, `X-Request-ID`).
- Aggregates: min/mean/p50/p90/p95/p99/max, stdev, throughput, success /
  failure / expected-rejection rates, achieved launch spread.
- Health sampling of `/health`, `/health/db`, `/ready` before/during/after.
- Optional progressive stages 1→10→25→50→100→250→500 to find the
  degradation knee.

## Known constraint — READ FIRST

The login endpoint is rate-limited to **10 requests / 60s per client IP**
(`rate_limit("login", 10, 60)` in `backend/app/api/v1/auth.py`). A
500-request burst from one IP will legitimately return ~490 `HTTP 429`s.
This is expected application behavior and is reported as such — the suite
never disables rate limiting. To measure unthrottled auth cost you need
either many source IPs or an authorized staging-only limit change.

## Setup

```bash
cd tests/load
python -m venv .venv && . .venv/Scripts/activate   # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

### Credentials (never committed — `credentials*.json` is gitignored)

```json
// credentials.json  — unique_users mode
[{"identifier": "loadtest-001@example.com", "password": "..."},
 {"identifier": "loadtest-002@example.com", "password": "..."}]
```

Or env vars (shared_user mode): `LOADTEST_IDENTIFIER`, `LOADTEST_PASSWORD`.
`LOADTEST_CREDENTIALS_FILE` may point at the file instead of `--credentials-file`.

## Commands

### Smoke test (a few accounts)

```bash
python test_concurrent_login.py --base-url http://localhost:8000 \
    --env test --confirm-load-test --mode unique_users \
    --credentials-file credentials.json --requests 3 --concurrency 3
```

### 500 concurrent logins (staging)

```bash
python test_concurrent_login.py --base-url https://staging-api.example.com \
    --env staging --confirm-load-test --mode unique_users \
    --credentials-file credentials.json --requests 500 --concurrency 500 \
    --warmup 5
```

### Progressive stages

```bash
python test_concurrent_login.py --base-url https://staging-api.example.com \
    --env staging --confirm-load-test --mode unique_users \
    --credentials-file credentials.json --only-progressive --concurrency 500
```

### Ramp comparison (spread over 5s instead of a burst)

```bash
python test_concurrent_login.py ... --ramp-ms 5000
```

### Post-login stability

```bash
python test_post_login_stability.py --base-url https://staging-api.example.com \
    --env staging --confirm-load-test \
    --credentials-file credentials.json --accounts 3 --test-refresh
```

### PowerShell

```powershell
python .\tests\load\test_concurrent_login.py --base-url http://localhost:8000 `
    --env test --confirm-load-test --mode shared_user `
    --requests 5 --concurrency 5
```

### Sustained phase + post-login reads under load

```bash
# after the burst: 500 workers keep issuing requests for 20s;
# 20% do authenticated reads (/auth/me + /workspace) instead of logins
python test_concurrent_login.py ... --sustained-s 20 --read-share 0.2
```

### Resource + DB-pool monitoring

```bash
# CPU%/RSS of the server process tree (localhost runs; psutil required)
... --server-pid <uvicorn-pid>

# pg_stat_activity sampling — real backend-connection counts at Postgres
# (works through the transaction pooler; statement cache disabled)
set LOADTEST_DB_URL=postgresql://...        # or --db-url
```

Outputs land in `process.csv` / `pg_activity.csv` + `summary.json.monitoring`.

### Seeding unique test accounts

```bash
cd backend && python ../tests/load/seed_accounts.py --count 500
# writes tests/load/credentials.json (gitignored); idempotent
```

### Test-only rate-limit override

`LOGIN_RATE_LIMIT` / `LOGIN_RATE_LIMIT_WINDOW_SECONDS` env vars
(defaults 10/60 — production posture, unchanged). Raise ONLY on
staging/test:

```bash
LOGIN_RATE_LIMIT=100000 python -m uvicorn app.main:app --port 8000
```

### Regenerate charts/report from a previous run

```bash
python analyze_results.py --outdir results/<run_id>
```

## Safety

- `--confirm-load-test` is mandatory; `--env production` additionally
  requires `--i-am-sure-production` (never default).
- Hard caps: concurrency ≤ 1000, requests ≤ 5000.
- Auto-abort when system-failure share exceeds `--abort-failure-rate`
  (default 95%, evaluated after 50 completions). Ctrl+C cancels cleanly.
- No automatic retries; no secrets in logs/artifacts; TLS verification on.

## Artifacts (per run, in `results/<run_id>/`)

`summary.json`, `requests.csv`, `errors.csv`, `health.csv`,
`latency_histogram.png`, `latency_over_time.png`,
`concurrency_comparison.png` (progressive only), `report.md`.
Charts are skipped when matplotlib is absent.

## Unit tests

```bash
cd tests/load && python -m pytest unit/ -v
```

Covers percentile math, outcome classification, credential loading,
safety gates, aggregation, artifact sanitization, cancellation, abort,
and report generation.
