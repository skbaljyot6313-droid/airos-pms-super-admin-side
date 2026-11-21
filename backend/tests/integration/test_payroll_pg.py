"""Payroll persistence rules on a real PostgreSQL instance.

Runs only when PAYROLL_TEST_DATABASE_URL points at an isolated, local database
whose name contains 'test'. The fixture resets the public schema there.
"""
import os
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models.company import Company
from app.models.employee import Employee
from app.models.payroll import PayrollLine, PayrollPeriod
from app.models.property import Property
from app.models.user import User, UserRole
from app.services import payroll as svc
from app.services.structure import ConflictErr, ValidationErr

URL = os.environ.get("PAYROLL_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="set PAYROLL_TEST_DATABASE_URL to an isolated local Postgres")

POLICY = {
    "monthly_working_days": 30, "expected_hours_per_day": 8, "late_free_per_month": 2,
    "late_deduction_days_per_excess": 0.5, "half_day_below_hours": 4, "absent_deduction_days": 1,
    "overtime_enabled": True, "overtime_multiplier": 1.5, "paid_leave_is_paid": True,
    "unpaid_leave_is_paid": False, "proration": "working_days",
}


def _guard(url: str) -> None:
    assert "localhost" in url or "127.0.0.1" in url, "refusing: DB must be local"
    assert "test" in url.rsplit("/", 1)[-1], "refusing: database name must contain 'test'"


@pytest.fixture
async def pg():
    from app.models import Base

    _guard(URL)
    engine = create_async_engine(URL)
    async with engine.begin() as conn:
        await conn.execute(text("DROP SCHEMA public CASCADE"))
        await conn.execute(text("CREATE SCHEMA public"))
        await conn.run_sync(Base.metadata.create_all)
        for seq in ("work_batch_seq", "maintenance_ticket_seq", "task_ticket_seq"):
            await conn.execute(text(f"CREATE SEQUENCE IF NOT EXISTS {seq} START 1"))
    yield async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    await engine.dispose()


async def _world(sm, employees=2):
    async with sm() as s:
        company = Company(company_name="Acme", brand_name="Acme", address="1 Main",
                          pin_code="10001", email="ops@acme.test", phone_number="555")
        s.add(company)
        await s.flush()
        prop = Property(company_id=company.id, name="HQ", code="HQ1", location="L", city="C",
                        state="S", manager_name="M", manager_email="m@x.test")
        s.add(prop)
        await s.flush()
        emps = []
        for i in range(employees):
            e = Employee(company_id=company.id, property_id=prop.id, name=f"E{i}",
                         email=f"e{i}@acme.test", status="Active", department="Housekeeping")
            s.add(e)
            await s.flush()
            emps.append(e)
        hr = User(company_id=company.id, property_id=prop.id, name="HR", email="hr@acme.test",
                  username="hr", password_hash="x", role=UserRole.HUMAN_RESOURCE)
        s.add(hr)
        await s.commit()
        return {"company": company.id, "prop": prop.id, "emps": [e.id for e in emps], "hr": hr.id}


async def _setup_pay(sm, w, effective="2026-01-01"):
    async with sm() as s:
        await svc.create_policy(s, company_id=w["company"], property_id=w["prop"], name="Std",
                                effective_from="2026-01-01", config=POLICY,
                                actor_id=None, actor_name="HR")
        for emp_id in w["emps"]:
            emp = await s.get(Employee, emp_id)
            await svc.create_structure(s, employee=emp, calc_method="monthly", basic=Decimal("30000"),
                                       hra=Decimal("6000"), allowances=[], incentive=Decimal("0"),
                                       overtime_rate=Decimal("0"), deductions=[],
                                       effective_from=effective, actor_id=None, actor_name="HR")
        await s.commit()


async def test_generate_twice_never_duplicates_lines(pg):
    w = await _world(pg)
    await _setup_pay(pg, w)
    for _ in range(2):
        async with pg() as s:
            await svc.generate_period(s, property_id=w["prop"], company_id=w["company"],
                                      period="2026-01", actor_name="HR", today="2026-02-15")
            await s.commit()
    async with pg() as s:
        n = await s.scalar(select(func.count()).select_from(PayrollLine))
        assert n == len(w["emps"])


async def test_approval_freezes_period_against_later_recalculation(pg):
    w = await _world(pg, employees=1)
    await _setup_pay(pg, w)
    async with pg() as s:
        await svc.generate_period(s, property_id=w["prop"], company_id=w["company"],
                                  period="2026-01", actor_name="HR", today="2026-02-15")
        await svc.submit_period(s, property_id=w["prop"], period="2026-01", actor_name="HR")
        await svc.approve_period(s, property_id=w["prop"], period="2026-01",
                                 actor_id=None, actor_name="Admin")
        await s.commit()
    async with pg() as s:
        before = (await s.execute(select(PayrollLine.net))).scalar_one()
        await svc.generate_period(s, property_id=w["prop"], company_id=w["company"],
                                  period="2026-01", actor_name="HR", today="2026-02-15")
        await s.commit()
    async with pg() as s:
        assert (await s.execute(select(PayrollLine.net))).scalar_one() == before
        assert (await s.execute(select(PayrollLine.status))).scalar_one() == "approved"


async def test_adjustment_only_on_approved_line_and_requires_reason(pg):
    w = await _world(pg, employees=1)
    await _setup_pay(pg, w)
    async with pg() as s:
        await svc.generate_period(s, property_id=w["prop"], company_id=w["company"],
                                  period="2026-01", actor_name="HR", today="2026-02-15")
        line = (await s.execute(select(PayrollLine))).scalar_one()
        with pytest.raises(ConflictErr):
            await svc.add_adjustment(s, line_id=line.id, amount=Decimal("100"),
                                     reason="Correction for missed bonus", actor_id=None, actor_name="A")
        line_id = line.id
        await s.commit()
    async with pg() as s:
        await svc.submit_period(s, property_id=w["prop"], period="2026-01", actor_name="HR")
        await svc.approve_period(s, property_id=w["prop"], period="2026-01", actor_id=None, actor_name="A")
        await s.commit()
    async with pg() as s:
        with pytest.raises(ValidationErr):
            await svc.add_adjustment(s, line_id=line_id, amount=Decimal("100"),
                                     reason="short", actor_id=None, actor_name="A")
        adj = await svc.add_adjustment(s, line_id=line_id, amount=Decimal("-250"),
                                       reason="Advance recovery per signed note", actor_id=None,
                                       actor_name="Admin")
        await s.commit()
        assert adj.amount == Decimal("-250.00")
        line = await s.get(PayrollLine, line_id)
        assert Decimal(line.snapshot["net"]) == line.net  # snapshot untouched


async def test_approval_blocked_while_lines_need_review(pg):
    w = await _world(pg, employees=1)
    await _setup_pay(pg, w)
    async with pg() as s:
        # Revision starting mid-period is flagged for review, not guessed at.
        emp = await s.get(Employee, w["emps"][0])
        await svc.create_structure(s, employee=emp, calc_method="monthly", basic=Decimal("36000"),
                                   hra=Decimal("0"), allowances=[], incentive=Decimal("0"),
                                   overtime_rate=Decimal("0"), deductions=[],
                                   effective_from="2026-01-15", actor_id=None, actor_name="HR")
        await s.commit()
    async with pg() as s:
        await svc.generate_period(s, property_id=w["prop"], company_id=w["company"],
                                  period="2026-01", actor_name="HR", today="2026-02-15")
        await svc.submit_period(s, property_id=w["prop"], period="2026-01", actor_name="HR")
        with pytest.raises(ConflictErr, match="need review"):
            await svc.approve_period(s, property_id=w["prop"], period="2026-01", actor_id=None, actor_name="A")
        await s.rollback()


async def test_revision_cannot_land_in_a_finalized_period(pg):
    w = await _world(pg, employees=1)
    await _setup_pay(pg, w)
    async with pg() as s:
        await svc.generate_period(s, property_id=w["prop"], company_id=w["company"],
                                  period="2026-01", actor_name="HR", today="2026-02-15")
        await svc.submit_period(s, property_id=w["prop"], period="2026-01", actor_name="HR")
        await svc.approve_period(s, property_id=w["prop"], period="2026-01", actor_id=None, actor_name="A")
        await s.commit()
    async with pg() as s:
        emp = await s.get(Employee, w["emps"][0])
        with pytest.raises(ConflictErr, match="finalized"):
            await svc.create_structure(s, employee=emp, calc_method="monthly", basic=Decimal("1"),
                                       hra=Decimal("0"), allowances=[], incentive=Decimal("0"),
                                       overtime_rate=Decimal("0"), deductions=[],
                                       effective_from="2026-01-20", actor_id=None, actor_name="HR")


async def test_only_approved_period_can_be_paid(pg):
    w = await _world(pg, employees=1)
    await _setup_pay(pg, w)
    async with pg() as s:
        await svc.generate_period(s, property_id=w["prop"], company_id=w["company"],
                                  period="2026-01", actor_name="HR", today="2026-02-15")
        await s.commit()
    async with pg() as s:
        with pytest.raises(ConflictErr):
            await svc.mark_paid(s, property_id=w["prop"], period="2026-01", actor_name="A")
        await s.rollback()
    async with pg() as s:
        status = (await s.execute(select(PayrollPeriod.status))).scalar_one()
        assert status == "open"


# --- half-day grouping, CL/LOP decisions, payment tracking ------------------

from app.models.attendance import AttendanceDay
from app.models.payroll import LeaveLedger, PayrollHalfDayGroup


async def _half_days(sm, w, emp_id, dates, work_hours=3):
    async with sm() as s:
        emp = await s.get(Employee, emp_id)
        for d in dates:
            s.add(AttendanceDay(
                property_id=w["prop"], employee_id=emp_id, employee_name=emp.name,
                attendance_date=d, status="present",
                started_at=datetime(2026, 1, int(d[8:]), 9, 0, tzinfo=UTC),
                ended_at=datetime(2026, 1, int(d[8:]), 12, 0, tzinfo=UTC),
                break_seconds=0, work_seconds=work_hours * 3600))
        await s.commit()


async def _gen(sm, w, period="2026-01"):
    async with sm() as s:
        await svc.generate_period(s, property_id=w["prop"], company_id=w["company"],
                                  period=period, actor_name="HR", today="2026-02-15")
        await s.commit()


async def _groups(sm, period_id, emp_id):
    async with sm() as s:
        return (await s.execute(select(PayrollHalfDayGroup).where(
            PayrollHalfDayGroup.period_id == period_id,
            PayrollHalfDayGroup.employee_id == emp_id).order_by(
            PayrollHalfDayGroup.group_index))).scalars().all()


async def _period_and_line(sm, w, period="2026-01"):
    async with sm() as s:
        pr = await s.scalar(select(PayrollPeriod).where(
            PayrollPeriod.property_id == w["prop"], PayrollPeriod.period == period))
        ln = await s.scalar(select(PayrollLine).where(
            PayrollLine.period_id == pr.id, PayrollLine.employee_id == w["emps"][0]))
        return pr, ln


async def test_three_half_days_create_one_pending_group_and_block_submit(pg):
    w = await _world(pg, employees=1)
    await _setup_pay(pg, w)
    await _half_days(pg, w, w["emps"][0], ["2026-01-05", "2026-01-06", "2026-01-07"])
    await _gen(pg, w)
    pr, ln = await _period_and_line(pg, w)
    groups = await _groups(pg, pr.id, w["emps"][0])
    assert len(groups) == 1 and groups[0].decision is None
    assert groups[0].dates == ["2026-01-05", "2026-01-06", "2026-01-07"]
    async with pg() as s:
        with pytest.raises(ConflictErr, match="CL or LOP"):
            await svc.submit_period(s, property_id=w["prop"], period="2026-01", actor_name="HR")
        await s.rollback()


async def test_seven_half_days_make_two_groups_plus_one_ungrouped(pg):
    w = await _world(pg, employees=1)
    await _setup_pay(pg, w)
    dates = [f"2026-01-{d:02d}" for d in (5, 6, 7, 8, 12, 13, 14)]
    await _half_days(pg, w, w["emps"][0], dates)
    await _gen(pg, w)
    pr, ln = await _period_and_line(pg, w)
    groups = await _groups(pg, pr.id, w["emps"][0])
    assert len(groups) == 2
    m = ln.snapshot["metrics"]
    assert m["half_days"] == 7 and m["pending_half_day_groups"] == 2
    # The ungrouped 7th half-day is deducted at 0.5 day (carry-forward off).
    half_ded = next(d for d in ln.snapshot["deductions"] if d["code"] == "half_day")
    daily = Decimal(ln.snapshot["daily_rate"])
    assert Decimal(half_ded["amount"]) == (daily * Decimal("0.5")).quantize(Decimal("0.01"))


async def test_decide_lop_adds_full_day_deduction_and_unblocks_submit(pg):
    w = await _world(pg, employees=1)
    await _setup_pay(pg, w)
    await _half_days(pg, w, w["emps"][0], ["2026-01-05", "2026-01-06", "2026-01-07"])
    await _gen(pg, w)
    pr, ln = await _period_and_line(pg, w)
    groups = await _groups(pg, pr.id, w["emps"][0])
    async with pg() as s:
        await svc.decide_half_day_group(s, group_id=groups[0].id, decision="lop",
                                        actor_id=None, actor_name="Admin")
        await s.commit()
    pr, ln = await _period_and_line(pg, w)
    ded = next(d for d in ln.snapshot["deductions"] if d["code"] == "lop_halfday")
    assert Decimal(ded["amount"]) == Decimal(ln.snapshot["daily_rate"])
    assert ln.snapshot["metrics"]["pending_half_day_groups"] == 0
    async with pg() as s:
        await svc.submit_period(s, property_id=w["prop"], period="2026-01", actor_name="HR")
        await s.commit()


async def test_decide_cl_consumes_leave_via_ledger_no_pay_deduction(pg):
    w = await _world(pg, employees=1)
    await _setup_pay(pg, w)
    async with pg() as s:
        emp = await s.get(Employee, w["emps"][0])
        emp.leave_balance_days = 3
        await s.commit()
    await _half_days(pg, w, w["emps"][0], ["2026-01-05", "2026-01-06", "2026-01-07"])
    await _gen(pg, w)
    pr, ln = await _period_and_line(pg, w)
    groups = await _groups(pg, pr.id, w["emps"][0])
    net_before = ln.net
    async with pg() as s:
        await svc.decide_half_day_group(s, group_id=groups[0].id, decision="cl",
                                        actor_id=None, actor_name="Admin")
        await s.commit()
        ledger = (await s.execute(select(LeaveLedger).where(
            LeaveLedger.employee_id == w["emps"][0]))).scalars().all()
        assert len(ledger) == 1 and ledger[0].delta == Decimal("-1.00")
        assert ledger[0].leave_type == "CL"
        assert str(ledger[0].reference_id) == str(groups[0].id)
    pr, ln = await _period_and_line(pg, w)
    assert ln.net == net_before  # CL conversion has no pay deduction
    assert ln.snapshot["metrics"]["cl_consumed"] == 1


async def test_insufficient_cl_flags_shortfall_and_never_goes_negative(pg):
    w = await _world(pg, employees=1)
    await _setup_pay(pg, w)
    async with pg() as s:
        emp = await s.get(Employee, w["emps"][0])
        emp.leave_balance_days = 0
        await s.commit()
    await _half_days(pg, w, w["emps"][0], ["2026-01-05", "2026-01-06", "2026-01-07"])
    await _gen(pg, w)
    pr, ln = await _period_and_line(pg, w)
    groups = await _groups(pg, pr.id, w["emps"][0])
    async with pg() as s:
        g = await svc.decide_half_day_group(s, group_id=groups[0].id, decision="cl",
                                            actor_id=None, actor_name="Admin")
        await s.commit()
        assert g.decision == "cl_short"
        assert await s.scalar(select(func.count()).select_from(LeaveLedger)) == 0
        line = await s.scalar(select(PayrollLine).where(PayrollLine.period_id == pr.id))
        assert line.status == "needs_review"


async def test_pay_line_records_payment_details(pg):
    w = await _world(pg, employees=1)
    await _setup_pay(pg, w)
    await _gen(pg, w)
    pr, ln = await _period_and_line(pg, w)
    async with pg() as s:
        await svc.submit_period(s, property_id=w["prop"], period="2026-01", actor_name="HR")
        await svc.approve_period(s, property_id=w["prop"], period="2026-01", actor_id=None, actor_name="A")
        await s.commit()
    async with pg() as s:
        ln2 = await svc.pay_line(s, line_id=ln.id, actor_name="Admin",
                                 payment_method="bank_transfer", payment_reference="TXN-1")
        await s.commit()
        assert ln2.status == "paid" and ln2.payment_method == "bank_transfer"
        assert ln2.paid_at is not None


async def test_mark_paid_cascades_payment_details_to_all_lines(pg):
    w = await _world(pg, employees=2)
    await _setup_pay(pg, w)
    await _gen(pg, w)
    async with pg() as s:
        await svc.submit_period(s, property_id=w["prop"], period="2026-01", actor_name="HR")
        await svc.approve_period(s, property_id=w["prop"], period="2026-01", actor_id=None, actor_name="A")
        await svc.mark_paid(s, property_id=w["prop"], period="2026-01", actor_name="Admin",
                            payment_method="upi", payment_reference="BATCH-9")
        await s.commit()
    async with pg() as s:
        refs = (await s.execute(select(PayrollLine.payment_reference,
                                       PayrollLine.payment_method))).all()
        assert all(r.payment_reference == "BATCH-9" and r.payment_method == "upi" for r in refs)
