/**
 * Attendance — Super Admin leave/week-off request review.
 * Requests are filed in the employee app; this is the decision surface.
 */

import { apiFetch } from './client';
import type { ListResponse } from './types';

export type AttendanceRequestType = 'leave' | 'week_off';
export type AttendanceRequestStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled';

export interface AttendanceRequest {
  request_uid: string;
  property_uid: string;
  employee_uid: string | null;
  employee_name: string;
  from_date: string;
  to_date: string;
  request_type: AttendanceRequestType;
  leave_type: string | null;
  reason: string | null;
  requested_days: number;
  status: AttendanceRequestStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_comment: string | null;
  created_at: string | null;
}

/** Schedule-aware per-employee evaluation for one IST operational day. */
export interface DayStatusItem {
  employee_uid: string;
  name: string;
  job_title: string | null;
  status:
    | 'working'
    | 'on_break'
    | 'completed'
    | 'absent'
    | 'awaiting'
    | 'scheduled'
    | 'off_day'
    | 'incomplete'
    | 'not_scheduled';
  label: string;
  scheduled: boolean;
  /** SA/PM-linked staff — work 24×7 by default, never scheduled/absent. */
  schedule_exempt: boolean;
  /** Open, non-stale attendance day — the floor-visibility rule. */
  floor_eligible: boolean;
  unscheduled: boolean;
  arrival: 'on_time' | 'late' | null;
  departure: 'on_time' | 'early' | null;
  needs_review: boolean;
  shift_name: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  started_at: string | null;
  ended_at: string | null;
  work_seconds: number | null;
  attendance_status: string | null;
}

export interface DayStatusBoard {
  date: string;
  property_uid: string;
  operational_day_start: string;
  is_today: boolean;
  employees: DayStatusItem[];
}

export const attendanceApi = {
  statusBoard: (property_uid: string, date?: string) =>
    apiFetch<DayStatusBoard>('/attendance/status-board', {
      query: { property_id: property_uid, date },
    }),
  listRequests: (status?: AttendanceRequestStatus) =>
    apiFetch<ListResponse<AttendanceRequest>>('/attendance/requests', {
      query: { status },
    }),
  approve: (request_uid: string, review_comment?: string) =>
    apiFetch<AttendanceRequest>(
      `/attendance/requests/${request_uid}/approve`,
      { method: 'POST', body: { review_comment } }
    ),
  reject: (request_uid: string, review_comment?: string) =>
    apiFetch<AttendanceRequest>(
      `/attendance/requests/${request_uid}/reject`,
      { method: 'POST', body: { review_comment } }
    ),
};
