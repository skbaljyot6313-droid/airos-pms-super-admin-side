"""Payroll API — Super Admin and HR only.

HR: configure policies and salary structures, generate and submit periods.
SUPER_ADMIN only: approve, mark paid, adjust approved lines.
Employees never reach these routes; their own read-only view lives in the
employee backend (shared tables, scoped to the caller's employee_id).
"""

import uuid
from decimal import Decimal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.dependencies.auth import Forbidden, require_role
from app.models.company import Company
from app.models.employee import Employee
from app.models.payroll import PayrollLine, PayrollPeriod, PayrollPolicy, SalaryStructure
from app.models.property import Property
from app.models.user import User, UserRole
from app.services import payroll as svc
from app.services.structure import NotFoundErr

router = APIRouter(prefix="/payroll", tags=["payroll"])

PayrollStaff = Depends(require_role(UserRole.SUPER_ADMIN, UserRole.HUMAN_RESOURCE))
SuperAdminOnly = Depends(require_role(UserRole.SUPER_ADMIN))


class PolicyIn(BaseModel):
    property_uid: uuid.UUID
    name: str = Field(min_length=1, max_length=120)
    effective_from: str
    config: dict


class AllowanceIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    amount: Decimal = Field(ge=0)


class DeductionIn(BaseModel):
    code: str
    mode: str
    value: Decimal = Field(ge=0)
    basis: str = "basic"
    ceiling: Decimal | None = Field(default=None, ge=0)


class StructureIn(BaseModel):
    calc_method: str
    effective_from: str
    basic: Decimal = Field(ge=0)
    hra: Decimal = Field(default=Decimal("0"), ge=0)
    allowances: list[AllowanceIn] = []
    incentive: Decimal = Field(default=Decimal("0"), ge=0)
    overtime_rate: Decimal = Field(default=Decimal("0"), ge=0)
    # Statutory deductions are opt-in: empty means none apply.
    deductions: list[DeductionIn] = []


class AdjustmentIn(BaseModel):
    amount: Decimal
    reason: str = Field(min_length=10, max_length=2000)


def _scope(user: User, property_uid: uuid.UUID) -> uuid.UUID:
    if user.role != UserRole.SUPER_ADMIN and user.property_id != property_uid:
        raise Forbidden("Payroll is limited to your property.")
    return property_uid


async def _property(session: AsyncSession, user: User, property_uid: uuid.UUID) -> Property:
    prop = await session.scalar(select(Property).where(
        Property.id == _scope(user, property_uid), Property.company_id == user.company_id))
    if prop is None:
        raise NotFoundErr("Property not found.")
    return prop


def _policy_out(p: PayrollPolicy) -> dict:
    return {"policy_uid": str(p.id), "name": p.name, "effective_from": p.effective_from,
            "effective_until": p.effective_until, "config": p.config,
            "created_by_name": p.created_by_name}


def _structure_out(s: SalaryStructure) -> dict:
    return {"structure_uid": str(s.id), "calc_method": s.calc_method,
            "effective_from": s.effective_from, "effective_until": s.effective_until,
            "basic": str(s.basic), "hra": str(s.hra), "allowances": s.allowances,
            "incentive": str(s.incentive), "overtime_rate": str(s.overtime_rate),
            "deductions": s.deductions, "created_by_name": s.created_by_name}


def _line_out(ln: PayrollLine) -> dict:
    return {"line_uid": str(ln.id), "employee_uid": str(ln.employee_id) if ln.employee_id else None,
            "employee_name": ln.employee_name, "status": ln.status, "gross": str(ln.gross),
            "total_deductions": str(ln.total_deductions), "net": str(ln.net),
            "snapshot": ln.snapshot}


def _period_out(pr: PayrollPeriod) -> dict:
    return {"period_uid": str(pr.id), "period": pr.period, "status": pr.status,
            "policy_uid": str(pr.policy_id) if pr.policy_id else None,
            "submitted_by": pr.submitted_by_name, "approved_by": pr.approved_by_name,
            "paid_by": pr.paid_by_name,
            "approved_at": pr.approved_at.isoformat() if pr.approved_at else None,
            "paid_at": pr.paid_at.isoformat() if pr.paid_at else None}


@router.get("/policies")
async def list_policies(property_uid: uuid.UUID, user: User = PayrollStaff,
                        session: AsyncSession = Depends(get_db)):
    prop = await _property(session, user, property_uid)
    rows = (await session.execute(select(PayrollPolicy).where(
        PayrollPolicy.property_id == prop.id).order_by(PayrollPolicy.effective_from.desc()))).scalars().all()
    return {"items": [_policy_out(p) for p in rows]}


@router.post("/policies", status_code=201)
async def create_policy(payload: PolicyIn, user: User = PayrollStaff,
                        session: AsyncSession = Depends(get_db)):
    prop = await _property(session, user, payload.property_uid)
    pol = await svc.create_policy(
        session, company_id=prop.company_id, property_id=prop.id, name=payload.name,
        effective_from=payload.effective_from, config=payload.config,
        actor_id=user.id, actor_name=user.name)
    await session.commit()
    return _policy_out(pol)


@router.get("/employees/{employee_uid}/structures")
async def list_structures(employee_uid: uuid.UUID, user: User = PayrollStaff,
                          session: AsyncSession = Depends(get_db)):
    emp = await session.get(Employee, employee_uid)
    if emp is None or emp.company_id != user.company_id:
        raise NotFoundErr("Employee not found.")
    _scope(user, emp.property_id)
    rows = (await session.execute(select(SalaryStructure).where(
        SalaryStructure.employee_id == emp.id).order_by(SalaryStructure.effective_from.desc()))).scalars().all()
    return {"items": [_structure_out(s) for s in rows]}


@router.post("/employees/{employee_uid}/structures", status_code=201)
async def create_structure(employee_uid: uuid.UUID, payload: StructureIn,
                           user: User = PayrollStaff, session: AsyncSession = Depends(get_db)):
    emp = await session.get(Employee, employee_uid)
    if emp is None or emp.company_id != user.company_id:
        raise NotFoundErr("Employee not found.")
    _scope(user, emp.property_id)
    row = await svc.create_structure(
        session, employee=emp, calc_method=payload.calc_method, basic=payload.basic,
        hra=payload.hra, allowances=[a.model_dump(mode="json") for a in payload.allowances],
        incentive=payload.incentive, overtime_rate=payload.overtime_rate,
        deductions=[d.model_dump(mode="json") for d in payload.deductions],
        effective_from=payload.effective_from, actor_id=user.id, actor_name=user.name)
    await session.commit()
    return _structure_out(row)


@router.get("/periods/{period}")
async def get_period(period: str, property_uid: uuid.UUID, user: User = PayrollStaff,
                     session: AsyncSession = Depends(get_db)):
    from app.models.payroll import PayrollHalfDayGroup

    prop = await _property(session, user, property_uid)
    pr = await session.scalar(select(PayrollPeriod).where(
        PayrollPeriod.property_id == prop.id, PayrollPeriod.period == period))
    if pr is None:
        raise NotFoundErr("Payroll period not found. Generate it first.")
    lines = (await session.execute(select(PayrollLine).where(
        PayrollLine.period_id == pr.id).order_by(PayrollLine.employee_name))).scalars().all()
    grp_rows = (await session.execute(select(PayrollHalfDayGroup, Employee).join(
        Employee, Employee.id == PayrollHalfDayGroup.employee_id).where(
        PayrollHalfDayGroup.period_id == pr.id).order_by(
        PayrollHalfDayGroup.employee_id, PayrollHalfDayGroup.group_index))).all()
    groups_out = [{
        "group_uid": str(g.id), "employee_uid": str(g.employee_id), "employee_name": e.name,
        "group_index": g.group_index, "dates": g.dates, "decision": g.decision,
        "cl_balance_at_decision": g.cl_balance_at_decision,
        "decided_by": g.decided_by_name,
    } for g, e in grp_rows]
    return {**_period_out(pr), "lines": [_line_out(ln) for ln in lines],
            "half_day_groups": groups_out}


@router.post("/periods/{period}/generate")
async def generate(period: str, property_uid: uuid.UUID, user: User = PayrollStaff,
                   session: AsyncSession = Depends(get_db)):
    prop = await _property(session, user, property_uid)
    svc.period_bounds(period)
    pr = await svc.generate_period(session, property_id=prop.id, company_id=prop.company_id,
                                   period=period, actor_name=user.name)
    await session.commit()
    return _period_out(pr)


@router.post("/periods/{period}/submit")
async def submit(period: str, property_uid: uuid.UUID, user: User = PayrollStaff,
                 session: AsyncSession = Depends(get_db)):
    prop = await _property(session, user, property_uid)
    pr = await svc.submit_period(session, property_id=prop.id, period=period, actor_name=user.name)
    await session.commit()
    return _period_out(pr)


@router.post("/periods/{period}/approve")
async def approve(period: str, property_uid: uuid.UUID, user: User = SuperAdminOnly,
                  session: AsyncSession = Depends(get_db)):
    prop = await _property(session, user, property_uid)
    pr = await svc.approve_period(session, property_id=prop.id, period=period,
                                  actor_id=user.id, actor_name=user.name)
    await session.commit()
    return _period_out(pr)


class PaymentIn(BaseModel):
    payment_method: str | None = Field(default=None, max_length=32)
    payment_reference: str | None = Field(default=None, max_length=120)


class GroupDecisionIn(BaseModel):
    decision: str  # 'cl' | 'lop'


@router.post("/periods/{period}/paid")
async def paid(period: str, property_uid: uuid.UUID, payload: PaymentIn | None = None,
               user: User = SuperAdminOnly, session: AsyncSession = Depends(get_db)):
    prop = await _property(session, user, property_uid)
    pr = await svc.mark_paid(
        session, property_id=prop.id, period=period, actor_name=user.name,
        payment_method=payload.payment_method if payload else None,
        payment_reference=payload.payment_reference if payload else None)
    await session.commit()
    return _period_out(pr)


@router.post("/lines/{line_uid}/pay")
async def pay_line(line_uid: uuid.UUID, payload: PaymentIn | None = None,
                   user: User = SuperAdminOnly, session: AsyncSession = Depends(get_db)):
    line = await session.get(PayrollLine, line_uid)
    if line is None:
        raise NotFoundErr("Payroll line not found.")
    pr = await session.get(PayrollPeriod, line.period_id)
    await _property(session, user, pr.property_id)
    ln = await svc.pay_line(session, line_id=line.id, actor_name=user.name,
                            payment_method=payload.payment_method if payload else None,
                            payment_reference=payload.payment_reference if payload else None)
    await session.commit()
    return _line_out(ln)


@router.post("/groups/{group_uid}/decide")
async def decide_group(group_uid: uuid.UUID, payload: GroupDecisionIn,
                       user: User = SuperAdminOnly, session: AsyncSession = Depends(get_db)):
    from app.models.payroll import PayrollHalfDayGroup

    group = await session.get(PayrollHalfDayGroup, group_uid)
    if group is None:
        raise NotFoundErr("Half-day group not found.")
    pr = await session.get(PayrollPeriod, group.period_id)
    await _property(session, user, pr.property_id)
    g = await svc.decide_half_day_group(session, group_id=group.id,
                                        decision=payload.decision,
                                        actor_id=user.id, actor_name=user.name)
    await session.commit()
    return {"group_uid": str(g.id), "decision": g.decision,
            "cl_balance_at_decision": g.cl_balance_at_decision}


@router.get("/periods/{period}/export.csv")
async def export_csv(period: str, property_uid: uuid.UUID, user: User = PayrollStaff,
                     session: AsyncSession = Depends(get_db)):
    from fastapi import Response

    prop = await _property(session, user, property_uid)
    pr = await session.scalar(select(PayrollPeriod).where(
        PayrollPeriod.property_id == prop.id, PayrollPeriod.period == period))
    if pr is None:
        raise NotFoundErr("Payroll period not found.")
    lines = (await session.execute(select(PayrollLine).where(
        PayrollLine.period_id == pr.id).order_by(PayrollLine.employee_name))).scalars().all()
    import csv
    import io

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["employee", "status", "present", "half_days", "absent", "paid_leave",
                "unpaid_leave", "week_offs", "holidays", "late_entries", "worked_hours",
                "break_hours", "overtime_hours", "gross", "total_deductions", "net"])
    for ln in lines:
        m = (ln.snapshot or {}).get("metrics", {})
        w.writerow([ln.employee_name, ln.status, m.get("present_days", 0),
                    m.get("half_days", 0), m.get("absent_days", 0),
                    m.get("paid_leave_days", 0), m.get("unpaid_leave_days", 0),
                    m.get("week_offs", 0), m.get("holidays", 0), m.get("late_entries", 0),
                    m.get("worked_hours", "0"), m.get("break_hours", "0"),
                    m.get("overtime_hours", "0"), ln.gross, ln.total_deductions, ln.net])
    return Response(content=buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition":
                             f'attachment; filename="payroll-{period}.csv"'})


@router.get("/holidays")
async def list_holidays(property_uid: uuid.UUID, user: User = PayrollStaff,
                        session: AsyncSession = Depends(get_db)):
    from app.models.payroll import Holiday

    prop = await _property(session, user, property_uid)
    rows = (await session.execute(select(Holiday).where(
        Holiday.property_id == prop.id).order_by(Holiday.date))).scalars().all()
    return {"items": [{"holiday_uid": str(h.id), "date": h.date, "name": h.name} for h in rows]}


class HolidayIn(BaseModel):
    property_uid: uuid.UUID
    date: str
    name: str = Field(min_length=1, max_length=120)


@router.post("/holidays", status_code=201)
async def create_holiday(payload: HolidayIn, user: User = PayrollStaff,
                         session: AsyncSession = Depends(get_db)):
    from app.models.payroll import Holiday

    prop = await _property(session, user, payload.property_uid)
    h = Holiday(property_id=prop.id, date=payload.date, name=payload.name.strip(),
                created_by_name=user.name)
    session.add(h)
    try:
        await session.commit()
    except Exception:
        await session.rollback()
        raise
    return {"holiday_uid": str(h.id), "date": h.date, "name": h.name}


@router.get("/lines/{line_uid}/slip.pdf")
async def salary_slip(line_uid: uuid.UUID, user: User = PayrollStaff,
                      session: AsyncSession = Depends(get_db)):
    from fastapi import Response
    from sqlalchemy import select as _select

    from app.models.payroll import PayrollAdjustment
    from app.services.payroll_slip import render_slip

    line = await session.get(PayrollLine, line_uid)
    if line is None:
        raise NotFoundErr("Payroll line not found.")
    period = await session.get(PayrollPeriod, line.period_id)
    prop = await _property(session, user, period.property_id)
    company = await session.get(Company, prop.company_id)
    emp = await session.get(Employee, line.employee_id) if line.employee_id else None
    adjustments = (await session.execute(_select(PayrollAdjustment).where(
        PayrollAdjustment.line_id == line.id).order_by(PayrollAdjustment.created_at))).scalars().all()
    pdf = render_slip(
        company_name=company.brand_name or company.company_name,
        employee_name=line.employee_name,
        employee_uid=str(line.employee_id) if line.employee_id else "—",
        department=emp.department if emp else None,
        designation=emp.job_title if emp else None,
        period=period.period, line_snapshot=line.snapshot, line_status=line.status,
        payment_date=period.paid_at.date().isoformat() if period.paid_at else None,
        adjustments=adjustments, net=str(line.net),
    )
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="salary-slip-{period.period}.pdf"'})


@router.post("/lines/{line_uid}/adjustments", status_code=201)
async def adjust(line_uid: uuid.UUID, payload: AdjustmentIn, user: User = SuperAdminOnly,
                 session: AsyncSession = Depends(get_db)):
    line = await session.get(PayrollLine, line_uid)
    if line is None:
        raise NotFoundErr("Payroll line not found.")
    period = await session.get(PayrollPeriod, line.period_id)
    prop = await _property(session, user, period.property_id)
    adj = await svc.add_adjustment(session, line_id=line.id, amount=payload.amount,
                                   reason=payload.reason, actor_id=user.id, actor_name=user.name)
    await session.commit()
    return {"adjustment_uid": str(adj.id), "amount": str(adj.amount), "reason": adj.reason,
            "created_by": adj.created_by_name, "property_uid": str(prop.id)}
