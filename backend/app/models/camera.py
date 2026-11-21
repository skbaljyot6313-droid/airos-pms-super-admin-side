"""Video Analytics (VA) camera models — owned by the Super Admin backend.

Cameras are property-scoped: each row belongs to exactly one property and is
assigned into the property's existing structure — a zone, or an area when no
specific zone applies (`zone_id` implies its `area_id`; `area_id` alone means
area-level placement). RTSP credentials are stored encrypted — `password`
holds a Fernet token produced by `app.core.secrets_crypto`, never plaintext.
go2rtc performs all RTSP ingestion; these rows are only the source-of-truth
configuration the media server is provisioned from.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import Uuid

from app.models import Base


class Camera(Base):
    """A registered IP camera. Soft-deleted rows keep `deleted_at` set."""

    __tablename__ = "cameras"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    property_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("properties.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Assignment into the property's existing structure — a zone (leaf) or a
    # whole area when no specific zone applies. At most one is set.
    area_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("areas.id", ondelete="SET NULL"), nullable=True, index=True
    )
    zone_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("zones.id", ondelete="SET NULL"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Stream URL WITHOUT embedded credentials (userinfo is stripped on write;
    # credentials travel in `username`/`password` instead).
    rtsp_url: Mapped[str] = mapped_column(String(1024), nullable=False)
    # Optional camera substream (low-bitrate secondary RTSP URL) — used for
    # multi-camera grid viewing. Same credentials as the primary URL.
    sub_rtsp_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    # NULL = follow the VA_TRANSCODE_ENABLED global default; explicit
    # true/false = per-camera override (transcode is the exception, not the
    # rule — prefer passthrough for H264-compatible sources).
    transcode: Mapped[bool | None] = mapped_column(nullable=True)
    # Keep the upstream camera connection hot so a viewer's first frame
    # skips the cold RTSP dial/describe. Bounded by VA_WARM_MAX_STREAMS.
    warm: Mapped[bool] = mapped_column(nullable=False, default=False, server_default="false")
    username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    password: Mapped[str | None] = mapped_column(String(1024), nullable=True)  # Fernet token
    transport: Mapped[str] = mapped_column(
        String(8), nullable=False, default="tcp", server_default="tcp"
    )
    resolution: Mapped[str | None] = mapped_column(String(32), nullable=True)
    fps: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_enabled: Mapped[bool] = mapped_column(nullable=False, default=True, server_default="true")
    # unknown | online | offline | error — only ever set by connectivity checks.
    connection_status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="unknown", server_default="unknown"
    )
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    area: Mapped["Area | None"] = relationship()
    zone: Mapped["Zone | None"] = relationship()


class CameraStreamSession(Base):
    """One viewer's stream lease. go2rtc pulls the RTSP source lazily while
    a valid JWT-authorized reader is attached; rows here enforce concurrency
    limits and give ops an audit trail of who watched which camera."""

    __tablename__ = "camera_stream_sessions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    camera_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("cameras.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    property_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("properties.id", ondelete="CASCADE"), nullable=False, index=True
    )
    protocol: Mapped[str] = mapped_column(String(16), nullable=False, default="webrtc")
    # "main" | "sub" — which camera stream the session is bound to.
    quality: Mapped[str] = mapped_column(
        String(8), nullable=False, default="main", server_default="main"
    )
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="active", server_default="active"
    )
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_activity_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
