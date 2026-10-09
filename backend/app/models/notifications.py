"""Minimal map of the shared `notifications` table.

The Employee Backend owns the notification surface; the Super Admin only
writes review outcomes (submission_approved / submission_disapproved)
so employees see the decision on their next feed poll.
"""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4
    )
    property_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("properties.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    employee_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("employees.id", ondelete="SET NULL"),
        nullable=True,
    )
    employee_name: Mapped[str | None] = mapped_column(
        String(255), nullable=True
    )
    task_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    ticket_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str] = mapped_column(String(500), nullable=False)
    is_read: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false",
    )
    read_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
