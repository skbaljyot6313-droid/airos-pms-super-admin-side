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

export const attendanceApi = {
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
