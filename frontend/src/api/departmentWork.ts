/** Department work management + shared work calendar + attendance history. */
import { apiFetch } from './client';
import type { Task } from '../types';

export interface RosterItem {
  employee_uid: string;
  name: string;
  role?: string | null;
  is_head: boolean;
  shift: { name: string; start_time: string; end_time: string; scheduled: boolean } | null;
  attendance_status: string | null;
  on_duty: boolean;
  open_tasks: number;
}

export interface DeptRoster {
  department_uid: string;
  name: string;
  code?: string | null;
  head_employee_uid?: string | null;
  items: RosterItem[];
}

export interface DeptPerformance {
  from: string;
  to: string;
  totals: Record<string, number>;
  per_employee: {
    employee_uid: string | null;
    name: string;
    open: number;
    submitted: number;
    completed: number;
    overdue: number;
  }[];
  avg_start_to_submit_minutes: number | null;
  weekly: { week: string; created: number; completed: number }[];
}

export interface AllocateWorkPayload {
  property_uid: string;
  title: string;
  description?: string;
  work_type?: string;
  priority?: string;
  employee_uids: string[];
  zone_uid?: string | null;
  room_uid?: string | null;
  dorm_uid?: string | null;
  washroom_uid?: string | null;
  due_date?: string;
  due_time?: string;
  scheduled_for?: string;
  checklist?: { title: string; description?: string | null; required?: boolean }[];
}

export interface AttendanceBreakRow {
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  open: boolean;
}

export interface AttendanceHistoryRow {
  date: string;
  status: string;
  leave_type?: string | null;
  holiday: boolean;
  is_past: boolean;
  shift: {
    name: string;
    start_time: string;
    end_time: string;
    grace_minutes: number;
    early_exit_minutes: number;
    overnight: boolean;
    scheduled: boolean;
  } | null;
  started_at: string | null;
  ended_at: string | null;
  work_seconds: number | null;
  break_seconds: number;
  breaks: AttendanceBreakRow[];
  on_break_now: boolean;
  late_minutes: number | null;
  on_time: boolean | null;
  early_exit_minutes: number | null;
  incomplete: boolean;
}

export interface AttendanceHistory {
  employee_uid: string;
  employee_name: string;
  department_uid?: string | null;
  from: string;
  to: string;
  items: AttendanceHistoryRow[];
}

export const departmentWorkApi = {
  roster: (departmentUid: string) =>
    apiFetch<DeptRoster>(`/departments/${departmentUid}/roster`),
  listWork: (departmentUid: string, q: {
    status?: string; priority?: string; employee_id?: string;
    from_date?: string; to_date?: string; search?: string;
    page?: number; limit?: number;
  }) =>
    apiFetch<{ items: Task[]; total: number; page: number; limit: number }>(
      `/departments/${departmentUid}/work`, { query: q }),
  allocateWork: (departmentUid: string, payload: AllocateWorkPayload) =>
    apiFetch<{ items: Task[] }>(`/departments/${departmentUid}/work`, {
      method: 'POST', body: payload }),
  performance: (departmentUid: string, from?: string, to?: string) =>
    apiFetch<DeptPerformance>(`/departments/${departmentUid}/performance`, {
      query: { from_date: from, to_date: to } }),
  calendar: (propertyUid: string, from: string, to: string, q?: {
    department_id?: string; employee_id?: string; zone_id?: string;
    status?: string; priority?: string; work_type?: string;
  }) =>
    apiFetch<{ items: Task[] }>('/tasks/calendar', {
      query: { property_id: propertyUid, from_date: from, to_date: to, ...q } }),
  attendanceHistory: (employeeUid: string, from: string, to: string) =>
    apiFetch<AttendanceHistory>(`/attendance/employees/${employeeUid}/history`, {
      query: { from, to } }),
};
