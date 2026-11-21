"""DepartmentService — org-grouping CRUD, heads, transfers, analytics.

Departments are property-scoped administrative groupings; they are
independent of zone/area coverage and never touch task allocation. All
writes are audited; employee moves are additionally recorded in
`department_transfers` (append-only).

Business rules enforced here (backend-authoritative):
- name unique per property (case-insensitive), code unique per property.
- head must be an active employee of the SAME property and may head at
  most ONE department; assigning a head never changes their department.
- delete only when empty (no member employees) — heads are cleared first;
  never cascade-deletes employees.
- transfers require an explicit `head_action` whenever a moved employee
  currently heads a department; replaced heads are audited.
- employee rows are locked FOR UPDATE during transfer so concurrent
  moves can't produce conflicting writes.
"""
import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.department import Department, DepartmentTransfer
from app.models.employee import Employee
from app.models.user import User
from app.schemas.department import (
    DepartmentCreateRequest,
    DepartmentHeadAssignRequest,
    DepartmentOut,
    DepartmentDetailOut,
    DepartmentEmployeeRow,
    DepartmentHeadOut,
    DepartmentOverview,
    DepartmentTransferOut,
    DepartmentTransferRequest,
    DepartmentTransferResult,
    DepartmentUpdateRequest,
)
from app.services.audit import AuditService
from app.services.structure import (
    ConflictErr,
    NotFoundErr,
    StructureService,
    ValidationErr,
)

_DEPT = "department"

# Canonical set auto-provisioned when a property's department structure is
# first materialised — mirrors the staff-form department picklist. System
# departments can be edited/reheaded but never deleted.
DEFAULT_DEPARTMENTS = [
    {"name": "General", "code": "GEN"},
    {"name": "Front Desk Operations", "code": "FDO"},
    {"name": "Housekeeping & Cleanliness", "code": "HKC"},
    {"name": "Maintenance & Engineering", "code": "MNE"},
    {"name": "Food & Beverage", "code": "FNB"},
    {"name": "Guest Experience & Community", "code": "GEC"},
    {"name": "Security & Safety", "code": "SNS"},
    {"name": "Accounts & Administration", "code": "ANA"},
]


class DepartmentService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.structure = StructureService(session)
        self.audit = AuditService(session)

    # ----------------------------- internals -----------------------------

    async def resolve_by_name(
        self, property_id: uuid.UUID, name: str | None
    ) -> Department | None:
        """Case-insensitive name → department row lookup (used to link the
        legacy free-text `employees.department` to a managed row)."""
        if not name:
            return None
        res = await self.session.execute(
            select(Department).where(
                Department.property_id == property_id,
                func.lower(Department.name) == name.strip().lower(),
            )
        )
        return res.scalar_one_or_none()

    async def _get(self, user: User, dept_id: uuid.UUID) -> Department:
        res = await self.session.execute(
            select(Department).where(Department.id == dept_id)
        )
        dept = res.scalar_one_or_none()
        if dept is None:
            raise NotFoundErr("Department not found.")
        await self.structure._property_for_write(user, dept.property_id)
        return dept

    async def _check_name(
        self, dept: Department | None, property_id: uuid.UUID, name: str
    ) -> None:
        q = select(Department.id).where(
            Department.property_id == property_id,
            func.lower(Department.name) == name.strip().lower(),
        )
        if dept is not None:
            q = q.where(Department.id != dept.id)
        if (await self.session.execute(q)).scalar_one_or_none() is not None:
            raise ConflictErr(
                "A department with this name already exists.",
                field="name",
            )

    async def _check_code(
        self, dept: Department | None, property_id: uuid.UUID, code: str | None
    ) -> None:
        if not code:
            return
        q = select(Department.id).where(
            Department.property_id == property_id,
            func.lower(Department.code) == code.strip().lower(),
        )
        if dept is not None:
            q = q.where(Department.id != dept.id)
        if (await self.session.execute(q)).scalar_one_or_none() is not None:
            raise ConflictErr(
                "A department with this code already exists.",
                field="code",
            )

    async def _eligible_head(
        self, user: User, dept: Department, employee_id: uuid.UUID
    ) -> Employee:
        """Validate head eligibility: real, active, same property, not
        already heading another department."""
        res = await self.session.execute(
            select(Employee).where(
                Employee.id == employee_id,
                Employee.property_id == dept.property_id,
            )
        )
        emp = res.scalar_one_or_none()
        if emp is None:
            raise ValidationErr(
                "Department head must be an employee of this property.",
                field="head_employee_uid",
            )
        if emp.deactivated_at is not None or (emp.status or "").lower() != "active":
            raise ValidationErr(
                "An inactive employee cannot be a department head.",
                field="head_employee_uid",
            )
        other = await self.session.execute(
            select(Department.name).where(
                Department.head_employee_id == emp.id,
                Department.id != dept.id,
            )
        )
        other_name = other.scalar_one_or_none()
        if other_name is not None:
            raise ConflictErr(
                f"{emp.name} already heads '{other_name}'. Remove that "
                "assignment first.",
                field="head_employee_uid",
            )
        return emp

    async def _assign_head(
        self,
        user: User,
        dept: Department,
        employee_id: uuid.UUID | None,
        *,
        audit_action: str = "department.head_change",
    ) -> None:
        old = dept.head_employee
        new_name = None
        if employee_id is not None:
            emp = await self._eligible_head(user, dept, employee_id)
            new_name = emp.name
        dept.head_employee_id = employee_id
        if old is not None or employee_id is not None:
            self.audit.record(
                user,
                entity_type=_DEPT,
                entity_id=dept.id,
                entity_name=dept.name,
                action=audit_action,
                property_id=dept.property_id,
                detail={
                    "previous_head": old.name if old else None,
                    "previous_head_uid": str(old.id) if old else None,
                    "new_head": new_name,
                    "new_head_uid": str(employee_id) if employee_id else None,
                },
            )

    def _head_out(self, dept: Department) -> DepartmentHeadOut | None:
        h = dept.head_employee
        if h is None:
            return None
        return DepartmentHeadOut(employee_uid=h.id, name=h.name)

    # -------------------------------- CRUD ---------------------------------

    async def create_department(
        self, user: User, payload: DepartmentCreateRequest
    ) -> DepartmentOut:
        prop = await self.structure._property_for_write(
            user, payload.property_uid
        )
        await self._check_name(None, prop.id, payload.name)
        await self._check_code(None, prop.id, payload.code)
        dept = Department(
            company_id=prop.company_id,
            property_id=prop.id,
            name=payload.name.strip(),
            code=payload.code.strip() if payload.code else None,
            description=payload.description,
            status=payload.status,
            created_by=user.id,
        )
        self.session.add(dept)
        await self.session.flush()
        if payload.head_employee_uid is not None:
            await self._assign_head(user, dept, payload.head_employee_uid)
        self.audit.record(
            user,
            entity_type=_DEPT,
            entity_id=dept.id,
            entity_name=dept.name,
            action="department.create",
            property_id=dept.property_id,
        )
        await self.session.commit()
        await self.session.refresh(dept)
        return await self._out(user, dept)

    async def update_department(
        self, user: User, dept_id: uuid.UUID, payload: DepartmentUpdateRequest
    ) -> DepartmentOut:
        dept = await self._get(user, dept_id)
        if payload.name is not None and payload.name.strip() != dept.name:
            await self._check_name(dept, dept.property_id, payload.name)
            dept.name = payload.name.strip()
        if payload.code is not None or "code" in payload.model_fields_set:
            await self._check_code(dept, dept.property_id, payload.code)
            dept.code = payload.code.strip() if payload.code else None
        if "description" in payload.model_fields_set:
            dept.description = payload.description
        if payload.status is not None:
            dept.status = payload.status
        if payload.clear_head:
            await self._assign_head(user, dept, None)
        elif "head_employee_uid" in payload.model_fields_set:
            await self._assign_head(user, dept, payload.head_employee_uid)
        self.audit.record(
            user,
            entity_type=_DEPT,
            entity_id=dept.id,
            entity_name=dept.name,
            action="department.update",
            property_id=dept.property_id,
            detail={
                k: (str(v) if isinstance(v, uuid.UUID) else v)
                for k, v in payload.model_dump(
                    exclude_unset=True, exclude={"head_employee_uid"}
                ).items()
            },
        )
        await self.session.commit()
        await self.session.refresh(dept)
        return await self._out(user, dept)

    async def _ensure_defaults(self, user: User, property_id: uuid.UUID) -> None:
        """Materialise the canonical department set the first time a
        property's departments are touched. Idempotent — only names not
        already present (as system rows) are created."""
        existing = (
            await self.session.execute(
                select(func.lower(Department.name)).where(
                    Department.property_id == property_id,
                    Department.is_system.is_(True),
                )
            )
        ).scalars().all()
        have = set(existing)
        created = False
        for spec in DEFAULT_DEPARTMENTS:
            if spec["name"].lower() in have:
                continue
            dept = Department(
                company_id=user.company_id,
                property_id=property_id,
                name=spec["name"],
                code=spec["code"],
                description="System-provisioned department.",
                status="active",
                is_system=True,
                created_by=user.id,
            )
            self.session.add(dept)
            created = True
        if not created:
            return
        await self.session.flush()
        self.audit.record(
            user,
            entity_type=_DEPT,
            entity_id=None,
            entity_name=None,
            action="department.provision_defaults",
            property_id=property_id,
        )
        await self.session.commit()

    async def delete_department(self, user: User, dept_id: uuid.UUID) -> None:
        dept = await self._get(user, dept_id)
        if dept.is_system:
            raise ConflictErr(
                f"'{dept.name}' is a system department and cannot be deleted.",
                field="department_uid",
                code="SYSTEM_DEPARTMENT",
            )
        count = (
            await self.session.execute(
                select(func.count(Employee.id)).where(
                    Employee.department_id == dept.id
                )
            )
        ).scalar_one()
        if count:
            raise ConflictErr(
                f"Department has {count} employee(s) assigned. Transfer "
                "them to another department before deleting.",
                field="department_uid",
            )
        if dept.head_employee_id is not None:
            await self._assign_head(user, dept, None)
        self.audit.record(
            user,
            entity_type=_DEPT,
            entity_id=dept.id,
            entity_name=dept.name,
            action="department.delete",
            property_id=dept.property_id,
        )
        await self.session.delete(dept)
        await self.session.commit()

    async def assign_head(
        self,
        user: User,
        dept_id: uuid.UUID,
        payload: DepartmentHeadAssignRequest | None,
    ) -> DepartmentOut:
        dept = await self._get(user, dept_id)
        await self._assign_head(
            user, dept, payload.employee_uid if payload else None
        )
        await self.session.commit()
        await self.session.refresh(dept)
        return await self._out(user, dept)

    # ------------------------------ transfers ------------------------------

    async def transfer(
        self, user: User, payload: DepartmentTransferRequest
    ) -> DepartmentTransferResult:
        prop = await self.structure._property_for_write(
            user, payload.property_uid
        )

        target: Department | None = None
        if payload.to_department_uid is not None:
            res = await self.session.execute(
                select(Department).where(
                    Department.id == payload.to_department_uid,
                    Department.property_id == prop.id,
                )
            )
            target = res.scalar_one_or_none()
            if target is None:
                raise ValidationErr(
                    "Destination department not found in this property.",
                    field="to_department_uid",
                )
            if target.status != "active":
                raise ValidationErr(
                    "Cannot transfer employees to an inactive department.",
                    field="to_department_uid",
                )

        # Lock employee rows FOR UPDATE — concurrent transfers can't
        # interleave conflicting writes.
        res = await self.session.execute(
            select(Employee)
            .where(
                Employee.id.in_(payload.employee_uids),
                Employee.property_id == prop.id,
            )
            .with_for_update()
        )
        emps = {e.id: e for e in res.scalars().all()}
        missing = [str(u) for u in payload.employee_uids if u not in emps]
        if missing:
            raise ValidationErr(
                f"Employee(s) not found in this property: {', '.join(missing)}",
                field="employee_uids",
            )

        # Head conflict only when the employee is a MEMBER of the
        # department they head and is being moved OUT of it — a head who
        # isn't a member is unaffected by membership transfers.
        res = await self.session.execute(
            select(Department).where(
                Department.head_employee_id.in_(emps.keys()),
                Department.property_id == prop.id,
            )
        )
        headed = [
            d
            for d in res.scalars().all()
            if (
                emps[d.head_employee_id].department_id == d.id
                and payload.to_department_uid != d.id
            )
        ]
        decisions: list[str] = []
        if headed:
            if payload.head_action is None:
                names = ", ".join(
                    f"{e.name} (heads '{d.name}')"
                    for d in headed
                    for e in emps.values()
                    if d.head_employee_id == e.id
                )
                raise ConflictErr(
                    f"Transfer includes department head(s): {names}. "
                    "Choose 'clear' to remove the head or 'replace' to "
                    "assign a replacement.",
                    field="head_action",
                )
            for d in headed:
                if payload.head_action == "clear":
                    await self._assign_head(user, d, None)
                    decisions.append(f"cleared head of '{d.name}'")
                else:
                    if payload.replacement_head_uid is None:
                        raise ValidationErr(
                            "replacement_head_uid is required when "
                            "head_action is 'replace'.",
                            field="replacement_head_uid",
                        )
                    await self._assign_head(
                        user, d, payload.replacement_head_uid
                    )
                    decisions.append(
                        f"replaced head of '{d.name}'"
                    )

        dept_names = {
            row.id: row.name
            for row in (
                await self.session.execute(
                    select(Department).where(Department.property_id == prop.id)
                )
            ).scalars()
        }

        transfers: list[DepartmentTransfer] = []
        moved = 0
        for e in emps.values():
            if e.department_id == payload.to_department_uid:
                continue  # idempotent — already there
            moved += 1
            tr = DepartmentTransfer(
                employee_id=e.id,
                property_id=prop.id,
                from_department_id=e.department_id,
                from_department_name=dept_names.get(e.department_id),
                to_department_id=target.id if target else None,
                to_department_name=target.name if target else None,
                reason=payload.reason,
                changed_by=user.id,
                changed_by_name=user.name,
            )
            self.session.add(tr)
            transfers.append(tr)
            e.department_id = target.id if target else None
            e.department = target.name if target else None  # legacy text col
        if transfers:
            await self.session.flush()
        transfer_ids = [t.id for t in transfers]

        self.audit.record(
            user,
            entity_type=_DEPT,
            entity_id=payload.to_department_uid,
            entity_name=target.name if target else None,
            action="department.bulk_transfer"
            if len(emps) > 1
            else "department.transfer",
            property_id=prop.id,
            detail={
                "employee_count": moved,
                "to_department": target.name if target else None,
                "reason": payload.reason,
                "head_decisions": decisions,
            },
        )
        await self.session.commit()
        return DepartmentTransferResult(
            transferred=moved,
            transfer_uids=transfer_ids,
            head_decisions=decisions,
        )

    # ------------------------------- reads ---------------------------------

    async def _counts(self, dept_ids: list[uuid.UUID]) -> dict:
        if not dept_ids:
            return {}
        rows = (
            await self.session.execute(
                select(
                    Employee.department_id,
                    func.count(Employee.id),
                    func.count(Employee.id).filter(
                        Employee.deactivated_at.is_(None)
                    ),
                )
                .where(Employee.department_id.in_(dept_ids))
                .group_by(Employee.department_id)
            )
        ).all()
        return {r[0]: (r[1], r[2]) for r in rows}

    async def _out(self, user: User, dept: Department) -> DepartmentOut:
        counts = await self._counts([dept.id])
        total, active = counts.get(dept.id, (0, 0))
        return DepartmentOut(
            department_uid=dept.id,
            property_uid=dept.property_id,
            name=dept.name,
            code=dept.code,
            description=dept.description,
            status=dept.status,
            is_system=dept.is_system,
            head=self._head_out(dept),
            employee_count=total,
            active_employee_count=active,
            created_at=dept.created_at,
        )

    async def list_departments(
        self,
        user: User,
        property_id: uuid.UUID,
        *,
        include_inactive: bool = True,
        search: str | None = None,
    ) -> list[DepartmentOut]:
        await self.structure._property_for_write(user, property_id)
        await self._ensure_defaults(user, property_id)
        q = (
            select(Department)
            .where(Department.property_id == property_id)
            .order_by(Department.name)
        )
        if not include_inactive:
            q = q.where(Department.status == "active")
        if search:
            q = q.where(Department.name.ilike(f"%{search}%"))
        depts = list((await self.session.execute(q)).scalars().all())
        counts = await self._counts([d.id for d in depts])
        return [
            DepartmentOut(
                department_uid=d.id,
                property_uid=d.property_id,
                name=d.name,
                code=d.code,
                description=d.description,
                status=d.status,
                is_system=d.is_system,
                head=self._head_out(d),
                employee_count=counts.get(d.id, (0, 0))[0],
                active_employee_count=counts.get(d.id, (0, 0))[1],
                created_at=d.created_at,
            )
            for d in depts
        ]

    async def detail(self, user: User, dept_id: uuid.UUID) -> DepartmentDetailOut:
        dept = await self._get(user, dept_id)
        base = await self._out(user, dept)
        rows = (
            await self.session.execute(
                select(Employee)
                .where(Employee.department_id == dept.id)
                .order_by(Employee.name)
            )
        ).scalars().all()
        return DepartmentDetailOut(
            **base.model_dump(),
            employees=[
                DepartmentEmployeeRow(
                    employee_uid=e.id,
                    name=e.name,
                    email=e.email,
                    job_title=e.job_title,
                    status=e.status,
                    is_head=dept.head_employee_id == e.id,
                )
                for e in rows
            ],
        )

    async def overview(
        self, user: User, property_id: uuid.UUID
    ) -> DepartmentOverview:
        await self.structure._property_for_write(user, property_id)
        depts = await self.list_departments(
            user, property_id, include_inactive=True
        )
        emp_row = (
            await self.session.execute(
                select(
                    func.count(Employee.id),
                    func.count(Employee.id).filter(
                        Employee.deactivated_at.is_(None)
                    ),
                    func.count(Employee.id).filter(
                        Employee.department_id.is_(None)
                    ),
                ).where(Employee.property_id == property_id)
            )
        ).one()
        total, active, unassigned = emp_row
        active_depts = [d for d in depts if d.status == "active"]
        no_head = sum(1 for d in active_depts if d.head is None)
        return DepartmentOverview(
            total_employees=total,
            active_employees=active,
            inactive_employees=total - active,
            total_departments=len(depts),
            unassigned_employees=unassigned,
            departments_without_head=no_head,
            avg_employees_per_department=(
                round(total / len(depts), 1) if depts else 0.0
            ),
            departments=depts,
        )

    async def transfer_history(
        self,
        user: User,
        property_id: uuid.UUID,
        employee_id: uuid.UUID | None = None,
        limit: int = 100,
    ) -> list[DepartmentTransferOut]:
        await self.structure._property_for_write(user, property_id)
        q = (
            select(DepartmentTransfer, Employee.name)
            .outerjoin(
                Employee, Employee.id == DepartmentTransfer.employee_id
            )
            .where(DepartmentTransfer.property_id == property_id)
            .order_by(DepartmentTransfer.created_at.desc())
            .limit(min(limit, 500))
        )
        if employee_id is not None:
            q = q.where(DepartmentTransfer.employee_id == employee_id)
        rows = (await self.session.execute(q)).all()
        return [
            DepartmentTransferOut(
                transfer_uid=t.id,
                employee_uid=t.employee_id,
                employee_name=name,
                from_department_uid=t.from_department_id,
                from_department_name=t.from_department_name,
                to_department_uid=t.to_department_id,
                to_department_name=t.to_department_name,
                reason=t.reason,
                changed_by_name=t.changed_by_name,
                created_at=t.created_at,
            )
            for t, name in rows
        ]
