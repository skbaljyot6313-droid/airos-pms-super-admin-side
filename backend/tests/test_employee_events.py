"""Allocation-notice push to the Employee Backend.

record() buffers events on session.info; the session-level commit hook
drains and POSTs them to EB /admin/notify-allocation. Delivery is
post-commit and best-effort — every failure mode must be swallowed.
"""

import asyncio
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import httpx
import pytest
import respx

import app.services.employee_events as ev_mod
from app.core.config import settings
from app.services.employee_events import (
    EB_ALLOC_EVENTS,
    dispatch_allocation_notices,
    queue_allocation_notice,
)

UPSTREAM = "http://employee-backend.test"
BASE = f"{UPSTREAM}/api/v1"
NOTIFY_URL = f"{BASE}/admin/notify-allocation"

TICKET_ID = uuid.uuid4()
EMP_ID = uuid.uuid4()
PREV_ID = uuid.uuid4()
TS = datetime(2026, 10, 10, 16, 51, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    monkeypatch.setattr(settings, "EMPLOYEE_API_BASE_URL", None)
    monkeypatch.setattr(settings, "EMPLOYEE_BACKEND_URL", UPSTREAM)
    monkeypatch.setattr(settings, "LOCATION_SERVICE_API_KEY", "test-key")
    yield


def _session() -> SimpleNamespace:
    return SimpleNamespace(
        info={},
        in_nested_transaction=lambda: False,
    )


class TestQueue:
    def test_buffers_payload(self):
        s = _session()
        queue_allocation_notice(
            s, ticket_kind="task", ticket_id=TICKET_ID,
            employee_id=EMP_ID, employee_name="Worker One",
            previous_employee_id=PREV_ID, event_created_at=TS,
        )
        assert s.info[EB_ALLOC_EVENTS] == [{
            "ticket_kind": "task",
            "ticket_uid": str(TICKET_ID),
            "employee_uid": str(EMP_ID),
            "employee_name": "Worker One",
            "previous_employee_uid": str(PREV_ID),
            "event_created_at": TS.isoformat(),
        }]

    def test_appends_multiple(self):
        s = _session()
        for _ in range(3):
            queue_allocation_notice(
                s, ticket_kind="maintenance", ticket_id=TICKET_ID,
                employee_id=EMP_ID, employee_name=None,
                previous_employee_id=None, event_created_at=None,
            )
        assert len(s.info[EB_ALLOC_EVENTS]) == 3

    def test_unassigned_is_skipped(self):
        s = _session()
        queue_allocation_notice(
            s, ticket_kind="task", ticket_id=TICKET_ID,
            employee_id=None, employee_name=None,
            previous_employee_id=None, event_created_at=None,
        )
        assert EB_ALLOC_EVENTS not in s.info

    def test_unknown_kind_is_skipped(self):
        s = _session()
        queue_allocation_notice(
            s, ticket_kind="carrier_pigeon", ticket_id=TICKET_ID,
            employee_id=EMP_ID, employee_name=None,
            previous_employee_id=None, event_created_at=None,
        )
        assert EB_ALLOC_EVENTS not in s.info


class TestDispatch:
    EVENT = {
        "ticket_kind": "task",
        "ticket_uid": str(TICKET_ID),
        "employee_uid": str(EMP_ID),
        "employee_name": "Worker One",
        "previous_employee_uid": None,
        "event_created_at": TS.isoformat(),
    }

    @respx.mock
    async def test_posts_event_with_service_key(self):
        route = respx.post(NOTIFY_URL).mock(
            return_value=httpx.Response(200, json={"notified": True})
        )
        await dispatch_allocation_notices([dict(self.EVENT)])
        req = route.calls[0].request
        assert req.headers["x-location-service-key"] == "test-key"
        import json
        assert json.loads(req.content) == self.EVENT

    @respx.mock
    async def test_sends_each_buffered_event(self):
        route = respx.post(NOTIFY_URL).mock(
            return_value=httpx.Response(200, json={"notified": True})
        )
        await dispatch_allocation_notices(
            [dict(self.EVENT), dict(self.EVENT)]
        )
        assert route.call_count == 2

    @pytest.mark.parametrize("code", (400, 404, 500, 503))
    @respx.mock
    async def test_http_failure_swallowed(self, code):
        respx.post(NOTIFY_URL).mock(return_value=httpx.Response(code))
        await dispatch_allocation_notices([dict(self.EVENT)])  # no raise

    @respx.mock
    async def test_transport_error_swallowed(self):
        respx.post(NOTIFY_URL).mock(
            side_effect=httpx.ConnectError("refused")
        )
        await dispatch_allocation_notices([dict(self.EVENT)])

    @respx.mock
    async def test_timeout_swallowed(self):
        respx.post(NOTIFY_URL).mock(
            side_effect=httpx.ReadTimeout("slow")
        )
        await dispatch_allocation_notices([dict(self.EVENT)])

    @respx.mock
    async def test_failure_mid_batch_does_not_stop_rest(self):
        respx.post(NOTIFY_URL).mock(
            side_effect=[
                httpx.ConnectError("refused"),
                httpx.Response(200, json={"notified": True}),
            ]
        )
        await dispatch_allocation_notices(
            [dict(self.EVENT), dict(self.EVENT)]
        )
        assert respx.calls.call_count == 2

    @respx.mock
    async def test_unconfigured_is_silent_noop(self, monkeypatch):
        monkeypatch.setattr(settings, "EMPLOYEE_BACKEND_URL", None)
        monkeypatch.setattr(settings, "EMPLOYEE_API_BASE_URL", None)
        route = respx.post(NOTIFY_URL).mock(
            return_value=httpx.Response(200)
        )
        await dispatch_allocation_notices([dict(self.EVENT)])
        assert not route.called

    @respx.mock
    async def test_missing_key_is_silent_noop(self, monkeypatch):
        monkeypatch.setattr(settings, "LOCATION_SERVICE_API_KEY", None)
        route = respx.post(NOTIFY_URL).mock(
            return_value=httpx.Response(200)
        )
        await dispatch_allocation_notices([dict(self.EVENT)])
        assert not route.called


class TestSessionHooks:
    """The after_commit/after_rollback listeners in app.core.database —
    exercised directly on a fake session (no live DB needed)."""

    def _event(self):
        return {
            "ticket_kind": "task",
            "ticket_uid": str(TICKET_ID),
            "employee_uid": str(EMP_ID),
            "employee_name": None,
            "previous_employee_uid": None,
            "event_created_at": TS.isoformat(),
        }

    async def test_commit_drains_and_dispatches(self, monkeypatch):
        from app.core.database import _eb_events_after_commit

        sent = []

        async def fake_dispatch(events):
            sent.append(events)

        monkeypatch.setattr(
            ev_mod, "dispatch_allocation_notices", fake_dispatch
        )
        s = _session()
        s.info[EB_ALLOC_EVENTS] = [self._event()]
        _eb_events_after_commit(s)
        await asyncio.sleep(0)  # let the scheduled task run
        assert sent == [[self._event()]]
        assert EB_ALLOC_EVENTS not in s.info

    async def test_nested_commit_waits_for_outer(self, monkeypatch):
        """SAVEPOINT release must not dispatch — the outer txn can still
        roll back; the buffer survives for the real commit."""
        from app.core.database import _eb_events_after_commit

        async def boom(events):
            raise AssertionError("must not dispatch on savepoint")

        monkeypatch.setattr(ev_mod, "dispatch_allocation_notices", boom)
        s = _session()
        s.in_nested_transaction = lambda: True
        s.info[EB_ALLOC_EVENTS] = [self._event()]
        _eb_events_after_commit(s)
        await asyncio.sleep(0)
        assert s.info[EB_ALLOC_EVENTS] == [self._event()]

    def test_empty_buffer_is_noop(self):
        from app.core.database import _eb_events_after_commit

        s = _session()
        _eb_events_after_commit(s)  # no raise, no dispatch

    def test_rollback_drops_buffer(self):
        from app.core.database import _eb_events_after_rollback

        s = _session()
        s.info[EB_ALLOC_EVENTS] = [self._event()]
        _eb_events_after_rollback(s)
        assert EB_ALLOC_EVENTS not in s.info

    def test_nested_rollback_preserves_buffer(self):
        """A rolled-back savepoint only unwinds its own work — events
        buffered before it must still go out on the real commit."""
        from app.core.database import _eb_events_after_rollback

        s = _session()
        s.in_nested_transaction = lambda: True
        s.info[EB_ALLOC_EVENTS] = [self._event()]
        _eb_events_after_rollback(s)
        assert s.info[EB_ALLOC_EVENTS] == [self._event()]
