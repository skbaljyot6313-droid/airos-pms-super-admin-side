"""Live-location proxy — Employee Backend integration tests.

Every case mocks the upstream HTTP call via respx so no employee service
(or shared key) is needed. The proxy must:
  - forward GET {base}/admin/live-locations with X-Location-Service-Key
  - forward validated employee_id/property_id/zone_id/is_active params
  - pass through a valid {locations: [...]} payload (incl. stale entries
    with null coordinates; drop entries that fail validation)
  - proxy GET /admin/location-history/{id} with from/to/session/max_points
  - map upstream 400 → 400 with the upstream code
  - map upstream 401/403 → 502 LIVE_LOCATION_AUTH_REJECTED
  - map upstream 503 / transport errors → 503 LIVE_LOCATION_UNAVAILABLE
  - map malformed JSON/shape → 502 LIVE_LOCATION_UPSTREAM
  - reject is_active=false without employee_id and >31-day ranges (400)
  - fail closed (503) when unconfigured
  - keep the routes super_admin-only
"""

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import httpx
import pytest
import respx

from app.core.config import settings
from app.models.attendance import AttendanceBreak, AttendanceDay
from app.services import live_location
from app.services.attendance import current_work_statuses
from app.services.live_location import (
    LiveLocationBadRequest,
    LiveLocationUnavailable,
    LiveLocationUpstreamError,
    fetch_live_locations,
    fetch_location_history,
)

UPSTREAM = "http://employee-backend.test"
BASE = f"{UPSTREAM}/api/v1"
LIVE_URL = f"{BASE}/admin/live-locations"

EMP_ID = str(uuid.uuid4())


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    monkeypatch.setattr(settings, "EMPLOYEE_API_BASE_URL", None)
    monkeypatch.setattr(settings, "EMPLOYEE_BACKEND_URL", UPSTREAM)
    monkeypatch.setattr(settings, "LOCATION_SERVICE_API_KEY", "test-key")
    yield


def _location(uid: str = EMP_ID, **kw) -> dict:
    base = {
        "employee_id": uid,
        "latitude": 19.076,
        "longitude": 72.8777,
        "accuracy_m": 8.5,
        "speed_mps": 1.4,
        "bearing_deg": 182.0,
        "altitude_m": 14.0,
        "captured_at": "2026-10-08T11:00:00+00:00",
        "received_at": "2026-10-08T11:00:01+00:00",
        "device_timestamp": 1791283210,
        "server_timestamp": 1791283212,
        "tracking_session_id": str(uuid.uuid4()),
        "sequence_number": 17,
        "quality": "valid",
        "source": "fused",
        "is_live": True,
        "is_stale": False,
    }
    base.update(kw)
    return base


def _point(**kw) -> dict:
    base = {
        "latitude": 19.076,
        "longitude": 72.8777,
        "accuracy_m": 8.5,
        "captured_at": "2026-10-08T11:00:00+00:00",
        "received_at": "2026-10-08T11:00:01+00:00",
        "sequence_number": 17,
        "quality": "valid",
    }
    base.update(kw)
    return base


class TestLiveSuccess:
    @respx.mock
    async def test_single_location_passes_through(self):
        route = respx.get(LIVE_URL).mock(
            return_value=httpx.Response(200, json={"locations": [_location()]})
        )
        out = await fetch_live_locations()
        assert len(out["locations"]) == 1
        e = out["locations"][0]
        assert e["employee_id"] == EMP_ID
        assert e["latitude"] == 19.076
        assert e["is_live"] is True
        assert e["quality"] == "valid"
        assert e["accuracy_m"] == 8.5
        assert e["captured_at"] == "2026-10-08T11:00:00+00:00"
        # The service key went out as X-Location-Service-Key, nowhere else.
        assert route.calls[0].request.headers["x-location-service-key"] == "test-key"

    @respx.mock
    async def test_legacy_numeric_aliases_normalized(self):
        respx.get(LIVE_URL).mock(
            return_value=httpx.Response(
                200,
                json={
                    "locations": [
                        _location(
                            accuracy_m=None,
                            speed_mps=None,
                            bearing_deg=None,
                            accuracy=9.5,
                            speed=2.1,
                            heading=45,
                        )
                    ]
                },
            )
        )
        out = await fetch_live_locations()
        e = out["locations"][0]
        assert e["accuracy_m"] == 9.5
        assert e["speed_mps"] == 2.1
        assert e["bearing_deg"] == 45.0

    @respx.mock
    async def test_filters_forwarded(self):
        route = respx.get(LIVE_URL).mock(
            return_value=httpx.Response(200, json={"locations": [_location()]})
        )
        prop, zone = str(uuid.uuid4()), str(uuid.uuid4())
        await fetch_live_locations(
            employee_id=EMP_ID, property_id=prop, zone_id=zone, is_active=False
        )
        q = route.calls[0].request.url.params
        assert q["employee_id"] == EMP_ID
        assert q["property_id"] == prop
        assert q["zone_id"] == zone
        assert q["is_active"] == "false"

    @respx.mock
    async def test_stale_entry_with_null_coords_kept(self):
        respx.get(LIVE_URL).mock(
            return_value=httpx.Response(
                200,
                json={
                    "locations": [
                        _location(
                            latitude=None,
                            longitude=None,
                            is_live=False,
                            is_stale=True,
                        )
                    ]
                },
            )
        )
        out = await fetch_live_locations(employee_id=EMP_ID, is_active=False)
        e = out["locations"][0]
        assert e["latitude"] is None and e["longitude"] is None
        assert e["is_stale"] is True and e["is_live"] is False

    @respx.mock
    async def test_empty_list(self):
        respx.get(LIVE_URL).mock(
            return_value=httpx.Response(200, json={"locations": []})
        )
        assert (await fetch_live_locations()) == {"locations": []}

    @respx.mock
    async def test_invalid_entries_dropped_not_fatal(self):
        respx.get(LIVE_URL).mock(
            return_value=httpx.Response(
                200,
                json={
                    "locations": [
                        _location("ok"),
                        {"employee_id": "bad"},  # live but no coords
                        "not-even-a-dict",
                    ]
                },
            )
        )
        out = await fetch_live_locations()
        assert [e["employee_id"] for e in out["locations"]] == ["ok"]


class TestLiveValidation:
    async def test_is_active_false_requires_employee(self):
        with pytest.raises(LiveLocationBadRequest) as err:
            await fetch_live_locations(is_active=False)
        assert err.value.code == "INVALID_FILTER"
        assert err.value.status_code == 400


class TestUpstreamFailures:
    @pytest.mark.parametrize("code", (401, 403))
    @respx.mock
    async def test_auth_rejected(self, code):
        respx.get(LIVE_URL).mock(return_value=httpx.Response(code))
        with pytest.raises(LiveLocationUpstreamError) as err:
            await fetch_live_locations()
        assert err.value.code == "LIVE_LOCATION_AUTH_REJECTED"
        assert err.value.status_code == 502

    @respx.mock
    async def test_upstream_400_passthrough(self):
        respx.get(LIVE_URL).mock(
            return_value=httpx.Response(
                400, json={"detail": {"code": "INVALID_FILTER", "message": "bad"}}
            )
        )
        with pytest.raises(LiveLocationBadRequest) as err:
            await fetch_live_locations()
        assert err.value.status_code == 400
        assert err.value.code == "INVALID_FILTER"

    @respx.mock
    async def test_upstream_503(self):
        respx.get(LIVE_URL).mock(return_value=httpx.Response(503))
        with pytest.raises(LiveLocationUnavailable) as err:
            await fetch_live_locations()
        assert err.value.status_code == 503

    @respx.mock
    async def test_upstream_404_wrong_endpoint(self):
        """A 404 means the base URL or deployed service is wrong — surface a
        distinct, diagnosable code rather than a generic connectivity error."""
        respx.get(LIVE_URL).mock(return_value=httpx.Response(404))
        with pytest.raises(LiveLocationUpstreamError) as err:
            await fetch_live_locations()
        assert err.value.status_code == 502
        assert err.value.code == "LIVE_LOCATION_NOT_FOUND"

    @respx.mock
    async def test_transport_error(self):
        respx.get(LIVE_URL).mock(side_effect=httpx.ConnectError("refused"))
        with pytest.raises(LiveLocationUnavailable):
            await fetch_live_locations()

    @respx.mock
    async def test_timeout(self):
        respx.get(LIVE_URL).mock(side_effect=httpx.ReadTimeout("slow"))
        with pytest.raises(LiveLocationUnavailable):
            await fetch_live_locations()

    @respx.mock
    async def test_malformed_json(self):
        respx.get(LIVE_URL).mock(
            return_value=httpx.Response(200, content=b"<html>nope</html>")
        )
        with pytest.raises(LiveLocationUpstreamError):
            await fetch_live_locations()

    @respx.mock
    async def test_wrong_shape(self):
        respx.get(LIVE_URL).mock(
            return_value=httpx.Response(200, json={"not_locations": []})
        )
        with pytest.raises(LiveLocationUpstreamError):
            await fetch_live_locations()


class TestUnconfigured:
    @pytest.mark.parametrize(
        "url,key", [(None, "k"), (UPSTREAM, None), (None, None)]
    )
    async def test_fails_closed(self, monkeypatch, url, key):
        monkeypatch.setattr(settings, "EMPLOYEE_BACKEND_URL", url)
        monkeypatch.setattr(settings, "EMPLOYEE_API_BASE_URL", None)
        monkeypatch.setattr(settings, "LOCATION_SERVICE_API_KEY", key)
        with pytest.raises(LiveLocationUnavailable):
            await fetch_live_locations()

    @respx.mock
    async def test_explicit_base_url_wins(self, monkeypatch):
        explicit = "https://employee-api.test/api/v1"
        monkeypatch.setattr(settings, "EMPLOYEE_API_BASE_URL", explicit)
        route = respx.get(f"{explicit}/admin/live-locations").mock(
            return_value=httpx.Response(200, json={"locations": []})
        )
        await fetch_live_locations()
        assert route.called


class TestHistory:
    FROM = datetime(2026, 10, 8, 8, 0, tzinfo=timezone.utc)
    TO = datetime(2026, 10, 8, 18, 0, tzinfo=timezone.utc)
    URL = f"{BASE}/admin/location-history/{EMP_ID}"

    @respx.mock
    async def test_success(self):
        route = respx.get(self.URL).mock(
            return_value=httpx.Response(
                200,
                json={
                    "employee_id": EMP_ID,
                    "from": "2026-10-08T08:00:00+00:00",
                    "to": "2026-10-08T18:00:00+00:00",
                    "total_points": 2,
                    "returned_points": 2,
                    "downsampled": False,
                    "points": [_point(), _point(sequence_number=18)],
                },
            )
        )
        out = await fetch_location_history(EMP_ID, self.FROM, self.TO)
        assert out["employee_id"] == EMP_ID
        assert out["total_points"] == 2
        assert out["downsampled"] is False
        assert len(out["points"]) == 2
        req = route.calls[0].request
        assert req.headers["x-location-service-key"] == "test-key"
        q = req.url.params
        assert q["from"] == "2026-10-08T08:00:00Z"
        assert q["to"] == "2026-10-08T18:00:00Z"

    @respx.mock
    async def test_session_and_max_points_forwarded(self):
        route = respx.get(self.URL).mock(
            return_value=httpx.Response(
                200,
                json={
                    "points": [_point()],
                    "total_points": 1,
                    "returned_points": 1,
                    "downsampled": False,
                },
            )
        )
        sid = str(uuid.uuid4())
        await fetch_location_history(
            EMP_ID, self.FROM, self.TO,
            tracking_session_id=sid, max_points=500,
        )
        q = route.calls[0].request.url.params
        assert q["tracking_session_id"] == sid
        assert q["max_points"] == "500"

    @respx.mock
    async def test_downsampled_flag_preserved(self):
        respx.get(self.URL).mock(
            return_value=httpx.Response(
                200,
                json={
                    "points": [_point()],
                    "total_points": 50_000,
                    "returned_points": 1,
                    "downsampled": True,
                },
            )
        )
        out = await fetch_location_history(EMP_ID, self.FROM, self.TO)
        assert out["downsampled"] is True
        assert out["total_points"] == 50_000

    async def test_to_before_from_rejected(self):
        with pytest.raises(LiveLocationBadRequest) as err:
            await fetch_location_history(EMP_ID, self.TO, self.FROM)
        assert err.value.code == "INVALID_HISTORY_RANGE"
        assert err.value.status_code == 400

    async def test_range_over_31_days_rejected(self):
        with pytest.raises(LiveLocationBadRequest) as err:
            await fetch_location_history(
                EMP_ID, self.FROM, self.FROM + timedelta(days=31, seconds=1)
            )
        assert err.value.code == "INVALID_HISTORY_RANGE"

    @respx.mock
    async def test_naive_datetimes_treated_as_utc(self):
        respx.get(self.URL).mock(
            return_value=httpx.Response(
                200,
                json={
                    "points": [], "total_points": 0,
                    "returned_points": 0, "downsampled": False,
                },
            )
        )
        out = await fetch_location_history(
            EMP_ID,
            datetime(2026, 10, 8, 8, 0),
            datetime(2026, 10, 8, 18, 0),
        )
        assert out["points"] == []

    @respx.mock
    async def test_upstream_invalid_range_passthrough(self):
        respx.get(self.URL).mock(
            return_value=httpx.Response(
                400,
                json={"detail": {"code": "INVALID_HISTORY_RANGE", "message": "bad"}},
            )
        )
        with pytest.raises(LiveLocationBadRequest) as err:
            await fetch_location_history(EMP_ID, self.FROM, self.TO)
        assert err.value.code == "INVALID_HISTORY_RANGE"

    @respx.mock
    async def test_bad_points_dropped(self):
        respx.get(self.URL).mock(
            return_value=httpx.Response(
                200,
                json={
                    "points": [_point(), {"latitude": "x"}, "junk"],
                    "total_points": 3,
                    "returned_points": 3,
                    "downsampled": False,
                },
            )
        )
        out = await fetch_location_history(EMP_ID, self.FROM, self.TO)
        assert len(out["points"]) == 1


# ---------------------------------------------------------------------------
# Route level — auth guard + validation wiring (upstream mocked)
# ---------------------------------------------------------------------------


class _FakeSession:
    """Minimal stand-in for AsyncSession — scalar() returns a truthy id
    when the scoped entity is "owned" by the caller's company; execute()
    answers the attendance-day fetch then the open-break fetch."""
    def __init__(self, owned=True, days=(), breaks=()):
        self.owned = owned
        self._batches = [list(days), list(breaks)]

    async def scalar(self, _q):
        return uuid.uuid4() if self.owned else None

    async def get(self, _model, _id):
        return SimpleNamespace(operational_day_start=None)

    async def execute(self, _q):
        rows = self._batches.pop(0) if self._batches else []
        return SimpleNamespace(scalars=lambda: iter(rows))


class TestRoutes:
    COMPANY = uuid.uuid4()

    @pytest.fixture
    def client(self):
        from app.core.database import get_db
        from app.dependencies.auth import get_current_user
        from app.main import app
        from app.models.user import UserRole

        app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
            role=UserRole.SUPER_ADMIN, company_id=self.COMPANY
        )

        async def _db():
            # An open attendance day for EMP_UUID — the default payload
            # employee counts as clocked-in (working).
            yield _FakeSession(
                owned=True,
                days=[_day(started_at=datetime.now(timezone.utc))],
            )

        app.dependency_overrides[get_db] = _db
        transport = httpx.ASGITransport(app=app)
        yield httpx.AsyncClient(
            transport=transport, base_url="http://sa.test"
        )
        app.dependency_overrides.clear()

    @respx.mock
    async def test_live_locations_route(self, client):
        respx.get(LIVE_URL).mock(
            return_value=httpx.Response(200, json={"locations": [_location()]})
        )
        async with client as c:
            res = await c.get("/api/v1/live-locations")
        assert res.status_code == 200
        locations = res.json()["locations"]
        assert len(locations) == 1
        # No attendance rows in the fake session — unresolved stays
        # "unknown" rather than guessing from GPS activity.
        assert locations[0]["work_status"]["state"] == "working"

    @respx.mock
    async def test_not_clocked_in_employees_filtered(self, client):
        """GPS reporting but no open attendance day → dropped server-side."""
        from app.core.database import get_db
        from app.main import app

        respx.get(LIVE_URL).mock(
            return_value=httpx.Response(200, json={"locations": [_location()]})
        )

        async def _db():
            yield _FakeSession(owned=True, days=[], breaks=[])

        app.dependency_overrides[get_db] = _db
        async with client as c:
            res = await c.get("/api/v1/live-locations")
        assert res.status_code == 200
        assert res.json()["locations"] == []

    @respx.mock
    async def test_clocked_out_employee_filtered(self, client):
        """A completed shift today → off_duty → removed from the map."""
        from app.core.database import get_db
        from app.main import app

        respx.get(LIVE_URL).mock(
            return_value=httpx.Response(200, json={"locations": [_location()]})
        )
        ended = datetime.now(timezone.utc)
        day = _day(started_at=ended - timedelta(hours=8), ended_at=ended)

        async def _db():
            yield _FakeSession(owned=True, days=[day])

        app.dependency_overrides[get_db] = _db
        async with client as c:
            res = await c.get("/api/v1/live-locations")
        assert res.status_code == 200
        assert res.json()["locations"] == []

    @respx.mock
    async def test_on_break_employee_stays_visible(self, client):
        """An open break sits inside an active shift — still on the map."""
        from app.core.database import get_db
        from app.main import app

        respx.get(LIVE_URL).mock(
            return_value=httpx.Response(200, json={"locations": [_location()]})
        )
        day = _day(
            started_at=datetime.now(timezone.utc) - timedelta(hours=3)
        )
        br = AttendanceBreak(
            attendance_day_id=day.id,
            started_at=datetime.now(timezone.utc) - timedelta(minutes=20),
            ended_at=None,
        )

        async def _db():
            yield _FakeSession(owned=True, days=[day], breaks=[br])

        app.dependency_overrides[get_db] = _db
        async with client as c:
            res = await c.get("/api/v1/live-locations")
        assert res.status_code == 200
        locations = res.json()["locations"]
        assert len(locations) == 1
        assert locations[0]["work_status"]["state"] == "on_break"

    @respx.mock
    async def test_single_lookup_null_when_off_duty(self, client):
        """Stale-capable single lookup is gated by attendance too."""
        from app.core.database import get_db
        from app.main import app

        respx.get(LIVE_URL).mock(
            return_value=httpx.Response(200, json={"locations": [_location()]})
        )
        ended = datetime.now(timezone.utc)
        day = _day(started_at=ended - timedelta(hours=8), ended_at=ended)

        async def _db():
            yield _FakeSession(owned=True, days=[day])

        app.dependency_overrides[get_db] = _db
        async with client as c:
            res = await c.get(f"/api/v1/live-locations/{EMP_ID}")
        assert res.status_code == 200
        assert res.json()["location"] is None

    async def test_live_locations_rejects_bad_uuid(self, client):
        async with client as c:
            res = await c.get(
                "/api/v1/live-locations", params={"employee_id": "not-a-uuid"}
            )
        assert res.status_code == 422

    @respx.mock
    async def test_single_employee_route(self, client):
        route = respx.get(LIVE_URL).mock(
            return_value=httpx.Response(200, json={"locations": [_location()]})
        )
        async with client as c:
            res = await c.get(f"/api/v1/live-locations/{EMP_ID}")
        assert res.status_code == 200
        assert res.json()["location"]["employee_id"] == EMP_ID
        q = route.calls[0].request.url.params
        assert q["employee_id"] == EMP_ID
        assert q["is_active"] == "false"

    async def test_history_rejects_over_31_days(self, client):
        async with client as c:
            res = await c.get(
                f"/api/v1/live-locations/{EMP_ID}/history",
                params={
                    "from": "2026-09-01T00:00:00Z",
                    "to": "2026-10-09T00:00:00Z",
                },
            )
        assert res.status_code == 400

    async def test_history_rejects_bad_max_points(self, client):
        async with client as c:
            res = await c.get(
                f"/api/v1/live-locations/{EMP_ID}/history",
                params={
                    "from": "2026-10-08T00:00:00Z",
                    "to": "2026-10-08T01:00:00Z",
                    "max_points": 0,
                },
            )
        assert res.status_code == 422

    @respx.mock
    async def test_property_manager_pinned_to_own_property(self, client):
        """PMs can read live locations — but always scoped to their own
        property, regardless of the filter they pass."""
        from app.core.database import get_db
        from app.dependencies.auth import get_current_user
        from app.main import app
        from app.models.user import UserRole

        PM_PROP = uuid.uuid4()
        PM_COMPANY = uuid.uuid4()
        upstream = respx.get(LIVE_URL).mock(
            return_value=httpx.Response(200, json={"locations": []})
        )
        app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
            role=UserRole.PROPERTY_MANAGER, company_id=PM_COMPANY,
            property_id=PM_PROP,
        )

        async def _db():
            yield _FakeSession(owned=True)

        app.dependency_overrides[get_db] = _db
        async with client as c:
            res = await c.get("/api/v1/live-locations")
        assert res.status_code == 200
        # The forwarded filter is the PM's own property, not the caller's arg.
        assert str(PM_PROP) in str(upstream.calls.last.request.url)

    async def test_pm_foreign_property_id_is_404(self, client):
        """A PM passing another property's id gets 404 — never forwarded."""
        from app.core.database import get_db
        from app.dependencies.auth import get_current_user
        from app.main import app
        from app.models.user import UserRole

        app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
            role=UserRole.PROPERTY_MANAGER, company_id=uuid.uuid4(),
            property_id=uuid.uuid4(),
        )

        async def _db():
            yield _FakeSession(owned=True)

        app.dependency_overrides[get_db] = _db
        async with client as c:
            res = await c.get(
                "/api/v1/live-locations",
                params={"property_id": str(uuid.uuid4())},
            )
        assert res.status_code == 404

    async def test_forbidden_for_employee_role(self, client):
        from app.dependencies.auth import get_current_user
        from app.main import app
        from app.models.user import UserRole

        app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
            role=UserRole.EMPLOYEE, company_id=uuid.uuid4()
        )
        async with client as c:
            res = await c.get("/api/v1/live-locations")
        assert res.status_code == 403

    @respx.mock
    async def test_foreign_employee_never_reaches_upstream(self, client):
        """An employee_uid outside the caller's company → 404, no proxy call."""
        from app.core.database import get_db
        from app.main import app

        upstream = respx.get(LIVE_URL).mock(
            return_value=httpx.Response(200, json={"locations": []})
        )

        async def _db():
            yield _FakeSession(owned=False)

        app.dependency_overrides[get_db] = _db
        async with client as c:
            res = await c.get(f"/api/v1/live-locations/{EMP_ID}")
        assert res.status_code == 404
        assert not upstream.called

    @respx.mock
    async def test_foreign_history_never_reaches_upstream(self, client):
        from app.core.database import get_db
        from app.main import app

        upstream = respx.get(
            f"{BASE}/admin/location-history/{EMP_ID}"
        ).mock(return_value=httpx.Response(200, json={"points": []}))

        async def _db():
            yield _FakeSession(owned=False)

        app.dependency_overrides[get_db] = _db
        async with client as c:
            res = await c.get(
                f"/api/v1/live-locations/{EMP_ID}/history",
                params={
                    "from": "2026-10-08T00:00:00Z",
                    "to": "2026-10-08T01:00:00Z",
                },
            )
        assert res.status_code == 404
        assert not upstream.called

    async def test_unauthenticated_rejected(self):
        from app.main import app

        app.dependency_overrides.clear()
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://sa.test"
        ) as c:
            res = await c.get("/api/v1/live-locations")
        assert res.status_code == 401


# ---------------------------------------------------------------------------
# Work status — attendance-derived duty state joined onto locations
# ---------------------------------------------------------------------------


class _StatusSession:
    """Answers the two queries current_work_statuses makes in order:
    the day-row fetch, then the open-break fetch."""
    def __init__(self, days=(), breaks=()):
        self._batches = [list(days), list(breaks)]

    async def get(self, _model, _id):
        return SimpleNamespace(operational_day_start=None)

    async def execute(self, _q):
        rows = self._batches.pop(0) if self._batches else []
        return SimpleNamespace(scalars=lambda: iter(rows))


USER = SimpleNamespace(company_id=uuid.uuid4())
EMP_UUID = uuid.UUID(EMP_ID)


def _today_key() -> str:
    from app.services.rollover import (
        current_operational_day,
        parse_day_start,
    )
    return current_operational_day(
        datetime.now(timezone.utc), parse_day_start(None)
    )


def _day(emp=EMP_UUID, **kw) -> AttendanceDay:
    base = dict(
        property_id=uuid.uuid4(),
        employee_id=emp,
        employee_name="Baldev",
        attendance_date=_today_key(),
        status="present",
        started_at=None,
        ended_at=None,
    )
    base.update(kw)
    return AttendanceDay(**base)


@pytest.mark.anyio
class TestWorkStatuses:
    async def test_open_day_is_working(self):
        started = datetime(2026, 10, 8, 5, 0, tzinfo=timezone.utc)
        out = await current_work_statuses(
            _StatusSession(days=[_day(started_at=started)]),
            USER,
            [EMP_UUID],
        )
        st = out[EMP_UUID]
        assert st["state"] == "working"
        assert st["since"] == started.isoformat()

    async def test_open_day_with_open_break_is_on_break(self):
        day = _day(started_at=datetime(
            2026, 10, 8, 5, 0, tzinfo=timezone.utc))
        br = AttendanceBreak(
            attendance_day_id=day.id,
            started_at=datetime(2026, 10, 8, 8, 0, tzinfo=timezone.utc),
            ended_at=None,
        )
        out = await current_work_statuses(
            _StatusSession(days=[day], breaks=[br]), USER, [EMP_UUID]
        )
        st = out[EMP_UUID]
        assert st["state"] == "on_break"
        assert st["since"] == br.started_at.isoformat()

    async def test_closed_day_is_off_duty(self):
        ended = datetime(2026, 10, 8, 14, 0, tzinfo=timezone.utc)
        out = await current_work_statuses(
            _StatusSession(days=[_day(
                started_at=ended - timedelta(hours=8), ended_at=ended)]),
            USER,
            [EMP_UUID],
        )
        st = out[EMP_UUID]
        assert st["state"] == "off_duty"
        assert st["since"] == ended.isoformat()

    async def test_marked_day_off_is_off_duty(self):
        out = await current_work_statuses(
            _StatusSession(days=[_day(status="week_off")]),
            USER,
            [EMP_UUID],
        )
        st = out[EMP_UUID]
        assert st["state"] == "off_duty"
        assert st["label"] == "Week off"

    async def test_no_rows_means_no_entry(self):
        out = await current_work_statuses(
            _StatusSession(), USER, [EMP_UUID]
        )
        assert out == {}

    async def test_empty_ids_short_circuits(self):
        out = await current_work_statuses(
            _StatusSession(), USER, []
        )
        assert out == {}
