"""EmployeeRequestService — the Super Admin approval workflow.

Every read and decision is scoped to the CALLER's ``company_id`` — an
admin of organization A can never see or decide a request that belongs
to organization B (there is no endpoint that takes a company id at all).

Approval is claim-then-create inside ONE transaction:

1. A conditional UPDATE flips ``status`` pending→approved ONLY where the
   row is still pending. Two concurrent approvals — the loser's UPDATE
   blocks on the row lock, then matches zero rows and gets a 409.
2. The winner calls ``EmployeeService.create_employee`` with the
   request's stored Argon2id hash. That method commits — atomically
   persisting claim + employee + user + allocation + audit in one shot.
   If anything fails, the whole thing (including the claim) rolls back
   and the request stays pending.
3. Result columns (created_employee_id, created_user_id, property_id),
   a best-effort SalaryStructure, the approval notification and the
   audit event land in a second commit. A failure there can never
   resurrect a half-created account — step 2 is already durable.

Rejection is the same conditional UPDATE to ``rejected`` — no account is
created, the row is kept forever as the audit record, and the applicant
sees the decision at their next login attempt (rejected applicants have
no device registered, so no push is possible).
"""

import uuid
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from fastapi import status
from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.centrifugo import prop_channel, queue_event
from app.core.exceptions import AppError
from app.models.notifications import Notification
from app.models.registration_request import EmployeeRegistrationRequest
from app.models.user import User, UserRole
from app.schemas.employee_requests import (
    EmployeeRequestApproveIn,
    EmployeeRequestOut,
)
from app.schemas.structure import EmployeeCreateRequest
from app.services import payroll as payroll_svc
from app.services.audit import AuditService
from app.services.employee import EmployeeService
from app.services.structure import NotFoundErr, ValidationErr


class RequestAlreadyDecided(AppError):
    status_code = status.HTTP_409_CONFLICT
    code = "REQUEST_ALREADY_DECIDED"
    message = "This registration request has already been decided."


def _out(req: EmployeeRegistrationRequest) -> EmployeeRequestOut:
    return EmployeeRequestOut(
        request_uid=str(req.id),
        status=req.status,
        full_name=req.full_name,
        username=req.username,
        email=req.email,
        phone=req.phone,
        date_of_birth=req.date_of_birth,
        gender=req.gender,
        designation=req.designation,
        department=req.department,
        employment_type=req.employment_type,
        joining_date=req.joining_date,
        reporting_manager=req.reporting_manager,
        salary=req.salary,
        salary_frequency=req.salary_frequency,
        reviewed_by_name=req.reviewed_by_name,
        reviewed_at=req.reviewed_at,
        rejection_reason=req.rejection_reason,
        created_employee_uid=(
            str(req.created_employee_id) if req.created_employee_id else None
        ),
        property_uid=str(req.property_id) if req.property_id else None,
        created_at=req.created_at,
    )


class EmployeeRequestService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.audit = AuditService(session)

    # ---------------------------------------------------------------
    # Reads
    # ---------------------------------------------------------------
    async def list_requests(
        self,
        user: User,
        *,
        status_filter: str | None = None,
        search: str | None = None,
        property_id: uuid.UUID | None = None,
        page: int = 1,
        limit: int = 25,
    ) -> tuple[list[EmployeeRequestOut], int]:
        # Property managers are pinned to their own property — the
        # caller-supplied filter can never widen their scope. A manager
        # with no property sees nothing (fail closed).
        if user.role != UserRole.SUPER_ADMIN:
            property_id = user.property_id
            if property_id is None:
                return [], 0
        q = select(EmployeeRegistrationRequest).where(
            EmployeeRegistrationRequest.company_id == user.company_id
        )
        if property_id is not None:
            q = q.where(
                EmployeeRegistrationRequest.property_id == property_id
            )
        if status_filter in ("pending", "approved", "rejected"):
            q = q.where(
                EmployeeRegistrationRequest.status == status_filter
            )
        if search:
            like = f"%{search.strip().lower()}%"
            q = q.where(
                or_(
                    func.lower(EmployeeRegistrationRequest.full_name).like(
                        like
                    ),
                    func.lower(EmployeeRegistrationRequest.username).like(
                        like
                    ),
                    func.lower(EmployeeRegistrationRequest.email).like(
                        like
                    ),
                )
            )
        total = await self.session.scalar(
            select(func.count()).select_from(q.subquery())
        )
        res = await self.session.execute(
            q.order_by(EmployeeRegistrationRequest.created_at.desc())
            .offset((page - 1) * limit)
            .limit(limit)
        )
        return [_out(r) for r in res.scalars()], total or 0

    async def pending_count(self, user: User) -> int:
        q = select(func.count(EmployeeRegistrationRequest.id)).where(
            EmployeeRegistrationRequest.company_id == user.company_id,
            EmployeeRegistrationRequest.status == "pending",
        )
        if user.role != UserRole.SUPER_ADMIN:
            if user.property_id is None:
                return 0
            q = q.where(
                EmployeeRegistrationRequest.property_id
                == user.property_id
            )
        res = await self.session.scalar(q)
        return res or 0

    async def get_request(
        self, user: User, request_id: uuid.UUID
    ) -> EmployeeRegistrationRequest:
        res = await self.session.execute(
            select(EmployeeRegistrationRequest).where(
                EmployeeRegistrationRequest.id == request_id,
                EmployeeRegistrationRequest.company_id == user.company_id,
            )
        )
        req = res.scalar_one_or_none()
        if req is None or (
            user.role != UserRole.SUPER_ADMIN
            and req.property_id != user.property_id
        ):
            # Same 404 whether the request doesn't exist, belongs to
            # another organization, or sits outside the caller's
            # property — no cross-tenant existence leak.
            raise NotFoundErr()
        return req

    # ---------------------------------------------------------------
    # Decision — claim (conditional UPDATE) then act
    # ---------------------------------------------------------------
    async def _claim(
        self, user: User, request_id: uuid.UUID, new_status: str
    ) -> None:
        conditions = [
            EmployeeRegistrationRequest.id == request_id,
            EmployeeRegistrationRequest.company_id == user.company_id,
            EmployeeRegistrationRequest.status == "pending",
        ]
        if user.role != UserRole.SUPER_ADMIN:
            # The property pin is part of the atomic claim — a manager
            # can never flip a request that belongs to another property,
            # not even by racing a direct request_id.
            if user.property_id is None:
                raise NotFoundErr()
            conditions.append(
                EmployeeRegistrationRequest.property_id
                == user.property_id
            )
        res = await self.session.execute(
            update(EmployeeRegistrationRequest)
            .where(*conditions)
            .values(
                status=new_status,
                reviewed_by_id=user.id,
                reviewed_by_name=user.name,
                reviewed_at=func.now(),
            )
        )
        if res.rowcount == 0:
            await self.get_request(user, request_id)  # 404 if not ours
            raise RequestAlreadyDecided()

    async def approve(
        self,
        user: User,
        request_id: uuid.UUID,
        payload: EmployeeRequestApproveIn,
    ) -> tuple[EmployeeRegistrationRequest, uuid.UUID, uuid.UUID]:
        await self._claim(user, request_id, "approved")
        req = await self.get_request(user, request_id)

        # The registration code already resolved the property at
        # submission — an explicit payload override still wins (the
        # admin owns the decision), but the request's own property is
        # the default. _property_for_write enforces company scope either
        # way, so a foreign property can never sneak in.
        property_uid = payload.property_uid or req.property_id
        if property_uid is None:
            await self.session.rollback()
            raise ValidationErr(
                "Choose a property to place this employee in.",
                field="property_uid",
            )

        # Reuse the existing employee-creation service verbatim — the
        # only difference is the password hash, which was Argon2id'd at
        # submission time and moves onto the users row as-is.
        create_req = EmployeeCreateRequest(
            property_uid=property_uid,
            name=req.full_name,
            email=req.email,
            password="approval-hash-override",  # never hashed — see kwarg
            job_title=payload.job_title or req.designation or "Employee",
            department=payload.department or req.department,
            phone=req.phone,
            username=req.username,
            zone_uid=payload.zone_uid,
            salary=payload.salary or req.salary,
            shift=payload.shift,
            start_date=payload.start_date or req.joining_date,
        )
        try:
            emp = await EmployeeService(self.session).create_employee(
                user, create_req, password_hash=req.password_hash
            )
        except Exception:
            # Roll back the claim too — the request stays pending so the
            # admin can retry after fixing the cause (e.g. bad property).
            await self.session.rollback()
            raise

        user_id = await self.session.scalar(
            select(User.id).where(User.employee_id == emp.id)
        )

        # property_id was already set at submission — refresh it in case
        # the admin overrode the placement.
        req.property_id = emp.property_id
        req.created_employee_id = emp.id
        req.created_user_id = user_id
        req.rejection_reason = None

        # Best-effort salary structure — the registration form collects a
        # free-text salary; if it parses to a positive amount, seed the
        # payroll history so the employee's first payroll period isn't
        # blank. A finalized-period conflict or unparseable amount never
        # blocks the approval — the admin can add a structure later.
        salary_amount = self._parse_salary(payload.salary or req.salary)
        if salary_amount is not None:
            try:
                effective = (
                    date.fromisoformat(payload.start_date or req.joining_date)
                    if (payload.start_date or req.joining_date)
                    else date.today()
                )
                await payroll_svc.create_structure(
                    self.session,
                    employee=emp,
                    calc_method=req.salary_frequency or "monthly",
                    basic=salary_amount,
                    hra=0,
                    allowances=[],
                    incentive=0,
                    overtime_rate=0,
                    deductions=[],
                    effective_from=effective,
                    actor_id=user.id,
                    actor_name=user.name,
                )
            except (AppError, ValueError, TypeError):
                pass

        # Approval notification — lands on the shared outbox; the EB push
        # sweep delivers it. Queued inside this transaction so a dispatch
        # failure can never roll back the created account.
        self.session.add(Notification(
            property_id=emp.property_id,
            employee_id=emp.id,
            employee_name=emp.name,
            type="registration_approved",
            title="Registration approved",
            body=(
                "Your registration has been approved. You can now sign "
                "in to Airco PMS Staff with your username and password."
            ),
        ))

        self.audit.record(
            user,
            entity_type="employee_registration",
            entity_id=req.id,
            entity_name=req.full_name,
            action="employee_request_approved",
            property_id=emp.property_id,
            detail={
                "employee_uid": str(emp.id),
                "user_uid": str(user_id) if user_id else None,
                "department": emp.department,
            },
        )
        queue_event(
            self.session,
            prop_channel(emp.property_id, "employees"),
            "employee_request.decided",
            {"request_uid": str(req.id), "status": "approved"},
        )
        await self.session.commit()
        await self.session.refresh(req)
        return req, emp.id, user_id

    async def reject(
        self, user: User, request_id: uuid.UUID, reason: str | None
    ) -> EmployeeRegistrationRequest:
        await self._claim(user, request_id, "rejected")
        req = await self.get_request(user, request_id)
        req.rejection_reason = reason
        self.audit.record(
            user,
            entity_type="employee_registration",
            entity_id=req.id,
            entity_name=req.full_name,
            action="employee_request_rejected",
            property_id=None,
            detail={"reason": reason} if reason else {},
        )
        await self.session.commit()
        await self.session.refresh(req)
        return req

    @staticmethod
    def _parse_salary(raw: str | None) -> Decimal | None:
        if not raw:
            return None
        # Tolerate "25,000", "25000/mo", currency symbols — keep digits,
        # dot, minus; bail on anything non-numeric after cleaning.
        cleaned = "".join(
            ch for ch in raw if ch.isdigit() or ch in ".,-"
        ).replace(",", "")
        try:
            amount = Decimal(cleaned)
        except InvalidOperation:
            return None
        return amount if amount > 0 else None
