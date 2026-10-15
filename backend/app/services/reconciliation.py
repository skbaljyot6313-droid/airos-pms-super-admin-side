"""Read-only resource-state reconciliation (spec §43/§44).

Detects — never repairs — integrity contradictions in BOTH directions:

    CLEANING    without active work            (orphan_cleaning)
    MAINTENANCE without an open ticket         (orphan_maintenance)
    OCCUPIED    without an open occupancy      (orphan_occupied)
    open occupancy + status == 'available'     (occupancy_status_conflict)
    open occupancy + cleaning/maintenance      (occupied_under_work — info)
    blocking ticket + status != maintenance    (unflagged_ticket)
    started task + status not work-flagged     (unflagged_task)
    any status outside the canonical set       (invalid_state)

Returns a list of findings for administrative review. It deliberately does
NOT rewrite state — an authorized correction goes through
ResourceStateService.repair() (POST /resources/{type}/{id}/repair), which
rewrites only the materialized projection and never deletes work or
occupancy records.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.resource_states import (
    BED_STATUSES,
    BLOCKING_MAINTENANCE,
    BLOCKING_TASK,
    DORM_STATUSES,
    FIXTURE_STATUSES,
    ROOM_STATUSES,
    WASHROOM_STATUSES,
)
from app.models.maintenance import MaintenanceTicket
from app.models.occupancy import Occupancy
from app.models.structure import (
    Bed,
    Dorm,
    Room,
    Washroom,
    WashroomFixture,
)
from app.models.task import Task

# A task only flags its resource once work actually begins — queued
# (pending/assigned/scheduled) work legitimately leaves the unit free.
_STARTED_TASK = {"in_progress", "submitted", "reopened"}


async def _prefetch_blockers(session: AsyncSession, property_id: uuid.UUID):
    """One grouped query per blocker family — replaces ~3–4 per-resource
    round trips with set lookups (B-06). Returns the resource->bool
    predicates reconcile_property consumes.

      open_occ_rooms / open_occ_beds  — resources with an open occupancy
      dorm_open_occ                   — dorms with ≥1 open bed occupancy
      task_rooms / task_dorms / task_washrooms / task_bed_cover
                                        — started-task coverage (bed cover
                                        is per-dorm: all beds or bed_ids)
      blocking_task_washrooms         — BLOCKING_TASK coverage (orphan ck)
      ticket_rooms / ticket_dorm_wide / ticket_beds / ticket_washrooms /
      ticket_fixtures                 — open-ticket coverage
    """
    beds_by_dorm: dict[uuid.UUID, list[uuid.UUID]] = {}
    for dorm_id, bed_id in (await session.execute(
        select(Bed.dorm_id, Bed.id)
        .join(Dorm, Bed.dorm_id == Dorm.id)
        .where(Dorm.property_id == property_id)
    )):
        beds_by_dorm.setdefault(dorm_id, []).append(bed_id)

    open_occ_rooms: set[uuid.UUID] = set()
    open_occ_beds: set[uuid.UUID] = set()
    for room_id, bed_id in (await session.execute(
        select(Occupancy.room_id, Occupancy.bed_id).where(
            Occupancy.checked_out_at.is_(None),
            # scope via the resource's property — no company join needed,
            # occupancies are room/bed-scoped
            Occupancy.room_id.in_(
                select(Room.id).where(Room.property_id == property_id)
            ) | Occupancy.bed_id.in_(
                select(Bed.id)
                .join(Dorm, Bed.dorm_id == Dorm.id)
                .where(Dorm.property_id == property_id)
            ),
        )
    )):
        if room_id:
            open_occ_rooms.add(room_id)
        if bed_id:
            open_occ_beds.add(bed_id)
    bed_to_dorm = {b: d for d, beds in beds_by_dorm.items() for b in beds}
    dorm_open_occ = {bed_to_dorm[b] for b in open_occ_beds if b in bed_to_dorm}

    # One task sweep covering both status sets the sweep consults.
    task_statuses = BLOCKING_TASK | _STARTED_TASK
    task_rooms: set[uuid.UUID] = set()
    task_dorms: set[uuid.UUID] = set()
    task_washrooms: set[uuid.UUID] = set()
    blocking_task_washrooms: set[uuid.UUID] = set()
    task_bed_cover: set[uuid.UUID] = set()
    for t_room, t_dorm, t_washroom, t_bed_ids, t_status in (
        await session.execute(
            select(
                Task.room_id, Task.dorm_id, Task.washroom_id,
                Task.bed_ids, Task.status,
            ).where(
                Task.property_id == property_id,
                Task.status.in_(task_statuses),
            )
        )
    ):
        started = t_status in _STARTED_TASK
        if t_room and started:
            task_rooms.add(t_room)
        if t_dorm and started:
            task_dorms.add(t_dorm)
            if not t_bed_ids:
                task_bed_cover.update(beds_by_dorm.get(t_dorm, []))
            else:
                task_bed_cover.update(
                    uuid.UUID(b) for b in t_bed_ids
                )
        if t_washroom:
            if started:
                task_washrooms.add(t_washroom)
            if t_status in BLOCKING_TASK:
                blocking_task_washrooms.add(t_washroom)

    ticket_rooms: set[uuid.UUID] = set()
    ticket_dorm_wide: set[uuid.UUID] = set()
    ticket_beds: set[uuid.UUID] = set()
    ticket_washrooms: set[uuid.UUID] = set()
    ticket_fixtures: set[uuid.UUID] = set()
    for m_room, m_dorm, m_bed, m_washroom, m_fixture in (
        await session.execute(
            select(
                MaintenanceTicket.room_id, MaintenanceTicket.dorm_id,
                MaintenanceTicket.bed_id, MaintenanceTicket.washroom_id,
                MaintenanceTicket.washroom_fixture_id,
            ).where(
                MaintenanceTicket.property_id == property_id,
                MaintenanceTicket.status.in_(BLOCKING_MAINTENANCE),
            )
        )
    ):
        if m_room:
            ticket_rooms.add(m_room)
        if m_bed:
            ticket_beds.add(m_bed)
        elif m_dorm:  # dorm-wide ticket = dorm_id with no bed_id
            ticket_dorm_wide.add(m_dorm)
        if m_washroom:
            ticket_washrooms.add(m_washroom)
        if m_fixture:
            ticket_fixtures.add(m_fixture)

    return {
        "open_occ_rooms": open_occ_rooms,
        "open_occ_beds": open_occ_beds,
        "dorm_open_occ": dorm_open_occ,
        "task_rooms": task_rooms,
        "task_dorms": task_dorms,
        "task_washrooms": task_washrooms,
        "blocking_task_washrooms": blocking_task_washrooms,
        "task_bed_cover": task_bed_cover,
        "ticket_rooms": ticket_rooms,
        "ticket_dorm_wide": ticket_dorm_wide,
        "ticket_beds": ticket_beds,
        "ticket_washrooms": ticket_washrooms,
        "ticket_fixtures": ticket_fixtures,
    }


async def reconcile_property(
    session: AsyncSession, property_id: uuid.UUID
) -> list[dict]:
    findings: list[dict] = []

    def flag(rtype, rid, label, status, issue, detail,
             severity="conflict", recommended_action="repair",
             has_open_occupancy=None):
        findings.append({
            "resource_type": rtype,
            "resource_id": str(rid),
            "label": label,
            "status": status,
            "issue": issue,
            "severity": severity,
            "recommended_action": recommended_action,
            "has_open_occupancy": has_open_occupancy,
            "detail": detail,
        })

    P = await _prefetch_blockers(session, property_id)

    # --- rooms -----------------------------------------------------------
    res = await session.execute(
        select(Room).where(Room.property_id == property_id))
    for r in res.scalars():
        if r.status not in ROOM_STATUSES:
            flag("room", r.id, r.room_number, r.status, "invalid_state",
                 f"'{r.status}' is not a canonical room status",
                 severity="error")
            continue
        open_occ = r.id in P["open_occ_rooms"]
        if r.status == "occupied":
            if not open_occ:
                flag("room", r.id, r.room_number, r.status,
                     "orphan_occupied", "occupied with no open occupancy",
                     has_open_occupancy=False)
        elif open_occ:
            if r.status == "available":
                flag("room", r.id, r.room_number, r.status,
                     "occupancy_status_conflict",
                     "available while an occupancy record is still open",
                     recommended_action="restore_occupied_projection",
                     has_open_occupancy=True)
            else:
                # cleaning/maintenance + open occupancy is the LEGAL
                # two-axis projection — reported for observability only
                flag("room", r.id, r.room_number, r.status,
                     "occupied_under_work",
                     "open occupancy while work blocks the unit",
                     severity="info", recommended_action="none",
                     has_open_occupancy=True)
        if r.status != "maintenance" and r.id in P["ticket_rooms"]:
            flag("room", r.id, r.room_number, r.status,
                 "unflagged_ticket",
                 "blocking maintenance ticket but unit is not maintenance")
        if r.status not in ("cleaning", "maintenance") \
                and r.id in P["task_rooms"]:
            flag("room", r.id, r.room_number, r.status,
                 "unflagged_task",
                 "started task but unit is not cleaning/maintenance")

    # --- dorms + beds ------------------------------------------------------
    res = await session.execute(
        select(Dorm).where(Dorm.property_id == property_id))
    for d in res.scalars():
        if d.status not in DORM_STATUSES:
            flag("dorm", d.id, d.name, d.status, "invalid_state",
                 f"'{d.status}' is not a canonical dorm status",
                 severity="error")
            continue
        dorm_occ = d.id in P["dorm_open_occ"]
        if d.status == "occupied":
            if not dorm_occ:
                flag("dorm", d.id, d.name, d.status, "orphan_occupied",
                     "occupied with no open bed occupancy",
                     has_open_occupancy=False)
        elif dorm_occ and d.is_active:
            if d.status == "available":
                flag("dorm", d.id, d.name, d.status,
                     "occupancy_status_conflict",
                     "available while a bed occupancy is still open",
                     recommended_action="restore_occupied_projection",
                     has_open_occupancy=True)
            else:
                flag("dorm", d.id, d.name, d.status, "occupied_under_work",
                     "open bed occupancy while work blocks the dorm",
                     severity="info", recommended_action="none",
                     has_open_occupancy=True)
        if d.status != "maintenance" \
                and d.id in P["ticket_dorm_wide"]:
            flag("dorm", d.id, d.name, d.status, "unflagged_ticket",
                 "blocking dorm ticket but dorm is not maintenance")
        if d.status not in ("cleaning", "maintenance") \
                and d.id in P["task_dorms"]:
            flag("dorm", d.id, d.name, d.status, "unflagged_task",
                 "started dorm task but dorm is not cleaning/maintenance")

    res = await session.execute(
        select(Bed).join(Dorm, Bed.dorm_id == Dorm.id)
        .where(Dorm.property_id == property_id))
    for b in res.scalars():
        if b.status not in BED_STATUSES:
            flag("bed", b.id, b.bed_number, b.status, "invalid_state",
                 f"'{b.status}' is not a canonical bed status",
                 severity="error")
            continue
        open_occ = b.id in P["open_occ_beds"]
        if b.status == "occupied":
            if not open_occ:
                flag("bed", b.id, b.bed_number, b.status, "orphan_occupied",
                     "occupied with no open occupancy")
        elif open_occ and b.status != "inactive":
            if b.status == "available":
                flag("bed", b.id, b.bed_number, b.status,
                     "occupancy_status_conflict",
                     "available while an occupancy record is still open",
                     recommended_action="restore_occupied_projection",
                     has_open_occupancy=True)
            else:
                flag("bed", b.id, b.bed_number, b.status,
                     "occupied_under_work",
                     "open occupancy while work blocks the bed",
                     severity="info", recommended_action="none",
                     has_open_occupancy=True)
        # a bed-LEVEL ticket must flag the bed even when occupied; a
        # dorm-wide ticket legitimately skips occupied/inactive beds
        if b.status != "maintenance":
            if b.id in P["ticket_beds"] or (
                b.status not in ("occupied", "inactive")
                and b.dorm_id in P["ticket_dorm_wide"]
            ):
                flag("bed", b.id, b.bed_number, b.status,
                     "unflagged_ticket",
                     "blocking maintenance ticket but bed is not "
                     "maintenance")
        if b.status not in ("cleaning", "maintenance", "inactive") \
                and b.id in P["task_bed_cover"]:
            flag("bed", b.id, b.bed_number, b.status, "unflagged_task",
                 "started covering task but bed is not "
                 "cleaning/maintenance")

    # --- washrooms ---------------------------------------------------------
    res = await session.execute(
        select(Washroom).where(Washroom.property_id == property_id))
    for w in res.scalars():
        if w.status not in WASHROOM_STATUSES:
            flag("washroom", w.id, w.name, w.status, "invalid_state",
                 f"'{w.status}' is not a canonical washroom status",
                 severity="error")
            continue
        if w.status == "cleaning":
            if w.id not in P["blocking_task_washrooms"]:
                flag("washroom", w.id, w.name, w.status, "orphan_cleaning",
                     "cleaning with no active work")
        elif w.status == "maintenance":
            if w.id not in P["ticket_washrooms"]:
                flag("washroom", w.id, w.name, w.status,
                     "orphan_maintenance", "maintenance with no open ticket")
        if w.status != "maintenance" \
                and w.id in P["ticket_washrooms"]:
            flag("washroom", w.id, w.name, w.status, "unflagged_ticket",
                 "blocking ticket but washroom is not maintenance")
        if w.status not in ("cleaning", "maintenance", "inactive") \
                and w.id in P["task_washrooms"]:
            flag("washroom", w.id, w.name, w.status, "unflagged_task",
                 "started task but washroom is not cleaning/maintenance")

    # --- fixtures ------------------------------------------------------------
    res = await session.execute(
        select(WashroomFixture).join(
            Washroom, WashroomFixture.washroom_id == Washroom.id)
        .where(Washroom.property_id == property_id))
    for f in res.scalars():
        if f.status not in FIXTURE_STATUSES:
            flag("fixture", f.id, f"{f.fixture_type} {f.fixture_number}",
                 f.status, "invalid_state",
                 f"'{f.status}' is not a canonical fixture status",
                 severity="error")
        elif f.status == "maintenance":
            if f.id not in P["ticket_fixtures"]:
                flag("fixture", f.id, f"{f.fixture_type} {f.fixture_number}",
                     f.status, "orphan_maintenance",
                     "fixture in maintenance with no open ticket")
        if f.status == "operational" \
                and f.id in P["ticket_fixtures"]:
            flag("fixture", f.id, f"{f.fixture_type} {f.fixture_number}",
                 f.status, "unflagged_ticket",
                 "blocking ticket but fixture is operational")

    return findings
