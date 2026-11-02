import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogsView } from './LogsView';
import { ActivityRow } from './ActivityEvent';
import { ActivityLog, getLogAttachment, listLogs } from '../../api/logs';

vi.mock('../../context/AppContext', () => ({ useApp: () => ({ companyProperties: [{ property_uid: 'property-1', name: 'Zostel Mumbai' }] }) }));
vi.mock('../../api/logs', async (original) => ({ ...await original<typeof import('../../api/logs')>(), listLogs: vi.fn(), getLogAttachment: vi.fn() }));
const event: ActivityLog = { log_uid: 'allocation:1', occurred_at: '2026-10-29T10:30:15Z', category: 'allocation', action: 'manual', actor_name: 'Manager', entity_type: 'task', entity_uid: 'task-1', entity_name: 'Clean room 101', property_uid: 'property-1', property_name: 'Zostel Mumbai', detail: { assigned_to: 'Staff member' } };
const response = { items: [event], total: 1, page: 1, limit: 50 };
afterEach(cleanup);
beforeEach(() => {
  vi.mocked(listLogs).mockReset(); vi.mocked(listLogs).mockResolvedValue(response);
  vi.mocked(getLogAttachment).mockReset(); vi.mocked(getLogAttachment).mockResolvedValue(new Blob(['image'], { type: 'image/jpeg' }));
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:attachment') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});
function open() { render(<LogsView />); fireEvent.click(screen.getByRole('button', { name: 'View logs for Zostel Mumbai' })); }
async function ready() { await screen.findByRole('heading', { name: 'Work assigned manually' }); }

describe('Activity Logs', () => {
  it('lists properties before requesting events', () => { render(<LogsView />); expect(listLogs).not.toHaveBeenCalled(); expect(screen.getByText('Zostel Mumbai')).toBeTruthy(); });
  it('scopes the first query and provides structured details', async () => {
    open(); await ready(); expect(listLogs).toHaveBeenLastCalledWith({ property_id: 'property-1' }, 1, 50);
    expect(screen.getByText('Manager')).toBeTruthy(); expect(screen.getByText(/04:00:15/)).toBeTruthy();
    expect(screen.queryByText('allocation:1')).toBeNull(); fireEvent.click(screen.getByText('View details'));
    expect(screen.getByText('Event summary')).toBeTruthy(); expect(screen.getByText('Affected entity')).toBeTruthy();
    expect(screen.getByText('Assigned to')).toBeTruthy();
    fireEvent.click(screen.getByText('Back to properties')); expect(screen.queryByRole('list', { name: 'Activity feed' })).toBeNull();
  });
  it('debounces search and filters actor/category against the server', async () => {
    open(); await ready(); fireEvent.change(screen.getByLabelText('Search logs'), { target: { value: 'room' } });
    fireEvent.change(screen.getByLabelText('Actor name'), { target: { value: 'Manager' } });
    fireEvent.change(screen.getByLabelText('Activity type'), { target: { value: 'task' } });
    await waitFor(() => expect(listLogs).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'room', actor: 'Manager', category: 'task', property_id: 'property-1' }), 1, 50));
    fireEvent.click(screen.getByLabelText('Clear search'));
    await waitFor(() => expect(listLogs).toHaveBeenLastCalledWith(expect.objectContaining({ search: undefined, actor: 'Manager' }), 1, 50));
  });
  it('converts inclusive custom IST dates', async () => {
    open(); await ready(); fireEvent.change(screen.getByLabelText('Date range'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('From date (IST)'), { target: { value: '2026-10-29' } });
    fireEvent.change(screen.getByLabelText('Through date (IST)'), { target: { value: '2026-10-29' } });
    await waitFor(() => expect(listLogs).toHaveBeenLastCalledWith(expect.objectContaining({ date_from: '2026-10-28T18:30:00.000Z', date_to: '2026-10-29T18:30:00.000Z' }), 1, 50));
  });
  it('paginates server events and resets page on filtering', async () => {
    vi.mocked(listLogs).mockResolvedValue({ ...response, total: 51 }); open(); await ready();
    fireEvent.click(screen.getByText('Next')); await waitFor(() => expect(listLogs).toHaveBeenLastCalledWith(expect.objectContaining({ property_id: 'property-1' }), 2, 50));
    await ready(); fireEvent.change(screen.getByLabelText('Activity type'), { target: { value: 'photo' } });
    await waitFor(() => expect(listLogs).toHaveBeenLastCalledWith(expect.objectContaining({ property_id: 'property-1', category: 'photo' }), 1, 50));
  });
  it('provides safe errors and retry', async () => {
    vi.mocked(listLogs).mockRejectedValueOnce(new Error('SQL internal secret')); open();
    await screen.findByText('Unable to load activity'); expect(screen.queryByText('SQL internal secret')).toBeNull();
    fireEvent.click(screen.getByText('Retry')); await ready();
  });
  it('shows empty state and clears filters', async () => {
    vi.mocked(listLogs).mockResolvedValue({ ...response, items: [], total: 0 }); open(); await screen.findByText('No activity found.');
    fireEvent.click(screen.getByText('Clear filters')); await waitFor(() => expect(listLogs).toHaveBeenLastCalledWith(expect.objectContaining({ property_id: undefined }), 1, 50));
  });
  it('groups only related photo events and exposes all individual records', async () => {
    const photo = { ...event, category: 'photo' as const, action: 'task_photo_attached', detail: { submission_uid: 'submission-1', url: '/api/v1/media/file/photo.jpg' } };
    vi.mocked(listLogs).mockResolvedValue({ ...response, items: [photo, { ...photo, log_uid: 'photo:2' }], total: 2 }); open();
    await screen.findByText('2 task photos attached'); fireEvent.click(screen.getByText('Inspect 2 events'));
    expect(screen.getByText(/Attachment event 1/)).toBeTruthy(); expect(screen.getByText(/Attachment event 2/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Group related photos on this page'));
    expect(screen.getAllByRole('heading', { name: 'Task photo attached' }).length).toBe(2);
  });
  it('loads authenticated blob previews and gracefully handles unavailable attachments', async () => {
    render(<ul><ActivityRow events={[{ ...event, category: 'photo', action: 'task_photo_attached', detail: { url: '/api/v1/media/file/evidence.jpg' } }]} workspaceAvailable={true} /></ul>);
    fireEvent.click(screen.getByText('View details'));
    const image = await screen.findByRole('img');
    expect(image.getAttribute('src')).toBe('blob:attachment');
    expect(getLogAttachment).toHaveBeenCalledWith(event.log_uid, 0);
    fireEvent.error(image);
    expect(screen.getByText('Attachment unavailable')).toBeTruthy();
  });
  it('keeps raw diagnostics collapsed and redacts credentials when opened', () => {
    render(<ul><ActivityRow events={[{ ...event, detail: { token: 'must-not-display', private_key: 'private-value' } }]} workspaceAvailable={true} /></ul>);
    fireEvent.click(screen.getByText('View details'));
    expect(screen.queryByLabelText('Copy metadata JSON')).toBeNull();
    fireEvent.click(screen.getByText('Technical details'));
    expect(screen.queryByText(/must-not-display|private-value/)).toBeNull();
  });
  it('containerizes every event with a horizontal strip and trustworthy failure details', () => {
    render(<ul><ActivityRow events={[{ ...event, category: 'session', action: 'login_failed', actor_name: null, detail: { outcome: 'failed', actor_identity_verified: false, reason_code: 'INVALID_CREDENTIALS', http_status: 401, target_account_name: 'Target account' } }]} workspaceAvailable={false} /></ul>);
    expect(screen.getByRole('article')).toBeTruthy();
    const progress = screen.getByRole('list', { name: 'Horizontal recorded event progress' });
    expect(within(progress).getByText('Failed')).toBeTruthy();
    expect(screen.getByText('Unverified attempt')).toBeTruthy();
    fireEvent.click(screen.getByText('View details'));
    expect(screen.getByText('Identity not authenticated')).toBeTruthy();
    expect(screen.getByText('401')).toBeTruthy();
    expect(screen.getByText('Target account')).toBeTruthy();
  });
  it('ignores stale requests', async () => {
    let resolve!: (value: typeof response) => void;
    vi.mocked(listLogs).mockImplementationOnce(() => new Promise((r) => { resolve = r; })); open();
    fireEvent.change(screen.getByLabelText('Search logs'), { target: { value: 'new' } });
    await ready(); resolve({ ...response, items: [{ ...event, action: 'logged_out', category: 'session' }] });
    await waitFor(() => expect(screen.queryByText('Signed out')).toBeNull());
  });
});
