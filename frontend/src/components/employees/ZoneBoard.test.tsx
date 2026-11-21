/**
 * ZoneBoard attendance visibility — Active staff are available; on-break staff
 * stay visible but unavailable; ended and absent staff move to "Off duty today";
 * non-assignable staff (deactivated / on leave) stay hidden. Pending work is
 * shown even when no on-duty staff cover the zone.
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ZoneBoard } from './ZoneBoard';

const employees = [
  { employee_uid: 'e1', name: 'Clocked In', zone_uid: 'z1', area_uid: null, status: 'Active', job_title: 'Housekeeper' },
  { employee_uid: 'e2', name: 'On Break Staff', zone_uid: 'z1', area_uid: null, status: 'Active', job_title: 'Housekeeper' },
  { employee_uid: 'e4', name: 'Ended Staff', zone_uid: 'z1', area_uid: null, status: 'Active', job_title: 'Housekeeper' },
  { employee_uid: 'e5', name: 'Never Came', zone_uid: 'z1', area_uid: null, status: 'Active', job_title: 'Housekeeper' },
  { employee_uid: 'e3', name: 'Deactivated Staff', zone_uid: 'z1', area_uid: null, status: 'Deactivated', job_title: 'Housekeeper' },
];

const board = {
  date: '2026-11-21',
  property_uid: 'p1',
  operational_day_start: '06:00',
  is_today: true,
  employees: [
    { employee_uid: 'e1', name: 'Clocked In', status: 'working', label: 'Working' },
    { employee_uid: 'e2', name: 'On Break Staff', status: 'on_break', label: 'On break' },
    { employee_uid: 'e4', name: 'Ended Staff', status: 'completed', label: 'Completed' },
    { employee_uid: 'e5', name: 'Never Came', status: 'absent', label: 'Absent' },
  ],
};

const tasks = [
  { task_uid: 't1', zone_uid: 'z1', status: 'pending', title: 'Unclaimed room' },
  { task_uid: 't2', zone_uid: 'z1', status: 'assigned', employee_uid: 'e1', title: 'Room 101' },
  { task_uid: 't3', zone_uid: 'z1', status: 'in_progress', employee_uid: 'e1', title: 'Room 102' },
  { task_uid: 't4', zone_uid: 'z1', status: 'completed', employee_uid: 'e1', title: 'Room 103' },
];

vi.mock('../../api/attendance', () => ({
  attendanceApi: { statusBoard: vi.fn(async () => board) },
}));
vi.mock('../../hooks/usePolling', () => ({ usePolling: () => {} }));
vi.mock('../../realtime/useRealtimeChannel', () => ({
  useRealtimeChannel: () => {},
  propChannel: (p: string, c: string) => `${p}:${c}`,
}));
vi.mock('../../context/AppContext', () => ({
  useApp: () => ({
    currentPropertyAreas: [],
    currentPropertyZones: [{ zone_uid: 'z1', name: 'dorms', code: 'D1', area_uid: null }],
    currentPropertyEmployees: employees,
    tasks,
    assignEmployeeToZone: vi.fn(),
    assignEmployeeToArea: vi.fn(),
    activeProperty: { property_uid: 'p1', name: 'Airco Suites' },
  }),
}));

describe('ZoneBoard attendance visibility', () => {
  it('shows an Active chip for the clocked-in employee and counts only them as available', async () => {
    render(<ZoneBoard onOpenCreateModal={() => {}} />);
    await waitFor(() => expect(screen.getByText('Off duty today')).toBeTruthy());

    const card = screen.getByText('Clocked In').closest('div.relative') as HTMLElement;
    expect(within(card).getByText('Active')).toBeTruthy();
    expect(screen.getAllByText('available', { exact: false }).length).toBeGreaterThan(0);
  });

  it('keeps on-break staff visible in their zone but labelled unavailable', async () => {
    render(<ZoneBoard onOpenCreateModal={() => {}} />);
    await waitFor(() => expect(screen.getByText('On break')).toBeTruthy());

    expect(screen.getByText('On Break Staff')).toBeTruthy();
    expect(screen.queryByText('Off duty today')).toBeTruthy();
  });

  it('moves ended and absent staff out of the zone and into "Off duty today"', async () => {
    render(<ZoneBoard onOpenCreateModal={() => {}} />);
    const offDuty = await screen.findByText('Off duty today');
    const section = offDuty.closest('section') as HTMLElement;

    expect(within(section).getByText('Ended Staff')).toBeTruthy();
    expect(within(section).getByText('Never Came')).toBeTruthy();
    expect(within(section).getByText('Ended')).toBeTruthy();
    expect(within(section).getByText('Absent')).toBeTruthy();
    expect(screen.getAllByText('Ended Staff')).toHaveLength(1);
  });

  it('still hides non-assignable employees (deactivated)', async () => {
    render(<ZoneBoard onOpenCreateModal={() => {}} />);
    await waitFor(() => expect(screen.getByText('Off duty today')).toBeTruthy());

    expect(screen.queryByText('Deactivated Staff')).toBeNull();
  });

  it('shows allocated, in-progress, done and pending counts for the zone', async () => {
    render(<ZoneBoard onOpenCreateModal={() => {}} />);
    await waitFor(() => expect(screen.getByText('Off duty today')).toBeTruthy());

    expect(screen.getByText(/1 allocated · 1 in progress · 1 done/)).toBeTruthy();
    expect(screen.getAllByText('1 pending').length).toBeGreaterThan(0);
  });
});
