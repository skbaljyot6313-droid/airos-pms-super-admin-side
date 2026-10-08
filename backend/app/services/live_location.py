"""Live employee locations — server-to-server proxy to the Employee Backend.

The Employee Backend owns live position state (Redis, 60s TTL). This
service forwards GET {EMPLOYEE_BACKEND_URL}/api/v1/admin/live-locations
with the shared LOCATION_SERVICE_API_KEY bearer and normalizes the payload
for the SA frontend. Coordinates are never stored and never logged — only
counts.
"""

import httpx

from app.core.config import settings
from app.core.exceptions import AppError
from app.core.logging import get_logger

logger = get_logger("app.live_location")

_TIMEOUT = httpx.Timeout(8.0, connect=4.0)

_REQUIRED_FIELDS = ("employee_id", "latitude", "longitude", "is_live")
_OPTIONAL_NUMERIC = ("accuracy", "speed", "heading")
_TIMESTAMPS = ("device_timestamp", "server_timestamp")


class LiveLocationUnavailable(AppError):
    status_code = 503
    code = "LIVE_LOCATION_UNAVAILABLE"
    message = "The live-location service is unavailable."


class LiveLocationUpstreamError(AppError):
    status_code = 502
    code = "LIVE_LOCATION_UPSTREAM"
    message = "The employee backend returned an invalid response."


def _normalize_employee(raw: object) -> dict | None:
    """One upstream entry → the wire shape, or None if unusable.

    A bad entry is dropped rather than failing the whole payload — one
    corrupt fix shouldn't blank the map."""
    if not isinstance(raw, dict):
        return None
    employee_id = raw.get("employee_id")
    lat, lng, is_live = raw.get("latitude"), raw.get("longitude"), raw.get("is_live")
    if not isinstance(employee_id, str) or not employee_id:
        return None
    if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
        return None
    out = {
        "employee_id": employee_id,
        "latitude": float(lat),
        "longitude": float(lng),
        "is_live": bool(is_live),
    }
    for key in _OPTIONAL_NUMERIC:
        v = raw.get(key)
        if isinstance(v, (int, float)):
            out[key] = float(v)
    for key in _TIMESTAMPS:
        v = raw.get(key)
        if isinstance(v, (int, float)):
            out[key] = int(v)
    return out


async def fetch_live_locations() -> dict:
    """Return {"employees": [...]} — only valid entries, as received.

    Raises 503 when unconfigured/unreachable/unavailable upstream; 502 on
    malformed payloads; 502 with a distinct code when the shared key is
    rejected (401/403) so the failure is diagnosable, not a silent empty map.
    """
    base = (settings.EMPLOYEE_BACKEND_URL or "").rstrip("/")
    key = settings.LOCATION_SERVICE_API_KEY
    if not base or not key:
        raise LiveLocationUnavailable(
            "Live locations are not configured "
            "(set EMPLOYEE_BACKEND_URL and LOCATION_SERVICE_API_KEY)."
        )
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            res = await client.get(
                f"{base}/api/v1/admin/live-locations",
                headers={"Authorization": f"Bearer {key}"},
            )
    except httpx.HTTPError as exc:
        logger.warning(
            "live-location upstream request failed: %s", type(exc).__name__
        )
        raise LiveLocationUnavailable(
            "Could not reach the employee backend."
        ) from exc

    if res.status_code in (401, 403):
        raise LiveLocationUpstreamError(
            "The employee backend rejected the service API key "
            "(LOCATION_SERVICE_API_KEY mismatch).",
            code="LIVE_LOCATION_AUTH_REJECTED",
        )
    if res.status_code != 200:
        raise LiveLocationUnavailable(
            f"The employee backend answered {res.status_code}."
        )

    try:
        payload = res.json()
    except ValueError as exc:
        raise LiveLocationUpstreamError(
            "The employee backend returned a non-JSON payload."
        ) from exc
    if not isinstance(payload, dict) or not isinstance(
        payload.get("employees"), list
    ):
        raise LiveLocationUpstreamError(
            "The employee backend returned an unexpected payload shape."
        )

    employees = [
        e for e in
        (_normalize_employee(item) for item in payload["employees"])
        if e is not None
    ]
    return {"employees": employees}
