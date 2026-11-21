"""Workspace API — one URL surface split into per-domain router modules.

Each module owns the endpoints for one domain and declares its own
``APIRouter``; this package aggregates them so ``router.py`` keeps a
single ``include_router(workspace.router)``. Module import order
preserves the original single-file route-registration order (relevant
for overlapping paths like ``/tasks/review-queue`` vs ``/tasks/{id}``).
"""
from fastapi import APIRouter

from . import bootstrap, dashboard, departments, employees, maintenance, occupancy, properties, reads, structure, tasks

router = APIRouter(tags=["workspace"])

for _module in (
    bootstrap, dashboard, departments, reads, structure, occupancy, employees, tasks,
    maintenance, properties,
):
    router.include_router(_module.router)
