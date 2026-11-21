import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, Clock, AlertTriangle, Zap, ChevronRight, ChevronDown, RefreshCw,
  CalendarCheck, UserCheck, Play, CheckCircle2, Timer, CalendarClock, Ban,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { usePolling } from '../../hooks/usePolling';
import * as tasksApi from '../../api/tasks';
import { TodayTaskItem, TodayTasksResponse } from '../../api/types';
import { Badge } from '../ui/Badge';
import { useRealtimeChannel, propChannel } from '../../realtime/useRealtimeChannel';
import { fmtTimeIST, fmtDateLongIST } from '../../lib/datetime';

const inputCls =
  'px-3 py-2 text-sm bg-white border border-[#E7E5E4] rounded-[10px] focus:outline-none focus:ring-[3px] focus:ring-[#800020]/15 focus:border-[#800020]';

const GEN_BADGE: Record<string, { label: string; variant: 'sage' | 'orange' | 'red' | 'neutral' }> = {
  generated: { label: 'Generated', variant: 'sage' },
  pending_generation: { label: 'Scheduled', variant: 'orange' },
  generation_failed: { label: 'Failed', variant: 'red' },
  skipped: { label: 'Skipped', variant: 'neutral' },
  cancelled: { label: 'Cancelled', variant: 'neutral' },
};

const WORK_BADGE: Record<string, 'sage' | 'orange' | 'red' | 'lavender' | 'info' | 'neutral'> = {
  assigned: 'info', pending: 'neutral', in_progress: 'lavender',
  completed: 'sage', submitted: 'sage', overdue: 'red',
  unassigned: 'neutral', reopened: 'orange', cancelled: 'neutral',
  abandoned: 'neutral',
};

const fmtTime = fmtTimeIST;

/**
 * Collapsible feeds — every row lands in exactly one group, matched in order.
 * "In progress" is the generated-and-open set (pending → submitted incl.
 * reopened/scheduled); "Delayed" is generated work flagged overdue; residue
 * (skipped/cancelled occurrences) stays reachable under the last group.
 */
const GROUPS: {
  key: string;
  label: string;
  icon: React.ElementType;
  tone: string;
  bar: string;
  badge: string;
  defaultOpen: boolean;
  hideWhenEmpty?: boolean;
  match: (i: TodayTaskItem) => boolean;
}[] = [
  {
    key: 'pending', label: 'To be generated', icon: Timer,
    tone: 'text-[#A56514]', bar: 'border-l-[#FF9137]', badge: 'bg-[#FFF1E4] text-[#A56514]',
    defaultOpen: false,
    match: (i) =>
      i.generation_state === 'pending_generation' ||
      i.generation_state === 'generation_failed',
  },
  {
    key: 'active', label: 'In progress', icon: Play,
    tone: 'text-[#800020]', bar: 'border-l-[#800020]', badge: 'bg-[#F7E9EE] text-[#800020]',
    defaultOpen: true,
    match: (i) => i.generation_state === 'generated' && i.work_status !== 'overdue',
  },
  {
    key: 'delayed', label: 'Delayed', icon: AlertTriangle,
    tone: 'text-[#A83434]', bar: 'border-l-[#D64545]', badge: 'bg-[#FAEBEB] text-[#A83434]',
    defaultOpen: true,
    match: (i) => i.work_status === 'overdue',
  },
  {
    key: 'other', label: 'Skipped / Cancelled', icon: CalendarCheck,
    tone: 'text-[#667085]', bar: 'border-l-[#7A8495]', badge: 'bg-[#F6F4F2] text-[#667085]',
    defaultOpen: false, hideWhenEmpty: true,
    match: (i) => i.generation_state === 'skipped' || i.generation_state === 'cancelled',
  },
];

const TABLE_HEAD = (
  <thead>
    <tr className="border-b border-[#E7E5E4] bg-[#F6F4F2] text-[10.5px] uppercase tracking-wider text-[#667085]">
      <th className="px-3.5 py-2.5 font-semibold">Time</th>
      <th className="px-3.5 py-2.5 font-semibold">Task</th>
      <th className="px-3.5 py-2.5 font-semibold">Target</th>
      <th className="px-3.5 py-2.5 font-semibold">Zone</th>
      <th className="px-3.5 py-2.5 font-semibold">Assignee</th>
      <th className="px-3.5 py-2.5 font-semibold">Generation</th>
      <th className="px-3.5 py-2.5 font-semibold">Status</th>
      <th className="px-3.5 py-2.5 font-semibold text-right">Action</th>
    </tr>
  </thead>
);


interface Props {
  onOpenTask: (taskUid: string) => void;
}

export const TodayTasksView: React.FC<Props> = ({ onOpenTask }) => {
  const { activePropertyUid, currentPropertyZones, currentPropertyEmployees, addToast } = useApp();
  const [data, setData] = useState<TodayTasksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [zoneFilter, setZoneFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [scope, setScope] = useState<'all' | 'unassigned'>('all');
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(
    () => Object.fromEntries(GROUPS.map((g) => [g.key, g.defaultOpen]))
  );
  const load = useCallback(async (quiet = false) => {
    if (!activePropertyUid) return;
    if (!quiet) setLoading(true);
    try {
      const res = await tasksApi.tasksToday(activePropertyUid);
      setData(res);
    } catch {
      if (!quiet) addToast({ type: 'error', title: 'Could not load today\'s tasks' });
    } finally {
      setLoading(false);
    }
  }, [activePropertyUid, addToast]);

  useEffect(() => {
    void load();
  }, [load]);
  // Task events (Centrifugo) refresh the list instantly; the residual
  // poll is reconciliation-only for events missed while disconnected.
  useRealtimeChannel(
    activePropertyUid ? propChannel(activePropertyUid, 'tasks') : null,
    !!activePropertyUid,
    () => void load(true),
  );
  usePolling(() => load(true), 120000, true, 'TodayTasksView');

  const generate = async (item: TodayTaskItem) => {
    if (!item.template_uid || !item.occurrence_key) return;
    setGenerating(item.occurrence_key);
    try {
      await tasksApi.generateOccurrence(item.template_uid, item.occurrence_key);
      addToast({ type: 'success', title: 'Task generated', description: item.title });
      await load(true);
    } catch (err) {
      addToast({ type: 'error', title: 'Generation failed', description: err instanceof Error ? err.message : '' });
    } finally {
      setGenerating(null);
    }
  };

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.items.filter((i) => {
      // finished work belongs in Task History, not today's schedule
      if (['completed', 'cancelled', 'abandoned'].includes(i.work_status || '')) return false;
      if (search && !`${i.title} ${i.ticket_number || ''} ${i.assignee || ''} ${i.room_number || ''}`
        .toLowerCase().includes(search.toLowerCase())) return false;
      if (zoneFilter && i.zone_name !== zoneFilter) return false;
      if (sourceFilter === 'template' && i.source !== 'template') return false;
      if (sourceFilter === 'manual' && i.source !== 'manual' && i.source !== 'one_time') return false;
      if (sourceFilter === 'pending' && i.generation_state !== 'pending_generation') return false;
      if (sourceFilter === 'generated' && i.generation_state !== 'generated') return false;
      if (scope === 'unassigned' && (i.assignee || i.generation_state !== 'generated')) return false;
      return true;
    });
  }, [data, search, zoneFilter, sourceFilter, scope]);

  const rows = useMemo(() => {
    // Guest requests pin to the top; the rest stay chronological — the
    // next pending occurrence sits on top, not the farthest-future one.
    // Generated work lands before its successor occurrences naturally
    // since it generated earlier.
    const t = (i: TodayTaskItem) => {
      const d = i.scheduled_at ? new Date(i.scheduled_at).getTime() : NaN;
      return isNaN(d) ? Number.MAX_SAFE_INTEGER : d;
    };
    const gr = (i: TodayTaskItem) => (i.origin === 'guest_request' ? 0 : 1);
    return [...filtered].sort((a, b) => gr(a) - gr(b) || t(a) - t(b));
  }, [filtered]);

  const grouped = useMemo(() => {
    const g: Record<string, TodayTaskItem[]> = Object.fromEntries(
      GROUPS.map((d) => [d.key, []])
    );
    for (const item of rows) {
      const def = GROUPS.find((d) => d.match(item));
      g[def ? def.key : 'other'].push(item);
    }
    return g;
  }, [rows]);

  // Any active filter/search force-expands every group — collapsed feeds
  // must never hide a row the user is explicitly looking for.
  const filtersActive =
    !!search.trim() || !!zoneFilter || sourceFilter !== 'all' || scope !== 'all';
  const groupIsOpen = (key: string) => filtersActive || !!openGroups[key];

  // Row aging tint — generated = green baseline; open task stale >1h yellow,
  // >3h red (red wins over yellow wins over green). Age is measured from the
  // item's scheduled time.
  const rowTint = (i: TodayTaskItem): string => {
    if (i.generation_state !== 'generated') return '';
    const open = !i.work_status
      || !['completed', 'cancelled', 'abandoned'].includes(i.work_status);
    if (open && i.scheduled_at) {
      const hrs = (Date.now() - new Date(i.scheduled_at).getTime()) / 3.6e6;
      if (hrs > 3) return 'bg-[#FAEBEB]';
      if (hrs > 1) return 'bg-[#F2D9AF]';
    }
    return 'bg-[#F7E9EE]';
  };

  const renderRow = (item: TodayTaskItem) => {
    const pending = item.generation_state === 'pending_generation';
    const gen = GEN_BADGE[item.generation_state] || GEN_BADGE.generated;
    return (
      <tr
        key={item.occurrence_key || item.task_uid}
        className={`border-b border-[#F6F4F2] last:border-0 transition hover:brightness-[0.985] ${rowTint(item)}`}
      >
        <td className="px-3.5 py-2.5 whitespace-nowrap text-[12px] text-[#667085]">
          <span className="inline-flex items-center gap-1.5">
            <Clock className="w-3 h-3 text-[#98A2B3]" /> {fmtTime(item.scheduled_at)}
          </span>
        </td>
        <td className="px-3.5 py-2.5">
          <p className="font-semibold text-[13px] text-[#0D1C42] leading-tight">{item.title}</p>
          <span className="inline-flex items-center gap-1.5 mt-0.5">
            {item.origin === 'guest_request' && (
              <Badge variant="orange" size="sm">Guest Request</Badge>
            )}
            {item.ticket_number && (
              <span className="text-[10.5px] text-[#667085]">{item.ticket_number}</span>
            )}
          </span>
        </td>
        <td className="px-3.5 py-2.5 text-[12px] text-[#667085]">
          {item.target_label || item.room_number || 'Property-wide'}
        </td>
        <td className="px-3.5 py-2.5 text-[12px] text-[#667085] whitespace-nowrap">
          {item.zone_name || '—'}
        </td>
        <td className="px-3.5 py-2.5 text-[12px] whitespace-nowrap">
          {pending ? (
            <span className="text-[#667085]">
              {item.allocation_method === 'zone_round_robin'
                ? 'Auto · Round Robin'
                : item.assignment_mode === 'individual' ? 'Individual' : item.assignment_mode || '—'}
            </span>
          ) : (
            <span className="text-[#667085]">{item.assignee || 'Unassigned'}</span>
          )}
        </td>
        <td className="px-3.5 py-2.5 whitespace-nowrap">
          <Badge variant={gen.variant} size="sm">{gen.label}</Badge>
        </td>
        <td className="px-3.5 py-2.5 whitespace-nowrap">
          {item.work_status ? (
            <Badge variant={WORK_BADGE[item.work_status] || 'neutral'} size="sm">
              {item.work_status.replace(/_/g, ' ')}
            </Badge>
          ) : '—'}
        </td>
        <td className="px-3.5 py-2.5 text-right whitespace-nowrap">
          {pending ? (
            <button
              onClick={() => void generate(item)}
              disabled={generating === item.occurrence_key}
              className="px-2.5 py-1.5 text-xs font-semibold text-[#800020] hover:bg-[#F7E9EE] rounded-[8px] inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
            >
              <Zap className="w-3.5 h-3.5" />
              {generating === item.occurrence_key ? 'Generating…' : 'Generate Now'}
            </button>
          ) : (
            <button
              onClick={() => item.task_uid && onOpenTask(item.task_uid)}
              className="px-2.5 py-1.5 text-xs font-semibold text-[#800020] hover:bg-[#F7E9EE] rounded-[8px] inline-flex items-center gap-1 cursor-pointer"
            >
              Open <ChevronRight className="w-3.5 h-3.5" />
            </button>
          )}
        </td>
      </tr>
    );
  };

  const summary = data?.summary;
  const attention = summary
    ? [
        { n: summary.overdue, l: 'Overdue', icon: AlertTriangle, tone: 'text-[#A83434] bg-[#FAEBEB] border-[#F0C8C8]' },
        { n: summary.pending_generation, l: 'Pending Generation', icon: Timer, tone: 'text-[#A56514] bg-[#FFFCFA] border-[#F2D9AF]' },
        { n: summary.unassigned, l: 'Unassigned', icon: UserCheck, tone: 'text-[#667085] bg-[#FFFCFA] border-[#E7E5E4]' },
      ].filter((x) => x.n > 0)
    : [];

  return (
    <div className="space-y-4">
      {/* Header + summary */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display font-bold text-xl text-[#0D1C42]">Today's Tasks</h2>
          <p className="text-sm text-[#667085]">
            {data ? fmtDateLongIST(data.date) : ''}
          </p>
        </div>
        {summary && (
          <div className="flex flex-wrap gap-1.5">
            {([
              { l: 'Planned', n: summary.total_planned, icon: CalendarClock, tone: 'bg-[#E9EDF5] border-[#C9D4EA] text-[#0D1C42]' },
              { l: 'Generated', n: summary.generated, icon: Zap, tone: 'bg-[#F7E9EE] border-[#EAD3DB] text-[#800020]' },
              { l: 'Pending', n: summary.pending_generation, icon: Timer, tone: 'bg-[#FFF1E4] border-[#F4DCC3] text-[#A56514]' },
              { l: 'Assigned', n: summary.assigned, icon: UserCheck, tone: 'bg-[#EAF1FB] border-[#C3D6F0] text-[#2457A8]' },
              { l: 'In Progress', n: summary.in_progress, icon: Clock, tone: 'bg-[#F0EBFA] border-[#D8CAF0] text-[#5C41A5]' },
              { l: 'Completed', n: summary.completed, icon: CheckCircle2, tone: 'bg-[#E6F4EE] border-[#BFE3D2] text-[#0F6847]' },
              { l: 'Abandoned', n: summary.abandoned, icon: Ban, tone: 'bg-[#FAEBEB] border-[#F0C8C8] text-[#A83434]' },
              { l: 'Overdue', n: summary.overdue, icon: AlertTriangle, tone: 'bg-[#790D16] border-[#790D16] text-white' },
            ] as const).map(({ l, n, icon: Icon, tone }) => (
              <span key={l} className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[9px] text-[11px] font-semibold border ${tone}`}>
                <Icon className="w-3 h-3" />
                {l} <span className="font-num tabular-nums font-bold">{n}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Needs attention */}
      {attention.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attention.map((a) => {
            const Icon = a.icon;
            return (
              <button key={a.l}
                onClick={() => {
                  if (a.l === 'Pending Generation') setSourceFilter('pending');
                  else if (a.l === 'Unassigned') setScope('unassigned');
                }}
                className={`flex items-center gap-2 px-3 py-2 rounded-[10px] border text-xs font-semibold cursor-pointer ${a.tone}`}>
                <Icon className="w-3.5 h-3.5" /> {a.n} {a.l}
              </button>
            );
          })}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#98A2B3]" />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks…" className={`${inputCls} w-full pl-8`} />
        </div>
        <select value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value)} className={`${inputCls} cursor-pointer`}>
          <option value="">All zones</option>
          {currentPropertyZones.map((z) => <option key={z.zone_uid} value={z.name}>{z.name}</option>)}
        </select>
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} className={`${inputCls} cursor-pointer`}>
          <option value="all">All sources</option>
          <option value="generated">Generated</option>
          <option value="pending">Pending generation</option>
          <option value="template">Template</option>
          <option value="manual">Manual / One-time</option>
        </select>
        <div className="flex items-center gap-1 bg-[#F6F4F2] rounded-[10px] p-1">
          {(['all', 'unassigned'] as const).map((s) => (
            <button key={s} onClick={() => setScope(s)}
              className={`px-3 py-1.5 text-xs font-medium rounded-[8px] cursor-pointer ${
                scope === s ? 'bg-white text-[#0D1C42] shadow-sm' : 'text-[#667085]'
              }`}>
              {s === 'all' ? 'All Tasks' : 'Unassigned'}
            </button>
          ))}
        </div>
        <button onClick={() => void load()} className="p-2 text-[#667085] hover:bg-[#FFFCFA] rounded-[9px] cursor-pointer" title="Refresh">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Table */}
      {loading ? (
        <p className="text-sm text-[#667085] py-12 text-center">Loading today's schedule…</p>
      ) : rows.length === 0 ? (
        <div className="py-16 text-center">
          <CalendarCheck className="w-10 h-10 text-[#D6D3D1] mx-auto mb-3" />
          <p className="text-sm font-medium text-[#667085]">No work scheduled for today</p>
          <p className="text-xs text-[#667085] mt-1">
            There are currently no scheduled or generated tasks for this property.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {GROUPS.map((g) => {
            const items = grouped[g.key];
            const open = groupIsOpen(g.key);
            const Icon = g.icon;
            if (g.hideWhenEmpty && items.length === 0) return null;
            return (
              <div
                key={g.key}
                className={`rounded-[12px] border border-l-[3px] border-[#E7E5E4] ${g.bar} bg-white overflow-hidden`}
              >
                <button
                  onClick={() =>
                    setOpenGroups((p) => ({ ...p, [g.key]: !p[g.key] }))
                  }
                  className="w-full flex items-center gap-2.5 px-4 py-3 text-left hover:bg-[#FFFCFA] transition-colors cursor-pointer"
                >
                  <ChevronDown
                    className={`w-4 h-4 text-[#667085] transition-transform ${open ? '' : '-rotate-90'}`}
                  />
                  <Icon className={`w-4 h-4 ${g.tone}`} />
                  <span className="font-display font-semibold text-sm text-[#0D1C42]">
                    {g.label}
                  </span>
                  <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${g.badge}`}>
                    {items.length}
                  </span>
                </button>
                {open && (
                  items.length === 0 ? (
                    <p className="px-4 pb-3.5 -mt-1 text-xs text-[#667085]">
                      No tasks in this group.
                    </p>
                  ) : (
                    <div className="border-t border-[#E7E5E4] overflow-x-auto">
                      <table className="w-full text-left text-sm min-w-[860px]">
                        {TABLE_HEAD}
                        <tbody>{items.map(renderRow)}</tbody>
                      </table>
                    </div>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default TodayTasksView;
