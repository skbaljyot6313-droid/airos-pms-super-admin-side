"""OrganizationService — per-property 12-char registration codes.

One company can run many properties and an employee joins a PROPERTY —
each property therefore has its own code, and a mobile-app registration
request resolves the exact property (and its company transitively) from
it. Reading and rotating codes are super-admin-only surfaces — rotation
invalidates the old code for NEW requests instantly (existing approved
employees are untouched; their link is the users row, not the code).
Every rotation is audited.
"""

import uuid

from fastapi import status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppError
from app.core.security import generate_organization_code
from app.models.property import Property
from app.models.user import User
from app.services.audit import AuditService


class PropertyNotFound(AppError):
    status_code = status.HTTP_404_NOT_FOUND
    code = "PROPERTY_NOT_FOUND"
    message = "Property not found."


async def unique_organization_code(session: AsyncSession) -> str:
    """Generate a code that doesn't collide with any property's."""
    for _ in range(20):
        code = generate_organization_code()
        exists = await session.scalar(
            select(Property.id).where(Property.organization_code == code)
        )
        if exists is None:
            return code
    # 32^12 codes — reaching this means something is deeply wrong.
    raise RuntimeError("Could not allocate a unique organization code.")


class OrganizationService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.audit = AuditService(session)

    async def list_codes(self, user: User) -> list[Property]:
        """Every property in the caller's company, with its code. The
        caller's ``company_id`` is the ONLY tenant scope — an admin can
        never reach another organization's codes."""
        res = await self.session.execute(
            select(Property)
            .where(Property.company_id == user.company_id)
            .order_by(Property.name)
        )
        return list(res.scalars())

    async def _company_property(
        self, user: User, property_id: uuid.UUID
    ) -> Property:
        prop = await self.session.scalar(
            select(Property).where(
                Property.id == property_id,
                Property.company_id == user.company_id,
            )
        )
        if prop is None:
            # Same 404 whether it doesn't exist or belongs to another
            # organization — no cross-tenant existence leak.
            raise PropertyNotFound()
        return prop

    async def regenerate_code(
        self, user: User, property_id: uuid.UUID
    ) -> Property:
        prop = await self._company_property(user, property_id)
        old = prop.organization_code
        prop.organization_code = await unique_organization_code(
            self.session
        )
        self.audit.record(
            user,
            entity_type="property",
            entity_id=prop.id,
            entity_name=prop.name,
            action="organization_code_regenerated",
            property_id=prop.id,
            detail={
                # Old code is partially masked — enough to correlate an
                # audit row with a leaked/reported code, not enough to
                # keep using it.
                "previous_code_hint": f"{old[:4]}…{old[-2:]}" if old else None,
                "new_code_hint": (
                    f"{prop.organization_code[:4]}…"
                    f"{prop.organization_code[-2:]}"
                ),
            },
        )
        await self.session.commit()
        await self.session.refresh(prop)
        return prop
