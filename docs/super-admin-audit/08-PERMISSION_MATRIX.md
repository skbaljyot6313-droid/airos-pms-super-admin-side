# 08 — Permission Matrix

Roles: SA=super_admin, PM=property_manager, HR=human_resource, DM=department_manager, EMP=employee.

| Feature | SA | PM | HR | DM | EMP | Guard |
|---|---|---|---|---|---|---|
| /admin properties/settings/logs | ✓ | ✗ | ✗ | ✗ | ✗ | `require_super_admin` + RequireRole |
| Property workspace (zones/rooms/tasks) | ✓ | ✓ | ✗ | ✗ | ✗ | `require_property_manager` |
| Zones/structure CRUD | ✓ | ✓ | ✗ | ✗ | ✗ | Staff |
| Rooms/dorms/washrooms + occupancy | ✓ | ✓ | ✗ | ✗ | ✗ | Staff |
| Employee create/edit/delete/allocate | ✓ | ✓ | ✗ | ✗ | ✗ | Staff |
| Deactivate/reactivate | ✓ | ✓ | ✗ | ✗ | ✗ | Staff |
| Departments CRUD/head/transfer | ✓ | ✓ | ✗ | ✗ | ✗ | Staff |
| Live location | ✓ | ✓ | ✗ | ✗ | ✗ | PM dep |
| Shifts/attendance/leaves | ✓ | ✓ | ✗ | ✗ | ✗ | PM dep |
| Tasks CRUD/assign | ✓ | ✓ | ✗ | ✗ | ✗ | Staff |
| Task review (approve/reject) | ✓ | ✓ | ✗ | ✗ | ✗ | `_require_reviewer` (staff-only) |
| Resource-targeted task decisions | ✓ | ✗* | ✗ | ✗ | ✗ | `_require_resource_authority` = SA |
| Maintenance tickets | ✓ | ✓ | ✗ | ✗ | ✗ | Staff |
| Templates | ✓ | ✓ | ✗ | ✗ | ✗ | Staff |
| VA cameras/streams | ✓ | ✓ | ✗ | ✗ | ✗ | RequireRole[SA,PM] |
| Company PATCH | ✓ | ✗ | ✗ | ✗ | ✗ | company-scope check |
| Property PATCH/DELETE | ✓ | ✗ | ✗ | ✗ | ✗ | `_property_for_write` |
| Self profile | ✓ | ✓ | ✓ | ✓ | ✓ | authed |

\* PM can approve/reject employee-submitted tasks but not staff-owned resource-targeted ones.

## Scope enforcement

- SA: any property in own company (`_assert_company_scope`, company_id tenant).
- PM: own `user.property_id` only — enforced in `_property_for_write` + scope guards.
- HR/DM: authenticated but **zero workspace routes** — land on `/`, no surface.
- EMP: mobile app only; `RequireAuth` blocks this UI.

## Frontend mirroring

`lib/permissions.ts` `can()` mirrors role rules; Header filters nav by role; RequireRole guards routes. Backend is authoritative — frontend gates are UX-only.
