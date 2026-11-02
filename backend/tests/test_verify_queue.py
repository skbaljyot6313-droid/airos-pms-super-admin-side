"""Bounded verify-queue tests — admission control, saturation, timeout,
cancellation, and the overload→503 mapping. No DB required."""

import asyncio
import threading
import time

import pytest
from fastapi import status

from app.core.verify_queue import (
    AuthOverloaded,
    VerificationQueueFull,
    VerificationWaitTimeout,
    VerifyQueue,
    dummy_hash,
    get_verify_queue,
)


def _slow_verify(delay: float, result=True):
    def fn(*_args):
        time.sleep(delay)
        return result
    return fn


def _fast(*_):
    return True


async def test_verify_returns_result():
    q = VerifyQueue(max_workers=1, max_queue=10, queue_timeout_s=1)
    assert await q.verify(_fast, "pw", "hash") is True
    assert q.stats()["completed"] == 1


async def test_concurrent_verifies_bounded():
    """Two jobs on a 1-worker pool — second queues, both complete."""
    q = VerifyQueue(max_workers=1, max_queue=10, queue_timeout_s=5)
    r = await asyncio.gather(
        q.verify(_slow_verify(0.15)),
        q.verify(_slow_verify(0.15)))
    assert r == [True, True]
    assert q.active == 0 and q.queued == 0
    assert q.stats()["completed"] == 2


async def test_queue_full_rejects_immediately():
    q = VerifyQueue(max_workers=1, max_queue=0, queue_timeout_s=5)
    started = threading.Event()

    def blocker(*_):
        started.set()
        time.sleep(0.3)
        return True

    t = asyncio.create_task(q.verify(blocker))
    while not started.is_set():
        await asyncio.sleep(0.005)
    with pytest.raises(VerificationQueueFull):
        await q.verify(_fast)
    assert q.stats()["rejected_queue_full"] == 1
    await t


async def test_wait_timeout_rejects_with_503():
    q = VerifyQueue(max_workers=1, max_queue=4, queue_timeout_s=0.05)
    blocker_started = threading.Event()

    def blocker(*_):
        blocker_started.set()
        time.sleep(0.3)
        return True

    t = asyncio.create_task(q.verify(blocker))
    while not blocker_started.is_set():
        await asyncio.sleep(0.005)
    with pytest.raises(VerificationWaitTimeout) as ei:
        await q.verify(_fast)
    exc = ei.value
    assert exc.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    assert exc.headers["Retry-After"].isdigit()
    assert q.stats()["rejected_queue_timeout"] == 1
    await t
    # slot freed — pool still usable after the timeout
    assert await q.verify(_fast) is True


async def test_cancelled_waiter_leaks_nothing():
    q = VerifyQueue(max_workers=1, max_queue=4, queue_timeout_s=5)
    blocker_started = threading.Event()

    def blocker(*_):
        blocker_started.set()
        time.sleep(0.2)
        return True

    running = asyncio.create_task(q.verify(blocker))
    while not blocker_started.is_set():
        await asyncio.sleep(0.005)
    waiter = asyncio.create_task(q.verify(_fast))
    await asyncio.sleep(0.02)
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert q.queued == 0
    await running
    assert q.active == 0 and q._slots._value == 1  # permit fully restored


async def test_cancelled_running_releases_slot():
    """Cancelling a request mid-verify must not permanently hold a slot."""
    q = VerifyQueue(max_workers=1, max_queue=4, queue_timeout_s=5)
    t = asyncio.create_task(q.verify(_slow_verify(0.2)))
    await asyncio.sleep(0.05)  # job is running
    t.cancel()
    with pytest.raises(asyncio.CancelledError):
        await t
    # next job must proceed — the abandoned thread finishes and the pool
    # accepts new work immediately (slot released at cancellation).
    assert await q.verify(_fast) is True


async def test_overload_is_distinct_from_invalid_credentials():
    """Overload responses are 503 + code AUTH_*, never INVALID_CREDENTIALS."""
    exc = AuthOverloaded(retry_after=3)
    assert exc.status_code == 503
    assert exc.code.startswith("AUTH_")
    assert exc.code != "INVALID_CREDENTIALS"


def test_dummy_hash_is_real_argon2():
    h = dummy_hash()
    assert h.startswith("$argon2")
    assert dummy_hash() == h  # cached


def test_singleton_uses_settings():
    q = get_verify_queue()
    assert q is get_verify_queue()
    assert q.max_workers >= 1
