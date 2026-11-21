# Testing Strategy

## Current maturity

| Layer | State |
|-------|-------|
| Backend | pytest + pytest-asyncio + respx — **18 files, ~249 tests** covering auth/login, verify queue, rollover, shifts, employee profile/events, live locations, media validation, storage GCS, task review/evidence, realtime, logs, perf regressions, security characterization |
| Frontend | Vitest + Testing Library — **12 test files** (ZoneBoard, LiveLocationMap, evidenceDelivery, etc.). Thin relative to 134 source files; mostly recently-touched components |
| E2E | **None** — no Playwright/Cypress; critical journeys unprotected end-to-end |
| CI gates | None configured for tests/lint (legacy deploy workflows only) |
| Type checking | `tsc --noEmit` passes; enforced manually |
| Lint/format | None configured (backend or frontend) |

## What the existing tests do well

- Characterization tests exist for risky semantics (e.g. refresh-reuse documented as a test).
- Security-discovery test file probes auth surfaces directly.
- Shared-chain migration test guards the Alembic invariant (fixed to assert linear-head + ancestry
  instead of a moving pinned head).
- respx mocks outbound HTTP — live-location proxy and EB notify paths are covered without network.

## Critical workflows lacking automated protection

1. **Occupancy lifecycle** — check-in/checkout/switch atomicity, cleaning-task spawn, `release_to`
   paths. Highest-value: a Postgres-backed test asserting "occupied is impossible without an open
   occupancy row" and switch rollback integrity.
2. **Rollover sweeps** — `expire_due` + midnight run are tested; add a case for
   `submitted`-survives-expiry and `NEXT_SCHEDULED_OCCURRENCE` reason.
3. **Allocation round-robin** — pointer persistence, secondary-zone/property-wide pool membership,
   dedup across pools. Currently exercised indirectly; deserves a dedicated service test.
4. **Review queue decisions** — approve/reject → resource release + notifications + shared tables.
5. **Attendance status_board** — the single evaluator deserves exhaustive day-state matrix tests.
6. **Frontend critical journeys** — login → workspace bootstrap → create task → review decision →
   checkout→cleaning. These are the flows 50–60 users run daily.

## Recommended strategy

- **Keep the backend pyramid as-is** — it's the strongest part; grow it where bugs recur.
- **Add a thin E2E layer**: Playwright, 5–8 journeys (login, zone board drag, task create/assign,
  occupancy check-in→checkout→clean, maintenance ticket, template generation). Run against a
  seeded dev DB in CI.
- **Contract the shared-DB boundary**: a small schema-snapshot test per repo asserting the columns
  the other service relies on (prevents silent drift better than revision mirroring alone).
- **Gate in CI**: `ruff` + `pytest` backend; `tsc` + `vitest` + `eslint` frontend; alembic
  single-head check; both repo chains resolve to same head.
- **Frontend**: extract pure logic from `AppContext` into testable units *as it is split*, rather
  than writing tests against the god-object now.
