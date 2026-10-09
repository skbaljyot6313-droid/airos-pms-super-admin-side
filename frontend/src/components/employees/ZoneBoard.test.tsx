/**
 * ZoneBoard floor-visibility tests — cards render only for employees the
 * backend status board marks floor_eligible (open, non-stale attendance
 * day). Fails closed while loading and on API error.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ZoneBoard } from './ZoneBoard';

const statusBoard = vi.fn();
vi.mock('../../api/attendance', () => ({
  attendanceApi: {
    statusBoard: (...a: unknown[]) => statusBoard(...a),
  },
}));

const employees = [
  {
    employee_uid: 'e1',
    name: 'Clocked In',
    zone_uid: 'z1',
    area_uid: null,
    status: 'Active',
    job_title: 'Housekeeper',
  },
  {
    employee_uid: 'e2',
    name: 'Not On Duty',
    zone_uid: 'z1',
    area_uid: null,
    status: 'Active',
    job_title: 'Housekeeper',
  },
];

vi.mock('../../context/AppContext', () => ({
  useApp: () => ({
    currentPropertyAreas: [],
    currentPropertyZones: [
      { zone_uid: 'z1', name: 'dorms', code: 'D1', area_uid: null },
    ],
    currentPropertyEmployees: employees,
    tasks: [],
    assignEmployeeToZone: vi.fn(),
    assignEmployeeToArea: vi.fn(),
    activeProperty: { property_uid: 'p1', name: 'Airco Suites' },
  }),
}));

const board = (eligible: string[]) => ({
  date: '2026-10-22',
  property_uid: 'p1',
  operational_day_start: '06:00',
  is_today: true,
  employees: employees.map((e) => ({
    employee_uid: e.employee_uid,
    name: e.name,
    job_title: e.job_title,
    status: eligible.includes(e.employee_uid) ? 'working' : 'not_scheduled',
    label: 'Working',
    scheduled: true,
    floor_eligible: eligible.includes(e.employee_uid),
    unscheduled: false,
    arrival: null,
    departure: null,
    needs_review: false,
    shift_name: 'Day',
    scheduled_start: '09:00',
    scheduled_end: '18:00',
    started_at: null,
    ended_at: null,
    work_seconds: null,
    attendance_status: null,
  })),
});

describe('ZoneBoard floor eligibility', () => {
  beforeEach(() => {
    statusBoard.mockReset();
  });

  it('renders only employees the backend marks floor_eligible', async () => {
    statusBoard.mockResolvedValue(board(['e1']));
    render(<ZoneBoard onOpenCreateModal={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText('Clocked In')).toBeTruthy()
    );
    expect(screen.queryByText('Not On Duty')).toBeNull();
    expect(statusBoard).toHaveBeenCalledWith('p1');
  });

  it('fails closed when the status board is empty', async () => {
    statusBoard.mockResolvedValue(board([]));
    render(<ZoneBoard onOpenCreateModal={() => {}} />);

    await waitFor(() => expect(statusBoard).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByText('Clocked In')).toBeNull()
    );
    expect(screen.queryByText('Not On Duty')).toBeNull();
  });

  it('fails closed when the status board request fails', async () => {
    statusBoard.mockRejectedValue(new Error('boom'));
    render(<ZoneBoard onOpenCreateModal={() => {}} />);

    await waitFor(() => expect(statusBoard).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByText('Clocked In')).toBeNull()
    );
  });
});
