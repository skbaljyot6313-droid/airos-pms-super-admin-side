"""Attendance — leave/week-off request review (Super Admin).

Requests are filed in the employee application; this router is the
management-side decision surface on the shared database.
"""

import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.dependencies.auth import require_property_manager
from app.models.user import User
from app.services.attendance import (
    AttendanceService,
    day_status_board,
    request_out,
)

router = APIRouter(prefix="/attendance", tags=["attendance"])


@router.get("/status-board")
async def status_board(
    property_id: uuid.UUID | None = None,
    date: str | None = None,
    user: User = Depends(require_property_manager),
    session: AsyncSession = Depends(get_db),
):
    """Schedule-aware attendance for one IST operational day —
    super_admin picks any company property; PMs are pinned to theirs."""
    return await day_status_board(
        session, user, property_id, op_date=date
    )


class AttendanceReviewBody(BaseModel):
    review_comment: str | None = Field(default=None, max_length=2000)


@router.get("/requests")
async def list_requests(
    status: str | None = None,
    user: User = Depends(require_property_manager),
    session: AsyncSession = Depends(get_db),
):
    svc = AttendanceService(session)
    requests = await svc.list_requests(user, status=status)
    return {
        "items": [request_out(r) for r in requests],
        "total": len(requests),
        "page": 1,
        "limit": len(requests),
    }


@router.post("/requests/{request_uid}/approve")
async def approve_request(
    request_uid: uuid.UUID,
    body: AttendanceReviewBody | None = None,
    user: User = Depends(require_property_manager),
    session: AsyncSession = Depends(get_db),
):
    svc = AttendanceService(session)
    req = await svc.review_request(
        user, request_uid, approve=True,
        review_comment=body.review_comment if body else None,
    )
    return request_out(req)


@router.post("/requests/{request_uid}/reject")
async def reject_request(
    request_uid: uuid.UUID,
    body: AttendanceReviewBody | None = None,
    user: User = Depends(require_property_manager),
    session: AsyncSession = Depends(get_db),
):
    svc = AttendanceService(session)
    req = await svc.review_request(
        user, request_uid, approve=False,
        review_comment=body.review_comment if body else None,
    )
    return request_out(req)
