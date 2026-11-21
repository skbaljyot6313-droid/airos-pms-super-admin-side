import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, RefreshCw, Search } from 'lucide-react';
import { findJourneyTasks, getTaskJourney, JourneyTask, TaskJourneyResponse, TASK_STATUS_LABELS, TaskSearchResponse } from '../../api/logs';
import { useApp } from '../../context/AppContext';
import { fmtAuditDateTimeIST } from '../../lib/datetime';
import { readable } from '../../lib/activityLogs';
import { Button } from '../ui/Button';
import { ActivityTimeline } from './ActivityTimeline';

const field = 'w-full min-w-0 rounded-md border border-[#D6D3D1] bg-white px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#800020]/30';

export function elapsedTaskTime(task: JourneyTask): string | null {
  const end = task.status === 'completed' ? task.completed_at : task.status === 'abandoned' ? task.abandoned_at : null;
  if (!task.created_at || !end) return null;
  const ms = Date.parse(end) - Date.parse(task.created_at);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 3600)} hr ${Math.floor(seconds % 3600 / 60)} min ${seconds % 60} sec`;
}

function JourneyLoading() {
  return <div role="status" aria-label="Loading task history" className="space-y-5 p-5">{[0, 1, 2].map((n) => <div key={n} className="flex animate-pulse gap-4"><span className="h-3 w-3 rounded-full bg-[#C3D6F0]" /><div className="flex-1 space-y-2"><div className="h-3 w-1/3 rounded bg-[#F6F4F2]" /><div className="h-3 w-2/3 rounded bg-[#F6F4F2]" /></div></div>)}</div>;
}

export function TaskJourney({ initialProperty = '', initialTaskId = null }: { initialProperty?: string; initialTaskId?: string | null }) {
  const { companyProperties } = useApp();
  const [taskId, setTaskId] = useState<string | null>(initialTaskId);
  const [search, setSearch] = useState('');
  const [property, setProperty] = useState(initialProperty);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<TaskSearchResponse | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const requestId = useRef(0);
  const previousSearch = useRef('');
  useEffect(() => {
    if (taskId) return;
    const id = ++requestId.current;
    setLoading(true); setError(false); setResult(null);
    const delay = previousSearch.current === search ? 0 : 350;
    previousSearch.current = search;
    const timer = window.setTimeout(() => {
      void findJourneyTasks({ search: search.trim() || undefined, property_id: property || undefined, status: status || undefined }, page)
        .then((data) => { if (id === requestId.current) setResult(data); })
        .catch(() => { if (id === requestId.current) setError(true); })
        .finally(() => { if (id === requestId.current) setLoading(false); });
    }, delay);
    return () => { window.clearTimeout(timer); requestId.current += 1; };
  }, [search, property, status, page, retry, taskId]);

  if (taskId) return <JourneyDetail key={taskId} taskId={taskId} onBack={() => setTaskId(null)} />;
  const clear = () => { setSearch(''); setProperty(''); setStatus(''); setPage(1); };
  return <section className="rounded-lg border border-[#E7E5E4] bg-white">
    <div className="space-y-3 border-b border-[#E7E5E4] p-4"><div><h2 className="text-sm font-semibold">Find a task journey</h2><p className="mt-1 text-xs text-[#667085]">Search by task name, TASK ticket number, current assignee or task ID. Maintenance tickets remain in Activity Timeline.</p></div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr]">
        <label className="text-xs text-[#667085]">Task or ticket<div className="relative mt-1"><Search size={14} className="absolute left-3 top-2.5" /><input aria-label="Search task journeys" className={`${field} pl-9`} value={search} maxLength={200} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Task name, TASK-… or task ID" /></div></label>
        <label className="text-xs text-[#667085]">Property<select aria-label="Journey property" className={`${field} mt-1`} value={property} onChange={(e) => { setProperty(e.target.value); setPage(1); }}><option value="">All properties</option>{companyProperties.map((p) => <option key={p.property_uid} value={p.property_uid}>{p.name}</option>)}</select></label>
        <label className="text-xs text-[#667085]">Current task status<select aria-label="Journey current status" className={`${field} mt-1`} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All current statuses</option>{Object.entries(TASK_STATUS_LABELS).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      </div>
      {(search || property || status) && <div className="flex flex-wrap items-center gap-2 text-xs text-[#667085]">{search && <button onClick={() => { setSearch(''); setPage(1); }} className="rounded border px-2 py-1">Search: {search} ×</button>}{property && <button onClick={() => { setProperty(''); setPage(1); }} className="rounded border px-2 py-1">{companyProperties.find((p) => p.property_uid === property)?.name || 'Property'} ×</button>}{status && <button onClick={() => { setStatus(''); setPage(1); }} className="rounded border px-2 py-1">{TASK_STATUS_LABELS[status]} ×</button>}<Button size="sm" variant="ghost" onClick={clear}>Clear filters</Button></div>}
    </div>
    {loading ? <JourneyLoading /> : error ? <div role="alert" className="p-8 text-center text-sm">Unable to load tasks. <Button size="sm" variant="outline" onClick={() => setRetry((v) => v + 1)}>Retry</Button></div> : !result?.items.length ? <div className="p-8 text-center text-sm"><p>No tasks found.</p><Button size="sm" variant="ghost" onClick={clear}>Clear filters</Button></div> : <ul className="divide-y divide-[#F6F4F2]">{result.items.map((task) => <li key={task.task_uid}><button className="flex w-full items-center justify-between gap-4 p-4 text-left hover:bg-[#FFFFFF] focus-visible:outline-2 focus-visible:outline-[#800020]" onClick={() => setTaskId(task.task_uid)} aria-label={`Open journey for ${task.title}`}><div className="min-w-0"><h3 className="break-words text-sm font-medium">{task.title}</h3><p className="mt-1 text-xs text-[#667085]">{task.ticket_number || 'No ticket number'} · {task.property_name} · {task.assignee_name || 'No current assignee'}</p></div><span className="flex shrink-0 items-center gap-3 text-xs text-[#800020]">{TASK_STATUS_LABELS[task.status] || readable(task.status)}<ArrowRight size={14} /></span></button></li>)}</ul>}
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#E7E5E4] p-4 text-xs text-[#667085]"><span>{result ? `${result.total.toLocaleString()} tasks · Page ${page} of ${Math.max(1, Math.ceil(result.total / 25))}` : 'Task search'}</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={loading || page <= 1} onClick={() => setPage((p) => p - 1)}>Previous tasks</Button><Button size="sm" variant="outline" disabled={loading || !result || page * 25 >= result.total} onClick={() => setPage((p) => p + 1)}>Next tasks</Button></div></div>
  </section>;
}

function JourneySummary({ task }: { task: JourneyTask }) {
  const elapsed = elapsedTaskTime(task);
  const fields = {
    Property: task.property_name, 'Current status': TASK_STATUS_LABELS[task.status] || readable(task.status),
    'Current assignee': task.assignee_name || 'No current assignee recorded',
    ...(task.zone_name ? { 'Current zone': task.zone_name } : {}),
    ...(task.created_at ? { Created: `${fmtAuditDateTimeIST(task.created_at)} IST` } : {}),
    ...(task.submitted_at ? { 'Recorded submission': `${fmtAuditDateTimeIST(task.submitted_at)} IST` } : {}),
    ...(task.completed_at ? { 'Recorded completion': `${fmtAuditDateTimeIST(task.completed_at)} IST` } : {}),
    ...(task.abandoned_at ? { 'Recorded abandonment': `${fmtAuditDateTimeIST(task.abandoned_at)} IST` } : {}),
    ...(task.abandoned_reason ? { 'Recorded abandonment reason': readable(task.abandoned_reason) } : {}),
    ...(elapsed ? { 'Creation to current terminal outcome': elapsed } : {}),
  };
  return <section className="border-b border-[#E7E5E4] bg-[#FFFFFF] p-4 sm:p-5" aria-label="Current task summary">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold">{task.title}</h2><span className="text-xs text-[#667085]">{task.ticket_number || 'No ticket number recorded'}</span></div>
    <p className="mt-1 text-xs text-[#667085]">Current authoritative task record, independent of the timeline. Recorded timestamps may belong to earlier lifecycle stages.</p>
    <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-3">{Object.entries(fields).map(([name, value]) => <div key={name}><dt className="text-[#667085]">{name}</dt><dd className="mt-1 break-words font-medium text-[#0D1C42]">{value}</dd></div>)}</dl>
  </section>;
}

function JourneyDetail({ taskId, onBack }: { taskId: string; onBack: () => void }) {
  const { companyProperties } = useApp();
  const [data, setData] = useState<TaskJourneyResponse | null>(null);
  const [page, setPage] = useState(1), [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const [grouped, setGrouped] = useState(true);
  const requestId = useRef(0);
  useEffect(() => {
    const id = ++requestId.current;
    setLoading(true); setError(false); setData(null);
    void getTaskJourney(taskId, page).then((result) => {
      if (id !== requestId.current) return;
      const last = Math.max(1, Math.ceil(result.events.total / result.events.limit));
      if (page > last) { setPage(last); return; }
      setData(result);
    }).catch(() => { if (id === requestId.current) setError(true); })
      .finally(() => { if (id === requestId.current) setLoading(false); });
    return () => { requestId.current += 1; };
  }, [taskId, page, refresh]);
  return <section className="overflow-hidden rounded-lg border border-[#E7E5E4] bg-white">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E7E5E4] p-3"><Button size="sm" variant="ghost" onClick={onBack}><ArrowLeft size={14} /> Choose another task</Button><Button size="sm" variant="outline" disabled={loading} onClick={() => setRefresh((v) => v + 1)}><RefreshCw size={13} /> Refresh journey</Button></div>
    {loading ? <JourneyLoading /> : error ? <div role="alert" className="p-8 text-center"><p className="text-sm">Unable to load this task journey.</p><p className="my-2 text-xs text-[#667085]">It may have been removed, be outside your company, or be temporarily unavailable.</p><Button size="sm" variant="outline" onClick={() => setRefresh((v) => v + 1)}>Retry journey</Button></div> : data && <>
      <JourneySummary task={data.task} />
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 text-xs text-[#667085]"><span>{data.events.total.toLocaleString()} recorded events · Oldest first</span><label className="flex items-center gap-2"><input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} /> Group related photos</label></div>
      <p className="mx-4 mb-4 rounded border border-[#E7E5E4] bg-[#FFFFFF] p-3 text-xs leading-relaxed text-[#667085]">Available recorded history only. No creation, start, assignment or completion event is synthesized from current status. Legacy records may omit steps or actors; standalone uploads without task correlation cannot be linked. Review and completion are separate records. Activity Timeline filters do not restrict this journey.</p>
      {data.history_types && !data.history_types.includes('started') && <p className="mx-4 mb-4 text-xs text-[#667085]">History gap: no work-start event is available in this task’s recorded task history.</p>}
      {data.events.items.length ? <ActivityTimeline events={data.events.items} grouped={grouped} propertyIds={companyProperties.map((p) => p.property_uid)} /> : <p className="p-8 text-center text-sm text-[#667085]">No available lifecycle events were recorded for this task. The summary above is its current task record, not a reconstructed history.</p>}
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[#E7E5E4] p-4 text-xs text-[#667085]"><span>Page {page} of {Math.max(1, Math.ceil(data.events.total / data.events.limit))} · {data.events.limit} events per page · Groups do not cross pages</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Earlier events</Button><Button size="sm" variant="outline" disabled={page * data.events.limit >= data.events.total} onClick={() => setPage((p) => p + 1)}>Later events</Button></div></footer>
    </>}
  </section>;
}
