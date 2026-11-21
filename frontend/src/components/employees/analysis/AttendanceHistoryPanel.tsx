import React, { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { attendanceApi, HistoryDay } from '../../../api/attendance';
import { fmtTimeIST } from '../../../lib/datetime';
import { BlockFailure, BlockLoading } from './kit';

const istDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

type Preset = '7d' | '30d' | '90d' | 'month' | 'prev' | 'custom';
const PRESETS: { id: Preset; label: string }[] = [
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: '90d', label: 'Last 90 days' },
  { id: 'month', label: 'This month' },
  { id: 'prev', label: 'Previous month' },
  { id: 'custom', label: 'Custom' },
];

function rangeFor(p: Preset): { from: string; to: string } {
  const now = new Date();
  const d = new Date(now);
  if (p === 'month') d.setDate(1);
  else if (p === 'prev') {
    const f = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const t = new Date(now.getFullYear(), now.getMonth(), 0);
    return { from: istDay(f), to: istDay(t) };
  } else {
    const back: Record<string, number> = { '7d': 6, '30d': 29, '90d': 89 };
    d.setDate(d.getDate() - (back[p] ?? 0));
  }
  return { from: istDay(d), to: istDay(now) };
}

const STATUS_STYLE: Record<string, string> = {
  completed: 'bg-[#E3F3EC] text-[#0E6B47]',
  present: 'bg-[#E3F3EC] text-[#0E6B47]',
  in_progress: 'bg-[#F0EAFC] text-[#5C3FA8]',
  on_break: 'bg-[#FFF1E4] text-[#8A5A10]',
  absent: 'bg-[#FBE6E6] text-[#A83434]',
  leave: 'bg-[#E9EFFB] text-[#2B5FA8]',
  holiday: 'bg-[#E9EFFB] text-[#2B5FA8]',
  day_off: 'bg-[#EFF1F4] text-[#5A6472]',
  week_off: 'bg-[#EFF1F4] text-[#5A6472]',
  not_scheduled: 'bg-[#EFF1F4] text-[#5A6472]',
  not_marked: 'bg-[#FBE6E6] text-[#A83434]',
};
const statusStyle = (s: string) => STATUS_STYLE[s] ?? 'bg-[#EFF1F4] text-[#5A6472]';

const fmtSecs = (s?: number | null) => {
  if (s == null) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};

// ---------------------------------------------------------------------------
// Day drawer — shift info, punches, every break, evaluation, timeline
// ---------------------------------------------------------------------------
const DayDrawer: React.FC<{ day: HistoryDay; onClose: () => void }> = ({ day, onClose }) => {
  const events: { label: string; at: string | null; kind: 'sched' | 'actual' | 'break' }[] = [];
  if (day.shift?.scheduled) {
    events.push({ label: `Shift starts — ${day.shift.name}`, at: `${day.date}T${day.shift.start_time}:00`, kind: 'sched' });
    events.push({ label: 'Shift ends', at: `${day.date}T${day.shift.end_time}:00`, kind: 'sched' });
  }
  if (day.started_at) events.push({ label: 'Start Day', at: day.started_at, kind: 'actual' });
  day.breaks.forEach((b, i) => {
    events.push({ label: `Break ${i + 1} starts`, at: b.started_at, kind: 'break' });
    if (b.ended_at) events.push({ label: `Break ${i + 1} ends`, at: b.ended_at, kind: 'break' });
  });
  if (day.ended_at) events.push({ label: 'End Day', at: day.ended_at, kind: 'actual' });
  events.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));

  const row = (k: string, v: React.ReactNode) => (
    <div className="flex justify-between gap-3 py-1.5 border-b border-[#F6F4F2] last:border-0">
      <span className="text-[#667085]">{k}</span>
      <span className="font-medium text-[#0D1C42] text-right">{v}</span>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="w-full max-w-md h-full bg-white shadow-xl overflow-y-auto p-5 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-display font-semibold text-lg text-[#0D1C42]">{day.date}</h3>
            <span className={`inline-block mt-1 text-[11px] px-1.5 py-0.5 rounded-[5px] font-medium ${statusStyle(day.status)}`}>
              {day.status.replace(/_/g, ' ')}
            </span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-[7px] text-[#667085] hover:bg-[#F6F4F2]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <section className="text-[12px]">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-[#667085] mb-1">Shift</h4>
          {day.shift ? (
            <>
              {row('Shift', `${day.shift.name}${day.shift.overnight ? ' (overnight)' : ''}`)}
              {row('Scheduled', day.shift.scheduled
                ? `${day.shift.start_time} – ${day.shift.end_time}` : 'Day off')}
              {row('Grace', `${day.shift.grace_minutes} min`)}
            </>
          ) : row('Shift', 'No shift assigned')}
        </section>

        <section className="text-[12px]">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-[#667085] mb-1">Attendance</h4>
          {row('Time in', day.started_at ? fmtTimeIST(day.started_at) : '—')}
          {row('Time out', day.ended_at ? fmtTimeIST(day.ended_at) : day.started_at ? 'still open' : '—')}
          {row('Working', fmtSecs(day.work_seconds))}
          {row('Breaks', fmtSecs(day.break_seconds))}
          {day.leave_type && row('Leave', day.leave_type)}
          {day.incomplete && row('Incomplete', 'started but never ended')}
        </section>

        {day.breaks.length > 0 && (
          <section className="text-[12px]">
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-[#667085] mb-1">Breaks</h4>
            {day.breaks.map((b, i) => (
              <div key={i} className="flex justify-between py-1 border-b border-[#F6F4F2] last:border-0">
                <span>Break {i + 1}</span>
                <span className="font-medium">
                  {b.started_at ? fmtTimeIST(b.started_at) : '—'} – {b.ended_at ? fmtTimeIST(b.ended_at) : 'open'}
                  <span className="ml-2 text-[#667085]">{fmtSecs(b.duration_seconds)}</span>
                </span>
              </div>
            ))}
          </section>
        )}

        <section className="text-[12px]">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-[#667085] mb-1">Evaluation</h4>
          {row('Arrival', day.on_time == null ? '—'
            : day.on_time ? 'On time' : `Late by ${day.late_minutes} min`)}
          {row('Early exit', day.early_exit_minutes ? `${day.early_exit_minutes} min early` : '—')}
        </section>

        <section>
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-[#667085] mb-2">Timeline</h4>
          <ol className="relative border-l-2 border-[#E7E5E4] ml-2 space-y-3">
            {events.map((e, i) => (
              <li key={i} className="ml-3 text-[12px]">
                <span className={`absolute -left-[5px] w-2 h-2 rounded-full mt-1 ${
                  e.kind === 'sched' ? 'bg-[#98A2B3]' : e.kind === 'break' ? 'bg-[#F4BE38]' : 'bg-[#800020]'
                }`} />
                <span className="font-medium text-[#0D1C42]">
                  {e.at ? fmtTimeIST(e.at) : '—'}
                </span>
                <span className="ml-2 text-[#667085]">{e.label}</span>
              </li>
            ))}
            {events.length === 0 && <li className="ml-3 text-[12px] text-[#667085]">No events recorded.</li>}
          </ol>
        </section>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// History panel — summary + per-day records table
// ---------------------------------------------------------------------------
export const AttendanceHistoryPanel: React.FC<{ employeeId: string }> = ({ employeeId }) => {
  const [preset, setPreset] = useState<Preset>('30d');
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [status, setStatus] = useState('');
  const [lateOnly, setLateOnly] = useState(false);
  const [items, setItems] = useState<HistoryDay[] | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [sel, setSel] = useState<HistoryDay | null>(null);

  const range = preset === 'custom' && custom ? custom : rangeFor(preset === 'custom' ? '30d' : preset);

  useEffect(() => {
    let active = true;
    setItems(null); setError(false);
    void attendanceApi.employeeHistory(employeeId, range.from, range.to)
      .then((r) => { if (active) setItems(r.items); })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [employeeId, range.from, range.to, retry]);

  const filtered = useMemo(() => (items ?? []).filter((d) => {
    if (status && d.status !== status) return false;
    if (lateOnly && !(d.late_minutes && d.late_minutes > 0) && !d.incomplete) return false;
    return true;
  }), [items, status, lateOnly]);

  const summary = useMemo(() => {
    const s = { scheduled: 0, present: 0, absent: 0, late: 0, early: 0, incomplete: 0, leave: 0, work: 0, brk: 0 };
    (items ?? []).forEach((d) => {
      if (d.shift?.scheduled) s.scheduled++;
      if (d.started_at) s.present++;
      if (d.status === 'absent' || (d.status === 'not_marked' && d.is_past)) s.absent++;
      if (d.late_minutes && d.late_minutes > 0) s.late++;
      if (d.early_exit_minutes) s.early++;
      if (d.incomplete) s.incomplete++;
      if (d.leave_type) s.leave++;
      s.work += d.work_seconds ?? 0;
      s.brk += d.break_seconds ?? 0;
    });
    return s;
  }, [items]);

  const statuses = useMemo(() => [...new Set((items ?? []).map((d) => d.status))], [items]);
  const selectCls =
    'px-2 py-1 bg-white border border-[#E7E5E4] rounded-[7px] text-[12px] text-[#0D1C42]';

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => (
          <button key={p.id}
            onClick={() => { setPreset(p.id); if (p.id === 'custom' && !custom) setCustom(rangeFor('30d')); }}
            className={`px-2.5 py-1 rounded-[7px] text-[12px] font-medium ${
              preset === p.id ? 'bg-[#800020] text-white' : 'bg-white border border-[#E7E5E4] text-[#667085]'
            }`}>
            {p.label}
          </button>
        ))}
        {preset === 'custom' && custom && (
          <>
            <input type="date" className={selectCls} value={custom.from}
              onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            <input type="date" className={selectCls} value={custom.to}
              onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
          </>
        )}
        <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {statuses.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-[12px] text-[#667085]">
          <input type="checkbox" checked={lateOnly} onChange={(e) => setLateOnly(e.target.checked)}
            className="accent-[#800020]" />
          Late / incomplete only
        </label>
      </div>

      {/* Compact summary strip */}
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-[#667085]">
        <span><b className="text-[#0D1C42]">{summary.scheduled}</b> scheduled</span>
        <span><b className="text-[#0E6B47]">{summary.present}</b> present</span>
        <span><b className="text-[#A83434]">{summary.absent}</b> absent/not marked</span>
        <span><b className="text-[#8A5A10]">{summary.late}</b> late</span>
        <span><b className="text-[#8A5A10]">{summary.early}</b> early exits</span>
        <span><b className="text-[#2B5FA8]">{summary.leave}</b> leave days</span>
        <span><b className="text-[#0D1C42]">{fmtSecs(summary.work)}</b> worked · {fmtSecs(summary.brk)} breaks</span>
      </div>

      {error && <BlockFailure msg="Unable to load attendance history." retry={() => setRetry((v) => v + 1)} />}
      {!error && !items && <BlockLoading label="Loading attendance history" />}

      {items && (
        <div className="rounded-lg border border-[#E7E5E4] bg-white overflow-x-auto">
          <table className="w-full text-[12px] min-w-[860px]">
            <thead>
              <tr className="text-left text-[10.5px] uppercase tracking-wide text-[#667085] bg-[#F6F4F2]">
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Shift</th>
                <th className="px-3 py-2 font-medium">Scheduled</th>
                <th className="px-3 py-2 font-medium">Time in</th>
                <th className="px-3 py-2 font-medium">Time out</th>
                <th className="px-3 py-2 font-medium">Break</th>
                <th className="px-3 py-2 font-medium">Working</th>
                <th className="px-3 py-2 font-medium">Late</th>
                <th className="px-3 py-2 font-medium">Early</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr key={d.date} onClick={() => setSel(d)}
                  className="border-t border-[#F6F4F2] hover:bg-[#FFFCFA] cursor-pointer">
                  <td className="px-3 py-2 font-medium text-[#0D1C42]">{d.date.slice(5)}</td>
                  <td className="px-3 py-2 text-[#667085]">{d.shift?.name ?? '—'}</td>
                  <td className="px-3 py-2 text-[#667085]">
                    {d.shift?.scheduled ? `${d.shift.start_time}–${d.shift.end_time}` : '—'}
                  </td>
                  <td className="px-3 py-2">{d.started_at ? fmtTimeIST(d.started_at) : '—'}</td>
                  <td className="px-3 py-2">
                    {d.ended_at ? fmtTimeIST(d.ended_at) : d.started_at ? 'open' : '—'}
                  </td>
                  <td className="px-3 py-2">{fmtSecs(d.break_seconds)}</td>
                  <td className="px-3 py-2">{fmtSecs(d.work_seconds)}</td>
                  <td className="px-3 py-2">
                    {d.late_minutes ? <span className="text-[#8A5A10] font-medium">{d.late_minutes}m</span> : '—'}
                  </td>
                  <td className="px-3 py-2">
                    {d.early_exit_minutes ? <span className="text-[#8A5A10]">{d.early_exit_minutes}m</span> : '—'}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`text-[10.5px] px-1.5 py-0.5 rounded-[5px] font-medium ${statusStyle(d.status)}`}>
                      {d.status.replace(/_/g, ' ')}
                      {d.incomplete ? ' !' : ''}
                    </span>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={10} className="px-3 py-6 text-center text-[#667085]">
                  No days match the filters.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {sel && <DayDrawer day={sel} onClose={() => setSel(null)} />}
    </div>
  );
};
