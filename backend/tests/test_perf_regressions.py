"""Latency-regression tests — guard the query-count fixes for the
Occupied → Unoccupied path.

Every fix here removes a redundant remote round trip (~200ms each on the
production WAN), so the tests assert on WHAT the code no longer asks the
session to execute rather than on wall-clock time.
"""

import uuid
from types import SimpleNamespace

import pytest

from app.domain.resource_events import SRC_OCCUPANCY_CHECKOUT
from app.models.structure import Room
from app.models.user import UserRole
from app.schemas.workspace import mark_open_occupancy
from app.services.occupancy import OccupancyService
from app.services.resource_state import ResourceStateService
from app.services.structure import ConflictErr

CID = uuid.uuid4()
PID = uuid.uuid4()
RID = uuid.uuid4()

PROP = SimpleNamespace(id=PID, company_id=CID)

SA_USER = SimpleNamespace(
    id=uuid.uuid4(), role=UserRole.SUPER_ADMIN,
    company_id=CID, property_id=PID, name="Admin",
)


class _Res:
    def __init__(self, rows):
        self.rows = list(rows) if isinstance(rows, (list, tuple)) else [rows]

    def scalar_one_or_none(self):
        return self.rows[0] if self.rows else None

    def scalar(self):
        return self.rows[0] if self.rows else None

    def scalars(self):
        return self

    def unique(self):
        return self

    def all(self):
        return self.rows

    def first(self):
        return self.rows[0] if self.rows else None

    def __iter__(self):
        return iter(self.rows)


class _Session:
    """Scripted session — counts execute() calls and pops canned results."""
    def __init__(self, executes=(), get_obj=None):
        self._execs = list(executes)
        self._get = get_obj
        self.exec_count = 0
        self.added = []
        self.info = {}

    async def execute(self, _q, *args, **kwargs):
        self.exec_count += 1
        rows = self._execs.pop(0) if self._execs else []
        return _Res(rows)

    async def get(self, _m, _id):
        return self._get

    async def scalar(self, _q):
        return None

    def add(self, o):
        self.added.append(o)

    async def flush(self):
        pass

    async def commit(self):
        pass


@pytest.mark.anyio
class TestCheckoutQueryCount:
    async def test_no_double_occupancy_load_on_conflict(self):
        """check_out_room used to SELECT the open occupancy twice (once
        for the conflict check, once inside checkout_units). With a
        non-checkoutable room the whole path must cost exactly two
        round trips: the joined room+property lock and the batched
        occupancy map."""
        room = Room(id=RID, property_id=PID, status="available")
        sess = _Session(
            executes=[
                [(room, PROP)],  # _lock_room joined select
                [],              # _open_occupancy_map — nothing open
            ],
            get_obj=PROP,
        )
        with pytest.raises(ConflictErr):
            await OccupancyService(sess).check_out_room(SA_USER, RID)
        assert sess.exec_count == 2


@pytest.mark.anyio
class TestTransitionLockedRow:
    async def test_locked_row_skips_reselect(self):
        """A caller holding FOR UPDATE on the row must not pay a second
        SELECT to re-lock it inside transition()."""
        room = Room(id=RID, property_id=PID, status="occupied")
        sess = _Session(get_obj=PROP)  # for _check_scope's property get
        await ResourceStateService(sess).transition(
            "room", RID, "cleaning", user=SA_USER,
            source=SRC_OCCUPANCY_CHECKOUT, locked_row=room,
        )
        assert room.status == "cleaning"
        # zero SELECTs — the only session traffic was flush() (no-ops)
        assert sess.exec_count == 0

    async def test_without_locked_row_still_locks(self):
        room = Room(id=RID, property_id=PID, status="occupied")
        sess = _Session(executes=[[room]], get_obj=PROP)
        await ResourceStateService(sess).transition(
            "room", RID, "cleaning", user=SA_USER,
            source=SRC_OCCUPANCY_CHECKOUT,
        )
        assert room.status == "cleaning"
        assert sess.exec_count == 1  # the FOR UPDATE re-select


@pytest.mark.anyio
class TestMarkOpenOccupancy:
    async def test_stamped_units_skip_query(self):
        """Units whose occupancy was already resolved upstream must not
        trigger a second occupancy SELECT at serialization time."""
        room = Room(id=RID, property_id=PID, status="cleaning")
        room._open_occupancy = False
        sess = _Session()
        await mark_open_occupancy(sess, rooms=[room])
        assert sess.exec_count == 0
        assert room._open_occupancy is False

    async def test_unstamped_units_still_query(self):
        room = Room(id=RID, property_id=PID, status="occupied")
        sess = _Session(executes=[[(RID, None)]])
        await mark_open_occupancy(sess, rooms=[room])
        assert sess.exec_count == 1
        assert room._open_occupancy is True
