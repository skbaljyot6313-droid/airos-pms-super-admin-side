/**
 * ZoneBoard staff visibility — every assignable employee renders on the
 * board; attendance/floor eligibility no longer gates who is shown.
 * Non-assignable staff (deactivated / on leave) stay hidden.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ZoneBoard } from './ZoneBoard';

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
  {
    employee_uid: 'e3',
    name: 'Deactivated Staff',
    zone_uid: 'z1',
    area_uid: null,
    status: 'Deactivated',
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

describe('ZoneBoard staff visibility', () => {
  it('renders every assignable employee regardless of attendance', () => {
    render(<ZoneBoard onOpenCreateModal={() => {}} />);

    expect(screen.getByText('Clocked In')).toBeTruthy();
    expect(screen.getByText('Not On Duty')).toBeTruthy();
  });

  it('still hides non-assignable employees (deactivated)', () => {
    render(<ZoneBoard onOpenCreateModal={() => {}} />);

    expect(screen.queryByText('Deactivated Staff')).toBeNull();
  });
});
