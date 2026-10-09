"""Shift scheduling + schedule-aware attendance tests.

Levels:
  1. pure helpers — shift_window_utc / shift_applies_on
  2. current_work_statuses — stale/overnight gating for floor visibility
  3. day_status_board — metrics (late/early/absent/overnight/unscheduled)
  4. routes — CRUD, assignment overlap, SA/PM permission boundaries
"""

import uuid
from datetime import datetime, time, timedelta, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import httpx
import pytest

from app.models.attendance import AttendanceBreak, AttendanceDay
from app.models.employee import Employee
from app.models.shift import EmployeeShiftAssignment, Shift
from app.services.attendance import current_work_statuses, day_status_board
from app.services.shifts import shift_applies_on, shift_window_utc

IST = ZoneInfo("Asia/Kolkata")
UTC = timezone.utc

CID = uuid.uuid4()
PID = uuid.uuid4()
EID = uuid.uuid4()


def ist(hh: int, mm: int, d: str = "2026-10-08") -> datetime:
    """IST wall-clock on `d` → aware UTC instant."""
    y, m, dd = (int(p) for p in d.split("-"))
    return datetime(y, m, dd, hh, mm, tzinfo=IST).astimezone(UTC)


def _shift(**kw) -> Shift:
    base = dict(
        id=uuid.uuid4(), company_id=CID, property_id=PID,
        name="Morning", start_time=time(9, 0), end_time=time(17, 0),
        grace_minutes=10, early_exit_minutes=0,
        working_days="1111111", is_active=True,
    )
    base.update(kw)
    return Shift(**base)


def _emp(**kw) -> Employee:
    base = dict(
        id=EID, company_id=CID, property_id=PID,
        name="Baldev", email="b@x.co", status="Active",
        job_title=None, zone_id=None,
    )
    base.update(kw)
    return Employee(**base)


def _day(date="2026-10-08", status="present", **kw) -> AttendanceDay:
    base = dict(
        id=uuid.uuid4(), property_id=PID, employee_id=EID,
        employee_name="Baldev", attendance_date=date, status=status,
        started_at=None, ended_at=None, work_seconds=None,
    )
    base.update(kw)
    return AttendanceDay(**base)


def _assign(shift: Shift, **kw) -> EmployeeShiftAssignment:
    base = dict(
        id=uuid.uuid4(), employee_id=EID, shift_id=shift.id,
        effective_from="2026-01-01", effective_until=None,
    )
    base.update(kw)
    return EmployeeShiftAssignment(**base)


class _Res:
    def __init__(self, rows):
        self.rows = list(rows)

    def scalars(self):
        return self

    def all(self):
        return self.rows

    def first(self):
        return self.rows[0] if self.rows else None

    def __iter__(self):
        return iter(self.rows)


class _SeqSession:
    """Scripted AsyncSession — scalars() pops in order, execute() pops
    canned row-lists in order."""
    def __init__(self, scalars=(), executes=(), get_obj=None):
        self._scalars = list(scalars)
        self._execs = list(executes)
        self._get = get_obj
        self.added = []
        self.deleted = []

    async def scalar(self, _q):
        return self._scalars.pop(0) if self._scalars else None

    async def get(self, _m, _id):
        return self._get

    async def execute(self, _q):
        rows = self._execs.pop(0) if self._execs else []
        return _Res(rows)

    def add(self, o):
        self.added.append(o)

    async def commit(self):
        pass

    async def flush(self):
        pass

    async def delete(self, o):
        self.deleted.append(o)


PROP = SimpleNamespace(id=PID, company_id=CID)
COMPANY = SimpleNamespace(operational_day_start=None)
from app.models.user import UserRole

SA_USER = SimpleNamespace(
    id=uuid.uuid4(), role=UserRole.SUPER_ADMIN,
    company_id=CID, property_id=None, name="Admin",
)


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


class TestShiftHelpers:
    def test_window_same_day(self):
        s, e = shift_window_utc(_shift(), "2026-10-08")
        assert s == ist(9, 0) and e == ist(17, 0)

    def test_window_overnight(self):
        s, e = shift_window_utc(
            _shift(start_time=time(22, 0), end_time=time(6, 0)),
            "2026-10-08",
        )
        assert s == ist(22, 0, "2026-10-08")
        assert e == ist(6, 0, "2026-10-09")

    def test_applies_on_bitmap(self):
        # 2026-10-08 is a Thursday (index 3)
        only_thu = _shift(working_days="0001000")
        assert shift_applies_on(only_thu, "2026-10-08")
        assert not shift_applies_on(only_thu, "2026-10-09")


# ---------------------------------------------------------------------------
# Floor eligibility — stale open-day gating in current_work_statuses
# ---------------------------------------------------------------------------


@pytest.mark.anyio
class TestFloorStaleGating:
    USER = SimpleNamespace(company_id=CID)

    async def test_todays_open_day_is_working(self):
        now = datetime(2026, 10, 9, 4, 0, tzinfo=UTC)  # 09:30 IST
        today_key = "2026-10-09"
        day = _day(date=today_key, started_at=now - timedelta(hours=1))
        out = await current_work_statuses(
            _SeqSession(get_obj=COMPANY, executes=[[day], []]),
            self.USER, [EID], now=now,
        )
        assert out[EID]["state"] == "working"

    async def test_old_open_day_fails_closed(self):
        """Open day from a previous op-day, no overnight cover → excluded."""
        now = datetime(2026, 10, 9, 4, 0, tzinfo=UTC)
        day = _day(
            date="2026-10-08",
            started_at=ist(8, 37, "2026-10-08"),
        )
        out = await current_work_statuses(
            _SeqSession(get_obj=COMPANY, executes=[[day]]),
            self.USER, [EID], now=now,
        )
        st = out[EID]
        assert st["state"] == "unknown"
        assert st["needs_review"] is True

    async def test_overnight_shift_keeps_prior_day_open_valid(self):
        """Yesterday's open day + overnight shift still in window → working."""
        now = datetime(2026, 10, 9, 1, 0, tzinfo=UTC)  # 06:30 IST
        day = _day(
            date="2026-10-08",
            started_at=ist(22, 5, "2026-10-08"),
        )
        night = _shift(start_time=time(22, 0), end_time=time(6, 0))
        a = _assign(night)
        out = await current_work_statuses(
            _SeqSession(
                get_obj=COMPANY,
                executes=[[day], [], [(a, night)]],
            ),
            self.USER, [EID], now=now,
        )
        # window ends 06:00 IST (=00:30 UTC) + 120m carryover = 02:30 UTC
        assert out[EID]["state"] == "working"

    async def test_overnight_shift_past_carryover_is_stale(self):
        now = datetime(2026, 10, 9, 3, 0, tzinfo=UTC)  # past 02:30 cutoff
        day = _day(
            date="2026-10-08",
            started_at=ist(22, 5, "2026-10-08"),
        )
        night = _shift(start_time=time(22, 0), end_time=time(6, 0))
        a = _assign(night)
        out = await current_work_statuses(
            _SeqSession(
                get_obj=COMPANY,
                executes=[[day], [], [(a, night)]],
            ),
            self.USER, [EID], now=now,
        )
        assert out[EID]["state"] == "unknown"
        assert out[EID]["needs_review"] is True


# ---------------------------------------------------------------------------
# day_status_board — schedule-aware metrics
# ---------------------------------------------------------------------------


@pytest.mark.anyio
class TestDayStatusBoard:
    NOW = datetime(2026, 10, 9, 4, 0, tzinfo=UTC)  # 09:30 IST → today=10-09

    async def _board(self, executes, op_date="2026-10-09", user=None):
        sess = _SeqSession(
            scalars=[PROP], get_obj=COMPANY, executes=executes
        )
        return await day_status_board(
            sess, user or SA_USER, PID, op_date=op_date, now=self.NOW
        )

    async def test_completed_on_time(self):
        shift = _shift()
        day = _day(
            date="2026-10-08",
            started_at=ist(9, 5),   # within 10m grace
            ended_at=ist(17, 10),
            work_seconds=28500,
        )
        b = await self._board(
            [[_emp()], [day], [], [(_assign(shift), shift)]],
            op_date="2026-10-08",
        )
        e = b["employees"][0]
        assert e["status"] == "completed"
        assert e["arrival"] == "on_time"
        assert e["departure"] == "on_time"
        assert e["scheduled"] is True

    async def test_late_entry(self):
        shift = _shift()
        day = _day(date="2026-10-08", started_at=ist(9, 20),
                   ended_at=ist(17, 5))
        b = await self._board(
            [[_emp()], [day], [], [(_assign(shift), shift)]],
            op_date="2026-10-08",
        )
        e = b["employees"][0]
        assert e["status"] == "completed"
        assert e["arrival"] == "late"

    async def test_early_exit(self):
        shift = _shift(early_exit_minutes=15)
        day = _day(date="2026-10-08", started_at=ist(9, 0),
                   ended_at=ist(16, 30))  # end-15m = 16:45 → early
        b = await self._board(
            [[_emp()], [day], [], [(_assign(shift), shift)]],
            op_date="2026-10-08",
        )
        assert b["employees"][0]["departure"] == "early"

    async def test_schedule_exempt_never_absent(self):
        """PM/SA-linked employees work 24×7 — a stale assignment can
        never mark them absent."""
        shift = _shift()
        # executes: employees, days, assignments, exempt user ids
        b = await self._board(
            [[_emp()], [], [(_assign(shift), shift)], [EID]],
            op_date="2026-10-08",
        )
        e = b["employees"][0]
        assert e["status"] == "not_scheduled"
        assert e["schedule_exempt"] is True
        assert e["label"] == "24×7 duty"
        assert e["scheduled"] is False

    async def test_absent_past_day(self):
        shift = _shift()
        b = await self._board(
            [[_emp()], [], [(_assign(shift), shift)]],
            op_date="2026-10-08",
        )
        assert b["employees"][0]["status"] == "absent"

    async def test_absent_today_after_cutoff(self):
        # now = 09:30 IST; shift starts 08:00 + 10m grace → past cutoff
        shift = _shift(start_time=time(8, 0))
        b = await self._board(
            [[_emp()], [], [(_assign(shift), shift)]],
        )
        assert b["employees"][0]["status"] == "absent"

    async def test_awaiting_before_cutoff(self):
        # shift starts 10:30 IST (05:00 UTC) — now 04:00 UTC, inside window
        shift = _shift(start_time=time(10, 30))
        b = await self._board(
            [[_emp()], [], [(_assign(shift), shift)]],
        )
        assert b["employees"][0]["status"] == "awaiting"

    async def test_working_and_on_break(self):
        today_key = "2026-10-09"
        day = _day(date=today_key, started_at=self.NOW - timedelta(hours=2))
        br = AttendanceBreak(
            attendance_day_id=day.id,
            started_at=self.NOW - timedelta(minutes=15), ended_at=None,
        )
        b = await self._board([[_emp()], [day], [br], []])
        assert b["employees"][0]["status"] == "on_break"

    async def test_unscheduled_attendance_flagged(self):
        day = _day(date="2026-10-09",
                   started_at=self.NOW - timedelta(hours=1))
        b = await self._board([[_emp()], [day], [], []])
        e = b["employees"][0]
        assert e["status"] == "working"
        assert e["unscheduled"] is True

    async def test_not_scheduled(self):
        b = await self._board([[_emp()], [], []])
        assert b["employees"][0]["status"] == "not_scheduled"

    async def test_leave_is_off_day_not_absent(self):
        shift = _shift()
        day = _day(date="2026-10-09", status="leave")
        b = await self._board(
            [[_emp()], [day], [], [(_assign(shift), shift)]]
        )
        e = b["employees"][0]
        assert e["status"] == "off_day"
        assert e["label"] == "Leave"

    async def test_past_open_day_needs_review(self):
        # Open day on 10-08, day shift (not overnight) → incomplete.
        shift = _shift()
        day = _day(date="2026-10-08", started_at=ist(9, 0))
        b = await self._board(
            [[_emp()], [day], [], [(_assign(shift), shift)]],
            op_date="2026-10-08",
        )
        e = b["employees"][0]
        assert e["status"] == "incomplete"
        assert e["needs_review"] is True

    async def test_overnight_still_running_not_flagged(self):
        # now = 01:00 UTC (06:30 IST); overnight window ends 00:30 UTC
        # +120m carryover → still valid at 01:00.
        now = datetime(2026, 10, 9, 1, 0, tzinfo=UTC)
        shift = _shift(start_time=time(22, 0), end_time=time(6, 0))
        day = _day(date="2026-10-08", started_at=ist(22, 5))
        sess = _SeqSession(
            scalars=[PROP], get_obj=COMPANY,
            executes=[[_emp()], [day], [], [(_assign(shift), shift)]],
        )
        b = await day_status_board(
            sess, SA_USER, PID, op_date="2026-10-08", now=now
        )
        e = b["employees"][0]
        assert e["status"] == "working"
        assert e["needs_review"] is False


# ---------------------------------------------------------------------------
# Routes — CRUD + permission boundaries
# ---------------------------------------------------------------------------


class TestShiftRoutes:
    SA = SimpleNamespace(
        id=uuid.uuid4(), company_id=CID, property_id=None,
        name="Admin",
    )
    PM = SimpleNamespace(
        id=uuid.uuid4(), company_id=CID, property_id=PID,
        name="Mgr",
    )

    def _client(self, user, session):
        from app.core.database import get_db
        from app.dependencies.auth import get_current_user
        from app.main import app
        from app.models.user import UserRole

        role = {
            "sa": UserRole.SUPER_ADMIN,
            "pm": UserRole.PROPERTY_MANAGER,
            "emp": UserRole.EMPLOYEE,
        }[user]
        app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
            id=self.SA.id,
            role=role,
            company_id=CID,
            property_id=PID if role != UserRole.SUPER_ADMIN else None,
            name="U",
        )

        async def _db():
            yield session

        app.dependency_overrides[get_db] = _db
        transport = httpx.ASGITransport(app=app)
        return httpx.AsyncClient(
            transport=transport, base_url="http://sa.test"
        )

    async def test_create_shift_super_admin(self):
        sess = _SeqSession(scalars=[PROP])
        async with self._client("sa", sess) as c:
            res = await c.post(
                "/api/v1/shifts",
                json={
                    "property_uid": str(PID),
                    "name": "Morning",
                    "start_time": "09:00",
                    "end_time": "17:00",
                    "grace_minutes": 10,
                    "working_days": "1111110",
                },
            )
        assert res.status_code == 201
        body = res.json()
        assert body["name"] == "Morning"
        assert body["overnight"] is False

    async def test_create_overnight_shift_flagged(self):
        sess = _SeqSession(scalars=[PROP])
        async with self._client("sa", sess) as c:
            res = await c.post(
                "/api/v1/shifts",
                json={
                    "property_uid": str(PID),
                    "name": "Night",
                    "start_time": "22:00",
                    "end_time": "06:00",
                },
            )
        assert res.status_code == 201
        assert res.json()["overnight"] is True

    async def test_employee_role_forbidden(self):
        sess = _SeqSession()
        async with self._client("emp", sess) as c:
            res = await c.get("/api/v1/shifts")
        assert res.status_code == 403

    async def test_property_manager_own_property(self):
        sess = _SeqSession(scalars=[PROP])
        async with self._client("pm", sess) as c:
            res = await c.get("/api/v1/shifts", params={"property_id": str(PID)})
        assert res.status_code == 200

    async def test_cross_company_property_404(self):
        # property lookup returns nothing (foreign tenant) → 404
        sess = _SeqSession(scalars=[None])
        async with self._client("sa", sess) as c:
            res = await c.get(
                "/api/v1/shifts", params={"property_id": str(uuid.uuid4())}
            )
        assert res.status_code == 404

    async def test_overlapping_assignment_conflict(self):
        emp = _emp()
        shift = _shift()
        existing = _assign(shift)
        # scalars: employee, shift; executes: overlap query → existing row
        sess = _SeqSession(
            scalars=[emp, shift],
            executes=[[existing]],
        )
        async with self._client("sa", sess) as c:
            res = await c.post(
                f"/api/v1/employees/{EID}/shift-assignments",
                json={
                    "shift_uid": str(shift.id),
                    "effective_from": "2026-10-01",
                },
            )
        assert res.status_code == 409

    async def test_assign_success(self):
        emp = _emp()
        shift = _shift()
        sess = _SeqSession(scalars=[emp, shift], executes=[[]])
        async with self._client("sa", sess) as c:
            res = await c.post(
                f"/api/v1/employees/{EID}/shift-assignments",
                json={
                    "shift_uid": str(shift.id),
                    "effective_from": "2026-10-01",
                    "effective_until": "2026-12-31",
                },
            )
        assert res.status_code == 201
        assert res.json()["effective_from"] == "2026-10-01"

    async def test_pm_cannot_assign_foreign_property_employee(self):
        emp = _emp(property_id=uuid.uuid4())  # other property
        shift = _shift()
        sess = _SeqSession(scalars=[emp])
        async with self._client("pm", sess) as c:
            res = await c.post(
                f"/api/v1/employees/{EID}/shift-assignments",
                json={
                    "shift_uid": str(shift.id),
                    "effective_from": "2026-10-01",
                },
            )
        assert res.status_code == 404

    async def test_status_board_route_pm_allowed(self):
        sess = _SeqSession(
            scalars=[PROP], get_obj=COMPANY, executes=[[]]
        )
        async with self._client("pm", sess) as c:
            res = await c.get(
                "/api/v1/attendance/status-board",
                params={"property_id": str(PID)},
            )
        assert res.status_code == 200
        assert "employees" in res.json()

    async def test_current_assignments_route(self):
        shift = _shift()
        a = _assign(shift)
        # scalars: property; executes: employee ids, (assignment, shift)
        # rows, exempt user ids
        sess = _SeqSession(
            scalars=[PROP], executes=[[EID], [(a, shift)], [EID]]
        )
        async with self._client("pm", sess) as c:
            res = await c.get(
                "/api/v1/shift-assignments",
                params={"property_id": str(PID)},
            )
        assert res.status_code == 200
        items = res.json()["items"]
        assert len(items) == 1
        assert items[0]["employee_uid"] == str(EID)
        assert items[0]["shift_uid"] == str(shift.id)
        assert res.json()["exempt_employee_uids"] == [str(EID)]

    async def test_delete_assignment_same_day_allowed(self):
        today = datetime.now(IST).date().isoformat()
        a = _assign(_shift(), effective_from=today)
        # scalars: assignment, employee
        sess = _SeqSession(scalars=[a, _emp()])
        async with self._client("sa", sess) as c:
            res = await c.delete(
                f"/api/v1/shift-assignments/{a.id}"
            )
        assert res.status_code == 204
        assert sess.deleted == [a]

    async def test_delete_assignment_historical_conflict(self):
        a = _assign(_shift(), effective_from="2026-01-01")
        sess = _SeqSession(scalars=[a, _emp()])
        async with self._client("sa", sess) as c:
            res = await c.delete(
                f"/api/v1/shift-assignments/{a.id}"
            )
        assert res.status_code == 409
        assert not sess.deleted

    async def test_delete_assignment_pm_foreign_employee(self):
        a = _assign(
            _shift(),
            effective_from=datetime.now(IST).date().isoformat(),
        )
        sess = _SeqSession(
            scalars=[a, _emp(property_id=uuid.uuid4())]
        )
        async with self._client("pm", sess) as c:
            res = await c.delete(
                f"/api/v1/shift-assignments/{a.id}"
            )
        assert res.status_code == 404
