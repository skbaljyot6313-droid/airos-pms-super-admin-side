"""EmployeeService — staff records, login credentials, zone allocation."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core import auth_cache
from app.core.centrifugo import prop_channel, queue_event
from app.core.security import hash_password, slugify_username
from app.models.allocation import AllocationEvent
from app.models.employee import (
    EMPLOYEE_STATUS_ACTIVE,
    EMPLOYEE_STATUS_DEACTIVATED,
    Employee,
    EmployeeAreaAssignment,
    employee_is_assignable,
)
from app.models.maintenance import MaintenanceTicket, MaintenanceTicketEvent
from app.models.property import Property
from app.models.structure import Zone
from app.models.task import Task, TaskHistoryEvent
from app.models.user import User, UserRole
from app.models.work_allocation import WorkAllocationBatch
from app.repositories.user import UserRepository
from app.schemas.structure import (
    EmployeeCreateRequest,
    EmployeeUpdateRequest,
)
from app.services.audit import AuditService
from app.services.auth import EmailAlreadyExists, UsernameTaken
from app.services.structure import NotFoundErr, StructureService, ValidationErr

AVATAR_COLORS = ["#386641", "#6A994E", "#A7C957", "#BC4749", "#8C867C", "#4A6FA5"]

# "leave this coverage slot unchanged" — distinct from an explicit None
# ("clear it"). Used by assign() so dedicated calls (e.g. secondary-zone
# only) don't clobber unrelated coverage.
_UNSET = object()


class EmployeeService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.users = UserRepository(session)
        self.structure = StructureService(session)
        self.audit = AuditService(session)

    def _emit_employee(self, emp: Employee, event_type: str) -> None:
        """Queue a minimal employee event — published post-commit to the
        property's employees topic (attendance channel subscribers care
        about roster changes like deactivation too)."""
        queue_event(
            self.session,
            prop_channel(emp.property_id, "employees"),
            event_type,
            {
                "employee_uid": str(emp.id),
                "property_uid": str(emp.property_id),
                "status": emp.status,
            },
        )

    async def _get_employee(self, user: User, employee_id: uuid.UUID) -> Employee:
        res = await self.session.execute(
            select(Employee)
            .options(selectinload(Employee.area_assignments))
            .where(Employee.id == employee_id)
        )
        emp = res.scalar_one_or_none()
        if emp is None:
            raise NotFoundErr()
        await self.structure._property_for_write(user, emp.property_id)
        return emp

    async def _zone_or_none(self, zone_id, property_id):
        if zone_id is None:
            return None
        res = await self.session.execute(
            select(Zone).where(Zone.id == zone_id, Zone.property_id == property_id)
        )
        if res.scalar_one_or_none() is None:
            raise ValidationErr("Zone not found in this property.", field="zone_uid")
        return zone_id

    async def _area_or_none(self, area_id, property_id):
        if area_id is None:
            return None
        from app.models.structure import Area
        res = await self.session.execute(
            select(Area).where(Area.id == area_id, Area.property_id == property_id)
        )
        if res.scalar_one_or_none() is None:
            raise ValidationErr("Area not found in this property.", field="area_uid")
        return area_id

    async def _dept_id_or_none(
        self, property_id: uuid.UUID, name: str | None
    ) -> uuid.UUID | None:
        """Link the legacy free-text `department` to a managed departments
        row when one exists with that name (case-insensitive)."""
        if not name:
            return None
        from app.models.department import Department

        res = await self.session.execute(
            select(Department.id).where(
                Department.property_id == property_id,
                func.lower(Department.name) == name.strip().lower(),
            )
        )
        return res.scalar_one_or_none()

    async def _unique_username(self, seed: str) -> str:
        base = slugify_username(seed)
        candidate, n = base, 1
        while await self.users.username_exists(candidate):
            n += 1
            candidate = f"{base}.{n}"
        return candidate

    async def create_employee(self, user: User, payload: EmployeeCreateRequest) -> Employee:
        prop = await self.structure._property_for_write(user, payload.property_uid)
        zone_id = await self._zone_or_none(payload.zone_uid, prop.id)

        email = payload.email.strip().lower()
        if await self.users.get_by_email(email):
            raise EmailAlreadyExists(field="email")
        if payload.username:
            username = payload.username.strip().lower()
            if await self.users.username_exists(username):
                raise UsernameTaken(field="username")
        else:
            seed = payload.name.strip() or email.split("@")[0]
            username = await self._unique_username(seed)

        res = await self.session.execute(select(func.count(Employee.id)))
        avatar = AVATAR_COLORS[(res.scalar() or 0) % len(AVATAR_COLORS)]

        try:
            emp = Employee(
                company_id=prop.company_id,
                property_id=prop.id,
                zone_id=zone_id,
                name=payload.name.strip(),
                email=email,
                phone=payload.phone,
                username=username,
                job_title=payload.job_title.strip(),
                department=payload.department,
                department_id=(
                    await self._dept_id_or_none(prop.id, payload.department)
                ),
                salary=payload.salary,
                shift=payload.shift,
                start_date=payload.start_date,
                avatar_color=avatar,
                status="Active",
            )
            self.session.add(emp)
            await self.session.flush()
            # mark the collection loaded-empty so employee_out never
            # triggers a lazy emit on a brand-new row.
            emp.area_assignments = []

            await self.users.create(
                company_id=prop.company_id,
                name=emp.name,
                email=email,
                username=username,
                password_hash=hash_password(payload.password),
                phone_number=payload.phone,
                role=UserRole.EMPLOYEE,
                property_id=prop.id,
                employee_id=emp.id,
                zone_id=zone_id,
                job_title=emp.job_title,
            )
            if zone_id:
                self.session.add(AllocationEvent(
                    entity_type="employee", entity_id=emp.id, property_id=prop.id,
                    to_zone_id=zone_id, actor_user_id=user.id, actor_name=user.name,
                ))
            self.audit.record(
                user, entity_type="employee", entity_id=emp.id,
                entity_name=emp.name, action="employee_created",
                property_id=prop.id,
                detail={"department": emp.department, "job_title": emp.job_title},
            )
            self._emit_employee(emp, "employee.created")
            await self.session.commit()
            return emp
        except IntegrityError as exc:
            await self.session.rollback()
            msg = str(exc.orig).lower() if exc.orig else ""
            if "username" in msg:
                raise UsernameTaken(field="username") from exc
            raise EmailAlreadyExists(field="email") from exc

    async def update_employee(
        self, user: User, employee_id: uuid.UUID, payload: EmployeeUpdateRequest
    ) -> Employee:
        emp = await self._get_employee(user, employee_id)
        data = payload.model_dump(exclude_unset=True)
        if "status" in data:
            raise ValidationErr(
                "Use the deactivate or reactivate endpoint to change staff status.",
                field="status",
            )
        if "zone_uid" in data:
            await self.assign_zone(user, employee_id, data.pop("zone_uid"))
            await self.session.refresh(emp)
        if "email" in data and data["email"]:
            data["email"] = data["email"].strip().lower()
            existing = await self.users.get_by_email(data["email"])
            if existing and existing.employee_id != emp.id:
                raise EmailAlreadyExists(field="email")
        for k, v in data.items():
            setattr(emp, k, v)
        if "department" in data:
            emp.department_id = await self._dept_id_or_none(
                emp.property_id, emp.department
            )
        self.audit.record(
            user, entity_type="employee", entity_id=emp.id,
            entity_name=emp.name, action="employee_updated",
            property_id=emp.property_id,
            detail={"fields": sorted(data)},
        )
        self._emit_employee(emp, "employee.updated")
        await self.session.commit()
        return emp

    async def assign_zone(
        self, user: User, employee_id: uuid.UUID, zone_uid: uuid.UUID | None
    ) -> Employee:
        return await self.assign(user, employee_id, zone_uid=zone_uid)

    async def _coverage_zone(
        self, zone_uid, property_id, *, field: str, exclude: uuid.UUID | None = None
    ) -> uuid.UUID:
        zone_id = await self._zone_or_none(zone_uid, property_id)
        if exclude is not None and zone_id == exclude:
            raise ValidationErr(
                "That zone is already this employee's primary zone.",
                field=field,
            )
        return zone_id

    async def assign(
        self, user: User, employee_id: uuid.UUID, *,
        zone_uid=_UNSET,
        area_uid=_UNSET,
        secondary_zone_uid=_UNSET,
        property_wide: bool | None = None,
    ) -> Employee:
        """Assign coverage: named zones (primary ± one secondary), whole
        areas (primary ``area_id`` + extra join rows), or the whole
        property — in any additive combination.

        Each argument is an independent directive: ``_UNSET`` leaves that
        coverage mode alone, an explicit ``None`` clears only that mode.
        Zones and areas COEXIST — assigning a zone no longer wipes area
        coverage and vice-versa. An explicit area directive is replace
        semantics for the area SET (the POST /areas endpoint is the
        append path). Setting any coverage narrows ``covers_property``;
        ``property_wide=True`` is the one exclusive directive — it clears
        every other mode. To fully unallocate send
        ``zone_uid=None, area_uid=None, property_wide=False``."""
        emp = await self._get_employee(user, employee_id)
        assigning = (
            property_wide is True
            or (area_uid is not _UNSET and area_uid is not None)
            or (zone_uid is not _UNSET and zone_uid is not None)
            or (secondary_zone_uid is not _UNSET and secondary_zone_uid is not None)
        )
        if assigning and not employee_is_assignable(emp):
            raise ValidationErr(
                "Inactive or deactivated staff cannot be assigned coverage.",
                field="employee_uid",
            )

        zone_id, secondary_id, area_id, covers = (
            emp.zone_id, emp.secondary_zone_id, emp.area_id, emp.covers_property,
        )
        wipe_extras = False
        if property_wide is True:
            zone_id = secondary_id = area_id = None
            covers = True
            wipe_extras = True
        else:
            if property_wide is False:
                covers = False
            if zone_uid is not _UNSET:
                if zone_uid is None:
                    # Clear the zone PAIR only — area coverage survives.
                    zone_id = secondary_id = None
                else:
                    covers = False
                    zone_id = await self._zone_or_none(zone_uid, emp.property_id)
                    secondary_id = (
                        await self._coverage_zone(
                            secondary_zone_uid, emp.property_id,
                            field="secondary_zone_uid", exclude=zone_id,
                        )
                        if secondary_zone_uid is not _UNSET and secondary_zone_uid is not None
                        else None
                    )
            elif secondary_zone_uid is not _UNSET:
                if secondary_zone_uid is None:
                    secondary_id = None
                else:
                    covers = False
                    if zone_id is None:
                        # No primary — the added zone becomes primary.
                        zone_id = await self._coverage_zone(
                            secondary_zone_uid, emp.property_id,
                            field="secondary_zone_uid",
                        )
                        secondary_id = None
                    else:
                        secondary_id = await self._coverage_zone(
                            secondary_zone_uid, emp.property_id,
                            field="secondary_zone_uid", exclude=zone_id,
                        )
            if area_uid is not _UNSET:
                # An explicit area directive is replace semantics for the
                # whole area set — extras are wiped even when the primary
                # value itself is unchanged.
                wipe_extras = True
                if area_uid is None:
                    area_id = None
                else:
                    covers = False
                    area_id = await self._area_or_none(area_uid, emp.property_id)

        extras_wiped = wipe_extras or area_id is None
        if (emp.zone_id == zone_id and emp.secondary_zone_id == secondary_id
                and emp.area_id == area_id and emp.covers_property == covers
                and not (extras_wiped and emp.area_assignments)):
            return emp
        from_zone, from_area = emp.zone_id, emp.area_id
        from_secondary, from_covers = emp.secondary_zone_id, emp.covers_property
        emp.zone_id, emp.secondary_zone_id = zone_id, secondary_id
        emp.area_id, emp.covers_property = area_id, covers
        if extras_wiped:
            await self.session.execute(
                delete(EmployeeAreaAssignment).where(
                    EmployeeAreaAssignment.employee_id == emp.id
                )
            )
            emp.area_assignments = []
        else:
            # The new primary may duplicate a stored extra — drop it.
            emp.area_assignments = [
                a for a in emp.area_assignments if a.area_id != area_id
            ]
            await self.session.execute(
                delete(EmployeeAreaAssignment).where(
                    EmployeeAreaAssignment.employee_id == emp.id,
                    EmployeeAreaAssignment.area_id == area_id,
                )
            )
        # keep the linked login account in sync (primary zone only)
        res = await self.session.execute(
            select(User).where(User.employee_id == emp.id)
        )
        for u in res.scalars():
            u.zone_id = zone_id
        self.session.add(AllocationEvent(
            entity_type="employee", entity_id=emp.id, property_id=emp.property_id,
            from_zone_id=from_zone, to_zone_id=zone_id,
            from_area_id=from_area, to_area_id=area_id,
            actor_user_id=user.id, actor_name=user.name,
        ))
        self.audit.record(
            user, entity_type="employee", entity_id=emp.id,
            entity_name=emp.name, action="employee_assignment_changed",
            property_id=emp.property_id,
            detail={
                "from_zone_id": str(from_zone) if from_zone else None,
                "to_zone_id": str(zone_id) if zone_id else None,
                "from_secondary_zone_id": str(from_secondary) if from_secondary else None,
                "to_secondary_zone_id": str(secondary_id) if secondary_id else None,
                "from_area_id": str(from_area) if from_area else None,
                "to_area_id": str(area_id) if area_id else None,
                "from_covers_property": from_covers,
                "to_covers_property": covers,
            },
        )
        self._emit_employee(emp, "employee.updated")
        await self.session.commit()
        return emp

    async def add_area(
        self, user: User, employee_id: uuid.UUID, area_uid: uuid.UUID
    ) -> Employee:
        """Add ANOTHER whole area to the employee's coverage.

        First area becomes the primary ``area_id``; subsequent ones append
        to ``employee_area_assignments``. Zone coverage coexists — named
        zones are kept, only ``covers_property`` narrows (adding a
        specific area to a whole-property employee is an explicit
        narrowing directive)."""
        emp = await self._get_employee(user, employee_id)
        if not employee_is_assignable(emp):
            raise ValidationErr(
                "Inactive or deactivated staff cannot be assigned coverage.",
                field="employee_uid",
            )
        from app.models.structure import Area
        res = await self.session.execute(
            select(Area).where(
                Area.id == area_uid, Area.property_id == emp.property_id
            )
        )
        if res.scalar_one_or_none() is None:
            raise ValidationErr("Area not found.", field="area_uid")
        covered = {a.area_id for a in emp.area_assignments}
        if emp.area_id:
            covered.add(emp.area_id)
        if area_uid in covered and not emp.covers_property:
            return emp

        from_area = emp.area_id
        from_covers = emp.covers_property
        emp.covers_property = False
        if emp.area_id is None:
            emp.area_id = area_uid
        elif area_uid not in covered:
            emp.area_assignments = [
                *emp.area_assignments,
                EmployeeAreaAssignment(employee_id=emp.id, area_id=area_uid),
            ]
        from_zone, from_secondary = emp.zone_id, emp.secondary_zone_id
        self.audit.record(
            user, entity_type="employee", entity_id=emp.id,
            entity_name=emp.name, action="employee_assignment_changed",
            property_id=emp.property_id,
            detail={
                "from_zone_id": str(from_zone) if from_zone else None,
                "from_secondary_zone_id": (
                    str(from_secondary) if from_secondary else None
                ),
                "from_area_id": str(from_area) if from_area else None,
                "added_area_id": str(area_uid),
                "area_ids": [
                    str(a) for a in
                    ({emp.area_id} | {x.area_id for x in emp.area_assignments})
                    if a
                ],
            },
        )
        self._emit_employee(emp, "employee.updated")
        await self.session.commit()
        return emp

    async def remove_area(
        self, user: User, employee_id: uuid.UUID, area_uid: uuid.UUID
    ) -> Employee:
        """Drop ONE area from coverage — extras survive (unlike a full
        unassign). Removing the primary promotes the oldest extra row."""
        emp = await self._get_employee(user, employee_id)
        covered = {a.area_id for a in emp.area_assignments}
        if emp.area_id:
            covered.add(emp.area_id)
        if area_uid not in covered:
            raise ValidationErr(
                "Employee is not allocated to that area.", field="area_uid"
            )
        extras = sorted(
            (a for a in emp.area_assignments if a.area_id != area_uid),
            key=lambda a: a.created_at,
        )
        if emp.area_id == area_uid:
            # Promote the oldest remaining extra to primary, if any.
            promote = extras.pop(0) if extras else None
            emp.area_id = promote.area_id if promote else None
        keep = {a.area_id for a in extras}
        await self.session.execute(
            delete(EmployeeAreaAssignment).where(
                EmployeeAreaAssignment.employee_id == emp.id,
                EmployeeAreaAssignment.area_id.notin_(keep),
            )
        )
        await self.session.refresh(emp, ["area_assignments"])
        self.audit.record(
            user, entity_type="employee", entity_id=emp.id,
            entity_name=emp.name, action="employee_assignment_changed",
            property_id=emp.property_id,
            detail={
                "removed_area_id": str(area_uid),
                "to_area_id": str(emp.area_id) if emp.area_id else None,
            },
        )
        self._emit_employee(emp, "employee.updated")
        await self.session.commit()
        return emp

    async def _linked_users(self, employee_id: uuid.UUID) -> list[User]:
        res = await self.session.execute(
            select(User).where(User.employee_id == employee_id)
        )
        return list(res.scalars())

    async def deactivate(self, user: User, employee_id: uuid.UUID) -> Employee:
        """Pause the staff account without deleting employment/work history.

        Deactivation also frees the zone/area assignment — allocation must
        stop routing work to deactivated staff — and disables linked logins."""
        emp = await self._get_employee(user, employee_id)
        if emp.status.lower() != "deactivated":
            from_zone, from_area = emp.zone_id, emp.area_id
            emp.status = EMPLOYEE_STATUS_DEACTIVATED
            emp.deactivated_at = datetime.now(UTC)
            emp.reactivated_at = None
            emp.zone_id = None
            emp.secondary_zone_id = None
            emp.area_id = None
            emp.covers_property = False
            await self.session.execute(
                delete(EmployeeAreaAssignment).where(
                    EmployeeAreaAssignment.employee_id == emp.id
                )
            )
            emp.area_assignments = []
            for linked in await self._linked_users(emp.id):
                linked.is_active = False
                linked.zone_id = None
                auth_cache.invalidate(linked.id)
            self.audit.record(
                user, entity_type="employee", entity_id=emp.id,
                entity_name=emp.name, action="employee_deactivated",
                property_id=emp.property_id,
            )
            if from_zone or from_area:
                self.session.add(AllocationEvent(
                    entity_type="employee", entity_id=emp.id,
                    property_id=emp.property_id,
                    from_zone_id=from_zone, to_zone_id=None,
                    from_area_id=from_area, to_area_id=None,
                    actor_user_id=user.id, actor_name=user.name,
                ))
            self._emit_employee(emp, "employee.deactivated")
            await self.session.commit()
        return emp

    async def reactivate(self, user: User, employee_id: uuid.UUID) -> Employee:
        """Restore eligibility without auto-restoring a zone or task."""
        emp = await self._get_employee(user, employee_id)
        if emp.status.lower() == "active" and not emp.leave_status:
            return emp
        from_zone, from_area = emp.zone_id, emp.area_id
        emp.status = EMPLOYEE_STATUS_ACTIVE
        emp.leave_status = False
        emp.reactivated_at = datetime.now(UTC)
        emp.zone_id = None
        emp.secondary_zone_id = None
        emp.area_id = None
        emp.covers_property = False
        for linked in await self._linked_users(emp.id):
            linked.is_active = True
            linked.zone_id = None
            auth_cache.invalidate(linked.id)
        self.audit.record(
            user, entity_type="employee", entity_id=emp.id,
            entity_name=emp.name, action="employee_activated",
            property_id=emp.property_id,
        )
        if from_zone or from_area:
            self.session.add(AllocationEvent(
                entity_type="employee", entity_id=emp.id, property_id=emp.property_id,
                from_zone_id=from_zone, from_area_id=from_area,
                to_zone_id=None, to_area_id=None,
                actor_user_id=user.id, actor_name=user.name,
            ))
        self._emit_employee(emp, "employee.updated")
        await self.session.commit()
        return emp

    async def delete_employee(self, user: User, employee_id: uuid.UUID) -> None:
        """Permanently delete the employee/login while preserving work history."""
        emp = await self._get_employee(user, employee_id)

        prop = await self.session.get(Property, emp.property_id)
        if prop and prop.manager_employee_id == emp.id:
            prop.manager_employee_id = None  # name/email stay as snapshots

        # Open work returns to the unassigned queue. Completed/cancelled rows
        # keep assigned_to_name/supervisor_name as the immutable display name.
        open_statuses = {
            "pending", "assigned", "in_progress", "submitted",
            "reopened", "overdue", "scheduled",
        }
        res = await self.session.execute(
            select(Task).where(Task.employee_id == emp.id)
        )
        for task in res.scalars():
            task.employee_id = None
            if task.status in open_statuses:
                task.assigned_to_name = None
                task.status = "pending"
                task.submitted_at = None
                task.allocation_status = "unassigned"
                task.allocation_method = None
                task.allocation_reason = "employee_deleted"
                self.session.add(TaskHistoryEvent(
                    task_id=task.id, type="employee_removed",
                    actor_name=user.name,
                    note=f"{emp.name} was deleted; task returned to the unassigned queue.",
                ))

        res = await self.session.execute(
            select(Task).where(Task.supervisor_id == emp.id)
        )
        for task in res.scalars():
            task.supervisor_id = None

        res = await self.session.execute(
            select(MaintenanceTicket).where(MaintenanceTicket.assigned_to == emp.id)
        )
        for ticket in res.scalars():
            ticket.assigned_to = None
            if ticket.status in {"open", "assigned", "in_progress", "on_hold"}:
                ticket.assigned_to_name = None
                ticket.status = "open"
                ticket.allocation_status = "unassigned"
                ticket.allocation_method = None
                ticket.allocation_reason = "employee_deleted"
                self.session.add(MaintenanceTicketEvent(
                    ticket_id=ticket.id, action="unassigned",
                    actor_name=user.name,
                    comment=f"{emp.name} was deleted; ticket returned to the unassigned queue.",
                ))

        res = await self.session.execute(
            select(WorkAllocationBatch).where(
                WorkAllocationBatch.employee_id == emp.id
            )
        )
        for batch in res.scalars():
            batch.employee_id = None  # employee_name remains for audit

        # remove the linked login accounts entirely — keeping them would hold
        # the email/username hostage and 409 any re-create of the same person
        for linked in await self._linked_users(emp.id):
            await self.session.delete(linked)  # refresh tokens cascade
        self.audit.record(
            user, entity_type="employee", entity_id=emp.id,
            entity_name=emp.name, action="employee_deleted",
            property_id=emp.property_id,
        )
        await self.session.delete(emp)
        await self.session.commit()
