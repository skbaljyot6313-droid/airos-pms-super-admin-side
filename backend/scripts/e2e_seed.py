"""Deterministic E2E fixture seed.

Two modes, selected by DATABASE_URL:

- sqlite+aiosqlite:///… — the DB file is deleted, rebuilt via
  ``Base.metadata.create_all``, and ``alembic_version`` is stamped at the
  current script head so the boot-time schema gate passes.
- postgresql(+asyncpg)://… — expects ``alembic upgrade head`` already
  applied; deletes then re-inserts the fixture rows (idempotent).

Fixtures:

    company → property → zone → two rooms (one occupied, one vacant)
    property_manager user   e2e.manager@airos.test / E2E-Pass-123
    one pending cleaning task on the vacant room
    one submitted task (review-queue entry)
    one open occupancy on the occupied room

Usage (from backend/):
    DATABASE_URL=sqlite+aiosqlite:///./e2e.db python scripts/e2e_seed.py
    DATABASE_URL=postgresql+asyncpg://postgres:e2e@localhost:55432/airos_e2e \
        python scripts/e2e_seed.py
"""

from __future__ import annotations

import asyncio
import sys
import uuid
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402

# Import every model module so Base.metadata knows all tables.
import app.models  # noqa: E402,F401
from app.core.config import settings  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.models import Base  # noqa: E402
from app.models.company import Company  # noqa: E402
from app.models.occupancy import Occupancy  # noqa: E402
from app.models.property import Property  # noqa: E402
from app.models.structure import Room, Zone  # noqa: E402
from app.models.task import Task  # noqa: E402
from app.models.user import User, UserRole  # noqa: E402

E2E_EMAIL = "e2e.manager@airos.test"
E2E_PASSWORD = "E2E-Pass-123"

COMPANY_ID = uuid.UUID("11111111-1111-4111-8111-111111111111")
PROPERTY_ID = uuid.UUID("22222222-2222-4222-8222-222222222222")
ZONE_ID = uuid.UUID("33333333-3333-4333-8333-333333333333")
OCCUPIED_ROOM_ID = uuid.UUID("44444444-4444-4444-8444-444444444444")
VACANT_ROOM_ID = uuid.UUID("55555555-5555-4555-8555-555555555555")

ALEMBIC_INI = Path(__file__).resolve().parents[1] / "alembic.ini"


def sqlite_path() -> Path | None:
    url = settings.database_url
    prefix = "sqlite+aiosqlite:///"
    if not url.startswith(prefix):
        return None
    return Path(url[len(prefix):]).resolve()


async def init_sqlite(engine) -> None:
    """create_all + stamp alembic_version at the script head."""
    from alembic.config import Config as AlembicConfig
    from alembic.script import ScriptDirectory
    from sqlalchemy import text

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    heads = ScriptDirectory.from_config(AlembicConfig(str(ALEMBIC_INI))).get_heads()
    async with engine.begin() as conn:
        await conn.execute(
            text("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
        )
        for head in heads:
            await conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": head},
            )


async def clear_fixtures(engine) -> None:
    """Postgres path: remove prior fixture rows so re-runs are idempotent."""
    from sqlalchemy import text

    ids = {
        "c": str(COMPANY_ID),
        "p": str(PROPERTY_ID),
        "z": str(ZONE_ID),
        "o": str(OCCUPIED_ROOM_ID),
        "v": str(VACANT_ROOM_ID),
    }
    async with engine.begin() as conn:
        await conn.execute(
            text("DELETE FROM occupancies WHERE property_id = :p"), ids
        )
        await conn.execute(text("DELETE FROM tasks WHERE property_id = :p"), ids)
        await conn.execute(
            text("DELETE FROM users WHERE email = :e"), {"e": E2E_EMAIL}
        )
        await conn.execute(
            text("DELETE FROM rooms WHERE property_id = :p"), ids
        )
        await conn.execute(
            text("DELETE FROM zones WHERE property_id = :p"), ids
        )
        await conn.execute(text("DELETE FROM properties WHERE id = :p"), ids)
        await conn.execute(text("DELETE FROM companies WHERE id = :c"), ids)


async def main() -> None:
    path = sqlite_path()
    if path is not None and path.exists():
        path.unlink()

    engine = create_async_engine(settings.database_url)
    if path is not None:
        await init_sqlite(engine)
    else:
        await clear_fixtures(engine)

    from sqlalchemy.ext.asyncio import async_sessionmaker

    SessionLocal = async_sessionmaker(bind=engine, expire_on_commit=False)
    async with SessionLocal() as session:
        company = Company(
            id=COMPANY_ID,
            company_name="E2E Fixtures Co",
            brand_name="E2E Suites",
            legal_name="E2E Fixtures Co Pvt Ltd",
            address="1 Fixture Lane",
            pin_code="560001",
            email="ops@e2e.test",
            phone_number="+910000000000",
        )
        prop = Property(
            id=PROPERTY_ID,
            company_id=COMPANY_ID,
            name="E2E Harbor View",
            code="E2E-001",
            location="Fixture District",
            city="Fixture City",
            state="Karnataka",
            status="Active",
            manager_name="E2E Manager",
            manager_email=E2E_EMAIL,
        )
        zone = Zone(
            id=ZONE_ID,
            property_id=PROPERTY_ID,
            name="Zone A",
            code="ZA-01",
            zone_type="stay",
        )
        occupied_room = Room(
            id=OCCUPIED_ROOM_ID,
            property_id=PROPERTY_ID,
            zone_id=ZONE_ID,
            room_number="101",
            type="Private Room",
            status="occupied",
            bed_count=1,
        )
        vacant_room = Room(
            id=VACANT_ROOM_ID,
            property_id=PROPERTY_ID,
            zone_id=ZONE_ID,
            room_number="102",
            type="Private Room",
            status="available",
            bed_count=1,
        )
        manager = User(
            id=uuid.uuid4(),
            company_id=COMPANY_ID,
            property_id=PROPERTY_ID,
            name="E2E Manager",
            email=E2E_EMAIL,
            username="e2e.manager",
            password_hash=hash_password(E2E_PASSWORD),
            role=UserRole.PROPERTY_MANAGER,
            is_active=True,
        )
        pending_task = Task(
            id=uuid.uuid4(),
            property_id=PROPERTY_ID,
            zone_id=ZONE_ID,
            room_id=VACANT_ROOM_ID,
            room_number="102",
            title="E2E pending cleaning",
            task_type="fixed",
            work_type="cleaning",
            origin="manual",
            status="pending",
            priority="medium",
            due_date=datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat(),
        )
        submitted_task = Task(
            id=uuid.uuid4(),
            property_id=PROPERTY_ID,
            zone_id=ZONE_ID,
            room_id=OCCUPIED_ROOM_ID,
            room_number="101",
            title="E2E submitted task",
            task_type="fixed",
            work_type="cleaning",
            origin="manual",
            status="submitted",
            priority="medium",
        )
        occupancy = Occupancy(
            id=uuid.uuid4(),
            property_id=PROPERTY_ID,
            room_id=OCCUPIED_ROOM_ID,
            guest_name="E2E Guest",
        )
        session.add_all([company, prop])
        await session.flush()
        session.add_all([zone, occupied_room, vacant_room, manager])
        await session.flush()
        session.add_all([pending_task, submitted_task, occupancy])
        await session.commit()

    await engine.dispose()
    print(f"Seeded {path or settings.database_url.split('@')[-1]}")
    print(f"  login: {E2E_EMAIL} / {E2E_PASSWORD}")
    print(f"  property_uid: {PROPERTY_ID}")


if __name__ == "__main__":
    asyncio.run(main())
