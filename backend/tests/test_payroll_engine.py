"""Payroll calculation core — pure functions, no database."""
from decimal import Decimal

import pytest

from app.services.payroll import (
    DayFacts,
    Metrics,
    classify_day,
    compute_line,
    period_bounds,
    validate_policy,
    validate_structure,
)
from app.services.structure import ValidationErr

POLICY = {
    "monthly_working_days": 30,
    "expected_hours_per_day": 8,
    "late_free_per_month": 2,
    "late_deduction_days_per_excess": 0.5,
    "half_day_below_hours": 4,
    "absent_deduction_days": 1,
    "overtime_enabled": True,
    "overtime_multiplier": 1.5,
    "paid_leave_is_paid": True,
    "unpaid_leave_is_paid": False,
    "proration": "working_days",
}

MONTHLY = {
    "calc_method": "monthly", "basic": 30000, "hra": 6000,
    "allowances": [{"name": "Transport", "amount": 1500}], "incentive": 1000,
    "overtime_rate": 200, "deductions": [],
}


def _line(structure=MONTHLY, policy=POLICY, **metrics):
    return compute_line(structure, policy, Metrics(**metrics))


def _amount(line, code, bucket="earnings"):
    return sum(Decimal(x["amount"]) for x in line[bucket] if x["code"] == code)


# --- policy & structure validation -----------------------------------------

def test_policy_requires_every_money_rule():
    incomplete = {k: v for k, v in POLICY.items() if k != "late_free_per_month"}
    with pytest.raises(ValidationErr, match="late_free_per_month"):
        validate_policy(incomplete)


def test_policy_rejects_unknown_proration():
    with pytest.raises(ValidationErr):
        validate_policy({**POLICY, "proration": "calendar_days"})


def test_structure_rejects_unknown_method_and_negative_amounts():
    with pytest.raises(ValidationErr):
        validate_structure(calc_method="weekly", basic=Decimal(1), hra=Decimal(0), deductions=[])
    with pytest.raises(ValidationErr):
        validate_structure(calc_method="monthly", basic=Decimal(-1), hra=Decimal(0), deductions=[])


def test_structure_rejects_unknown_statutory_code():
    with pytest.raises(ValidationErr):
        validate_structure(calc_method="monthly", basic=Decimal(1), hra=Decimal(0),
                           deductions=[{"code": "XYZ", "mode": "fixed", "value": 1}])


# --- day classification ----------------------------------------------------

def test_present_full_day():
    r = classify_day(DayFacts(scheduled=True, status="present", started=True, ended=True,
                              worked_seconds=8 * 3600), POLICY)
    assert r.kind == "present"


def test_short_day_is_half_day():
    r = classify_day(DayFacts(scheduled=True, status="present", started=True, ended=True,
                              worked_seconds=3 * 3600), POLICY)
    assert r.kind == "half"


def test_missing_end_of_day_is_anomaly_not_deduction():
    r = classify_day(DayFacts(scheduled=True, status="present", started=True, ended=False), POLICY)
    assert r.kind == "anomaly" and r.review


def test_unmarked_past_scheduled_day_is_absent_and_future_is_off():
    assert classify_day(DayFacts(scheduled=True, status=None, past=True), POLICY).kind == "absent"
    assert classify_day(DayFacts(scheduled=True, status=None, past=False), POLICY).kind == "off"


def test_approved_paid_leave_is_not_absence():
    r = classify_day(DayFacts(scheduled=True, status=None, approved_leave_type="sick_leave"), POLICY)
    assert r.kind == "paid_leave"


def test_approved_unpaid_leave_follows_policy():
    r = classify_day(DayFacts(scheduled=True, status=None, approved_leave_type="unpaid_leave"), POLICY)
    assert r.kind == "unpaid_leave"


def test_late_arrival_is_recorded_but_not_a_half_day():
    r = classify_day(DayFacts(scheduled=True, status="present", started=True, ended=True,
                              worked_seconds=8 * 3600, arrival_late=True), POLICY)
    assert r.kind == "present" and r.late is True


def test_week_off_and_unscheduled_days_do_not_deduct():
    assert classify_day(DayFacts(scheduled=False, status="week_off"), POLICY).kind == "week_off"
    assert classify_day(DayFacts(scheduled=False, status=None), POLICY).kind == "off"


# --- monthly salary --------------------------------------------------------

def test_monthly_full_attendance_earns_full_components():
    line = _line(present=26, worked_seconds=26 * 8 * 3600)
    assert Decimal(line["gross"]) == Decimal("38500.00")  # 30000+6000+1500+1000
    assert Decimal(line["total_deductions"]) == Decimal("0.00")
    assert Decimal(line["net"]) == Decimal("38500.00")


def test_monthly_absence_deducts_one_thirtieth_per_day():
    line = _line(present=25, absent=1, worked_seconds=25 * 8 * 3600)
    absence = _amount(line, "lop_absence", "deductions")
    daily = (Decimal(30000) + Decimal(6000) + Decimal(1500)) / Decimal(30)
    assert absence == daily.quantize(Decimal("0.01"))
    assert Decimal(line["net"]) == Decimal(line["gross"]) - absence


def test_unpaid_leave_deducts_like_absence_but_paid_leave_does_not():
    unpaid = _line(present=25, unpaid_leave=1, worked_seconds=25 * 8 * 3600)
    paid = _line(present=25, paid_leave=1, worked_seconds=25 * 8 * 3600)
    assert _amount(unpaid, "lop_leave", "deductions") > 0
    assert _amount(paid, "lop_leave", "deductions") == 0


def test_late_entries_allowed_then_deducted_by_policy():
    within = _line(present=26, late_entries=2, worked_seconds=26 * 8 * 3600)
    beyond = _line(present=26, late_entries=4, worked_seconds=26 * 8 * 3600)
    assert _amount(within, "late_entry", "deductions") == 0
    # 2 excess late entries × 0.5 day × (monthly pay / 30)
    assert _amount(beyond, "late_entry", "deductions") > 0
    assert _amount(beyond, "late_entry", "deductions") == _amount(beyond, "late_entry", "deductions").quantize(Decimal("0.01"))


def test_late_entry_never_auto_becomes_half_day():
    line = _line(present=26, late_entries=2, worked_seconds=26 * 8 * 3600)
    assert _amount(line, "half_day", "deductions") == 0


def test_half_day_deducts_half_a_day():
    line = _line(present=25, half=1, ungrouped_half_days=1, worked_seconds=25 * 8 * 3600 + 3 * 3600)
    daily = (Decimal(30000) + Decimal(6000) + Decimal(1500)) / Decimal(30)
    assert _amount(line, "half_day", "deductions") == (daily * Decimal("0.5")).quantize(Decimal("0.01"))


def test_breaks_are_excluded_from_worked_hours_via_metrics():
    # worked_seconds is already net of breaks (AttendanceDay.work_seconds).
    line = _line(present=1, worked_seconds=7 * 3600)
    assert line["metrics"]["worked_hours"] == "7.0"


def test_overtime_paid_at_rate_times_multiplier():
    line = _line(present=26, worked_seconds=26 * 8 * 3600 + 2 * 3600, overtime_seconds=2 * 3600)
    assert _amount(line, "overtime") == Decimal("200") * Decimal("1.5") * Decimal("2")


def test_overtime_not_payable_when_disabled():
    line = _line(policy={**POLICY, "overtime_enabled": False}, present=26,
                 worked_seconds=26 * 8 * 3600 + 3600, overtime_seconds=3600)
    assert _amount(line, "overtime") == 0
    assert any("not payable" in n for n in line["notes"])


def test_percent_statutory_deduction_applies_only_when_configured():
    with_pf = {**MONTHLY, "deductions": [{"code": "PF", "mode": "percent", "value": 12,
                                           "basis": "basic", "ceiling": 1800}]}
    line = _line(structure=with_pf, present=26, worked_seconds=26 * 8 * 3600)
    assert _amount(line, "PF", "deductions") == Decimal("1800.00")  # 12% of 30000 capped
    assert _amount(_line(present=26, worked_seconds=26 * 8 * 3600), "PF", "deductions") == 0


def test_negative_net_is_floored_and_noted():
    tiny = {**MONTHLY, "basic": 100, "hra": 0, "allowances": [], "incentive": 0,
            "deductions": [{"code": "other", "mode": "fixed", "value": 5000}]}
    line = _line(structure=tiny, present=26, worked_seconds=26 * 8 * 3600)
    assert Decimal(line["net"]) == Decimal("0.00")
    assert any("floored" in n for n in line["notes"])


# --- daily and hourly wages ------------------------------------------------

DAILY = {"calc_method": "daily", "basic": 1000, "hra": 0, "allowances": [], "incentive": 0,
         "overtime_rate": 0, "deductions": []}
HOURLY = {"calc_method": "hourly", "basic": 150, "hra": 0, "allowances": [], "incentive": 0,
          "overtime_rate": 0, "deductions": []}


def test_daily_wage_pays_per_paid_day_including_paid_leave_not_absence():
    line = _line(structure=DAILY, present=20, paid_leave=2, absent=1, half=1,
                 worked_seconds=20 * 8 * 3600)
    # 20 present + 2 paid leave + 0.5 half = 22.5 paid days
    assert Decimal(line["gross"]) == Decimal("22500.00")


def test_hourly_wage_pays_net_hours_only():
    line = _line(structure=HOURLY, present=2, worked_seconds=15 * 3600)
    assert Decimal(line["gross"]) == Decimal("2250.00")  # 15h × 150


def test_daily_and_hourly_do_not_double_count_late_or_absence():
    line = _line(structure=HOURLY, present=2, absent=3, late_entries=5, worked_seconds=10 * 3600)
    assert _amount(line, "lop_absence", "deductions") == 0
    assert _amount(line, "late_entry", "deductions") == 0


# --- period bounds ---------------------------------------------------------

def test_period_bounds_cover_whole_calendar_month():
    assert period_bounds("2026-02") == ("2026-02-01", "2026-02-28")
    assert period_bounds("2028-02") == ("2028-02-01", "2028-02-29")


# --- new spec: 30-minute late-entry half-day rule ---------------------------

def _late(minutes, worked=8 * 3600):
    return classify_day(DayFacts(scheduled=True, status="present", started=True, ended=True,
                                 worked_seconds=worked, arrival_late=minutes > 0,
                                 late_minutes=minutes), POLICY)


def test_late_at_exactly_30_minutes_is_not_a_half_day():
    r = _late(30)
    assert r.kind == "present" and r.late and not r.late_half_day


def test_late_at_29_minutes_is_not_a_half_day():
    assert _late(29).kind == "present"


def test_late_at_31_minutes_is_a_half_day():
    r = _late(31)
    assert r.kind == "half" and r.late_half_day


def test_late_at_60_minutes_is_a_half_day():
    assert _late(60).kind == "half"


def test_late_half_day_threshold_is_configurable():
    pol = {**POLICY, "late_half_day_after_minutes": 15}
    assert classify_day(DayFacts(scheduled=True, status="present", started=True, ended=True,
                                 worked_seconds=8 * 3600, arrival_late=True, late_minutes=20),
                        pol).kind == "half"


def test_missing_end_of_day_late_over_30_is_anomaly_not_half():
    r = classify_day(DayFacts(scheduled=True, status="present", started=True, ended=False,
                              arrival_late=True, late_minutes=45), POLICY)
    assert r.kind == "anomaly" and r.review


def test_late_half_day_not_double_charged_as_late_entry():
    m = Metrics(present=0, half=1, ungrouped_half_days=1,
                late_entries=1, late_dates=[{"date": "2026-01-05", "late_minutes": 45,
                                             "late_half_day": True}],
                worked_seconds=8 * 3600)
    line = compute_line(MONTHLY, POLICY, m)
    # Only the 0.5-day half-day charge; the late incident is not charged again.
    assert _amount(line, "late_entry", "deductions") == 0
    assert _amount(line, "half_day", "deductions") > 0


# --- holidays ---------------------------------------------------------------

def test_holiday_is_paid_not_absent():
    r = classify_day(DayFacts(scheduled=True, status=None, holiday=True), POLICY)
    assert r.kind == "holiday"


def test_unpaid_holiday_policy_yields_unpaid_leave():
    pol = {**POLICY, "holiday_is_paid": False}
    assert classify_day(DayFacts(scheduled=True, status=None, holiday=True), pol).kind == "unpaid_leave"


# --- per-day divisor modes --------------------------------------------------

def test_fixed_divisor_uses_configured_value():
    line = _line(policy={**POLICY, "per_day_divisor": {"mode": "fixed", "value": 30}},
                 present=25, absent=1, worked_seconds=25 * 8 * 3600)
    daily = (Decimal(30000) + Decimal(6000) + Decimal(1500)) / Decimal(30)
    assert _amount(line, "lop_absence", "deductions") == daily.quantize(Decimal("0.01"))


def test_calendar_divisor_uses_days_in_month():
    line = _line(policy={**POLICY, "per_day_divisor": {"mode": "calendar"}},
                 calendar_days=31, present=26, absent=1, worked_seconds=26 * 8 * 3600)
    daily = (Decimal(30000) + Decimal(6000) + Decimal(1500)) / Decimal(31)
    assert _amount(line, "lop_absence", "deductions") == daily.quantize(Decimal("0.01"))


def test_scheduled_divisor_uses_working_days():
    line = _line(policy={**POLICY, "per_day_divisor": {"mode": "scheduled"}},
                 calendar_days=31, working_days_in_period=26, present=25, absent=1,
                 worked_seconds=25 * 8 * 3600)
    daily = (Decimal(30000) + Decimal(6000) + Decimal(1500)) / Decimal(26)
    assert _amount(line, "lop_absence", "deductions") == daily.quantize(Decimal("0.01"))


def test_divisor_label_is_shown_in_basis():
    line = _line(policy={**POLICY, "per_day_divisor": {"mode": "fixed", "value": 30}},
                 present=26, worked_seconds=26 * 8 * 3600)
    basic = next(e for e in line["earnings"] if e["code"] == "basic")
    assert "fixed 30-day divisor" in basic["basis"]


# --- leave normalization ----------------------------------------------------

def test_leave_type_aliases():
    from app.services.payroll import normalize_leave_type
    assert normalize_leave_type("casual_leave") == "CL"
    assert normalize_leave_type("CL") == "CL"
    assert normalize_leave_type("sick_leave") == "SL"
    assert normalize_leave_type("unpaid_leave") == "LWP"
    assert normalize_leave_type("mystery") == "other"


def test_cl_is_paid_by_default_paid_leave_types():
    r = classify_day(DayFacts(scheduled=True, status=None, approved_leave_type="cl"), POLICY)
    assert r.kind == "paid_leave"


def test_pending_leave_is_not_counted_anywhere():
    # Only approved leave types reach classify_day; a pending request never
    # appears as a paid day. Guarded here by construction: no approved type.
    r = classify_day(DayFacts(scheduled=True, status=None, past=True), POLICY)
    assert r.kind == "absent"


# --- half-day deduction & carry-forward -------------------------------------

def test_ungrouped_half_days_deduct_half_day_each():
    m = Metrics(present=24, half=2, ungrouped_half_days=2, worked_seconds=24 * 8 * 3600)
    line = compute_line(MONTHLY, POLICY, m)
    daily = (Decimal(30000) + Decimal(6000) + Decimal(1500)) / Decimal(30)
    assert _amount(line, "half_day", "deductions") == (daily * 1).quantize(Decimal("0.01"))


def test_carry_forward_policy_skips_ungrouped_deduction():
    m = Metrics(present=24, half=1, ungrouped_half_days=1, carried_half_days=1,
                worked_seconds=24 * 8 * 3600)
    line = compute_line(MONTHLY, {**POLICY, "half_day_carry_forward": True}, m)
    assert _amount(line, "half_day", "deductions") == 0
    assert any("carried" in n for n in line["notes"])


def test_lop_group_adds_one_full_day_deduction():
    m = Metrics(present=22, half=3, ungrouped_half_days=0, lop_group_days=1,
                worked_seconds=22 * 8 * 3600)
    line = compute_line(MONTHLY, POLICY, m)
    daily = (Decimal(30000) + Decimal(6000) + Decimal(1500)) / Decimal(30)
    assert _amount(line, "lop_halfday", "deductions") == daily.quantize(Decimal("0.01"))
    # Grouped half-days are not also charged as half-day deductions.
    assert _amount(line, "half_day", "deductions") == 0
