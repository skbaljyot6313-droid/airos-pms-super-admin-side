# Codebase Architecture

## Directory structure

```
super-admin/
  main.py                     dev launcher (frees :8000/:3000, uvicorn --reload + vite)
  backend/
    app/
      main.py                 lifespan, middleware chain, /health /ready, embedded scheduler, schema-head check
      api/v1/                 10 routers; workspace.py is the monolith (~99 routes, 1,640 LOC)
      core/                   config, database, security, middleware, rate_limit, storage,
                              verify_queue, redis, queue(arq), centrifugo, exceptions, logging
      dependencies/auth.py    get_current_user, require_super_admin, require_property_manager
      domain/                 pure transition tables (resource_states, transitions, resource_events)
      models/                 SQLAlchemy models (structure, task, occupancy, employee, user, …)
      repositories/           data access; workspace.py holds tenant scoping
      schemas/                pydantic + `*_out()` serializers
      services/               business logic
      utils/
    alembic/versions/         43 revisions; chain mirrored into employee repo
    tests/                    18 files, ~249 tests
  frontend/
    src/
      App.tsx                 routes + RequireAuth/RequireRole/PropertyScopedView guards
      context/AppContext.tsx  god-context: session + all collections + all mutations (2,733 LOC)
      api/                    thin wrappers over apiFetch (bearer, refresh-on-401 once, ApiError)
      components/             domain folders (zones, rooms, tasks, templates, maintenance,
                              employees, admin, auth, properties, profile, navigation, ui, landing)
      realtime/               centrifuge client; events = invalidation hints only
      hooks/  lib/  dev/      utilities; dev/perf.ts imported by production code
```

## Module responsibilities & relationships

```
React SPA ──apiFetch──▶ FastAPI routers ──▶ services ──▶ repositories ──▶ SQLAlchemy ──▶ Postgres
    ▲                        │                   │            (shared with employee app)
    └──── centrifuge ◀───────┴── session.info ◀──┘
         (invalidation)        after_commit dispatch → EB notify-allocation (X-Location-Service-Key)
```

- **Routers** do auth resolution + scoping calls; thin.
- **Services** hold business rules and transaction boundaries (`session.commit()` inside services —
  a deliberate single-commit-per-use-case convention).
- **`ResourceStateService`** is the single writer for resource status; status is *derived* from
  blocking work + occupancy.
- **`domain/`** encodes legal transitions — good separation of policy from mechanism.
- **Frontend**: `AppContext` is the sole state owner; realtime events trigger refetch, never merge
  payload truth.

## Coupling observations

- `api/v1/workspace.py` (1,640 LOC) is effectively a façade for most CRUD — acceptable as a
  "workspace aggregate" pattern but it concentrates merge risk; splitting by domain
  (structure/tasks/employees sub-routers) would localize change.
- `services/structure.py` (2,217 LOC) owns property/area/zone/room/dorm/washroom/bed lifecycle —
  the widest service; `_property_for_write` is even invoked from `media.py`'s read path.
- Employee **coverage logic is duplicated** across `work_allocation._eligible_pools`,
  `maintenance._employee_coverage`, `employee_profile` context, and `structure` listing — the
  secondary-zone/property-wide feature had to touch all four. A single `EmployeeCoverage`
  value object/query fragment would prevent drift.
- `AppContext.tsx` (2,733 LOC) mixes session, ~10 collections, optimistic mutation, toasts,
  correlation logging. Works, but every mutation is a context re-render for the whole tree.

## Circular dependencies

No import cycles detected at module level (services defer a few imports inside functions —
e.g. `workspace.py` lazily imports structure models — which is a smell of borderline layering but
not a cycle).

## Dead code

- `app/core/queue.py` `enqueue()` — zero callers (only `close_queue` wired in lifespan).
- `deploy/centrifugo/`, `railway.toml`, `vercel.json`, `main`-push workflows — legacy pipeline
  retained per ops decision.
- `frontend/src/dev/perf.ts` — dev instrumentation imported by 6 production modules.
