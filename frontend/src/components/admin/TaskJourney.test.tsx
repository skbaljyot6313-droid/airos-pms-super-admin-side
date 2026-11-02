import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskJourney, elapsedTaskTime } from './TaskJourney';
import { findJourneyTasks, getTaskJourney, JourneyTask, TaskJourneyResponse } from '../../api/logs';

vi.mock('../../context/AppContext', () => ({ useApp: () => ({ companyProperties: [{ property_uid: 'property-1', name: 'Hotel' }] }) }));
vi.mock('../../api/logs', async (original) => ({ ...await original<typeof import('../../api/logs')>(), findJourneyTasks: vi.fn(), getTaskJourney: vi.fn() }));
const task: JourneyTask = { task_uid: 'task-1', title: 'Clean workstation', ticket_number: 'TASK-2026-1', property_uid: 'property-1', property_name: 'Hotel', status: 'completed', assignee_name: 'Current employee', zone_name: 'Ground floor', created_at: '2026-10-29T03:00:00Z', submitted_at: null, completed_at: '2026-10-29T05:00:00Z', abandoned_at: null, abandoned_reason: null };
const response: TaskJourneyResponse = { task, history_types: ['started'], events: { items: [{ log_uid: 'task_history:1', action: 'started', category: 'task', occurred_at: '2026-10-29T04:00:00Z', actor_name: 'Historical employee', entity_type: 'task', entity_uid: 'task-1', entity_name: 'Clean workstation', property_uid: 'property-1', property_name: 'Hotel', detail: {} }], total: 1, page: 1, limit: 50 } };
afterEach(cleanup);
beforeEach(() => {
  vi.mocked(findJourneyTasks).mockReset(); vi.mocked(findJourneyTasks).mockResolvedValue({ items: [task], total: 1, page: 1, limit: 25 });
  vi.mocked(getTaskJourney).mockReset(); vi.mocked(getTaskJourney).mockResolvedValue(response);
});

describe('Task Journey', () => {
  it('searches tasks server-side and opens the selected journey', async () => {
    render(<TaskJourney initialProperty="property-1" />);
    fireEvent.change(screen.getByLabelText('Search task journeys'), { target: { value: 'TASK-2026' } });
    await screen.findByRole('button', { name: 'Open journey for Clean workstation' });
    expect(findJourneyTasks).toHaveBeenLastCalledWith({ search: 'TASK-2026', property_id: 'property-1', status: undefined }, 1);
    fireEvent.click(screen.getByRole('button', { name: 'Open journey for Clean workstation' }));
    await screen.findByRole('region', { name: 'Activity timeline' });
    expect(getTaskJourney).toHaveBeenCalledWith('task-1', 1);
  });
  it('does not derive current state or fabricate completion from the last event', async () => {
    render(<TaskJourney initialTaskId="task-1" />);
    const summary = await screen.findByRole('region', { name: 'Current task summary' });
    expect(within(summary).getByText('Completed')).toBeTruthy();
    expect(within(summary).getByText('Current employee')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Work started' })).toBeTruthy();
    expect(screen.getByText('Historical employee')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Work completed' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Activity timeline' }).querySelector('li')?.className).toContain('border-l');
  });
  it('keeps task history paginated oldest-first', async () => {
    vi.mocked(getTaskJourney).mockResolvedValue({ ...response, events: { ...response.events, total: 51 } });
    render(<TaskJourney initialTaskId="task-1" />);
    await screen.findByText('51 recorded events · Oldest first');
    fireEvent.click(screen.getByText('Later events'));
    await waitFor(() => expect(getTaskJourney).toHaveBeenLastCalledWith('task-1', 2));
  });
  it('honestly shows history gaps and no synthetic events', async () => {
    vi.mocked(getTaskJourney).mockResolvedValue({ ...response, history_types: [], events: { ...response.events, total: 0, items: [] } });
    render(<TaskJourney initialTaskId="task-1" />);
    await screen.findByText(/No available lifecycle events/);
    expect(screen.getByText(/History gap/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Activity timeline' })).toBeNull();
  });
  it('has a safe retry state', async () => {
    vi.mocked(getTaskJourney).mockRejectedValueOnce(new Error('internal SQL details'));
    render(<TaskJourney initialTaskId="task-1" />);
    await screen.findByText('Unable to load this task journey.');
    expect(screen.queryByText('internal SQL details')).toBeNull();
    fireEvent.click(screen.getByText('Retry journey'));
    await screen.findByRole('region', { name: 'Activity timeline' });
  });
  it('calculates duration only for a valid current terminal outcome', () => {
    expect(elapsedTaskTime(task)).toBe('2 hr 0 min 0 sec');
    expect(elapsedTaskTime({ ...task, status: 'reopened' })).toBeNull();
    expect(elapsedTaskTime({ ...task, completed_at: null })).toBeNull();
    expect(elapsedTaskTime({ ...task, completed_at: '2026-10-01T00:00:00Z' })).toBeNull();
  });
});
