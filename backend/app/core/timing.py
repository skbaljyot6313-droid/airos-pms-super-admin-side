"""Request-scoped timing instrumentation.

A mutable TimingBag is placed in a contextvar at the start of each
request by RequestTimingMiddleware. SQLAlchemy cursor-execute events and
explicit `track_external()` spans accumulate into that bag, so the access
log can attribute each request's wall time to database work, external
calls, and everything else (auth/validation/business logic/serialization).

    method=GET path=/api/v1/tasks status=200 duration_ms=342
      db_ms=118 db_queries=7 ext_ms=0 ext_calls=0

Labels stay bounded — the log uses the route's path template, never raw
path parameters. Timing data contains no payloads, parameters, or
identifiers.

Disable with REQUEST_TIMING_ENABLED=false — the middleware then logs
duration only (identical to the previous access-log behavior) and the
engine listeners skip all work. The overhead when enabled is a handful of
perf_counter() calls per query plus one contextvar set per request.
"""

import contextvars
import time
from dataclasses import dataclass, field

from sqlalchemy import event

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger("app.timing")


@dataclass
class TimingBag:
    """Mutable per-request accumulator — shared by reference, so engine
    event handlers running inside greenlets still update the request's
    own bag."""

    db_ms: float = 0.0
    db_queries: int = 0
    ext_ms: float = 0.0
    ext_calls: int = 0
    notes: dict = field(default_factory=dict)


request_timing: contextvars.ContextVar[TimingBag | None] = contextvars.ContextVar(
    "request_timing", default=None
)


def current_bag() -> TimingBag | None:
    return request_timing.get()


class track_external:
    """Context manager — accumulate elapsed time of an outbound call
    (Redis op, httpx request to the employee backend, etc.) into the
    active request's bag. No-op when no request is active."""

    def __init__(self) -> None:
        self._t0 = 0.0

    def __enter__(self):
        self._bag = request_timing.get()
        self._t0 = time.perf_counter()
        return self

    def __exit__(self, *exc) -> bool:
        if self._bag is not None:
            self._bag.ext_ms += (time.perf_counter() - self._t0) * 1000
            self._bag.ext_calls += 1
        return False


def note(key: str, value) -> None:
    """Attach a bounded-cardinality annotation to the request's timing
    record (e.g. note('cache', 'hit'))."""
    bag = request_timing.get()
    if bag is not None:
        bag.notes[key] = value


def install_engine_listeners(engine) -> None:
    """Accumulate per-statement execution time into the active request's
    TimingBag. Registered on the SYNC engine — before/after_cursor_execute
    fire on the connection's sync facade regardless of the async driver.
    Statements executed outside a request (scheduler ticks, probes) simply
    find no bag and are skipped.
    """
    sync_engine = engine.sync_engine

    @event.listens_for(sync_engine, "before_cursor_execute")
    def _before(conn, cursor, statement, parameters, context, executemany):
        conn.info["_qstart"] = time.perf_counter()

    @event.listens_for(sync_engine, "after_cursor_execute")
    def _after(conn, cursor, statement, parameters, context, executemany):
        bag = request_timing.get()
        if bag is None:
            return
        started = conn.info.pop("_qstart", None)
        if started is None:
            return
        bag.db_ms += (time.perf_counter() - started) * 1000
        bag.db_queries += 1

    @event.listens_for(sync_engine, "handle_error")
    def _on_error(ctx):
        # Failed statements still consumed server time — count them.
        bag = request_timing.get()
        if bag is None:
            return
        started = ctx.connection.info.pop("_qstart", None)
        if started is not None:
            bag.db_ms += (time.perf_counter() - started) * 1000
            bag.db_queries += 1
