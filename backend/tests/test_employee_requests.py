"""Employee registration approval — service tests on in-memory SQLite.

Covers org scoping, the claim-then-create idempotency contract, employee
+ user materialization via the shared creation service, password-hash
carry-over, rejection, and cross-organization isolation.
"""
import uuid

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.security import hash_password, verify_password
from app.models import Base
from app.models.company import Company
from app.models.employee import Employee
from app.models.property import Property
from app.models.registration_request import EmployeeRegistrationRequest
from app.models.user import User, UserRole
from app.schemas.employee_requests import EmployeeRequestApproveIn
from app.services.employee_requests import (
    EmployeeRequestService,
    RequestAlreadyDecided,
)
from app.services.structure import NotFoundErr


@pytest.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as s:
        yield s
    await engine.dispose()


async def _seed(session: AsyncSession):
    """Two companies, each with a property + a super_admin — enough to
    exercise org isolation."""
    out = {}
    for tag in ("a", "b"):
        company = Company(
            company_name=f"Co {tag.upper()}", brand_name=tag,
            address="1 Main", pin_code="10001",
            email=f"co{tag}@x.test", phone_number="1",
        )
        session.add(company)
        await session.flush()
        prop = Property(
            company_id=company.id, name=f"P{tag}", code=tag,
            location="L", city="C", state="S",
            manager_name="M", manager_email=f"m{tag}@x.test",
        )
        session.add(prop)
        admin = User(
            company_id=company.id, property_id=prop.id,
            name=f"Admin {tag}", email=f"admin{tag}@x.test",
            username=f"admin{tag}", password_hash="x",
            role=UserRole.SUPER_ADMIN,
        )
        session.add(admin)
        await session.flush()
        out[tag] = {"company": company, "prop": prop, "admin": admin}
    await session.commit()
    return out


def _request(company_id: uuid.UUID, **over) -> EmployeeRegistrationRequest:
    base = dict(
        company_id=company_id, status="pending",
        full_name="Jane Applicant", username="jane.a",
        email="jane@x.test", phone="555",
        designation="Housekeeper", department="HK",
        salary="25000", salary_frequency="monthly",
        password_hash=hash_password("Joiner123"),
        organization_code="TESTCODE1234",
    )
    base.update(over)
    return EmployeeRegistrationRequest(**base)


async def test_approve_creates_employee_and_user(session):
    s = await _seed(session)
    admin, prop = s["a"]["admin"], s["a"]["prop"]
    req = _request(s["a"]["company"].id)
    session.add(req)
    await session.commit()

    svc = EmployeeRequestService(session)
    out_req, emp_id, user_id = await svc.approve(
        admin, req.id, EmployeeRequestApproveIn(property_uid=prop.id)
    )

    emp = await session.scalar(select(Employee).where(Employee.id == emp_id))
    assert emp is not None
    assert emp.company_id == s["a"]["company"].id
    assert emp.property_id == prop.id
    assert emp.name == "Jane Applicant"
    assert emp.job_title == "Housekeeper"
    assert emp.department == "HK"

    user = await session.scalar(select(User).where(User.id == user_id))
    assert user is not None
    assert user.role == UserRole.EMPLOYEE
    assert user.employee_id == emp.id
    # The request's Argon2id hash moved onto the account verbatim —
    # the employee signs in with the password they registered with.
    assert verify_password("Joiner123", user.password_hash)

    assert out_req.status == "approved"
    assert out_req.created_employee_id == emp.id
    assert out_req.created_user_id == user.id
    assert out_req.property_id == prop.id
    assert out_req.reviewed_by_id == admin.id

    # Approval notification queued for the push sweep.
    from app.models.notifications import Notification
    notif = await session.scalar(
        select(Notification).where(Notification.employee_id == emp.id)
    )
    assert notif is not None and notif.type == "registration_approved"


async def test_approve_twice_is_rejected(session):
    s = await _seed(session)
    admin, prop = s["a"]["admin"], s["a"]["prop"]
    req = _request(s["a"]["company"].id)
    session.add(req)
    await session.commit()

    svc = EmployeeRequestService(session)
    payload = EmployeeRequestApproveIn(property_uid=prop.id)
    await svc.approve(admin, req.id, payload)
    with pytest.raises(RequestAlreadyDecided):
        await svc.approve(admin, req.id, payload)
    # And exactly one employee + one user exist.
    assert await session.scalar(
        select(func.count(Employee.id)).where(Employee.email == "jane@x.test")
    ) == 1
    assert await session.scalar(
        select(func.count(User.id)).where(User.username == "jane.a")
    ) == 1


async def test_reject_marks_request_and_keeps_record(session):
    s = await _seed(session)
    admin = s["a"]["admin"]
    req = _request(s["a"]["company"].id)
    session.add(req)
    await session.commit()

    svc = EmployeeRequestService(session)
    out = await svc.reject(admin, req.id, "Position filled")
    assert out.status == "rejected"
    assert out.rejection_reason == "Position filled"
    assert out.reviewed_by_id == admin.id
    # No account artifacts.
    assert await session.scalar(
        select(func.count(Employee.id)).where(Employee.email == "jane@x.test")
    ) == 0
    # Decided request can't be re-decided.
    with pytest.raises(RequestAlreadyDecided):
        await svc.reject(admin, req.id, None)


async def test_cross_org_isolation(session):
    """Company B's admin can never see or decide company A's request."""
    s = await _seed(session)
    req = _request(s["a"]["company"].id)
    session.add(req)
    await session.commit()

    svc = EmployeeRequestService(session)
    admin_b = s["b"]["admin"]
    with pytest.raises(NotFoundErr):
        await svc.get_request(admin_b, req.id)
    items, total = await svc.list_requests(admin_b, status_filter="pending")
    assert total == 0 and items == []
    assert await svc.pending_count(admin_b) == 0
    # Claim is company-scoped too → NotFound, not a decision.
    with pytest.raises(NotFoundErr):
        await svc.reject(admin_b, req.id, None)
    assert req.status == "pending"


async def test_pending_count_and_filters(session):
    s = await _seed(session)
    admin = s["a"]["admin"]
    svc = EmployeeRequestService(session)
    r1 = _request(s["a"]["company"].id)
    r2 = _request(s["a"]["company"].id, username="bob.b",
                  email="bob@x.test", full_name="Bob Baker")
    r2.status = "approved"
    session.add_all([r1, r2])
    await session.commit()

    assert await svc.pending_count(admin) == 1
    items, total = await svc.list_requests(admin)
    assert total == 2
    items, total = await svc.list_requests(admin, status_filter="approved")
    assert total == 1 and items[0].username == "bob.b"
    items, total = await svc.list_requests(admin, search="jane")
    assert total == 1 and items[0].username == "jane.a"


async def test_approve_other_org_property_rejected(session):
    """Approving with a property from ANOTHER company must fail — the
    request can never land outside its own organization."""
    s = await _seed(session)
    admin_a = s["a"]["admin"]
    req = _request(s["a"]["company"].id)
    session.add(req)
    await session.commit()

    svc = EmployeeRequestService(session)
    with pytest.raises(NotFoundErr):
        await svc.approve(
            admin_a, req.id,
            EmployeeRequestApproveIn(property_uid=s["b"]["prop"].id),
        )
    # Failed approval rolls back the claim — request stays pending.
    await session.refresh(req)
    assert req.status == "pending"
