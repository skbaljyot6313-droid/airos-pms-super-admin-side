"""Media uploads — storage backend selected via STORAGE_BACKEND (local dir
or S3-compatible object store). Local objects are served from the
`/uploads` static mount; S3 objects get their public/CDN URL back.

`GET /media/file/{key}` proxies any stored object through this origin —
required because employee-app evidence is stored in the SAME shared bucket
but serialized as `/api/v1/media/file/<key>` paths the Super Admin
frontend resolves against this API.
"""

import mimetypes
import re
import time
import uuid

from fastapi import APIRouter, Depends, File, Request, UploadFile, status
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import String, cast, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.exceptions import AppError
from app.core.logging import get_logger
from app.core.rate_limit import rate_limit
from app.core.storage import (
    ALLOWED_CONTENT_TYPES,
    MAX_BYTES,
    get_storage,
    new_object_key,
)
from app.dependencies.auth import Forbidden, bearer_scheme, get_current_user
from app.models.maintenance import MaintenanceTicketAttachment
from app.models.property import Property
from app.models.task import Task, TaskCompletionImage, TaskHistoryEvent
from app.models.user import User, UserRole
from app.repositories.workspace import WorkspaceRepository
from app.services.audit import AuditService

router = APIRouter(tags=["media"])

logger = get_logger("app.media")

# Flat uuid-keyed blobs only — traversal can't pass the whitelist.
_OBJECT_KEY_RE = re.compile(r"^[0-9a-f]{32}\.[a-z0-9]{2,5}$")


class InvalidUpload(AppError):
    status_code = 422
    code = "INVALID_UPLOAD"


class MediaNotFound(AppError):
    status_code = 404
    code = "MEDIA_NOT_FOUND"


class StorageUnavailable(AppError):
    status_code = 502
    code = "STORAGE_UNAVAILABLE"


def _matches_image_signature(data: bytes, content_type: str) -> bool:
    if content_type == "image/jpeg":
        return data.startswith(b"\xff\xd8\xff")
    if content_type == "image/png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if content_type == "image/webp":
        return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    if content_type in ("image/heic", "image/heif"):
        # ISO BMFF container — 'ftyp' box at offset 4, brand heic/heix/mif1 etc.
        return len(data) >= 12 and data[4:8] == b"ftyp"
    return False


async def _read_bounded(file: UploadFile) -> bytes:
    chunks: list[bytes] = []
    size = 0
    while chunk := await file.read(1024 * 1024):
        size += len(chunk)
        if size > MAX_BYTES:
            raise InvalidUpload("File exceeds the 10 MB limit.", field="photos")
        chunks.append(chunk)
    return b"".join(chunks)


@router.post(
    "/media/uploads",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(rate_limit("upload", limit=30, window_seconds=60))],
)
async def upload_media(
    request: Request,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
    property_id: uuid.UUID | None = None,
):
    t_start = time.perf_counter()
    property_id = property_id or user.property_id
    if property_id and await WorkspaceRepository(session).get_property(user, property_id) is None:
        raise InvalidUpload("Property is not available.", field="property_id")
    if file.content_type not in ALLOWED_CONTENT_TYPES:
        raise InvalidUpload("Only JPEG/PNG/WebP images are allowed.", field="photos")
    data = await _read_bounded(file)
    if not data:
        raise InvalidUpload("Empty file.", field="photos")
    if not _matches_image_signature(data, file.content_type):
        raise InvalidUpload("File content does not match its image type.", field="photos")
    t_read = time.perf_counter()

    key = new_object_key(file.filename, file.content_type)
    try:
        url = await get_storage().save(data, key, file.content_type)
    except AppError:
        raise
    except Exception as exc:
        # Misconfigured/unreachable object store (bad credentials, missing
        # bucket, offline disk) must surface as a clean 502 — not an
        # unhandled 500 that strips CORS headers off the response.
        logger.error("storage save failed for key %s: %s", key, exc)
        raise StorageUnavailable(
            "Image storage is unavailable — check the storage backend configuration."
        ) from exc
    t_save = time.perf_counter()
    # Local backend returns a relative /uploads/<key> path — the frontend's
    # mediaUrl() resolves it against the API origin. Works identically
    # direct, or behind nginx (absolute proxy-derived URLs lose the port).
    AuditService(session).record(
        user, entity_type="media", entity_name=key, action="photo_uploaded",
        property_id=property_id,
        detail={"category": "photo", "url": url, "content_type": file.content_type,
                "size_bytes": len(data)},
    )
    await session.commit()
    # upload pipeline timing — separates read/validate, storage write, and
    # audit-commit latency so backend cost is distinguishable from network.
    t_end = time.perf_counter()
    logger.info(
        "upload key=%s bytes=%d read_validate_ms=%.1f storage_ms=%.1f audit_ms=%.1f",
        key, len(data),
        (t_read - t_start) * 1000, (t_save - t_read) * 1000,
        (t_end - t_save) * 1000,
    )
    return {"url": url, "key": key}


@router.get(
    "/media/file/{key}",
    dependencies=[
        Depends(rate_limit("media_fetch", limit=240, window_seconds=60))
    ],
)
async def get_media_file(
    key: str,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    session: AsyncSession = Depends(get_db),
):
    """Stream a stored object through the API origin.

    Task evidence uploaded by the employee app is serialized as
    `/api/v1/media/file/<key>` — both backends share the same object
    bucket, so the same proxy path serves those objects here. Public by
    design, same as the storage URLs it replaces: keys are unguessable
    uuid4 names and <img> tags can't attach a JWT. The key whitelist makes
    traversal impossible, so only our own objects are ever served.
    """
    if not _OBJECT_KEY_RE.fullmatch(key):
        raise MediaNotFound()
    tasks = (await session.execute(
        select(Task).where(or_(
            Task.id.in_(select(TaskCompletionImage.task_id).where(or_(
                TaskCompletionImage.storage_key == key,
                TaskCompletionImage.url.contains('/' + key),
            ))),
            Task.id.in_(select(TaskHistoryEvent.task_id).where(
                cast(TaskHistoryEvent.photos, String).contains(key)
            )),
        ))
    )).scalars().all()
    if tasks:
        user = await get_current_user(credentials, session)
        # One batched property lookup — the same company-scope check the
        # per-task _property_for_write calls performed, without N queries.
        props = {
            p.id: p for p in (await session.execute(
                select(Property).where(Property.id.in_({t.property_id for t in tasks}))
            )).scalars()
        }
        for task in tasks:
            prop = props.get(task.property_id)
            if prop is None or prop.company_id != user.company_id:
                raise MediaNotFound()
            if user.role not in {UserRole.SUPER_ADMIN, UserRole.PROPERTY_MANAGER} and (
                user.role != UserRole.EMPLOYEE or not user.employee_id
                or task.employee_id != user.employee_id
            ):
                raise Forbidden()
    else:
        # Non-task objects: maintenance-ticket attachments are rendered in
        # plain <img> tags that cannot carry a JWT, so they stay
        # public-by-unguessable-key (same exposure as the storage URLs they
        # replaced). An object referenced by NOTHING is never served — an
        # orphan upload has no owner to authorize against, so handing it
        # out by URL alone would be an unauthenticated disclosure vector.
        referenced = (await session.execute(
            select(MaintenanceTicketAttachment.id).where(
                MaintenanceTicketAttachment.url.contains('/' + key)
            ).limit(1)
        )).first()
        if referenced is None:
            raise MediaNotFound()
    try:
        opened = await get_storage().open(key)
    except Exception as exc:
        logger.error(
            "media fetch failed: %s", type(exc).__name__,
        )
        raise StorageUnavailable(
            "Media storage is unavailable."
        ) from exc
    if opened is None:
        raise MediaNotFound()
    stream, content_type, length = opened
    content_type = content_type or mimetypes.guess_type(key)[0]
    headers = {
        # objects are immutable uuid-keyed blobs
        "Cache-Control": "private, no-store",
        "Vary": "Authorization",
        "X-Content-Type-Options": "nosniff",
        # already-compressed formats — bypass GZipMiddleware so
        # Content-Length survives for client progress display
        "Content-Encoding": "identity",
    }
    if length is not None:
        headers["Content-Length"] = str(length)
    return StreamingResponse(
        stream(),
        media_type=content_type or "application/octet-stream",
        headers=headers,
    )
