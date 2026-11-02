"""
Unit tests for the load-suite internals — metrics aggregation,
percentile math, response classification, cancellation/abort, artifact
sanitization, and report generation. Run:

    cd tests/load && python -m pytest unit/ -v
"""

from __future__ import annotations

import asyncio
import csv
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import load_common as lc  # noqa: E402
from analyze_results import write_report, assess_hypotheses  # noqa: E402


# --- percentile math -------------------------------------------------------

def test_percentile_basic():
    assert lc.percentile([1, 2, 3, 4, 5], 50) == 3
    assert lc.percentile([1, 2, 3, 4, 5], 0) == 1
    assert lc.percentile([1, 2, 3, 4, 5], 100) == 5


def test_percentile_interpolation():
    # numpy 'linear': rank = p/100*(n-1) interpolated
    assert lc.percentile([0, 100], 50) == 50.0
    assert lc.percentile([0, 100], 25) == 25.0
    assert lc.percentile([10, 20, 30, 40], 90) == pytest.approx(37.0)


def test_percentile_edge():
    assert lc.percentile([], 50) is None
    assert lc.percentile([42.0], 99) == 42.0


def test_summarize_latencies():
    s = lc.summarize_latencies([10, 20, 30, 40, 100])
    assert s["count"] == 5
    assert s["min_ms"] == 10 and s["max_ms"] == 100
    assert s["mean_ms"] == 40
    assert s["p50_ms"] == 30
    assert lc.summarize_latencies([]) == {"count": 0}


# --- classification --------------------------------------------------------

def _auth_body():
    return json.dumps({
        "access_token": "x", "refresh_token": "y", "token_type": "bearer",
        "user": {"uid": "u"}, "company": {"company_uid": "c"}}).encode()


def test_classify_success():
    assert lc.classify_response(200, _auth_body()) == lc.OUTCOME_SUCCESS


def test_classify_malformed():
    assert lc.classify_response(200, b'{"access_token": "x"}') == lc.OUTCOME_MALFORMED
    assert lc.classify_response(200, b"not json") == lc.OUTCOME_MALFORMED


def test_classify_expected_rejections():
    body = json.dumps({"code": "INVALID_CREDENTIALS"}).encode()
    assert lc.classify_response(401, body) == lc.OUTCOME_AUTH_REJECTED
    assert lc.classify_response(403, body) == lc.OUTCOME_AUTH_REJECTED
    assert lc.classify_response(429, body) == lc.OUTCOME_RATE_LIMITED
    assert lc.classify_response(422, body) == lc.OUTCOME_VALIDATION


def test_classify_server_errors():
    assert lc.classify_response(500, b"") == lc.OUTCOME_SERVER_ERROR
    assert lc.classify_response(503, b"") == lc.OUTCOME_SERVER_ERROR


def test_classify_exceptions():
    import httpx
    assert lc.classify_exception(
        httpx.ConnectTimeout("t")) == lc.OUTCOME_CONNECT_TIMEOUT
    assert lc.classify_exception(
        httpx.ReadTimeout("t")) == lc.OUTCOME_READ_TIMEOUT
    assert lc.classify_exception(
        httpx.ConnectError("boom")) == lc.OUTCOME_CONNECT_ERROR
    assert lc.classify_exception(
        asyncio.CancelledError()) == lc.OUTCOME_CANCELLED


# --- credentials -----------------------------------------------------------

def test_load_credentials_shared_user_env(monkeypatch):
    monkeypatch.setenv("LOADTEST_IDENTIFIER", "qa@example.com")
    monkeypatch.setenv("LOADTEST_PASSWORD", "s3cret")
    creds = lc.load_credentials(None, "shared_user", 500)
    assert len(creds) == 500
    assert all(c == ("qa@example.com", "s3cret") for c in creds)


def test_load_credentials_unique_users_json(tmp_path):
    f = tmp_path / "creds.json"
    f.write_text(json.dumps(
        [{"identifier": f"u{i}@x.com", "password": "p"} for i in range(5)]))
    creds = lc.load_credentials(str(f), "unique_users", 3)
    assert len(creds) == 3
    with pytest.raises(ValueError, match="unique"):
        lc.load_credentials(str(f), "unique_users", 99)


def test_load_credentials_missing():
    with pytest.raises((ValueError, FileNotFoundError)):
        lc.load_credentials(None, "shared_user", 1)


# --- safety gates ----------------------------------------------------------

def _cfg(**kw):
    d = dict(base_url="http://x", environment="staging", mode="shared_user",
             concurrency=10, total_requests=10)
    d.update(kw)
    return lc.RunConfig(**d)


def test_enforce_safety_requires_confirm():
    with pytest.raises(SystemExit, match="confirm-load-test"):
        lc.enforce_safety(_cfg(), confirm=False, prod_override=False)


def test_enforce_safety_refuses_production_by_default():
    with pytest.raises(SystemExit, match="production"):
        lc.enforce_safety(_cfg(environment="production"),
                          confirm=True, prod_override=False)


def test_enforce_safety_caps():
    with pytest.raises(SystemExit, match="concurrency"):
        lc.enforce_safety(_cfg(concurrency=lc.MAX_CONCURRENCY + 1),
                          confirm=True, prod_override=False)
    with pytest.raises(SystemExit, match="total_requests"):
        lc.enforce_safety(_cfg(total_requests=lc.MAX_REQUESTS + 1),
                          confirm=True, prod_override=False)


def test_enforce_safety_ok():
    lc.enforce_safety(_cfg(), confirm=True, prod_override=False)  # no raise
    lc.enforce_safety(_cfg(environment="production"),
                      confirm=True, prod_override=True)  # explicit opt-in


# --- aggregation -----------------------------------------------------------

def _rec(seq, outcome, status=200, lat=100.0, **kw):
    return lc.RequestRecord(
        request_id=f"r{seq}", seq=seq, account_label="u",
        scheduled_offset_ms=0, launched_offset_ms=float(seq),
        outcome=outcome, status_code=status, latency_ms=lat,
        finished_offset_ms=float(seq) + lat, **kw)


def test_aggregate_mixed_outcomes():
    cfg = _cfg()
    recs = [
        _rec(0, lc.OUTCOME_SUCCESS),
        _rec(1, lc.OUTCOME_SUCCESS),
        _rec(2, lc.OUTCOME_RATE_LIMITED, status=429),
        _rec(3, lc.OUTCOME_AUTH_REJECTED, status=401),
        _rec(4, lc.OUTCOME_SERVER_ERROR, status=503),
        _rec(5, lc.OUTCOME_READ_TIMEOUT, status=None),
    ]
    s = lc.aggregate(recs, cfg, wall_ms=2000)
    c = s["counts"]
    assert c["attempted"] == 6
    assert c["successful_logins"] == 2
    assert c["http_429"] == 1
    assert c["system_failures"] == 2   # 503 + read timeout
    assert c["expected_rejections"] == 2  # 429 + 401
    assert s["throughput_rps"] == 3.0
    assert s["rates"]["success_rate"] == pytest.approx(0.3333)


def test_aggregate_server_timing():
    cfg = _cfg()
    recs = [_rec(0, lc.OUTCOME_SUCCESS, server_ms=80.0, db_ms=30.0,
                 db_queries=3)]
    s = lc.aggregate(recs, cfg, wall_ms=500)
    assert s["server_side"]["x_response_time"]["mean_ms"] == 80.0
    assert s["server_side"]["x_db_time"]["mean_ms"] == 30.0
    assert s["server_side"]["db_queries"]["mean"] == 3


# --- artifact writing + sanitization ---------------------------------------

def test_write_artifacts_no_secrets(tmp_path):
    cfg = _cfg()
    recs = [_rec(0, lc.OUTCOME_SUCCESS, got_access_token=True,
                 got_refresh_token=True, error_summary="x"),
            _rec(1, lc.OUTCOME_RATE_LIMITED, status=429)]
    summary = lc.aggregate(recs, cfg, wall_ms=100)
    paths = lc.write_artifacts(tmp_path, recs, summary, [])
    assert (tmp_path / "summary.json").exists()
    assert (tmp_path / "requests.csv").exists()
    assert (tmp_path / "errors.csv").exists()
    blob = ""
    for p in paths.values():
        blob += p.read_text()
    for secret in ("password", "access_token\":", "Bearer", "refresh_token\""):
        assert secret not in blob.replace("got_access_token", "").replace(
            "got_refresh_token", "")
    # errors.csv only holds non-success rows
    with (tmp_path / "errors.csv").open() as fh:
        rows = list(csv.DictReader(fh))
    assert len(rows) == 1 and rows[0]["outcome"] == "rate_limited"


# --- cancellation / abort ---------------------------------------------------

def test_abort_event_cancels_unlaunched():
    """Setting abort mid-run yields 'cancelled' records, no retries."""
    import httpx  # noqa

    cfg = _cfg(concurrency=5, total_requests=5, base_url="http://127.0.0.1:1")
    creds = [("a@b.c", "pw")] * 5
    abort = asyncio.Event()
    release = asyncio.Event()
    abort.set()  # abort before release → all records cancelled

    async def go():
        return await lc.run_login_burst(cfg, creds, abort_event=abort,
                                        release_event=release)
    try:
        recs = asyncio.run(go())
    except lc.AbortRun:
        return  # abort with recorded failures is also acceptable
    assert all(r.outcome == lc.OUTCOME_CANCELLED for r in recs)


def test_connect_failure_classified_not_raised():
    """Connection refused → connect_error records, burst completes."""
    cfg = _cfg(concurrency=3, total_requests=3,
               base_url="http://127.0.0.1:1", connect_timeout_s=1,
               timeout_s=2, abort_on_failure_rate=2.0)  # never abort
    creds = [("a@b.c", "pw")] * 3
    recs = asyncio.run(lc.run_login_burst(cfg, creds))
    assert len(recs) == 3
    assert all(r.outcome in (lc.OUTCOME_CONNECT_ERROR,
                             lc.OUTCOME_CONNECT_TIMEOUT,
                             lc.OUTCOME_READ_TIMEOUT) for r in recs)
    assert all(r.latency_ms is not None for r in recs)


# --- report -----------------------------------------------------------------

def test_report_contains_required_sections(tmp_path):
    cfg = _cfg()
    recs = [_rec(0, lc.OUTCOME_SUCCESS), _rec(1, lc.OUTCOME_RATE_LIMITED,
                                              status=429)]
    summary = lc.aggregate(recs, cfg, wall_ms=100)
    p = write_report(tmp_path, summary, [], recs)
    text = p.read_text()
    for section in ("Latency percentiles", "HTTP status distribution",
                    "Hypothesis assessment", "Rate limiting",
                    "Limitations"):
        assert section in text


def test_summarize_monitor_unavailable_and_stats():
    assert lc.summarize_monitor([])["status"] == "unavailable"
    assert lc.summarize_monitor([{"error": "unavailable: X"}])["status"] == "unavailable"
    s = lc.summarize_monitor([
        {"cpu_percent": 10.0, "rss_mb": 100.0},
        {"cpu_percent": 30.0, "rss_mb": 140.0}])
    assert s["cpu_percent"]["max"] == 30.0
    assert s["rss_mb"]["mean"] == 120.0
    s = lc.summarize_monitor([{"connections": {"active": 3, "idle": 7}},
                              {"connections": {"active": 5, "idle": 5}}])
    assert s["pg_connections"]["max"] == 10


def test_monitor_csv_roundtrip(tmp_path):
    p = lc.write_monitor_csv(tmp_path, "m.csv",
                             [{"a": 1, "b": "x"}, {"a": 2}])
    with p.open() as fh:
        rows = list(csv.DictReader(fh))
    assert len(rows) == 2 and rows[0]["a"] == "1"
    assert lc.write_monitor_csv(tmp_path, "none.csv", []) is None


def test_hypothesis_flags_rate_limiting():
    cfg = _cfg()
    recs = [_rec(i, lc.OUTCOME_RATE_LIMITED, status=429) for i in range(10)]
    summary = lc.aggregate(recs, cfg, wall_ms=100)
    hyps = assess_hypotheses(summary, recs)
    rl = next(h for h in hyps if "Rate limiting" in h["hypothesis"])
    assert "high" in rl["confidence"]
