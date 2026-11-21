import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.dependencies.auth import (
    get_current_user,
    require_super_admin,
)
from app.models.user import User
from app.schemas import workspace as ws
from app.schemas.property import PropertyUpdateRequest
from app.schemas.structure import (
    CompanyUpdateRequest,
)
from app.services.property import PropertyService

from ._common import BadRequest, NotFound, Staff

router = APIRouter()


# ------------------------------- Property update/delete --------------------

@router.patch("/properties/{property_id}")
async def update_property(
    property_id: uuid.UUID,
    payload: PropertyUpdateRequest,
    user: User = Staff,
    session: AsyncSession = Depends(get_db),
):
    return ws.property_out(
        await PropertyService(session).update_property(user, property_id, payload)
    )


@router.delete("/properties/{property_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_property(
    property_id: uuid.UUID,
    user: User = Depends(require_super_admin),
    session: AsyncSession = Depends(get_db),
):
    await PropertyService(session).delete_property(user, property_id)


# ------------------------------- Company -----------------------------------

@router.get("/companies/{company_id}")
async def get_company(
    company_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    if company_id != user.company_id:
        raise NotFound("Company not found.")
    from app.repositories.company import CompanyRepository
    from app.schemas.auth import company_to_out

    company = await CompanyRepository(session).get_by_id(company_id)
    if company is None:
        raise NotFound("Company not found.")
    return company_to_out(company)


@router.patch("/companies/{company_id}")
async def update_company(
    company_id: uuid.UUID,
    payload: CompanyUpdateRequest,
    user: User = Depends(require_super_admin),
    session: AsyncSession = Depends(get_db),
):
    if company_id != user.company_id:
        raise NotFound("Company not found.")
    from app.repositories.company import CompanyRepository
    from app.schemas.auth import company_to_out

    company = await CompanyRepository(session).get_by_id(company_id)
    if company is None:
        raise NotFound("Company not found.")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        data["company_name"] = data.pop("name")
    if "phone" in data:
        data["phone_number"] = data.pop("phone")
    if "operational_day_start" in data:
        if data["operational_day_start"] is None:
            data.pop("operational_day_start")
        else:
            hh, mm = data["operational_day_start"].split(":")
            if not (0 <= int(hh) <= 23 and 0 <= int(mm) <= 59):
                raise BadRequest(
                    "Operational day start must be a valid HH:MM time."
                )
    for k, v in data.items():
        setattr(company, k, v)
    await session.commit()
    return company_to_out(company)
