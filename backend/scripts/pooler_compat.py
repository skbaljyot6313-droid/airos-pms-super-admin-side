"""Pooler-mode compatibility probe — transaction :6543 vs session :5432.

Read-only. Verifies against the REAL configured Supabase project:
  * connectivity on both pooler ports
  * prepared-statement correctness — repeated parameterized statements
    across several pooled connections (the B-01 failure mode)
  * transaction-boundary behavior (BEGIN / prepared stmt / ROLLBACK)
  * warm-statement latency on each mode (statement_cache_size default vs 0)
  * concurrent-query smoke test

Usage (from backend/):
    python scripts/pooler_compat.py
"""

from __future__ import annotations

import asyncio
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import asyncpg  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402

from app.core.config import settings  # noqa: E402


def _url_for(port: int) -> str:
    url = make_url(settings.database_url)
    return url.set(port=port).render_as_string(hide_password=False).replace(
        "postgresql+asyncpg://", "postgresql://", 1
    )


def _kwargs(cache: int | None) -> dict:
    return {} if cache is None else {"statement_cache_size": cache}


async def _prepared_stmt_test(port: int, cache: int | None) -> dict:
    """Same parameterized statement across 4 connections — under
    transaction pooling each connection may land on a different backend,
    which is exactly the B-01 failure mode."""
    kwargs = _kwargs(cache)
    errors: list[str] = []
    lat: list[float] = []
    conns = []
    try:
        for _ in range(4):
            conns.append(await asyncpg.connect(_url_for(port), **kwargs))
        for i in range(24):
            conn = conns[i % 4]
            try:
                t0 = time.perf_counter()
                await conn.fetchval(
                    "SELECT count(*) FROM tasks WHERE status = $1", "completed"
                )
                lat.append((time.perf_counter() - t0) * 1000)
            except Exception as exc:  # noqa: BLE001 — report, don't crash
                errors.append(f"{type(exc).__name__}: {exc}")
    finally:
        for c in conns:
            try:
                await c.close()
            except Exception:
                pass
    return {
        "statements_run": len(lat),
        "error_count": len(errors),
        "errors": errors[:3],
        "median_ms": round(statistics.median(lat), 1) if lat else None,
        "min_ms": round(min(lat), 1) if lat else None,
    }


async def _txn_boundary_test(port: int, cache: int | None) -> dict:
    """Prepare inside an explicit transaction, roll back, repeat —
    the pattern that triggers `prepared statement does not exist`
    under transaction pooling."""
    kwargs = _kwargs(cache)
    errors: list[str] = []
    conn = None
    try:
        conn = await asyncpg.connect(_url_for(port), **kwargs)
        for _ in range(6):
            tx = conn.transaction()
            await tx.start()
            try:
                await conn.fetchval("SELECT $1::int + 1", 41)
            finally:
                await tx.rollback()
    except Exception as exc:  # noqa: BLE001
        errors.append(f"{type(exc).__name__}: {exc}")
    finally:
        if conn is not None:
            await conn.close()
    return {"txn_cycles": 6, "errors": errors}


async def _concurrency_test(port: int, cache: int | None, k: int = 8) -> dict:
    kwargs = _kwargs(cache)
    errors: list[str] = []

    async def worker():
        conn = None
        try:
            conn = await asyncpg.connect(_url_for(port), **kwargs)
            for _ in range(5):
                await conn.fetchval(
                    "SELECT count(*) FROM rooms WHERE property_id = $1",
                    "00000000-0000-0000-0000-000000000000",
                )
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{type(exc).__name__}: {exc}")
        finally:
            if conn is not None:
                await conn.close()

    await asyncio.gather(*(worker() for _ in range(k)))
    return {"workers": k, "statements": k * 5,
            "error_count": len(errors), "errors": errors[:3]}


async def main() -> None:
    url = make_url(settings.database_url)
    print(f"# project host: {url.host} (configured port {url.port})")

    cases = [
        (6543, 0, "transaction pooler, cache=0 (current production mode)"),
        (6543, None, "transaction pooler, cache=default (B-01 repro)"),
        (5432, None, "session pooler, cache=default (B-02 candidate)"),
        (5432, 0, "session pooler, cache=0 (fallback parity)"),
    ]
    for port, cache, label in cases:
        print(f"\n== {label} ==")
        try:
            prep = await _prepared_stmt_test(port, cache)
            txn = await _txn_boundary_test(port, cache)
            conc = await _concurrency_test(port, cache)
            print(" prepared-stmt:", prep)
            print(" txn-boundary :", txn)
            print(" concurrency  :", conc)
        except Exception as exc:  # noqa: BLE001
            print(f" UNREACHABLE/FATAL: {type(exc).__name__}: {exc}")


if __name__ == "__main__":
    asyncio.run(main())
