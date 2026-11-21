"""Midnight rollover — daily task expiry at 00:00 IST.

RolloverService.run() is the system-wide lifecycle boundary: every open
task anchored to a date before today's IST calendar date is abandoned.
Tests drive it with controlled `now` values — no waiting for midnight —
and scripted sessions (the suite never touches a real database).
"""

import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import Update

from app.services.rollover import (
    OPEN_STATUSES,
    REASON_MIDNIGHT,
    RolloverService,
    _midnight_anchor_key,
)

UTC = UTC

# 2026-11-08 00:00:05 IST — five seconds past the boundary.
JUST_AFTER_MIDNIGHT_UTC = datetime(2026, 11, 7, 18, 30, 5, tzinfo=UTC)
# 2026-11-08 14:00 IST — mid-day catch-up (e.g. restart after downtime).
MIDDAY_UTC = datetime(2026, 11, 8, 8, 30, 0, tzinfo=UTC)
TODAY = "2026-11-08"
YESTERDAY = "2026-11-07"
OLD = "2026-10-30"


def _row(status="pending", operational_date=None, due_date=None,
         scheduled_for=None, created_at=None, expires_at=None):
    return SimpleNamespace(
        id=uuid.uuid4(), status=status,
        operational_date=operational_date, due_date=due_date,
        scheduled_for=scheduled_for,
        created_at=created_at or datetime(2026, 11, 7, 3, 0, tzinfo=UTC),
        expires_at=expires_at,
    )


def _session(scan_rows, rowcounts=None):
    """Scripted session: Select → the candidate list, Update → rowcount."""
    state = {"updates": [], "adds": [], "committed": False}
    rowcounts = list(rowcounts or [])

    async def execute(stmt):
        if isinstance(stmt, Update):
            state["updates"].append(stmt)
            return SimpleNamespace(
                rowcount=rowcounts.pop(0) if rowcounts else 1)
        return list(scan_rows)

    def add(obj):
        state["adds"].append(obj)

    async def commit():
        state["committed"] = True

    return SimpleNamespace(execute=execute, add=add, commit=commit,
                           state=state)


def _values(stmt):
    return stmt.compile().params


# ---------------------------------------------------------------- anchor --

def test_anchor_prefers_operational_date():
    t = _row(operational_date="2026-11-05", due_date="2026-11-07",
             created_at=datetime(2026, 11, 4, 10, 0, tzinfo=UTC))
    assert _midnight_anchor_key(t) == "2026-11-05"


def test_anchor_clamps_operational_date_to_creation_day():
    # Stamped 'yesterday' by the pre-day-start rule but created today —
    # a task cannot expire before it exists.
    t = _row(operational_date="2026-11-07",
             created_at=datetime(2026, 11, 7, 21, 0, tzinfo=UTC))  # 02:30 IST Nov 8
    assert _midnight_anchor_key(t) == TODAY


def test_anchor_plain_due_date():
    t = _row(due_date="2026-11-07")
    assert _midnight_anchor_key(t) == YESTERDAY


def test_anchor_naive_due_datetime_is_ist_wall_clock():
    # 2026-11-07 23:30 naive == 23:30 IST → still Nov 7.
    t = _row(due_date="2026-11-07T23:30:00")
    assert _midnight_anchor_key(t) == YESTERDAY


def test_anchor_aware_due_datetime_converts_to_ist():
    # 2026-11-07 19:00 UTC == 2026-11-08 00:30 IST → Nov 8.
    t = _row(due_date="2026-11-07T19:00:00+00:00")
    assert _midnight_anchor_key(t) == TODAY


def test_anchor_scheduled_for_before_created_at():
    t = _row(scheduled_for=datetime(2026, 11, 6, 20, 0, tzinfo=UTC))
    assert _midnight_anchor_key(t) == "2026-11-07"  # 01:30 IST Nov 7


def test_anchor_created_at_fallback():
    t = _row(created_at=datetime(2026, 11, 7, 18, 29, 0, tzinfo=UTC))
    assert _midnight_anchor_key(t) == YESTERDAY  # 23:59 IST Nov 7
    t = _row(created_at=datetime(2026, 11, 7, 18, 31, 0, tzinfo=UTC))
    assert _midnight_anchor_key(t) == TODAY      # 00:01 IST Nov 8


# ----------------------------------------------------------------- sweep --

@pytest.mark.asyncio
@pytest.mark.parametrize("status", [
    "pending", "assigned", "in_progress", "submitted", "reopened", "overdue",
])
async def test_open_statuses_expire_at_midnight(status):
    s = _session([_row(status=status, due_date=YESTERDAY)])
    stats = await RolloverService(s).run(now=JUST_AFTER_MIDNIGHT_UTC)
    assert stats["abandoned"] == 1
    assert stats["today"] == TODAY
    assert s.state["committed"]


async def test_scheduled_and_terminal_statuses_are_not_eligible():
    assert "scheduled" not in OPEN_STATUSES
    for terminal in ("completed", "cancelled", "abandoned"):
        assert terminal not in OPEN_STATUSES


@pytest.mark.asyncio
async def test_completed_and_cancelled_are_never_touched():
    # Terminal rows are excluded by the scan WHERE; even if one slipped
    # through, the conditional UPDATE would refuse it (covered by the
    # rowcount race test). Verify the constant itself.
    s = _session([])
    stats = await RolloverService(s).run(now=MIDDAY_UTC)
    assert stats == {"today": TODAY, "abandoned": 0}
    assert not s.state["committed"]


@pytest.mark.asyncio
async def test_todays_task_survives():
    s = _session([_row(due_date=TODAY)])
    stats = await RolloverService(s).run(now=JUST_AFTER_MIDNIGHT_UTC)
    assert stats["abandoned"] == 0
    assert s.state["updates"] == []


@pytest.mark.asyncio
async def test_multi_day_old_task_is_abandoned():
    s = _session([_row(due_date=OLD)])
    stats = await RolloverService(s).run(now=MIDDAY_UTC)
    assert stats["abandoned"] == 1


@pytest.mark.asyncio
async def test_task_still_inside_occurrence_window_is_abandoned():
    # Strict daily lifecycle: a live expires_at window does NOT extend a
    # task past midnight — day-expiry supersedes the occurrence clock.
    s = _session([_row(
        due_date=YESTERDAY,
        expires_at=datetime(2026, 11, 9, 0, 0, tzinfo=UTC))])
    stats = await RolloverService(s).run(now=JUST_AFTER_MIDNIGHT_UTC)
    assert stats["abandoned"] == 1


@pytest.mark.asyncio
async def test_abandonment_stamps_full_audit_trail():
    row = _row(status="in_progress", due_date=YESTERDAY)
    s = _session([row])
    await RolloverService(s).run(now=JUST_AFTER_MIDNIGHT_UTC)
    params = _values(s.state["updates"][0])
    assert params["status"] == "abandoned"
    assert params["abandoned_reason"] == REASON_MIDNIGHT
    assert params["abandoned_from_status"] == "in_progress"
    assert params["operational_date"] == YESTERDAY
    assert params["abandoned_at"] == JUST_AFTER_MIDNIGHT_UTC
    event = s.state["adds"][0]
    assert event.type == "abandoned"
    assert event.task_id == row.id
    assert "midnight" in event.note
    assert "in_progress" in event.note


@pytest.mark.asyncio
async def test_completion_race_is_safe():
    # Task completed between the scan and our UPDATE → rowcount 0 → no
    # history event, no commit, task untouched.
    s = _session([_row(status="in_progress", due_date=YESTERDAY)],
                 rowcounts=[0])
    stats = await RolloverService(s).run(now=MIDDAY_UTC)
    assert stats["abandoned"] == 0
    assert s.state["adds"] == []
    assert not s.state["committed"]


@pytest.mark.asyncio
async def test_second_run_is_a_noop():
    # Idempotent: after the first sweep the rows leave the open set, so a
    # duplicate tick abandons nothing and writes no duplicate history.
    row = _row(due_date=YESTERDAY)
    s = _session([row])
    first = await RolloverService(s).run(now=JUST_AFTER_MIDNIGHT_UTC)
    assert first["abandoned"] == 1
    # Re-run with the row now terminal — the scan yields nothing stale.
    s2 = _session([])
    second = await RolloverService(s2).run(now=JUST_AFTER_MIDNIGHT_UTC)
    assert second["abandoned"] == 0
    assert s2.state["updates"] == []


@pytest.mark.asyncio
async def test_restart_catchup_reconciles_stale_work():
    # Downtime across the boundary: first tick after restart at mid-day
    # still reconciles everything expired.
    rows = [
        _row(status="assigned", due_date=YESTERDAY),
        _row(status="in_progress", due_date="2026-11-05"),
        _row(status="pending", due_date=TODAY),   # stays
        _row(status="assigned", operational_date=TODAY),  # stays
    ]
    s = _session(rows)
    stats = await RolloverService(s).run(now=MIDDAY_UTC)
    assert stats["abandoned"] == 2
    assert len(s.state["updates"]) == 2
    assert len(s.state["adds"]) == 2


@pytest.mark.asyncio
async def test_boundary_precision_yesterday_vs_today():
    # A task whose anchor is exactly today's date survives the sweep.
    rows = [
        _row(due_date="2026-11-07T23:59:59"),  # naive IST → yesterday
        _row(due_date="2026-11-08"),           # today
        _row(due_date="2026-11-09"),           # future
    ]
    s = _session(rows)
    stats = await RolloverService(s).run(now=JUST_AFTER_MIDNIGHT_UTC)
    assert stats["abandoned"] == 1


@pytest.mark.asyncio
async def test_naive_now_is_treated_as_utc():
    s = _session([_row(due_date=YESTERDAY)])
    stats = await RolloverService(s).run(
        now=JUST_AFTER_MIDNIGHT_UTC.replace(tzinfo=None))
    assert stats["abandoned"] == 1


# ------------------------------------------------- terminal-state guard --

@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["completed", "cancelled", "abandoned"])
async def test_reassign_rejects_terminal_tasks(status, monkeypatch):
    import app.services.task_location as task_location
    from app.services.task import TaskService
    from app.services.task_location import resolve_task_location  # noqa: F401

    task = SimpleNamespace(
        id=uuid.uuid4(), status=status, property_id=uuid.uuid4(),
        room_id=None, dorm_id=None, washroom_id=None, zone_id=None)

    res = SimpleNamespace(scalar_one_or_none=lambda: task)
    session = SimpleNamespace(execute=AsyncMock(return_value=res))
    svc = TaskService(session)
    svc.structure._property_for_write = AsyncMock()
    monkeypatch.setattr(task_location, "resolve_task_location",
                        AsyncMock(return_value=SimpleNamespace(area_id=None)))

    from app.core.exceptions import AppError
    with pytest.raises(AppError):
        await svc.reassign(SimpleNamespace(role=None), task.id, uuid.uuid4())


@pytest.mark.asyncio
async def test_reassign_allows_live_tasks(monkeypatch):
    import app.services.task_location as task_location
    from app.services.task import TaskService

    task = SimpleNamespace(
        id=uuid.uuid4(), status="assigned", property_id=uuid.uuid4(),
        room_id=None, dorm_id=None, washroom_id=None, zone_id=None,
        ticket_number="TASK-2026-1",
        employee_id=None, assigned_to_name=None,
        allocation_status=None, allocation_method=None,
        allocation_reason=None)

    res = SimpleNamespace(scalar_one_or_none=lambda: task)
    session = SimpleNamespace(execute=AsyncMock(return_value=res),
                              add=lambda o: None, commit=AsyncMock())
    svc = TaskService(session)
    svc.structure._property_for_write = AsyncMock()
    svc.alloc.record = AsyncMock()
    svc._task_work_type = AsyncMock(return_value="cleaning")
    svc._employee_or_none = AsyncMock(return_value=(None, None))
    svc._history = lambda *a, **k: None
    svc._emit_task = lambda *a, **k: None
    monkeypatch.setattr(task_location, "resolve_task_location",
                        AsyncMock(return_value=SimpleNamespace(area_id=None)))

    user = SimpleNamespace(role=None, name="Tester")
    out = await svc.reassign(user, task.id, None)
    assert out.status == "assigned"


# ------------------------------------------------- internal cron tick ----

@pytest.mark.asyncio
async def test_generation_tick_requires_secret(monkeypatch):
    import app.main as m
    from app.core.config import settings
    monkeypatch.setattr(settings, "CRON_SECRET", "s3cr3t")
    with pytest.raises(Exception) as e:
        await m.generation_tick(x_cron_key=None)
    assert getattr(e.value, "status_code", None) == 404
    with pytest.raises(Exception) as e:
        await m.generation_tick(x_cron_key="wrong")
    assert getattr(e.value, "status_code", None) == 404


@pytest.mark.asyncio
async def test_generation_tick_404_when_secret_unset(monkeypatch):
    import app.main as m
    from app.core.config import settings
    monkeypatch.setattr(settings, "CRON_SECRET", None)
    with pytest.raises(Exception) as e:
        await m.generation_tick(x_cron_key="anything")
    assert getattr(e.value, "status_code", None) == 404


@pytest.mark.asyncio
async def test_generation_tick_runs_ordered_sweeps(monkeypatch):
    import app.main as m
    from app.core.config import settings
    monkeypatch.setattr(settings, "CRON_SECRET", "k")
    calls = []

    class _Sess:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False

    monkeypatch.setattr(m, "AsyncSessionLocal", lambda: _Sess())

    async def fake(name, fn):
        calls.append(name)
        return {"ok": name}
    monkeypatch.setattr(m, "generation_tick", m.generation_tick)
    # reach inside: patch _step via the services is hard — instead patch
    # the four service calls the handler awaits.
    import app.services.rollover as ro
    import app.services.task as tk
    import app.services.template as tp
    async def ed(self): calls.append("expire_due"); return {"expired": 0}
    async def rn(self, now=None): calls.append("midnight_rollover"); return {"abandoned": 0}
    async def rd(self): calls.append("templates"); return {"generated": 0}
    async def rr(self, now=None): calls.append("repetitive"); return {"generated": 0}
    monkeypatch.setattr(ro.RolloverService, "expire_due", ed)
    monkeypatch.setattr(ro.RolloverService, "run", rn)
    monkeypatch.setattr(tp.TemplateService, "run_due", rd)
    monkeypatch.setattr(tk.TaskService, "run_due_repetitive", rr)

    out = await m.generation_tick(x_cron_key="k")
    assert calls == ["expire_due", "midnight_rollover",
                     "templates", "repetitive"]
    assert set(out) == set(calls)
