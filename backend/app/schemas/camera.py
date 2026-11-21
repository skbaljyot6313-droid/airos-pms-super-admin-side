"""VA camera request/response schemas.

`rtsp_url` is echoed back MASKED — userinfo is stripped on write, but the
host is still sensitive (internal network topology) so responses carry
only `rtsp_url_masked` (`rtsp://<host>/***`) plus a `has_credentials`
flag. Passwords are write-only. Cameras are assigned into the property's
existing areas/zones — `zone_uid` implies its area; `area_uid` alone is
area-level placement.
"""

from urllib.parse import unquote, urlsplit, urlunsplit

from pydantic import BaseModel, Field, field_validator, model_validator


class CameraMoveRequest(BaseModel):
    camera_uids: list[str] = Field(min_length=1)
    zone_uid: str | None = None
    area_uid: str | None = None  # None + zone_uid None → unassigned


def normalize_rtsp_url(raw: str) -> str:
    """Validate + normalize an RTSP URL. Returns the URL with any embedded
    userinfo REMOVED (credentials live in dedicated fields). Raises
    ValueError with a user-safe message on invalid input."""
    raw = raw.strip()
    if len(raw) > 1024:
        raise ValueError("RTSP URL is too long.")
    parts = urlsplit(raw)
    if parts.scheme.lower() != "rtsp":
        raise ValueError("Only rtsp:// stream URLs are supported.")
    if not parts.hostname:
        raise ValueError("RTSP URL must include a host.")
    host = parts.hostname.lower()
    if host in {"localhost", "metadata.google.internal"} or host.startswith("169.254."):
        raise ValueError("This stream host is not allowed.")
    if parts.port is not None and not (1 <= parts.port <= 65535):
        raise ValueError("Invalid RTSP port.")
    # Rebuild without userinfo
    netloc = host
    if parts.port:
        netloc = f"{host}:{parts.port}"
    if ":" in host and not netloc.startswith("["):  # IPv6 literal
        netloc = f"[{host}]" + (f":{parts.port}" if parts.port else "")
    return urlunsplit(("rtsp", netloc, parts.path or "/", parts.query, ""))


def _harvest_inline_credentials(data):
    """Copy userinfo embedded in `rtsp_url` into the dedicated fields when
    they aren't set — normalize_rtsp_url strips it for storage."""
    if isinstance(data, dict):
        raw = data.get("rtsp_url")
        if isinstance(raw, str) and "@" in raw:
            parts = urlsplit(raw.strip())
            if parts.username and not data.get("username"):
                data["username"] = unquote(parts.username)
            if parts.password and not data.get("password"):
                data["password"] = unquote(parts.password)
    return data


class CameraCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=500)
    zone_uid: str | None = None
    area_uid: str | None = None
    rtsp_url: str = Field(min_length=8, max_length=1024)
    sub_rtsp_url: str | None = Field(default=None, min_length=8, max_length=1024)
    transcode: bool | None = None  # None → global VA_TRANSCODE_ENABLED default
    warm: bool = False  # keep the upstream camera connection hot for fast first-frame
    location: str | None = Field(default=None, max_length=255)
    username: str | None = Field(default=None, max_length=255)
    password: str | None = Field(default=None, max_length=255)
    transport: str = Field(default="tcp", pattern="^(tcp|udp)$")
    resolution: str | None = Field(default=None, max_length=32)
    fps: int | None = Field(default=None, ge=1, le=120)
    is_enabled: bool = True

    @model_validator(mode="before")
    @classmethod
    def _harvest(cls, data):
        return _harvest_inline_credentials(data)

    @field_validator("rtsp_url", "sub_rtsp_url")
    @classmethod
    def _check_url(cls, v: str | None) -> str | None:
        return normalize_rtsp_url(v) if v is not None else None


class CameraUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=500)
    zone_uid: str | None = None
    area_uid: str | None = None
    rtsp_url: str | None = Field(default=None, min_length=8, max_length=1024)
    sub_rtsp_url: str | None = Field(default=None, min_length=8, max_length=1024)
    transcode: bool | None = None
    warm: bool | None = None  # None → leave unchanged
    location: str | None = Field(default=None, max_length=255)
    username: str | None = Field(default=None, max_length=255)
    password: str | None = Field(default=None, max_length=255)
    transport: str | None = Field(default=None, pattern="^(tcp|udp)$")
    resolution: str | None = Field(default=None, max_length=32)
    fps: int | None = Field(default=None, ge=1, le=120)
    is_enabled: bool | None = None

    @model_validator(mode="before")
    @classmethod
    def _harvest(cls, data):
        return _harvest_inline_credentials(data)

    @field_validator("rtsp_url", "sub_rtsp_url")
    @classmethod
    def _check_url(cls, v: str | None) -> str | None:
        return normalize_rtsp_url(v) if v is not None else None


def masked_rtsp(url: str) -> str:
    """`rtsp://<host>:<port>/***` — enough to identify the camera, nothing
    usable for connecting."""
    parts = urlsplit(url)
    netloc = parts.hostname or ""
    if parts.port:
        netloc += f":{parts.port}"
    return urlunsplit(("rtsp", netloc, "/***", "", ""))


def camera_out(c, *, zone_name: str | None = None, area_name: str | None = None) -> dict:
    return {
        "camera_uid": str(c.id),
        "property_uid": str(c.property_id),
        "zone_uid": str(c.zone_id) if c.zone_id else None,
        "zone_name": zone_name,
        "area_uid": str(c.area_id) if c.area_id else None,
        "area_name": area_name,
        "name": c.name,
        "description": c.description,
        "location": c.location,
        "rtsp_url_masked": masked_rtsp(c.rtsp_url),
        "sub_rtsp_url_masked": masked_rtsp(c.sub_rtsp_url) if c.sub_rtsp_url else None,
        "transcode": c.transcode,
        "warm": bool(getattr(c, "warm", False)),
        "username": c.username,
        "has_credentials": bool(c.username or c.password),
        "transport": c.transport,
        "resolution": c.resolution,
        "fps": c.fps,
        "is_enabled": c.is_enabled,
        "connection_status": c.connection_status,
        "last_checked_at": c.last_checked_at.isoformat() if c.last_checked_at else None,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
    }


def session_out(s) -> dict:
    return {
        "session_uid": str(s.id),
        "camera_uid": str(s.camera_id),
        "status": s.status,
        "protocol": s.protocol,
        "started_at": s.started_at.isoformat() if s.started_at else None,
        "ended_at": s.ended_at.isoformat() if s.ended_at else None,
    }
