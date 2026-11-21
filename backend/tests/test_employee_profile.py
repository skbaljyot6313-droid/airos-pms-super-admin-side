import uuid
from datetime import UTC, datetime, time, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import create_engine, delete
from sqlalchemy.orm import Session

from app.api.v1.workspace import router
from app.core.database import get_db
from app.core.exceptions import register_exception_handlers
from app.dependencies.auth import Forbidden, get_current_user
from app.models.attendance import AttendanceDay, AttendanceRequest
from app.models.employee import Employee, EmployeeAreaAssignment
from app.models.maintenance import MaintenanceTicket
from app.models.property import Property
from app.models.shift import EmployeeShiftAssignment, Shift
from app.models.structure import Area, Zone
from app.models.task import Task, TaskCompletionImage, TaskCompletionSubmission, TaskHistoryEvent
from app.models.user import UserRole
from app.models.work_allocation import WorkAllocationHistory
from app.services.employee_profile import EmployeeProfileService
from app.services.structure import NotFoundErr


@pytest.fixture
def data():
    engine = create_engine("sqlite://")
    for model in (Property, Employee, EmployeeAreaAssignment, Area, Zone, Task, TaskHistoryEvent, TaskCompletionSubmission,
                  TaskCompletionImage, WorkAllocationHistory, AttendanceDay, AttendanceRequest,
                  Shift, EmployeeShiftAssignment, MaintenanceTicket):
        model.__table__.create(engine)
    with Session(engine) as session:
        company, foreign_company = uuid.uuid4(), uuid.uuid4()
        p1, p2, p3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        a, b, foreign_employee = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        t1, t2, t3, t4, t5, foreign_task = (uuid.uuid4() for _ in range(6))
        base = datetime(2026, 10, 1, 3, tzinfo=UTC)
        at = lambda minutes: base + timedelta(minutes=minutes)
        for prop_id, co in ((p1, company), (p2, company), (p3, foreign_company)):
            session.add(Property(id=prop_id, company_id=co, name="Property", code=str(prop_id)[:8],
                                 location="Local", city="City", state="State", manager_name="Manager", manager_email="manager@example.test"))
        for eid, prop, co in ((a, p1, company), (b, p1, company), (foreign_employee, p3, foreign_company)):
            session.add(Employee(id=eid, company_id=co, property_id=prop, name="Same Name",
                                 email=f"{eid}@example.test", salary="15000 (stored amount)", leave_balance_days=4))
        for tid, prop, emp, status in ((t1, p1, b, "completed"), (t2, p1, b, "in_progress"),
                                      (t3, p1, a, "abandoned"), (t4, p1, a, "completed"),
                                      (t5, p2, a, "completed"), (foreign_task, p3, a, "completed")):
            session.add(Task(id=tid, property_id=prop, employee_id=emp, title="Clean 50%_room" if tid == t1 else "Work",
                             ticket_number=f"TASK-{str(tid)[:8]}", status=status, created_at=at(0),
                             abandoned_at=at(30) if tid in (t2, t3) else None))
        def allocation(tid, emp, minute, prop=p1, prev=None):
            return WorkAllocationHistory(id=uuid.uuid4(), property_id=prop, ticket_kind="task", ticket_id=tid,
                                         employee_id=emp, employee_name="Same Name", previous_employee_id=prev,
                                         previous_employee_name="Same Name" if prev else None,
                                         allocation_method="manual" if prev is None else "reassign",
                                         created_at=at(minute))
        session.add_all([allocation(t1, a, 0), allocation(t1, b, 50, prev=a), allocation(t2, a, 0),
                         allocation(t2, b, 50, prev=a),
                         allocation(t5, a, 0, p2), allocation(foreign_task, a, 0, p3)])
        session.add_all([TaskHistoryEvent(task_id=t1, type="started", at=at(10), actor_name="Same Name"),
                         TaskHistoryEvent(task_id=t1, type="started", at=at(30), actor_name="Same Name"),
                         TaskHistoryEvent(task_id=t2, type="abandoned", at=at(30), actor_name="System"),
                         TaskHistoryEvent(task_id=t4, type="completed", at=at(40), actor_name="Same Name")])
        for tid, attempt, submitted, state in ((t1, 1, 20, "disapproved"), (t1, 2, 40, "approved"),
                                                (t5, 1, 40, "approved"), (foreign_task, 1, 40, "approved")):
            session.add(TaskCompletionSubmission(task_id=tid, employee_id=a, employee_name="Same Name",
                                                attempt_number=attempt, status=state, submitted_at=at(submitted),
                                                reviewed_at=at(submitted + 5)))
        for prop, seconds in ((p1, 3600), (p2, 7200), (p3, 99999)):
            session.add(AttendanceDay(property_id=prop, employee_id=a, employee_name="Same Name", status="present",
                                      attendance_date="2026-10-01", started_at=at(0), ended_at=at(60), work_seconds=seconds))
            session.add(AttendanceRequest(property_id=prop, employee_id=a, employee_name="Same Name", request_type="leave",
                                          leave_type="paid_leave", from_date="2026-10-02", to_date="2026-10-02",
                                          requested_days=1, status="pending", created_at=at(10)))
            shift = Shift(id=uuid.uuid4(), company_id=company if prop != p3 else foreign_company,
                          property_id=prop, name="Day", start_time=time(9), end_time=time(17))
            session.add(shift)
            session.add(EmployeeShiftAssignment(employee_id=a, shift_id=shift.id, effective_from="2026-10-01"))
        session.commit()

        class ReadSession:
            async def execute(self, statement):
                return session.execute(statement)

        admin = SimpleNamespace(id=uuid.uuid4(), role=UserRole.SUPER_ADMIN, company_id=company, property_id=None)
        manager = SimpleNamespace(id=uuid.uuid4(), role=UserRole.PROPERTY_MANAGER, company_id=company, property_id=p1)
        yield SimpleNamespace(service=EmployeeProfileService(ReadSession()), session=session, admin=admin, manager=manager,
                              a=a, b=b, p1=p1, p2=p2, p3=p3, t1=t1, t2=t2, foreign_employee=foreign_employee, at=at,
                              allocation=allocation)
    engine.dispose()


@pytest.mark.asyncio
async def test_counts_use_employee_ids_not_names_or_current_assignee(data):
    profile = await data.service.profile(data.admin, data.a, data.p1)
    assert profile["tasks"]["allocated"] == 5
    assert profile["tasks"]["completed"] == 2
    assert profile["tasks"]["rejected"] == 1
    assert profile["tasks"]["abandoned"] == 2
    other = await data.service.profile(data.admin, data.b, data.p1)
    assert other["tasks"]["completed"] == 0
    assert other["tasks"]["rejected"] == 0
    assert other["tasks"]["abandoned"] == 0
    assert profile["employee"]["salary"] == "15000 (stored amount)"
    assert "password" not in str(profile).lower()


@pytest.mark.asyncio
async def test_manager_scope_applies_to_all_statistics_and_histories(data):
    profile = await data.service.profile(data.manager, data.a, data.p1)
    assert profile["tasks"]["allocated"] == 4
    assert profile["tasks"]["completed"] == 1
    assert profile["attendance"]["recorded_work_seconds"] == 3600
    assert profile["leave_requests"]["pending_requests"] == 1
    for kind in ("attendance", "leaves", "shifts", "allocations", "submissions"):
        result = await data.service.records(data.manager, data.a, kind=kind, property_id=data.p1)
        assert result["total"] > 0
        expected = {"attendance": 1, "leaves": 1, "shifts": 1, "allocations": 4, "submissions": 2}
        assert result["total"] == expected[kind]


@pytest.mark.asyncio
async def test_cross_tenant_and_wrong_property_profiles_are_not_disclosed(data):
    for caller, employee, prop in ((data.admin, data.foreign_employee, data.p3),
                                   (data.manager, data.foreign_employee, data.p3), (data.admin, data.a, data.p2)):
        with pytest.raises(NotFoundErr):
            await data.service.profile(caller, employee, prop)


@pytest.mark.asyncio
async def test_employee_role_cannot_query_salary_or_metrics(data):
    user = SimpleNamespace(role=UserRole.EMPLOYEE, company_id=data.admin.company_id, property_id=data.p1)
    with pytest.raises(Forbidden):
        await data.service.profile(user, data.a)


@pytest.mark.asyncio
async def test_search_escapes_wildcards_and_tasks_are_paginated(data):
    result = await data.service.tasks(data.admin, data.a, search="50%_", limit=1)
    assert result["total"] == 1 and uuid.UUID(result["items"][0]["task_uid"]) == data.t1
    assert result["items"][0]["current_status"] == "completed"
    page = await data.service.tasks(data.admin, data.a, page=2, limit=1)
    assert page["total"] == 5 and len(page["items"]) == 1 and page["page"] == 2


@pytest.mark.asyncio
async def test_duration_pairs_latest_attempt_with_its_recorded_start(data):
    result = await data.service.tasks(data.admin, data.a, search="50%_")
    row = result["items"][0]
    assert row["start_to_submission_seconds"] == 600
    assert row["review_status"] == "approved"
    rejected = (await data.service.tasks(data.admin, data.a, filter="rejected"))["items"][0]
    assert rejected["review_status"] == "disapproved" and rejected["attempt_number"] == 1
    data.session.add_all([data.allocation(data.t1, data.b, 35), data.allocation(data.t1, data.a, 36)])
    data.session.commit()
    row = (await data.service.tasks(data.admin, data.a, search="50%_"))["items"][0]
    assert row["assignment_changed_during_attempt"] is True
    assert row["start_to_submission_seconds"] is None


@pytest.mark.asyncio
async def test_start_from_previous_attempt_is_not_reused(data):
    data.session.execute(delete(TaskHistoryEvent).where(TaskHistoryEvent.task_id == data.t1, TaskHistoryEvent.at == data.at(30)))
    data.session.commit()
    row = (await data.service.tasks(data.admin, data.a, search="50%_"))["items"][0]
    assert row["recorded_start_at"] is None and row["start_to_submission_seconds"] is None


@pytest.mark.asyncio
async def test_metrics_and_task_list_respect_date_range(data):
    window = dict(date_from=data.at(15), date_to=data.at(45))
    profile = await data.service.profile(data.admin, data.a, data.p1, **window)
    assert profile["tasks"]["allocated"] == 0        # latest allocations at 50; created_at fallback at 0
    assert profile["tasks"]["completed"] == 2        # approved submissions at 40 (t1, t5)
    assert profile["tasks"]["rejected"] == 1         # disapproved submission at 20
    assert profile["tasks"]["abandoned"] == 2        # t2 history event at 30, t3 abandoned_at 30
    assert profile["tasks"]["current_open"] == 0     # created_at outside window
    later = await data.service.profile(data.admin, data.a, data.p1,
                                       date_from=data.at(45), date_to=data.at(60))
    assert later["tasks"]["completed"] == 0 and later["tasks"]["allocated"] == 0
    assert (await data.service.tasks(data.admin, data.a, filter="allocated",
                                     date_from=data.at(45), date_to=data.at(60)))["total"] == 0
    assert (await data.service.tasks(data.admin, data.a, filter="completed", **window))["total"] == 2
    assert (await data.service.tasks(data.admin, data.a, filter="completed",
                                     date_from=data.at(45)))["total"] == 0


@pytest.mark.asyncio
async def test_record_histories_respect_date_range(data):
    window = dict(date_from=data.at(5), date_to=data.at(15))
    assert (await data.service.records(data.admin, data.a, kind="leaves", **window))["total"] == 2
    assert (await data.service.records(data.admin, data.a, kind="leaves",
                                       date_from=data.at(20)))["total"] == 0
    # Reassignments at 50 list employee a as previous_employee_id
    assert (await data.service.records(data.admin, data.a, kind="allocations",
                                       date_from=data.at(45), date_to=data.at(60)))["total"] == 2
    assert (await data.service.records(data.admin, data.a, kind="submissions",
                                       date_from=data.at(45)))["total"] == 0


@pytest.mark.asyncio
async def test_analytics_aggregates_series_submissions_and_durations(data):
    result = await data.service.analytics(data.admin, data.a, property_id=data.p1)
    assert result["submissions"]["total"] == 3        # t1x2 + t5; foreign-company excluded
    assert result["submissions"]["approved"] == 2     # t1 attempt 2 + t5
    assert result["submissions"]["disapproved"] == 1
    assert result["submissions"]["approval_rate"] == round(2 / 3, 4)
    assert set(result["series"][0]) == {"bucket", "allocated", "submitted", "approved",
                                        "disapproved", "pending", "abandoned"}
    total_events = sum(r["allocated"] + r["submitted"] + r["abandoned"] for r in result["series"])
    assert total_events > 0
    assert result["durations"]["eligible"] + result["durations"]["unavailable"] >= 1


@pytest.mark.asyncio
async def test_allocation_direction_filters_and_maintenance_records(data):
    received = await data.service.records(data.admin, data.a, kind="allocations",
                                          property_id=data.p1, direction="received")
    away = await data.service.records(data.admin, data.a, kind="allocations",
                                      property_id=data.p1, direction="away")
    both = await data.service.records(data.admin, data.a, kind="allocations", property_id=data.p1)
    assert received["total"] == 3            # three assignments TO employee a (t1, t5, reassigned t4)
    assert away["total"] == 2                # two reallocations AWAY from a
    assert both["total"] == 5
    assert received["items"][0]["employee_uid"].replace("-", "") == str(data.a).replace("-", "")
    tasks_only = await data.service.records(data.admin, data.a, kind="allocations",
                                            property_id=data.p1, ticket_kind="task")
    assert tasks_only["total"] == 5
    maint = await data.service.records(data.admin, data.a, kind="maintenance", property_id=data.p1)
    assert maint["total"] == 0               # fixture has no maintenance allocations


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["profile", "tasks", "records?kind=leaves"])
async def test_profile_routes_require_staff(path):
    app = FastAPI()
    app.include_router(router)
    register_exception_handlers(app)
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(role=UserRole.EMPLOYEE)
    session = AsyncMock()
    app.dependency_overrides[get_db] = lambda: session
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get(f"/employees/{uuid.uuid4()}/{path}")
    assert response.status_code == 403
    session.execute.assert_not_called()


@pytest.mark.asyncio
async def test_salary_response_is_not_cacheable(monkeypatch):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(role=UserRole.SUPER_ADMIN)
    app.dependency_overrides[get_db] = lambda: AsyncMock()
    monkeypatch.setattr(EmployeeProfileService, "profile", AsyncMock(return_value={"employee": {"salary": "Stored value"}}))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get(f"/employees/{uuid.uuid4()}/profile")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
