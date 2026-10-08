"""Live-location proxy — Employee Backend integration tests.

Every case mocks the upstream HTTP call via respx so no employee service
(or shared key) is needed. The proxy must:
  - forward GET {EMPLOYEE_BACKEND_URL}/api/v1/admin/live-locations with
    Authorization: Bearer <LOCATION_SERVICE_API_KEY>
  - pass through a valid payload (drop entries that fail validation)
  - map upstream 401/403 → 502 LIVE_LOCATION_AUTH_REJECTED
  - map upstream 503 / transport errors → 503 LIVE_LOCATION_UNAVAILABLE
  - map malformed JSON/shape → 502 LIVE_LOCATION_UPSTREAM
  - fail closed (503) when unconfigured
"""

import httpx
import pytest
import respx

from app.core.config import settings
from app.services import live_location
from app.services.live_location import (
    LiveLocationUnavailable,
    LiveLocationUpstreamError,
    fetch_live_locations,
)

UPSTREAM = "http://employee-backend.test"
URL = f"{UPSTREAM}/api/v1/admin/live-locations"


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    monkeypatch.setattr(settings, "EMPLOYEE_BACKEND_URL", UPSTREAM)
    monkeypatch.setattr(settings, "LOCATION_SERVICE_API_KEY", "test-key")
    yield


def _employee(uid: str = "e1", **kw) -> dict:
    base = {
        "employee_id": uid,
        "latitude": 19.076,
        "longitude": 72.8777,
        "accuracy": 8.5,
        "device_timestamp": 1791283210,
        "server_timestamp": 1791283212,
        "speed": 1.4,
        "heading": 182,
        "is_live": True,
    }
    base.update(kw)
    return base


class TestSuccess:
    @respx.mock
    async def test_single_employee_passes_through(self):
        route = respx.get(URL).mock(
            return_value=httpx.Response(
                200, json={"employees": [_employee()]}
            )
        )
        out = await fetch_live_locations()
        assert len(out["employees"]) == 1
        e = out["employees"][0]
        assert e["employee_id"] == "e1"
        assert e["latitude"] == 19.076
        assert e["is_live"] is True
        assert e["server_timestamp"] == 1791283212
        # Bearer key went out in the upstream request, nowhere else.
        assert route.calls[0].request.headers["authorization"] == (
            "Bearer test-key"
        )

    @respx.mock
    async def test_multiple_employees(self):
        respx.get(URL).mock(
            return_value=httpx.Response(
                200,
                json={
                    "employees": [
                        _employee("a"),
                        _employee("b", is_live=False),
                        _employee("c"),
                    ]
                },
            )
        )
        out = await fetch_live_locations()
        assert [e["employee_id"] for e in out["employees"]] == ["a", "b", "c"]

    @respx.mock
    async def test_empty_list(self):
        respx.get(URL).mock(
            return_value=httpx.Response(200, json={"employees": []})
        )
        assert (await fetch_live_locations()) == {"employees": []}

    @respx.mock
    async def test_invalid_entries_dropped_not_fatal(self):
        respx.get(URL).mock(
            return_value=httpx.Response(
                200,
                json={
                    "employees": [
                        _employee("ok"),
                        {"employee_id": "bad"},  # no coords
                        "not-even-a-dict",
                    ]
                },
            )
        )
        out = await fetch_live_locations()
        assert [e["employee_id"] for e in out["employees"]] == ["ok"]


class TestUpstreamFailures:
    @pytest.mark.parametrize("code", (401, 403))
    @respx.mock
    async def test_auth_rejected(self, code):
        respx.get(URL).mock(return_value=httpx.Response(code))
        with pytest.raises(LiveLocationUpstreamError) as err:
            await fetch_live_locations()
        assert err.value.code == "LIVE_LOCATION_AUTH_REJECTED"
        assert err.value.status_code == 502

    @respx.mock
    async def test_upstream_503(self):
        respx.get(URL).mock(return_value=httpx.Response(503))
        with pytest.raises(LiveLocationUnavailable) as err:
            await fetch_live_locations()
        assert err.value.status_code == 503

    @respx.mock
    async def test_transport_error(self):
        respx.get(URL).mock(side_effect=httpx.ConnectError("refused"))
        with pytest.raises(LiveLocationUnavailable):
            await fetch_live_locations()

    @respx.mock
    async def test_malformed_json(self):
        respx.get(URL).mock(
            return_value=httpx.Response(200, content=b"<html>nope</html>")
        )
        with pytest.raises(LiveLocationUpstreamError):
            await fetch_live_locations()

    @respx.mock
    async def test_wrong_shape(self):
        respx.get(URL).mock(
            return_value=httpx.Response(200, json={"not_employees": []})
        )
        with pytest.raises(LiveLocationUpstreamError):
            await fetch_live_locations()


class TestUnconfigured:
    @pytest.mark.parametrize("url,key", [(None, "k"), (UPSTREAM, None), (None, None)])
    async def test_fails_closed(self, monkeypatch, url, key):
        monkeypatch.setattr(settings, "EMPLOYEE_BACKEND_URL", url)
        monkeypatch.setattr(settings, "LOCATION_SERVICE_API_KEY", key)
        with pytest.raises(LiveLocationUnavailable):
            await fetch_live_locations()
