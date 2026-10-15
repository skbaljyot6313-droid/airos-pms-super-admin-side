"""API latency probe — times the real endpoint set the frontend uses.

Mints a short-lived access token for a configured user (the script only
ever performs GETs — no writes, no state changes) and measures each
endpoint N times sequentially, plus the frontend's `loadWorkspace` burst
(9 parallel GETs) as it actually fires.

For every endpoint it reports client-observed wall time AND the server's
own attribution headers (X-Response-Time / X-DB-Time / X-DB-Queries /
X-Ext-Time) emitted by the timing middleware.

Usage (from backend/, app running on :8000):
    python scripts/api_probe.py --user <user_uuid> [--base http://localhost:8000/api/v1]
                                 [--n 15] [--out ../docs/performance-audit/data]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.security import create_access_token  # noqa: E402

ENDPOINTS = [
    ("GET", "/auth/me"),
    ("GET", "/properties"),
    ("GET", "/areas"),
    ("GET", "/zones"),
    ("GET", "/rooms"),
    ("GET", "/dorms"),
    ("GET", "/washrooms"),
    ("GET", "/employees"),
    ("GET", "/tasks?limit=500"),
    ("GET", "/maintenance"),
    ("GET", "/tasks/today"),
    ("GET", "/tasks/review-queue"),
    ("GET", "/attendance/status-board"),
    ("GET", "/templates"),
    ("GET", "/shifts"),
    ("GET", "/live-locations"),
]

WORKSPACE_BURST = [
    "/properties", "/areas", "/zones", "/rooms", "/dorms",
    "/washrooms", "/employees", "/tasks?limit=500", "/maintenance",
]


def _stats(samples: list[float]) -> dict:
    s = sorted(samples)
    n = len(s)
    p = lambda q: s[min(n - 1, int(q * n))]
    return {
        "n": n,
        "min_ms": round(s[0], 1),
        "median_ms": round(statistics.median(s), 1),
        "p90_ms": round(p(0.90), 1),
        "p95_ms": round(p(0.95), 1),
        "p99_ms": round(s[min(n - 1, int(0.99 * n) or 0)], 1),
        "max_ms": round(s[-1], 1),
        "mean_ms": round(statistics.mean(s), 1),
    }


def _hdr_ms(res: httpx.Response, name: str) -> float | None:
    v = res.headers.get(name)
    if not v:
        return None
    try:
        return float(v.replace("ms", ""))
    except ValueError:
        return None


async def main() -> dict:
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True, help="user uuid for the token")
    ap.add_argument("--company", default=None)
    ap.add_argument("--role", default="super_admin")
    ap.add_argument("--base", default="http://localhost:8000/api/v1")
    ap.add_argument("--n", type=int, default=15)
    ap.add_argument("--out", default="../docs/performance-audit/data")
    args = ap.parse_args()

    company = args.company or args.user  # company unknown → caller should pass
    token = create_access_token(
        user_id=args.user, company_id=company, role=args.role
    )
    headers = {"Authorization": f"Bearer {token}"}

    report: dict = {
        "probe": "api",
        "captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "base": args.base,
        "runs_per_endpoint": args.n,
        "env": settings.APP_ENV,
        "note": "local client -> local API -> remote Supabase (ap-south-1)",
    }

    async with httpx.AsyncClient(
        base_url=args.base, headers=headers, timeout=60
    ) as client:
        endpoints = []
        for method, path in ENDPOINTS:
            wall, srv, db, dbq, ext, sizes = [], [], [], [], [], []
            status = None
            for _ in range(args.n):
                t0 = time.perf_counter()
                try:
                    res = await client.request(method, path)
                    status = res.status_code
                    sizes.append(len(res.content))
                except httpx.HTTPError as exc:
                    status = f"ERR:{type(exc).__name__}"
                wall.append((time.perf_counter() - t0) * 1000)
                if status == 200:
                    srv.append(_hdr_ms(res, "x-response-time"))
                    db.append(_hdr_ms(res, "x-db-time"))
                    dbq.append(_hdr_ms(res, "x-db-queries"))
                    ext.append(_hdr_ms(res, "x-ext-time"))
            entry = {
                "endpoint": f"{method} {path}",
                "status": status,
                "client_wall": _stats(wall),
                "payload_bytes_med": (
                    int(statistics.median(sizes)) if sizes else None
                ),
            }
            if srv:
                entry["server_total"] = _stats([v for v in srv if v is not None])
            if any(v for v in db if v is not None):
                entry["db_time"] = _stats([v for v in db if v is not None])
            if any(v for v in dbq if v is not None):
                entry["db_queries_med"] = statistics.median(
                    [v for v in dbq if v is not None]
                )
            if any(v for v in ext if v is not None):
                entry["ext_time"] = _stats([v for v in ext if v is not None])
            endpoints.append(entry)
            print(
                f"{entry['endpoint']:45s} {status} "
                f"wall_med={entry['client_wall']['median_ms']:>7.1f}ms "
                f"srv_med={entry.get('server_total', {}).get('median_ms', '-'):>7} "
                f"dbq={entry.get('db_queries_med', '-')}"
            )
        report["endpoints"] = endpoints

        # The AppContext loadWorkspace burst — fired in parallel exactly
        # like signIn/session-restore does.
        burst_walls = []
        per_req_srv = {p: [] for p in WORKSPACE_BURST}
        for _ in range(args.n):
            t0 = time.perf_counter()
            results = await asyncio.gather(
                *(client.get(p) for p in WORKSPACE_BURST),
                return_exceptions=True,
            )
            burst_walls.append((time.perf_counter() - t0) * 1000)
            for p, r in zip(WORKSPACE_BURST, results):
                if isinstance(r, httpx.Response) and r.status_code == 200:
                    ms = _hdr_ms(r, "x-response-time")
                    if ms is not None:
                        per_req_srv[p].append(ms)
        report["workspace_burst"] = {
            "requests_per_load": len(WORKSPACE_BURST),
            "wall": _stats(burst_walls),
            "per_request_server_ms_median": {
                p: (round(statistics.median(v), 1) if v else None)
                for p, v in per_req_srv.items()
            },
        }
        print(
            f"workspace burst ({len(WORKSPACE_BURST)} parallel GETs): "
            f"wall_med={report['workspace_burst']['wall']['median_ms']:.0f}ms "
            f"p95={report['workspace_burst']['wall']['p95_ms']:.0f}ms"
        )

    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)
    out = outdir / f"api-probe-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}.json"
    out.write_text(json.dumps(report, indent=2, default=str))
    print(f"wrote {out}")
    return report


if __name__ == "__main__":
    asyncio.run(main())
