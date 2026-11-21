import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, ChevronLeft, ChevronRight, History } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import * as tasksApi from '../../api/tasks';
import { TaskHistoryItem, TaskHistoryResponse } from '../../api/types';
import { Badge } from '../ui/Badge';
import { fmtTimeIST, fmtDateTimeIST, parseIso, isSameISTDay, istDateKeyOffset } from '../../lib/datetime';

const inputCls =
  'px-2.5 py-2 text-xs bg-white border border-[#E7E5E4] rounded-[9px] focus:outline-none focus:ring-[3px] focus:ring-[#800020]/15 focus:border-[#800020]';

const STATUS_VARIANT: Record<string, 'sage' | 'orange' | 'red' | 'lavender' | 'neutral'> = {
  assigned: 'lavender', pending: 'neutral', in_progress: 'orange',
  completed: 'sage', submitted: 'sage', overdue: 'red', cancelled: 'neutral',
  abandoned: 'red', reopened: 'orange',
};

const DATE_PRESETS = [
  { v: 'all', l: 'All time' }, { v: 'today', l: 'Today' },
  { v: 'yesterday', l: 'Yesterday' }, { v: '7d', l: 'Last 7 days' },
  { v: '30d', l: 'Last 30 days' },
];

function dateRange(preset: string): { date_from?: string; date_to?: string } {
  // IST calendar days — not UTC slices; IST has no DST so day math is exact
  const d = istDateKeyOffset;
  switch (preset) {
    case 'today': return { date_from: d(0), date_to: d(0) };
    case 'yesterday': return { date_from: d(-1), date_to: d(-1) };
    case '7d': return { date_from: d(-6), date_to: d(0) };
    case '30d': return { date_from: d(-29), date_to: d(0) };
    default: return {};
  }
}

function fmtTs(iso?: string): string {
  const d = parseIso(iso);
  if (!d) return '—';
  return isSameISTDay(d) ? fmtTimeIST(d) : fmtDateTimeIST(d);
}

interface Props {
  onOpenTask: (taskUid: string) => void;
}

export const TaskHistoryView: React.FC<Props> = ({ onOpenTask }) => {
  const { activePropertyUid, currentPropertyZones, currentPropertyEmployees, addToast } = useApp();
  const [data, setData] = useState<TaskHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [preset, setPreset] = useState('all');
  const [zoneFilter, setZoneFilter] = useState('');
  const [employeeFilter, setEmployeeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [page, setPage] = useState(1);
  const debRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // debounce search → server-side filtering (never client-filter a full table)
  useEffect(() => {
    if (debRef.current) clearTimeout(debRef.current);
    debRef.current = setTimeout(() => setDebounced(search), 350);
    return () => { if (debRef.current) clearTimeout(debRef.current); };
  }, [search]);

  const load = useCallback(async () => {
    if (!activePropertyUid) return;
    setLoading(true);
    try {
      const zone = currentPropertyZones.find((z) => z.name === zoneFilter);
      const res = await tasksApi.tasksHistory({
        property_uid: activePropertyUid,
        ...dateRange(preset),
        zone_uid: zone?.zone_uid,
        employee_uid: employeeFilter || undefined,
        status: statusFilter || undefined,
        priority: priorityFilter || undefined,
        task_type: typeFilter || undefined,
        source: sourceFilter || undefined,
        search: debounced || undefined,
        page,
        page_size: 25,
      });
      setData(res);
    } catch {
      addToast({ type: 'error', title: 'Could not load task history' });
    } finally {
      setLoading(false);
    }
  }, [activePropertyUid, preset, zoneFilter, employeeFilter, statusFilter,
      priorityFilter, typeFilter, sourceFilter, debounced, page,
      currentPropertyZones, addToast]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setPage(1); }, [preset, zoneFilter, employeeFilter, statusFilter, priorityFilter, typeFilter, sourceFilter, debounced]);

  const p = data?.pagination;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display font-bold text-xl text-[#0D1C42] flex items-center gap-2">
          Task History
          {p && <span className="text-xs font-semibold text-[#667085] bg-[#F6F4F2] px-2 py-0.5 rounded-full">{p.total} generated</span>}
        </h2>
        <p className="text-sm text-[#667085]">All generated and allocated work — every actual task instance.</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#98A2B3]" />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Task ID, name, employee, room…" className={`${inputCls} w-full pl-8`} />
        </div>
        <div className="flex items-center gap-1 bg-[#F6F4F2] rounded-[9px] p-1">
          {DATE_PRESETS.map((d) => (
            <button key={d.v} onClick={() => setPreset(d.v)}
              className={`px-2.5 py-1.5 text-[11px] font-medium rounded-[7px] cursor-pointer ${
                preset === d.v ? 'bg-white text-[#0D1C42] shadow-sm' : 'text-[#667085]'
              }`}>
              {d.l}
            </button>
          ))}
        </div>
        <select value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value)} className={`${inputCls} cursor-pointer`}>
          <option value="">All zones</option>
          {currentPropertyZones.map((z) => <option key={z.zone_uid} value={z.name}>{z.name}</option>)}
        </select>
        <select value={employeeFilter} onChange={(e) => setEmployeeFilter(e.target.value)} className={`${inputCls} cursor-pointer`}>
          <option value="">All employees</option>
          {currentPropertyEmployees.map((e) => <option key={e.employee_uid} value={e.employee_uid}>{e.name}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={`${inputCls} cursor-pointer`}>
          <option value="">All statuses</option>
          {['pending', 'assigned', 'in_progress', 'submitted', 'completed', 'overdue', 'cancelled', 'abandoned', 'reopened'].map((s) =>
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
        <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)} className={`${inputCls} cursor-pointer`}>
          <option value="">All priorities</option>
          {['low', 'medium', 'high', 'urgent'].map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className={`${inputCls} cursor-pointer`}>
          <option value="">All types</option>
          {['fixed', 'repetitive', 'automated'].map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} className={`${inputCls} cursor-pointer`}>
          <option value="">All sources</option>
          <option value="template">Template</option>
          <option value="recurring">Recurring</option>
          <option value="manual">Manual</option>
        </select>
      </div>

      {/* Table */}
      {loading ? (
        <p className="text-sm text-[#667085] py-12 text-center">Loading history…</p>
      ) : !data || data.items.length === 0 ? (
        <div className="py-16 text-center">
          <History className="w-10 h-10 text-[#D6D3D1] mx-auto mb-3" />
          <p className="text-sm font-medium text-[#667085]">No generated tasks found</p>
          <p className="text-xs text-[#667085] mt-1">
            Generated tasks will appear here once work is created and allocated.
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-[14px] border border-[#E7E5E4] overflow-hidden">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="bg-[#FFFCFA] border-b border-[#E7E5E4] text-left">
                {['Task ID', 'Task', 'Location', 'Zone', 'Assigned To', 'Generated', 'Scheduled', 'Status', 'Priority', 'Source'].map((h) => (
                  <th key={h} className="px-3 py-2.5 text-[10.5px] font-semibold text-[#667085] uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F6F4F2]">
              {data.items.map((t: TaskHistoryItem) => (
                <tr key={t.task_uid} onClick={() => onOpenTask(t.task_uid)}
                  className="hover:bg-[#FFFFFF] cursor-pointer transition-colors">
                  <td className="px-3 py-2.5 font-mono text-[11px] font-semibold text-[#800020] whitespace-nowrap">
                    {t.ticket_number || '—'}
                  </td>
                  <td className="px-3 py-2.5 font-medium text-[#0D1C42] max-w-[200px] truncate">{t.title}</td>
                  <td className="px-3 py-2.5 text-[#667085]">{t.room_number || '—'}</td>
                  <td className="px-3 py-2.5 text-[#667085]">{t.zone_name || '—'}</td>
                  <td className="px-3 py-2.5 text-[#667085]">{t.assigned_to || <span className="text-[#98A2B3]">Unassigned</span>}</td>
                  <td className="px-3 py-2.5 text-[#667085] whitespace-nowrap">{fmtTs(t.generated_at)}</td>
                  <td className="px-3 py-2.5 text-[#667085] whitespace-nowrap">{fmtTs(t.scheduled_for)}</td>
                  <td className="px-3 py-2.5">
                    <Badge variant={STATUS_VARIANT[t.status] || 'neutral'} size="sm">
                      {t.status.replace(/_/g, ' ')}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge variant={t.priority === 'urgent' || t.priority === 'critical' ? 'red' : t.priority === 'high' ? 'orange' : 'neutral'} size="sm">
                      {t.priority}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5 text-[#667085] capitalize">
                    {t.source}{t.template_version ? ` v${t.template_version}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Pagination */}
          {p && p.total_pages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-[#E7E5E4] bg-[#FFFFFF]">
              <p className="text-[11px] text-[#667085]">
                Page {p.page} of {p.total_pages} · {p.total} tasks
              </p>
              <div className="flex gap-1.5">
                <button disabled={page <= 1} onClick={() => setPage((x) => x - 1)}
                  className="p-1.5 rounded-[7px] border border-[#E7E5E4] text-[#667085] hover:bg-white disabled:opacity-40 cursor-pointer">
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <button disabled={page >= p.total_pages} onClick={() => setPage((x) => x + 1)}
                  className="p-1.5 rounded-[7px] border border-[#E7E5E4] text-[#667085] hover:bg-white disabled:opacity-40 cursor-pointer">
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default TaskHistoryView;
