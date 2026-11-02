import { apiFetch } from './client';
import { Employee } from '../types';
import {
  EmployeeCreateRequest,
  EmployeeUpdateRequest,
  EmployeeZoneAssignRequest,
  ListResponse,
} from './types';

export interface EmployeeListParams {
  property_uid?: string;
  zone_uid?: string;
  department?: string;
  status?: string;
  search?: string;
}

export async function listEmployees(
  params: EmployeeListParams = {}
): Promise<ListResponse<Employee>> {
  return apiFetch<ListResponse<Employee>>('/employees', { query: params });
}

export async function createEmployee(req: EmployeeCreateRequest): Promise<Employee> {
  return apiFetch<Employee>('/employees', { method: 'POST', body: req });
}

export async function updateEmployee(
  employee_uid: string,
  req: EmployeeUpdateRequest
): Promise<Employee> {
  return apiFetch<Employee>(`/employees/${employee_uid}`, { method: 'PATCH', body: req });
}

/** Zone assignment — used by drag-and-drop board and the dropdown fallback. */
export async function assignEmployeeToZone(
  employee_uid: string,
  zone_uid: string | null
): Promise<Employee> {
  return apiFetch<Employee>(`/employees/${employee_uid}/zone`, {
    method: 'PATCH',
    body: { zone_uid } satisfies EmployeeZoneAssignRequest,
  });
}

/** Area assignment — employee covers every zone inside the area. */
export async function assignEmployeeToArea(
  employee_uid: string,
  area_uid: string | null
): Promise<Employee> {
  return apiFetch<Employee>(`/employees/${employee_uid}/zone`, {
    method: 'PATCH',
    body: { zone_uid: null, area_uid } satisfies EmployeeZoneAssignRequest,
  });
}

export async function deactivateEmployee(employee_uid: string): Promise<Employee> {
  return apiFetch<Employee>(`/employees/${employee_uid}/deactivate`, { method: 'POST' });
}

export async function reactivateEmployee(employee_uid: string): Promise<Employee> {
  return apiFetch<Employee>(`/employees/${employee_uid}/reactivate`, { method: 'POST' });
}

export type EmployeeTaskFilter = 'all' | 'allocated' | 'completed' | 'abandoned' | 'rejected' | 'pending_review' | 'current_open';
export type EmployeeRecordKind = 'attendance' | 'leaves' | 'shifts' | 'allocations' | 'submissions' | 'maintenance';
export interface EmployeeProfile {
  employee: Employee;
  context: { property_name: string; zone_name: string | null; area_name: string | null };
  tasks: Record<Exclude<EmployeeTaskFilter, 'all'>, number>;
  attendance: { recorded_days: number; present_days: number; absent_days: number; leave_days: number; week_off_days: number; recorded_work_seconds: number | null };
  leave_requests: { pending_requests: number; approved_requests: number; rejected_requests: number };
}
export interface EmployeeTaskRecord {
  task_uid: string; title: string; ticket_number: string | null; property_uid: string; property_name: string;
  current_status: string; current_assignee: string | null; created_at: string;
  completed_at: string | null; abandoned_at: string | null; abandoned_reason: string | null;
  submission_uid: string | null; submitted_at: string | null; review_status: string | null; attempt_number?: number | null;
  reviewed_at: string | null; reviewed_by: string | null; review_comment: string | null;
  recorded_start_at: string | null; start_to_submission_seconds: number | null;
  assignment_changed_during_attempt: boolean; start_assignment_matches_employee: boolean | null;
}
export interface EmployeePage<T> { items: T[]; total: number; page: number; limit: number }
export type EmployeeRecord = Record<string, unknown> & { record_uid: string };
export interface DateBounds { date_from?: string; date_to?: string }
export const getEmployeeProfile = (id: string, propertyId: string, bounds: DateBounds = {}) =>
  apiFetch<EmployeeProfile>(`/employees/${encodeURIComponent(id)}/profile`, { query: { property_id: propertyId, ...bounds } });
export const getEmployeeTasks = (id: string, propertyId: string, filters: { filter: EmployeeTaskFilter; search?: string; page: number } & DateBounds) =>
  apiFetch<EmployeePage<EmployeeTaskRecord>>(`/employees/${encodeURIComponent(id)}/tasks`, { query: { property_id: propertyId, ...filters, limit: 25 } });
export interface KpiValue { current: number | null; previous: number | null }
export interface EmployeeInsight { id: string; severity: 'positive' | 'warning' | 'neutral'; text: string }
export interface ShiftDay {
  date: string; shift_name: string; scheduled_start: string | null; scheduled_end: string | null;
  actual_start: string | null; actual_end: string | null;
  arrival_deviation_seconds: number | null; departure_deviation_seconds: number | null;
  arrival: 'on_time' | 'late'; early_departure: boolean;
}
export interface EmployeeAnalytics {
  bucket: 'day' | 'week' | 'month';
  series: { bucket: string; allocated: number; submitted: number; approved: number; disapproved: number; pending: number; abandoned: number }[];
  submissions: { total: number; approved: number; disapproved: number; pending: number; approval_rate: number | null };
  durations: { eligible: number; unavailable: number; median_seconds: number | null; buckets: { under_15_min: number; min_15_30: number; min_30_60: number; over_60_min: number } };
  breakdown: { by_priority: Record<string, number>; by_type: Record<string, number>; by_status: Record<string, number> };
  review: { turnaround_median_seconds: number | null; turnaround_avg_seconds: number | null; reviewed: number;
    first_attempt_decided: number; first_attempt_approved: number; first_attempt_approval_rate: number | null;
    tasks_with_rework: number; tasks_with_attempts: number };
  maintenance: { allocated: number; resolved: number; open: number; reassigned_away: number;
    currently_assigned: number; resolution_rate: number | null;
    median_resolution_seconds: number | null; by_zone: Record<string, number> };
  attendance: { days: Record<string, { status: string; started_at: string | null; ended_at: string | null; work_seconds: number | null }>;
    truncated: boolean; present_with_hours: number;
    total_work_seconds: number; total_break_seconds: number; incomplete: number; avg_work_seconds: number | null };
  previous_period: { allocated: number; submissions: number; abandoned: number; completed?: number } | null;
  kpis: {
    tasks_allocated: KpiValue; tasks_completed: KpiValue; tasks_open: KpiValue;
    tasks_abandoned: KpiValue; rejected_attempts: KpiValue; completion_rate: KpiValue;
    first_attempt_approval_rate: KpiValue; rework_tasks: KpiValue;
    review_turnaround_median_seconds: KpiValue; maintenance_allocated: KpiValue;
  };
  insights: EmployeeInsight[];
  location: { by_zone: Record<string, number>; by_area: Record<string, number> };
  shift_adherence: { evaluated: number; on_time: number; late: number; early_departures: number;
    unclassified: number; median_late_seconds: number | null; avg_late_seconds: number | null;
    days: ShiftDay[]; trend: { bucket: string; on_time: number; late: number }[] };
}
export const getEmployeeAnalytics = (id: string, propertyId: string, bounds: DateBounds = {}, bucket: 'day' | 'week' | 'month' = 'day') =>
  apiFetch<EmployeeAnalytics>(`/employees/${encodeURIComponent(id)}/analytics`, { query: { property_id: propertyId, ...bounds, bucket } });

export interface LocationTasks { allocated: number; completed: number; abandoned: number; open: number; completion_rate?: number | null }
export interface LocationUnit { label: string; kind: 'room' | 'dorm' | 'washroom'; tasks: LocationTasks }
export interface LocationArea { name: string; tasks: LocationTasks; units: LocationUnit[] }
export interface LocationZone { name: string; tasks: LocationTasks; maintenance: { allocated: number; resolved: number }; areas: LocationArea[] }
export interface EmployeeLocations { zones: LocationZone[] }
export const getEmployeeLocations = (id: string, propertyId: string, bounds: DateBounds = {}) =>
  apiFetch<EmployeeLocations>(`/employees/${encodeURIComponent(id)}/locations`, { query: { property_id: propertyId, ...bounds } });

export interface AttendanceCalendarDay { status: string; started_at: string | null; ended_at: string | null; work_seconds: number | null; break_seconds: number | null; incomplete: boolean }
export interface AttendanceCalendar {
  month: string;
  days: Record<string, AttendanceCalendarDay>;
  summary: { present: number; absent: number; leave: number; week_off: number; incomplete: number; recorded: number; total_work_seconds: number; total_break_seconds: number };
}
export const getEmployeeAttendanceCalendar = (id: string, propertyId: string, month: string) =>
  apiFetch<AttendanceCalendar>(`/employees/${encodeURIComponent(id)}/attendance/calendar`, { query: { property_id: propertyId, month } });

export interface AttendanceDayDetail {
  date: string;
  record: { status: string; started_at: string | null; ended_at: string | null; work_seconds: number | null; break_seconds: number | null; incomplete: boolean } | null;
  breaks: { started_at: string | null; ended_at: string | null; duration_seconds: number | null }[];
  shift: { name: string; start: string | null; end: string | null; grace_minutes?: number; early_exit_minutes?: number; not_scheduled?: boolean } | null;
  leave: { request_type: string; leave_type: string | null; status: string; reason: string | null } | null;
}
export const getEmployeeAttendanceDay = (id: string, propertyId: string, date: string) =>
  apiFetch<AttendanceDayDetail>(`/employees/${encodeURIComponent(id)}/attendance/day`, { query: { property_id: propertyId, date } });

export interface TeamAnalyticsRow {
  employee_uid: string; name: string; job_title: string | null; status: string | null;
  zone_name: string | null; allocated: number; completed: number; abandoned: number;
  open: number; completion_rate: number | null;
}
export interface TeamAnalytics {
  employees: TeamAnalyticsRow[]; total: number;
  team: { allocated: number; completed: number; abandoned: number; open: number };
}
export const getTeamAnalytics = (propertyId: string, bounds: DateBounds = {}) =>
  apiFetch<TeamAnalytics>('/employees/team-analytics', { query: { property_id: propertyId, ...bounds } });

export interface EmployeeDevices {
  available?: boolean;
  devices: { device_id: string; platform: string; app_version: string | null; is_active: boolean; registered_at: string | null; last_seen_at: string | null }[];
  latest_release: { platform: string; version: string; force_update: boolean } | null;
  tracking: { sessions: number; active_session: boolean; last_session_started: string | null; last_session_ended: string | null; last_event_at: string | null; last_event_source: string | null };
}
export const getEmployeeDevices = (id: string, propertyId: string) =>
  apiFetch<EmployeeDevices>(`/employees/${encodeURIComponent(id)}/devices`, { query: { property_id: propertyId } });
export const getEmployeeRecords = (id: string, propertyId: string, kind: EmployeeRecordKind, page: number, bounds: DateBounds = {},
    opts: { direction?: 'received' | 'away'; ticket_kind?: 'task' | 'maintenance' } = {}) =>
  apiFetch<EmployeePage<EmployeeRecord>>(`/employees/${encodeURIComponent(id)}/records`, { query: { property_id: propertyId, kind, page, limit: 25, ...bounds, ...opts } });

export async function deleteEmployee(employee_uid: string): Promise<void> {
  return apiFetch<void>(`/employees/${employee_uid}`, { method: 'DELETE' });
}
