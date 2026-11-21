"""Department-manager authorization scope.

A ``department_manager`` user is linked to an employee record
(``User.employee_id``). They may operate the departments they head
(``departments.head_employee_id``) plus the department their own
employee record belongs to. Everywhere else they are read-denied —
cross-department access returns NotFound so the existence of other
departments is not leaked.

Super Admin and Property Manager are unrestricted (``None`` scope).
"""
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import Forbidden
from app.models.department import Department
from app.models.employee import Employee
from app.models.user import User, UserRole
from app.services.structure import NotFoundErr

SCOPED_ROLES = (UserRole.DEPARTMENT_MANAGER,)


async def managed_department_ids(
    session: AsyncSession, user: User
) -> set[uuid.UUID] | None:
    """None → unrestricted staff; set → the departments this manager owns."""
    if user.role in (UserRole.SUPER_ADMIN, UserRole.PROPERTY_MANAGER):
        return None
    if user.role != UserRole.DEPARTMENT_MANAGER or not user.employee_id:
        return set()
    ids = set(
        (await session.execute(
            select(Department.id).where(
                Department.head_employee_id == user.employee_id)
        )).scalars().all()
    )
    own = await session.scalar(
        select(Employee.department_id).where(Employee.id == user.employee_id)
    )
    if own:
        ids.add(own)
    return ids


async def department_for_user(
    session: AsyncSession, user: User, department_id: uuid.UUID
) -> Department:
    """Fetch a department the caller may operate; NotFound on any
    out-of-scope id (never a 403 that would leak its existence)."""
    dept = await session.get(Department, department_id)
    if dept is None:
        raise NotFoundErr("Department not found.")
    if user.role == UserRole.SUPER_ADMIN and dept.company_id != user.company_id:
        raise NotFoundErr("Department not found.")
    if user.role in SCOPED_ROLES + (UserRole.PROPERTY_MANAGER,) and (
        user.property_id and dept.property_id != user.property_id
    ):
        raise NotFoundErr("Department not found.")
    ids = await managed_department_ids(session, user)
    if ids is not None and dept.id not in ids:
        raise NotFoundErr("Department not found.")
    return dept


async def employee_in_department(
    session: AsyncSession, department: Department, employee_id: uuid.UUID
) -> Employee:
    """Resolve an employee that belongs to this department — the only
    population a department manager may assign work to."""
    emp = await session.get(Employee, employee_id)
    if emp is None or emp.department_id != department.id:
        raise Forbidden("Employee is not a member of this department.")
    if emp.property_id != department.property_id:
        raise Forbidden("Employee is not in this property.")
    return emp
