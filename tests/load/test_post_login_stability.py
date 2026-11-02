"""
Post-login stability check — AiROS PMS.

After a login burst (or standalone), verifies the system still serves
authenticated traffic: it logs in a small number of test accounts, then
exercises the real authenticated read paths.

Endpoints exercised (verified against backend/app):
  - POST /api/v1/auth/login          obtain tokens (small count!)
  - GET  /api/v1/auth/me             identity/profile read  (Bearer)
  - GET  /api/v1/workspace           workspace aggregate     (Bearer)
  - POST /api/v1/auth/refresh        refresh-token exchange  (optional)

NOTE: the login rate limit is 10 req/min per client IP — keep --accounts
small and reuse is sequential, or the check itself gets throttled. 429s
are reported, not hidden.

Runner script, not a pytest module (__test__ = False).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import load_common as lc  # noqa: E402

__test__ = False

DEFAULT_READS_PER_ACCOUNT = 5


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="AiROS post-login stability check")
    lc.add_safety_args(p)
    p.add_argument("--credentials-file", default=None)
    p.add_argument("--accounts", type=int, default=3,
                   help="distinct accounts to log in with (keep <= ~8; "
                        "login limit is 10/min/IP)")
    p.add_argument("--reads-per-account", type=int,
                   default=DEFAULT_READS_PER_ACCOUNT)
    p.add_argument("--test-refresh", action="store_true",
                   help="also POST /auth/refresh once per account")
    p.add_argument("--outdir", default=None)
    p.add_argument("--concurrency", type=int, default=5,
                   help="parallel authenticated reads (not logins)")
    return p.parse_args(argv)


async def _timed_get(client, path, token) -> dict:
    t0 = time.perf_counter()
    try:
        r = await client.get(path, headers={"Authorization": f"Bearer {token}"})
        return {"path": path, "status": r.status_code,
                "latency_ms": round((time.perf_counter() - t0) * 1000, 2),
                "server_ms": lc.parse_ms_header(r.headers.get("x-response-time")),
                "db_ms": lc.parse_ms_header(r.headers.get("x-db-time"))}
    except Exception as exc:  # noqa: BLE001
        return {"path": path, "status": None,
                "latency_ms": round((time.perf_counter() - t0) * 1000, 2),
                "error": lc.error_summary(exc)}


async def main_async(args) -> int:
    cfg = lc.RunConfig(
        base_url=args.base_url.rstrip("/"), environment=args.env,
        mode="unique_users", concurrency=args.concurrency,
        total_requests=args.accounts)
    lc.enforce_safety(cfg, args.confirm_load_test, args.i_am_sure_production)
    lc.verify_reachable(cfg.base_url)

    creds = lc.load_credentials(args.credentials_file, "unique_users",
                                args.accounts)
    outdir = Path(args.outdir) if args.outdir else (
        lc.RESULTS_DIR / f"stability-{cfg.run_id}")
    outdir.mkdir(parents=True, exist_ok=True)

    result: dict = {"run_id": cfg.run_id, "base_url": cfg.base_url,
                    "environment": cfg.environment, "phases": {}}

    async with lc.make_client(cfg) as client:
        # Phase 1 — sequential logins (respect the 10/min/IP limit)
        sessions = []   # (label, access, refresh)
        login_results = []
        for i, (ident, pw) in enumerate(creds):
            t0 = time.perf_counter()
            try:
                r = await client.post(lc.LOGIN_PATH,
                                      json={"identifier": ident,
                                            "password": pw})
                lat = round((time.perf_counter() - t0) * 1000, 2)
                login_results.append({"seq": i, "status": r.status_code,
                                      "latency_ms": lat})
                if r.status_code == 200:
                    body = r.json()
                    sessions.append((ident.split("@")[0],
                                     body["access_token"],
                                     body["refresh_token"]))
            except Exception as exc:  # noqa: BLE001
                login_results.append({"seq": i, "status": None,
                                      "error": lc.error_summary(exc)})
            await asyncio.sleep(0.4)  # stay well under the rate limit
        ok_logins = sum(1 for x in login_results if x["status"] == 200)
        result["phases"]["login"] = {
            "attempted": len(login_results), "succeeded": ok_logins,
            "detail": login_results,
        }
        print(f"[login] {ok_logins}/{len(login_results)} succeeded")

        # Phase 2 — authenticated reads: /auth/me + /workspace per account
        read_results = []
        for label, access, _refresh in sessions:
            for _ in range(args.reads_per_account):
                read_results.append(await _timed_get(
                    client, lc.ME_PATH, access))
                read_results.append(await _timed_get(
                    client, lc.WORKSPACE_PATH, access))
        for path in (lc.ME_PATH, lc.WORKSPACE_PATH):
            subset = [r for r in read_results if r["path"] == path]
            ok = sum(1 for r in subset if r["status"] == 200)
            lats = [r["latency_ms"] for r in subset]
            result["phases"][f"read{path}"] = {
                "attempted": len(subset), "succeeded": ok,
                "latency": lc.summarize_latencies(lats),
                "errors": [r for r in subset if r["status"] != 200][:10],
            }
            print(f"[read] {path}: {ok}/{len(subset)} ok "
                  f"p50={result['phases'][f'read{path}']['latency'].get('p50_ms')}ms")

        # Phase 3 — refresh-token exchange (optional)
        if args.test_refresh:
            refresh_results = []
            for _label, _a, refresh in sessions:
                t0 = time.perf_counter()
                try:
                    r = await client.post(lc.REFRESH_PATH,
                                          json={"refresh_token": refresh})
                    refresh_results.append({
                        "status": r.status_code,
                        "latency_ms": round((time.perf_counter() - t0) * 1000, 2),
                        "got_access": bool(
                            r.status_code == 200
                            and r.json().get("access_token")),
                    })
                except Exception as exc:  # noqa: BLE001
                    refresh_results.append({"status": None,
                                            "error": lc.error_summary(exc)})
            ok = sum(1 for r in refresh_results if r.get("got_access"))
            result["phases"]["refresh"] = {
                "attempted": len(refresh_results), "succeeded": ok,
                "detail": refresh_results,
            }
            print(f"[refresh] {ok}/{len(refresh_results)} issued new access tokens")

        # Phase 4 — recovery snapshot
        health = await lc.sample_health(cfg.base_url, phase="after",
                                        duration_s=3.0)
        result["phases"]["health_after"] = [
            {"path": s.path, "status": s.status_code,
             "latency_ms": s.latency_ms} for s in health]

    p = outdir / "stability_summary.json"
    p.write_text(json.dumps(result, indent=2))
    print(f"[done] {p}")
    failed_phases = [k for k, v in result["phases"].items()
                     if isinstance(v, dict) and "succeeded" in v
                     and v["succeeded"] < v["attempted"]]
    if failed_phases:
        print(f"[warn] phases with failures: {failed_phases}")
        return 1
    return 0


def main() -> int:
    args = parse_args()
    try:
        return asyncio.run(main_async(args))
    except KeyboardInterrupt:
        print("\n[cancelled]")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
