import { apiFetch } from './client';

export const LOG_CATEGORIES = ['audit', 'session', 'task', 'photo', 'maintenance', 'allocation', 'resource', 'attendance'] as const;
export type LogCategory = typeof LOG_CATEGORIES[number];

export interface ActivityLog {
  log_uid: string;
  occurred_at: string;
  category: LogCategory;
  action: string;
  actor_name: string | null;
  entity_type: string;
  entity_uid: string | null;
  entity_name: string | null;
  property_uid: string | null;
  property_name: string | null;
  detail: Record<string, unknown>;
}

export interface LogFilters {
  property_id?: string;
  category?: string;
  search?: string;
  actor?: string;
  action?: string;
  task_status?: string;
  date_from?: string;
  date_to?: string;
}

export interface LogsResponse {
  items: ActivityLog[];
  total: number;
  page: number;
  limit: number;
}

export const listLogs = (filters: LogFilters, page = 1, limit = 50) =>
  apiFetch<LogsResponse>('/admin/logs', { query: { ...filters, page, limit } });

export const TASK_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending', assigned: 'Assigned', in_progress: 'In progress', submitted: 'Pending review',
  reopened: 'Reopened', completed: 'Completed', cancelled: 'Cancelled', abandoned: 'Abandoned',
  overdue: 'Overdue', scheduled: 'Scheduled',
};

export interface JourneyTask {
  task_uid: string;
  title: string;
  ticket_number: string | null;
  property_uid: string;
  property_name: string;
  status: string;
  assignee_name: string | null;
  zone_name: string | null;
  created_at: string | null;
  submitted_at: string | null;
  completed_at: string | null;
  abandoned_at: string | null;
  abandoned_reason: string | null;
}

export interface TaskSearchResponse { items: JourneyTask[]; total: number; page: number; limit: number }
export interface TaskJourneyResponse { task: JourneyTask; events: LogsResponse; history_types?: string[] }
export const findJourneyTasks = (filters: { search?: string; property_id?: string; status?: string }, page = 1) =>
  apiFetch<TaskSearchResponse>('/admin/logs/tasks', { query: { ...filters, page, limit: 25 } });
export const getLogAttachment = (logUid: string, index: number) => {
  const [source, id] = logUid.split(':');
  return apiFetch<Blob>(`/admin/logs/attachments/${encodeURIComponent(source)}/${encodeURIComponent(id || '')}`, {
    query: { index }, responseType: 'blob',
  });
};
export const getTaskJourney = (id: string, page = 1) =>
  apiFetch<TaskJourneyResponse>(`/admin/logs/tasks/${encodeURIComponent(id)}/journey`, { query: { page, limit: 50 } });
