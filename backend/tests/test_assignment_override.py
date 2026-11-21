"""Emergency assignment override — authorization, reason rule, the single
on-duty bypass, and the audit record."""
import uuid
from types import SimpleNamespace

import pytest

from app.dependencies.auth import Forbidden
from app.models.audit import AuditEvent
from app.models.employee import Employee
from app.models.user import UserRole
from app.services.assignment_override import audit_override, authorize_override
from app.services.structure import ValidationErr
from app.services.work_allocation import WorkAllocationService

PID = uuid.uuid4()
REASON = "Guest emergency — cover the floor until the on-duty colleague arrives"


def _user(role):
    return SimpleNamespace(id=uuid.uuid4(), name="Admin", role=role)


def _emp(status="Active", leave=False):
    return Employee(
        id=uuid.uuid4(), company_id=uuid.uuid4(), property_id=PID,
        name="Worker", email="w@acme.test", status=status, leave_status=leave,
        department="Housekeeping",
    )


class _Result:
    def __init__(self, value):
        self.value = value

    def scalar_one_or_none(self):
        return self.value


class _DutySession:
    """First execute → the employee row; later executes → the day-start;
    scalar → the on-duty EXISTS result."""

    def __init__(self, employee, on_duty):
        self.employee = employee
        self.on_duty = on_duty
        self.calls = 0

    async def execute(self, _query):
        self.calls += 1
        return _Result(self.employee if self.calls == 1 else "06:00")

    async def scalar(self, _query):
        return self.on_duty


def test_no_override_requested_is_a_noop_for_any_role():
    assert authorize_override(_user(UserRole.PROPERTY_MANAGER),
                              emergency_override=False, reason=None) is None


def test_property_manager_cannot_override():
    with pytest.raises(Forbidden):
        authorize_override(_user(UserRole.PROPERTY_MANAGER),
                           emergency_override=True, reason=REASON)


def test_super_admin_override_requires_a_reason():
    with pytest.raises(ValidationErr, match="reason"):
        authorize_override(_user(UserRole.SUPER_ADMIN),
                           emergency_override=True, reason="   short ")
    with pytest.raises(ValidationErr):
        authorize_override(_user(UserRole.SUPER_ADMIN),
                           emergency_override=True, reason=None)


def test_super_admin_override_returns_trimmed_reason():
    assert authorize_override(_user(UserRole.SUPER_ADMIN), emergency_override=True,
                              reason=f"  {REASON}  ") == REASON


async def test_override_bypasses_only_the_on_duty_gate():
    emp = _emp()
    svc = WorkAllocationService(_DutySession(emp, on_duty=False))
    assert await svc.employee_for_assignment(emp.id, PID, emergency_override=True) is emp


async def test_override_still_refuses_inactive_or_on_leave_employees():
    for emp in (_emp(status="Deactivated"), _emp(leave=True)):
        svc = WorkAllocationService(_DutySession(emp, on_duty=False))
        with pytest.raises(ValidationErr, match="not active"):
            await svc.employee_for_assignment(emp.id, PID, emergency_override=True)


async def test_without_override_off_duty_employee_is_refused():
    emp = _emp()
    svc = WorkAllocationService(_DutySession(emp, on_duty=False))
    with pytest.raises(ValidationErr, match="not on duty"):
        await svc.employee_for_assignment(emp.id, PID)


def test_audit_event_records_admin_employee_reason_and_bypass():
    added = []

    class _Session:
        def add(self, obj):
            added.append(obj)

    admin = _user(UserRole.SUPER_ADMIN)
    emp = _emp()
    audit_override(_Session(), admin, property_id=PID, entity_type="task",
                   entity_id=uuid.uuid4(), entity_name="T-1", employee_id=emp.id,
                   employee_name=emp.name, previous_employee_name="Prev", reason=REASON)
    (event,) = added
    assert isinstance(event, AuditEvent)
    assert event.action == "emergency_assignment_override"
    assert event.actor_user_id == admin.id and event.actor_name == "Admin"
    assert event.detail["reason"] == REASON
    assert event.detail["employee_uid"] == str(emp.id)
    assert event.detail["previous_employee_name"] == "Prev"
    assert event.detail["bypassed"] == "attendance_availability"
