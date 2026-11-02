"""
Shared library for the AiROS PMS load-test suite.

Source of truth (verified against backend/app):
  - Login: POST {base}/api/v1/auth/login
        request : {"identifier": <email-or-username>, "password": <pw>}
        success : 200 {access_token, refresh_token, token_type="bearer",
                       user{...}, company{...}}
        errors  : 401 INVALID_CREDENTIALS, 403 ACCOUNT_INACTIVE,
                  422 validation, 429 RATE_LIMITED, 503 DATABASE_UNAVAILABLE
  - Login rate limit: 10 requests / 60 s per client IP
    (api/v1/auth.py — Depends(rate_limit("login", 10, 60))). A 500-request
    burst from ONE client IP will legitimately return ~490 x 429 unless
    the limit was raised on the target environment. This suite never
    disables or bypasses rate limiting — 429s are first-class results.
  - Refresh: POST /api/v1/auth/refresh {"refresh_token": ...} ->
             200 {access_token, token_type}
  - Identity: GET /api/v1/auth/me with "Authorization: Bearer <access>"
  - Workspace: GET /api/v1/workspace (authenticated)
  - Health: GET /health, GET /health/db, GET /ready (unauthenticated)
  - Server timing headers emitted by AccessLogMiddleware when
    REQUEST_TIMING_ENABLED=true (default):
        X-Response-Time: "<ms>ms"   total server-side wall time
        X-DB-Time:       "<ms>ms"   accumulated DB statement time
        X-DB-Queries:    "<n>"      statement count
        X-Ext-Time:      "<ms>ms"   external calls (only when >0)
        X-Request-ID:    correlation id

Everything here is import-safe and free of secrets — passwords/tokens
are never logged or written to artifacts.
"""

from __future__ import annotations

import asyncio
import csv
import json
import math
import os
import statistics
import time
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants — endpoint contract (do not invent; verified in backend/app)
# ---------------------------------------------------------------------------

LOGIN_PATH = "/api/v1/auth/login"
REFRESH_PATH = "/api/v1/auth/refresh"
ME_PATH = "/api/v1/auth/me"
WORKSPACE_PATH = "/api/v1/workspace"
HEALTH_PATHS = ("/health", "/health/db", "/ready")

TIMING_HEADERS = ("x-response-time", "x-db-time", "x-db-queries", "x-ext-time")

# Safety caps — hard ceilings regardless of CLI input.
MAX_CONCURRENCY = 1000
MAX_REQUESTS = 5000
DEFAULT_TIMEOUT_S = 30.0
DEFAULT_CONNECT_TIMEOUT_S = 10.0

RESULTS_DIR = Path(__file__).resolve().parent / "results"


# ---------------------------------------------------------------------------
# Outcome classification
# ---------------------------------------------------------------------------

# Expected, well-formed rejections — an auth deny is NOT a system failure.
OUTCOME_SUCCESS = "success"                    # 200 + valid AuthResponse
OUTCOME_AUTH_REJECTED = "auth_rejected"        # 401/403 w/ error body
OUTCOME_RATE_LIMITED = "rate_limited"          # 429
OUTCOME_VALIDATION = "validation_error"        # 422
OUTCOME_CLIENT_ERROR = "client_error_other"    # other 4xx
OUTCOME_SERVER_ERROR = "server_error"          # 5xx
OUTCOME_CONNECT_ERROR = "connect_error"        # TCP/TLS/DNS failure
OUTCOME_CONNECT_TIMEOUT = "connect_timeout"
OUTCOME_READ_TIMEOUT = "read_timeout"
OUTCOME_MALFORMED = "malformed_response"       # 200 but not AuthResponse
OUTCOME_CANCELLED = "cancelled"

FAILURE_OUTCOMES = {
    OUTCOME_SERVER_ERROR, OUTCOME_CONNECT_ERROR, OUTCOME_CONNECT_TIMEOUT,
    OUTCOME_READ_TIMEOUT, OUTCOME_MALFORMED,
}
EXPECTED_REJECT_OUTCOMES = {OUTCOME_AUTH_REJECTED, OUTCOME_RATE_LIMITED}


def classify_response(status_code: int, body: bytes | None,
                      expect_auth_response: bool = True) -> str:
    """Map an HTTP response to an outcome class."""
    if status_code == 200:
        if not expect_auth_response:
            return OUTCOME_SUCCESS
        try:
            payload = json.loads(body or b"")
        except (json.JSONDecodeError, UnicodeDecodeError):
            return OUTCOME_MALFORMED
        # AuthResponse contract: access_token + refresh_token + user + company
        if isinstance(payload, dict) and payload.get("access_token") \
                and payload.get("refresh_token") \
                and isinstance(payload.get("user"), dict):
            return OUTCOME_SUCCESS
        return OUTCOME_MALFORMED
    if status_code in (401, 403):
        return OUTCOME_AUTH_REJECTED
    if status_code == 429:
        return OUTCOME_RATE_LIMITED
    if status_code == 422:
        return OUTCOME_VALIDATION
    if 400 <= status_code < 500:
        return OUTCOME_CLIENT_ERROR
    if status_code >= 500:
        return OUTCOME_SERVER_ERROR
    return OUTCOME_CLIENT_ERROR


def classify_exception(exc: BaseException) -> str:
    """Map an httpx/asyncio exception to an outcome class."""
    import httpx

    if isinstance(exc, (asyncio.CancelledError,)):
        return OUTCOME_CANCELLED
    if isinstance(exc, httpx.ConnectTimeout):
        return OUTCOME_CONNECT_TIMEOUT
    if isinstance(exc, (httpx.ReadTimeout, httpx.WriteTimeout,
                      httpx.PoolTimeout, asyncio.TimeoutError, TimeoutError)):
        return OUTCOME_READ_TIMEOUT
    if isinstance(exc, httpx.ConnectError):
        return OUTCOME_CONNECT_ERROR
    return OUTCOME_CONNECT_ERROR


def error_summary(exc: BaseException) -> str:
    """One-line, secret-free description of a client-side failure."""
    name = type(exc).__name__
    msg = str(exc).splitlines()[0] if str(exc) else ""
    # Strip anything that could carry host credentials — keep it short.
    return f"{name}: {msg[:160]}".strip()


# ---------------------------------------------------------------------------
# Statistics — linear-interpolation percentiles (numpy 'linear' method)
# ---------------------------------------------------------------------------

def percentile(sorted_vals: list[float], p: float) -> float | None:
    """Percentile via linear interpolation on the sorted sample.

    Method: rank = (p/100)*(n-1); interpolate between floor/ceil ranks.
    Same convention as numpy.percentile(..., method='linear') and the
    common monitoring-stack convention. Requires sorted input.
    """
    n = len(sorted_vals)
    if n == 0:
        return None
    if n == 1:
        return sorted_vals[0]
    rank = (p / 100.0) * (n - 1)
    lo = math.floor(rank)
    hi = math.ceil(rank)
    if lo == hi:
        return sorted_vals[lo]
    frac = rank - lo
    return sorted_vals[lo] + frac * (sorted_vals[hi] - sorted_vals[lo])


def summarize_latencies(latencies_ms: list[float]) -> dict:
    """Full latency stats block for a set of request latencies (ms)."""
    s = sorted(latencies_ms)
    if not s:
        return {"count": 0}
    return {
        "count": len(s),
        "min_ms": round(s[0], 2),
        "max_ms": round(s[-1], 2),
        "mean_ms": round(statistics.fmean(s), 2),
        "p50_ms": round(percentile(s, 50), 2),
        "p90_ms": round(percentile(s, 90), 2),
        "p95_ms": round(percentile(s, 95), 2),
        "p99_ms": round(percentile(s, 99), 2),
        "stdev_ms": round(statistics.stdev(s), 2) if len(s) > 1 else 0.0,
    }


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class RequestRecord:
    """One measured request. NEVER carries secrets — the access_token
    field in the response is consumed to a boolean and discarded."""
    request_id: str
    seq: int
    account_label: str                    # e.g. "loadtest-001" — no password
    scheduled_offset_ms: float            # launch delay vs t0 (0 for burst)
    launched_offset_ms: float             # actual dispatch time vs t0
    outcome: str
    status_code: int | None = None
    latency_ms: float | None = None
    ttfb_ms: float | None = None
    response_bytes: int | None = None
    server_ms: float | None = None        # X-Response-Time
    db_ms: float | None = None            # X-DB-Time
    db_queries: int | None = None         # X-DB-Queries
    ext_ms: float | None = None           # X-Ext-Time
    pool_wait_ms: float | None = None     # X-DB-Pool-Time
    verify_ms: float | None = None        # X-Verify-Time (argon2 exec)
    verify_wait_ms: float | None = None   # X-Verify-Wait (queue wait)
    server_request_id: str | None = None  # X-Request-ID echo
    error_category: str | None = None
    error_summary: str | None = None
    got_access_token: bool = False
    got_refresh_token: bool = False
    concurrency_stage: int = 0
    finished_offset_ms: float = 0.0


@dataclass
class HealthSample:
    ts_utc: str
    phase: str                            # before | during | after
    path: str
    status_code: int | None
    latency_ms: float | None
    detail: str = ""                      # e.g. degraded component summary


@dataclass
class RunConfig:
    base_url: str
    environment: str                      # staging | production
    mode: str                             # unique_users | shared_user
    concurrency: int
    total_requests: int
    ramp_ms: int = 0                      # >0 = staged launch instead of burst
    warmup_requests: int = 0
    timeout_s: float = DEFAULT_TIMEOUT_S
    connect_timeout_s: float = DEFAULT_CONNECT_TIMEOUT_S
    abort_on_failure_rate: float = 0.95   # abort if failures exceed this share
    abort_after_min: int = 50             # ... evaluated after N completed
    progressive: bool = False
    stage_recover_s: float = 5.0
    run_id: str = field(default_factory=lambda: (
        datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        + "-" + uuid.uuid4().hex[:8]))


# ---------------------------------------------------------------------------
# Credential loading
# ---------------------------------------------------------------------------

def load_credentials(path: str | None, mode: str,
                     need: int) -> list[tuple[str, str]]:
    """Return [(identifier, password)] — never logged.

    Sources (first hit wins):
      1. JSON/CSV file at `path` or $LOADTEST_CREDENTIALS_FILE.
         JSON: [{"identifier": "...", "password": "..."}, ...]
         CSV : header row with identifier,password columns.
      2. Env for shared_user: LOADTEST_IDENTIFIER + LOADTEST_PASSWORD.
    """
    cred_file = path or os.environ.get("LOADTEST_CREDENTIALS_FILE")
    creds: list[tuple[str, str]] = []
    if cred_file:
        p = Path(cred_file)
        if not p.exists():
            raise FileNotFoundError(f"credentials file not found: {p}")
        if p.suffix.lower() == ".json":
            data = json.loads(p.read_text())
            creds = [(d["identifier"], d["password"]) for d in data]
        else:
            with p.open(newline="") as fh:
                for row in csv.DictReader(fh):
                    creds.append((row["identifier"], row["password"]))
    else:
        ident = os.environ.get("LOADTEST_IDENTIFIER")
        pw = os.environ.get("LOADTEST_PASSWORD")
        if ident and pw:
            creds = [(ident, pw)]

    if mode == "unique_users":
        if len(creds) < need:
            raise ValueError(
                f"unique_users mode needs >= {need} distinct accounts; "
                f"credentials source yielded {len(creds)}")
        # dedupe by identifier
        seen, uniq = set(), []
        for c in creds:
            if c[0] not in seen:
                seen.add(c[0])
                uniq.append(c)
        if len(uniq) < need:
            raise ValueError(
                f"only {len(uniq)} unique identifiers for {need} requests")
        return uniq[:need]
    # shared_user
    if not creds:
        raise ValueError(
            "no credentials: set LOADTEST_IDENTIFIER/LOADTEST_PASSWORD or "
            "--credentials-file / LOADTEST_CREDENTIALS_FILE")
    return [creds[0]] * need


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def parse_ms_header(value: str | None) -> float | None:
    """'123ms' -> 123.0 ; '123' -> 123.0 ; else None."""
    if not value:
        return None
    v = value.strip().rstrip("ms").strip()
    try:
        return float(v)
    except ValueError:
        return None


def make_client(cfg: RunConfig):
    """Shared AsyncClient — one pool sized to the requested concurrency so
    the client is never the bottleneck (limits >= concurrency)."""
    import httpx

    limits = httpx.Limits(
        max_connections=cfg.concurrency + 10,
        max_keepalive_connections=cfg.concurrency + 10,
    )
    timeout = httpx.Timeout(
        timeout=cfg.timeout_s,
        connect=cfg.connect_timeout_s,
    )
    return httpx.AsyncClient(
        base_url=cfg.base_url,
        limits=limits,
        timeout=timeout,
        follow_redirects=False,   # never silently chase redirects
        headers={"Accept": "application/json"},
    )


# ---------------------------------------------------------------------------
# Burst engine
# ---------------------------------------------------------------------------

class AbortRun(Exception):
    """Raised when the failure-rate threshold aborts the run."""


async def run_login_burst(cfg: RunConfig, creds: list[tuple[str, str]],
                          stage_label: int = 0,
                          abort_event: asyncio.Event | None = None,
                          release_event: asyncio.Event | None = None,
                          ) -> list[RequestRecord]:
    """Dispatch `cfg.total_requests` logins.

    Synchronized start: every worker is spawned, then all wait on
    `release_event` (or an internal one) so the burst leaves together.
    When cfg.ramp_ms > 0, worker i additionally sleeps
    i * ramp_ms / total before dispatch — a linear ramp for comparison.
    """
    import httpx  # noqa: F401 — ensures dependency error is local

    release = release_event or asyncio.Event()
    abort = abort_event or asyncio.Event()
    records: list[RequestRecord] = []
    done = 0
    failures = 0
    state = {"t0": None}

    async def worker(seq: int, client, ident: str, pw: str):
        nonlocal done, failures
        scheduled = (seq * cfg.ramp_ms / max(cfg.total_requests - 1, 1)
                     if cfg.ramp_ms else 0.0)
        await release.wait()
        if scheduled:
            await asyncio.sleep(scheduled / 1000.0)
        launched = (time.perf_counter() - state["t0"]) * 1000
        rec = RequestRecord(
            request_id=uuid.uuid4().hex[:12],
            seq=seq,
            account_label=ident.split("@")[0][:40],
            scheduled_offset_ms=round(scheduled, 2),
            launched_offset_ms=round(launched, 2),
            outcome=OUTCOME_CANCELLED,
            concurrency_stage=stage_label,
        )
        if abort.is_set():
            rec.outcome = OUTCOME_CANCELLED
            records.append(rec)
            return
        t_start = time.perf_counter()
        try:
            resp = await client.post(
                LOGIN_PATH,
                json={"identifier": ident, "password": pw},
            )
            elapsed = (time.perf_counter() - t_start) * 1000
            body = resp.content
            rec.status_code = resp.status_code
            rec.latency_ms = round(elapsed, 2)
            rec.response_bytes = len(body)
            rec.server_ms = parse_ms_header(resp.headers.get("x-response-time"))
            rec.db_ms = parse_ms_header(resp.headers.get("x-db-time"))
            dq = resp.headers.get("x-db-queries")
            rec.db_queries = int(dq) if dq and dq.isdigit() else None
            rec.ext_ms = parse_ms_header(resp.headers.get("x-ext-time"))
            rec.pool_wait_ms = parse_ms_header(
                resp.headers.get("x-db-pool-time"))
            rec.verify_ms = parse_ms_header(resp.headers.get("x-verify-time"))
            rec.verify_wait_ms = parse_ms_header(
                resp.headers.get("x-verify-wait"))
            rec.server_request_id = resp.headers.get("x-request-id")
            rec.outcome = classify_response(resp.status_code, body)
            if rec.outcome == OUTCOME_SUCCESS:
                payload = resp.json()
                rec.got_access_token = bool(payload.get("access_token"))
                rec.got_refresh_token = bool(payload.get("refresh_token"))
            else:
                try:
                    err = resp.json()
                    rec.error_category = (
                        err.get("code")
                        or (err.get("detail") or {}).get("code")
                        if isinstance(err, dict) else None)
                except Exception:
                    rec.error_category = None
                rec.error_summary = (resp.text or "")[:160].replace("\n", " ")
        except asyncio.CancelledError:
            rec.outcome = OUTCOME_CANCELLED
            rec.latency_ms = round((time.perf_counter() - t_start) * 1000, 2)
        except Exception as exc:  # noqa: BLE001 — classified, not re-raised
            rec.latency_ms = round((time.perf_counter() - t_start) * 1000, 2)
            rec.outcome = classify_exception(exc)
            rec.error_category = type(exc).__name__
            rec.error_summary = error_summary(exc)
        finally:
            rec.finished_offset_ms = round(
                (time.perf_counter() - state["t0"]) * 1000, 2)
            records.append(rec)
            done += 1
            if rec.outcome in FAILURE_OUTCOMES:
                failures += 1
            if (not abort.is_set()
                    and done >= cfg.abort_after_min
                    and failures / done > cfg.abort_on_failure_rate):
                abort.set()

    async with make_client(cfg) as client:
        state["t0"] = time.perf_counter()
        tasks = [
            asyncio.create_task(worker(i, client, *creds[i % len(creds)]))
            for i in range(cfg.total_requests)
        ]
        release.set()          # synchronized release of the whole burst
        await asyncio.gather(*tasks, return_exceptions=False)

    if abort.is_set() and failures:
        raise AbortRun(
            f"aborted: failure rate exceeded {cfg.abort_on_failure_rate:.0%} "
            f"after {done} requests")
    return records


# ---------------------------------------------------------------------------
# Health sampling — low frequency so monitoring never skews the test
# ---------------------------------------------------------------------------

async def sample_health(base_url: str, phase: str, interval_s: float = 2.0,
                        stop: asyncio.Event | None = None,
                        duration_s: float | None = None
                        ) -> list[HealthSample]:
    """Poll /health, /health/db, /ready at `interval_s` until `stop` is set
    or duration_s elapses. Unauthenticated, cheap, and clearly labelled.
    Anything not exposed by the target is recorded as unavailable."""
    import httpx

    samples: list[HealthSample] = []
    deadline = (time.perf_counter() + duration_s) if duration_s else None
    async with httpx.AsyncClient(base_url=base_url,
                                 timeout=5.0,
                                 follow_redirects=False) as client:
        while True:
            if stop and stop.is_set():
                break
            if deadline and time.perf_counter() >= deadline:
                break
            for path in HEALTH_PATHS:
                t0 = time.perf_counter()
                try:
                    r = await client.get(path)
                    lat = (time.perf_counter() - t0) * 1000
                    detail = ""
                    try:
                        body = r.json()
                        detail = ",".join(
                            f"{k}={v}" for k, v in body.items()
                            if k != "status")[:200]
                    except Exception:
                        pass
                    samples.append(HealthSample(
                        ts_utc=datetime.now(timezone.utc).isoformat(),
                        phase=phase, path=path,
                        status_code=r.status_code,
                        latency_ms=round(lat, 2), detail=detail))
                except Exception as exc:  # noqa: BLE001
                    samples.append(HealthSample(
                        ts_utc=datetime.now(timezone.utc).isoformat(),
                        phase=phase, path=path, status_code=None,
                        latency_ms=None,
                        detail=f"unavailable: {type(exc).__name__}"))
            await asyncio.sleep(interval_s)
    return samples


# ---------------------------------------------------------------------------
# Sustained-load engine — workers loop requests for a fixed duration, mixing
# logins with authenticated reads under load (not just post-burst).
# ---------------------------------------------------------------------------

READ_PATHS = (ME_PATH, WORKSPACE_PATH)


async def run_sustained(cfg: RunConfig, creds: list[tuple[str, str]],
                        duration_s: float, read_share: float = 0.0,
                        stage_label: int = 0) -> list[RequestRecord]:
    """Sustained phase: `cfg.concurrency` workers each issue requests back-
    to-back for `duration_s`. `read_share` (0..1) of workers perform
    authenticated reads (login once, then loop /auth/me + /workspace);
    the rest loop logins. Measures throughput *and* post-login endpoints
    while the system is under load — not only after it."""
    records: list[RequestRecord] = []
    deadline = time.perf_counter() + duration_s
    seq = 0

    async def do_request(client, method: str, path: str, *, token=None,
                         json_body=None, expect_auth=True,
                         label="", token_sink=None) -> RequestRecord:
        nonlocal seq
        my_seq = seq; seq += 1
        rec = RequestRecord(
            request_id=uuid.uuid4().hex[:12], seq=my_seq,
            account_label=label, scheduled_offset_ms=0,
            launched_offset_ms=0, outcome=OUTCOME_CANCELLED,
            concurrency_stage=stage_label)
        t0 = time.perf_counter()
        try:
            headers = {"Authorization": f"Bearer {token}"} if token else None
            if method == "GET":
                resp = await client.get(path, headers=headers)
            else:
                resp = await client.post(path, json=json_body)
            body = resp.content
            rec.status_code = resp.status_code
            rec.latency_ms = round((time.perf_counter() - t0) * 1000, 2)
            rec.response_bytes = len(body)
            rec.server_ms = parse_ms_header(resp.headers.get("x-response-time"))
            rec.db_ms = parse_ms_header(resp.headers.get("x-db-time"))
            dq = resp.headers.get("x-db-queries")
            rec.db_queries = int(dq) if dq and dq.isdigit() else None
            rec.ext_ms = parse_ms_header(resp.headers.get("x-ext-time"))
            rec.pool_wait_ms = parse_ms_header(
                resp.headers.get("x-db-pool-time"))
            rec.verify_ms = parse_ms_header(resp.headers.get("x-verify-time"))
            rec.verify_wait_ms = parse_ms_header(
                resp.headers.get("x-verify-wait"))
            rec.server_request_id = resp.headers.get("x-request-id")
            rec.outcome = classify_response(resp.status_code, body,
                                            expect_auth_response=expect_auth)
            if expect_auth and rec.outcome == OUTCOME_SUCCESS:
                p = resp.json()
                rec.got_access_token = bool(p.get("access_token"))
                rec.got_refresh_token = bool(p.get("refresh_token"))
                if token_sink is not None:
                    token_sink["token"] = p.get("access_token")
        except asyncio.CancelledError:
            rec.outcome = OUTCOME_CANCELLED
            rec.latency_ms = round((time.perf_counter() - t0) * 1000, 2)
        except Exception as exc:  # noqa: BLE001
            rec.latency_ms = round((time.perf_counter() - t0) * 1000, 2)
            rec.outcome = classify_exception(exc)
            rec.error_category = type(exc).__name__
            rec.error_summary = error_summary(exc)
        records.append(rec)
        return rec

    async def login_worker(client, cred):
        ident, pw = cred
        while time.perf_counter() < deadline:
            await do_request(client, "POST", LOGIN_PATH,
                             json_body={"identifier": ident, "password": pw},
                             expect_auth=True, label=ident.split("@")[0][:40])

    async def read_worker(client, cred):
        ident, pw = cred
        # One login to obtain an access token (held only in this closure —
        # never written to artifacts), then loop reads until the deadline.
        sink: dict = {}
        await do_request(client, "POST", LOGIN_PATH,
                         json_body={"identifier": ident, "password": pw},
                         expect_auth=True, label=ident.split("@")[0][:40],
                         token_sink=sink)
        token = sink.get("token")
        if not token:
            return
        i = 0
        while time.perf_counter() < deadline:
            await do_request(client, "GET", READ_PATHS[i % len(READ_PATHS)],
                             token=token, expect_auth=False,
                             label=ident.split("@")[0][:40])
            i += 1

    async with make_client(cfg) as client:
        workers = []
        n_read = int(cfg.concurrency * read_share)
        for i in range(cfg.concurrency):
            cred = creds[i % len(creds)]
            fn = read_worker if i < n_read else login_worker
            workers.append(asyncio.create_task(fn(client, cred)))
        await asyncio.gather(*workers)
    return records


# ---------------------------------------------------------------------------
# Resource monitors — passive observation only. Anything not reachable is
# recorded as 'unavailable'; nothing is fabricated.
# ---------------------------------------------------------------------------

async def sample_process(pid: int, interval_s: float,
                         stop: asyncio.Event) -> list[dict]:
    """CPU%/RSS of the server process tree via psutil (children included,
    so multi-worker uvicorn is covered). Local-host runs only."""
    try:
        import psutil
    except ImportError:
        return [{"ts_utc": datetime.now(timezone.utc).isoformat(),
                 "error": "unavailable: psutil not installed"}]
    samples: list[dict] = []
    try:
        root = psutil.Process(pid)
    except psutil.NoSuchProcess:
        return samples
    # Cache Process objects by PID — cpu_percent(None) measures since the
    # last call ON THAT OBJECT, so children discovered each tick must be
    # re-primed/reused or they always read 0.0.
    procs: dict[int, "psutil.Process"] = {pid: root}
    for p in procs.values():
        try:
            p.cpu_percent(None)
        except Exception:
            pass
    while not stop.is_set():
        cpu = rss = 0.0
        try:
            for child in root.children(recursive=True):
                if child.pid not in procs:
                    try:
                        child.cpu_percent(None)  # prime new child
                    except Exception:
                        pass
                    procs[child.pid] = child
            for cpid in [k for k in procs if k != pid]:
                if not procs[cpid].is_running():
                    del procs[cpid]
            for p in procs.values():
                try:
                    cpu += p.cpu_percent(None)
                    rss += p.memory_info().rss
                except Exception:
                    pass
            procs_n = len(procs)
            samples.append({
                "ts_utc": datetime.now(timezone.utc).isoformat(),
                "cpu_percent": round(cpu, 1),
                "rss_mb": round(rss / 1e6, 1),
                "n_processes": procs_n,
            })
        except psutil.NoSuchProcess:
            break
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval_s)
        except asyncio.TimeoutError:
            pass
    return samples


async def sample_pg(db_url: str, interval_s: float,
                    stop: asyncio.Event) -> list[dict]:
    """pg_stat_activity sampler — REAL connection counts as Postgres sees
    them (i.e. after the Supabase pooler). Counts by state and flags
    pooler-visible saturation without any app-side instrumentation."""
    import asyncpg
    samples: list[dict] = []
    try:
        # statement_cache_size=0 — required through transaction-mode
        # poolers (Supabase :6543); same constraint as app DB_POOLER_MODE.
        conn = await asyncpg.connect(db_url, timeout=5,
                                     statement_cache_size=0)
    except Exception as exc:
        return [{"ts_utc": datetime.now(timezone.utc).isoformat(),
                 "error": f"unavailable: {type(exc).__name__}"}]
    try:
        while not stop.is_set():
            try:
                rows = await conn.fetch(
                    "SELECT state, count(*) FROM pg_stat_activity "
                    "WHERE backend_type = 'client backend' GROUP BY state")
                samples.append({
                    "ts_utc": datetime.now(timezone.utc).isoformat(),
                    "connections": {r["state"] or "none": r["count"]
                                    for r in rows},
                })
            except Exception as exc:
                samples.append({"ts_utc": datetime.now(timezone.utc).isoformat(),
                                "error": type(exc).__name__})
            try:
                await asyncio.wait_for(stop.wait(), timeout=interval_s)
            except asyncio.TimeoutError:
                pass
    finally:
        await conn.close()
    return samples


def summarize_monitor(samples: list[dict]) -> dict:
    """Compact stats for summary.json — or 'unavailable'."""
    if not samples:
        return {"status": "unavailable"}
    if "error" in samples[0] and len(samples) == 1:
        return {"status": "unavailable", "reason": samples[0]["error"]}
    cpus = [s["cpu_percent"] for s in samples if "cpu_percent" in s]
    rss = [s["rss_mb"] for s in samples if "rss_mb" in s]
    conns = [sum(s["connections"].values())
             for s in samples if "connections" in s]
    out: dict = {"samples": len(samples)}
    if cpus:
        out["cpu_percent"] = {"mean": round(statistics.fmean(cpus), 1),
                              "max": max(cpus)}
        out["rss_mb"] = {"mean": round(statistics.fmean(rss), 1),
                         "max": max(rss)}
    if conns:
        out["pg_connections"] = {"mean": round(statistics.fmean(conns), 1),
                                 "max": max(conns)}
    return out


# ---------------------------------------------------------------------------
# Aggregation + artifacts
# ---------------------------------------------------------------------------

def aggregate(records: list[RequestRecord], cfg: RunConfig,
              wall_ms: float) -> dict:
    """Machine-readable summary — the content of summary.json."""
    n = len(records)
    lat = [r.latency_ms for r in records if r.latency_ms is not None]
    by_outcome: dict[str, int] = {}
    by_status: dict[str, int] = {}
    for r in records:
        by_outcome[r.outcome] = by_outcome.get(r.outcome, 0) + 1
        key = str(r.status_code) if r.status_code is not None else "no_response"
        by_status[key] = by_status.get(key, 0) + 1

    successes = by_outcome.get(OUTCOME_SUCCESS, 0)
    sys_failures = sum(by_outcome.get(o, 0) for o in FAILURE_OUTCOMES)
    expected_rejects = sum(by_outcome.get(o, 0) for o in EXPECTED_REJECT_OUTCOMES)

    server_times = [r.server_ms for r in records if r.server_ms is not None]
    db_times = [r.db_ms for r in records if r.db_ms is not None]
    db_queries = [r.db_queries for r in records if r.db_queries is not None]
    pool_waits = [r.pool_wait_ms for r in records if r.pool_wait_ms is not None]
    verify_times = [r.verify_ms for r in records if r.verify_ms is not None]
    verify_waits = [r.verify_wait_ms for r in records
                    if r.verify_wait_ms is not None]
    launch = sorted(r.launched_offset_ms for r in records)

    return {
        "run_id": cfg.run_id,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "environment": cfg.environment,
        "base_url": cfg.base_url,
        "mode": cfg.mode,
        "configuration": {
            "concurrency": cfg.concurrency,
            "total_requests": cfg.total_requests,
            "ramp_ms": cfg.ramp_ms,
            "timeout_s": cfg.timeout_s,
            "connect_timeout_s": cfg.connect_timeout_s,
        },
        "wall_time_ms": round(wall_ms, 2),
        "throughput_rps": round(n / (wall_ms / 1000), 2) if wall_ms else None,
        "achieved_launch_spread_ms": round(launch[-1] - launch[0], 2) if launch else None,
        "time_to_first_response_ms": round(
            min((r.finished_offset_ms for r in records), default=0), 2),
        "latency": summarize_latencies(lat),
        "server_side": {
            "x_response_time": summarize_latencies(server_times),
            "x_db_time": summarize_latencies(db_times),
            "x_db_pool_wait": summarize_latencies(pool_waits),
            "x_verify_time": summarize_latencies(verify_times),
            "x_verify_wait": summarize_latencies(verify_waits),
            "db_queries": {
                "count": len(db_queries),
                "mean": round(statistics.fmean(db_queries), 2) if db_queries else None,
                "max": max(db_queries) if db_queries else None,
            },
            "note": ("server_ms/db_ms are backend-reported values from "
                     "X-Response-Time / X-DB-Time headers — never derived "
                     "from client latency"),
        },
        "outcomes": by_outcome,
        "status_codes": by_status,
        "counts": {
            "attempted": n,
            "successful_logins": successes,
            "failed_logins": n - successes,
            "system_failures": sys_failures,
            "expected_rejections": expected_rejects,
            "http_429": by_outcome.get(OUTCOME_RATE_LIMITED, 0),
            "http_5xx": by_status.get("5xx", 0) or sum(
                v for k, v in by_status.items()
                if k.isdigit() and k.startswith("5")),
            "connect_errors": by_outcome.get(OUTCOME_CONNECT_ERROR, 0)
                + by_outcome.get(OUTCOME_CONNECT_TIMEOUT, 0),
            "timeouts": by_outcome.get(OUTCOME_READ_TIMEOUT, 0)
                + by_outcome.get(OUTCOME_CONNECT_TIMEOUT, 0),
            "malformed": by_outcome.get(OUTCOME_MALFORMED, 0),
        },
        "rates": {
            "success_rate": round(successes / n, 4) if n else None,
            "failure_rate": round((n - successes) / n, 4) if n else None,
            "system_failure_rate": round(sys_failures / n, 4) if n else None,
        },
        "monitoring": {
            "note": "metrics not exposed by the target are 'unavailable'",
        },
    }


def write_artifacts(outdir: Path, records: list[RequestRecord],
                    summary: dict, health: list[HealthSample]) -> dict[str, Path]:
    """summary.json + requests.csv + errors.csv + health.csv. Sanitized —
    no passwords, tokens, or auth headers anywhere."""
    outdir.mkdir(parents=True, exist_ok=True)
    paths: dict[str, Path] = {}

    p = outdir / "summary.json"
    p.write_text(json.dumps(summary, indent=2))
    paths["summary"] = p

    p = outdir / "requests.csv"
    with p.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow([
            "request_id", "seq", "account_label", "scheduled_offset_ms",
            "launched_offset_ms", "finished_offset_ms", "outcome",
            "status_code", "latency_ms", "ttfb_ms", "response_bytes",
            "server_ms", "db_ms", "db_queries", "ext_ms", "pool_wait_ms",
            "verify_ms", "verify_wait_ms",
            "server_request_id", "error_category", "concurrency_stage",
            "got_access_token", "got_refresh_token",
        ])
        for r in sorted(records, key=lambda r: r.seq):
            w.writerow([
                r.request_id, r.seq, r.account_label,
                r.scheduled_offset_ms, r.launched_offset_ms,
                r.finished_offset_ms, r.outcome, r.status_code,
                r.latency_ms, r.ttfb_ms, r.response_bytes,
                r.server_ms, r.db_ms, r.db_queries, r.ext_ms,
                r.pool_wait_ms, r.verify_ms, r.verify_wait_ms,
                r.server_request_id, r.error_category, r.concurrency_stage,
                r.got_access_token, r.got_refresh_token,
            ])
    paths["requests"] = p

    p = outdir / "errors.csv"
    with p.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["request_id", "seq", "status_code", "outcome",
                    "error_category", "error_summary", "finished_offset_ms"])
        for r in records:
            if r.outcome != OUTCOME_SUCCESS:
                w.writerow([r.request_id, r.seq, r.status_code, r.outcome,
                            r.error_category, r.error_summary,
                            r.finished_offset_ms])
    paths["errors"] = p

    if health:
        p = outdir / "health.csv"
        with p.open("w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["ts_utc", "phase", "path", "status_code",
                        "latency_ms", "detail"])
            for s in health:
                w.writerow([s.ts_utc, s.phase, s.path, s.status_code,
                            s.latency_ms, s.detail])
        paths["health"] = p

    return paths


def write_monitor_csv(outdir: Path, name: str, samples: list[dict]) -> Path | None:
    """Generic monitor dump (process or pg samples)."""
    if not samples:
        return None
    keys = sorted({k for s in samples for k in s})
    p = outdir / name
    with p.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=keys)
        w.writeheader()
        for s in samples:
            w.writerow({k: s.get(k) for k in keys})
    return p


# ---------------------------------------------------------------------------
# Safety / CLI plumbing shared by the runner scripts
# ---------------------------------------------------------------------------

def add_safety_args(parser) -> None:
    parser.add_argument("--base-url", required=True,
                        help="e.g. https://staging-api.example.com")
    parser.add_argument("--env", choices=["staging", "test", "production"],
                        required=True,
                        help="explicit environment designation (required)")
    parser.add_argument("--confirm-load-test", action="store_true",
                        help="required for any real run")
    parser.add_argument("--i-am-sure-production", action="store_true",
                        help="required ADDITIONALLY when --env=production")


def enforce_safety(cfg: RunConfig, confirm: bool, prod_override: bool) -> None:
    """Refuse unsafe invocations. Exits via SystemExit with a clear reason."""
    if not confirm:
        raise SystemExit(
            "refusing to run: pass --confirm-load-test to acknowledge this "
            "generates real authentication load")
    if cfg.environment == "production" and not prod_override:
        raise SystemExit(
            "refusing to run against production: this requires a separate "
            "--i-am-sure-production flag AND an agreed load window")
    if cfg.concurrency > MAX_CONCURRENCY:
        raise SystemExit(f"concurrency {cfg.concurrency} exceeds cap "
                         f"{MAX_CONCURRENCY}")
    if cfg.total_requests > MAX_REQUESTS:
        raise SystemExit(f"total_requests {cfg.total_requests} exceeds cap "
                         f"{MAX_REQUESTS}")


def verify_reachable(base_url: str) -> dict:
    """Pre-flight: GET /health. Returns the body or raises SystemExit."""
    import httpx
    try:
        r = httpx.get(f"{base_url.rstrip('/')}/health", timeout=5.0,
                      follow_redirects=False)
        return r.json() if r.headers.get("content-type", "").startswith(
            "application/json") else {"status_code": r.status_code}
    except Exception as exc:
        raise SystemExit(f"target unreachable at {base_url}/health: "
                         f"{type(exc).__name__} {exc}")
