"""Attendance review — Super Admin decides leave/week-off requests.

Requests are filed by employees in the employee application; this service
is the approval surface on the shared database. Approving stamps every
date in the inclusive [from..to] range with the request's day status so
the allocation pool sees the leave immediately.
"""

import uuid
from datetime import date, datetime, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.attendance import (
    AttendanceDay,
    AttendanceRequest,
    OPEN_REQUEST_STATUSES,
)
from app.models.property import Property
from app.models.user import User, UserRole
from app.services.audit import AuditService
from app.services.structure import ConflictErr, NotFoundErr, ValidationErr


def _date_range(from_date: str, to_date: str) -> list[str]:
    """Inclusive IST 'YYYY-MM-DD' keys — ISO strings compare lexically."""
    start = date.fromisoformat(from_date)
    end = date.fromisoformat(to_date)
    if end < start:
        return []
    return [
        date.fromordinal(start.toordinal() + i).isoformat()
        for i in range((end - start).days + 1)
    ]


def request_out(r: AttendanceRequest) -> dict:
    return {
        "request_uid": str(r.id),
        "property_uid": str(r.property_id),
        "employee_uid": str(r.employee_id) if r.employee_id else None,
        "employee_name": r.employee_name,
        "from_date": r.from_date,
        "to_date": r.to_date,
        "request_type": r.request_type,
        "leave_type": r.leave_type,
        "reason": r.reason,
        "requested_days": r.requested_days,
        "status": r.status,
        "reviewed_by": r.reviewed_by_name,
        "reviewed_at": r.reviewed_at.isoformat() if r.reviewed_at else None,
        "review_comment": r.review_comment,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


class AttendanceService:
    def __init__(self, session: AsyncSession):
        self.session = session

    def _require_super_admin(self, user: User) -> None:
        from app.dependencies.auth import Forbidden

        if user.role != UserRole.SUPER_ADMIN:
            raise Forbidden()

    async def list_requests(
        self, user: User, *, status: str | None = None
    ) -> list[AttendanceRequest]:
        """Company-scoped review queue — Super Admin only, newest first."""
        self._require_super_admin(user)
        q = (
            select(AttendanceRequest)
            .join(Property, AttendanceRequest.property_id == Property.id)
            .where(Property.company_id == user.company_id)
            .order_by(
                AttendanceRequest.created_at.desc(),
            )
        )
        if status:
            if status not in ("pending", "approved", "rejected", "cancelled"):
                raise ValidationErr("Unknown status filter.")
            q = q.where(AttendanceRequest.status == status)
        res = await self.session.execute(q)
        return list(res.scalars())

    async def _request_for_review(
        self, user: User, request_id: uuid.UUID
    ) -> AttendanceRequest:
        """FOR UPDATE lock + company scope. Cross-company → 404, never a leak."""
        self._require_super_admin(user)
        res = await self.session.execute(
            select(AttendanceRequest)
            .where(AttendanceRequest.id == request_id)
            .with_for_update()
        )
        req = res.scalar_one_or_none()
        if req is None:
            raise NotFoundErr("Request not found.")
        prop = await self.session.get(Property, req.property_id)
        if prop is None or prop.company_id != user.company_id:
            raise NotFoundErr("Request not found.")
        return req

    async def _materialize_range(self, req: AttendanceRequest) -> None:
        """Stamp every date in [from..to] with the day status — 'leave' or
        'week_off'. One range SELECT up front (no N+1); existing days are
        updated in place, missing ones inserted. A worked/started day
        anywhere in the range aborts the approval, naming the date."""
        day_status = req.request_type  # 'leave' | 'week_off'
        res = await self.session.execute(
            select(AttendanceDay)
            .where(
                AttendanceDay.employee_id == req.employee_id,
                AttendanceDay.attendance_date >= req.from_date,
                AttendanceDay.attendance_date <= req.to_date,
            )
            .with_for_update()
        )
        by_date = {d.attendance_date: d for d in res.scalars()}
        for dstr in _date_range(req.from_date, req.to_date):
            day = by_date.get(dstr)
            if day is not None and (
                day.started_at is not None or day.status == "present"
            ):
                raise ConflictErr(
                    f"Cannot approve — {dstr} already has a workday on record."
                )
        for dstr in _date_range(req.from_date, req.to_date):
            day = by_date.get(dstr)
            if day is None:
                self.session.add(AttendanceDay(
                    property_id=req.property_id,
                    employee_id=req.employee_id,
                    employee_name=req.employee_name,
                    attendance_date=dstr,
                    status=day_status,
                ))
            else:
                day.status = day_status
        try:
            async with self.session.begin_nested():
                await self.session.flush()
        except IntegrityError as exc:
            # A concurrent workday start or approval won the
            # (employee, date) slot — surface as a conflict, never
            # half-materialize the range.
            raise ConflictErr(
                "Cannot approve — a workday was recorded inside the "
                "requested range."
            ) from exc

    async def review_request(
        self, user: User, request_id: uuid.UUID, *, approve: bool,
        review_comment: str | None = None,
    ) -> AttendanceRequest:
        req = await self._request_for_review(user, request_id)
        if req.status != "pending":
            raise ConflictErr(
                f"Only a pending request can be decided — this one is "
                f"{req.status}."
            )
        if approve:
            if req.employee_id is None:
                raise ConflictErr(
                    "The employee record no longer exists — reject the "
                    "request instead."
                )
            overlap = await self.session.execute(
                select(AttendanceRequest).where(
                    AttendanceRequest.employee_id == req.employee_id,
                    AttendanceRequest.id != req.id,
                    AttendanceRequest.from_date <= req.to_date,
                    AttendanceRequest.to_date >= req.from_date,
                    AttendanceRequest.status.in_(OPEN_REQUEST_STATUSES),
                )
            )
            if overlap.scalars().first() is not None:
                raise ConflictErr(
                    "Another pending or approved request overlaps these "
                    "dates — decide it first.",
                    code="OVERLAPPING_REQUEST",
                )
            await self._materialize_range(req)
        req.status = "approved" if approve else "rejected"
        req.reviewed_by_id = user.id
        req.reviewed_by_name = user.name
        req.reviewed_at = datetime.now(timezone.utc)
        req.review_comment = (review_comment or "").strip() or None
        AuditService(self.session).record(
            user,
            entity_type="attendance_request",
            entity_id=req.id,
            entity_name=req.employee_name,
            action=(
                f"{req.request_type}_approved" if approve
                else f"{req.request_type}_rejected"
            ),
            property_id=req.property_id,
            detail={
                "from_date": req.from_date,
                "to_date": req.to_date,
                "request_type": req.request_type,
                "leave_type": req.leave_type,
                "state": req.status,
            },
        )
        await self.session.commit()
        return req
