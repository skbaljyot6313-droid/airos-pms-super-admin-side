"""Read-only performance audit probe for the AiROS Postgres database.

Connects with the app's own configured URL (app.core.config.settings) and
emits a JSON report with:

  * connect / SELECT 1 round-trip latencies (median, p95, min, max)
  * timed executions of the application's hot read queries (same SQL the
    repositories issue — literals bound, no writes)
  * catalog facts: server version, pg_stat_statements availability,
    per-table sizes/row estimates, index inventory, sequential-scan stats,
    live session count
  * pg_stat_statements top queries when the extension is enabled

NOTHING in this script writes to the database. All statements are SELECTs
against pg_catalog / pg_stat_* views or the application's own read paths.

Usage (from backend/):
    python scripts/audit_probe.py [--out ../docs/performance-audit/data]
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

import asyncpg  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402

from app.core.config import settings  # noqa: E402


def _stats(samples: list[float]) -> dict:
    s = sorted(samples)
    n = len(s)
    p = lambda q: s[min(n - 1, int(q * n))]
    return {
        "n": n,
        "min_ms": round(s[0], 1),
        "median_ms": round(statistics.median(s), 1),
        "p95_ms": round(p(0.95), 1),
        "max_ms": round(s[-1], 1),
        "mean_ms": round(statistics.mean(s), 1),
    }


def _pg_url() -> str:
    url = make_url(settings.database_url)
    return url.render_as_string(hide_password=False).replace(
        "postgresql+asyncpg://", "postgresql://", 1
    )


async def timed(conn, label: str, sql: str, args: tuple = (), n: int = 5):
    out = []
    rows = 0
    for _ in range(n):
        t0 = time.perf_counter()
        r = await conn.fetch(sql, *args)
        out.append((time.perf_counter() - t0) * 1000)
        rows = len(r)
    return {"label": label, "rows_returned": rows, **_stats(out)}


async def main(outdir: Path) -> dict:
    report: dict = {"probe": "db", "captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "env": settings.APP_ENV}
    url = _pg_url()
    host = make_url(settings.database_url).host
    report["db_host"] = host
    report["db_port"] = make_url(settings.database_url).port
    report["pooler_mode_hint"] = (
        "transaction (port 6543)" if make_url(settings.database_url).port == 6543
        else "session/direct (port 5432)"
    )

    # --- connect + warm RTT ------------------------------------------------
    conn_times = []
    conn = None
    for _ in range(5):
        t0 = time.perf_counter()
        c = await asyncpg.connect(url, statement_cache_size=0)
        conn_times.append((time.perf_counter() - t0) * 1000)
        await c.close()
    report["fresh_connect_ms"] = _stats(conn_times)

    conn = await asyncpg.connect(url, statement_cache_size=0)
    try:
        report["select1_rtt"] = _stats([
            (await _one(conn, "SELECT 1")) for _ in range(12)
        ][1:])  # drop cold first sample

        # --- catalog -------------------------------------------------------
        report["server_version"] = (await conn.fetchrow("SHOW server_version"))[0]
        ext = await conn.fetch(
            "SELECT extname, extversion FROM pg_extension ORDER BY extname"
        )
        report["extensions"] = [f'{r["extname"]}-{r["extversion"]}' for r in ext]
        report["pg_stat_statements_enabled"] = any(
            e["extname"] == "pg_stat_statements" for e in ext
        )

        report["sessions"] = dict(
            await conn.fetchrow(
                "SELECT count(*) total, "
                "count(*) FILTER (WHERE state='active') active, "
                "count(*) FILTER (WHERE state='idle in transaction') idle_in_tx "
                "FROM pg_stat_activity WHERE datname = current_database()"
            )
        )

        # Tenant scale context — read-only estimates + real counts on the
        # small hot tables the frontend lists in full.
        report["tenant_row_estimates"] = [
            dict(r) for r in await conn.fetch(
                """SELECT c.relname AS table, c.reltuples::bigint AS est_rows,
                          pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
                   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname='public' AND c.relkind='r'
                   ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 25"""
            )
        ]

        report["scan_stats"] = [
            dict(r) for r in await conn.fetch(
                """SELECT relname, seq_scan, idx_scan,
                          seq_tup_read, idx_tup_fetch, n_live_tup
                   FROM pg_stat_user_tables
                   ORDER BY seq_tup_read DESC LIMIT 25"""
            )
        ]

        report["index_inventory"] = [
            dict(r) for r in await conn.fetch(
                """SELECT tablename, indexname, indexdef
                   FROM pg_indexes WHERE schemaname='public'
                   ORDER BY tablename, indexname"""
            )
        ]

        # FK columns lacking a supporting btree — classic write/child-lookup
        # latency source at scale.
        report["unindexed_foreign_keys"] = [
            dict(r) for r in await conn.fetch(
                """SELECT conrelid::regclass::text AS table,
                          a.attname AS column, confrelid::regclass::text AS refs
                   FROM pg_constraint c
                   JOIN pg_attribute a
                     ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
                   WHERE c.contype = 'f' AND array_length(c.conkey,1) = 1
                     AND NOT EXISTS (
                       SELECT 1 FROM pg_index i
                       WHERE i.indrelid = c.conrelid
                         AND (i.indkey::int2[])[0] = c.conkey[1]
                     )
                   ORDER BY 1"""
            )
        ]

        if report["pg_stat_statements_enabled"]:
            report["top_queries_total_time"] = [
                {k: (str(v) if not isinstance(v, float) else round(v, 1))
                 for k, v in dict(r).items()}
                for r in await conn.fetch(
                    """SELECT calls,
                              round(total_exec_time::numeric,1) AS total_ms,
                              round(mean_exec_time::numeric,1) AS mean_ms,
                              round(max_exec_time::numeric,1) AS max_ms,
                              rows,
                              left(regexp_replace(query, '\\s+', ' ', 'g'), 220) AS query
                       FROM pg_stat_statements
                       WHERE query NOT ILIKE '%pg_stat_statements%'
                         AND query NOT ILIKE '%pg_catalog%'
                       ORDER BY total_exec_time DESC LIMIT 20"""
                )
            ]
            report["top_queries_mean_time"] = [
                {k: (str(v) if not isinstance(v, float) else round(v, 1))
                 for k, v in dict(r).items()}
                for r in await conn.fetch(
                    """SELECT calls,
                              round(mean_exec_time::numeric,1) AS mean_ms,
                              round(max_exec_time::numeric,1) AS max_ms,
                              left(regexp_replace(query, '\\s+', ' ', 'g'), 220) AS query
                       FROM pg_stat_statements
                       WHERE calls > 20
                         AND query NOT ILIKE '%pg_stat_statements%'
                         AND query NOT ILIKE '%pg_catalog%'
                       ORDER BY mean_exec_time DESC LIMIT 15"""
                )
            ]

        # --- hot-path timed reads ------------------------------------------
        # The queries below replicate the repository SQL shape. Property/
        # company scoping is bound from a real row so plans are realistic.
        prop = await conn.fetchrow(
            "SELECT id, company_id FROM properties LIMIT 1"
        )
        measurements = []
        if prop:
            cid, pid = prop["company_id"], prop["id"]
            measurements.append(await timed(
                conn, "list_rooms (company join)",
                """SELECT r.* FROM rooms r
                   JOIN properties p ON r.property_id = p.id
                   WHERE p.company_id = $1 ORDER BY r.room_number""", (cid,)))
            measurements.append(await timed(
                conn, "list_rooms (property scope)",
                "SELECT * FROM rooms WHERE property_id=$1 ORDER BY room_number",
                (pid,)))
            measurements.append(await timed(
                conn, "list_dorms + beds (property)",
                """SELECT d.*, b.* FROM dorms d
                   LEFT JOIN beds b ON b.dorm_id = d.id
                   WHERE d.property_id=$1 ORDER BY d.name""", (pid,)))
            measurements.append(await timed(
                conn, "list_tasks (company join, desc created_at)",
                """SELECT t.* FROM tasks t
                   JOIN properties p ON t.property_id = p.id
                   WHERE p.company_id=$1 ORDER BY t.created_at DESC""", (cid,)))
            measurements.append(await timed(
                conn, "open_occupancy stamp (property rooms)",
                """SELECT o.room_id, o.bed_id FROM occupancies o
                   JOIN rooms r ON o.room_id = r.id
                   WHERE r.property_id=$1 AND o.checked_out_at IS NULL""", (pid,)))
            measurements.append(await timed(
                conn, "list_employees (company)",
                "SELECT * FROM employees WHERE company_id=$1 ORDER BY created_at DESC",
                (cid,)))
            measurements.append(await timed(
                conn, "auth user lookup (by pk)",
                "SELECT * FROM users WHERE id = (SELECT id FROM users LIMIT 1)",
                (), n=8))
            measurements.append(await timed(
                conn, "list_maintenance (company join)",
                """SELECT m.* FROM maintenance_tickets m
                   JOIN properties p ON m.property_id = p.id
                   WHERE p.company_id=$1""", (cid,)))
        report["hot_reads"] = measurements
    finally:
        await conn.close()

    outdir.mkdir(parents=True, exist_ok=True)
    out = outdir / f"db-probe-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}.json"
    out.write_text(json.dumps(report, indent=2, default=str))
    return report, out


async def _one(conn, sql):
    t0 = time.perf_counter()
    await conn.fetch(sql)
    return (time.perf_counter() - t0) * 1000


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="../docs/performance-audit/data")
    args = ap.parse_args()
    report, path = asyncio.run(main(Path(args.out)))
    print(f"wrote {path}")
    print(json.dumps(
        {k: v for k, v in report.items()
         if k in ("db_host", "db_port", "pooler_mode_hint", "fresh_connect_ms",
                  "select1_rtt", "pg_stat_statements_enabled", "sessions",
                  "hot_reads")},
        indent=2, default=str,
    ))
