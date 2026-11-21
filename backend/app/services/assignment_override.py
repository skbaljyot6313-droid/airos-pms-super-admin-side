"""Emergency assignment override — the one way to hand work to an employee who
is not on duty.

Restricted to SUPER_ADMIN (property managers cannot override), requires a
written reason, and is audited. It bypasses ONLY the attendance availability
gate. The active-employee, leave and department checks still apply, the
employee's attendance state is never written, and the override does not make
the employee eligible for automatic allocation — the auto pool still requires
an open workday.
"""

from app.dependencies.auth import Forbidden
from app.models.audit import AuditEvent
from app.models.user import User, UserRole
from app.services.structure import ValidationErr

OVERRIDE_ROLES = (UserRole.SUPER_ADMIN,)
OVERRIDE_ACTION = "emergency_assignment_override"
MIN_REASON_LENGTH = 10


def authorize_override(user: User, *, emergency_override: bool, reason: str | None) -> str | None:
    """Returns the cleaned reason when an override is requested, else None."""
    if not emergency_override:
        return None
    if user.role not in OVERRIDE_ROLES:
        raise Forbidden("Only a super admin can make an emergency assignment override.")
    text = (reason or "").strip()
    if len(text) < MIN_REASON_LENGTH:
        raise ValidationErr(
            f"An emergency override needs a reason of at least {MIN_REASON_LENGTH} characters.",
            field="override_reason",
        )
    return text


def audit_override(session, user: User, *, property_id, entity_type: str, entity_id,
                   entity_name: str | None, employee_id, employee_name: str | None,
                   previous_employee_name: str | None, reason: str) -> None:
    session.add(AuditEvent(
        property_id=property_id, actor_user_id=user.id, actor_name=user.name,
        entity_type=entity_type, entity_id=entity_id, entity_name=entity_name,
        action=OVERRIDE_ACTION,
        detail={
            "employee_uid": str(employee_id),
            "employee_name": employee_name,
            "previous_employee_name": previous_employee_name,
            "reason": reason,
            "bypassed": "attendance_availability",
        },
    ))
