"""OrganizationService — the organization's 12-char registration code.

The code is what admits a mobile-app registration request into this
company. Reading it and rotating it are super-admin-only surfaces —
rotation invalidates the old code for NEW requests instantly (existing
approved employees are untouched; their link is the users row, not the
code). Every rotation is audited.
"""

import uuid

from fastapi import status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppError
from app.core.security import generate_organization_code
from app.models.company import Company
from app.models.user import User
from app.services.audit import AuditService


class OrganizationNotFound(AppError):
    status_code = status.HTTP_404_NOT_FOUND
    code = "ORGANIZATION_NOT_FOUND"
    message = "Organization not found."


async def unique_organization_code(session: AsyncSession) -> str:
    """Generate a code that doesn't collide with any company's."""
    for _ in range(20):
        code = generate_organization_code()
        exists = await session.scalar(
            select(Company.id).where(Company.organization_code == code)
        )
        if exists is None:
            return code
    # 32^12 codes — reaching this means something is deeply wrong.
    raise RuntimeError("Could not allocate a unique organization code.")


class OrganizationService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.audit = AuditService(session)

    async def _company(self, user: User) -> Company:
        # Requests resolve the company from the CALLER's own
        # company_id — an admin can never reach another org's code.
        company = await self.session.scalar(
            select(Company).where(Company.id == user.company_id)
        )
        if company is None:
            raise OrganizationNotFound()
        return company

    async def get_code(self, user: User) -> str:
        return (await self._company(user)).organization_code

    async def regenerate_code(self, user: User) -> str:
        company = await self._company(user)
        old = company.organization_code
        company.organization_code = await unique_organization_code(
            self.session
        )
        self.audit.record(
            user,
            entity_type="company",
            entity_id=company.id,
            entity_name=company.company_name,
            action="organization_code_regenerated",
            property_id=None,
            detail={
                # Old code is partially masked — enough to correlate an
                # audit row with a leaked/reported code, not enough to
                # keep using it.
                "previous_code_hint": f"{old[:4]}…{old[-2:]}" if old else None,
                "new_code_hint": (
                    f"{company.organization_code[:4]}…"
                    f"{company.organization_code[-2:]}"
                ),
            },
        )
        await self.session.commit()
        return company.organization_code
