import React, { useCallback, useEffect, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { departmentWorkApi } from '../../api/departmentWork';
import { listDepartments, type Department } from '../../api/departments';
import { WorkCalendar, type CalendarViewMode } from './WorkCalendar';
import { TaskDetailDrawer } from '../tasks/TaskDetailDrawer';
import { BackButton } from '../ui/BackButton';
import type { Task } from '../../types';

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const STATUS_OPTIONS = ['pending', 'assigned', 'in_progress', 'submitted', 'completed', 'overdue', 'abandoned', 'scheduled'];
const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'urgent'];
const TYPE_OPTIONS = ['cleaning', 'maintenance', 'inspection', 'housekeeping', 'other'];

/** Property-wide work calendar — real tasks over the selected range. */
export const CalendarView: React.FC = () => {
  const { activePropertyUid, currentPropertyEmployees, currentUser } = useApp();
  const today = isoDay(new Date());
  const [range, setRange] = useState(() => {
    const end = new Date();
    end.setDate(end.getDate() + 13);
    return { from: today, to: isoDay(end) };
  });
  const [view, setView] = useState<CalendarViewMode>('agenda');
  const [items, setItems] = useState<Task[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [filters, setFilters] = useState<{
    department_id?: string; employee_id?: string; status?: string;
    priority?: string; work_type?: string;
  }>({});
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isDeptManager = currentUser?.role === 'department_manager';

  const load = useCallback(async () => {
    if (!activePropertyUid) return;
    try {
      const res = await departmentWorkApi.calendar(
        activePropertyUid, range.from, range.to, filters);
      setItems(res.items);
      setError(null);
    } catch (e) {
      setError((e as { message?: string })?.message || 'Could not load the calendar.');
    }
  }, [activePropertyUid, range, filters]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!activePropertyUid) return;
    listDepartments({ property_uid: activePropertyUid })
      .then(setDepartments)
      .catch(() => setDepartments([]));
  }, [activePropertyUid]);

  const set = (k: keyof typeof filters, v: string) =>
    setFilters((f) => ({ ...f, [k]: v || undefined }));

  const selectCls =
    'px-2.5 py-1.5 bg-white border border-[#E7E5E4] rounded-[8px] text-[13px] text-[#0D1C42] focus:outline-none focus:ring-1 focus:ring-[#800020]';

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
        <select className={selectCls} value={filters.employee_id ?? ''}
          onChange={(e) => set('employee_id', e.target.value)}>
          <option value="">All employees</option>
          {currentPropertyEmployees
            .filter((e) => !e.deactivated_at)
            .map((e) => (
              <option key={e.employee_uid} value={e.employee_uid}>{e.name}</option>
            ))}
        </select>
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
        {Object.values(filters).some(Boolean) && (
          <button onClick={() => setFilters({})}
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
    </div>
  );
};
