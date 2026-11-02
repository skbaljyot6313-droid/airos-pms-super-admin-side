import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import create_engine
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Session

from app.api.v1.logs import router
from app.core.database import get_db
from app.core.exceptions import register_exception_handlers
from app.dependencies.auth import Forbidden, get_current_user
from app.models.audit import AuditEvent
from app.models.refresh_token import RefreshToken
from app.models.user import User, UserRole
from app.services.audit import AuditService, capture_mutations
from app.services.auth import AuthService
from app.services.logs import LogAttachmentNotFound, LogsService, TaskJourneyNotFound, activity_query


COMPANY_ID = uuid.uuid4()
PROPERTY_ID = uuid.uuid4()


def user(role=UserRole.SUPER_ADMIN):
    return SimpleNamespace(id=uuid.uuid4(), name="Admin", company_id=COMPANY_ID,
                           property_id=None, role=role)


@pytest.mark.asyncio
@pytest.mark.parametrize("role", [UserRole.PROPERTY_MANAGER, UserRole.EMPLOYEE,
                                  UserRole.HUMAN_RESOURCE, UserRole.DEPARTMENT_MANAGER])
async def test_logs_service_denies_non_super_admin(role):
    session = AsyncMock()
    with pytest.raises(Forbidden):
        await LogsService(session).list_events(user(role))
    session.execute.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("role, expected", [(UserRole.PROPERTY_MANAGER, 403), (UserRole.SUPER_ADMIN, 200)])
async def test_logs_route_role_guard(role, expected, monkeypatch):
    app = FastAPI()
    app.include_router(router)
    register_exception_handlers(app)
    app.dependency_overrides[get_current_user] = lambda: user(role)
    app.dependency_overrides[get_db] = lambda: AsyncMock()
    listing = AsyncMock(return_value={"items": [], "total": 0, "page": 1, "limit": 50})
    monkeypatch.setattr(LogsService, "list_events", listing)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/admin/logs")
    assert response.status_code == expected
    assert listing.await_count == (1 if expected == 200 else 0)


@pytest.mark.asyncio
@pytest.mark.parametrize("query", ["page=0", "limit=101", "category=unknown", "property_id=invalid",
                                   "date_from=2026-10-29T12:00:00",
                                   "date_from=2026-10-30T00:00:00Z&date_to=2026-10-29T00:00:00Z"])
async def test_logs_invalid_filters(query):
    app = FastAPI()
    app.include_router(router)
    register_exception_handlers(app)
    app.dependency_overrides[get_current_user] = lambda: user()
    app.dependency_overrides[get_db] = lambda: AsyncMock()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get(f"/admin/logs?{query}")
    assert response.status_code == 422


def test_query_includes_shared_activity_without_credentials():
    query = str(activity_query().select().compile(dialect=postgresql.dialect()))
    for table in ("task_history_events", "task_completion_images", "maintenance_ticket_events",
                  "work_allocation_history", "resource_state_events", "attendance_days", "audit_events"):
        assert table in query
    for secret in ("password_hash", "token_hash", "refresh_tokens", "password"):
        assert secret not in query
    assert "LEFT OUTER JOIN" in query


@pytest.mark.asyncio
async def test_logs_company_scope_filters_and_pagination():
    class Result:
        def scalar_one(self):
            return 1

        def mappings(self):
            return [{"source": "work_allocation", "event_uid": "event", "occurred_at": datetime.now(timezone.utc),
                     "company_uid": str(COMPANY_ID), "category": "allocation", "action": "manual",
                     "actor_name": "Manager", "entity_type": "task", "entity_uid": "task",
                     "entity_name": "TASK-1", "property_uid": str(PROPERTY_ID), "property_name": "Hotel",
                     "detail": {"assigned_to": "Employee"}}]

    session = AsyncMock()
    session.execute.return_value = Result()
    result = await LogsService(session).list_events(
        user(), property_id=PROPERTY_ID, category="allocation", search="50%_off", actor="Manager_1", action="manual", page=2, limit=10,
        date_from=datetime(2026, 10, 1, tzinfo=timezone.utc),
        date_to=datetime(2026, 11, 1, tzinfo=timezone.utc))
    for call in session.execute.call_args_list:
        compiled = call.args[0].compile(dialect=postgresql.dialect())
        params = compiled.params.values()
        assert str(COMPANY_ID) in params
        assert str(PROPERTY_ID) in params
        assert "%50/%/_off%" in params
        assert "%Manager/_1%" in params
        assert "manual" in params
        assert "activity.actor_name ILIKE" in str(compiled)
        assert "activity.action =" in str(compiled)
    query = session.execute.call_args.args[0].compile(dialect=postgresql.dialect())
    assert "LIMIT" in str(query) and "OFFSET" in str(query)
    assert result["items"][0]["property_name"] == "Hotel"
    assert result["items"][0]["log_uid"] == "work_allocation:event"
    assert "company_uid" not in result["items"][0]


def test_audit_snapshot_excludes_credentials_and_survives_entity_delete():
    session = Session()
    actor = user()
    session.info["audit_actor"] = {"id": actor.id, "name": actor.name,
                                   "company_id": actor.company_id, "role": "super_admin"}
    target = User(name="Staff", email="private@example.com", username="staff", password_hash="SECRET",
                  company_id=COMPANY_ID, role=UserRole.EMPLOYEE)
    session.add(target)
    capture_mutations(session, None, None)
    event = next(item for item in session.new if isinstance(item, AuditEvent))
    assert event.entity_id == target.id
    assert event.detail["company_uid"] == str(COMPANY_ID)
    assert event.property_id is None
    assert "SECRET" not in str(event.detail)
    assert "private@example.com" not in str(event.detail)
    assert event.detail["values"]["role"] == "employee"
    session.close()


def test_audit_capture_commits_atomically_and_rolls_back():
    engine = create_engine("sqlite://")
    AuditEvent.__table__.create(engine)
    with Session(engine) as session:
        AuditService(session).record(user(), entity_type="session", action="logged_in",
                                     detail={"category": "session"})
        session.rollback()
        assert session.query(AuditEvent).count() == 0
        AuditService(session).record(user(), entity_type="session", action="logged_in")
        session.commit()
        assert session.query(AuditEvent).count() == 1
    engine.dispose()


def test_entity_changes_and_audit_share_commit_and_rollback():
    engine = create_engine("sqlite://")
    User.__table__.create(engine)
    RefreshToken.__table__.create(engine)
    AuditEvent.__table__.create(engine)
    actor = user()
    with Session(engine) as session:
        session.info["audit_actor"] = {"id": actor.id, "name": actor.name,
                                       "company_id": actor.company_id, "role": "super_admin"}
        target = User(name="Original", email="staff@example.com", username="staff",
                      password_hash="SECRET", company_id=COMPANY_ID, role=UserRole.EMPLOYEE)
        session.add(target)
        session.commit()
        assert session.query(AuditEvent).count() == 1
        target.name = "Changed"
        session.commit()
        changed = session.query(AuditEvent).filter_by(action="updated").one()
        assert changed.detail["changes"]["name"] == {"before": "Original", "after": "Changed"}
        target.name = "Rolled back"
        session.flush()
        session.rollback()
        assert session.query(AuditEvent).count() == 2
        assert target.name == "Changed"
        session.delete(target)
        session.commit()
        assert session.query(User).count() == 0
        assert session.query(AuditEvent).filter_by(action="deleted").one().entity_id == target.id
    engine.dispose()


@pytest.mark.asyncio
async def test_upload_rejects_foreign_property_before_storing(monkeypatch):
    from app.api.v1.media import InvalidUpload, upload_media
    from app.repositories.workspace import WorkspaceRepository
    get_property = AsyncMock(return_value=None)
    monkeypatch.setattr(WorkspaceRepository, "get_property", get_property)
    with pytest.raises(InvalidUpload):
        await upload_media(request=None, file=None, user=user(), session=AsyncMock(), property_id=PROPERTY_ID)


@pytest.mark.asyncio
async def test_logout_records_actor_without_storing_token():
    session = AsyncMock()
    session.add = lambda obj: events.append(obj)
    service = AuthService(session)
    service.tokens.get_valid = AsyncMock(return_value=SimpleNamespace(user_id=uuid.uuid4(), revoked=False))
    service.users.get_by_id = AsyncMock(return_value=user())
    events = []
    await service.logout("private-refresh-token")
    assert len(events) == 1
    assert events[0].action == "logged_out"
    assert "private-refresh-token" not in str(events[0].detail)
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_repeated_logout_does_not_invent_event():
    session = AsyncMock()
    service = AuthService(session)
    service.tokens.get_valid = AsyncMock(return_value=None)
    await service.logout("already-revoked")
    session.add.assert_not_called()
    session.commit.assert_not_awaited()


def task_summary_row():
    return {"task_uid": str(uuid.uuid4()), "title": "Recorded task", "ticket_number": "TASK-1",
            "property_uid": str(PROPERTY_ID), "property_name": "Hotel", "status": "completed",
            "assignee_name": "Current assignee", "zone_name": None,
            "created_at": datetime(2026, 10, 1, tzinfo=timezone.utc), "submitted_at": None,
            "completed_at": datetime(2026, 10, 2, tzinfo=timezone.utc),
            "abandoned_at": None, "abandoned_reason": None}


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["find_tasks", "task_journey", "attachment_key"])
async def test_new_explorer_services_reject_property_manager(method):
    session = AsyncMock()
    args = {"task_journey": (uuid.uuid4(),), "attachment_key": ("task_photo", uuid.uuid4())}.get(method, ())
    with pytest.raises(Forbidden):
        await getattr(LogsService(session), method)(user(UserRole.PROPERTY_MANAGER), *args)
    session.execute.assert_not_called()


@pytest.mark.asyncio
async def test_task_lookup_is_scoped_filtered_and_paginated():
    session = AsyncMock()
    count, rows = MagicMock(), MagicMock()
    count.scalar_one.return_value = 1
    rows.mappings.return_value = [task_summary_row()]
    session.execute.side_effect = [count, rows]
    result = await LogsService(session).find_tasks(user(), property_id=PROPERTY_ID, status="completed",
                                                 search="TASK_1%", page=2, limit=25)
    for call in session.execute.call_args_list:
        compiled = call.args[0].compile(dialect=postgresql.dialect())
        assert COMPANY_ID in compiled.params.values()
        assert PROPERTY_ID in compiled.params.values()
        assert "completed" in compiled.params.values()
        assert "%TASK/_1/%%" in compiled.params.values()
    assert result["items"][0]["status"] == "completed"
    assert result["items"][0]["created_at"].endswith("+00:00")
    assert result["page"] == 2


@pytest.mark.asyncio
async def test_journey_summary_is_not_inferred_from_latest_event():
    session = AsyncMock()
    summary, types = MagicMock(), MagicMock()
    summary.mappings.return_value.one_or_none.return_value = task_summary_row()
    types.scalars.return_value.all.return_value = ["started"]
    session.execute.side_effect = [summary, types]
    service = LogsService(session)
    service.list_events = AsyncMock(return_value={"items": [{"action": "started"}], "total": 1, "page": 2, "limit": 50})
    task_id = uuid.uuid4()
    result = await service.task_journey(user(), task_id, page=2)
    assert result["task"]["status"] == "completed"
    assert result["events"]["items"] == [{"action": "started"}]
    assert result["history_types"] == ["started"]
    service.list_events.assert_awaited_once()
    assert service.list_events.call_args.kwargs == {"task_id": task_id, "page": 2, "limit": 50, "ascending": True}
    sql = session.execute.call_args_list[0].args[0].compile(dialect=postgresql.dialect())
    assert COMPANY_ID in sql.params.values() and task_id in sql.params.values()


@pytest.mark.asyncio
async def test_foreign_or_deleted_task_is_not_disclosed():
    session = AsyncMock()
    missing = MagicMock()
    missing.mappings.return_value.one_or_none.return_value = None
    session.execute.return_value = missing
    with pytest.raises(TaskJourneyNotFound):
        await LogsService(session).task_journey(user(), uuid.uuid4())
    assert session.execute.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("detail", [None, {"url": "https://external.invalid/private.jpg"}, {"url": "/uploads/../../private"}])
async def test_attachment_rejects_missing_or_unsafe_storage_reference(detail):
    session = AsyncMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = detail
    session.execute.return_value = result
    with pytest.raises(LogAttachmentNotFound):
        await LogsService(session).attachment_key(user(), "task_photo", uuid.uuid4())


@pytest.mark.asyncio
async def test_attachment_scope_and_original_photo_index():
    session = AsyncMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = {"photos": ["/uploads/" + "a" * 32 + ".jpg"]}
    session.execute.return_value = result
    event_id = uuid.uuid4()
    key = await LogsService(session).attachment_key(user(), "task_history", event_id, index=1)
    assert key == "a" * 32 + ".jpg"
    compiled = session.execute.call_args.args[0].compile(dialect=postgresql.dialect())
    assert str(COMPANY_ID) in compiled.params.values() and str(event_id) in compiled.params.values()


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/admin/logs/tasks", f"/admin/logs/tasks/{uuid.uuid4()}/journey",
                                  f"/admin/logs/attachments/task_photo/{uuid.uuid4()}"])
async def test_explorer_routes_require_super_admin(path):
    app = FastAPI()
    app.include_router(router)
    register_exception_handlers(app)
    app.dependency_overrides[get_current_user] = lambda: user(UserRole.PROPERTY_MANAGER)
    session = AsyncMock()
    app.dependency_overrides[get_db] = lambda: session
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get(path)
    assert response.status_code == 403
    session.execute.assert_not_called()


@pytest.mark.asyncio
async def test_authorized_attachment_stream_uses_private_cache_and_safe_mime(monkeypatch):
    from app.api.v1 import logs as api
    app = FastAPI()
    app.include_router(router)
    register_exception_handlers(app)
    app.dependency_overrides[get_current_user] = lambda: user()
    app.dependency_overrides[get_db] = lambda: AsyncMock()
    monkeypatch.setattr(LogsService, "attachment_key", AsyncMock(return_value="a" * 32 + ".jpg"))

    async def stream():
        yield b"image-bytes"

    storage = SimpleNamespace(open=AsyncMock(return_value=(stream(), "image/jpeg", 11)))
    monkeypatch.setattr(api, "get_storage", lambda: storage)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get(f"/admin/logs/attachments/task_photo/{uuid.uuid4()}")
    assert response.status_code == 200 and response.content == b"image-bytes"
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
