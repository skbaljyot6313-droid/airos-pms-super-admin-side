import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Building2, ClipboardList, RefreshCw, Search, X } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { listLogs, LOG_CATEGORIES, LogFilters, LogsResponse, TASK_STATUS_LABELS } from '../../api/logs';
import { categoryLabels, dateBounds, DatePreset } from '../../lib/activityLogs';
import { fmtAuditDateTimeIST } from '../../lib/datetime';
import { Button } from '../ui/Button';
import { ActivityTimeline } from './ActivityTimeline';
import { TaskJourney } from './TaskJourney';

const input = 'w-full min-w-0 rounded-md border border-[#D6D3D1] bg-white px-3 py-2 text-xs text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]/30';
const description = 'Track administrative actions, employee activity, and operational changes across your properties.';

export const LogsView: React.FC = () => {
  const { companyProperties } = useApp();
  const [selected, setSelected] = useState<string | null>(null);
  if (selected !== null) return <ActivityFeed key={selected} initialProperty={selected === 'all' ? '' : selected} onBack={() => setSelected(null)} />;
  return <section className="space-y-5">
    <header><h1 className="pg-in flex items-center gap-2.5 font-display font-bold text-[26px] text-[#0D1C42] tracking-tight"><span className="w-9 h-9 rounded-[10px] bg-[#F7E9EE] text-[#800020] flex items-center justify-center"><ClipboardList size={18} /></span> Activity Logs</h1><p className="mt-1 text-sm text-[#667085]">{description}</p></header>
    <div className="flex items-center justify-between border-b border-[#D6D3D1] pb-3"><h2 className="text-sm font-medium">Choose a property <span className="ml-2 text-xs text-[#667085]">{companyProperties.length} available</span></h2><span className="text-xs text-[#667085]">Super admin only</span></div>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{companyProperties.map((p) => <button key={p.property_uid} onClick={() => setSelected(p.property_uid)} aria-label={`View logs for ${p.name}`} className="group rounded-lg border border-[#D6D3D1] bg-white p-4 text-left hover:border-[#C3D6F0] focus-visible:outline-2 focus-visible:outline-[#800020]">
      <div className="flex items-start gap-3"><Building2 size={20} className="mt-1 shrink-0 text-[#800020]" /><div className="min-w-0 flex-1"><h3 className="break-words text-sm font-semibold">{p.name}</h3><p className="mt-1 text-xs text-[#667085]">{p.location || p.code}</p></div><ArrowRight size={16} className="mt-1 text-[#667085]" /></div><p className="mt-4 border-t border-[#EAF1FB] pt-3 text-xs text-[#800020]">View activity history</p>
    </button>)}</div>
    {!companyProperties.length && <p className="rounded-lg border border-[#E7E5E4] bg-white p-6 text-sm text-[#667085]">No properties are available yet.</p>}
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#E7E5E4] bg-white p-4"><p className="text-xs text-[#667085]">Include company-level sessions and activity not linked to a property.</p><Button size="sm" variant="outline" onClick={() => setSelected('all')}>View all company logs <ArrowRight size={14} /></Button></div>
  </section>;
};

function ActivityFeed({ initialProperty, onBack }: { initialProperty: string; onBack: () => void }) {
  const { companyProperties } = useApp();
  const [mode, setMode] = useState<'activity' | 'journey'>('activity');
  const [journeyTask, setJourneyTask] = useState<string | null>(null);
  const [taskStatus, setTaskStatus] = useState('');
  const [property, setProperty] = useState(initialProperty);
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [preset, setPreset] = useState<DatePreset>('all');
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  const [page, setPage] = useState(1), [limit, setLimit] = useState(50);
  const [data, setData] = useState<LogsResponse | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const [updated, setUpdated] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0), [grouped, setGrouped] = useState(true);
  const requestId = useRef(0);
  const [query, setQuery] = useState<LogFilters>({ property_id: initialProperty || undefined });
  const [dateAnchor, setDateAnchor] = useState(() => new Date());
  const invalidRange = preset === 'custom' && ((!from && !to) || !!(from && to && from > to));
  useEffect(() => {
    if (invalidRange) return;
    const timer = window.setTimeout(() => {
      setPage(1);
      setQuery({ property_id: property || undefined, category: category || undefined,
        search: search.trim() || undefined, actor: actor.trim() || undefined, action: action.trim() || undefined,
        task_status: taskStatus || undefined,
        ...dateBounds(preset, from, to, dateAnchor) });
    }, search.trim() !== (query.search || '') || actor.trim() !== (query.actor || '') || action.trim() !== (query.action || '') ? 350 : 0);
    return () => window.clearTimeout(timer);
  }, [property, category, search, actor, action, taskStatus, preset, from, to, invalidRange, dateAnchor]);

  const queryKey = JSON.stringify(query);
  const loadedKey = useRef('');
  useEffect(() => {
    if (mode !== 'activity') return;
    const id = ++requestId.current;
    setLoading(true); setError(false);
    setData(null);
    void listLogs(query, page, limit).then((result) => {
      if (id !== requestId.current) return;
      const lastPage = Math.max(1, Math.ceil(result.total / limit));
      if (page > lastPage) { setPage(lastPage); return; }
      setData(result); setUpdated(new Date().toISOString()); loadedKey.current = queryKey;
    }).catch(() => { if (id === requestId.current) setError(true); })
      .finally(() => { if (id === requestId.current) setLoading(false); });
    return () => { requestId.current += 1; };
  }, [queryKey, page, limit, refresh, mode]);

  const clear = () => { setProperty(''); setCategory(''); setSearch(''); setActor(''); setAction(''); setTaskStatus(''); setPreset('all'); setFrom(''); setTo(''); };
  const propertyName = companyProperties.find((p) => p.property_uid === property)?.name || 'All properties';
  const chips = [
    property && { name: propertyName, clear: () => setProperty('') },
    category && { name: categoryLabels[category], clear: () => setCategory('') },
    search && { name: `Search: ${search}`, clear: () => setSearch('') },
    actor && { name: `Actor: ${actor}`, clear: () => setActor('') },
    action && { name: `Event: ${action}`, clear: () => setAction('') },
    taskStatus && { name: `Current task status: ${TASK_STATUS_LABELS[taskStatus]}`, clear: () => setTaskStatus('') },
    preset !== 'all' && { name: preset === 'custom' ? `${from || 'Any date'} – ${to || 'Now'}` : preset === 'today' ? 'Today' : `Last ${preset} days`, clear: () => setPreset('all') },
  ].filter((chip): chip is { name: string; clear: () => void } => !!chip);
  const pages = data ? Math.max(1, Math.ceil(data.total / limit)) : 1;
  const pending = loading || invalidRange || property !== (query.property_id || '') || category !== (query.category || '') || search.trim() !== (query.search || '') || actor.trim() !== (query.actor || '') || action.trim() !== (query.action || '') || taskStatus !== (query.task_status || '');
  const modeSwitch = <div role="group" aria-label="Log browsing mode" className="inline-flex rounded-md border border-[#D6D3D1] bg-[#FFFCFA] p-0.5">
    <Button size="sm" variant={mode === 'activity' ? 'sage' : 'ghost'} aria-pressed={mode === 'activity'} onClick={() => setMode('activity')}>Activity Timeline</Button>
    <Button size="sm" variant={mode === 'journey' ? 'sage' : 'ghost'} aria-pressed={mode === 'journey'} onClick={() => { setJourneyTask(null); setMode('journey'); }}>Task Journey</Button>
  </div>;
  if (mode === 'journey') return <section className="min-w-0 space-y-4">
    <Button size="sm" variant="ghost" onClick={onBack}><ArrowLeft size={14} /> Back to properties</Button>
    <header><h1 className="pg-in font-display font-bold text-[26px] text-[#0D1C42] tracking-tight">Activity Logs</h1><p className="mt-1 text-sm text-[#667085]">Explore a task’s available lifecycle, separate from its current authoritative state. All times IST.</p></header>
    {modeSwitch}
    <TaskJourney initialProperty={property} initialTaskId={journeyTask} />
  </section>;
  return <section className="min-w-0 space-y-4">
    <Button size="sm" variant="ghost" onClick={onBack}><ArrowLeft size={14} /> Back to properties</Button>
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="pg-in font-display font-bold text-[26px] text-[#0D1C42] tracking-tight">Activity Logs</h1><p className="mt-1 max-w-2xl text-sm text-[#667085]">{description}</p><p className="mt-2 text-xs font-medium text-[#800020]">{propertyName} · All times IST</p></div><Button size="sm" variant="outline" disabled={pending} onClick={() => { setDateAnchor(new Date()); setRefresh((v) => v + 1); }}><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh</Button></header>
    <div className="rounded-lg border border-[#D6D3D1] bg-white">
      <div className="space-y-3 border-b border-[#D6D3D1] p-4">
        <div className="flex flex-wrap gap-3"><div className="relative min-w-48 flex-1"><Search size={15} className="absolute left-3 top-2.5 text-[#667085]" /><input className={`${input} pl-9 pr-8`} aria-label="Search logs" placeholder="Search people, properties, tasks or identifiers…" maxLength={200} value={search} onChange={(e) => setSearch(e.target.value)} />{search && <button aria-label="Clear search" className="absolute right-2 top-2 rounded p-0.5 focus-visible:outline-2" onClick={() => setSearch('')}><X size={14} /></button>}</div>
          <label className="min-w-36"><span className="sr-only">Date range</span><select className={input} aria-label="Date range" value={preset} onChange={(e) => { setDateAnchor(new Date()); setPreset(e.target.value as DatePreset); }}><option value="all">All time</option><option value="today">Today</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="custom">Custom range</option></select></label>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <label className="space-y-1 text-[11px] text-[#667085]">Property<select className={input} aria-label="Property" value={property} onChange={(e) => setProperty(e.target.value)}><option value="">All properties</option>{companyProperties.map((p) => <option key={p.property_uid} value={p.property_uid}>{p.name}</option>)}</select></label>
          <label className="space-y-1 text-[11px] text-[#667085]">Category<select className={input} aria-label="Activity type" value={category} onChange={(e) => setCategory(e.target.value)}><option value="">All categories</option>{LOG_CATEGORIES.map((c) => <option key={c} value={c}>{categoryLabels[c]}</option>)}</select></label>
          <label className="space-y-1 text-[11px] text-[#667085]">Actor<input className={input} aria-label="Actor name" placeholder="Employee or administrator" maxLength={200} value={actor} onChange={(e) => setActor(e.target.value)} /></label>
          <label className="space-y-1 text-[11px] text-[#667085]">Event type<input className={input} aria-label="Event type" placeholder="Exact key, e.g. logged_in" maxLength={64} value={action} onChange={(e) => setAction(e.target.value)} /></label>
        </div>
        <label className="block max-w-xs space-y-1 text-[11px] text-[#667085]">Current task status<select className={input} aria-label="Current task status" value={taskStatus} onChange={(e) => setTaskStatus(e.target.value)}><option value="">All activity, any status</option>{Object.entries(TASK_STATUS_LABELS).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
        {taskStatus && <p className="text-xs text-[#667085]">Showing events linked to tasks whose current status is {TASK_STATUS_LABELS[taskStatus]}. This is not the status at each historical event.</p>}
        {preset === 'custom' && <div className="flex flex-wrap gap-3"><label className="text-xs text-[#667085]">From (IST)<input type="date" aria-label="From date (IST)" className={input} value={from} onChange={(e) => setFrom(e.target.value)} /></label><label className="text-xs text-[#667085]">Through (IST)<input type="date" aria-label="Through date (IST)" className={input} value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>{invalidRange && <p role="alert" className="self-end py-2 text-xs text-[#A83434]">Choose a valid date range. End date must be on or after start date.</p>}</div>}
        {chips.length > 0 && <div className="flex flex-wrap items-center gap-2">{chips.map((chip) => <button key={chip.name} aria-label={`Remove ${chip.name} filter`} onClick={chip.clear} className="inline-flex max-w-full items-center gap-1 rounded border border-[#EAD3DB] bg-[#F7E9EE] px-2 py-1 text-[11px] text-[#800020] focus-visible:outline-2"><span className="truncate">{chip.name}</span><X size={11} /></button>)}<button onClick={clear} className="p-1 text-xs font-medium text-[#667085] underline">Clear all</button></div>}
      </div>
      <div className="border-b border-[#F6F4F2] px-4 py-3">{modeSwitch}<span className="ml-3 text-xs text-[#667085]">Newest events first</span></div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#F6F4F2] px-4 py-3 text-xs text-[#667085]"><p role="status">{pending ? 'Updating activity…' : error ? 'Activity unavailable' : `${data?.total.toLocaleString() || 0} events matching your query`}{updated && !pending && !error && loadedKey.current === queryKey && <span className="ml-3 text-[#667085]">Updated {fmtAuditDateTimeIST(updated)} IST (fetched)</span>}</p><label className="flex items-center gap-2"><input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} /> Group related photos on this page</label></div>
      {pending ? <div role="status" aria-label="Loading activity" className="divide-y divide-[#F6F4F2]">{[0, 1, 2, 3].map((n) => <div key={n} className="flex animate-pulse gap-3 p-5"><div className="h-8 w-8 rounded-full bg-[#F6F4F2]" /><div className="flex-1 space-y-2"><div className="h-3 w-1/3 rounded bg-[#F6F4F2]" /><div className="h-3 w-2/3 rounded bg-[#F6F4F2]" /><div className="h-3 w-1/2 rounded bg-[#F6F4F2]" /></div></div>)}</div> : error ? <div role="alert" className="p-10 text-center"><h2 className="text-sm font-semibold">Unable to load activity</h2><p className="my-2 text-xs text-[#667085]">Please try again. If the problem continues, check your connection.</p><Button size="sm" variant="outline" onClick={() => setRefresh((v) => v + 1)}>Retry</Button></div> : !data?.items.length ? <div className="p-12 text-center"><Search size={22} className="mx-auto mb-3 text-[#667085]" /><h2 className="text-sm font-semibold">No activity found.</h2><p className="mb-3 mt-1 text-xs text-[#667085]">Try a wider date range or remove a filter.</p><Button variant="outline" size="sm" onClick={clear}>Clear filters</Button></div> : <ActivityTimeline events={data.items} grouped={grouped} propertyIds={companyProperties.map((p) => p.property_uid)} onOpenTask={(id) => { setJourneyTask(id); setMode('journey'); }} />}
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[#E7E5E4] p-4 text-xs text-[#667085]"><div className="flex flex-wrap items-center gap-3"><span>{data && !pending && !error ? `${data.total ? (page - 1) * limit + 1 : 0}–${Math.min(page * limit, data.total)} of ${data.total.toLocaleString()} events · Page ${page} of ${pages}` : 'Server-paginated activity'}</span><select aria-label="Events per page" value={limit} className="rounded border border-[#D6D3D1] p-1" onChange={(e) => { setPage(1); setLimit(Number(e.target.value)); }}>{[25, 50, 100].map((n) => <option key={n} value={n}>{n} per page</option>)}</select></div><div className="flex gap-2"><Button size="sm" variant="outline" disabled={pending || page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button><Button size="sm" variant="outline" disabled={pending || error || !data || page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button></div></footer>
    </div>
    <details className="text-xs text-[#667085]"><summary className="cursor-pointer">About activity coverage</summary><p className="mt-2 max-w-3xl leading-relaxed">Recorded events only. Authentication events reflect this backend’s explicit session actions, not browser closure or clock-in. Employee-app authentication needs that application’s logging. Historical sources follow their existing retention rules. Groups are presentation-only and never remove records; attachments crossing a page boundary remain on their respective pages.</p></details>
  </section>;
}
