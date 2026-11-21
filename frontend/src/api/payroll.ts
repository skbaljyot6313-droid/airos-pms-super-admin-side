/**
 * Payroll — Super Admin and HR. Calculations are server-side; this module only
 * reads, submits and triggers. Money is returned as decimal strings.
 */

import { apiFetch, BASE_URL } from './client';

export interface PayrollLineItem {
  line_uid: string;
  employee_uid: string | null;
  employee_name: string;
  status: 'calculated' | 'needs_review' | 'approved' | 'paid';
  gross: string;
  total_deductions: string;
  net: string;
  snapshot: {
    earnings?: { code: string; label: string; amount: string; basis?: string }[];
    deductions?: { code: string; label: string; amount: string; basis?: string }[];
    metrics?: Record<string, string | number>;
    notes?: string[];
    anomalies?: { date: string; reason: string }[];
  };
}

export interface HalfDayGroup {
  group_uid: string;
  employee_uid: string;
  employee_name: string;
  group_index: number;
  dates: string[];
  decision: 'cl' | 'lop' | 'cl_short' | null;
  cl_balance_at_decision: number | null;
  decided_by: string | null;
}

export interface PayrollPreviewRow {
  employee_uid: string;
  employee_name: string;
  calc_method: 'monthly' | 'daily' | 'hourly' | null;
  rate: string | null;
  rate_label: string | null;
  metrics: Record<string, string | number | Record<string, number>>;
  gross: string;
  total_deductions: string;
  net: string;
  anomalies: { date: string; reason: string }[];
}

export interface PayrollPeriodView {
  period_uid: string;
  period: string;
  status: 'open' | 'submitted' | 'approved' | 'paid';
  policy_uid: string | null;
  submitted_by: string | null;
  approved_by: string | null;
  paid_by: string | null;
  approved_at: string | null;
  paid_at: string | null;
  lines: PayrollLineItem[];
  half_day_groups: HalfDayGroup[];
}

export interface PayrollPolicy {
  policy_uid: string;
  name: string;
  effective_from: string;
  effective_until: string | null;
  config: Record<string, unknown>;
  created_by_name: string | null;
}

export interface SalaryStructure {
  structure_uid: string;
  calc_method: 'monthly' | 'daily' | 'hourly';
  effective_from: string;
  effective_until: string | null;
  basic: string;
  hra: string;
  allowances: { name: string; amount: string }[];
  incentive: string;
  overtime_rate: string;
  deductions: { code: string; mode: string; value: string; basis?: string; ceiling?: string | null }[];
  created_by_name: string | null;
}

export const payrollApi = {
  getPeriod: (propertyUid: string, period: string) =>
    apiFetch<PayrollPeriodView>(`/payroll/periods/${period}`, { query: { property_uid: propertyUid } }),
  generate: (propertyUid: string, period: string) =>
    apiFetch<PayrollPeriodView>(`/payroll/periods/${period}/generate`, {
      method: 'POST', query: { property_uid: propertyUid },
    }),
  submit: (propertyUid: string, period: string) =>
    apiFetch<PayrollPeriodView>(`/payroll/periods/${period}/submit`, {
      method: 'POST', query: { property_uid: propertyUid },
    }),
  approve: (propertyUid: string, period: string) =>
    apiFetch<PayrollPeriodView>(`/payroll/periods/${period}/approve`, {
      method: 'POST', query: { property_uid: propertyUid },
    }),
  markPaid: (propertyUid: string, period: string, payment?: { payment_method?: string; payment_reference?: string }) =>
    apiFetch<PayrollPeriodView>(`/payroll/periods/${period}/paid`, {
      method: 'POST', query: { property_uid: propertyUid }, body: payment ?? {},
    }),
  payLine: (lineUid: string, payment?: { payment_method?: string; payment_reference?: string }) =>
    apiFetch<PayrollLineItem>(`/payroll/lines/${lineUid}/pay`, { method: 'POST', body: payment ?? {} }),
  decideGroup: (groupUid: string, decision: 'cl' | 'lop') =>
    apiFetch<{ group_uid: string; decision: string; cl_balance_at_decision: number }>(
      `/payroll/groups/${groupUid}/decide`, { method: 'POST', body: { decision } }),
  exportCsvUrl: (propertyUid: string, period: string) =>
    `${BASE_URL}/payroll/periods/${period}/export.csv?property_uid=${propertyUid}`,
  adjust: (lineUid: string, amount: string, reason: string) =>
    apiFetch(`/payroll/lines/${lineUid}/adjustments`, { method: 'POST', body: { amount, reason } }),
  slipUrl: (lineUid: string) => `${BASE_URL}/payroll/lines/${lineUid}/slip.pdf`,
  listPolicies: (propertyUid: string) =>
    apiFetch<{ items: PayrollPolicy[] }>('/payroll/policies', { query: { property_uid: propertyUid } }),
  createPolicy: (body: { property_uid: string; name: string; effective_from: string; config: Record<string, unknown> }) =>
    apiFetch<PayrollPolicy>('/payroll/policies', { method: 'POST', body }),
  listStructures: (employeeUid: string) =>
    apiFetch<{ items: SalaryStructure[] }>(`/payroll/employees/${employeeUid}/structures`),
  createStructure: (employeeUid: string, body: Record<string, unknown>) =>
    apiFetch<SalaryStructure>(`/payroll/employees/${employeeUid}/structures`, { method: 'POST', body }),
  postLeaveEntries: (employeeUid: string, entries: { leave_type: string; days: number; reason?: string }[]) =>
    apiFetch<{ items: { leave_type: string; days: number }[] }>(
      `/payroll/employees/${employeeUid}/leave-entries`, { method: 'POST', body: { entries } }),
  getPreview: (propertyUid: string, period: string) =>
    apiFetch<{ items: PayrollPreviewRow[] }>(`/payroll/periods/${period}/preview`, {
      query: { property_uid: propertyUid } }),
};
