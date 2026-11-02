import { ActivityLog } from '../api/logs';
import { mediaUrl } from '../api/client';
import { fmtDateLongIST, istDateKey, istDateKeyOffset, parseIso } from './datetime';

export const categoryLabels: Record<string, string> = {
  session: 'Authentication', task: 'Task activity', photo: 'Photos & attachments',
  audit: 'Administration & changes', maintenance: 'Maintenance', allocation: 'Work allocation',
  resource: 'Resource changes', attendance: 'Attendance',
};
export const readable = (value: string) => value.replace(/[_ .-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
const sensitive = /password|passwd|token|secret|credential|authorization|cookie|(?:api|private|access).?key|signature/i;

export function safeMetadata(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[Nested data omitted]';
  if (Array.isArray(value)) return value.map((v) => safeMetadata(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([k, v]) => [k, sensitive.test(k) ? '[Redacted]' : safeMetadata(v, depth + 1)]));
  if (typeof value === 'string') {
    if (/bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(value)) return '[Redacted]';
    return value.replace(/([?&][^=\s]*(?:token|signature|credential|secret|key)[^=\s]*=)[^&\s]*/gi, '$1[Redacted]');
  }
  return value;
}

export function metadata(log: ActivityLog): Record<string, unknown> {
  return log.detail && typeof log.detail === 'object' && !Array.isArray(log.detail) ? log.detail : {};
}
export function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : typeof value === 'number' ? String(value) : null;
}
export function entityLabel(log: ActivityLog): string {
  const name = log.entity_name;
  return name && !/^[0-9a-f-]{32,36}(\.[a-z]+)?$/i.test(name) ? name : readable(log.entity_type || 'Record');
}

const titles: Record<string, string> = {
  logged_in: 'Signed in', logged_out: 'Signed out', session_refreshed: 'Session refreshed',
  login_failed: 'Sign-in failed', refresh_failed: 'Session refresh failed',
  account_registered: 'Account registered', photo_uploaded: 'Photo uploaded',
  task_photo_attached: 'Task photo attached', maintenance_photo_attached: 'Maintenance photo attached',
  evidence_submitted: 'Completion evidence recorded', auto_generated: 'Task generated',
  evidence_approved: 'Evidence approval recorded', evidence_disapproved: 'Evidence rejection recorded',
  allocated: 'Task assigned', reassigned: 'Task reassigned', redo_requested: 'Rework requested',
  admin_closed: 'Administrative closure recorded', evidence_deleted: 'Evidence removed',
  room_status_changed: 'Related room status changed',
  clocked_in: 'Clocked in', clocked_out: 'Clocked out', break_started: 'Break started',
  break_ended: 'Break ended', time_off_requested: 'Time off requested', location_changed: 'Location allocation changed',
  manual: 'Work assigned manually', round_robin: 'Work assigned automatically', reassign: 'Work reassigned',
};

export function formatEvent(log: ActivityLog) {
  const detail = metadata(log);
  const entity = entityLabel(log);
  let title = titles[log.action];
  if (log.category === 'task') {
    title = ({ started: 'Work started', completed: 'Work completed', submitted: 'Completion submitted for review',
      completion_submitted: 'Completion submitted for review', approved: 'Work approved', rejected: 'Submission rejected',
      abandoned: 'Work abandoned', cancelled: 'Task cancelled', reopened: 'Task reopened' } as Record<string, string>)[log.action] || title;
    if (log.action === 'allocated' && detail.note === 'Created') title = 'Task created';
  }
  if (!title) {
    const type = log.category === 'task' ? 'Task' : log.category === 'maintenance' ? 'Maintenance ticket' : readable(log.entity_type || 'Record');
    title = `${type} ${readable(log.action || 'activity recorded').toLowerCase()}`;
  }
  let description = `Activity recorded for ${entity}.`;
  if (log.category === 'session') description = metadata(log).outcome === 'failed'
    ? `The attempt was rejected${text(detail.reason_code) ? ` · ${readable(String(detail.reason_code))}` : ''}. Account identity was not authenticated.`
    : log.action === 'logged_out' ? 'The account explicitly signed out.' : 'An account session action was recorded.';
  else if (log.action === 'task_photo_attached') description = `Evidence attached to “${entity}”. This event records an attachment, not task completion.`;
  else if (log.action === 'maintenance_photo_attached') description = `An attachment was added to “${entity}”.`;
  else if (log.action === 'photo_uploaded') description = 'An image was uploaded. Attachment to work is recorded separately.';
  else if (log.category === 'allocation' && text(detail.assigned_to)) description = `${detail.previous_assignee ? `${detail.previous_assignee} → ` : 'Assigned to '}${detail.assigned_to}${log.entity_name ? ` · ${entity}` : ''}`;
  else if (detail.previous_state && detail.new_state) description = `${readable(String(detail.previous_state))} → ${readable(String(detail.new_state))} · ${entity}`;
  else if (['abandoned', 'rejected', 'reassigned', 'redo_requested'].includes(log.action) && text(detail.note)) description = `${entity} · ${detail.note}`;
  else if (log.action === 'evidence_submitted') description = `Completion evidence recorded for “${entity}”. This does not confirm final completion or approval.`;
  else if (log.action === 'evidence_approved') description = `An approved review was recorded for “${entity}”; it may be an automatic acknowledgement during direct staff completion.`;
  else if (log.category === 'task' || log.category === 'maintenance') description = entity;
  const role = text(detail.actor_role);
  return { title, description, entity, role: role ? readable(role) : null,
    category: categoryLabels[log.category] || 'Other activity' };
}

export function timelineDay(iso: string): string {
  const date = parseIso(iso);
  return date ? istDateKey(date) : 'unknown';
}

export function timelineDateLabel(iso: string, now = new Date()): string {
  const date = parseIso(iso);
  if (!date) return 'Date not recorded';
  const key = istDateKey(date);
  const prefix = key === istDateKey(now) ? 'Today · ' : key === istDateKeyOffset(-1, now) ? 'Yesterday · ' : '';
  return `${prefix}${fmtDateLongIST(date)}`;
}

export function recordedOutcome(log: ActivityLog): string {
  const outcome = text(metadata(log).outcome);
  if (outcome) return readable(outcome);
  if (log.category === 'session' && ['logged_in', 'logged_out', 'session_refreshed', 'account_registered'].includes(log.action)) return 'Successful';
  if (log.category === 'task' && ['approved', 'evidence_approved', 'completed'].includes(log.action)) return 'Approved / completed';
  if (['abandoned', 'cancelled', 'rejected', 'evidence_disapproved'].includes(log.action)) return readable(log.action);
  return 'Outcome not recorded';
}

export function eventTone(log: ActivityLog): string {
  if (metadata(log).outcome === 'failed') return 'bg-[#A85343]';
  if (log.category === 'session' && recordedOutcome(log) === 'Successful') return 'bg-[#386641]';
  if (log.category === 'task') {
    if (['completed', 'approved', 'evidence_approved'].includes(log.action)) return 'bg-[#386641]';
    if (['abandoned', 'cancelled', 'rejected', 'evidence_disapproved'].includes(log.action)) return 'bg-[#A85343]';
    if (['submitted', 'completion_submitted', 'redo_requested'].includes(log.action)) return 'bg-[#AC7F28]';
    if (['allocated', 'reassigned', 'auto_generated', 'started', 'reopened'].includes(log.action)) return 'bg-[#56758C]';
  }
  if (log.category === 'allocation') return 'bg-[#56758C]';
  return 'bg-[#92968A]';
}

export interface ActivityGroup { id: string; events: ActivityLog[] }
export function groupActivity(items: ActivityLog[], enabled = true): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    const head = last?.events[0];
    const submission = text(metadata(item).submission_uid);
    const elapsed = head ? Math.abs(Date.parse(head.occurred_at) - Date.parse(item.occurred_at)) : Infinity;
    if (enabled && head && item.action === 'task_photo_attached' && head.action === item.action &&
        item.entity_uid && head.entity_uid === item.entity_uid && item.actor_name && head.actor_name === item.actor_name &&
        item.property_uid === head.property_uid && submission && submission === text(metadata(head).submission_uid) &&
        elapsed <= 120000 && timelineDay(item.occurred_at) === timelineDay(head.occurred_at)) last.events.push(item);
    else groups.push({ id: item.log_uid, events: [item] });
  }
  return groups;
}

export function attachmentReferences(log: ActivityLog): { url: string; index: number }[] {
  const d = metadata(log);
  const values = [d.url, ...(Array.isArray(d.photos) ? d.photos : [])];
  return values.flatMap((value, index) => {
    if (typeof value !== 'string' || !value || value.startsWith('//')) return [];
    if (value.startsWith('/') && !/^\/(uploads\/|api\/v\d+\/media\/file\/)/.test(value)) return [];
    try {
      const url = new URL(mediaUrl(value), window.location.origin);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? [{ url: url.href, index }] : [];
    } catch { return []; }
  });
}

export function attachmentUrls(log: ActivityLog): string[] {
  return attachmentReferences(log).map((attachment) => attachment.url);
}

export type DatePreset = 'all' | 'today' | '7' | '30' | 'custom';
export function dateBounds(preset: DatePreset, from: string, to: string, now = new Date()) {
  let start = from, end = to;
  if (preset === 'all') return {};
  if (preset !== 'custom') {
    end = istDateKey(now);
    start = istDateKey(new Date(now.getTime() - (preset === 'today' ? 0 : Number(preset) - 1) * 86400000));
  }
  return {
    date_from: start ? new Date(`${start}T00:00:00+05:30`).toISOString() : undefined,
    date_to: end ? new Date(new Date(`${end}T00:00:00+05:30`).getTime() + 86400000).toISOString() : undefined,
  };
}

export function relativeTime(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60000);
  if (!Number.isFinite(minutes) || minutes < 0) return '';
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`;
  return `${Math.floor(minutes / 1440)} days ago`;
}
