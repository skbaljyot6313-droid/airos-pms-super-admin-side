"""
Analysis + reporting for AiROS PMS load runs.

Used two ways:
  1. imported by test_concurrent_login.py / test_post_login_stability.py
     (write_charts / write_report) right after a run;
  2. standalone: regenerate artifacts from an existing requests.csv —
         python analyze_results.py --outdir results/<run_id>

Charts require matplotlib; when it is not installed, chart files are
skipped and the report says so — no fabricated images.
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from pathlib import Path

import load_common as lc


# ---------------------------------------------------------------------------
# Charts
# ---------------------------------------------------------------------------

def _mpl():
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        return plt
    except ImportError:
        return None


def write_charts(outdir: Path, records: list[lc.RequestRecord],
                 summary: dict) -> dict[str, Path]:
    """latency_histogram.png, latency_over_time.png, and
    concurrency_comparison.png when multiple stages ran."""
    plt = _mpl()
    paths: dict[str, Path] = {}
    if plt is None:
        return paths

    lats = [r.latency_ms for r in records if r.latency_ms is not None]
    if lats:
        fig, ax = plt.subplots(figsize=(9, 5))
        ax.hist(lats, bins=min(60, max(10, len(lats) // 5)),
                color="#386641", edgecolor="white")
        ax.set_xlabel("latency (ms)")
        ax.set_ylabel("requests")
        ax.set_title(f"Login latency distribution — run {summary['run_id']}")
        fig.tight_layout()
        p = outdir / "latency_histogram.png"
        fig.savefig(p, dpi=120)
        plt.close(fig)
        paths["latency_histogram"] = p

    timed = sorted((r for r in records if r.latency_ms is not None),
                   key=lambda r: r.finished_offset_ms)
    if timed:
        fig, ax = plt.subplots(figsize=(10, 5))
        ax.scatter([r.finished_offset_ms for r in timed],
                   [r.latency_ms for r in timed],
                   s=8, alpha=0.5,
                   c=["#A32A2A" if r.outcome != lc.OUTCOME_SUCCESS
                      else "#386641" for r in timed])
        ax.set_xlabel("elapsed since burst start (ms)")
        ax.set_ylabel("latency (ms)")
        ax.set_title("Latency over time (red = non-success)")
        fig.tight_layout()
        p = outdir / "latency_over_time.png"
        fig.savefig(p, dpi=120)
        plt.close(fig)
        paths["latency_over_time"] = p

    stages: dict[int, list[lc.RequestRecord]] = defaultdict(list)
    for r in records:
        stages[r.concurrency_stage].append(r)
    if len(stages) > 1:
        xs, p50, p99, ok_rate = [], [], [], []
        for stage in sorted(stages):
            rs = stages[stage]
            l = sorted(r.latency_ms for r in rs if r.latency_ms is not None)
            xs.append(stage)
            p50.append(lc.percentile(l, 50) or 0)
            p99.append(lc.percentile(l, 99) or 0)
            ok_rate.append(
                sum(r.outcome == lc.OUTCOME_SUCCESS for r in rs) / len(rs))
        fig, (a1, a2) = plt.subplots(2, 1, figsize=(9, 7), sharex=True)
        a1.plot(xs, p50, marker="o", label="p50")
        a1.plot(xs, p99, marker="o", label="p99", color="#A32A2A")
        a1.set_ylabel("latency (ms)")
        a1.legend()
        a2.plot(xs, [v * 100 for v in ok_rate], marker="o", color="#386641")
        a2.set_ylabel("success rate (%)")
        a2.set_xlabel("concurrency stage")
        a2.set_ylim(0, 105)
        fig.suptitle("Latency + success rate by concurrency")
        fig.tight_layout()
        p = outdir / "concurrency_comparison.png"
        fig.savefig(p, dpi=120)
        plt.close(fig)
        paths["concurrency_comparison"] = p

    return paths


# ---------------------------------------------------------------------------
# Diagnostic hypotheses — evidence-based, never claimed as root cause
# ---------------------------------------------------------------------------

def assess_hypotheses(summary: dict, records: list[lc.RequestRecord]) -> list[dict]:
    """Rate each known bottleneck hypothesis from OBSERVED data only.
    Each entry states evidence seen, evidence missing, confidence, and the
    next measurement that would confirm or reject it."""
    counts = summary["counts"]
    n = max(counts["attempted"], 1)
    lat = summary.get("latency") or {}
    srv = summary.get("server_side") or {}
    db = (srv.get("x_db_time") or {})
    srt = (srv.get("x_response_time") or {})
    out = summary.get("outcomes") or {}

    p99 = lat.get("p99_ms") or 0
    mean_srv = srt.get("mean_ms")
    mean_db = db.get("mean_ms")
    mean_lat = lat.get("mean_ms") or 0
    dbq_mean = (db.get("db_queries") or {}).get("mean") \
        or (summary.get("server_side", {}).get("db_queries") or {}).get("mean")

    hyps = []

    rate_limited_share = counts["http_429"] / n
    hyps.append({
        "hypothesis": "Rate limiting (login scope: 10 req / 60 s / client IP)",
        "evidence": (f"{counts['http_429']}/{n} responses were HTTP 429 "
                     f"({rate_limited_share:.0%}). Login is limited to "
                     "10/min/IP in api/v1/auth.py — a single-IP burst is "
                     "expected to be mostly 429."),
        "confidence": ("high — direct observation" if rate_limited_share > 0.05
                       else "low — few/no 429s observed"),
        "next": ("Re-run from many client IPs, or with an authorized "
                 "staging-only limit override, to measure raw auth cost."),
    })

    timeouts = counts["timeouts"] + counts["connect_errors"]
    hyps.append({
        "hypothesis": "SQLAlchemy pool exhaustion / acquisition queueing "
                      "(pool_size=5, max_overflow=5, pool_timeout=30s)",
        "evidence": (f"{timeouts} timeout/connect failures; "
                     f"p99={p99}ms vs server-side mean={mean_srv}ms. "
                     "A large client-latency vs server-time gap is "
                     "consistent with pool queueing, but not proof."),
        "missing": "Pool checkout wait metrics, asyncpg QueuePool stats, "
                   "pg_stat_activity counts during the burst.",
        "confidence": ("medium" if (timeouts > 0 or (mean_srv and mean_lat > 3 * mean_srv))
                       else "low"),
        "next": "Instrument engine.pool status during a staged run; "
                "correlate p99 jump with pool saturation.",
    })

    hyps.append({
        "hypothesis": "Supabase/pgbouncer pool exhaustion (EMAXCONNSESSION)",
        "evidence": ("No client-side visibility into pooler rejections; "
                     "they would surface as 503 DATABASE_UNAVAILABLE or "
                     f"connect timeouts. 5xx={counts['http_5xx']}, "
                     f"connect_errors={counts['connect_errors']}."),
        "missing": "Supabase pooler logs / pg_stat_activity; whether the "
                   "deployed URL targets session or transaction pooling.",
        "confidence": "indeterminate from client side",
        "next": "Check Supabase dashboard 'pooler errors' and DB "
                "connection count graphs for the run window.",
    })

    db_share = (mean_db / mean_srv) if (mean_db and mean_srv) else None
    hyps.append({
        "hypothesis": "Excessive DB round trips in auth path "
                      "(user lookup + last_login update + refresh insert "
                      "+ commit)",
        "evidence": (f"X-DB-Queries mean={dbq_mean}; "
                     f"X-DB-Time mean={mean_db}ms "
                     f"({f'{db_share:.0%} of server time' if db_share else 'share n/a'})."),
        "missing": "Per-statement breakdown; whether remote-DB RTT "
                   "dominates statement time.",
        "confidence": ("medium" if db_share and db_share > 0.6 else "low"),
        "next": "Enable SQL_ECHO on staging for one login; count statements.",
    })

    cpu_bound = (mean_srv is not None and mean_db is not None
                 and mean_srv - mean_db > 100)
    hyps.append({
        "hypothesis": "Argon2id verification CPU saturation "
                      "(memory-hard verify inside the event loop)",
        "evidence": (f"server_ms mean={mean_srv} vs db_ms mean={mean_db} — "
                     f"non-DB server time "
                     f"≈{round(mean_srv - mean_db, 1) if mean_srv and mean_db else 'n/a'}ms "
                     "covers argon2 verify + JWT + serialization."),
        "missing": "API process CPU% during the burst; worker count.",
        "confidence": ("medium — argon2 is intentionally expensive and runs "
                       "on the event loop" if cpu_bound else "low"),
        "next": "Sample container CPU during the run; if pinned at 100% "
                "with rising p99, argon2/CPU is the limiter.",
    })

    hyps.append({
        "hypothesis": "JWT/refresh-token write contention "
                      "(refresh_tokens insert + users.last_login update)",
        "evidence": "Login commits one transaction with two writes. Lock "
                    "contention would appear as 5xx or elevated db_ms.",
        "missing": "pg_locks / deadlocks during the window.",
        "confidence": "low — writes are per-user rows",
        "next": "Check DB deadlock/lock-wait metrics if db_ms spikes.",
    })

    hyps.append({
        "hypothesis": "Redis contention / rate-limit backend latency",
        "evidence": ("Redis is used for rate limiting when REDIS_URL is "
                     "set; limiter fails open on Redis errors. X-Ext-Time "
                     "captures Redis call time when present."),
        "missing": "Whether target runs Redis; X-Ext-Time values.",
        "confidence": "low",
        "next": "Confirm REDIS_URL on target; watch X-Ext-Time header "
                "distribution.",
    })

    return hyps


# ---------------------------------------------------------------------------
# report.md
# ---------------------------------------------------------------------------

def write_report(outdir: Path, summary: dict,
                 health: list[lc.HealthSample],
                 records: list[lc.RequestRecord] | None = None,
                 stability: dict | None = None) -> Path:
    records = records or []
    lat = summary.get("latency") or {}
    c = summary["counts"]
    r = summary["rates"]

    def f(v, unit="ms"):
        return f"{v}{unit}" if v is not None else "n/a"

    lines = [
        f"# AiROS PMS — Concurrent Login Load Test",
        f"",
        f"- **Run ID**: `{summary['run_id']}`",
        f"- **Generated (UTC)**: {summary['generated_at_utc']}",
        f"- **Target**: `{summary['base_url']}` (env: **{summary['environment']}**)",
        f"- **Mode**: {summary['mode']}",
        f"- **Wall time**: {f(summary['wall_time_ms'])}",
        f"- **Throughput**: {summary['throughput_rps']} req/s",
        f"- **Launch spread**: {f(summary['achieved_launch_spread_ms'])} "
        f"(all-request dispatch window — measures achieved simultaneity)",
        f"",
        f"## Configuration",
        f"",
        f"| param | value |",
        f"|---|---|",
        f"| concurrency | {summary['configuration']['concurrency']} |",
        f"| total requests | {summary['configuration']['total_requests']} |",
        f"| ramp | {summary['configuration']['ramp_ms']} ms |",
        f"| timeout | {summary['configuration']['timeout_s']} s "
        f"(connect {summary['configuration']['connect_timeout_s']} s) |",
        f"",
        f"## Results summary",
        f"",
        f"| metric | value |",
        f"|---|---|",
        f"| attempted | {c['attempted']} |",
        f"| successful logins | {c['successful_logins']} |",
        f"| failed (all) | {c['failed_logins']} |",
        f"| success rate | {r['success_rate']} |",
        f"| system failures (5xx/conn/timeout/malformed) | {c['system_failures']} |",
        f"| expected rejections (401/403/429) | {c['expected_rejections']} |",
        f"| HTTP 429 | {c['http_429']} |",
        f"| HTTP 5xx | {c['http_5xx']} |",
        f"| connect errors | {c['connect_errors']} |",
        f"| timeouts | {c['timeouts']} |",
        f"| malformed responses | {c['malformed']} |",
        f"",
        f"## Latency percentiles",
        f"",
        f"| p50 | p90 | p95 | p99 | mean | min | max | stdev |",
        f"|---|---|---|---|---|---|---|---|",
        f"| {f(lat.get('p50_ms'))} | {f(lat.get('p90_ms'))} | "
        f"{f(lat.get('p95_ms'))} | {f(lat.get('p99_ms'))} | "
        f"{f(lat.get('mean_ms'))} | {f(lat.get('min_ms'))} | "
        f"{f(lat.get('max_ms'))} | {f(lat.get('stdev_ms'))} |",
        f"",
        f"Percentile method: linear interpolation (numpy 'linear').",
        f"",
        f"## HTTP status distribution",
        f"",
        "| status | count |", "|---|---|",
    ]
    for code, n in sorted(summary.get("status_codes", {}).items()):
        lines.append(f"| {code} | {n} |")

    srv = summary.get("server_side") or {}
    lines += [
        "",
        "## Backend-reported timing (X-Response-Time / X-DB-Time headers)",
        "",
        f"- server time: {json.dumps(srv.get('x_response_time'))}",
        f"- db time: {json.dumps(srv.get('x_db_time'))}",
        f"- db queries: {json.dumps(srv.get('db_queries'))}",
        f"- note: {srv.get('note', '')}",
        "",
        "## Health samples",
        "",
    ]
    if health:
        by_path = defaultdict(list)
        for s in health:
            by_path[s.path].append(s)
        for path, ss in by_path.items():
            ok = sum(1 for s in ss if s.status_code and s.status_code < 500)
            lines.append(
                f"- `{path}`: {ok}/{len(ss)} samples healthy "
                f"(phases: {sorted(set(s.phase for s in ss))})")
    else:
        lines.append("- `unavailable` — health sampling disabled or failed")

    lines += ["", "## Hypothesis assessment", ""]
    for h in assess_hypotheses(summary, records):
        lines += [
            f"### {h['hypothesis']}",
            f"- **Evidence observed**: {h['evidence']}",
            f"- **Evidence missing**: {h.get('missing', '—')}",
            f"- **Confidence**: {h['confidence']}",
            f"- **Next measurement**: {h['next']}",
            "",
        ]

    if stability:
        lines += ["## Post-login stability", "",
                  "```json", json.dumps(stability, indent=2), "```", ""]

    lines += [
        "## Limitations",
        "",
        "- Client-side measurements only; no server CPU/memory/pool "
        "internals unless separately observed.",
        "- 429s reflect the per-IP login rate limit (10/min) — a "
        "single-source burst cannot measure unthrottled auth capacity.",
        "- No automatic root-cause claims: correlations above are "
        "hypotheses requiring the listed next measurements.",
        "",
    ]

    p = outdir / "report.md"
    p.write_text("\n".join(lines))
    return p


# ---------------------------------------------------------------------------
# Standalone regeneration from requests.csv
# ---------------------------------------------------------------------------

def _records_from_csv(path: Path) -> list[lc.RequestRecord]:
    recs = []
    with path.open(newline="") as fh:
        for row in csv.DictReader(fh):
            def num(k):
                v = row.get(k)
                return float(v) if v not in (None, "") else None
            recs.append(lc.RequestRecord(
                request_id=row["request_id"], seq=int(row["seq"]),
                account_label=row["account_label"],
                scheduled_offset_ms=num("scheduled_offset_ms") or 0,
                launched_offset_ms=num("launched_offset_ms") or 0,
                finished_offset_ms=num("finished_offset_ms") or 0,
                outcome=row["outcome"],
                status_code=int(row["status_code"]) if row["status_code"] else None,
                latency_ms=num("latency_ms"), ttfb_ms=num("ttfb_ms"),
                response_bytes=num("response_bytes"),
                server_ms=num("server_ms"), db_ms=num("db_ms"),
                db_queries=num("db_queries"), ext_ms=num("ext_ms"),
                server_request_id=row.get("server_request_id"),
                error_category=row.get("error_category"),
                concurrency_stage=int(row.get("concurrency_stage") or 0),
            ))
    return recs


def main() -> int:
    ap = argparse.ArgumentParser(description="Regenerate load-test artifacts")
    ap.add_argument("--outdir", required=True,
                    help="results dir containing requests.csv")
    args = ap.parse_args()
    outdir = Path(args.outdir)
    records = _records_from_csv(outdir / "requests.csv")
    summary = json.loads((outdir / "summary.json").read_text())
    charts = write_charts(outdir, records, summary)
    print(f"charts: {list(charts) or 'skipped (matplotlib not installed)'}")
    write_report(outdir, summary, [], records)
    print(f"report: {outdir / 'report.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
