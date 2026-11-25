"""Employee registration requests + organization code endpoints.

The whole surface is super_admin-only: registration requests carry
personal + compensation data, and the organization code is the key that
admits new requests — neither may leak to property-level staff.
"""
import uuid

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.dependencies.auth import require_super_admin
from app.models.user import User
from app.schemas.employee_requests import (
    EmployeeRequestApproveIn,
    EmployeeRequestApproveResponse,
    EmployeeRequestListResponse,
    EmployeeRequestOut,
    EmployeeRequestRejectIn,
    OrganizationCodeResponse,
    PendingCountResponse,
)
from app.services.employee_requests import (
    EmployeeRequestService,
    _out,
)
from app.services.organization import OrganizationService

router = APIRouter()

SuperAdmin = Depends(require_super_admin)


# ------------------------- Organization code -------------------------

@router.get(
    "/organization/code", response_model=OrganizationCodeResponse
)
async def get_organization_code(
    response: Response,
    user: User = SuperAdmin,
    session: AsyncSession = Depends(get_db),
):
    response.headers["Cache-Control"] = "private, no-store"
    code = await OrganizationService(session).get_code(user)
    return OrganizationCodeResponse(organization_code=code)


@router.post(
    "/organization/code/regenerate",
    response_model=OrganizationCodeResponse,
)
async def regenerate_organization_code(
    user: User = SuperAdmin,
    session: AsyncSession = Depends(get_db),
):
    code = await OrganizationService(session).regenerate_code(user)
    return OrganizationCodeResponse(organization_code=code)


# ------------------------- Employee requests -------------------------

@router.get(
    "/employee-requests", response_model=EmployeeRequestListResponse
)
async def list_employee_requests(
    status: str | None = Query(None, pattern="^(pending|approved|rejected)$"),
    search: str | None = Query(None, max_length=200),
    page: int = Query(1, ge=1, le=100000),
    limit: int = Query(25, ge=1, le=100),
    user: User = SuperAdmin,
    session: AsyncSession = Depends(get_db),
):
    items, total = await EmployeeRequestService(session).list_requests(
        user, status_filter=status, search=search, page=page, limit=limit
    )
    return EmployeeRequestListResponse(
        items=items, total=total, page=page, limit=limit
    )


@router.get(
    "/employee-requests/pending-count",
    response_model=PendingCountResponse,
)
async def employee_requests_pending_count(
    user: User = SuperAdmin,
    session: AsyncSession = Depends(get_db),
):
    count = await EmployeeRequestService(session).pending_count(user)
    return PendingCountResponse(pending=count)


@router.get(
    "/employee-requests/{request_id}", response_model=EmployeeRequestOut
)
async def get_employee_request(
    request_id: uuid.UUID,
    user: User = SuperAdmin,
    session: AsyncSession = Depends(get_db),
):
    req = await EmployeeRequestService(session).get_request(user, request_id)
    return _out(req)


@router.post(
    "/employee-requests/{request_id}/approve",
    response_model=EmployeeRequestApproveResponse,
)
async def approve_employee_request(
    request_id: uuid.UUID,
    payload: EmployeeRequestApproveIn,
    user: User = SuperAdmin,
    session: AsyncSession = Depends(get_db),
):
    req, emp_id, user_id = await EmployeeRequestService(session).approve(
        user, request_id, payload
    )
    return EmployeeRequestApproveResponse(
        request_uid=str(req.id),
        status="approved",
        employee_uid=str(emp_id),
        user_uid=str(user_id) if user_id else "",
        username=req.username,
    )


@router.post(
    "/employee-requests/{request_id}/reject",
    response_model=EmployeeRequestOut,
)
async def reject_employee_request(
    request_id: uuid.UUID,
    payload: EmployeeRequestRejectIn,
    user: User = SuperAdmin,
    session: AsyncSession = Depends(get_db),
):
    req = await EmployeeRequestService(session).reject(
        user, request_id, payload.reason
    )
    return _out(req)
