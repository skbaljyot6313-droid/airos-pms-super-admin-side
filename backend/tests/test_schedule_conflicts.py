"""Shared schedule rules — conflict detection, windows, overdue.

Exercises ``app.domain.schedule_conflicts`` — the module mirrored
byte-identical in the Employee backend — over in-memory SQLite (same
AsyncShim pattern as test_departments). These rules keep the SA work
calendar and the mobile calendar interpreting assignments identically.
"""

import uuid
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.domain.schedule_conflicts import (
    IST,
    assignment_conflicts,
    hm,
    is_overdue,
    parse_dt,
    scheduled_end,
    task_day,
    task_window,
)
from app.models.employee import Employee
from app.models.task import Task

CID = uuid.uuid4()
PID = uuid.uuid4()
EID = uuid.uuid4()


class AsyncShim:
    """Minimal AsyncSession facade over a sync Session."""

    def __init__(self, sync: Session):
        self._s = sync

    async def execute(self, stmt):
        return self._s.execute(stmt)

    def add(self, obj):
        self._s.add(obj)

    def add_all(self, objs):
        self._s.add_all(objs)

    async def flush(self):
        self._s.flush()

    async def commit(self):
        self._s.commit()


@pytest.fixture
def session():
    engine = create_engine("sqlite://")
    for model in (Employee, Task):
        model.__table__.create(engine)
    with Session(engine) as s:
        yield AsyncShim(s)


def _task(**kw) -> Task:
    base = dict(
        id=uuid.uuid4(), property_id=PID, title="Clean corridor",
        status="assigned", task_type="fixed", employee_id=EID,
    )
    base.update(kw)
    return Task(**base)


# --- pure helpers -----------------------------------------------------------

def test_hm_parses_and_rejects():
    assert hm("09:30") == 570
    assert hm("23:59") == 1439
    assert hm(None) is None
    assert hm("") is None
    assert hm("bad") is None


def test_task_day_prefers_scheduled_for_then_due_date():
    # naive scheduled_for is read as IST
    t = _task(scheduled_for=datetime(2026, 11, 25, 9, 0))
    assert task_day(t) == "2026-11-25"
    # UTC instant late in the day still lands on the IST date
    t2 = _task(scheduled_for=datetime(2026, 11, 25, 20, 0, tzinfo=UTC))
    assert task_day(t2) == "2026-11-26"  # 01:30 IST next day
    t3 = _task(due_date="2026-11-25", scheduled_for=None)
    assert task_day(t3) == "2026-11-25"
    t4 = _task(operational_date="2026-11-24")
    assert task_day(t4) == "2026-11-24"
    assert task_day(_task()) is None


def test_task_window_explicit_and_fallback():
    assert task_window(_task(start_time="09:00", end_time="17:00")) == (540, 1020)
    # due_time is the start fallback; end stays None (open-ended)
    assert task_window(_task(due_time="14:00")) == (840, None)
    assert task_window(_task()) == (None, None)


def test_scheduled_end_overnight_rolls_forward():
    t = _task(due_date="2026-11-25", start_time="22:00", end_time="02:00")
    end = scheduled_end(t)
    assert end is not None
    assert end.date().isoformat() == "2026-11-26"
    assert (end.hour, end.minute) == (2, 0)


def test_is_overdue_respects_terminal_states_and_clock():
    past = _task(due_date="2026-11-20", start_time="09:00", end_time="10:00")
    assert is_overdue(past, now=datetime(2026, 11, 21, 0, 0, tzinfo=IST))
    assert not is_overdue(past, now=datetime(2026, 11, 20, 9, 30, tzinfo=IST))
    for status in ("completed", "cancelled", "submitted", "abandoned"):
        assert not is_overdue(
            _task(status=status, due_date="2026-11-20",
                  start_time="09:00", end_time="10:00"),
            now=datetime(2026, 11, 21, tzinfo=IST))
    # No schedule at all → never overdue
    assert not is_overdue(_task(status="assigned"))


def test_parse_dt_naive_is_ist():
    dt = parse_dt("2026-11-25T09:00:00")
    assert dt is not None and dt.tzinfo is not None
    # 09:00 IST == 03:30 UTC
    assert (dt.hour, dt.minute) == (3, 30)
    aware = parse_dt("2026-11-25T09:00:00+00:00")
    assert aware is not None and (aware.hour, aware.minute) == (9, 0)
    assert parse_dt("not-a-date") is None
    assert parse_dt(None) is None


# --- conflict detection over the shared tasks table -------------------------

async def test_overlap_conflict_detected(session):
    session.add(_task(due_date="2026-11-25", start_time="09:00", end_time="13:00"))
    await session.commit()
    emp = SimpleNamespace(id=EID, name="Ram")
    conflicts = await assignment_conflicts(
        session, {EID: emp},
        target_day="2026-11-25", start=720, end=1080,  # 12:00–18:00
        title="Other job", property_id=PID)
    assert len(conflicts) == 1
    c = conflicts[0]
    assert c["kind"] == "overlap"
    assert c["employee_uid"] == str(EID)
    assert c["start_time"] == "09:00" and c["end_time"] == "13:00"


async def test_duplicate_title_same_day_conflicts(session):
    session.add(_task(title="Same job", due_date="2026-11-25",
                      start_time="09:00", end_time="10:00"))
    await session.commit()
    emp = SimpleNamespace(id=EID, name="Ram")
    conflicts = await assignment_conflicts(
        session, {EID: emp},
        target_day="2026-11-25", start=1200, end=1320,
        title="same job", property_id=PID)  # case-insensitive
    assert conflicts[0]["kind"] == "duplicate"


async def test_no_conflict_other_day_or_employee(session):
    session.add(_task(due_date="2026-11-25", start_time="09:00", end_time="13:00"))
    other_emp = uuid.uuid4()
    session.add(_task(due_date="2026-11-25", start_time="09:00",
                      end_time="13:00", employee_id=other_emp))
    await session.commit()
    emp = SimpleNamespace(id=EID, name="Ram")
    # different day → nothing
    assert await assignment_conflicts(
        session, {EID: emp}, target_day="2026-11-26",
        start=600, end=700, title="X", property_id=PID) == []
    # same window but only the OTHER employee is targeted → nothing for EID
    assert await assignment_conflicts(
        session, {other_emp: SimpleNamespace(id=other_emp, name="Z")},
        target_day="2026-11-26", start=600, end=700,
        title="X", property_id=PID) == []


async def test_terminal_and_excluded_rows_never_conflict(session):
    cancelled = _task(status="cancelled", due_date="2026-11-25",
                      start_time="09:00", end_time="13:00")
    keep = _task(due_date="2026-11-25", start_time="09:00", end_time="13:00")
    session.add_all([cancelled, keep])
    await session.commit()
    emp = SimpleNamespace(id=EID, name="Ram")
    # cancelled row is invisible
    assert await assignment_conflicts(
        session, {EID: emp}, target_day="2026-11-25",
        start=600, end=700, title="X", property_id=PID,
        exclude_task_ids={keep.id}) == []
    # excluding the only conflicting row → clean
    assert await assignment_conflicts(
        session, {EID: emp}, target_day="2026-11-25",
        start=600, end=700, title="X", property_id=PID,
        exclude_task_ids={keep.id, cancelled.id}) == []


async def test_windowless_task_only_duplicate_conflicts(session):
    session.add(_task(title="Unscheduled", due_date="2026-11-25"))
    await session.commit()
    emp = SimpleNamespace(id=EID, name="Ram")
    # overlapping window but the existing row has no window → no overlap
    assert await assignment_conflicts(
        session, {EID: emp}, target_day="2026-11-25",
        start=600, end=700, title="Different", property_id=PID) == []
    # same title → duplicate
    dup = await assignment_conflicts(
        session, {EID: emp}, target_day="2026-11-25",
        start=600, end=700, title="Unscheduled", property_id=PID)
    assert dup[0]["kind"] == "duplicate"
