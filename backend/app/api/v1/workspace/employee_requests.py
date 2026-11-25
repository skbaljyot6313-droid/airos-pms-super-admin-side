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
    OrganizationCodesResponse,
    PendingCountResponse,
    PropertyCodeOut,
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
    "/organization/code", response_model=OrganizationCodesResponse
)
async def get_organization_codes(
    response: Response,
    user: User = SuperAdmin,
    session: AsyncSession = Depends(get_db),
):
    """Every property in the caller's organization with its own code —
    a code admits registrations into that specific property."""
    response.headers["Cache-Control"] = "private, no-store"
    props = await OrganizationService(session).list_codes(user)
    return OrganizationCodesResponse(
        items=[
            PropertyCodeOut(
                property_uid=str(p.id),
                property_name=p.name,
                organization_code=p.organization_code,
            )
            for p in props
        ]
    )


@router.post(
    "/organization/code/{property_id}/regenerate",
    response_model=PropertyCodeOut,
)
async def regenerate_organization_code(
    property_id: uuid.UUID,
    user: User = SuperAdmin,
    session: AsyncSession = Depends(get_db),
):
    prop = await OrganizationService(session).regenerate_code(
        user, property_id
    )
    return PropertyCodeOut(
        property_uid=str(prop.id),
        property_name=prop.name,
        organization_code=prop.organization_code,
    )


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
