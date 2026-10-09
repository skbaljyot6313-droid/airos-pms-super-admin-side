/**
 * Shift definitions + employee assignments — SA backend routes.
 * Times are IST wall-clock 'HH:MM'; overnight shifts have
 * end_time <= start_time. Effective dates are IST op-day keys.
 */

import { apiFetch } from './client';

export interface Shift {
  shift_uid: string;
  property_uid: string;
  name: string;
  start_time: string;
  end_time: string;
  overnight: boolean;
  grace_minutes: number;
  early_exit_minutes: number;
  /** Monday-first 7-char '0'/'1' bitmap. */
  working_days: string;
  is_active: boolean;
  created_at: string | null;
}

export interface ShiftAssignment {
  assignment_uid: string;
  employee_uid: string;
  shift_uid: string;
  shift_name: string | null;
  effective_from: string;
  effective_until: string | null;
  created_by_name: string | null;
  created_at: string | null;
}

export interface ShiftCreateBody {
  property_uid: string;
  name: string;
  start_time: string;
  end_time: string;
  grace_minutes?: number;
  early_exit_minutes?: number;
  working_days?: string;
}

export const shiftsApi = {
  list: (property_uid: string, include_inactive = false) =>
    apiFetch<{ items: Shift[] }>('/shifts', {
      query: {
        property_id: property_uid,
        include_inactive: include_inactive || undefined,
      },
    }),
  create: (body: ShiftCreateBody) =>
    apiFetch<Shift>('/shifts', { method: 'POST', body }),
  update: (shift_uid: string, patch: Partial<ShiftCreateBody> & { is_active?: boolean }) =>
    apiFetch<Shift>(`/shifts/${shift_uid}`, { method: 'PATCH', body: patch }),
  listAssignments: (employee_uid: string) =>
    apiFetch<{ items: ShiftAssignment[] }>(
      `/employees/${employee_uid}/shift-assignments`
    ),
  assign: (
    employee_uid: string,
    body: {
      shift_uid: string;
      effective_from: string;
      effective_until?: string;
    }
  ) =>
    apiFetch<ShiftAssignment>(
      `/employees/${employee_uid}/shift-assignments`,
      { method: 'POST', body }
    ),
  endAssignment: (assignment_uid: string, effective_until: string) =>
    apiFetch<ShiftAssignment>(`/shift-assignments/${assignment_uid}`, {
      method: 'PATCH',
      body: { effective_until },
    }),
  /** Every employee's currently effective assignment for the board,
      plus SA/PM-linked staff who work 24×7 and carry no shift. */
  listCurrent: (property_uid: string) =>
    apiFetch<{
      items: ShiftAssignment[];
      exempt_employee_uids: string[];
    }>('/shift-assignments', {
      query: { property_id: property_uid },
    }),
  /** Delete an assignment starting today or later (same-day reassign). */
  deleteAssignment: (assignment_uid: string) =>
    apiFetch<void>(`/shift-assignments/${assignment_uid}`, {
      method: 'DELETE',
    }),
};
