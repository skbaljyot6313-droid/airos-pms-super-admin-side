import React, { useEffect, useState } from 'react';
import { Check, ChevronDown, Copy, ExternalLink, ImageOff } from 'lucide-react';
import { ActivityLog, getLogAttachment } from '../../api/logs';
import { attachmentReferences, eventTone, formatEvent, metadata, readable, recordedOutcome, safeMetadata, text } from '../../lib/activityLogs';
import { fmtAuditDateTimeIST } from '../../lib/datetime';
import { Button } from '../ui/Button';

function CopyValue({ value, name }: { value: string; name: string }) {
  const [status, setStatus] = useState('');
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setStatus('Copied'); }
    catch { setStatus('Copy unavailable. Select the value to copy.'); }
  };
  return <span className="inline-flex max-w-full items-center gap-2"><code className="break-all text-xs">{value}</code><button type="button" onClick={copy} aria-label={`Copy ${name}`} className="shrink-0 rounded p-1 hover:bg-[#EAE5DC] focus-visible:outline-2 focus-visible:outline-[#386641]">{status === 'Copied' ? <Check size={14} /> : <Copy size={14} />}</button><span role="status" className="text-xs">{status}</span></span>;
}

function EventProgress({ log }: { log: ActivityLog }) {
  const event = formatEvent(log);
  const steps = [{ label: 'Activity', value: event.category }, { label: 'Recorded action', value: event.title }, { label: 'Recorded outcome', value: recordedOutcome(log) }];
  return <div className="mx-3 mb-3 rounded-md border border-[#EAE5DC] bg-[#FAFAF7] px-3 py-2">
    <ol aria-label="Horizontal recorded event progress" className="grid grid-cols-3 gap-2">{steps.map((step, index) => <li key={step.label} className="relative min-w-0">
      {index < steps.length - 1 && <span aria-hidden="true" className="absolute left-2 right-[-8px] top-1 h-px bg-[#CFD8C8]" />}
      <span aria-hidden="true" className={`relative block h-2 w-2 rounded-full ${index === 2 ? eventTone(log) : 'bg-[#6C8063]'}`} />
      <span className="mt-2 block text-[10px] text-[#78736A]">{step.label}</span><span className="mt-0.5 block break-words text-[11px] font-medium text-[#35322E]">{step.value}</span>
    </li>)}</ol>
    <p className="mt-2 text-[10px] text-[#78736A]">Recorded facts, not a completion percentage or predicted workflow.</p>
  </div>;
}

function Attachment({ logUid, index }: { logUid: string; index: number }) {
  const [failed, setFailed] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true, objectUrl: string | null = null;
    setUrl(null); setFailed(false);
    void getLogAttachment(logUid, index).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [logUid, index]);
  return <div className="overflow-hidden rounded-lg border border-[#EAE5DC] bg-white">
    {failed ? <div className="flex h-32 items-center justify-center gap-2 text-xs text-[#6C675F]"><ImageOff size={16} /> Attachment unavailable</div> : !url ? <div role="status" className="flex h-32 items-center justify-center text-xs text-[#6C675F]">Loading attachment…</div> : <img src={url} alt={`Event attachment ${index + 1}`} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="h-36 w-full object-contain" />}
    {url && !failed && <a href={url} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-2 border-t border-[#EAE5DC] p-2 text-xs font-medium text-[#386641]">Open attachment <ExternalLink size={12} /></a>}
  </div>;
}

export function ActivityEventDetails({ log, workspaceAvailable }: { log: ActivityLog; workspaceAvailable: boolean }) {
  const event = formatEvent(log);
  const detail = safeMetadata(metadata(log)) as Record<string, unknown>;
  const attachments = attachmentReferences(log);
  const fields = ['ticket_number', 'file_name', 'assigned_to', 'previous_assignee', 'attempt', 'kind', 'content_type', 'size_bytes', 'reason', 'note', 'previous_state', 'new_state', 'attendance_date', 'request_type', 'leave_type', 'from_date', 'to_date', 'duration_seconds', 'status', 'review_status_current', 'outcome', 'reason_code', 'http_status', 'channel', 'target_account_name'];
  const changes = detail.changes && typeof detail.changes === 'object' ? Object.entries(detail.changes) : [];
  const values = detail.values && typeof detail.values === 'object' ? Object.entries(detail.values).filter(([, v]) => v !== null) : [];
  const identifierKeys = Object.keys(detail).filter((key) => /(_uid|_id|_number)$/.test(key) && text(detail[key]));
  const [technicalOpen, setTechnicalOpen] = useState(false);
  return <div className="space-y-5 border-t border-[#EAE5DC] bg-[#FAF9F6] px-4 py-5 sm:px-6">
    <section><h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[#78736A]">Event summary</h3>
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        {Object.entries({ Activity: event.title, Actor: detail.actor_identity_verified === false ? 'Identity not authenticated' : log.actor_name || 'Not recorded', ...(event.role ? { Role: event.role } : {}), Property: log.property_name || 'Not linked to a property', Timestamp: `${fmtAuditDateTimeIST(log.occurred_at)} IST`, Category: event.category }).map(([key, value]) => <div key={key}><dt className="text-xs text-[#78736A]">{key}</dt><dd className="mt-1 break-words text-[#35322E]">{value}</dd></div>)}
      </dl>
    </section>
    <section><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#78736A]">Affected entity</h3><p className="text-sm font-medium">{event.entity}</p><p className="mt-1 text-xs text-[#6C675F]">{readable(log.entity_type || 'Record')}</p>
      {workspaceAvailable && log.property_uid && <a className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-[#386641]" href={`/property/${encodeURIComponent(log.property_uid)}/${log.entity_type === 'task' || log.entity_type === 'maintenance' ? 'tasks' : 'zones'}`}>Open {log.entity_type === 'task' || log.entity_type === 'maintenance' ? 'property tasks' : 'property workspace'} <ExternalLink size={12} /></a>}
    </section>
    {(fields.some((key) => text(detail[key])) || values.length > 0 || changes.length > 0) && <section><h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[#78736A]">Event information</h3>
      <dl className="space-y-2 text-sm">{fields.filter((key) => text(detail[key])).map((key) => <div key={key} className="grid gap-1 sm:grid-cols-[140px_1fr]"><dt className="text-xs text-[#78736A]">{readable(key)}</dt><dd className="whitespace-pre-wrap break-words">{text(detail[key])}</dd></div>)}</dl>
      {changes.length > 0 && <div className="mt-3 space-y-2">{changes.map(([key, value]) => {
        const change = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return <div key={key} className="rounded border border-[#EAE5DC] bg-white p-3 text-xs"><span className="font-medium">{readable(key)}</span><p className="mt-1 break-words text-[#6C675F]">{String(change.before ?? 'Not recorded')} → {String(change.after ?? 'Not set')}</p></div>;
      })}</div>}
      {values.length > 0 && <details className="mt-3 text-xs"><summary className="cursor-pointer font-medium text-[#386641]">Recorded values</summary><dl className="mt-2 space-y-2">{values.map(([key, value]) => <div key={key}><dt className="text-[#78736A]">{readable(key)}</dt><dd className="break-all">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>)}</dl></details>}
    </section>}
    {log.category === 'photo' && attachments.length === 0 && <p className="flex items-center gap-2 text-xs text-[#6C675F]"><ImageOff size={14} /> Attachment unavailable. No supported media URL was recorded.</p>}
    {attachments.length > 0 && <section><h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[#78736A]">Attachments ({attachments.length})</h3><div className="grid gap-3 sm:grid-cols-2">{attachments.map(({ index }) => <Attachment key={index} logUid={log.log_uid} index={index} />)}</div></section>}
    <details open={technicalOpen} onToggle={(e) => setTechnicalOpen(e.currentTarget.open)} className="rounded-lg border border-[#EAE5DC] bg-white p-3 text-xs">
      <summary className="cursor-pointer font-medium text-[#6C675F]">Technical details</summary>
      {technicalOpen && <div className="mt-3 space-y-3"><p>Event ID<br /><CopyValue value={log.log_uid} name="event ID" /></p>{log.entity_uid && <p>Entity ID<br /><CopyValue value={log.entity_uid} name="entity ID" /></p>}<p>Original event type: <code>{log.category}.{log.action}</code></p>
        {identifierKeys.map((key) => <p key={key}>{readable(key)}<br /><CopyValue value={String(detail[key])} name={readable(key)} /></p>)}
        <CopyValue value={JSON.stringify(detail, null, 2)} name="metadata JSON" />
      </div>}
    </details>
  </div>;
}

export function ActivityRow({ events, workspaceAvailable, onOpenTask }: { events: ActivityLog[]; workspaceAvailable: boolean; onOpenTask?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const log = events[0], event = formatEvent(log);
  const grouped = events.length > 1;
  const id = `event-${log.log_uid.replace(/[^\w-]/g, '-')}`;
  const actor = metadata(log).actor_identity_verified === false ? 'Unverified attempt' : log.actor_name || 'Actor not recorded';
  return <li className="relative ml-5 min-w-0 border-l border-[#DDE1D5] pb-4 pl-4 sm:ml-7 sm:pl-6">
    <span aria-hidden="true" className={`absolute -left-[5px] top-6 h-[9px] w-[9px] rounded-full ring-4 ring-white ${eventTone(log)}`} />
    <article className="overflow-hidden rounded-lg border border-[#E3E4DA] bg-white">
    <div className="flex gap-3 rounded-md px-3 py-4 transition-colors hover:bg-[#FAFAF6] sm:pr-5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-sm font-medium text-[#24221F]"><button type="button" className="text-left focus-visible:outline-2 focus-visible:outline-[#386641]" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{grouped ? `${events.length} task photos attached` : event.title}</button></h2>
          <time dateTime={log.occurred_at} title={`${fmtAuditDateTimeIST(log.occurred_at)} IST`} className="text-xs text-[#78736A]">{fmtAuditDateTimeIST(log.occurred_at)} IST</time>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2"><p className="text-xs font-medium text-[#35322E]">{actor}{event.role && <span className="ml-2 font-normal text-[#78736A]">{event.role}</span>}</p><span className="rounded border border-[#E6E8DF] bg-[#F6F7F2] px-1.5 py-0.5 text-[10px] text-[#53634B]">{event.category}</span></div>
        <p className="mt-1 break-words text-xs leading-relaxed text-[#6C675F]">{event.description}</p>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-[#78736A]">{log.property_name || (log.property_uid ? 'Property unavailable' : 'Company activity')} · {readable(log.entity_type || 'Record')}</p>
          {onOpenTask && log.entity_uid && ['task', 'tasks'].includes(log.entity_type) && <Button size="sm" variant="ghost" onClick={() => onOpenTask(log.entity_uid!)}>Task journey</Button>}
          <Button size="sm" variant="ghost" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{open ? 'Hide details' : grouped ? `Inspect ${events.length} events` : 'View details'}<ChevronDown size={13} className={open ? 'rotate-180' : ''} /></Button>
        </div>
      </div>
    </div>
    <EventProgress log={log} />
    {open && <div id={id}>{grouped ? <div className="border-t border-[#EAE5DC] bg-[#FAF9F6] p-4"><p className="mb-3 text-xs text-[#6C675F]">{events.length} separate events from this page, grouped by task, actor and submission. Every event is retained.</p>{events.map((item, index) => <details key={`${item.log_uid}:${index}`} className="mb-2 rounded border border-[#EAE5DC] bg-white"><summary className="cursor-pointer p-3 text-xs font-medium">Attachment event {index + 1} · {fmtAuditDateTimeIST(item.occurred_at)} IST</summary><ActivityEventDetails log={item} workspaceAvailable={workspaceAvailable} /></details>)}</div> : <ActivityEventDetails log={log} workspaceAvailable={workspaceAvailable} />}</div>}
    </article>
  </li>;
}
