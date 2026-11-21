import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeftRight, Crown, Plus, RefreshCw, Search } from 'lucide-react';
import { departmentWorkApi, type DeptPerformance, type DeptRoster } from '../../../api/departmentWork';
import { departmentWorkApi as dw } from '../../../api/departmentWork';
import { WorkCalendar } from '../../calendar/WorkCalendar';
import { TaskDetailDrawer } from '../../tasks/TaskDetailDrawer';
import { AllocateWorkModal } from './AllocateWorkModal';
import { useApp } from '../../../context/AppContext';
import type { Task } from '../../../types';

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const STATUS_CHIP: Record<string, string> = {
  pending: 'bg-[#FFF1E4] text-[#8A5A10]',
  assigned: 'bg-[#E9EFFB] text-[#2B5FA8]',
  in_progress: 'bg-[#F0EAFC] text-[#5C3FA8]',
  submitted: 'bg-[#E3F3EC] text-[#0E6B47]',
  reopened: 'bg-[#FFF1E4] text-[#8A5A10]',
  completed: 'bg-[#E3F3EC] text-[#0E6B47]',
  overdue: 'bg-[#FBE6E6] text-[#A83434]',
  abandoned: 'bg-[#EFF1F4] text-[#5A6472]',
  cancelled: 'bg-[#EFF1F4] text-[#5A6472]',
};
const chip = (s: string) => STATUS_CHIP[s] ?? STATUS_CHIP.pending;

// ---------------------------------------------------------------------------
// Employees tab — roster with shift, attendance and workload
// ---------------------------------------------------------------------------
export const DeptEmployeesTab: React.FC<{ roster: DeptRoster | null }> = ({ roster }) => {
  const { propertyUid } = useParams();
  const [q, setQ] = useState('');
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (roster?.items ?? []).filter((r) => !needle || r.name.toLowerCase().includes(needle));
  }, [roster, q]);
  if (!roster) return <p className="text-sm text-[#667085]">Loading roster…</p>;
  return (
    <div className="space-y-3">
      <div className="relative max-w-xs">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#98A2B3]" />
        <input
          value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search employees…"
          className="w-full pl-9 pr-3 py-2 bg-white border border-[#E7E5E4] rounded-[9px] text-sm focus:outline-none focus:ring-1 focus:ring-[#800020]"
        />
      </div>
      <div className="rounded-xl border border-[#E7E5E4] bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-[#667085] bg-[#F6F4F2]">
              <th className="px-4 py-2.5 font-medium">Employee</th>
              <th className="px-4 py-2.5 font-medium">Shift today</th>
              <th className="px-4 py-2.5 font-medium">Attendance</th>
              <th className="px-4 py-2.5 font-medium text-right">Open work</th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.employee_uid} className="border-t border-[#F6F4F2] hover:bg-[#FFFCFA]">
                <td className="px-4 py-2.5">
                  <Link to={`/property/${propertyUid}/workforce/employees/${e.employee_uid}`}
                    className="font-medium text-[#0D1C42] hover:underline">
                    {e.name}
                  </Link>
                  {e.is_head && <Crown className="w-3.5 h-3.5 inline ml-1.5 text-[#A56514]" />}
                </td>
                <td className="px-4 py-2.5 text-[#667085]">
                  {e.shift?.scheduled
                    ? `${e.shift.name} · ${e.shift.start_time}–${e.shift.end_time}`
                    : e.shift ? `${e.shift.name} — off` : '—'}
                </td>
                <td className="px-4 py-2.5">
                  {e.on_duty
                    ? <span className="text-[#0E6B47] font-medium">On duty</span>
                    : <span className="text-[#667085]">{e.attendance_status ?? 'not marked'}</span>}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span className={e.open_tasks > 0 ? 'font-semibold text-[#0D1C42]' : 'text-[#98A2B3]'}>
                    {e.open_tasks}
                  </span>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-[#667085]">No employees match.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Work Allocation tab — the department's work table + Allocate action
// ---------------------------------------------------------------------------
export const DeptWorkTab: React.FC<{ departmentUid: string; roster: DeptRoster | null; onChanged?: () => void }> = ({
  departmentUid, roster, onChanged,
}) => {
  const { activePropertyUid, zones } = useApp();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [status, setStatus] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [search, setSearch] = useState('');
  const [allocOpen, setAllocOpen] = useState(false);
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await dw.listWork(departmentUid, {
        status: status || undefined, employee_id: employeeId || undefined,
        search: search || undefined, limit: 100,
      });
      setTasks(res.items);
      setErr(null);
    } catch (e) {
      setErr((e as { message?: string })?.message || 'Could not load work.');
    }
  }, [departmentUid, status, employeeId, search]);

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  const selectCls =
    'px-2.5 py-1.5 bg-white border border-[#E7E5E4] rounded-[8px] text-[13px] text-[#0D1C42]';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#98A2B3]" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search work…"
            className="pl-9 pr-3 py-1.5 bg-white border border-[#E7E5E4] rounded-[8px] text-[13px] w-52 focus:outline-none focus:ring-1 focus:ring-[#800020]" />
        </div>
        <select className={selectCls} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
          <option value="">All employees</option>
          {(roster?.items ?? []).map((r) => <option key={r.employee_uid} value={r.employee_uid}>{r.name}</option>)}
        </select>
        <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {Object.keys(STATUS_CHIP).map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
        <button onClick={() => void load()} className="p-1.5 rounded-[7px] border border-[#E7E5E4] text-[#667085] hover:bg-[#F6F4F2]">
          <RefreshCw className="w-4 h-4" />
        </button>
        <div className="flex-1" />
        <button onClick={() => setAllocOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] bg-[#800020] text-white text-[13px] font-semibold hover:bg-[#0D1C42]">
          <Plus className="w-4 h-4" /> Allocate Work
        </button>
      </div>
      {err && <p className="text-[12px] text-[#A83434]">{err}</p>}
      <div className="rounded-xl border border-[#E7E5E4] bg-white overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-[#667085] bg-[#F6F4F2]">
              <th className="px-4 py-2.5 font-medium">Work</th>
              <th className="px-4 py-2.5 font-medium">Assignee</th>
              <th className="px-4 py-2.5 font-medium">Scheduled</th>
              <th className="px-4 py-2.5 font-medium">Due</th>
              <th className="px-4 py-2.5 font-medium">Priority</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.task_uid} onClick={() => setOpenTask(t)}
                className="border-t border-[#F6F4F2] hover:bg-[#FFFCFA] cursor-pointer">
                <td className="px-4 py-2.5">
                  <span className="font-medium text-[#0D1C42]">{t.title}</span>
                  {(t.checklist?.length ?? 0) > 0 && (
                    <span className="ml-1.5 text-[10px] text-[#667085]">☑{t.checklist!.length}</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-[#667085]">{t.assigned_to_name ?? 'Unassigned'}</td>
                <td className="px-4 py-2.5 text-[#667085]">
                  {t.scheduled_for
                    ? new Date(t.scheduled_for).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
                    : t.due_date?.slice(0, 10) ?? '—'}
                </td>
                <td className="px-4 py-2.5 text-[#667085]">
                  {t.due_date?.slice(0, 10) ?? '—'}{t.due_time ? ` ${t.due_time.slice(0, 5)}` : ''}
                </td>
                <td className="px-4 py-2.5 text-[#667085]">{t.priority}</td>
                <td className="px-4 py-2.5">
                  <span className={`text-[11px] px-1.5 py-0.5 rounded-[5px] font-medium ${chip(t.status)}`}>
                    {t.status.replace('_', ' ')}
                  </span>
                </td>
              </tr>
            ))}
            {tasks.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-[#667085]">
                No work allocated yet — use Allocate Work to create the department's first task.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <AllocateWorkModal
        open={allocOpen}
        onClose={() => setAllocOpen(false)}
        departmentUid={departmentUid}
        roster={roster?.items ?? []}
        zones={(zones ?? []).map((z) => ({ zone_uid: z.zone_uid, name: z.name }))}
        onAllocated={() => { void load(); onChanged?.(); }}
      />
      <TaskDetailDrawer task={openTask} onClose={() => setOpenTask(null)} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Calendar tab — the department's work on the shared calendar
// ---------------------------------------------------------------------------
export const DeptCalendarTab: React.FC<{ departmentUid: string }> = ({ departmentUid }) => {
  const { activePropertyUid } = useApp();
  const [range, setRange] = useState(() => {
    const end = new Date(); end.setDate(end.getDate() + 13);
    return { from: isoDay(new Date()), to: isoDay(end) };
  });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [openTask, setOpenTask] = useState<Task | null>(null);

  useEffect(() => {
    if (!activePropertyUid) return;
    departmentWorkApi.calendar(activePropertyUid, range.from, range.to, { department_id: departmentUid })
      .then((r) => setTasks(r.items))
      .catch(() => setTasks([]));
  }, [activePropertyUid, departmentUid, range]);

  return (
    <>
      <WorkCalendar
        tasks={tasks} range={range}
        onRangeChange={(from, to) => setRange({ from, to })}
        onEventClick={setOpenTask}
      />
      <TaskDetailDrawer task={openTask} onClose={() => setOpenTask(null)} />
    </>
  );
};

// ---------------------------------------------------------------------------
// Performance tab
// ---------------------------------------------------------------------------
export const DeptPerformanceTab: React.FC<{ departmentUid: string }> = ({ departmentUid }) => {
  const [perf, setPerf] = useState<DeptPerformance | null>(null);
  useEffect(() => {
    departmentWorkApi.performance(departmentUid)
      .then(setPerf).catch(() => setPerf(null));
  }, [departmentUid]);
  if (!perf) return <p className="text-sm text-[#667085]">Loading…</p>;

  const stat = (label: string, v: React.ReactNode) => (
    <div className="rounded-xl border border-[#E7E5E4] bg-white px-4 py-3">
      <div className="font-display text-xl font-bold text-[#0D1C42] tabular-nums">{v}</div>
      <div className="text-[11px] text-[#667085] mt-1">{label}</div>
    </div>
  );
  const maxWeekly = Math.max(1, ...perf.weekly.map((w) => Math.max(w.created, w.completed)));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {stat('Assigned', Object.values(perf.totals).reduce((a, b) => a + b, 0) - (perf.totals.overdue ?? 0))}
        {stat('Completed', perf.totals.completed ?? 0)}
        {stat('Overdue', perf.totals.overdue ?? 0)}
        {stat('Avg start→submit', perf.avg_start_to_submit_minutes != null
          ? `${Math.round(perf.avg_start_to_submit_minutes / 60)}h ${Math.round(perf.avg_start_to_submit_minutes % 60)}m`
          : '—')}
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-[#E7E5E4] bg-white p-4">
          <h3 className="text-[13px] font-semibold text-[#0D1C42] mb-3">Assigned vs completed — weekly</h3>
          <div className="space-y-2">
            {perf.weekly.length === 0 && <p className="text-[12px] text-[#667085]">No work in this period.</p>}
            {perf.weekly.map((w) => (
              <div key={w.week} className="flex items-center gap-2 text-[11px]">
                <span className="w-20 text-[#667085]">{new Date(w.week + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
                <div className="flex-1 space-y-0.5">
                  <div className="h-2 rounded-full bg-[#800020]" style={{ width: `${(w.created / maxWeekly) * 100}%` }} />
                  <div className="h-2 rounded-full bg-[#16865B]" style={{ width: `${(w.completed / maxWeekly) * 100}%` }} />
                </div>
                <span className="w-14 text-right text-[#667085]">{w.created}/{w.completed}</span>
              </div>
            ))}
          </div>
          <div className="flex gap-4 mt-3 text-[11px] text-[#667085]">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#800020]" />Assigned</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#16865B]" />Completed</span>
          </div>
        </div>

        <div className="rounded-xl border border-[#E7E5E4] bg-white p-4">
          <h3 className="text-[13px] font-semibold text-[#0D1C42] mb-3">Workload distribution</h3>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[11px] text-[#667085] uppercase">
                <th className="py-1 font-medium">Employee</th>
                <th className="text-right font-medium">Open</th>
                <th className="text-right font-medium">In review</th>
                <th className="text-right font-medium">Done</th>
                <th className="text-right font-medium">Overdue</th>
              </tr>
            </thead>
            <tbody>
              {perf.per_employee.map((e) => (
                <tr key={e.employee_uid ?? 'none'} className="border-t border-[#F6F4F2]">
                  <td className="py-1.5 font-medium text-[#0D1C42]">{e.name}</td>
                  <td className="text-right">{e.open}</td>
                  <td className="text-right">{e.submitted}</td>
                  <td className="text-right">{e.completed}</td>
                  <td className={`text-right ${e.overdue ? 'text-[#A83434] font-semibold' : ''}`}>{e.overdue}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

// Re-export icon for the parent tab bar
export { ArrowLeftRight };
