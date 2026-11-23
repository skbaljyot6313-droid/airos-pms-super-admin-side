"""VA camera service + schema tests — SQLite-backed, no media server.

Covers: RTSP URL normalization/masking, section CRUD + the not-empty
guard, camera create (credential encryption at rest), update, soft delete,
bulk move, and stream-session guards (disabled camera, no media server).
"""
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models.audit import AuditEvent
from app.models.camera import Camera, CameraStreamSession
from app.models.property import Property
from app.models.structure import Area, Zone
from app.models.user import UserRole
from app.schemas.camera import (
    CameraCreateRequest,
    masked_rtsp,
    normalize_rtsp_url,
)
from app.services import go2rtc
from app.services.camera import CameraService, Conflict, ServiceUnavailable
from app.services.structure import NotFoundErr


def _sess(s: Session):
    """Sync Session wrapped in the async surface services use."""

    class S:
        async def execute(self, st, *a, **k):
            return s.execute(st, *a, **k)

        async def scalar(self, st, *a, **k):
            return s.scalar(st, *a, **k)

        def add(self, o):
            s.add(o)

        async def flush(self):
            s.flush()

        async def commit(self):
            s.commit()

        async def refresh(self, o):
            s.refresh(o)

        async def delete(self, o):
            s.delete(o)

    return S()


@pytest.fixture(autouse=True)
def _no_media_server(monkeypatch):
    """Never let tests reach a real go2rtc (dev .env may configure one)."""
    monkeypatch.setattr(go2rtc, "available", lambda: False)


@pytest.fixture
def data():
    engine = create_engine("sqlite://")
    for m in (Property, Camera, CameraStreamSession, AuditEvent, Area, Zone):
        m.__table__.create(engine)
    with Session(engine) as s:
        company = uuid.uuid4()
        prop = Property(
            id=uuid.uuid4(), company_id=company, name="P", code="P-1",
            location="L", city="C", state="S",
            manager_name="M", manager_email="m@x.test",
        )
        s.add(prop)
        s.commit()
        area = Area(id=uuid.uuid4(), property_id=prop.id, name="Dorms",
                    code="A-1", level_number=1)
        zone = Zone(id=uuid.uuid4(), property_id=prop.id, area_id=area.id,
                    name="Zone A", code="Z-1")
        s.add_all([area, zone])
        s.commit()
        admin = SimpleNamespace(
            id=uuid.uuid4(),
            name="Admin",
            email="admin@x.test",
            role=UserRole.SUPER_ADMIN,
            company_id=company,
            property_id=None,
        )
        yield SimpleNamespace(
            service=CameraService(_sess(s)),
            session=s,
            admin=admin,
            prop=prop, area=area, zone=zone,
        )
    engine.dispose()


def test_normalize_rtsp_url_strips_userinfo():
    out = normalize_rtsp_url("rtsp://admin:secret@192.168.1.10:554/cam1")
    assert out == "rtsp://192.168.1.10:554/cam1"
    assert "secret" not in out


@pytest.mark.parametrize(
    "url",
    [
        "http://192.168.1.10/x",  # wrong scheme
        "rtsp://",  # no host
        "rtsp://localhost/x",  # loopback
        "rtsp://169.254.169.254/latest",  # cloud metadata
        "ftp://host/x",
    ],
)
def test_normalize_rtsp_url_rejects_unsafe(url):
    with pytest.raises(ValueError):
        normalize_rtsp_url(url)


def test_masked_rtsp_hides_path_and_creds():
    m = masked_rtsp("rtsp://192.168.1.10:554/stream/secret")
    assert m == "rtsp://192.168.1.10:554/***"
    assert "stream" not in m and "secret" not in m


@pytest.mark.asyncio
async def test_structure_assignment_zone_implies_area(data):
    svc = data.service
    cam = await svc.create_camera(
        data.admin,
        str(data.prop.id),
        CameraCreateRequest(
            name="Cam1", rtsp_url="rtsp://10.0.0.5/feed",
            zone_uid=str(data.zone.id),
        ),
    )
    assert cam["zone_uid"] == str(data.zone.id)
    assert cam["zone_name"] == "Zone A"
    assert cam["area_uid"] == str(data.area.id)  # implied by the zone

    moved = await svc.bulk_move(
        data.admin, str(data.prop.id), [cam["camera_uid"]], None,
        str(data.area.id),
    )
    assert moved["moved"] == 1
    out = (await svc.list_cameras(data.admin, str(data.prop.id)))[0]
    assert out["zone_uid"] is None and out["area_uid"] == str(data.area.id)

    bad = str(uuid.uuid4())
    with pytest.raises(NotFoundErr):
        await svc.bulk_move(data.admin, str(data.prop.id),
                            [cam["camera_uid"]], bad, None)


@pytest.mark.asyncio
async def test_camera_credentials_encrypted_and_never_serialized(data):
    svc = data.service
    cam = await svc.create_camera(
        data.admin,
        str(data.prop.id),
        CameraCreateRequest(
            name="Secure",
            rtsp_url="rtsp://10.0.0.9/live",
            username="admin",
            password="hunter2",
        ),
    )
    assert cam["has_credentials"] is True
    assert "hunter2" not in str(cam)
    row = data.session.execute(
        select(Camera).where(Camera.id == uuid.UUID(cam["camera_uid"]))
    ).scalar_one()
    assert row.password != "hunter2"  # Fernet token at rest


@pytest.mark.asyncio
async def test_update_and_soft_delete(data):
    svc = data.service
    cam = await svc.create_camera(
        data.admin,
        str(data.prop.id),
        CameraCreateRequest(name="Old", rtsp_url="rtsp://10.0.0.7/a"),
    )
    from app.schemas.camera import CameraUpdateRequest  # local: matches usage sites

    out = await svc.update_camera(
        data.admin,
        str(data.prop.id),
        cam["camera_uid"],
        CameraUpdateRequest(name="New", rtsp_url="rtsp://10.0.0.7/b"),
    )
    assert out["name"] == "New"
    assert out["rtsp_url_masked"] == "rtsp://10.0.0.7/***"

    await svc.delete_camera(data.admin, str(data.prop.id), cam["camera_uid"])
    assert await svc.list_cameras(data.admin, str(data.prop.id)) == []
    row = data.session.execute(
        select(Camera).where(Camera.id == uuid.UUID(cam["camera_uid"]))
    ).scalar_one()
    assert row.deleted_at is not None and row.is_enabled is False


@pytest.mark.asyncio
async def test_stream_session_guards(data, monkeypatch):
    svc = data.service
    cam = await svc.create_camera(
        data.admin,
        str(data.prop.id),
        CameraCreateRequest(name="Off", rtsp_url="rtsp://10.0.0.3/s", is_enabled=False),
    )
    with pytest.raises(Conflict):
        await svc.create_session(
            data.admin, str(data.prop.id), cam["camera_uid"], "webrtc"
        )
    from app.schemas.camera import CameraUpdateRequest as _U

    await svc.update_camera(
        data.admin, str(data.prop.id), cam["camera_uid"], _U(is_enabled=True)
    )
    with pytest.raises(ServiceUnavailable):
        await svc.create_session(
            data.admin, str(data.prop.id), cam["camera_uid"], "webrtc"
        )


@pytest.mark.asyncio
async def test_stream_session_recreates_after_idle_sweep(data, monkeypatch):
    """A session ended by the idle sweep must not be reused — the sweep
    runs before the join SELECT so an ended row is never loaded as active."""
    from datetime import datetime, timedelta, UTC

    import app.services.camera as cmod

    svc = data.service
    cam = await svc.create_camera(
        data.admin,
        str(data.prop.id),
        CameraCreateRequest(name="Cam", rtsp_url="rtsp://10.0.0.6/feed"),
    )
    cid = cam["camera_uid"]
    monkeypatch.setattr(cmod, "_media_ready", lambda: True)

    async def _noop(_cam):
        return None

    monkeypatch.setattr(cmod, "_ensure_media_registered", _noop)
    exp = datetime.now(UTC) + timedelta(hours=1)
    monkeypatch.setattr(cmod.mediamtx, "mint_stream_token", lambda *a, **k: ("tok", exp))
    monkeypatch.setattr(cmod.mediamtx, "playback_urls", lambda *a, **k: {})

    s1 = await svc.create_session(data.admin, str(data.prop.id), cid, "webrtc")
    assert s1["reused"] is False and s1["status"] == "active"

    # Age the session past the idle TTL, then force the amortized sweep.
    row = data.session.execute(
        select(CameraStreamSession).where(
            CameraStreamSession.id == uuid.UUID(s1["session_uid"])
        )
    ).scalar_one()
    row.last_activity_at = datetime.now(UTC) - timedelta(hours=1)
    data.session.commit()
    cmod._last_sweep = 0

    s2 = await svc.create_session(data.admin, str(data.prop.id), cid, "webrtc")
    assert s2["reused"] is False
    assert s2["session_uid"] != s1["session_uid"]
    assert s2["status"] == "active" and s2["ended_at"] is None

    row2 = data.session.execute(
        select(CameraStreamSession).where(
            CameraStreamSession.id == uuid.UUID(s1["session_uid"])
        )
    ).scalar_one()
    assert row2.status == "ended" and row2.ended_at is not None


@pytest.mark.asyncio
async def test_cross_property_isolation(data):
    other_prop = Property(
        id=uuid.uuid4(), company_id=data.admin.company_id, name="Q",
        code="Q-1", location="L", city="C", state="S",
        manager_name="M", manager_email="m@x.test",
    )
    data.session.add(other_prop)
    data.session.commit()
    cam = await data.service.create_camera(
        data.admin,
        str(data.prop.id),
        CameraCreateRequest(name="C", rtsp_url="rtsp://10.0.0.1/x"),
    )
    with pytest.raises(NotFoundErr):
        await data.service._camera(other_prop, cam["camera_uid"])
