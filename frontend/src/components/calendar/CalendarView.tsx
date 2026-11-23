import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { departmentWorkApi } from '../../api/departmentWork';
import { listDepartments, type Department } from '../../api/departments';
import { WorkCalendar, type CalendarViewMode } from './WorkCalendar';
import { TaskDetailDrawer } from '../tasks/TaskDetailDrawer';
import { BackButton } from '../ui/BackButton';
import { Button } from '../ui/Button';
import { AllocateWorkModal } from '../employees/management/AllocateWorkModal';
import type { Task } from '../../types';

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const STATUS_OPTIONS = ['pending', 'assigned', 'in_progress', 'submitted', 'completed', 'overdue', 'abandoned', 'scheduled'];
const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'urgent'];
const TYPE_OPTIONS = ['cleaning', 'maintenance', 'inspection', 'housekeeping', 'other'];

/** Property-wide work calendar — real tasks over the selected range. */
export const CalendarView: React.FC = () => {
  const { activePropertyUid, currentPropertyEmployees, currentPropertyZones, currentUser } = useApp();
  const today = isoDay(new Date());
  const [range, setRange] = useState(() => {
    const end = new Date();
    end.setDate(end.getDate() + 13);
    return { from: today, to: isoDay(end) };
  });
  const [view, setView] = useState<CalendarViewMode>('week');
  const [items, setItems] = useState<Task[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [filters, setFilters] = useState<{
    department_id?: string; status?: string;
    priority?: string; work_type?: string; zone_id?: string; search?: string;
  }>({});
  const [pickedEmps, setPickedEmps] = useState<Set<string>>(new Set());
  const [empPickOpen, setEmpPickOpen] = useState(false);
  const [empFilter, setEmpFilter] = useState('');
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDeptManager = currentUser?.role === 'department_manager';

  const load = useCallback(async () => {
    if (!activePropertyUid) return;
    try {
      const res = await departmentWorkApi.calendar(
        activePropertyUid, range.from, range.to, {
          ...filters,
          employee_ids: pickedEmps.size ? [...pickedEmps] : undefined,
        });
      setItems(res.items);
      setError(null);
    } catch (e) {
      setError((e as { message?: string })?.message || 'Could not load the calendar.');
    }
  }, [activePropertyUid, range, filters, pickedEmps]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!activePropertyUid) return;
    listDepartments({ property_uid: activePropertyUid })
      .then(setDepartments)
      .catch(() => setDepartments([]));
  }, [activePropertyUid]);

  const set = (k: keyof typeof filters, v: string) =>
    setFilters((f) => ({ ...f, [k]: v || undefined }));

  const toggleEmp = (uid: string) =>
    setPickedEmps((s) => { const n = new Set(s); n.has(uid) ? n.delete(uid) : n.add(uid); return n; });

  const selectCls =
    'px-2.5 py-1.5 bg-white border border-[#E7E5E4] rounded-[8px] text-[13px] text-[#0D1C42] focus:outline-none focus:ring-1 focus:ring-[#800020]';

  const activeEmployees = currentPropertyEmployees.filter((e) => !e.deactivated_at);
  const filteredEmps = activeEmployees.filter(
    (e) => !empFilter || e.name.toLowerCase().includes(empFilter.toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div>
          <div className="mb-2">
            <BackButton to={`/property/${activePropertyUid}/operations/tasks`} />
          </div>
          <h1 className="font-display font-semibold text-[26px] text-[#0D1C42] tracking-tight">
            Calendar
          </h1>
          <p className="font-body text-sm text-[#667085] mt-1">
            {isDeptManager
              ? 'Scheduled work across your departments'
              : 'All scheduled work across the property — allocated, generated and recurring'}
          </p>
        </div>
        <Button variant="primary" onClick={() => setAssignOpen(true)}>
          <Plus className="w-4 h-4 mr-1.5" /> Assign Work
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {!isDeptManager && departments.length > 0 && (
          <select className={selectCls} value={filters.department_id ?? ''}
            onChange={(e) => set('department_id', e.target.value)}>
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d.department_uid} value={d.department_uid}>{d.name}</option>
            ))}
          </select>
        )}
        <div className="relative">
          <button className={selectCls} onClick={() => setEmpPickOpen((o) => !o)}>
            {pickedEmps.size
              ? `${pickedEmps.size} employee${pickedEmps.size > 1 ? 's' : ''}`
              : 'All employees'}
          </button>
          {empPickOpen && (
            <div className="absolute z-20 mt-1 w-64 rounded-[10px] border border-[#E7E5E4] bg-white shadow-lg p-2">
              <input
                autoFocus value={empFilter} onChange={(e) => setEmpFilter(e.target.value)}
                placeholder="Search employees…"
                className="w-full px-2.5 py-1.5 mb-1.5 rounded-[7px] border border-[#E7E5E4] text-[12px] focus:outline-none focus:ring-1 focus:ring-[#800020]"
              />
              <div className="max-h-48 overflow-y-auto space-y-0.5">
                {filteredEmps.map((e) => (
                  <label key={e.employee_uid}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-[6px] hover:bg-[#F6F4F2] cursor-pointer text-[12px]">
                    <input type="checkbox" checked={pickedEmps.has(e.employee_uid)}
                      onChange={() => toggleEmp(e.employee_uid)} className="accent-[#800020]" />
                    <span className="truncate">{e.name}</span>
                  </label>
                ))}
                {filteredEmps.length === 0 && (
                  <p className="text-[11px] text-[#667085] px-2 py-1">No matching employees.</p>
                )}
              </div>
            </div>
          )}
        </div>
        <select className={selectCls} value={filters.status ?? ''}
          onChange={(e) => set('status', e.target.value)}>
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{s.replace('_', ' ')}</option>
          ))}
        </select>
        <select className={selectCls} value={filters.priority ?? ''}
          onChange={(e) => set('priority', e.target.value)}>
          <option value="">All priorities</option>
          {PRIORITY_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className={selectCls} value={filters.work_type ?? ''}
          onChange={(e) => set('work_type', e.target.value)}>
          <option value="">All work types</option>
          {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {currentPropertyZones.length > 0 && (
          <select className={selectCls} value={filters.zone_id ?? ''}
            onChange={(e) => set('zone_id', e.target.value)}>
            <option value="">All zones</option>
            {currentPropertyZones.map((z) => (
              <option key={z.zone_uid} value={z.zone_uid}>{z.name}</option>
            ))}
          </select>
        )}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#98A2B3]" />
          <input
            value={filters.search ?? ''}
            onChange={(e) => set('search', e.target.value)}
            placeholder="Search work…"
            className={`${selectCls} pl-8 w-44`}
          />
        </div>
        {(Object.values(filters).some(Boolean) || pickedEmps.size > 0) && (
          <button onClick={() => { setFilters({}); setPickedEmps(new Set()); }}
            className="text-[12px] font-semibold text-[#800020] hover:underline">
            Clear filters
          </button>
        )}
      </div>

      {error && <p className="text-[13px] text-[#A83434]">{error}</p>}

      <WorkCalendar
        tasks={items}
        range={range}
        onRangeChange={(from, to) => setRange({ from, to })}
        view={view}
        onViewChange={setView}
        onEventClick={setOpenTask}
      />

      <TaskDetailDrawer task={openTask} onClose={() => setOpenTask(null)} />

      <AllocateWorkModal
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        zones={currentPropertyZones.map((z) => ({ zone_uid: z.zone_uid, name: z.name }))}
        onAllocated={() => void load()}
      />
    </div>
  );
};
