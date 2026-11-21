import { apiFetch } from './client';

export interface DepartmentHead {
  employee_uid: string;
  name: string;
}

export interface Department {
  department_uid: string;
  property_uid: string;
  name: string;
  code: string | null;
  description: string | null;
  status: 'active' | 'inactive';
  is_system: boolean;
  head: DepartmentHead | null;
  employee_count: number;
  active_employee_count: number;
  created_at: string | null;
}

export interface DepartmentEmployee {
  employee_uid: string;
  name: string;
  email: string;
  job_title: string | null;
  status: string;
  is_head: boolean;
}

export interface DepartmentDetail extends Department {
  employees: DepartmentEmployee[];
}

export interface DepartmentOverview {
  total_employees: number;
  active_employees: number;
  inactive_employees: number;
  total_departments: number;
  unassigned_employees: number;
  departments_without_head: number;
  avg_employees_per_department: number;
  departments: Department[];
}

export interface DepartmentTransferRecord {
  transfer_uid: string;
  employee_uid: string;
  employee_name: string | null;
  from_department_uid: string | null;
  from_department_name: string | null;
  to_department_uid: string | null;
  to_department_name: string | null;
  reason: string | null;
  changed_by_name: string | null;
  created_at: string | null;
}

export interface DepartmentTransferResult {
  transferred: number;
  transfer_uids: string[];
  head_decisions: string[];
}

export interface DepartmentCreateRequest {
  property_uid: string;
  name: string;
  code?: string | null;
  description?: string | null;
  status?: 'active' | 'inactive';
  head_employee_uid?: string | null;
}

export interface DepartmentUpdateRequest {
  name?: string;
  code?: string | null;
  description?: string | null;
  status?: 'active' | 'inactive';
  head_employee_uid?: string | null;
  clear_head?: boolean;
}

export async function listDepartments(params: {
  property_uid: string;
  include_inactive?: boolean;
  search?: string;
}): Promise<Department[]> {
  const { property_uid, ...rest } = params;
  return apiFetch<Department[]>('/departments', {
    query: { property_id: property_uid, ...rest },
  });
}

export async function departmentOverview(
  property_uid: string
): Promise<DepartmentOverview> {
  return apiFetch<DepartmentOverview>('/departments/overview', {
    query: { property_id: property_uid },
  });
}

export async function departmentDetail(uid: string): Promise<DepartmentDetail> {
  return apiFetch<DepartmentDetail>(`/departments/${uid}`);
}

export async function createDepartment(
  req: DepartmentCreateRequest
): Promise<Department> {
  return apiFetch<Department>('/departments', { method: 'POST', body: req });
}

export async function updateDepartment(
  uid: string,
  req: DepartmentUpdateRequest
): Promise<Department> {
  return apiFetch<Department>(`/departments/${uid}`, {
    method: 'PATCH',
    body: req,
  });
}

export async function deleteDepartment(uid: string): Promise<void> {
  return apiFetch<void>(`/departments/${uid}`, { method: 'DELETE' });
}

export async function assignDepartmentHead(
  uid: string,
  employee_uid: string | null
): Promise<Department> {
  return apiFetch<Department>(`/departments/${uid}/head`, {
    method: 'PUT',
    body: employee_uid ? { employee_uid } : null,
  });
}

export async function transferEmployees(req: {
  property_uid: string;
  employee_uids: string[];
  to_department_uid: string | null;
  reason?: string | null;
  head_action?: 'clear' | 'replace';
  replacement_head_uid?: string;
}): Promise<DepartmentTransferResult> {
  return apiFetch<DepartmentTransferResult>('/departments/transfer', {
    method: 'POST',
    body: req,
  });
}

export async function departmentTransfers(params: {
  property_uid: string;
  employee_id?: string;
  limit?: number;
}): Promise<DepartmentTransferRecord[]> {
  const { property_uid, ...rest } = params;
  return apiFetch<DepartmentTransferRecord[]>('/departments/transfers', {
    query: { property_id: property_uid, ...rest },
  });
}
