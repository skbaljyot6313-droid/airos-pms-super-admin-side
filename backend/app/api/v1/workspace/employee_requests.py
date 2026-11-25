"""Employee registration requests + organization code endpoints.

Super admins see the whole organization; property managers are pinned
to their own ``property_id`` by the services — they can list accounts,
review and decide requests, and read/rotate the code only for the
property they manage. Other roles stay locked out: registration
requests carry personal + compensation data, and the organization code
is the key that admits new requests.
"""
import uuid

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.exceptions import AppError
from app.dependencies.auth import require_property_manager
from app.models.user import User
from app.schemas.employee_requests import (
    AccountListResponse,
    AccountOut,
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

Staff = Depends(require_property_manager)


class _NotFound(AppError):
    status_code = status.HTTP_404_NOT_FOUND
    code = "NOT_FOUND"
    message = "The requested resource was not found."


def _uid(v: str | None) -> uuid.UUID | None:
    if not v:
        return None
    try:
        return uuid.UUID(v)
    except ValueError:
        raise _NotFound()


# ------------------------- Organization code -------------------------

@router.get(
    "/organization/code", response_model=OrganizationCodesResponse
)
async def get_organization_codes(
    response: Response,
    user: User = Staff,
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
    user: User = Staff,
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


# ------------------------------ Accounts ------------------------------

@router.get("/accounts", response_model=AccountListResponse)
async def list_accounts(
    property_uid: str | None = Query(default=None),
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    """Login accounts in the caller's organization with their role — the
    Workforce → Accounts roster. ``property_uid`` narrows to one
    property's accounts (company-validated); omitted → the whole org.
    Read-only; account writes happen in signup / request approval /
    employee onboarding."""
    rows = await OrganizationService(session).list_accounts(
        user, property_uid=_uid(property_uid)
    )
    return AccountListResponse(
        items=[
            AccountOut(
                account_uid=str(u.id),
                name=u.name,
                username=u.username,
                email=u.email,
                phone_number=u.phone_number,
                role=u.role.value,
                job_title=u.job_title,
                property_uid=(
                    str(u.property_id) if u.property_id else None
                ),
                property_name=property_name,
                is_active=u.is_active,
                last_login_at=u.last_login_at,
                created_at=u.created_at,
            )
            for u, property_name in rows
        ],
        total=len(rows),
    )


# ------------------------- Employee requests -------------------------

@router.get(
    "/employee-requests", response_model=EmployeeRequestListResponse
)
async def list_employee_requests(
    status: str | None = Query(None, pattern="^(pending|approved|rejected)$"),
    search: str | None = Query(None, max_length=200),
    property_uid: str | None = Query(default=None),
    page: int = Query(1, ge=1, le=100000),
    limit: int = Query(25, ge=1, le=100),
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    pid = _uid(property_uid)
    if pid is not None:
        await OrganizationService(session)._company_property(user, pid)
    items, total = await EmployeeRequestService(session).list_requests(
        user, status_filter=status, search=search, property_id=pid,
        page=page, limit=limit,
    )
    return EmployeeRequestListResponse(
        items=items, total=total, page=page, limit=limit
    )


@router.get(
    "/employee-requests/pending-count",
    response_model=PendingCountResponse,
)
async def employee_requests_pending_count(
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    count = await EmployeeRequestService(session).pending_count(user)
    return PendingCountResponse(pending=count)


@router.get(
    "/employee-requests/{request_id}", response_model=EmployeeRequestOut
)
async def get_employee_request(
    request_id: uuid.UUID,
    user: User = Staff,
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
    user: User = Staff,
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
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    req = await EmployeeRequestService(session).reject(
        user, request_id, payload.reason
    )
    return _out(req)
