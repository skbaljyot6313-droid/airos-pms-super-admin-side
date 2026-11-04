import base64
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.api.v1 import media
from app.core.config import settings
from app.core.storage import storage_key_from_url
from app.dependencies.auth import Forbidden, Unauthenticated
from app.models.user import UserRole
from app.schemas.workspace import completion_image_out

KEY = 'a' * 32 + '.png'
PIXEL = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==')


def session_for(tasks):
    result = SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: tasks))
    return SimpleNamespace(execute=AsyncMock(return_value=result))


@pytest.fixture
def storage(monkeypatch):
    async def stream():
        yield PIXEL
    backend = SimpleNamespace(open=AsyncMock(return_value=(stream, 'image/png', len(PIXEL))))
    monkeypatch.setattr(media, 'get_storage', lambda: backend)
    return backend


@pytest.mark.asyncio
async def test_linked_evidence_requires_authentication(storage):
    task = SimpleNamespace(property_id=uuid.uuid4(), employee_id=uuid.uuid4())
    with pytest.raises(Unauthenticated):
        await media.get_media_file(KEY, credentials=None, session=session_for([task]))
    storage.open.assert_not_awaited()


@pytest.mark.asyncio
async def test_property_scope_is_checked_before_storage(monkeypatch, storage):
    task = SimpleNamespace(property_id=uuid.uuid4())
    user = SimpleNamespace(role=UserRole.PROPERTY_MANAGER, company_id='company')
    monkeypatch.setattr(media, 'get_current_user', AsyncMock(return_value=user))
    scope = AsyncMock(side_effect=Forbidden())
    monkeypatch.setattr(media.StructureService, '_property_for_write', scope)
    with pytest.raises(Forbidden):
        await media.get_media_file(KEY, credentials=None, session=session_for([task]))
    storage.open.assert_not_awaited()


@pytest.mark.asyncio
async def test_employee_cannot_read_another_assignees_evidence(monkeypatch, storage):
    task = SimpleNamespace(property_id=uuid.uuid4(), employee_id=uuid.uuid4())
    user = SimpleNamespace(role=UserRole.EMPLOYEE, employee_id=uuid.uuid4(), company_id='company')
    monkeypatch.setattr(media, 'get_current_user', AsyncMock(return_value=user))
    monkeypatch.setattr(media.StructureService, '_property_for_write', AsyncMock(return_value=SimpleNamespace(company_id='company')))
    with pytest.raises(Forbidden):
        await media.get_media_file(KEY, credentials=None, session=session_for([task]))
    storage.open.assert_not_awaited()


@pytest.mark.asyncio
async def test_authorized_evidence_stream_is_private(monkeypatch, storage):
    task = SimpleNamespace(property_id=uuid.uuid4())
    user = SimpleNamespace(role=UserRole.PROPERTY_MANAGER, company_id='company')
    monkeypatch.setattr(media, 'get_current_user', AsyncMock(return_value=user))
    monkeypatch.setattr(media.StructureService, '_property_for_write', AsyncMock(return_value=SimpleNamespace(company_id='company')))
    response = await media.get_media_file(KEY, credentials=None, session=session_for([task]))
    assert response.headers['cache-control'] == 'private, no-store'
    assert response.media_type == 'image/png'
    assert b''.join([chunk async for chunk in response.body_iterator]) == PIXEL


@pytest.mark.asyncio
async def test_missing_object_is_404(storage):
    storage.open.return_value = None
    with pytest.raises(media.MediaNotFound):
        await media.get_media_file(KEY, credentials=None, session=session_for([]))


@pytest.mark.asyncio
async def test_storage_error_is_502(storage):
    storage.open.side_effect = RuntimeError('unavailable')
    with pytest.raises(media.StorageUnavailable):
        await media.get_media_file(KEY, credentials=None, session=session_for([]))


@pytest.mark.asyncio
async def test_invalid_key_never_reaches_database_or_storage(storage):
    session = session_for([])
    with pytest.raises(media.MediaNotFound):
        await media.get_media_file('../secret.png', credentials=None, session=session)
    session.execute.assert_not_awaited()
    storage.open.assert_not_awaited()


@pytest.mark.parametrize('url', [
    'https://storage.googleapis.com/evidence-bucket/' + KEY,
    'https://evidence-bucket.storage.googleapis.com/' + KEY,
])
def test_configured_private_gcs_url_maps_to_key(monkeypatch, url):
    from app.core import storage as storage_module
    values = {**settings.model_dump(), 'GCS_BUCKET': 'evidence-bucket'}
    monkeypatch.setattr(storage_module, 'settings', SimpleNamespace(**values))
    assert storage_key_from_url(url) == KEY
    assert storage_key_from_url(url.replace('evidence-bucket', 'other-bucket')) is None


def test_serializer_prefers_durable_key_over_expired_url():
    image = SimpleNamespace(id=uuid.uuid4(), task_id=uuid.uuid4(), history_event_id=None,
                            submission_id=None, storage_key=KEY, url='https://expired.invalid/image',
                            file_name='photo.png', created_by_name='Employee', created_at=None)
    assert completion_image_out(image)['url'] == '/api/v1/media/file/' + KEY


@pytest.mark.asyncio
@pytest.mark.parametrize('headers', [{}, {'Authorization': 'Bearer invalid-test-token'}])
async def test_http_evidence_requires_valid_session(monkeypatch, storage, headers):
    import httpx
    from fastapi import FastAPI
    from app.core.exceptions import register_exception_handlers

    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(media.router, prefix='/api/v1')
    task = SimpleNamespace(property_id=uuid.uuid4())
    app.dependency_overrides[media.get_db] = lambda: session_for([task])
    monkeypatch.setattr(settings, 'RATE_LIMIT_ENABLED', False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        response = await client.get('/api/v1/media/file/' + KEY, headers=headers)
    assert response.status_code == 401
    storage.open.assert_not_awaited()


@pytest.mark.asyncio
async def test_cross_company_evidence_is_rejected(monkeypatch, storage):
    task = SimpleNamespace(property_id=uuid.uuid4())
    user = SimpleNamespace(role=UserRole.PROPERTY_MANAGER, company_id='other')
    monkeypatch.setattr(media, 'get_current_user', AsyncMock(return_value=user))
    monkeypatch.setattr(media.StructureService, '_property_for_write', AsyncMock(return_value=SimpleNamespace(company_id='owner')))
    with pytest.raises(media.MediaNotFound):
        await media.get_media_file(KEY, credentials=None, session=session_for([task]))
    storage.open.assert_not_awaited()


@pytest.mark.asyncio
async def test_local_objects_get_browser_renderable_content_type(storage):
    stream, _, length = storage.open.return_value
    storage.open.return_value = (stream, None, length)
    response = await media.get_media_file(KEY, credentials=None, session=session_for([]))
    assert response.media_type == 'image/png'
