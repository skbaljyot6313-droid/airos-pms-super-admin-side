"""on_duty() truth table — evaluated against real rows on SQLite.

Allocation only hands work to employees for whom this predicate holds
(open, started workday for today's op-date, no open break)."""
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models import Base
from app.models.attendance import AttendanceBreak, AttendanceDay, on_duty

DAY = "2026-11-21"


@pytest.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    tables = [AttendanceDay.__table__, AttendanceBreak.__table__]
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=tables))
    async with async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)() as s:
        yield s
    await engine.dispose()


async def _check(session, emp, op_date=DAY) -> bool:
    return bool(await session.scalar(select(on_duty(emp, op_date))))


def _day(emp, **over):
    fields = dict(
        property_id=uuid.uuid4(), employee_id=emp, employee_name="E",
        attendance_date=DAY, status="present", started_at=datetime.now(UTC),
    )
    fields.update(over)
    return AttendanceDay(**fields)


async def test_no_row_is_not_on_duty(db):
    assert await _check(db, uuid.uuid4()) is False


async def test_started_open_day_is_on_duty(db):
    emp = uuid.uuid4()
    db.add(_day(emp))
    await db.commit()
    assert await _check(db, emp) is True


async def test_not_started_day_is_not_on_duty(db):
    emp = uuid.uuid4()
    db.add(_day(emp, started_at=None))
    await db.commit()
    assert await _check(db, emp) is False


async def test_ended_day_is_not_on_duty(db):
    emp = uuid.uuid4()
    db.add(_day(emp, ended_at=datetime.now(UTC)))
    await db.commit()
    assert await _check(db, emp) is False


async def test_open_break_is_not_on_duty_and_resume_restores(db):
    emp = uuid.uuid4()
    day = _day(emp)
    db.add(day)
    await db.flush()
    br = AttendanceBreak(attendance_day_id=day.id, started_at=datetime.now(UTC))
    db.add(br)
    await db.commit()
    assert await _check(db, emp) is False

    br.ended_at = datetime.now(UTC)
    await db.commit()
    assert await _check(db, emp) is True


async def test_other_operational_date_is_not_on_duty(db):
    emp = uuid.uuid4()
    db.add(_day(emp))
    await db.commit()
    assert await _check(db, emp, op_date="2026-11-22") is False
