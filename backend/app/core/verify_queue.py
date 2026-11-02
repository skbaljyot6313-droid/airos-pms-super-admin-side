"""
Bounded password-verification executor — admission control for the
CPU-bound argon2 verify inside login.

Why this exists (measured): argon2id verify runs ~50-150 ms of pure CPU.
On the event loop, N concurrent logins serialize the loop AND inflate
every other request's latency; under the 500-login burst this produced
accept-queue starvation (client ConnectError) and pool timeouts. Simply
wrapping verify in run_in_executor with the DEFAULT executor replaces
loop starvation with unbounded thread growth — every queued request still
holds an OS thread + a DB session checkout.

Design (process-local — per worker, see MultiInstance note):
  * Dedicated ThreadPoolExecutor(max_workers=VERIFY_MAX_WORKERS) — the
    pool is bounded; threads are created lazily up to the cap, never
    beyond it.
  * Admission = asyncio semaphore sized to the pool. Waiters are counted
    (_queued); when waiters reach VERIFY_QUEUE_MAX the request is
    rejected immediately — bounded queued work, no memory/thread growth.
  * A wait deadline (VERIFY_QUEUE_TIMEOUT_S) bounds how long a request
    may wait for a slot. Rejections and timeouts both become
    AuthOverloaded -> HTTP 503 + Retry-After — never misclassified as
    INVALID_CREDENTIALS.
  * Cancellation: if the awaiting coroutine is cancelled while queued, no
    slot was acquired — nothing leaks. If cancelled after submission, the
    worker thread finishes (~100 ms) and the slot is released via the
    future's done-callback, so abandoned requests can't permanently
    occupy the executor.
  * Dummy-hash path: login verifies a fixed argon2 hash for nonexistent
    accounts so unknown-user requests consume identical queue/CPU time —
    preserves the uniform InvalidCredentials contract without teaching
    an attacker which identifiers exist.

Multi-instance: limits are PER PROCESS. Total argon2 concurrency =
VERIFY_MAX_WORKERS x uvicorn workers x instance count — size per-process
limits against deployment max replicas and vCPU (see deploy/cloudrun.md).
"""

from __future__ import annotations

import asyncio
import os
import time
from concurrent.futures import ThreadPoolExecutor

from fastapi import status

from app.core.config import settings
from app.core.exceptions import AppError
from app.core.logging import get_logger
from app.core.security import hash_password
from app.core.timing import current_bag

logger = get_logger("app.verify_queue")


class AuthOverloaded(AppError):
    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    code = "AUTH_OVERLOADED"
    message = "Authentication service is busy. Please retry shortly."

    def __init__(self, retry_after: int):
        super().__init__()
        self.headers = {"Retry-After": str(retry_after)}


class VerificationQueueFull(AuthOverloaded):
    code = "AUTH_QUEUE_FULL"


class VerificationWaitTimeout(AuthOverloaded):
    code = "AUTH_QUEUE_TIMEOUT"


# A real argon2 hash so unknown-user logins cost the same as known users.
_DUMMY_HASH: str | None = None


def dummy_hash() -> str:
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = hash_password("dummy-password-for-uniform-timing")
    return _DUMMY_HASH


def _auto_workers() -> int:
    """Argon2 verify is CPU-bound: meaningful parallelism ≈ vCPU count.
    Cap at 4 by default — more threads only lengthen the queue on a
    memory-hard function that already pins a core each."""
    if settings.VERIFY_MAX_WORKERS > 0:
        return settings.VERIFY_MAX_WORKERS
    return max(1, min(4, (os.cpu_count() or 2)))


class VerifyQueue:
    """Bounded executor + bounded queue for argon2 verification."""

    def __init__(self, max_workers: int | None = None,
                 max_queue: int | None = None,
                 queue_timeout_s: float | None = None):
        self.max_workers = max_workers or _auto_workers()
        self.max_queue = (settings.VERIFY_QUEUE_MAX
                          if max_queue is None else max_queue)
        self.queue_timeout_s = (settings.VERIFY_QUEUE_TIMEOUT_S
                                if queue_timeout_s is None else queue_timeout_s)
        self._pool = ThreadPoolExecutor(
            max_workers=self.max_workers,
            thread_name_prefix="argon2-verify")
        self._slots = asyncio.BoundedSemaphore(self.max_workers)
        self._queued = 0
        self._active = 0
        # process-lifetime counters (read-only observability)
        self.rejected_full = 0
        self.rejected_timeout = 0
        self.completed = 0
        self.verify_ms_total = 0.0

    @property
    def queued(self) -> int:
        return self._queued

    @property
    def active(self) -> int:
        return self._active

    def stats(self) -> dict:
        return {
            "max_workers": self.max_workers,
            "max_queue": self.max_queue,
            "queue_timeout_s": self.queue_timeout_s,
            "active": self._active,
            "queued": self._queued,
            "rejected_queue_full": self.rejected_full,
            "rejected_queue_timeout": self.rejected_timeout,
            "completed": self.completed,
            "verify_ms_total": round(self.verify_ms_total, 1),
            "verify_ms_avg": round(
                self.verify_ms_total / self.completed, 1)
                if self.completed else None,
        }

    async def verify(self, verify_fn, *args):
        """Run `verify_fn(*args)` in the bounded pool. Returns its result.
        Raises AuthOverloaded (503) when the queue is full or the wait
        deadline expires."""
        retry = settings.VERIFY_OVERLOAD_RETRY_AFTER_S
        locked = self._slots.locked()
        if locked and self._queued >= self.max_queue:
            # pool busy AND waiters at capacity — reject immediately
            self.rejected_full += 1
            raise VerificationQueueFull(retry)

        t_wait = time.perf_counter()
        if locked:
            self._queued += 1
        try:
            # wait_for bounds every acquire — a waiter that loses a race
            # to an unlocked slot still can't wait past the deadline.
            await asyncio.wait_for(
                self._slots.acquire(), timeout=self.queue_timeout_s)
        except (asyncio.TimeoutError, TimeoutError):
            self.rejected_timeout += 1
            raise VerificationWaitTimeout(retry) from None
        finally:
            if locked:
                self._queued -= 1

        wait_ms = (time.perf_counter() - t_wait) * 1000
        self._active += 1
        bag = current_bag()
        if bag is not None:
            bag.verify_wait_ms += wait_ms

        loop = asyncio.get_running_loop()
        t0 = time.perf_counter()

        def _run():
            try:
                return verify_fn(*args)
            finally:
                ms = (time.perf_counter() - t0) * 1000
                self.verify_ms_total += ms
                self.completed += 1

        fut = loop.run_in_executor(self._pool, _run)

        def _release(_f):
            self._slots.release()
            self._active -= 1

        fut.add_done_callback(_release)
        try:
            result = await fut
        except asyncio.CancelledError:
            # Thread still finishes (~100 ms) and _release frees the slot —
            # nothing leaks, no retry of the cancelled request.
            raise
        finally:
            ms = (time.perf_counter() - t0) * 1000
            if bag is not None:
                bag.verify_ms += ms
        return result


# Module singleton — created lazily so importing this module at startup
# doesn't spawn threads before the event loop exists (fork-inherited
# pools are a classic deadlock source with --workers on some platforms).
_queue: VerifyQueue | None = None


def get_verify_queue() -> VerifyQueue:
    global _queue
    if _queue is None:
        _queue = VerifyQueue()
        logger.info("verify queue: workers=%d max_queue=%d timeout=%.1fs",
                    _queue.max_workers, _queue.max_queue,
                    _queue.queue_timeout_s)
    return _queue
