import React, { useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, List, LayoutGrid, Rows3 } from 'lucide-react';
import type { Task } from '../../types';

/**
 * Shared work calendar — month / week / day / agenda over real task rows.
 * The event date resolves from scheduled_for → due_date → operational_date
 * (never created_at), matching the backend overlap rule.
 */

export type CalendarViewMode = 'month' | 'week' | 'day' | 'agenda';

const STATUS_STYLE: Record<string, { dot: string; chip: string }> = {
  pending:     { dot: '#E99A23', chip: 'bg-[#FFF1E4] text-[#8A5A10]' },
  assigned:    { dot: '#3478D4', chip: 'bg-[#E9EFFB] text-[#2B5FA8]' },
  in_progress: { dot: '#7554C8', chip: 'bg-[#F0EAFC] text-[#5C3FA8]' },
  submitted:   { dot: '#16865B', chip: 'bg-[#E3F3EC] text-[#0E6B47]' },
  reopened:    { dot: '#E99A23', chip: 'bg-[#FFF1E4] text-[#8A5A10]' },
  completed:   { dot: '#16865B', chip: 'bg-[#E3F3EC] text-[#0E6B47]' },
  overdue:     { dot: '#D64545', chip: 'bg-[#FBE6E6] text-[#A83434]' },
  abandoned:   { dot: '#7A8495', chip: 'bg-[#EFF1F4] text-[#5A6472]' },
  cancelled:   { dot: '#7A8495', chip: 'bg-[#EFF1F4] text-[#5A6472]' },
  scheduled:   { dot: '#0D1C42', chip: 'bg-[#E9EDF5] text-[#0D1C42]' },
};
const styleFor = (s: string) => STATUS_STYLE[s] ?? STATUS_STYLE.pending;

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The calendar day a task belongs to — never its creation timestamp. */
export const taskDay = (t: Task): string | null => {
  if (t.scheduled_for) return t.scheduled_for.slice(0, 10);
  if (t.due_date) return t.due_date.slice(0, 10);
  if (t.operational_date) return t.operational_date;
  return null;
};

const taskTime = (t: Task): string | null => {
  if (t.scheduled_for && t.scheduled_for.includes('T')) {
    const d = new Date(t.scheduled_for);
    return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  if (t.due_time) return t.due_time.slice(0, 5);
  if (t.due_date && t.due_date.includes('T')) {
    const d = new Date(t.due_date);
    return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return null;
};

/** 'HH:MM–HH:MM' work window when the assignment carries one — the shared
 * schedule contract also shown on the employee calendar. */
const windowLabel = (t: Task): string | null => {
  const s = t.start_time?.slice(0, 5);
  const e = t.end_time?.slice(0, 5);
  if (s && e) return `${s}–${e}`;
  if (s) return `${s}–`;
  return taskTime(t);
};

/** Effective status for display — open work past its scheduled end is
 * overdue (server-computed, consistent with the employee calendar). */
const displayStatus = (t: Task): string =>
  t.is_overdue && !['completed', 'cancelled', 'submitted', 'abandoned'].includes(t.status)
    ? 'overdue'
    : t.status;

const locationLabel = (t: Task): string | null =>
  t.room_number ? `Room ${t.room_number}`
    : t.dorm_name ? t.dorm_name
    : t.washroom_name ? t.washroom_name
    : t.washroom_fixture_label ? t.washroom_fixture_label
    : null;

interface Props {
  tasks: Task[];
  onEventClick?: (task: Task) => void;
  /** Controlled range — the parent fetches [range.from, range.to]. */
  range: { from: string; to: string };
  onRangeChange: (from: string, to: string) => void;
  view?: CalendarViewMode;
  onViewChange?: (v: CalendarViewMode) => void;
}

export const WorkCalendar: React.FC<Props> = ({
  tasks, onEventClick, range, onRangeChange, view: viewProp, onViewChange,
}) => {
  const [innerView, setInnerView] = useState<CalendarViewMode>('week');
  const view = viewProp ?? innerView;
  const setView = (v: CalendarViewMode) => {
    setInnerView(v);
    onViewChange?.(v);
  };

  const anchor = range.from; // YYYY-MM-DD the views navigate around

  const byDay = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of tasks) {
      const d = taskDay(t);
      if (!d) continue;
      (m.get(d) ?? m.set(d, []).get(d)!).push(t);
    }
    for (const list of m.values())
      list.sort((a, b) => (taskTime(a) ?? '99') < (taskTime(b) ?? '99') ? -1 : 1);
    return m;
  }, [tasks]);

  const shift = (n: number) => {
    const d = new Date(anchor + 'T00:00:00');
    if (view === 'month') {
      d.setDate(1);
      d.setMonth(d.getMonth() + n);
    } else {
      const span = view === 'week' ? 7 : view === 'day' ? 1 : 14;
      d.setDate(d.getDate() + n * span);
    }
    setRangeFor(d);
  };

  const setRangeFor = (d: Date) => {
    if (view === 'month') {
      const first = new Date(d.getFullYear(), d.getMonth(), 1);
      const start = new Date(first);
      start.setDate(1 - ((first.getDay() + 6) % 7)); // Monday-first grid
      const end = new Date(start);
      end.setDate(start.getDate() + 41);
      onRangeChange(isoDay(start), isoDay(end));
    } else if (view === 'week') {
      const start = new Date(d);
      start.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      onRangeChange(isoDay(start), isoDay(end));
    } else if (view === 'day') {
      onRangeChange(isoDay(d), isoDay(d));
    } else {
      const end = new Date(d);
      end.setDate(d.getDate() + 13);
      onRangeChange(isoDay(d), isoDay(end));
    }
  };

  const goToday = () => setRangeFor(new Date());

  const days = useMemo(() => {
    const out: string[] = [];
    const d = new Date(range.from + 'T00:00:00');
    const end = new Date(range.to + 'T00:00:00');
    while (d <= end) {
      out.push(isoDay(d));
      d.setDate(d.getDate() + 1);
    }
    return out;
  }, [range]);

  const today = isoDay(new Date());
  const anchorDate = new Date(anchor + 'T00:00:00');
  const title =
    view === 'month'
      ? anchorDate.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
      : `${new Date(range.from + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${new Date(range.to + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;

  const EventChip: React.FC<{ t: Task; dense?: boolean }> = ({ t, dense }) => {
    const st = styleFor(displayStatus(t));
    const time = windowLabel(t);
    return (
      <button
        onClick={() => onEventClick?.(t)}
        className={`w-full text-left rounded-[6px] px-1.5 py-1 ${st.chip} hover:ring-1 hover:ring-[#800020]/40 transition-shadow cursor-pointer`}
        title={`${t.title} · ${displayStatus(t)}${t.assigned_to_name ? ` · ${t.assigned_to_name}` : ''}`}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: st.dot }} />
          <span className="text-[11px] font-medium truncate">
            {time && <span className="opacity-70 mr-1">{time}</span>}
            {t.title}
          </span>
        </div>
        {!dense && (t.assigned_to_name || locationLabel(t) || t.department_name) && (
          <div className="text-[10px] opacity-75 truncate pl-3">
            {[t.assigned_to_name, locationLabel(t), t.department_name].filter(Boolean).join(' · ')}
          </div>
        )}
      </button>
    );
  };

  return (
    <div className="space-y-3">
      {/* Header — navigation + view switcher */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <button onClick={() => shift(-1)} className="p-1.5 rounded-[7px] border border-[#E7E5E4] text-[#0D1C42] hover:bg-[#F6F4F2]">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button onClick={goToday} className="px-2.5 py-1.5 rounded-[7px] border border-[#E7E5E4] text-[13px] font-medium text-[#0D1C42] hover:bg-[#F6F4F2]">
            Today
          </button>
          <button onClick={() => shift(1)} className="p-1.5 rounded-[7px] border border-[#E7E5E4] text-[#0D1C42] hover:bg-[#F6F4F2]">
            <ChevronRight className="w-4 h-4" />
          </button>
          <span className="ml-2 font-display font-semibold text-[15px] text-[#0D1C42]">{title}</span>
        </div>
        <div className="flex items-center gap-1 bg-[#F6F4F2] rounded-[9px] p-0.5 border border-[#E7E5E4]">
          {([
            { v: 'month' as const, icon: LayoutGrid, l: 'Month' },
            { v: 'week' as const, icon: Rows3, l: 'Week' },
            { v: 'day' as const, icon: CalendarDays, l: 'Day' },
            { v: 'agenda' as const, icon: List, l: 'Agenda' },
          ]).map(({ v, icon: Icon, l }) => (
            <button
              key={v}
              onClick={() => { setView(v); setRangeFor(anchorDate); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[7px] text-[12px] font-semibold ${
                view === v ? 'bg-[#800020] text-white' : 'text-[#667085] hover:text-[#0D1C42]'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />{l}
            </button>
          ))}
        </div>
      </div>

      {/* Month grid */}
      {view === 'month' && (
        <div className="rounded-[10px] border border-[#E7E5E4] overflow-hidden bg-white">
          <div className="grid grid-cols-7 text-[11px] font-semibold text-[#667085] uppercase tracking-wide bg-[#F6F4F2]">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
              <div key={d} className="px-2 py-1.5">{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {days.slice(0, 42).map((d) => {
              const inMonth = d.slice(5, 7) === anchor.slice(5, 7);
              const list = byDay.get(d) ?? [];
              return (
                <div
                  key={d}
                  className={`min-h-[92px] border-t border-r border-[#F6F4F2] p-1 ${
                    inMonth ? 'bg-white' : 'bg-[#FBFAF9]'
                  } ${d === today ? 'ring-1 ring-inset ring-[#800020]' : ''}`}
                >
                  <div className={`text-[11px] font-semibold px-1 ${inMonth ? 'text-[#0D1C42]' : 'text-[#B0B7C3]'} ${d === today ? 'text-[#800020]' : ''}`}>
                    {Number(d.slice(8))}
                  </div>
                  <div className="space-y-0.5 mt-0.5">
                    {list.slice(0, 3).map((t) => <EventChip key={t.task_uid} t={t} dense />)}
                    {list.length > 3 && (
                      <div className="text-[10px] text-[#667085] pl-1">+{list.length - 3} more</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Week columns */}
      {view === 'week' && (
        <div className="rounded-[10px] border border-[#E7E5E4] overflow-hidden bg-white grid grid-cols-7">
          {days.map((d) => {
            const list = byDay.get(d) ?? [];
            const label = new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' });
            return (
              <div key={d} className={`min-h-[240px] border-r border-[#F6F4F2] last:border-r-0 p-1.5 ${d === today ? 'bg-[#FFFCFA]' : ''}`}>
                <div className={`text-[11px] font-semibold pb-1.5 border-b border-[#F6F4F2] mb-1.5 ${d === today ? 'text-[#800020]' : 'text-[#0D1C42]'}`}>
                  {label}
                </div>
                <div className="space-y-1">
                  {list.map((t) => <EventChip key={t.task_uid} t={t} />)}
                  {list.length === 0 && <div className="text-[10px] text-[#B0B7C3] px-1 pt-1">—</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Day */}
      {view === 'day' && (
        <div className="rounded-[10px] border border-[#E7E5E4] bg-white divide-y divide-[#F6F4F2]">
          {(byDay.get(range.from) ?? []).length === 0 && (
            <div className="px-4 py-8 text-center text-[13px] text-[#667085]">
              No work scheduled this day.
            </div>
          )}
          {(byDay.get(range.from) ?? []).map((t) => {
            const st = styleFor(displayStatus(t));
            return (
              <button key={t.task_uid} onClick={() => onEventClick?.(t)}
                className="w-full text-left px-4 py-2.5 hover:bg-[#FFFCFA] flex items-center gap-3">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: st.dot }} />
                <span className="text-[12px] text-[#667085] w-12 shrink-0">{windowLabel(t) ?? '—'}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] font-medium text-[#0D1C42] truncate">{t.title}</span>
                  <span className="block text-[11px] text-[#667085] truncate">
                    {[t.assigned_to_name, locationLabel(t), t.priority].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className={`text-[11px] px-1.5 py-0.5 rounded-[5px] ${st.chip}`}>{displayStatus(t).replace('_', ' ')}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Agenda — date-grouped list */}
      {view === 'agenda' && (
        <div className="rounded-[10px] border border-[#E7E5E4] bg-white divide-y divide-[#F6F4F2]">
          {days.map((d) => {
            const list = byDay.get(d) ?? [];
            if (list.length === 0) return null;
            return (
              <div key={d}>
                <div className={`px-4 py-2 text-[12px] font-semibold bg-[#F6F4F2] ${d === today ? 'text-[#800020]' : 'text-[#0D1C42]'}`}>
                  {new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}
                  {d === today && ' — today'}
                </div>
                {list.map((t) => {
                  const st = styleFor(displayStatus(t));
                  return (
                    <button key={t.task_uid} onClick={() => onEventClick?.(t)}
                      className="w-full text-left px-4 py-2 hover:bg-[#FFFCFA] flex items-center gap-3">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: st.dot }} />
                      <span className="text-[12px] text-[#667085] w-12 shrink-0">{windowLabel(t) ?? '—'}</span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-[13px] font-medium text-[#0D1C42] truncate">{t.title}</span>
                        <span className="block text-[11px] text-[#667085] truncate">
                          {[t.assigned_to_name, locationLabel(t), t.priority].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      <span className={`text-[11px] px-1.5 py-0.5 rounded-[5px] ${st.chip}`}>{displayStatus(t).replace('_', ' ')}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
          {[...byDay.values()].every((l) => l.length === 0) && (
            <div className="px-4 py-8 text-center text-[13px] text-[#667085]">
              No work in this period.
            </div>
          )}
        </div>
      )}
    </div>
  );
};
