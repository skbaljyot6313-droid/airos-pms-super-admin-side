"""
SQLAlchemy async database infrastructure.

AsyncEngine → async_sessionmaker → AsyncSession, injected into routes via
the `get_db` dependency (see app/dependencies/db.py).
"""

import asyncio
import socket
import ssl as ssl_module
from collections.abc import AsyncGenerator

from fastapi import status
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import settings
from app.core.exceptions import AppError
from app.core.logging import get_logger

logger = get_logger("app.database")


class DatabaseUnavailable(AppError):
    """Connectivity-level failure reaching PostgreSQL (DNS/refused/timeout).

    Distinct from SQLAlchemyError handling — asyncpg surfaces gaierror and
    friends as raw OSErrors that never become SQLAlchemyError subclasses."""

    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    code = "DATABASE_UNAVAILABLE"
    message = "The database is temporarily unavailable. Please try again."


def _pgbouncer_connect_args() -> dict:
    """pgbouncer transaction/statement poolers do not support asyncpg's
    prepared-statement cache. Disable the cache when the URL points at a
    Supabase pooler host so migrations and queries work reliably.

    asyncpg renamed the connect kwarg in 0.30 (`statement_cache_size` →
    `prepared_statement_cache_size`) — pass whichever the installed
    version accepts; the wrong name raises TypeError on connect."""
    try:
        parsed = make_url(settings.database_url)
        if not (parsed.host and "pooler" in parsed.host):
            return {}
        import inspect

        import asyncpg

        params = inspect.signature(asyncpg.connect).parameters
        key = (
            "statement_cache_size"
            if "statement_cache_size" in params
            else "prepared_statement_cache_size"
        )
        return {key: 0}
    except Exception:
        pass
    return {}


engine: AsyncEngine = create_async_engine(
    settings.database_url,
    connect_args=_pgbouncer_connect_args(),
    # pool_recycle handles stale connections at checkout — avoids paying an
    # extra DB round trip (~300ms to remote Supabase) on EVERY request.
    pool_pre_ping=False,
    pool_recycle=settings.DB_POOL_RECYCLE,
    pool_size=settings.DB_POOL_SIZE,
    max_overflow=settings.DB_MAX_OVERFLOW,
    pool_timeout=settings.DB_POOL_TIMEOUT,
    echo=settings.SQL_ECHO,
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)


# --------------------------------------------------------------------------
# Employee-Backend push notices — allocation events buffered by
# WorkAllocationService.record() on session.info are dispatched to the EB
# ONLY after the outer transaction commits; rollbacks discard the buffer.
# SQLAlchemy fires after_commit for SAVEPOINT releases too, so nested
# transactions are skipped — the outer commit drains the whole buffer.
# --------------------------------------------------------------------------

from sqlalchemy import event  # noqa: E402
from sqlalchemy.orm import Session as _SyncSession  # noqa: E402

# Session events can't target an async_sessionmaker — the listener
# receives the underlying sync Session, so register on the Session class
# (AsyncSessionLocal is the only session factory in this process).


@event.listens_for(_SyncSession, "after_commit")
def _eb_events_after_commit(session) -> None:
    if session.in_nested_transaction():
        return
    from app.services.employee_events import (
        EB_ALLOC_EVENTS,
        dispatch_allocation_notices,
    )
    events = session.info.pop(EB_ALLOC_EVENTS, None)
    if not events:
        return
    try:
        try:
            asyncio.get_running_loop().create_task(
                dispatch_allocation_notices(list(events))
            )
        except RuntimeError:
            # inside greenlet_spawn during session.commit() — await directly
            from sqlalchemy.util.concurrency import await_only
            await_only(dispatch_allocation_notices(list(events)))
    except Exception as exc:
        # The commit already happened — a failed notice must never surface
        # as a failed allocation. The EB feed synthesis is the backstop.
        logger.warning(
            "allocation-notice dispatch failed: %s", type(exc).__name__
        )


@event.listens_for(_SyncSession, "after_rollback")
def _eb_events_after_rollback(session) -> None:
    if session.in_nested_transaction():
        return
    from app.services.employee_events import EB_ALLOC_EVENTS
    session.info.pop(EB_ALLOC_EVENTS, None)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency — yields an AsyncSession, always closed on exit."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
        except Exception as exc:
            await session.rollback()
            # asyncpg raises raw OSErrors (gaierror, refused, timeout) that
            # bypass the SQLAlchemyError handler — map them to a clean 503.
            if isinstance(_unwrap(exc), (socket.gaierror, ConnectionError, TimeoutError)):
                logger.error("Database unavailable: %s", describe_db_error(exc))
                raise DatabaseUnavailable() from exc
            raise


async def close_db() -> None:
    """Dispose the engine's connection pool (app shutdown)."""
    await engine.dispose()


async def check_database(timeout: float = 10.0) -> None:
    """Real connectivity probe — runs SELECT 1 through the engine/pool.

    Raises on failure; returns None on success. Bounded by `timeout` so a
    stalled remote (e.g. Supabase) can't hang health checks or startup.
    """
    async def _probe() -> None:
        async with AsyncSessionLocal() as session:
            await session.execute(text("SELECT 1"))

    await asyncio.wait_for(_probe(), timeout=timeout)


def _unwrap(exc: BaseException) -> BaseException:
    """Peel SQLAlchemy/OSError wrappers down to the root cause."""
    seen: set[int] = set()
    cur: BaseException = exc
    while True:
        nxt = getattr(cur, "orig", None) or getattr(cur, "__cause__", None)
        if nxt is None or id(nxt) in seen:
            return cur
        seen.add(id(cur))
        cur = nxt


def describe_db_error(exc: BaseException) -> str:
    """Categorized, credential-free description of a database failure.

    Used for startup/scheduler/health logging — identifies the failure class
    (DNS, auth, refused, timeout, TLS) and the sanitized host:port, without
    ever emitting the connection string or password.
    """
    host_port = settings.database_host_port
    root = _unwrap(exc)

    if isinstance(root, socket.gaierror):
        return f"unable to resolve PostgreSQL host '{host_port}' (DNS failure)"
    if isinstance(root, (TimeoutError, asyncio.TimeoutError)):
        return f"connection to PostgreSQL host '{host_port}' timed out"
    if isinstance(root, ConnectionRefusedError):
        return f"connection refused by PostgreSQL host '{host_port}'"
    if isinstance(root, ssl_module.SSLError):
        return f"TLS/SSL failure connecting to PostgreSQL host '{host_port}'"
    if isinstance(root, OSError):
        return f"network error reaching PostgreSQL host '{host_port}': {root.strerror or root}"

    name = type(root).__name__.lower()
    if "password" in name or "auth" in name:
        return f"authentication failed for PostgreSQL host '{host_port}' — check SUPABASE_DB_USER/SUPABASE_DB_PASSWORD"
    return f"{type(exc).__name__} connecting to PostgreSQL host '{host_port}'"
