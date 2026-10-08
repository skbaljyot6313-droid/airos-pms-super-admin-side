import { AuthUser, PermissionAction, PermissionResource } from '../types';

export interface PermissionContext {
  property_uid?: string;
  employee_uid?: string;
  zone_uid?: string;
}

/**
 * Centralized authorization engine.
 * Determines if a given AuthUser has permission to perform an action on a resource.
 */
export function can(
  action: PermissionAction,
  resource: PermissionResource,
  user: AuthUser | null,
  context?: PermissionContext
): boolean {
  if (!user) return false;

  // 1. Super Admin has universal access across the entire company
  if (user.role === 'super_admin') {
    return true;
  }

  // 2. Property Manager has full operational access only within their assigned property
  if (user.role === 'property_manager') {
    // Cannot manage all properties or global company settings
    if (action === 'manage_all_properties' || action === 'manage_org_settings') {
      return false;
    }
    if (resource === 'companies') {
      return false;
    }

    // Property check: must match assigned property if context is provided
    if (context?.property_uid && context.property_uid !== user.property_uid) {
      return false;
    }

    // Allowed to manage zones, rooms, dorms, beds, employees and tasks in their property
    return true;
  }

  // Employee / HR / department roles have no surface in this app — the
  // employee experience lives in a separate application.
  return false;
}
