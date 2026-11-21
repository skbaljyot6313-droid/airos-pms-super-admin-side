from unittest.mock import patch

import pytest
from google.api_core.exceptions import Forbidden, NotFound

from app.core import storage
from app.core.config import Settings, settings


@pytest.fixture
def gcs(monkeypatch):
    monkeypatch.setattr(settings, "GCS_BUCKET", "synthetic-shared-media", raising=False)
    with patch("google.cloud.storage.Client") as client:
        blob = client.return_value.bucket.return_value.blob.return_value
        blob.content_type = "image/jpeg"
        blob.generation = 123
        blob.download_as_bytes.return_value = b"synthetic-evidence"
        yield client, blob


@pytest.mark.asyncio
async def test_gcs_open_reads_shared_bucket_off_loop(gcs):
    client, blob = gcs
    opened = await storage.GCSStorage().open("a" * 32 + ".jpg")
    stream, content_type, length = opened
    assert b"".join([chunk async for chunk in stream()]) == b"synthetic-evidence"
    assert content_type == "image/jpeg"
    assert length == 18
    client.return_value.bucket.assert_called_once_with("synthetic-shared-media")
    blob.reload.assert_called_once_with(timeout=30)
    blob.download_as_bytes.assert_called_once_with(if_generation_match=123, raw_download=True, timeout=30)


@pytest.mark.asyncio
async def test_gcs_save_returns_proxy_url_without_public_acl(gcs):
    client, blob = gcs
    key = "b" * 32 + ".jpg"
    result = await storage.GCSStorage().save(b"synthetic", key, "image/jpeg")
    assert result == "/api/v1/media/file/" + key
    blob.upload_from_string.assert_called_once_with(
        b"synthetic", content_type="image/jpeg", if_generation_match=0, timeout=30,
    )
    blob.make_public.assert_not_called()
    blob.generate_signed_url.assert_not_called()


@pytest.mark.asyncio
async def test_gcs_missing_object_is_not_found(gcs):
    _, blob = gcs
    blob.reload.side_effect = NotFound("synthetic missing object")
    assert await storage.GCSStorage().open("c" * 32 + ".jpg") is None
    blob.download_as_bytes.assert_not_called()


@pytest.mark.asyncio
async def test_gcs_permission_failure_is_not_misreported_as_missing(gcs):
    _, blob = gcs
    blob.reload.side_effect = Forbidden("synthetic permission denied")
    with pytest.raises(Forbidden):
        await storage.GCSStorage().open("c" * 32 + ".jpg")


def test_gcs_requires_bucket(monkeypatch):
    monkeypatch.setattr(settings, "GCS_BUCKET", None, raising=False)
    with pytest.raises(RuntimeError, match="GCS_BUCKET"):
        storage.GCSStorage()


def test_explicit_gcs_selection(gcs, monkeypatch):
    monkeypatch.setattr(storage, "_backend", None)
    monkeypatch.setattr(settings, "STORAGE_BACKEND", "gcs")
    assert isinstance(storage.get_storage(), storage.GCSStorage)


def test_auto_prefers_explicit_gcs_bucket(gcs, monkeypatch):
    monkeypatch.setattr(storage, "_backend", None)
    monkeypatch.setattr(settings, "STORAGE_BACKEND", "auto")
    assert isinstance(storage.get_storage(), storage.GCSStorage)


@pytest.mark.parametrize("mode", ["local", "auto", "typo"])
def test_production_cannot_silently_use_local_storage(mode, monkeypatch):
    monkeypatch.setattr(storage, "_backend", None)
    monkeypatch.setattr(settings, "APP_ENV", "production")
    monkeypatch.setattr(settings, "STORAGE_BACKEND", mode)
    monkeypatch.setattr(settings, "GCS_BUCKET", None, raising=False)
    monkeypatch.setattr(settings, "SUPABASE_SECRET_KEY", None)
    monkeypatch.setattr(settings, "S3_BUCKET", None)
    with pytest.raises(RuntimeError):
        storage.get_storage()


def test_local_storage_remains_available_in_development(monkeypatch):
    monkeypatch.setattr(storage, "_backend", None)
    monkeypatch.setattr(settings, "APP_ENV", "development")
    monkeypatch.setattr(settings, "STORAGE_BACKEND", "local")
    assert isinstance(storage.get_storage(), storage.LocalStorage)


@pytest.mark.asyncio
async def test_gcs_delete_uses_storage_identity(gcs):
    _, blob = gcs
    await storage.GCSStorage().delete("d" * 32 + ".jpg")
    blob.delete.assert_called_once_with(timeout=30)


def test_sensitive_settings_are_not_printed():
    values = Settings(
        _env_file=None, DATABASE_URL="postgresql+asyncpg://synthetic:do-not-print@localhost/test",
        JWT_SECRET_KEY="synthetic-jwt-do-not-print", S3_SECRET_KEY="synthetic-s3-do-not-print",
        S3_ACCESS_KEY="synthetic-access-do-not-print", SUPABASE_SECRET_KEY="synthetic-supabase-do-not-print",
    )
    assert "do-not-print" not in repr(values)
    assert "do-not-print" not in str(values)


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/uploads/", "/api/v1/media/file/"])
async def test_legacy_and_current_media_paths_share_storage(path, monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    import httpx

    from app.api.v1 import media
    from app.main import app

    async def stream():
        yield b"synthetic-preserved-evidence"

    backend = SimpleNamespace(open=AsyncMock(return_value=(stream, "image/jpeg", 28)))
    monkeypatch.setattr(media, "get_storage", lambda: backend)
    monkeypatch.setattr(settings, "RATE_LIMIT_ENABLED", False)
    previous = app.dependency_overrides.copy()
    rows = SimpleNamespace(
        scalars=lambda: SimpleNamespace(all=lambda: []),
        # referenced by a maintenance attachment → public-by-key serve path
        first=lambda: (1,),
    )
    app.dependency_overrides[media.get_db] = lambda: SimpleNamespace(execute=AsyncMock(return_value=rows))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://audit.test") as client:
            result = await client.get(path + "a" * 32 + ".jpg")
    finally:
        app.dependency_overrides = previous
    assert result.status_code == 200
    assert result.content == b"synthetic-preserved-evidence"
    backend.open.assert_awaited_once_with("a" * 32 + ".jpg")


def test_shared_employee_revision_is_resolvable_without_database():
    from pathlib import Path

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    scripts = ScriptDirectory.from_config(config)
    # ONE linear chain — the shared alembic_version row must never branch
    assert len(scripts.get_heads()) == 1
    rev = scripts.get_revision("w3b7d9f1a4c6")
    assert rev.down_revision == "v9f2b5c8d1e4"
    # and it stays an ancestor of whatever head the chain has grown to
    assert "w3b7d9f1a4c6" in {
        r.revision for r in scripts.walk_revisions()
    }
