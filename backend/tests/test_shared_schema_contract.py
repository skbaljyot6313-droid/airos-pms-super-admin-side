"""Shared-database boundary contract tests.

This backend shares one PostgreSQL database — and one alembic_version row —
with the Employee Backend. These tests pin the invariants that keep that
arrangement safe, without needing a live database:

* the migration chain stays a single linear head (never branches);
* the extended-coverage revision (secondary zone + property-wide flag) is
  mirrored and resolvable with the correct parentage;
* the ORM maps the coverage columns both sides agreed on;
* every shared table the Employee Backend reads/writes is present in this
  repo's metadata so SA-side queries can't drift from EB's schema.
"""
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory

from app.models import Base
from app.models.employee import Employee

_ALEMBIC_INI = Path(__file__).resolve().parents[1] / "alembic.ini"

# Revisions written by/for the shared boundary — if either repo drops or
# reparents one, the other side's boot check will (correctly) refuse to run.
_SHARED_REVISIONS = {
    "y5d8f2a6c4e1": "x8b3d6f1a4c7",  # employee extended coverage
    "b4e9f2a7c3d6": "y5d8f2a6c4e1",  # employee multi-area coverage
    "u7e1f5a9d3c6": None,  # EB-owned tables (parentage asserted loosely)
}

# Tables the Employee Backend owns or shares — SA must keep mapping them so
# cross-service reads (attendance, notifications, shifts) stay consistent.
_SHARED_TABLES = {
    "attendance_days", "attendance_requests", "attendance_breaks",
    "notifications", "shifts", "employee_shift_assignments",
    "employees", "users", "occupancies", "tasks", "maintenance_tickets",
    "refresh_tokens", "cameras", "camera_stream_sessions", "employee_area_assignments",
}


def _scripts() -> ScriptDirectory:
    return ScriptDirectory.from_config(Config(str(_ALEMBIC_INI)))


def test_chain_has_single_head():
    """ONE linear chain — the shared alembic_version row must never branch."""
    assert len(_scripts().get_heads()) == 1


def test_shared_revisions_resolvable():
    scripts = _scripts()
    for revision, parent in _SHARED_REVISIONS.items():
        rev = scripts.get_revision(revision)
        assert rev is not None, f"missing shared revision {revision}"
        if parent is not None:
            assert rev.down_revision == parent


def test_extended_coverage_columns_mapped():
    """SA writes these columns; both sides must agree they exist."""
    cols = {c.name for c in Employee.__table__.columns}
    assert {"secondary_zone_id", "covers_property"} <= cols
    assert Employee.__table__.c.covers_property.nullable is False


def test_shared_tables_present_in_metadata():
    tables = set(Base.metadata.tables)
    missing = _SHARED_TABLES - tables
    assert not missing, f"shared tables unmapped on SA side: {missing}"
