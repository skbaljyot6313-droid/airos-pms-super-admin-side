"""Workspace API — departments (org groupings, heads, transfers)."""
import uuid

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.user import User
from app.schemas.department import (
    DepartmentCreateRequest,
    DepartmentHeadAssignRequest,
    DepartmentTransferRequest,
    DepartmentUpdateRequest,
)
from app.services.department import DepartmentService

from ._common import Staff

router = APIRouter()


@router.get("/departments")
async def list_departments(
    response: Response,
    property_id: uuid.UUID,
    include_inactive: bool = True,
    search: str | None = Query(None, max_length=200),
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    response.headers["Cache-Control"] = "private, no-store"
    return await DepartmentService(session).list_departments(
        user, property_id, include_inactive=include_inactive, search=search
    )


@router.get("/departments/overview")
async def department_overview(
    response: Response,
    property_id: uuid.UUID,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    response.headers["Cache-Control"] = "private, no-store"
    return await DepartmentService(session).overview(user, property_id)


@router.get("/departments/transfers")
async def department_transfer_history(
    response: Response,
    property_id: uuid.UUID,
    employee_id: uuid.UUID | None = None,
    limit: int = Query(100, ge=1, le=500),
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    response.headers["Cache-Control"] = "private, no-store"
    return await DepartmentService(session).transfer_history(
        user, property_id, employee_id, limit
    )


@router.post("/departments/transfer")
async def transfer_employees(
    payload: DepartmentTransferRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return await DepartmentService(session).transfer(user, payload)


@router.post("/departments", status_code=status.HTTP_201_CREATED)
async def create_department(
    payload: DepartmentCreateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return await DepartmentService(session).create_department(user, payload)


@router.get("/departments/{department_id}")
async def department_detail(
    department_id: uuid.UUID,
    response: Response,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    response.headers["Cache-Control"] = "private, no-store"
    return await DepartmentService(session).detail(user, department_id)


@router.patch("/departments/{department_id}")
async def update_department(
    department_id: uuid.UUID,
    payload: DepartmentUpdateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return await DepartmentService(session).update_department(
        user, department_id, payload
    )


@router.delete("/departments/{department_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_department(
    department_id: uuid.UUID,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    await DepartmentService(session).delete_department(user, department_id)


@router.put("/departments/{department_id}/head")
async def assign_department_head(
    department_id: uuid.UUID,
    payload: DepartmentHeadAssignRequest | None = None,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return await DepartmentService(session).assign_head(
        user, department_id, payload
    )
