"""Payroll engine — pure calculation core + DB orchestration.

Pure functions (no I/O) hold every money rule so they can be tested exactly:
classify_day, compute_line, validate_policy, validate_structure.

DB orchestration (generate/submit/approve/mark_paid/adjust) reads the
authoritative attendance rows, shift assignments and approved leave, writes
payroll lines once per (period, employee), and freezes on approval.

No default money rules: every amount-affecting policy key must be present.
Statutory deductions apply only when explicitly configured on the structure.
"""

import calendar
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, time, timedelta
from datetime import date as date_type
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from app.models.attendance import AttendanceDay, AttendanceRequest
from app.models.employee import Employee
from app.models.payroll import (
    CALC_METHODS,
    FINAL_PERIOD_STATUSES,
    Holiday,
    LeaveLedger,
    PayrollAdjustment,
    PayrollHalfDayGroup,
    PayrollLine,
    PayrollPeriod,
    PayrollPolicy,
    SalaryStructure,
)
from app.services.structure import ConflictErr, NotFoundErr, ValidationErr

CENT = Decimal("0.01")

REQUIRED_POLICY_KEYS = (
    "monthly_working_days",
    "expected_hours_per_day",
    "late_free_per_month",
    "late_deduction_days_per_excess",
    "half_day_below_hours",
    "absent_deduction_days",
    "overtime_enabled",
    "overtime_multiplier",
    "paid_leave_is_paid",
    "unpaid_leave_is_paid",
    "proration",
)
# Optional keys with spec-mandated defaults.
POLICY_DEFAULTS = {
    "late_half_day_after_minutes": 30,
    "half_day_carry_forward": False,
    "holiday_is_paid": True,
    "paid_leave_types": ["CL", "SL", "EL"],
    "week_off_is_paid": True,
    # {"mode": "fixed", "value": 30} | {"mode": "calendar"} | {"mode": "scheduled"}
    "per_day_divisor": {"mode": "fixed", "value": 30},
}
LEAVE_ALIASES = {
    "cl": "CL", "casual_leave": "CL", "casual": "CL",
    "sl": "SL", "sick_leave": "SL", "sick": "SL",
    "el": "EL", "earned_leave": "EL", "earned": "EL", "pl": "EL", "privilege_leave": "EL",
    "lwp": "LWP", "unpaid_leave": "LWP", "unpaid": "LWP", "lwop": "LWP",
}


def normalize_leave_type(raw: str | None) -> str:
    if not raw:
        return "other"
    return LEAVE_ALIASES.get(raw.strip().lower(), "other")


def policy_get(config: dict, key: str):
    return config.get(key, POLICY_DEFAULTS[key])


def per_day_divisor(config: dict, scheduled_days: int, calendar_days: int) -> tuple[Decimal, str]:
    """Resolve the configured per-day-salary divisor: fixed | calendar | scheduled."""
    spec = policy_get(config, "per_day_divisor")
    mode = spec.get("mode", "fixed") if isinstance(spec, dict) else "fixed"
    if mode == "calendar":
        return Decimal(calendar_days), f"{calendar_days} calendar days"
    if mode == "scheduled":
        if scheduled_days <= 0:
            raise ValidationErr("per_day_divisor 'scheduled' needs at least one scheduled day.")
        return Decimal(scheduled_days), f"{scheduled_days} scheduled working days"
    value = Decimal(str(spec.get("value", config.get("monthly_working_days", 30))))
    if value <= 0:
        raise ValidationErr("per_day_divisor value must be positive.", field="per_day_divisor")
    return value, f"fixed {value}-day divisor"
STATUTORY_CODES = ("PF", "ESI", "TDS", "other")


def money(value) -> Decimal:
    return Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_UP)


def validate_policy(config: dict) -> dict:
    missing = [k for k in REQUIRED_POLICY_KEYS if k not in config]
    if missing:
        raise ValidationErr(f"Policy is missing required keys: {', '.join(missing)}.", field="config")
    if config["proration"] != "working_days":
        raise ValidationErr("Only proration='working_days' is supported.", field="proration")
    if not (1 <= int(config["monthly_working_days"]) <= 31):
        raise ValidationErr("monthly_working_days must be between 1 and 31.", field="monthly_working_days")
    if float(config["expected_hours_per_day"]) <= 0:
        raise ValidationErr("expected_hours_per_day must be positive.", field="expected_hours_per_day")
    if float(config["overtime_multiplier"]) < 0:
        raise ValidationErr("overtime_multiplier cannot be negative.", field="overtime_multiplier")
    if int(policy_get(config, "late_half_day_after_minutes")) < 0:
        raise ValidationErr("late_half_day_after_minutes cannot be negative.", field="late_half_day_after_minutes")
    return config


def validate_structure(*, calc_method: str, basic: Decimal, hra: Decimal, deductions: list) -> None:
    if calc_method not in CALC_METHODS:
        raise ValidationErr("calc_method must be monthly, daily or hourly.", field="calc_method")
    if basic < 0 or hra < 0:
        raise ValidationErr("Amounts cannot be negative.", field="basic")
    for d in deductions:
        if d.get("code") not in STATUTORY_CODES:
            raise ValidationErr("Unknown deduction code.", field="deductions")
        if d.get("mode") not in ("percent", "fixed"):
            raise ValidationErr("Deduction mode must be percent or fixed.", field="deductions")
        if d.get("basis", "basic") not in ("basic", "gross"):
            raise ValidationErr("Deduction basis must be basic or gross.", field="deductions")
        if Decimal(str(d.get("value", 0))) < 0:
            raise ValidationErr("Deduction value cannot be negative.", field="deductions")


# ---------------------------------------------------------------------------
# Day classification — one operational day, from authoritative records only
# ---------------------------------------------------------------------------

@dataclass
class DayFacts:
    scheduled: bool            # a shift applies on this date
    status: str | None         # AttendanceDay.status or None (no record)
    started: bool = False
    ended: bool = False
    worked_seconds: int = 0    # net of breaks (work_seconds)
    break_seconds: int = 0
    arrival_late: bool = False
    late_minutes: int = 0      # minutes past shift start (not grace)
    holiday: bool = False
    approved_leave_type: str | None = None  # normalized: CL|SL|EL|LWP|other
    past: bool = True          # date is before today


@dataclass
class DayResult:
    kind: str                  # present|half|absent|paid_leave|unpaid_leave|week_off|holiday|off|anomaly
    late: bool = False
    late_half_day: bool = False  # half day caused by the late-entry rule
    worked_seconds: int = 0
    break_seconds: int = 0
    late_minutes: int = 0
    review: str | None = None  # anomaly reason, no deduction is made


def classify_day(f: DayFacts, policy: dict) -> DayResult:
    if f.approved_leave_type is not None:
        lt = normalize_leave_type(f.approved_leave_type)
        if lt == "LWP":
            paid = bool(policy["unpaid_leave_is_paid"])
        else:
            paid = lt in policy_get(policy, "paid_leave_types") and bool(policy["paid_leave_is_paid"])
        return DayResult("paid_leave" if paid else "unpaid_leave")
    if f.holiday:
        return DayResult("holiday" if policy_get(policy, "holiday_is_paid") else "unpaid_leave")
    if f.status == "week_off":
        return DayResult("week_off")
    if f.status == "leave":
        return DayResult("unpaid_leave" if not bool(policy["paid_leave_is_paid"]) else "paid_leave")
    if f.status == "absent":
        return DayResult("absent")
    if f.status == "present" and f.started:
        threshold = int(policy_get(policy, "late_half_day_after_minutes"))
        late_hd = f.arrival_late and f.late_minutes > threshold
        if not f.ended:
            return DayResult("anomaly", late=f.arrival_late, late_half_day=late_hd,
                             late_minutes=f.late_minutes, review="no end of day recorded")
        hours_threshold = float(policy["half_day_below_hours"]) * 3600
        short = 0 < f.worked_seconds < hours_threshold
        kind = "half" if (short or late_hd) else "present"
        return DayResult(kind, late=f.arrival_late, late_half_day=late_hd,
                         worked_seconds=f.worked_seconds, break_seconds=f.break_seconds,
                         late_minutes=f.late_minutes)
    if not f.scheduled:
        return DayResult("off")
    if f.past:
        return DayResult("absent")
    return DayResult("off")


# ---------------------------------------------------------------------------
# Line calculation — earnings, deductions, totals, full trace
# ---------------------------------------------------------------------------

@dataclass
class Metrics:
    working_days_in_period: int = 0   # scheduled working days
    calendar_days: int = 0
    present: int = 0
    half: int = 0                     # all half days (short-hours + late rule)
    absent: int = 0
    paid_leave: int = 0
    unpaid_leave: int = 0
    week_offs: int = 0
    holidays: int = 0
    late_entries: int = 0
    late_minutes_total: int = 0
    worked_seconds: int = 0
    break_seconds: int = 0
    overtime_seconds: int = 0
    lop_group_days: int = 0           # decided 'lop' half-day groups × 1 day
    cl_consumed: int = 0              # decided 'cl' half-day groups × 1 CL
    ungrouped_half_days: int = 0      # remainder < 3 (deducted 0.5/day or carried)
    carried_half_days: int = 0        # ungrouped remainder carried out (policy-gated)
    carried_in_half_days: int = 0     # arrived from the previous period
    pending_groups: int = 0           # complete groups awaiting an admin decision
    day_log: list = field(default_factory=list)
    half_day_dates: list = field(default_factory=list)
    absent_dates: list = field(default_factory=list)
    unpaid_leave_dates: list = field(default_factory=list)
    late_dates: list = field(default_factory=list)
    leave_by_type: dict = field(default_factory=dict)
    anomalies: list = field(default_factory=list)


def compute_line(structure: dict, policy: dict, m: Metrics) -> dict:
    """structure: dict with calc_method, basic, hra, allowances[], incentive,
    overtime_rate, deductions[]. Returns components, totals and the trace.

    Half-day accounting: every complete group of 3 half-days is a
    payroll_half_day_groups row. Decided 'lop' groups add one full LOP day
    each; decided 'cl' groups consume CL (no pay deduction). The ungrouped
    remainder is deducted at 0.5 day each, unless carry-forward applies.
    Late entries that became half-days are never charged twice."""
    method = structure["calc_method"]
    basic = money(structure["basic"])
    hra = money(structure["hra"])
    allowances = [(a["name"], money(a["amount"])) for a in structure.get("allowances", [])]
    incentive = money(structure["incentive"])
    ot_rate = money(structure["overtime_rate"])
    divisor, divisor_label = per_day_divisor(policy, m.working_days_in_period,
                                           m.calendar_days or int(policy["monthly_working_days"]))
    hours_per_day = Decimal(str(policy["expected_hours_per_day"]))
    paid_days = Decimal(m.present + m.paid_leave) + Decimal(m.half) * Decimal("0.5")

    earnings: list[dict] = []
    trace_notes: list[str] = []

    if method == "monthly":
        monthly_fixed = basic + hra + sum((a for _, a in allowances), Decimal(0))
        daily_base = monthly_fixed / divisor
        earnings.append({"code": "basic", "label": "Basic salary", "amount": basic,
                         "basis": f"monthly; per-day = {money(daily_base)} ({divisor_label})"})
        earnings.append({"code": "hra", "label": "House rent allowance", "amount": hra, "basis": "monthly"})
        for name, amt in allowances:
            earnings.append({"code": "allowance", "label": name, "amount": amt, "basis": "monthly"})

        ungrouped = m.ungrouped_half_days
        half_remainder_deduction = Decimal("0") if policy_get(policy, "half_day_carry_forward") \
            else daily_base * Decimal(ungrouped) * Decimal("0.5")
        if policy_get(policy, "half_day_carry_forward") and ungrouped:
            trace_notes.append(f"{ungrouped} ungrouped half day(s) carried into the next period")
        # Late entries that already classified a day as half-day are excluded
        # from the per-entry deduction — one incident, one charge.
        deductible_late = max(0, m.late_entries - sum(1 for d in m.late_dates if d.get("late_half_day")))
        excess_late = max(0, deductible_late - int(policy["late_free_per_month"]))
        late_days = Decimal(str(policy["late_deduction_days_per_excess"])) * excess_late
        late_deduction = money(daily_base * late_days)
        if excess_late:
            trace_notes.append(f"{excess_late} late entries beyond the allowance deducted at {policy['late_deduction_days_per_excess']} day each")
        if m.lop_group_days:
            trace_notes.append(f"{m.lop_group_days} half-day group(s) decided as one-day LOP each")
        if m.cl_consumed:
            trace_notes.append(f"{m.cl_consumed} half-day group(s) converted to CL (no pay deduction)")
        deductions_pre = [
            {"code": "lop_absence", "label": "Loss of pay — absence",
             "amount": money(daily_base * Decimal(m.absent)) if m.absent else Decimal("0.00"),
             "basis": f"{m.absent} day(s) × {money(daily_base)}/day ({divisor_label})",
             "dates": m.absent_dates},
            {"code": "lop_leave", "label": "Loss of pay — unpaid leave",
             "amount": money(daily_base * Decimal(m.unpaid_leave)) if m.unpaid_leave else Decimal("0.00"),
             "basis": f"{m.unpaid_leave} unpaid leave day(s) × {money(daily_base)}/day",
             "dates": m.unpaid_leave_dates},
            {"code": "lop_halfday", "label": "Loss of pay — half-day groups",
             "amount": money(daily_base * Decimal(m.lop_group_days)) if m.lop_group_days else Decimal("0.00"),
             "basis": f"{m.lop_group_days} group(s) of 3 half-days = 1 day LOP each"},
            {"code": "half_day", "label": "Half-day deduction (ungrouped)",
             "amount": money(half_remainder_deduction) if ungrouped else Decimal("0.00"),
             "basis": f"{ungrouped} ungrouped half day(s) × 0.5 day",
             "dates": m.half_day_dates[-ungrouped:] if ungrouped else []},
            {"code": "late_entry", "label": "Late-entry deduction", "amount": late_deduction,
             "basis": f"{excess_late} excess late entries (≥30-min half-days excluded)"},
        ]
    else:
        rate = basic
        unit = "day" if method == "daily" else "hour"
        worked_hours = Decimal(m.worked_seconds) / Decimal(3600)
        if method == "daily":
            base_amount = money(rate * paid_days)
            earnings.append({"code": "basic", "label": "Basic wage", "amount": base_amount,
                             "basis": f"{paid_days} paid days × daily rate {rate}"})
        else:
            base_amount = money(rate * worked_hours)
            earnings.append({"code": "basic", "label": "Basic wage", "amount": base_amount,
                             "basis": f"{worked_hours:.2f} net hours × hourly rate {rate}"})
        if hra:
            earnings.append({"code": "hra", "label": "House rent allowance", "amount": hra, "basis": "fixed"})
        for name, amt in allowances:
            earnings.append({"code": "allowance", "label": name, "amount": amt, "basis": "fixed"})
        deductions_pre = []
        trace_notes.append(f"Wage is paid per {unit}; late and absence are not deducted separately")

    earnings.append({"code": "incentive", "label": "Performance incentive", "amount": incentive, "basis": "fixed"})
    ot_hours = Decimal(m.overtime_seconds) / Decimal(3600)
    if policy["overtime_enabled"] and ot_hours > 0:
        ot_amount = money(ot_rate * Decimal(str(policy["overtime_multiplier"])) * ot_hours)
        earnings.append({"code": "overtime", "label": "Overtime", "amount": ot_amount,
                         "basis": f"{ot_hours:.2f} h × {ot_rate} × {policy['overtime_multiplier']}"})
    else:
        ot_amount = Decimal("0.00")
        if ot_hours > 0:
            trace_notes.append("Overtime recorded but not payable under this policy")

    gross = money(sum((e["amount"] for e in earnings), Decimal(0)))

    deductions = [d for d in deductions_pre if d["amount"] > 0]
    for sd in structure.get("deductions", []):
        base_value = basic if sd.get("basis", "basic") == "basic" else gross
        if sd["mode"] == "percent":
            amount = money(base_value * Decimal(str(sd["value"])) / Decimal(100))
            basis = f"{sd['value']}% of {sd.get('basis', 'basic')}"
        else:
            amount = money(sd["value"])
            basis = "fixed amount"
        if sd.get("ceiling") is not None:
            amount = min(amount, money(sd["ceiling"]))
            basis += f", capped at {sd['ceiling']}"
        deductions.append({"code": sd["code"], "label": f"{sd['code']} (statutory/configured)",
                           "amount": amount, "basis": basis})

    total_deductions = money(sum((d["amount"] for d in deductions), Decimal(0)))
    net = money(gross - total_deductions)
    if net < 0:
        net = Decimal("0.00")
        trace_notes.append("Deductions exceed earnings — net floored at zero, flagged for review")
    return {
        "earnings": [{**e, "amount": str(e["amount"])} for e in earnings],
        "deductions": [{**d, "amount": str(d["amount"])} for d in deductions],
        "gross": str(gross),
        "total_deductions": str(total_deductions),
        "net": str(net),
        "notes": trace_notes,
        "metrics": {
            "calendar_days": m.calendar_days,
            "working_days_in_period": m.working_days_in_period,
            "present_days": m.present,
            "half_days": m.half,
            "absent_days": m.absent,
            "paid_leave_days": m.paid_leave,
            "unpaid_leave_days": m.unpaid_leave,
            "week_offs": m.week_offs,
            "holidays": m.holidays,
            "late_entries": m.late_entries,
            "late_minutes_total": m.late_minutes_total,
            "worked_hours": str(round(m.worked_seconds / 3600, 2)),
            "break_hours": str(round(m.break_seconds / 3600, 2)),
            "overtime_hours": str(round(m.overtime_seconds / 3600, 2)),
            "lop_group_days": m.lop_group_days,
            "cl_consumed": m.cl_consumed,
            "pending_half_day_groups": m.pending_groups,
            "carried_half_days": m.carried_half_days,
            "carried_in_half_days": m.carried_in_half_days,
            "leave_by_type": m.leave_by_type,
        },
        "anomalies": m.anomalies,
        "method": method,
    }


def period_bounds(period: str) -> tuple[str, str]:
    year, month = (int(x) for x in period.split("-"))
    last = calendar.monthrange(year, month)[1]
    return f"{year:04d}-{month:02d}-01", f"{year:04d}-{month:02d}-{last:02d}"


def _dates(start: str, end: str) -> list[str]:
    s, e = date_type.fromisoformat(start), date_type.fromisoformat(end)
    return [(s + timedelta(days=i)).isoformat() for i in range((e - s).days + 1)]


# ---------------------------------------------------------------------------
# DB orchestration
# ---------------------------------------------------------------------------

async def _policy_for(session: AsyncSession, property_id: uuid.UUID, period_end: str) -> PayrollPolicy:
    policy = await session.scalar(
        select(PayrollPolicy).where(
            PayrollPolicy.property_id == property_id,
            PayrollPolicy.effective_from <= period_end,
            (PayrollPolicy.effective_until.is_(None)) | (PayrollPolicy.effective_until >= period_end),
        ).order_by(PayrollPolicy.effective_from.desc())
    )
    if policy is None:
        raise ConflictErr("No payroll policy is in force for this period. Configure one first.", code="NO_POLICY")
    return policy


async def _structures_for(session: AsyncSession, employee_ids: list[uuid.UUID], period_end: str):
    rows = (await session.execute(
        select(SalaryStructure).where(
            SalaryStructure.employee_id.in_(employee_ids),
            SalaryStructure.effective_from <= period_end,
        ).order_by(SalaryStructure.employee_id, SalaryStructure.effective_from.desc())
    )).scalars().all()
    by_emp: dict[uuid.UUID, list[SalaryStructure]] = {}
    for r in rows:
        by_emp.setdefault(r.employee_id, []).append(r)
    return by_emp


def _in_force(revisions: list[SalaryStructure], day: str) -> SalaryStructure | None:
    for r in revisions:
        if r.effective_from <= day and (r.effective_until is None or r.effective_until >= day):
            return r
    return None


async def generate_period(session: AsyncSession, *, property_id: uuid.UUID, company_id: uuid.UUID,
                          period: str, actor_name: str, today: str | None = None) -> PayrollPeriod:
    """Create the period if needed and (re)calculate lines that are not frozen.

    Approved/paid periods are returned untouched. Duplicate lines for the same
    employee are prevented by the unique constraint and by re-using the row."""
    start, end = period_bounds(period)
    pr = await session.scalar(select(PayrollPeriod).where(
        PayrollPeriod.property_id == property_id, PayrollPeriod.period == period))
    if pr is None:
        pr = PayrollPeriod(company_id=company_id, property_id=property_id, period=period, status="open")
        session.add(pr)
        await session.flush()
    if pr.status in FINAL_PERIOD_STATUSES:
        return pr
    policy = await _policy_for(session, property_id, end)
    pr.policy_id = policy.id
    cfg = validate_policy(policy.config)
    today = today or datetime.now(UTC).date().isoformat()

    employees = (await session.execute(select(Employee).where(
        Employee.property_id == property_id, Employee.company_id == company_id,
        func.lower(Employee.status) != "deactivated"))).scalars().all()
    emp_ids = [e.id for e in employees]
    revisions = await _structures_for(session, emp_ids, end)
    dates = _dates(start, end)
    days = (await session.execute(select(AttendanceDay).where(
        AttendanceDay.property_id == property_id,
        AttendanceDay.employee_id.in_(emp_ids),
        AttendanceDay.attendance_date >= start, AttendanceDay.attendance_date <= end,
    ))).scalars().all() if emp_ids else []
    by_emp_day = {(d.employee_id, d.attendance_date): d for d in days}
    leaves = (await session.execute(select(AttendanceRequest).where(
        AttendanceRequest.property_id == property_id,
        AttendanceRequest.employee_id.in_(emp_ids),
        AttendanceRequest.status == "approved",
        AttendanceRequest.from_date <= end, AttendanceRequest.to_date >= start,
    ))).scalars().all() if emp_ids else []
    leave_by_day: dict[tuple, str] = {}
    leave_pending: dict[uuid.UUID, int] = {}
    for lv in leaves:
        for d in _dates(max(lv.from_date, start), min(lv.to_date, end)):
            leave_by_day[(lv.employee_id, d)] = normalize_leave_type(lv.leave_type)
    pending_leaves = (await session.execute(select(AttendanceRequest).where(
        AttendanceRequest.property_id == property_id,
        AttendanceRequest.employee_id.in_(emp_ids),
        AttendanceRequest.status == "pending",
        AttendanceRequest.from_date <= end, AttendanceRequest.to_date >= start,
    ))).scalars().all() if emp_ids else []
    for lv in pending_leaves:
        leave_pending[lv.employee_id] = leave_pending.get(lv.employee_id, 0) + 1
    holiday_rows = (await session.execute(select(Holiday).where(
        Holiday.property_id == property_id,
        Holiday.date >= start, Holiday.date <= end))).scalars().all()
    holidays = {h.date for h in holiday_rows}

    from app.services.shifts import effective_assignments, shift_applies_on, shift_window_utc
    shift_by_day = {d: await effective_assignments(session, emp_ids, d) for d in dates} if emp_ids else {}

    existing = {ln.employee_id: ln for ln in (await session.execute(select(PayrollLine).where(
        PayrollLine.period_id == pr.id))).scalars().all()}
    groups = (await session.execute(select(PayrollHalfDayGroup).where(
        PayrollHalfDayGroup.period_id == pr.id))).scalars().all()
    groups_by_emp: dict[uuid.UUID, list[PayrollHalfDayGroup]] = {}
    for g in groups:
        groups_by_emp.setdefault(g.employee_id, []).append(g)

    # Carried-in half-day dates from the previous calendar month's line snapshot.
    prev_year, prev_month = int(start[:4]), int(start[5:7])
    prev_month -= 1
    if prev_month == 0:
        prev_year, prev_month = prev_year - 1, 12
    prev_key = f"{prev_year:04d}-{prev_month:02d}"
    prev_period = await session.scalar(select(PayrollPeriod).where(
        PayrollPeriod.property_id == property_id, PayrollPeriod.period == prev_key))
    carried_in: dict[uuid.UUID, list] = {}
    if prev_period and policy_get(cfg, "half_day_carry_forward"):
        prev_lines = (await session.execute(select(PayrollLine).where(
            PayrollLine.period_id == prev_period.id))).scalars().all()
        for pl in prev_lines:
            dates_in = (pl.snapshot or {}).get("carried_half_day_dates") or []
            if dates_in:
                carried_in[pl.employee_id] = list(dates_in)

    for emp in employees:
        m = Metrics(calendar_days=len(dates))
        revs = revisions.get(emp.id, [])
        structure = _in_force(revs, end)
        mid_change = any(start < r.effective_from <= end for r in revs)
        for d in dates:
            pair = shift_by_day.get(d, {}).get(emp.id)
            shift = pair[1] if pair else None
            scheduled = shift is not None and shift_applies_on(shift, d)
            if scheduled:
                m.working_days_in_period += 1
            row = by_emp_day.get((emp.id, d))
            facts = DayFacts(
                scheduled=scheduled,
                status=row.status if row else None,
                started=bool(row and row.started_at), ended=bool(row and row.ended_at),
                worked_seconds=int(row.work_seconds or 0) if row else 0,
                break_seconds=int(row.break_seconds or 0) if row else 0,
                holiday=d in holidays,
                approved_leave_type=leave_by_day.get((emp.id, d)),
                past=d < today,
            )
            if row and row.started_at and scheduled:
                window = shift_window_utc(shift, d)
                delta = (row.started_at - window[0]).total_seconds() / 60
                facts.late_minutes = max(0, int(delta))
                facts.arrival_late = row.started_at > window[0] + timedelta(
                    minutes=shift.grace_minutes)
            res = classify_day(facts, cfg)
            lt = facts.approved_leave_type
            if lt:
                m.leave_by_type[lt] = m.leave_by_type.get(lt, 0) + 1
            m.day_log.append({
                "date": d, "kind": res.kind, "late": res.late,
                "late_minutes": res.late_minutes, "late_half_day": res.late_half_day,
                "worked_seconds": res.worked_seconds, "break_seconds": res.break_seconds,
                "leave_type": lt, "review": res.review,
            })
            if res.kind == "present":
                m.present += 1
            elif res.kind == "half":
                m.half += 1
                m.half_day_dates.append(d)
            elif res.kind == "absent":
                m.absent += 1
                m.absent_dates.append(d)
            elif res.kind == "paid_leave":
                m.paid_leave += 1
            elif res.kind == "unpaid_leave":
                m.unpaid_leave += 1
                m.unpaid_leave_dates.append(d)
            elif res.kind == "week_off":
                m.week_offs += 1
            elif res.kind == "holiday":
                m.holidays += 1
            elif res.kind == "anomaly":
                m.anomalies.append({"date": d, "reason": res.review})
            if res.late:
                m.late_entries += 1
                m.late_minutes_total += res.late_minutes
                m.late_dates.append({"date": d, "late_minutes": res.late_minutes,
                                     "late_half_day": res.late_half_day})
            m.worked_seconds += res.worked_seconds
            m.break_seconds += res.break_seconds
            expected = int(float(cfg["expected_hours_per_day"]) * 3600)
            if res.kind in ("present", "half") and res.worked_seconds > expected:
                m.overtime_seconds += res.worked_seconds - expected
        if mid_change:
            m.anomalies.append({"date": end, "reason": "salary revision effective inside this period — review"})

        # --- Half-day grouping: complete groups of 3 become admin decisions.
        pool = sorted(carried_in.get(emp.id, []) + m.half_day_dates)
        m.carried_in_half_days = len(carried_in.get(emp.id, []))
        n_groups = len(pool) // 3
        remainder = pool[3 * n_groups:]
        m.ungrouped_half_days = len(remainder)
        m.carried_half_days = len(remainder) if policy_get(cfg, "half_day_carry_forward") else 0
        emp_groups = sorted(groups_by_emp.get(emp.id, []), key=lambda g: g.group_index)
        decided = [g for g in emp_groups if g.decision in ("cl", "lop")]
        pending = [g for g in emp_groups if g.decision in (None, "cl_short")]
        # Recreate pending groups to match the fresh grouping; keep decided ones.
        for g in pending:
            await session.delete(g)
        pending = []
        for i in range(n_groups):
            existing_g = next((g for g in decided if g.group_index == i), None)
            if existing_g is None:
                g = PayrollHalfDayGroup(period_id=pr.id, employee_id=emp.id,
                                        group_index=i, dates=pool[3 * i:3 * i + 3])
                session.add(g)
                pending.append(g)
        m.pending_groups = len(pending)
        m.lop_group_days = sum(1 for g in decided if g.decision == "lop")
        m.cl_consumed = sum(1 for g in decided if g.decision == "cl")
        if m.pending_groups:
            m.anomalies.append({"date": end,
                                "reason": f"{m.pending_groups} half-day group(s) awaiting CL/LOP decision"})
        if leave_pending.get(emp.id):
            m.anomalies.append({"date": end,
                                "reason": f"{leave_pending[emp.id]} leave request(s) still pending"})
        if structure is None:
            m.anomalies.append({"date": end, "reason": "no salary structure in force"})
            trace = None
        else:
            trace = compute_line({
                "calc_method": structure.calc_method, "basic": structure.basic, "hra": structure.hra,
                "allowances": structure.allowances, "incentive": structure.incentive,
                "overtime_rate": structure.overtime_rate, "deductions": structure.deductions,
            }, cfg, m)
        status = "needs_review" if (m.anomalies or trace is None) else "calculated"
        snapshot = trace or {"anomalies": m.anomalies, "gross": "0", "total_deductions": "0", "net": "0"}
        snapshot["structure_id"] = str(structure.id) if structure else None
        snapshot["policy_id"] = str(policy.id)
        snapshot["period"] = period
        snapshot["day_log"] = m.day_log
        snapshot["carried_half_day_dates"] = list(
            pool[3 * n_groups:] if policy_get(cfg, "half_day_carry_forward") else [])
        if structure is not None and structure.calc_method == "monthly":
            fixed_total = Decimal(structure.basic) + Decimal(structure.hra) + sum(
                (Decimal(str(a["amount"])) for a in structure.allowances), Decimal(0))
            div, div_label = per_day_divisor(cfg, m.working_days_in_period, m.calendar_days)
            snapshot["daily_rate"] = str(money(fixed_total / div))
            snapshot["divisor_label"] = div_label
        ln = existing.get(emp.id)
        if ln is None:
            ln = PayrollLine(period_id=pr.id, employee_id=emp.id, employee_name=emp.name)
            session.add(ln)
        ln.structure_id = structure.id if structure else None
        ln.status = status
        ln.gross = Decimal(snapshot["gross"])
        ln.total_deductions = Decimal(snapshot["total_deductions"])
        ln.net = Decimal(snapshot["net"])
        ln.snapshot = snapshot
        ln.calculated_at = datetime.now(UTC)
    await session.flush()
    return pr


async def preview_period(session: AsyncSession, *, property_id: uuid.UUID,
                         company_id: uuid.UUID, period: str,
                         today: str | None = None) -> list[dict]:
    """Read-only month-to-date view of the period — classifies every
    employee's days up to today with the same rules as generation and
    computes each line as it currently stands. Writes nothing: half-day
    groups are counted as pending rather than persisted."""
    start, end = period_bounds(period)
    today = today or datetime.now(UTC).date().isoformat()
    as_of = min(end, today)
    dates = _dates(start, as_of)
    policy = await _policy_for(session, property_id, end)
    cfg = validate_policy(policy.config)

    employees = (await session.execute(select(Employee).where(
        Employee.property_id == property_id, Employee.company_id == company_id,
        func.lower(Employee.status) != "deactivated"))).scalars().all()
    emp_ids = [e.id for e in employees]
    revisions = await _structures_for(session, emp_ids, end)
    days = (await session.execute(select(AttendanceDay).where(
        AttendanceDay.property_id == property_id,
        AttendanceDay.employee_id.in_(emp_ids),
        AttendanceDay.attendance_date >= start, AttendanceDay.attendance_date <= end,
    ))).scalars().all() if emp_ids else []
    by_emp_day = {(d.employee_id, d.attendance_date): d for d in days}
    leaves = (await session.execute(select(AttendanceRequest).where(
        AttendanceRequest.property_id == property_id,
        AttendanceRequest.employee_id.in_(emp_ids),
        AttendanceRequest.status == "approved",
        AttendanceRequest.from_date <= end, AttendanceRequest.to_date >= start,
    ))).scalars().all() if emp_ids else []
    leave_by_day: dict[tuple, str] = {}
    for lv in leaves:
        for d in _dates(max(lv.from_date, start), min(lv.to_date, end)):
            leave_by_day[(lv.employee_id, d)] = normalize_leave_type(lv.leave_type)
    holiday_rows = (await session.execute(select(Holiday).where(
        Holiday.property_id == property_id,
        Holiday.date >= start, Holiday.date <= end))).scalars().all()
    holidays = {h.date for h in holiday_rows}

    from app.services.shifts import effective_assignments, shift_applies_on, shift_window_utc
    shift_by_day = {d: await effective_assignments(session, emp_ids, d) for d in dates} if emp_ids else {}

    # Half-days carried in from the previous month still feed the grouping.
    prev_year, prev_month = int(start[:4]), int(start[5:7])
    prev_month -= 1
    if prev_month == 0:
        prev_year, prev_month = prev_year - 1, 12
    prev_period = await session.scalar(select(PayrollPeriod).where(
        PayrollPeriod.property_id == property_id,
        PayrollPeriod.period == f"{prev_year:04d}-{prev_month:02d}"))
    carried_in: dict[uuid.UUID, list] = {}
    if prev_period and policy_get(cfg, "half_day_carry_forward"):
        prev_lines = (await session.execute(select(PayrollLine).where(
            PayrollLine.period_id == prev_period.id))).scalars().all()
        for pl in prev_lines:
            dates_in = (pl.snapshot or {}).get("carried_half_day_dates") or []
            if dates_in:
                carried_in[pl.employee_id] = list(dates_in)

    rows: list[dict] = []
    for emp in employees:
        m = Metrics(calendar_days=len(dates))
        revs = revisions.get(emp.id, [])
        structure = _in_force(revs, as_of)
        mid_change = any(start < r.effective_from <= end for r in revs)
        for d in dates:
            pair = shift_by_day.get(d, {}).get(emp.id)
            shift = pair[1] if pair else None
            scheduled = shift is not None and shift_applies_on(shift, d)
            if scheduled:
                m.working_days_in_period += 1
            row = by_emp_day.get((emp.id, d))
            facts = DayFacts(
                scheduled=scheduled,
                status=row.status if row else None,
                started=bool(row and row.started_at), ended=bool(row and row.ended_at),
                worked_seconds=int(row.work_seconds or 0) if row else 0,
                break_seconds=int(row.break_seconds or 0) if row else 0,
                holiday=d in holidays,
                approved_leave_type=leave_by_day.get((emp.id, d)),
                past=d < today,
            )
            if row and row.started_at and scheduled:
                window = shift_window_utc(shift, d)
                delta = (row.started_at - window[0]).total_seconds() / 60
                facts.late_minutes = max(0, int(delta))
                facts.arrival_late = row.started_at > window[0] + timedelta(
                    minutes=shift.grace_minutes)
            res = classify_day(facts, cfg)
            lt = facts.approved_leave_type
            if lt:
                m.leave_by_type[lt] = m.leave_by_type.get(lt, 0) + 1
            if res.kind == "present":
                m.present += 1
            elif res.kind == "half":
                m.half += 1
                m.half_day_dates.append(d)
            elif res.kind == "absent":
                m.absent += 1
                m.absent_dates.append(d)
            elif res.kind == "paid_leave":
                m.paid_leave += 1
            elif res.kind == "unpaid_leave":
                m.unpaid_leave += 1
                m.unpaid_leave_dates.append(d)
            elif res.kind == "week_off":
                m.week_offs += 1
            elif res.kind == "holiday":
                m.holidays += 1
            elif res.kind == "anomaly":
                m.anomalies.append({"date": d, "reason": res.review})
            if res.late:
                m.late_entries += 1
                m.late_minutes_total += res.late_minutes
                m.late_dates.append({"date": d, "late_minutes": res.late_minutes,
                                     "late_half_day": res.late_half_day})
            m.worked_seconds += res.worked_seconds
            m.break_seconds += res.break_seconds
            expected = int(float(cfg["expected_hours_per_day"]) * 3600)
            if res.kind in ("present", "half") and res.worked_seconds > expected:
                m.overtime_seconds += res.worked_seconds - expected

        # Grouping math identical to generation, but no group rows are
        # written — complete groups are simply reported as pending.
        pool = sorted(carried_in.get(emp.id, []) + m.half_day_dates)
        m.carried_in_half_days = len(carried_in.get(emp.id, []))
        n_groups = len(pool) // 3
        m.ungrouped_half_days = len(pool) % 3
        m.carried_half_days = m.ungrouped_half_days if policy_get(cfg, "half_day_carry_forward") else 0
        m.pending_groups = n_groups
        if m.pending_groups:
            m.anomalies.append({"date": as_of,
                                "reason": f"{m.pending_groups} half-day group(s) awaiting CL/LOP decision"})
        if mid_change:
            m.anomalies.append({"date": end, "reason": "salary revision effective inside this period — review"})

        rate = None
        rate_label = None
        trace = None
        if structure is not None:
            trace = compute_line({
                "calc_method": structure.calc_method, "basic": structure.basic, "hra": structure.hra,
                "allowances": structure.allowances, "incentive": structure.incentive,
                "overtime_rate": structure.overtime_rate, "deductions": structure.deductions,
            }, cfg, m)
            if structure.calc_method == "monthly":
                fixed_total = Decimal(structure.basic) + Decimal(structure.hra) + sum(
                    (Decimal(str(a["amount"])) for a in structure.allowances), Decimal(0))
                div, div_label = per_day_divisor(cfg, m.working_days_in_period, m.calendar_days)
                rate = money(fixed_total / div)
                rate_label = f"per day ({div_label})"
            elif structure.calc_method == "daily":
                rate = money(structure.basic)
                rate_label = "per day"
            else:
                rate = money(structure.basic)
                rate_label = "per hour"
        else:
            m.anomalies.append({"date": as_of, "reason": "no salary structure in force"})

        metrics = trace["metrics"] if trace else {
            "calendar_days": m.calendar_days,
            "working_days_in_period": m.working_days_in_period,
            "present_days": m.present, "half_days": m.half,
            "absent_days": m.absent, "paid_leave_days": m.paid_leave,
            "unpaid_leave_days": m.unpaid_leave, "week_offs": m.week_offs,
            "holidays": m.holidays, "late_entries": m.late_entries,
            "late_minutes_total": m.late_minutes_total,
            "worked_hours": str(round(m.worked_seconds / 3600, 2)),
            "break_hours": str(round(m.break_seconds / 3600, 2)),
            "overtime_hours": str(round(m.overtime_seconds / 3600, 2)),
            "lop_group_days": m.lop_group_days, "cl_consumed": m.cl_consumed,
            "pending_half_day_groups": m.pending_groups,
            "carried_half_days": m.carried_half_days,
            "carried_in_half_days": m.carried_in_half_days,
            "leave_by_type": m.leave_by_type,
        }
        rows.append({
            "employee_uid": str(emp.id),
            "employee_name": emp.name,
            "calc_method": structure.calc_method if structure else None,
            "rate": str(rate) if rate is not None else None,
            "rate_label": rate_label,
            "metrics": metrics,
            "gross": trace["gross"] if trace else "0",
            "total_deductions": trace["total_deductions"] if trace else "0",
            "net": trace["net"] if trace else "0",
            "anomalies": m.anomalies,
        })
    return rows


async def _period(session, property_id, period) -> PayrollPeriod:
    pr = await session.scalar(select(PayrollPeriod).where(
        PayrollPeriod.property_id == property_id, PayrollPeriod.period == period))
    if pr is None:
        raise NotFoundErr("Payroll period not found.")
    return pr


async def submit_period(session, *, property_id, period, actor_name) -> PayrollPeriod:
    pr = await _period(session, property_id, period)
    if pr.status != "open":
        raise ConflictErr(f"Only an open period can be submitted (status is {pr.status}).", code="BAD_STATE")
    pending = await session.scalar(select(func.count()).select_from(PayrollHalfDayGroup).where(
        PayrollHalfDayGroup.period_id == pr.id,
        PayrollHalfDayGroup.decision.is_(None) | (PayrollHalfDayGroup.decision == "cl_short")))
    if pending:
        raise ConflictErr(
            f"{pending} half-day group(s) still need a CL or LOP decision before submission.",
            code="PENDING_DECISIONS")
    pr.status = "submitted"
    pr.submitted_by_name = actor_name
    pr.submitted_at = datetime.now(UTC)
    await session.flush()
    return pr


async def approve_period(session, *, property_id, period, actor_id, actor_name) -> PayrollPeriod:
    pr = await _period(session, property_id, period)
    if pr.status != "submitted":
        raise ConflictErr("Only a submitted period can be approved.", code="BAD_STATE")
    open_reviews = await session.scalar(select(func.count()).select_from(PayrollLine).where(
        PayrollLine.period_id == pr.id, PayrollLine.status == "needs_review"))
    if open_reviews:
        raise ConflictErr(f"{open_reviews} line(s) still need review; resolve before approval.", code="NEEDS_REVIEW")
    pr.status = "approved"
    pr.approved_by_id = actor_id
    pr.approved_by_name = actor_name
    pr.approved_at = datetime.now(UTC)
    await session.execute(
        PayrollLine.__table__.update().where(PayrollLine.period_id == pr.id).values(status="approved"))
    await session.flush()
    return pr


async def mark_paid(session, *, property_id, period, actor_name,
                    payment_method: str | None = None,
                    payment_reference: str | None = None) -> PayrollPeriod:
    pr = await _period(session, property_id, period)
    if pr.status != "approved":
        raise ConflictErr("Only an approved period can be marked paid.", code="BAD_STATE")
    now = datetime.now(UTC)
    pr.status = "paid"
    pr.paid_at = now
    pr.paid_by_name = actor_name
    lines = (await session.execute(select(PayrollLine).where(
        PayrollLine.period_id == pr.id))).scalars().all()
    for ln in lines:
        ln.status = "paid"
        ln.paid_at = ln.paid_at or now
        ln.paid_by_name = actor_name
        if payment_method:
            ln.payment_method = payment_method
        if payment_reference:
            ln.payment_reference = payment_reference
    await session.flush()
    return pr


async def pay_line(session, *, line_id, actor_name, payment_method=None,
                   payment_reference=None) -> PayrollLine:
    """Mark one approved line as paid — individual payment record."""
    line = await session.get(PayrollLine, line_id)
    if line is None:
        raise NotFoundErr("Payroll line not found.")
    pr = await session.get(PayrollPeriod, line.period_id)
    if pr.status != "approved" and not (pr.status == "paid" and line.status == "approved"):
        raise ConflictErr("Only approved payroll lines can be marked paid.", code="BAD_STATE")
    line.status = "paid"
    line.paid_at = datetime.now(UTC)
    line.paid_by_name = actor_name
    line.payment_method = payment_method
    line.payment_reference = payment_reference
    await session.flush()
    return line


async def cl_balance(session, employee_id: uuid.UUID) -> Decimal:
    """CL balance = opening employees.leave_balance_days + ledger deltas."""
    emp = await session.get(Employee, employee_id)
    if emp is None:
        raise NotFoundErr("Employee not found.")
    opening = Decimal(str(emp.leave_balance_days or 0))
    deltas = await session.scalar(select(func.coalesce(func.sum(LeaveLedger.delta), 0)).where(
        LeaveLedger.employee_id == employee_id, LeaveLedger.leave_type == "CL"))
    return opening + Decimal(str(deltas))


async def decide_half_day_group(session, *, group_id, decision, actor_id, actor_name) -> PayrollHalfDayGroup:
    """Apply the admin decision for one group of 3 half-days.

    'cl'  → consume 1 Casual Leave via the ledger (never negative; a shortfall
            is flagged 'cl_short' instead of being applied).
    'lop' → one full-day LOP: the line's lop_halfday deduction is updated and
            totals recomputed from the snapshot.
    Only allowed while the period is open (not submitted/approved/paid)."""
    if decision not in ("cl", "lop"):
        raise ValidationErr("Decision must be 'cl' or 'lop'.", field="decision")
    group = await session.get(PayrollHalfDayGroup, group_id)
    if group is None:
        raise NotFoundErr("Half-day group not found.")
    pr = await session.get(PayrollPeriod, group.period_id)
    if pr.status != "open":
        raise ConflictErr("Half-day decisions can only be made while the period is open.",
                          code="BAD_STATE")
    if group.decision == "cl" and decision == "cl":
        raise ConflictErr("This group already consumed CL.", code="ALREADY_PROCESSED")
    line = await session.scalar(select(PayrollLine).where(
        PayrollLine.period_id == pr.id, PayrollLine.employee_id == group.employee_id))
    if line is None:
        raise NotFoundErr("Payroll line not found.")
    now = datetime.now(UTC)
    balance = await cl_balance(session, group.employee_id)
    if decision == "cl" and balance < 1:
        group.decision = "cl_short"
        group.cl_balance_at_decision = int(balance)
        group.decided_by_id, group.decided_by_name, group.decided_at = actor_id, actor_name, now
        anomalies = line.snapshot.setdefault("anomalies", [])
        anomalies.append({"date": pr.period, "reason":
                          f"CL balance insufficient ({balance}) for half-day group {group.group_index + 1}"})
        line.status = "needs_review"
        flag_modified(line, "snapshot")
        await session.flush()
        return group
    if decision == "cl":
        session.add(LeaveLedger(
            employee_id=group.employee_id, leave_type="CL", delta=Decimal("-1"),
            reason=f"3 half-days converted to CL — {pr.period} group {group.group_index + 1} "
                   f"(dates: {', '.join(group.dates)})",
            reference_type="half_day_group", reference_id=group.id,
            created_by_id=actor_id, created_by_name=actor_name))
    group.decision = decision
    group.cl_balance_at_decision = int(balance)
    group.decided_by_id, group.decided_by_name, group.decided_at = actor_id, actor_name, now

    # Recompute the line's totals from its snapshot.
    snap = line.snapshot
    daily_rate = Decimal(snap.get("daily_rate", "0"))
    lop_groups = await session.scalar(select(func.count()).select_from(PayrollHalfDayGroup).where(
        PayrollHalfDayGroup.period_id == pr.id, PayrollHalfDayGroup.employee_id == group.employee_id,
        PayrollHalfDayGroup.decision == "lop"))
    cl_groups = await session.scalar(select(func.count()).select_from(PayrollHalfDayGroup).where(
        PayrollHalfDayGroup.period_id == pr.id, PayrollHalfDayGroup.employee_id == group.employee_id,
        PayrollHalfDayGroup.decision == "cl"))
    ded = {d["code"]: d for d in snap.get("deductions", [])}
    if lop_groups:
        ded["lop_halfday"] = {"code": "lop_halfday", "label": "Loss of pay — half-day groups",
                              "amount": str(money(daily_rate * Decimal(lop_groups))),
                              "basis": f"{lop_groups} group(s) of 3 half-days = 1 day LOP each"}
    elif "lop_halfday" in ded:
        ded.pop("lop_halfday")
    snap["deductions"] = [d for d in ded.values() if Decimal(str(d["amount"])) != 0]
    metrics = snap.setdefault("metrics", {})
    metrics["lop_group_days"] = lop_groups
    metrics["cl_consumed"] = cl_groups
    metrics["pending_half_day_groups"] = max(
        0, metrics.get("pending_half_day_groups", 1) - 1)
    gross = Decimal(snap["gross"])
    total = money(sum((Decimal(str(d["amount"])) for d in snap["deductions"]), Decimal(0)))
    snap["total_deductions"] = str(total)
    snap["net"] = str(money(gross - total))
    line.total_deductions = total
    line.net = Decimal(snap["net"])
    snap["anomalies"] = [a for a in snap.get("anomalies", [])
                         if "half-day group" not in a.get("reason", "")]
    remaining = await session.scalar(select(func.count()).select_from(PayrollHalfDayGroup).where(
        PayrollHalfDayGroup.period_id == pr.id,
        PayrollHalfDayGroup.employee_id == group.employee_id,
        PayrollHalfDayGroup.decision.is_(None) | (PayrollHalfDayGroup.decision == "cl_short")))
    if not remaining and not snap.get("anomalies"):
        line.status = "calculated"
    flag_modified(line, "snapshot")
    await session.flush()
    return group


async def add_adjustment(session, *, line_id, amount, reason, actor_id, actor_name) -> PayrollAdjustment:
    reason = (reason or "").strip()
    if len(reason) < 10:
        raise ValidationErr("An adjustment needs a reason of at least 10 characters.", field="reason")
    line = await session.get(PayrollLine, line_id)
    if line is None:
        raise NotFoundErr("Payroll line not found.")
    if line.status not in ("approved", "paid"):
        raise ConflictErr("Adjustments apply to approved or paid lines only; recalculate open periods instead.", code="BAD_STATE")
    amt = money(amount)
    if amt == 0:
        raise ValidationErr("Adjustment amount cannot be zero.", field="amount")
    adj = PayrollAdjustment(line_id=line.id, amount=amt, reason=reason,
                            created_by_id=actor_id, created_by_name=actor_name)
    session.add(adj)
    await session.flush()
    return adj


def _prev_day(day: str) -> str:
    return (date_type.fromisoformat(day) - timedelta(days=1)).isoformat()


async def _finalized_covers(session, property_id, day: str) -> bool:
    finals = (await session.execute(select(PayrollPeriod.period).where(
        PayrollPeriod.property_id == property_id,
        PayrollPeriod.status.in_(FINAL_PERIOD_STATUSES)))).scalars().all()
    return any(period_bounds(p)[1] >= day for p in finals)


def _check_date(value: str, field: str) -> str:
    try:
        date_type.fromisoformat(value)
    except (TypeError, ValueError):
        raise ValidationErr(f"{field} must be YYYY-MM-DD.", field=field)
    return value


async def create_policy(session, *, company_id, property_id, name, effective_from, config,
                        actor_id, actor_name) -> PayrollPolicy:
    _check_date(effective_from, "effective_from")
    validate_policy(config)
    if await _finalized_covers(session, property_id, effective_from):
        raise ConflictErr("A finalized payroll period already covers this date.", code="FINALIZED_PERIOD")
    latest = await session.scalar(select(PayrollPolicy).where(
        PayrollPolicy.property_id == property_id).order_by(PayrollPolicy.effective_from.desc()))
    if latest is not None:
        if effective_from <= latest.effective_from:
            raise ConflictErr("A new policy must start after the latest policy's start date.", code="POLICY_ORDER")
        if latest.effective_until is None or latest.effective_until >= effective_from:
            latest.effective_until = _prev_day(effective_from)
    pol = PayrollPolicy(company_id=company_id, property_id=property_id, name=name.strip() or "Policy",
                        effective_from=effective_from, config=config,
                        created_by_id=actor_id, created_by_name=actor_name)
    session.add(pol)
    await session.flush()
    return pol


async def create_structure(session, *, employee: Employee, calc_method, basic, hra, allowances,
                           incentive, overtime_rate, deductions, effective_from,
                           actor_id, actor_name) -> SalaryStructure:
    _check_date(effective_from, "effective_from")
    basic_d, hra_d = money(basic), money(hra)
    inc_d, ot_d = money(incentive), money(overtime_rate)
    validate_structure(calc_method=calc_method, basic=basic_d, hra=hra_d, deductions=deductions)
    if await _finalized_covers(session, employee.property_id, effective_from):
        raise ConflictErr("A finalized payroll period already covers this date; the revision cannot apply to it.",
                          code="FINALIZED_PERIOD")
    latest = await session.scalar(select(SalaryStructure).where(
        SalaryStructure.employee_id == employee.id).order_by(SalaryStructure.effective_from.desc()))
    if latest is not None:
        if effective_from <= latest.effective_from:
            raise ConflictErr("A revision must start after the latest revision's effective date.", code="REVISION_ORDER")
        if latest.effective_until is None or latest.effective_until >= effective_from:
            latest.effective_until = _prev_day(effective_from)
    row = SalaryStructure(
        employee_id=employee.id, property_id=employee.property_id, calc_method=calc_method,
        effective_from=effective_from, basic=basic_d, hra=hra_d,
        allowances=[{"name": str(a["name"])[:80], "amount": str(money(a["amount"]))} for a in allowances],
        incentive=inc_d, overtime_rate=ot_d, deductions=deductions,
        created_by_id=actor_id, created_by_name=actor_name,
    )
    session.add(row)
    await session.flush()
    return row
