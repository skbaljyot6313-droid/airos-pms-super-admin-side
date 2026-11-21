"""Salary slip PDF — renders from the frozen snapshot."""
from app.services.payroll_slip import render_slip


def _snapshot():
    return {
        "earnings": [{"code": "basic", "label": "Basic salary", "amount": "30000.00"}],
        "deductions": [{"code": "absence", "label": "Unpaid absence", "amount": "1000.00"}],
        "gross": "30000.00", "total_deductions": "1000.00", "net": "29000.00",
        "metrics": {"present_days": 25, "absent_days": 1, "worked_hours": "200.0"},
        "notes": ["1 unpaid day deducted"],
    }


def test_slip_is_a_valid_pdf_with_content():
    pdf = render_slip(company_name="Acme", employee_name="Worker", employee_uid="u1",
                      department="Housekeeping", designation="Housekeeper", period="2026-01",
                      line_snapshot=_snapshot(), line_status="approved", payment_date=None,
                      adjustments=[], net="29000.00")
    assert pdf.startswith(b"%PDF-")
    assert pdf.rstrip().endswith(b"%%EOF")
    assert len(pdf) > 1000


def test_slip_renders_without_optional_fields():
    pdf = render_slip(company_name="Acme", employee_name="Worker", employee_uid="u1",
                      department=None, designation=None, period="2026-01",
                      line_snapshot={"earnings": [], "deductions": [], "gross": "0",
                                     "total_deductions": "0", "net": "0"},
                      line_status="calculated", payment_date=None, adjustments=[], net="0")
    assert pdf.startswith(b"%PDF-")
