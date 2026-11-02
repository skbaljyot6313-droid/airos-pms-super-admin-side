import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmployeeDetailView, duration } from './EmployeeDetailView';
import { EmployeeAnalytics, EmployeeProfile, EmployeeTaskRecord, getEmployeeAnalytics, getEmployeeAttendanceCalendar, getEmployeeAttendanceDay, getEmployeeDevices, getEmployeeLocations, getEmployeeProfile, getEmployeeRecords, getEmployeeTasks } from '../../api/employees';
import { getTask } from '../../api/tasks';
import { Task } from '../../types';

const routing = vi.hoisted(() => ({ employeeUid: 'employee-1', propertyUid: 'property-1' }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (original) => ({ ...await original<typeof import('react-router-dom')>(), useParams: () => routing }));
vi.mock('../../context/AppContext', () => ({ useApp: () => ({ navigate }) }));
vi.mock('../../api/employees', () => ({
  getEmployeeProfile: vi.fn(), getEmployeeTasks: vi.fn(), getEmployeeRecords: vi.fn(),
  getEmployeeAnalytics: vi.fn(), getEmployeeLocations: vi.fn(),
  getEmployeeAttendanceCalendar: vi.fn(), getEmployeeAttendanceDay: vi.fn(), getEmployeeDevices: vi.fn(),
}));
vi.mock('../../api/tasks', () => ({ getTask: vi.fn() }));

const profile: EmployeeProfile = {
  employee: { employee_uid: 'employee-1', company_uid: 'company-1', property_uid: 'property-1', name: 'Employee One', email: 'employee@example.test', phone: '123', username: 'employee', job_title: 'Housekeeper', department: 'Housekeeping', status: 'Active', role: 'employee', joined_date: '2026-10-01', leave_balance_days: 4 },
  context: { property_name: 'Property', zone_name: 'Zone A', area_name: null },
  tasks: { allocated: 42, completed: 20, abandoned: 3, rejected: 2, current_open: 5, pending_review: 1 },
  attendance: { recorded_days: 4, present_days: 3, absent_days: 0, leave_days: 1, week_off_days: 0, recorded_work_seconds: 3600 },
  leave_requests: { pending_requests: 1, approved_requests: 2, rejected_requests: 0 },
};
const analytics: EmployeeAnalytics = {
  bucket: 'day',
  series: [{ bucket: '2026-10-20', allocated: 3, submitted: 2, approved: 2, disapproved: 0, pending: 0, abandoned: 1 }],
  submissions: { total: 10, approved: 7, disapproved: 2, pending: 1, approval_rate: 0.7778 },
  durations: { eligible: 0, unavailable: 0, median_seconds: null, buckets: { under_15_min: 0, min_15_30: 0, min_30_60: 0, over_60_min: 0 } },
  breakdown: { by_priority: { high: 4 }, by_type: { cleaning: 6 }, by_status: { completed: 5 } },
  review: { turnaround_median_seconds: 600, turnaround_avg_seconds: 700, reviewed: 8,
    first_attempt_decided: 6, first_attempt_approved: 5, first_attempt_approval_rate: 0.8333,
    tasks_with_rework: 1, tasks_with_attempts: 6 },
  maintenance: { allocated: 3, resolved: 2, open: 1, reassigned_away: 1, currently_assigned: 1,
    resolution_rate: 0.6667, median_resolution_seconds: 3600, by_zone: { 'Zone A': 2 } },
  attendance: { days: {}, truncated: false, present_with_hours: 0, total_work_seconds: 0,
    total_break_seconds: 0, incomplete: 0, avg_work_seconds: null },
  previous_period: { allocated: 10, submissions: 8, abandoned: 2, completed: 6 },
  kpis: {
    tasks_allocated: { current: 12, previous: 10 }, tasks_completed: { current: 8, previous: 6 },
    tasks_open: { current: 4, previous: null }, tasks_abandoned: { current: 2, previous: 3 },
    rejected_attempts: { current: 2, previous: 1 }, completion_rate: { current: 0.6667, previous: 0.6 },
    first_attempt_approval_rate: { current: 0.8333, previous: 0.8 }, rework_tasks: { current: 1, previous: 2 },
    review_turnaround_median_seconds: { current: 600, previous: 800 },
    maintenance_allocated: { current: 3, previous: 2 },
  },
  insights: [{ id: 'completion_up', severity: 'positive', text: 'Completed work rose to 8 tasks (from 6 in the previous period).' }],
  location: { by_zone: { 'Zone A': 5 }, by_area: {} },
  shift_adherence: { evaluated: 4, on_time: 3, late: 1, early_departures: 1, unclassified: 0,
    median_late_seconds: 600, avg_late_seconds: 600, days: [], trend: [] },
};
const allocRecord = {
  record_uid: 'alloc-1', ticket_kind: 'task', ticket_number: 'TASK-1', employee_name: 'Employee One',
  previous_employee_name: null, allocation_method: 'round_robin', reason: null, actor_name: 'Manager',
  created_at: '2026-10-20T05:00:00Z', employee_uid: 'employee-1', previous_employee_uid: null,
  work_uid: 'task-1', property_name: 'Property',
  lifecycle: { kind: 'task', current_status: 'assigned', submitted_at: null, submitted_by: null,
    submission_status: null, reviewed_at: null, reviewed_by: null, completed_at: null, abandoned_at: null },
};

afterEach(cleanup);
beforeEach(() => {
  routing.employeeUid = 'employee-1'; routing.propertyUid = 'property-1'; navigate.mockReset();
  vi.mocked(getEmployeeProfile).mockReset().mockResolvedValue(profile);
  vi.mocked(getEmployeeTasks).mockReset().mockResolvedValue({ items: [], total: 0, page: 1, limit: 25 });
  vi.mocked(getEmployeeRecords).mockReset().mockResolvedValue({ items: [allocRecord], total: 1, page: 1, limit: 25 });
  vi.mocked(getEmployeeAnalytics).mockReset().mockResolvedValue(analytics);
  vi.mocked(getEmployeeLocations).mockReset().mockResolvedValue({ zones: [{ name: 'Zone A', tasks: { allocated: 5, completed: 3, abandoned: 1, open: 1, completion_rate: 0.6 }, maintenance: { allocated: 0, resolved: 0 }, areas: [] }] });
  vi.mocked(getTask).mockReset();
});

describe('Employee analysis', () => {
  it('renders the identity header and KPI modules from server data', async () => {
    render(<EmployeeDetailView />);
    await screen.findByRole('heading', { name: 'Employee One' });
    expect(screen.getByText(/ID employee/)).toBeTruthy();
    expect(screen.getByText(/Housekeeper/)).toBeTruthy();
    const strip = await screen.findByRole('list', { name: 'Key metrics' });
    expect(within(strip).getByText('Allocated')).toBeTruthy();
    expect(within(strip).getByText('Completion rate')).toBeTruthy();
    expect(within(strip).getByText('12')).toBeTruthy();
    expect(getEmployeeProfile).toHaveBeenCalledWith('employee-1', 'property-1', expect.any(Object));
    expect(screen.getByText('Completed work rose to 8 tasks (from 6 in the previous period).')).toBeTruthy();
  });
  it('shows previous-period deltas without misleading signs', async () => {
    render(<EmployeeDetailView />);
    const strip = await screen.findByRole('list', { name: 'Key metrics' });
    expect(within(strip).getByText('+2 (+20%)')).toBeTruthy();         // allocated 12 vs 10
    expect(within(strip).getByText('-1 (-33%)')).toBeTruthy();         // abandoned 2 vs 3 — decrease is good
  });
  it('renders workload breakdown zones from the locations endpoint', async () => {
    render(<EmployeeDetailView />);
    await waitFor(() => expect(getEmployeeLocations).toHaveBeenCalledWith('employee-1', 'property-1', expect.any(Object)));
    const breakdown = await screen.findByRole('region', { name: 'Workload breakdown' });
    await within(breakdown).findByText('Zone A');
  });
  it('renders the allocations tab with lifecycle stepper and filters', async () => {
    render(<EmployeeDetailView />);
    await screen.findByRole('heading', { name: 'Employee One' });
    fireEvent.click(screen.getByRole('button', { name: 'Allocations' }));
    await screen.findByText('Assigned to Employee One');
    expect(screen.getByText('#TASK-1')).toBeTruthy();
    expect(screen.getByRole('img', { name: /Progress: Allocated/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reassigned away' }));
    await waitFor(() => expect(getEmployeeRecords).toHaveBeenLastCalledWith('employee-1', 'property-1', 'allocations', 1,
      expect.any(Object), { direction: 'away', ticket_kind: undefined }));
    fireEvent.click(screen.getByRole('button', { name: 'Maintenance' }));
    await waitFor(() => expect(getEmployeeRecords).toHaveBeenLastCalledWith('employee-1', 'property-1', 'allocations', 1,
      expect.any(Object), { direction: 'away', ticket_kind: 'maintenance' }));
  });
  it('applies the reporting period to analytics queries', async () => {
    render(<EmployeeDetailView />);
    await screen.findByRole('heading', { name: 'Employee One' });
    fireEvent.click(screen.getByRole('button', { name: /Last 30 days|All time/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Last 7 days' }));
    await waitFor(() => expect(getEmployeeAnalytics).toHaveBeenLastCalledWith('employee-1', 'property-1',
      expect.objectContaining({ date_from: expect.any(String), date_to: expect.any(String) }), 'day'));
  });
  it('shows a safe retry state instead of private backend errors', async () => {
    vi.mocked(getEmployeeProfile).mockRejectedValueOnce(new Error('private salary SQL stack'));
    render(<EmployeeDetailView />);
    await screen.findByRole('alert');
    expect(screen.queryByText('private salary SQL stack')).toBeNull();
    fireEvent.click(screen.getByText('Retry'));
    await screen.findByRole('heading', { name: 'Employee One' });
  });
  it('ignores a stale profile response after navigating to another employee', async () => {
    let finish!: (value: EmployeeProfile) => void;
    vi.mocked(getEmployeeProfile).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<EmployeeDetailView />);
    routing.employeeUid = 'employee-2';
    vi.mocked(getEmployeeProfile).mockResolvedValue({ ...profile, employee: { ...profile.employee, name: 'Employee Two' } });
    view.rerender(<EmployeeDetailView />);
    await screen.findByRole('heading', { name: 'Employee Two' });
    finish(profile);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Employee One' })).toBeNull());
  });
  it('does not fabricate durations when records are missing or invalid', () => {
    expect(duration(null)).toBe('Not available'); expect(duration(-1)).toBe('Not available');
    expect(duration(Infinity)).toBe('Not available'); expect(duration(0)).toBe('0h 0m 0s');
  });
});
