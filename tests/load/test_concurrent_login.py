"""
Concurrent login load test — AiROS PMS.

Runs a synchronized burst of POST /api/v1/auth/login requests (default
500) against an explicitly designated environment, plus optional
progressive stages (1/10/25/50/100/250/500) to locate the degradation
knee.

This is a RUNNER script (python test_concurrent_login.py ...), not a
pytest unit test — `__test__ = False` prevents collection.

Examples
--------
# Smoke test — 3 requests, burst mode
python test_concurrent_login.py --base-url http://localhost:8000 \
    --env test --confirm-load-test --mode unique_users \
    --credentials-file credentials.json --requests 3 --concurrency 3

# The headline test — 500 concurrent logins (staging)
python test_concurrent_login.py --base-url https://staging.example.com \
    --env staging --confirm-load-test --mode unique_users \
    --credentials-file credentials.json --requests 500 --concurrency 500

# Progressive stages — locate the knee
python test_concurrent_login.py ... --progressive

# Ramp comparison — 500 requests spread over 5 s instead of a burst
python test_concurrent_login.py ... --ramp-ms 5000
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import load_common as lc  # noqa: E402

__test__ = False  # not a pytest module

PROGRESSIVE_STAGES = (1, 10, 25, 50, 100, 250, 500)


def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="AiROS PMS concurrent-login load test")
    lc.add_safety_args(p)
    p.add_argument("--mode", choices=["unique_users", "shared_user"],
                   default="unique_users")
    p.add_argument("--credentials-file", default=None,
                   help="JSON/CSV with identifier,password — or set "
                        "LOADTEST_CREDENTIALS_FILE / LOADTEST_IDENTIFIER+"
                        "LOADTEST_PASSWORD")
    p.add_argument("--requests", type=int, default=500,
                   help="total login requests (default 500)")
    p.add_argument("--concurrency", type=int, default=500,
                   help="parallel workers (default 500)")
    p.add_argument("--ramp-ms", type=int, default=0,
                   help=">0 spreads launches linearly over N ms")
    p.add_argument("--warmup", type=int, default=0,
                   help="unmeasured warm-up requests before the burst")
    p.add_argument("--timeout-s", type=float, default=lc.DEFAULT_TIMEOUT_S)
    p.add_argument("--connect-timeout-s", type=float,
                   default=lc.DEFAULT_CONNECT_TIMEOUT_S)
    p.add_argument("--progressive", action="store_true",
                   help="run staged concurrency sweep AFTER the main burst")
    p.add_argument("--only-progressive", action="store_true",
                   help="skip the main burst; run only the sweep")
    p.add_argument("--stage-recover-s", type=float, default=5.0)
    p.add_argument("--sustained-s", type=float, default=0.0,
                   help="after the burst: hold `concurrency` workers issuing "
                        "requests for N seconds (sustained-load phase)")
    p.add_argument("--read-share", type=float, default=0.0,
                   help="fraction (0..1) of sustained workers doing "
                        "authenticated reads (/auth/me + /workspace) "
                        "instead of logins — post-login under load")
    p.add_argument("--server-pid", type=int, default=None,
                   help="local server PID — enables CPU/RSS sampling "
                        "(psutil; children included → covers multi-worker)")
    p.add_argument("--db-url", default=None,
                   help="postgres:// URL for pg_stat_activity sampling "
                        "(or set LOADTEST_DB_URL)")
    p.add_argument("--abort-failure-rate", type=float, default=0.95,
                   help="abort when system-failure share exceeds this "
                        "(evaluated after 50 completions)")
    p.add_argument("--no-health-sampling", action="store_true")
    p.add_argument("--outdir", default=None,
                   help="default tests/load/results/<run_id>")
    return p.parse_args(argv)


async def _warmup(cfg: lc.RunConfig, creds) -> None:
    """Unmeasured sequential logins — primes connections/pools so the
    measured burst isn't dominated by first-touch TLS/argon2 costs."""
    import httpx
    async with lc.make_client(cfg) as client:
        for i in range(cfg.warmup_requests):
            ident, pw = creds[i % len(creds)]
            try:
                await client.post(lc.LOGIN_PATH,
                                  json={"identifier": ident, "password": pw})
            except Exception:
                pass  # warm-up results are excluded by design


async def main_async(args) -> int:
    cfg = lc.RunConfig(
        base_url=args.base_url.rstrip("/"),
        environment=args.env,
        mode=args.mode,
        concurrency=args.concurrency,
        total_requests=args.requests,
        ramp_ms=args.ramp_ms,
        warmup_requests=args.warmup,
        timeout_s=args.timeout_s,
        connect_timeout_s=args.connect_timeout_s,
        abort_on_failure_rate=args.abort_failure_rate,
        progressive=args.progressive or args.only_progressive,
        stage_recover_s=args.stage_recover_s,
    )
    lc.enforce_safety(cfg, args.confirm_load_test, args.i_am_sure_production)

    health = lc.verify_reachable(cfg.base_url)
    print(f"[pre-flight] {cfg.base_url}/health -> {health}")

    creds = lc.load_credentials(args.credentials_file, cfg.mode,
                                cfg.total_requests)
    print(f"[credentials] {cfg.mode}: {len(creds)} slot(s) loaded "
          f"(secrets never logged)")

    outdir = Path(args.outdir) if args.outdir else lc.RESULTS_DIR / cfg.run_id
    outdir.mkdir(parents=True, exist_ok=True)

    if args.mode == "shared_user":
        print("[note] shared_user mode: repeated logins may create many "
              "refresh-token rows for one account; 429s are expected past "
              "the per-IP login rate limit (10/min).")

    all_records: list[lc.RequestRecord] = []
    health_samples: list[lc.HealthSample] = []
    monitor_tasks = []
    proc_samples: list[dict] = []
    pg_samples: list[dict] = []
    stop_monitors = asyncio.Event()
    health_task = None
    if not args.no_health_sampling:
        health_task = asyncio.create_task(
            lc.sample_health(cfg.base_url, phase="during",
                             interval_s=2.0, stop=stop_monitors))
        all_health = await lc.sample_health(  # one baseline pass
            cfg.base_url, phase="before", duration_s=0.1)
        health_samples.extend(all_health)
    if args.server_pid:
        monitor_tasks.append(("proc", asyncio.create_task(lc.sample_process(
            args.server_pid, interval_s=1.0, stop=stop_monitors))))
    db_url = args.db_url or os.environ.get("LOADTEST_DB_URL")
    if db_url:
        monitor_tasks.append(("pg", asyncio.create_task(lc.sample_pg(
            db_url, interval_s=1.0, stop=stop_monitors))))

    try:
        if cfg.warmup_requests:
            print(f"[warmup] {cfg.warmup_requests} unmeasured logins...")
            await _warmup(cfg, creds)

        aborted = None
        if not args.only_progressive:
            print(f"[burst] {cfg.total_requests} logins @ concurrency "
                  f"{cfg.concurrency} (ramp {cfg.ramp_ms} ms)...")
            t0 = time.perf_counter()
            try:
                recs = await lc.run_login_burst(cfg, creds, stage_label=cfg.concurrency)
            except lc.AbortRun as exc:
                aborted = str(exc)
                recs = []
            wall_ms = (time.perf_counter() - t0) * 1000
            all_records.extend(recs)
            burst_summary = lc.aggregate(recs, cfg, wall_ms) if recs else {}
            if aborted:
                print(f"[burst] ABORTED — {aborted}")
                burst_summary["aborted"] = aborted

        if cfg.progressive:
            for stage in PROGRESSIVE_STAGES:
                if stage > cfg.concurrency:
                    break
                stage_cfg = lc.RunConfig(
                    **{**cfg.__dict__, "concurrency": stage,
                       "total_requests": stage})
                print(f"[stage] concurrency={stage} ...")
                t0 = time.perf_counter()
                try:
                    recs = await lc.run_login_burst(
                        stage_cfg, creds, stage_label=stage)
                    all_records.extend(recs)
                    ok = sum(r.outcome == lc.OUTCOME_SUCCESS for r in recs)
                    lats = [r.latency_ms for r in recs
                            if r.latency_ms is not None]
                    s = lc.summarize_latencies(lats)
                    print(f"        ok={ok}/{len(recs)} "
                          f"p50={s.get('p50_ms')}ms p99={s.get('p99_ms')}ms "
                          f"wall={(time.perf_counter()-t0)*1000:.0f}ms")
                except lc.AbortRun as exc:
                    print(f"        stage aborted: {exc}")
                    break
                if stage != PROGRESSIVE_STAGES[-1]:
                    await asyncio.sleep(cfg.stage_recover_s)

        if args.sustained_s > 0:
            print(f"[sustained] {cfg.concurrency} workers for "
                  f"{args.sustained_s}s (read_share={args.read_share})...")
            recs = await lc.run_sustained(
                cfg, creds, duration_s=args.sustained_s,
                read_share=args.read_share, stage_label=-1)
            all_records.extend(recs)
            ok = sum(r.outcome == lc.OUTCOME_SUCCESS for r in recs)
            reads = [r for r in recs if r.latency_ms is not None]
            print(f"        {len(recs)} requests, {ok} successes, "
                  f"effective rps={len(recs)/args.sustained_s:.1f}")

        # post-burst recovery snapshot
        if not args.no_health_sampling:
            health_samples.extend(await lc.sample_health(
                cfg.base_url, phase="after", duration_s=4.0))
    finally:
        stop_monitors.set()
        if health_task:
            health_samples.extend(await health_task)
        for name, t in monitor_tasks:
            try:
                res = await t
            except Exception as exc:  # monitor failure must not lose results
                res = [{"error": f"monitor failed: {type(exc).__name__}"}]
            (proc_samples if name == "proc" else pg_samples).extend(res)

    # ---- artifacts ------------------------------------------------------
    wall_ms = (max((r.finished_offset_ms for r in all_records), default=0))
    summary = lc.aggregate(all_records, cfg, wall_ms)
    summary["monitoring"]["health_samples"] = len(health_samples)
    summary["monitoring"]["process"] = lc.summarize_monitor(proc_samples)
    summary["monitoring"]["pg_stat_activity"] = lc.summarize_monitor(pg_samples)
    # successful-auth throughput != attempted throughput
    ok_logins = [r for r in all_records if r.got_access_token]
    if ok_logins and wall_ms:
        span = max(r.finished_offset_ms for r in ok_logins)
        summary["successful_auth_rps"] = round(
            len(ok_logins) / (span / 1000), 2) if span else None
    paths = lc.write_artifacts(outdir, all_records, summary, health_samples)
    for name, samples in (("process.csv", proc_samples),
                          ("pg_activity.csv", pg_samples)):
        p = lc.write_monitor_csv(outdir, name, samples)
        if p:
            paths[name.split(".")[0]] = p

    from analyze_results import write_report, write_charts
    paths.update(write_charts(outdir, all_records, summary))
    report_path = write_report(outdir, summary, health_samples)
    paths["report"] = report_path

    print(f"[done] artifacts in {outdir}")
    for k, v in paths.items():
        print(f"  {k}: {v}")
    counts = summary["counts"]
    print(f"[result] {counts['successful_logins']}/{counts['attempted']} "
          f"logins succeeded; 429s={counts['http_429']} "
          f"5xx={counts['http_5xx']} sys_failures={counts['system_failures']}")
    return 0


def main() -> int:
    args = parse_args()
    try:
        return asyncio.run(main_async(args))
    except KeyboardInterrupt:
        print("\n[cancelled] interrupted by user — partial artifacts kept")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
