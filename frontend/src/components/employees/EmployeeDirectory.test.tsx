import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmployeeDirectory } from './EmployeeDirectory';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('../../context/AppContext', () => ({ useApp: () => ({
  currentPropertyEmployees: [{ employee_uid: 'employee-1', property_uid: 'property-1', name: 'Employee One', email: 'one@example.test', phone: '123', job_title: 'Housekeeper', department: 'Housekeeping', status: 'Active' }],
  currentPropertyZones: [], currentPropertyAreas: [], activePropertyUid: 'property-1', navigate,
}) }));
afterEach(cleanup);
beforeEach(() => navigate.mockReset());
describe('Employee directory profile links', () => {
  it('opens the canonical detail page from the employee name and card background', () => {
    render(<EmployeeDirectory />);
    fireEvent.click(screen.getByRole('button', { name: 'View employee profile for Employee One' }));
    expect(navigate).toHaveBeenLastCalledWith('/property/property-1/employees/employee-1');
    navigate.mockClear();
    fireEvent.click(screen.getByText('Housekeeper'));
    expect(navigate).toHaveBeenLastCalledWith('/property/property-1/employees/employee-1');
  });
  it('does not navigate when interacting with the allocation dropdown', () => {
    const { container } = render(<EmployeeDirectory />);
    const name = screen.getByRole('button', { name: 'View employee profile for Employee One' });
    const card = name.closest('[class*="cursor-pointer"]');
    const select = card?.querySelector('select');
    expect(select).toBeTruthy();
    fireEvent.click(select!);
    expect(navigate).not.toHaveBeenCalled();
    expect(container).toBeTruthy();
  });
});
