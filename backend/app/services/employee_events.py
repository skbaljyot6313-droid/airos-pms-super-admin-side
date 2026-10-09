"""Push-side allocation notices to the Employee Backend.

WorkAllocationService.record() buffers an event dict on
``session.info[EB_ALLOC_EVENTS]``; session-level commit/rollback hooks in
app.core.database drain the buffer only after the outer transaction
commits and POST each event to ``{EB}/admin/notify-allocation`` under the
shared ``X-Location-Service-Key``. A rolled-back allocation never
notifies; a failed or slow call is logged and forgotten — the EB's ledger
synthesis (GET /notifications) recreates the row on the employee's next
feed poll, so a missed push is a delay, never a loss.
"""

import uuid
from datetime import datetime

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.logging import get_logger
from app.services.live_location import _base_url

logger = get_logger("app.employee_events")

EB_ALLOC_EVENTS = "eb_alloc_events"


def queue_allocation_notice(
    session: AsyncSession,
    *,
    ticket_kind: str,
    ticket_id: uuid.UUID | None,
    employee_id: uuid.UUID | None,
    employee_name: str | None,
    previous_employee_id: uuid.UUID | None,
    event_created_at: datetime | None,
) -> None:
    """Buffer one allocation event on the session for post-commit
    dispatch. Unassigned outcomes and unknown kinds are not pushed."""
    if employee_id is None or ticket_kind not in ("task", "maintenance"):
        return
    session.info.setdefault(EB_ALLOC_EVENTS, []).append({
        "ticket_kind": ticket_kind,
        "ticket_uid": str(ticket_id),
        "employee_uid": str(employee_id),
        "employee_name": employee_name,
        "previous_employee_uid": (
            str(previous_employee_id) if previous_employee_id else None
        ),
        "event_created_at": (
            event_created_at.isoformat() if event_created_at else None
        ),
    })


async def dispatch_allocation_notices(events: list[dict]) -> None:
    """POST buffered events to the EB, one call each, bounded by the
    location-service timeout. Every failure mode is swallowed: this runs
    after commit and must never surface to the allocation path."""
    base = _base_url()
    key = settings.LOCATION_SERVICE_API_KEY
    if not base or not key:
        logger.debug(
            "allocation-notice dispatch skipped — employee API or "
            "LOCATION_SERVICE_API_KEY not configured"
        )
        return
    timeout = httpx.Timeout(
        settings.LOCATION_SERVICE_TIMEOUT_SECONDS, connect=4.0
    )
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            for ev in events:
                try:
                    res = await client.post(
                        f"{base}/admin/notify-allocation",
                        json=ev,
                        headers={"X-Location-Service-Key": key},
                    )
                    if res.status_code == 404:
                        logger.info(
                            "EB skipped allocation event %s (stale or "
                            "reassigned)", ev.get("ticket_uid"),
                        )
                    elif res.status_code != 200:
                        logger.warning(
                            "EB notify-allocation %s -> HTTP %s",
                            ev.get("ticket_uid"), res.status_code,
                        )
                except httpx.HTTPError as exc:
                    logger.warning(
                        "EB notify-allocation %s failed: %s",
                        ev.get("ticket_uid"), type(exc).__name__,
                    )
    except Exception as exc:
        logger.warning("allocation-notice dispatch failed: %s", exc)
