/**
 * Employee registration requests + organization code — super_admin only.
 * Requests arrive from the mobile app's public self-registration flow
 * (org-code verified server-side) and are decided here.
 */

import { apiFetch } from './client';
import { ListResponse } from './types';

export type RegistrationStatus = 'pending' | 'approved' | 'rejected';

export interface EmployeeRequest {
  request_uid: string;
  status: RegistrationStatus;
  full_name: string;
  username: string;
  email: string;
  phone: string | null;
  date_of_birth: string | null;
  gender: string | null;
  designation: string | null;
  department: string | null;
  employment_type: string | null;
  joining_date: string | null;
  reporting_manager: string | null;
  salary: string | null;
  salary_frequency: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
  created_employee_uid: string | null;
  property_uid: string | null;
  created_at: string;
}

export interface EmployeeRequestListParams {
  status?: RegistrationStatus;
  search?: string;
  page?: number;
  limit?: number;
}

export async function listEmployeeRequests(
  params: EmployeeRequestListParams = {},
): Promise<ListResponse<EmployeeRequest>> {
  return apiFetch<ListResponse<EmployeeRequest>>('/employee-requests', {
    query: params,
  });
}

export async function getEmployeeRequestsPendingCount(): Promise<{
  pending: number;
}> {
  return apiFetch<{ pending: number }>('/employee-requests/pending-count');
}

export async function getEmployeeRequest(
  request_uid: string,
): Promise<EmployeeRequest> {
  return apiFetch<EmployeeRequest>(`/employee-requests/${request_uid}`);
}

export interface ApproveEmployeeRequestBody {
  property_uid: string;
  zone_uid?: string | null;
  shift?: string | null;
  job_title?: string | null;
  department?: string | null;
  salary?: string | null;
  start_date?: string | null;
}

export async function approveEmployeeRequest(
  request_uid: string,
  body: ApproveEmployeeRequestBody,
): Promise<{
  request_uid: string;
  status: string;
  employee_uid: string;
  user_uid: string;
  username: string;
}> {
  return apiFetch(`/employee-requests/${request_uid}/approve`, {
    method: 'POST',
    body,
  });
}

export async function rejectEmployeeRequest(
  request_uid: string,
  reason: string | null,
): Promise<EmployeeRequest> {
  return apiFetch<EmployeeRequest>(`/employee-requests/${request_uid}/reject`, {
    method: 'POST',
    body: { reason },
  });
}

// --------------------------- Organization code ---------------------------

export async function getOrganizationCode(): Promise<{
  organization_code: string;
}> {
  return apiFetch<{ organization_code: string }>('/organization/code');
}

export async function regenerateOrganizationCode(): Promise<{
  organization_code: string;
}> {
  return apiFetch<{ organization_code: string }>(
    '/organization/code/regenerate',
    { method: 'POST' },
  );
}
