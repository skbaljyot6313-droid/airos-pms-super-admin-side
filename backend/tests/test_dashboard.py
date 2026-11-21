"""Property dashboard — period logic, operational-day boundaries, occupancy
ledger trends, attendance and data-quality rules.

Pure-function tests: the aggregate is verified end-to-end against live data
(see the reconciliation run recorded in docs/super-admin-redesign-discovery/11).
"""

from datetime import UTC, date, datetime, time
from types import SimpleNamespace

import pytest

from app.services.dashboard import (
    EXPIRY_REASONS,
    DashboardService,
    _day_bounds,
    _median_minutes,
    _op_day,
    resolve_period,
)

OP = time(6, 0)
TODAY = date(2026, 11, 19)


def _win(d_from, d_to):
    from app.services.dashboard import _day_bounds
    p_start, _ = _day_bounds(d_from, OP)
    _, p_end = _day_bounds(d_to, OP)
    return dict(p_start=p_start, p_end=p_end, now=datetime(2026, 11, 20, 12, 0, tzinfo=UTC))


def _occ(room=None, bed=None, cin=None, cout=None):
    return SimpleNamespace(room_id=room, bed_id=bed, checked_in_at=cin, checked_out_at=cout)


def _svc():
    return DashboardService(None)


# ---- period resolution ---------------------------------------------------

@pytest.mark.parametrize("key,expected", [
    ("today", (date(2026, 11, 19), date(2026, 11, 19))),
    ("yesterday", (date(2026, 11, 18), date(2026, 11, 18))),
    ("last_7_days", (date(2026, 11, 13), date(2026, 11, 19))),
    ("last_30_days", (date(2026, 10, 21), date(2026, 11, 19))),
    ("this_month", (date(2026, 11, 1), date(2026, 11, 19))),
    ("last_month", (date(2026, 10, 1), date(2026, 10, 31))),
])
def test_named_periods(key, expected):
    d_from, d_to, _ = resolve_period(key, TODAY)
    assert (d_from, d_to) == expected


def test_last_month_crosses_year_boundary():
    d_from, d_to, _ = resolve_period("last_month", date(2027, 1, 5))
    assert (d_from, d_to) == (date(2026, 12, 1), date(2026, 12, 31))


def test_custom_period_validates_order_and_length():
    with pytest.raises(ValueError):
        resolve_period("custom", TODAY, date(2026, 11, 5), date(2026, 11, 1))
    with pytest.raises(ValueError):
        resolve_period("custom", TODAY, date(2025, 1, 1), date(2026, 11, 1))
    with pytest.raises(ValueError):
        resolve_period("custom", TODAY, None, None)
    d_from, d_to, label = resolve_period("custom", TODAY, date(2026, 11, 1), date(2026, 11, 3))
    assert (d_from, d_to) == (date(2026, 11, 1), date(2026, 11, 3))
    assert "Nov 2026" in label


def test_unknown_period_rejected():
    with pytest.raises(ValueError):
        resolve_period("next_year", TODAY)


# ---- operational day boundaries (IST, 06:00 start) -------------------------

def test_operational_day_rolls_over_at_six_ist():
    # 05:30 IST on 20 Nov is still the 19 Nov operational day
    early = datetime(2026, 11, 20, 0, 0, tzinfo=UTC)  # 05:30 IST
    late = datetime(2026, 11, 20, 1, 0, tzinfo=UTC)  # 06:30 IST
    assert _op_day(early, OP) == date(2026, 11, 19)
    assert _op_day(late, OP) == date(2026, 11, 20)


def test_day_bounds_span_exactly_one_operational_day():
    start, end = _day_bounds(date(2026, 11, 19), OP)
    assert (end - start).total_seconds() == 24 * 3600
    assert start.hour == 0 and start.minute == 30  # 06:00 IST == 00:30 UTC


def test_naive_timestamps_are_treated_as_utc():
    naive = datetime(2026, 11, 19, 12, 0)
    assert _op_day(naive, OP) == _op_day(naive.replace(tzinfo=UTC), OP)


# ---- occupancy ledger trend -------------------------------------------------

def test_occupancy_trend_counts_each_day_of_a_stay_once():
    start = datetime(2026, 11, 1, 1, 0, tzinfo=UTC)   # 06:30 IST 1 Nov
    end = datetime(2026, 11, 4, 1, 0, tzinfo=UTC)     # 06:30 IST 4 Nov
    rows = [_occ(room="r1", cin=start, cout=end), _occ(room="r2", cin=start, cout=None)]
    t = _svc()._occupancy_trend(rows, date(2026, 11, 1), date(2026, 11, 5), OP, 4, "day", **_win(date(2026, 11, 1), date(2026, 11, 5)))
    occupied = {p["date"]: p["occupied_rooms"] for p in t["daily"]}
    assert occupied["2026-11-01"] == 2
    assert occupied["2026-11-03"] == 2
    assert occupied["2026-11-05"] == 1  # r2 still open; r1 checked out
    assert t["peak"]["occupied_rooms"] == 2
    assert t["average_occupied_rooms"] == pytest.approx((2 + 2 + 2 + 2 + 1) / 5, rel=1e-3)


def test_bed_stays_do_not_count_as_room_occupancy():
    start = datetime(2026, 11, 2, 1, 0, tzinfo=UTC)
    rows = [_occ(bed="b1", cin=start, cout=None)]
    t = _svc()._occupancy_trend(rows, date(2026, 11, 1), date(2026, 11, 3), OP, 10, "day", **_win(date(2026, 11, 1), date(2026, 11, 3)))
    assert all(p["occupied_rooms"] == 0 for p in t["daily"])


def test_occupancy_trend_reports_no_records_explicitly():
    t = _svc()._occupancy_trend([], date(2026, 10, 1), date(2026, 10, 31), OP, 16, "day", **_win(date(2026, 10, 1), date(2026, 10, 31)))
    assert t["reliable"] is False
    assert t["first_record_date"] is None
    assert "No occupancy ledger records" in t["reason"]


def test_occupancy_trend_reliable_when_history_covers_the_range():
    start = datetime(2026, 11, 1, 1, 0, tzinfo=UTC)
    rows = [_occ(room="r1", cin=start, cout=start.replace(day=2))]
    t = _svc()._occupancy_trend(rows, date(2026, 11, 1), date(2026, 11, 3), OP, 16, "day", **_win(date(2026, 11, 1), date(2026, 11, 3)))
    assert t["reliable"] is True
    assert t["reason"] is None


def test_occupancy_trend_flags_days_before_first_record_instead_of_zero():
    start = datetime(2026, 11, 2, 1, 0, tzinfo=UTC)
    rows = [_occ(room="r1", cin=start, cout=None)]
    t = _svc()._occupancy_trend(rows, date(2026, 11, 1), date(2026, 11, 3), OP, 16, "day", **_win(date(2026, 11, 1), date(2026, 11, 3)))
    assert t["reliable"] is False
    assert "not shown as zero" in t["reason"]


def test_weekly_granularity_buckets_by_monday():
    rows = []
    t = _svc()._occupancy_trend(rows, date(2026, 11, 2), date(2026, 11, 15), OP, 16, "week", **_win(date(2026, 11, 2), date(2026, 11, 15)))
    assert [p["bucket"] for p in t["points"]] == ["2026-11-02", "2026-11-09"]


# ---- attendance rules --------------------------------------------------------

def test_attendance_pct_requires_absence_records():
    rows = [SimpleNamespace(attendance_date="2026-11-18", status="present", employee_id="e1")]
    a = _svc()._attendance_period(rows, {"e1"}, date(2026, 11, 13), date(2026, 11, 19))
    assert a["attendance_pct"] is None  # present-only data cannot yield a rate
    assert a["late_arrivals"] is None
    assert "Shift" in a["late_reason"]


def test_attendance_pct_computed_when_absences_recorded():
    rows = [
        SimpleNamespace(attendance_date="2026-11-18", status="present", employee_id="e1"),
        SimpleNamespace(attendance_date="2026-11-18", status="present", employee_id="e2"),
        SimpleNamespace(attendance_date="2026-11-18", status="absent", employee_id="e3"),
    ]
    a = _svc()._attendance_period(rows, {"e1", "e2", "e3"}, date(2026, 11, 13), date(2026, 11, 19))
    assert a["attendance_pct"] == pytest.approx(66.7, abs=0.1)


def test_attendance_ignores_inactive_employee_rows():
    rows = [SimpleNamespace(attendance_date="2026-11-18", status="present", employee_id="gone")]
    a = _svc()._attendance_period(rows, {"e1"}, date(2026, 11, 13), date(2026, 11, 19))
    assert a["status_counts"] == {}


# ---- data quality policy ----------------------------------------------------

def _dq(**kw):
    base = dict(trend={"reliable": True, "reason": None, "first_record_date": "2026-10-01"},
                att_dates_total=9, att_rows_total=11, state_mismatch=0, cleaning_unverified=0,
                aband_other=0, last_ticket=datetime(2026, 11, 19, tzinfo=UTC), n_rooms=16,
                active_n=10, aband_total=0)
    base.update(kw)
    return {d["key"]: d for d in _svc()._data_quality(**base)}


def test_unverified_cleaning_is_flagged_not_hidden():
    dq = _dq(cleaning_unverified=15)
    assert dq["cleaning_state"]["state"] == "unverified"
    assert "15 of 16" in dq["cleaning_state"]["detail"]


def test_attendance_marked_insufficient_under_threshold():
    dq = _dq(att_rows_total=11, att_dates_total=9)
    assert dq["attendance"]["state"] == "insufficient"


def test_no_tickets_is_no_records_not_zero_problems():
    dq = _dq(last_ticket=None)
    assert dq["maintenance"]["state"] == "no_records"


def test_stale_tickets_are_limited_with_caveat():
    dq = _dq(last_ticket=datetime(2026, 10, 26, tzinfo=UTC))
    assert dq["maintenance"]["state"] == "limited"
    assert "not evidence" in dq["maintenance"]["detail"]


def test_small_team_marked_limited():
    dq = _dq(active_n=1)
    assert dq["workforce"]["state"] == "limited"


# ---- classification & helpers ---------------------------------------------------

def test_expiry_reasons_match_the_existing_auto_abandon_set_plus_system_resets():
    assert {"SYSTEM_DAILY_ROLLOVER", "NEXT_SCHEDULED_OCCURRENCE"} <= set(EXPIRY_REASONS)
    assert "MIDNIGHT_EXPIRY" in EXPIRY_REASONS and "FRESH_DAY_RESET" in EXPIRY_REASONS
    assert "MANUAL" not in EXPIRY_REASONS


def test_median_minutes_ignores_incomplete_pairs():
    a = datetime(2026, 11, 19, 10, 0, tzinfo=UTC)
    pairs = [(a, datetime(2026, 11, 19, 11, 0, tzinfo=UTC)), (a, None), (None, a)]
    assert _median_minutes(pairs) == 60.0
    assert _median_minutes([(None, None)]) is None


# ---- dorm and bed breakdown (ledger-based) ----------------------------------

def test_dorm_breakdown_uses_ledger_not_bed_state():
    from app.services.dashboard import dorm_breakdown
    dorms = [
        SimpleNamespace(id="d1", name="Dorm A", dorm_type="Mixed", status="available"),
        SimpleNamespace(id="d2", name="Dorm B", dorm_type="Female", status="cleaning"),
    ]
    beds = [
        SimpleNamespace(id="b1", dorm_id="d1", status="available"),   # ledger says occupied
        SimpleNamespace(id="b2", dorm_id="d1", status="occupied"),    # state says occupied, ledger no
        SimpleNamespace(id="b3", dorm_id="d2", status="cleaning"),    # no open cleaning task
    ]
    out = dorm_breakdown(dorms, beds, open_beds={"b1"}, verified_dorm_cleaning=set())
    assert out["beds"]["occupied"] == 1          # only the ledger row counts
    assert out["beds"]["cleaning_unverified"] == 1
    assert out["dorms"]["occupied"] == 1         # Dorm A has one occupied bed
    assert out["dorms"]["cleaning_unverified"] == 1
    by = {r["dorm_name"]: r for r in out["by_dorm"]}
    assert by["Dorm A"]["beds_occupied"] == 1 and by["Dorm A"]["beds_total"] == 2
    assert out["by_dorm_type"][0]["type"] in {"Mixed", "Female"}


def test_dorm_breakdown_handles_empty_property():
    from app.services.dashboard import dorm_breakdown
    out = dorm_breakdown([], [], set(), set())
    assert out["beds"]["total"] == 0 and out["beds"]["occupancy_pct"] is None
    assert out["dorms"]["occupancy_pct"] is None
    assert out["by_dorm"] == []
