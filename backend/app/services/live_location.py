"""Employee live locations & route history — server-to-server proxy.

The Employee Backend owns position state (Redis live snapshot, 120s TTL,
plus day-partitioned history). This service forwards requests to
{EMPLOYEE_API_BASE_URL}/admin/... with the shared LOCATION_SERVICE_API_KEY
in the X-Location-Service-Key header and normalizes payloads for the SA
frontend. Coordinates are never stored and never logged — only counts.

Base URL resolution: EMPLOYEE_API_BASE_URL (full base incl. /api/v1) wins;
otherwise EMPLOYEE_BACKEND_URL + /api/v1.
"""

from datetime import datetime, timedelta, timezone

import httpx

from app.core.config import settings
from app.core.exceptions import AppError
from app.core.logging import get_logger

logger = get_logger("app.live_location")

_MAX_HISTORY_SPAN = timedelta(days=31)

# Canonical field names emitted to the frontend. Upstream also sends legacy
# aliases (accuracy/speed/heading) — read the _m/_mps/_deg names first.
_NUMERIC_FIELDS = (
    ("accuracy_m", "accuracy"),
    ("speed_mps", "speed"),
    ("bearing_deg", "heading"),
    ("altitude_m", None),
)
_STRING_FIELDS = ("captured_at", "received_at", "tracking_session_id", "quality", "source")
_INT_FIELDS = ("sequence_number", "device_timestamp", "server_timestamp")


class LiveLocationUnavailable(AppError):
    status_code = 503
    code = "LIVE_LOCATION_UNAVAILABLE"
    message = "The live-location service is unavailable."


class LiveLocationUpstreamError(AppError):
    status_code = 502
    code = "LIVE_LOCATION_UPSTREAM"
    message = "The employee backend returned an invalid response."


class LiveLocationBadRequest(AppError):
    status_code = 400
    code = "INVALID_FILTER"
    message = "The location request was invalid."


def _base_url() -> str:
    """Upstream /api/v1 base — EMPLOYEE_API_BASE_URL verbatim, else the
    legacy EMPLOYEE_BACKEND_URL root with /api/v1 appended."""
    explicit = (settings.EMPLOYEE_API_BASE_URL or "").rstrip("/")
    if explicit:
        return explicit
    root = (settings.EMPLOYEE_BACKEND_URL or "").rstrip("/")
    return f"{root}/api/v1" if root else ""


def _extract_upstream_error(res: httpx.Response) -> tuple[str | None, str | None]:
    """Pull (code, message) out of an upstream error body, if JSON."""
    try:
        body = res.json()
    except ValueError:
        return None, None
    if not isinstance(body, dict):
        return None, None
    detail = body.get("detail")
    if isinstance(detail, dict):
        return detail.get("code"), detail.get("message")
    if isinstance(detail, str):
        return None, detail
    error = body.get("error")
    if isinstance(error, dict):
        return error.get("code"), error.get("message")
    return None, None


async def _get(path: str, params: dict | None = None) -> dict:
    """One authenticated GET against the Employee Backend → parsed JSON dict.

    Error mapping:
      unconfigured          → 503 (fail closed, no key hints)
      transport/timeout     → 503 LIVE_LOCATION_UNAVAILABLE
      upstream 400          → 400 with the upstream code/message
      upstream 401/403      → 502 LIVE_LOCATION_AUTH_REJECTED
      upstream 503          → 503 LIVE_LOCATION_UNAVAILABLE
      other non-200         → 503
      non-JSON / bad shape  → 502 LIVE_LOCATION_UPSTREAM
    """
    base = _base_url()
    key = settings.LOCATION_SERVICE_API_KEY
    if not base or not key:
        raise LiveLocationUnavailable(
            "Live locations are not configured (set EMPLOYEE_API_BASE_URL "
            "or EMPLOYEE_BACKEND_URL, and LOCATION_SERVICE_API_KEY)."
        )
    timeout = httpx.Timeout(
        settings.LOCATION_SERVICE_TIMEOUT_SECONDS, connect=4.0
    )
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.get(
                f"{base}{path}",
                params=params or {},
                headers={"X-Location-Service-Key": key},
            )
    except httpx.HTTPError as exc:
        logger.warning(
            "live-location upstream request failed: %s", type(exc).__name__
        )
        raise LiveLocationUnavailable(
            "Could not reach the employee backend."
        ) from exc

    if res.status_code == 200:
        try:
            payload = res.json()
        except ValueError as exc:
            raise LiveLocationUpstreamError(
                "The employee backend returned a non-JSON payload."
            ) from exc
        if not isinstance(payload, dict):
            raise LiveLocationUpstreamError(
                "The employee backend returned an unexpected payload shape."
            )
        return payload

    if res.status_code in (401, 403):
        raise LiveLocationUpstreamError(
            "The employee backend rejected the service API key "
            "(LOCATION_SERVICE_API_KEY mismatch).",
            code="LIVE_LOCATION_AUTH_REJECTED",
        )
    if res.status_code == 400:
        code, message = _extract_upstream_error(res)
        raise LiveLocationBadRequest(
            message or "The employee backend rejected the query parameters.",
            code=code or "INVALID_FILTER",
        )
    if res.status_code == 404:
        raise LiveLocationUpstreamError(
            "The employee backend does not expose this route — check "
            "EMPLOYEE_API_BASE_URL (it must include /api/v1) and that the "
            "deployed employee service has the location endpoints.",
            code="LIVE_LOCATION_NOT_FOUND",
        )
    raise LiveLocationUnavailable(
        f"The employee backend answered {res.status_code}."
    )


def _normalize_location(raw: object) -> dict | None:
    """One upstream live entry → the wire shape, or None if unusable.

    A bad entry is dropped rather than failing the whole payload. Stale
    entries (is_stale=true) legitimately carry null coordinates — they are
    kept so the UI can show "last seen, now offline"; only non-stale rows
    without coordinates are dropped."""
    if not isinstance(raw, dict):
        return None
    employee_id = raw.get("employee_id")
    if not isinstance(employee_id, str) or not employee_id:
        return None
    lat, lng = raw.get("latitude"), raw.get("longitude")
    lat = float(lat) if isinstance(lat, (int, float)) else None
    lng = float(lng) if isinstance(lng, (int, float)) else None
    is_stale = bool(raw.get("is_stale"))
    if (lat is None or lng is None) and not is_stale:
        return None

    out = {
        "employee_id": employee_id,
        "latitude": lat,
        "longitude": lng,
        "is_live": bool(raw.get("is_live")),
        "is_stale": is_stale,
    }
    for canonical, legacy in _NUMERIC_FIELDS:
        v = raw.get(canonical)
        if not isinstance(v, (int, float)) and legacy:
            v = raw.get(legacy)
        if isinstance(v, (int, float)):
            out[canonical] = float(v)
    for key in _STRING_FIELDS:
        v = raw.get(key)
        if isinstance(v, str) and v:
            out[key] = v
    for key in _INT_FIELDS:
        v = raw.get(key)
        if isinstance(v, (int, float)):
            out[key] = int(v)
    return out


def _normalize_point(raw: object) -> dict | None:
    """One history point → wire shape, or None. History points without
    real coordinates are useless for the route — dropped."""
    if not isinstance(raw, dict):
        return None
    lat, lng = raw.get("latitude"), raw.get("longitude")
    if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
        return None
    out = {"latitude": float(lat), "longitude": float(lng)}
    for canonical, legacy in _NUMERIC_FIELDS:
        v = raw.get(canonical)
        if not isinstance(v, (int, float)) and legacy:
            v = raw.get(legacy)
        if isinstance(v, (int, float)):
            out[canonical] = float(v)
    for key in _STRING_FIELDS:
        v = raw.get(key)
        if isinstance(v, str) and v:
            out[key] = v
    for key in ("sequence_number",):
        v = raw.get(key)
        if isinstance(v, (int, float)):
            out[key] = int(v)
    return out


async def fetch_live_locations(
    *,
    employee_id: str | None = None,
    property_id: str | None = None,
    zone_id: str | None = None,
    is_active: bool = True,
) -> dict:
    """Return {"locations": [...]} — only valid entries, as received.

    is_active=False (stale lookup) is only valid scoped to one employee —
    mirrors the upstream INVALID_FILTER rule."""
    if not is_active and not employee_id:
        raise LiveLocationBadRequest(
            "is_active=false requires an employee_id filter.",
            code="INVALID_FILTER",
        )
    params: dict = {}
    if employee_id:
        params["employee_id"] = employee_id
    if property_id:
        params["property_id"] = property_id
    if zone_id:
        params["zone_id"] = zone_id
    if not is_active:
        params["is_active"] = "false"

    payload = await _get("/admin/live-locations", params)
    if not isinstance(payload.get("locations"), list):
        raise LiveLocationUpstreamError(
            "The employee backend returned an unexpected payload shape."
        )
    locations = [
        e for e in
        (_normalize_location(item) for item in payload["locations"])
        if e is not None
    ]
    return {"locations": locations}


async def fetch_location_history(
    employee_id: str,
    from_dt: datetime,
    to_dt: datetime,
    *,
    tracking_session_id: str | None = None,
    max_points: int | None = None,
) -> dict:
    """Return the normalized route-history payload for one employee.

    Range rules mirror upstream: `to` must be after `from`, span <= 31 days.
    Naive datetimes are treated as UTC; aware ones are converted."""
    if from_dt.tzinfo is None:
        from_dt = from_dt.replace(tzinfo=timezone.utc)
    if to_dt.tzinfo is None:
        to_dt = to_dt.replace(tzinfo=timezone.utc)
    from_dt = from_dt.astimezone(timezone.utc)
    to_dt = to_dt.astimezone(timezone.utc)
    if to_dt <= from_dt:
        raise LiveLocationBadRequest(
            "`to` must be after `from`.", code="INVALID_HISTORY_RANGE"
        )
    if to_dt - from_dt > _MAX_HISTORY_SPAN:
        raise LiveLocationBadRequest(
            "The requested range exceeds the 31-day maximum.",
            code="INVALID_HISTORY_RANGE",
        )

    params: dict = {
        "from": from_dt.isoformat().replace("+00:00", "Z"),
        "to": to_dt.isoformat().replace("+00:00", "Z"),
    }
    if tracking_session_id:
        params["tracking_session_id"] = tracking_session_id
    if max_points is not None:
        params["max_points"] = max_points

    payload = await _get(
        f"/admin/location-history/{employee_id}", params
    )
    if not isinstance(payload.get("points"), list):
        raise LiveLocationUpstreamError(
            "The employee backend returned an unexpected payload shape."
        )

    points = [
        p for p in
        (_normalize_point(item) for item in payload["points"])
        if p is not None
    ]
    return {
        "employee_id": employee_id,
        "from": payload.get("from") if isinstance(payload.get("from"), str) else params["from"],
        "to": payload.get("to") if isinstance(payload.get("to"), str) else params["to"],
        "total_points": int(payload.get("total_points") or len(points)),
        "returned_points": int(payload.get("returned_points") or len(points)),
        "downsampled": bool(payload.get("downsampled")),
        "points": points,
    }
