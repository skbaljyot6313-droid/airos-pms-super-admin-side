"""Department management — CRUD, heads, transfers, analytics.

SQLite-backed service tests (same pattern as test_employee_profile):
sync Session behind a minimal async shim; only the touched tables are
created.
"""

import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models.department import Department, DepartmentTransfer
from app.models.employee import Employee, EmployeeAreaAssignment
from app.models.property import Property
from app.models.audit import AuditEvent
from app.models.user import UserRole
from app.schemas.department import (
    DepartmentCreateRequest,
    DepartmentHeadAssignRequest,
    DepartmentTransferRequest,
    DepartmentUpdateRequest,
)
from app.services.department import DepartmentService
from app.services.structure import ConflictErr, ValidationErr

CID = uuid.uuid4()
PID = uuid.uuid4()
AID = uuid.uuid4()  # admin user


class AsyncShim:
    """Minimal AsyncSession facade over a sync Session — covers the verbs
    DepartmentService uses (execute/add/flush/commit/refresh/delete)."""

    def __init__(self, sync: Session):
        self._s = sync

    async def execute(self, stmt):
        return self._s.execute(stmt)

    def add(self, obj):
        self._s.add(obj)

    async def flush(self):
        self._s.flush()

    async def commit(self):
        self._s.commit()

    async def refresh(self, obj):
        self._s.refresh(obj)

    async def delete(self, obj):
        self._s.delete(obj)

    # AuditService.session.add already covered; session.info unused.


@pytest.fixture
def data():
    engine = create_engine("sqlite://")
    for model in (Property, Employee, EmployeeAreaAssignment, Department, DepartmentTransfer, AuditEvent):
        model.__table__.create(engine)
    with Session(engine) as session:
        session.add(
            Property(
                id=PID, company_id=CID, name="Prop", code="P1",
                location="Loc", city="City", state="State",
                manager_name="M", manager_email="m@x.test",
            )
        )
        emps = {}
        for i, name in enumerate(("Asha", "Bala", "Chin", "Devi")):
            e = Employee(
                id=uuid.uuid4(), company_id=CID, property_id=PID,
                name=name, email=f"{name}@x.test", status="Active",
            )
            if name == "Devi":
                e.deactivated_at = datetime.now(UTC)
            session.add(e)
            emps[name] = e
        session.commit()

        admin = SimpleNamespace(
            id=AID, role=UserRole.SUPER_ADMIN, company_id=CID,
            property_id=None, name="Admin",
        )
        pm = SimpleNamespace(
            id=uuid.uuid4(), role=UserRole.PROPERTY_MANAGER,
            company_id=CID, property_id=PID, name="PM",
        )
        foreign = SimpleNamespace(
            id=uuid.uuid4(), role=UserRole.PROPERTY_MANAGER,
            company_id=CID, property_id=uuid.uuid4(), name="Other",
        )
        yield SimpleNamespace(
            svc=DepartmentService(AsyncShim(session)),
            session=session, admin=admin, pm=pm, foreign=foreign,
            emps=emps,
        )
    engine.dispose()


def _mk(name="Housekeeping", **kw):
    return DepartmentCreateRequest(
        property_uid=PID, name=name, **kw
    )


async def test_create_and_duplicate_name(data):
    d = await data.svc.create_department(data.pm, _mk())
    assert d.name == "Housekeeping" and d.status == "active"
    with pytest.raises(ConflictErr):
        await data.svc.create_department(data.pm, _mk(name=" housekeeping "))


async def test_create_with_head_and_inactive_head_rejected(data):
    d = await data.svc.create_department(
        data.pm, _mk(head_employee_uid=data.emps["Asha"].id)
    )
    assert d.head and d.head.employee_uid == data.emps["Asha"].id
    with pytest.raises(ValidationErr):
        await data.svc.create_department(
            data.pm, _mk(name="F&B", head_employee_uid=data.emps["Devi"].id)
        )


async def test_head_cannot_head_two_departments(data):
    await data.svc.create_department(
        data.pm, _mk(head_employee_uid=data.emps["Asha"].id)
    )
    with pytest.raises(ConflictErr):
        await data.svc.create_department(
            data.pm, _mk(name="Kitchen", head_employee_uid=data.emps["Asha"].id)
        )


async def test_head_assignment_does_not_change_department(data):
    d = await data.svc.create_department(data.pm, _mk())
    d = await data.svc.assign_head(
        data.pm, d.department_uid,
        DepartmentHeadAssignRequest(employee_uid=data.emps["Bala"].id),
    )
    assert d.head.employee_uid == data.emps["Bala"].id
    assert data.emps["Bala"].department_id is None  # unchanged


async def test_head_change_audited(data):
    d = await data.svc.create_department(
        data.pm, _mk(head_employee_uid=data.emps["Asha"].id)
    )
    await data.svc.assign_head(
        data.pm, d.department_uid,
        DepartmentHeadAssignRequest(employee_uid=data.emps["Bala"].id),
    )
    evs = data.session.execute(
        select(AuditEvent).where(AuditEvent.action == "department.head_change")
    ).scalars().all()
    assert any(
        e.detail.get("previous_head") == "Asha"
        and e.detail.get("new_head") == "Bala"
        for e in evs
    )


async def test_update_status_and_clear_head(data):
    d = await data.svc.create_department(
        data.pm, _mk(head_employee_uid=data.emps["Asha"].id)
    )
    d = await data.svc.update_department(
        data.pm, d.department_uid,
        DepartmentUpdateRequest(status="inactive", clear_head=True),
    )
    assert d.status == "inactive" and d.head is None


async def test_delete_only_when_empty(data):
    d = await data.svc.create_department(data.pm, _mk())
    # put an employee in it
    await data.svc.transfer(
        data.pm,
        DepartmentTransferRequest(
            property_uid=PID,
            employee_uids=[data.emps["Asha"].id],
            to_department_uid=d.department_uid,
        ),
    )
    with pytest.raises(ConflictErr):
        await data.svc.delete_department(data.pm, d.department_uid)
    # empty it, then delete works
    await data.svc.transfer(
        data.pm,
        DepartmentTransferRequest(
            property_uid=PID,
            employee_uids=[data.emps["Asha"].id],
            to_department_uid=None,
        ),
    )
    await data.svc.delete_department(data.pm, d.department_uid)
    assert (
        data.session.execute(
            select(Department).where(Department.id == d.department_uid)
        ).scalar_one_or_none()
        is None
    )


async def test_transfer_writes_history_and_dual_write(data):
    d = await data.svc.create_department(data.pm, _mk())
    r = await data.svc.transfer(
        data.pm,
        DepartmentTransferRequest(
            property_uid=PID,
            employee_uids=[data.emps["Asha"].id, data.emps["Bala"].id],
            to_department_uid=d.department_uid,
            reason="reorg",
        ),
    )
    assert r.transferred == 2
    assert data.emps["Asha"].department_id == d.department_uid
    assert data.emps["Asha"].department == "Housekeeping"  # legacy text col
    hist = await data.svc.transfer_history(data.pm, PID)
    assert len(hist) == 2
    assert hist[0].to_department_name == "Housekeeping"
    assert hist[0].from_department_name is None


async def test_transfer_to_inactive_department_rejected(data):
    d = await data.svc.create_department(
        data.pm, _mk(status="inactive")
    )
    with pytest.raises(ValidationErr):
        await data.svc.transfer(
            data.pm,
            DepartmentTransferRequest(
                property_uid=PID,
                employee_uids=[data.emps["Asha"].id],
                to_department_uid=d.department_uid,
            ),
        )


async def test_transfer_missing_employee_rejected(data):
    with pytest.raises(ValidationErr):
        await data.svc.transfer(
            data.pm,
            DepartmentTransferRequest(
                property_uid=PID,
                employee_uids=[uuid.uuid4()],
                to_department_uid=None,
            ),
        )


async def test_transfer_head_requires_decision(data):
    d = await data.svc.create_department(
        data.pm, _mk(head_employee_uid=data.emps["Asha"].id)
    )
    d2 = await data.svc.create_department(data.pm, _mk(name="F&B"))
    # Asha heads Housekeeping AND is a member of it
    await data.svc.transfer(
        data.pm,
        DepartmentTransferRequest(
            property_uid=PID,
            employee_uids=[data.emps["Asha"].id],
            to_department_uid=d.department_uid,
        ),
    )
    with pytest.raises(ConflictErr):
        await data.svc.transfer(
            data.pm,
            DepartmentTransferRequest(
                property_uid=PID,
                employee_uids=[data.emps["Asha"].id],
                to_department_uid=d2.department_uid,
            ),
        )
    # with 'clear' it succeeds and head is removed
    r = await data.svc.transfer(
        data.pm,
        DepartmentTransferRequest(
            property_uid=PID,
            employee_uids=[data.emps["Asha"].id],
            to_department_uid=d2.department_uid,
            head_action="clear",
        ),
    )
    assert r.transferred == 1 and r.head_decisions
    assert data.emps["Asha"].department_id == d2.department_uid


async def test_transfer_head_replace(data):
    d = await data.svc.create_department(
        data.pm, _mk(head_employee_uid=data.emps["Asha"].id)
    )
    await data.svc.transfer(
        data.pm,
        DepartmentTransferRequest(
            property_uid=PID,
            employee_uids=[data.emps["Asha"].id],
            to_department_uid=d.department_uid,
        ),
    )
    await data.svc.transfer(
        data.pm,
        DepartmentTransferRequest(
            property_uid=PID,
            employee_uids=[data.emps["Asha"].id],
            to_department_uid=None,
            head_action="replace",
            replacement_head_uid=data.emps["Bala"].id,
        ),
    )
    dept = data.session.execute(
        select(Department).where(Department.id == d.department_uid)
    ).scalar_one()
    assert dept.head_employee_id == data.emps["Bala"].id


async def test_idempotent_noop_transfer(data):
    d = await data.svc.create_department(data.pm, _mk())
    req = DepartmentTransferRequest(
        property_uid=PID,
        employee_uids=[data.emps["Asha"].id],
        to_department_uid=d.department_uid,
    )
    await data.svc.transfer(data.pm, req)
    r = await data.svc.transfer(data.pm, req)
    assert r.transferred == 0  # duplicate op is a safe no-op


async def test_overview_analytics(data):
    d1 = await data.svc.create_department(data.pm, _mk())
    await data.svc.create_department(data.pm, _mk(name="F&B"))
    await data.svc.transfer(
        data.pm,
        DepartmentTransferRequest(
            property_uid=PID,
            employee_uids=[data.emps["Asha"].id],
            to_department_uid=d1.department_uid,
        ),
    )
    ov = await data.svc.overview(data.pm, PID)
    assert ov.total_employees == 4
    assert ov.active_employees == 3  # Devi is deactivated
    assert ov.inactive_employees == 1
    # 2 created + 8 auto-provisioned system departments
    assert ov.total_departments == 10
    assert ov.unassigned_employees == 3
    assert ov.departments_without_head == 10
    assert ov.avg_employees_per_department == 0.4


async def test_system_departments_provisioned_and_undeletable(data):
    # First list materialises the canonical system set (General + the
    # staff-form picklist departments).
    depts = await data.svc.list_departments(data.pm, PID)
    system = [d for d in depts if d.is_system]
    assert len(system) == 8
    names = {d.name for d in system}
    assert "General" in names and "Housekeeping & Cleanliness" in names
    gen = next(d for d in depts if d.name == "General")
    # second call does not duplicate them
    depts2 = await data.svc.list_departments(data.pm, PID)
    assert sum(1 for d in depts2 if d.is_system) == 8
    with pytest.raises(ConflictErr):
        await data.svc.delete_department(data.pm, gen.department_uid)


async def test_foreign_property_denied(data):
    d = await data.svc.create_department(data.pm, _mk())
    from app.services.structure import NotFoundErr

    with pytest.raises(NotFoundErr):
        await data.svc.detail(data.foreign, d.department_uid)
