import React, { useEffect, useRef, useState } from 'react';
import { AttendanceCalendar, AttendanceDayDetail, EmployeeAnalytics, getEmployeeAnalytics, getEmployeeAttendanceCalendar, getEmployeeAttendanceDay } from '../../../api/employees';
import { fmtTimeIST, istDateKey } from '../../../lib/datetime';
import { duration } from '../EmployeeDetailView';
import { Panel, BlockLoading, BlockFailure, Empty, STATUS_COLORS, C } from './kit';
import { Period } from './PeriodSelector';

const DAY_C: Record<string, string> = { ...STATUS_COLORS, no_record: '#E9EDF2' };

function DayDetail({ employeeId, propertyId, date }: { employeeId: string; propertyId: string; date: string }) {
  const [d, setD] = useState<AttendanceDayDetail | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(false);
    void getEmployeeAttendanceDay(employeeId, propertyId, date)
      .then((v) => { if (active) setD(v); })
      .catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [employeeId, propertyId, date, retry]);
  if (loading) return <BlockLoading label="Loading day" />;
  if (error || !d) return <BlockFailure msg="Unable to load this day." retry={() => setRetry((v) => v + 1)} />;
  const r = d.record;
  const row = (k: string, v: React.ReactNode) => v == null ? null :
    <div key={k} className="flex justify-between gap-2"><dt className="text-[#697586]">{k}</dt><dd className="font-medium text-[#17212B]">{v}</dd></div>;
  return <div className="mt-3 rounded-md border border-[#E9EDF2] p-3 text-[11px]">
    <p className="font-semibold text-[#17212B]">{date} (IST)</p>
    {!r ? <p className="mt-2 text-[#697586]">No attendance record — never counted as an absence.</p>
      : <dl className="mt-2 space-y-1">
        {row('Status', <span style={{ color: DAY_C[r.incomplete ? 'incomplete' : r.status] || '#697586' }} className="font-semibold">{r.incomplete ? 'incomplete' : r.status.replace('_', ' ')}</span>)}
        {row('Clock-in', r.started_at ? `${fmtTimeIST(r.started_at)} IST` : 'Not recorded')}
        {row('Clock-out', r.ended_at ? `${fmtTimeIST(r.ended_at)} IST` : r.incomplete ? 'Still open' : 'Not recorded')}
        {row('Recorded work', r.work_seconds != null ? duration(r.work_seconds) : 'Not recorded')}
        {row('Recorded break', r.break_seconds != null ? duration(r.break_seconds) : 'Not recorded')}
        {d.breaks.length > 0 && <div><dt className="mt-1 text-[#697586]">Breaks</dt>
          {d.breaks.map((b, i) => <dd key={i} className="flex justify-between font-medium text-[#17212B]">
            <span>{b.started_at ? fmtTimeIST(b.started_at) : '—'} → {b.ended_at ? fmtTimeIST(b.ended_at) : 'open'}</span>
            <span>{b.duration_seconds != null ? duration(b.duration_seconds) : ''}</span></dd>)}</div>}
        {d.shift && <div className="mt-1 border-t border-[#E9EDF2] pt-1">
          <dt className="text-[#697586]">Assigned shift</dt>
          <dd className="font-medium text-[#17212B]">{d.shift.name}{d.shift.not_scheduled ? ' (not scheduled this day)' : d.shift.start && d.shift.end ? ` · ${fmtTimeIST(d.shift.start)}–${fmtTimeIST(d.shift.end)} IST` : ''}</dd></div>}
        {d.leave && <div className="mt-1 border-t border-[#E9EDF2] pt-1">
          <dt className="text-[#697586]">Approved leave</dt>
          <dd className="font-medium text-[#17212B]">{d.leave.request_type.replace('_', ' ')}{d.leave.leave_type ? ` · ${d.leave.leave_type.replace('_', ' ')}` : ''}{d.leave.reason ? ` — ${d.leave.reason}` : ''}</dd></div>}
      </dl>}
    <p className="mt-2 text-[10px] text-[#697586]">Recorded time only — not payroll or measured active labour.</p>
  </div>;
}

function Calendar({ employeeId, propertyId, onSelect, sel }: {
  employeeId: string; propertyId: string;
  onSelect: (d: string) => void; sel: string | null;
}) {
  const [month, setMonth] = useState(() => istDateKey().slice(0, 7));
  const [cal, setCal] = useState<AttendanceCalendar | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const id = useRef(0);
  useEffect(() => {
    const rid = ++id.current;
    setLoading(true); setError(false);
    void getEmployeeAttendanceCalendar(employeeId, propertyId, month)
      .then((v) => { if (rid === id.current) setCal(v); })
      .catch(() => { if (rid === id.current) setError(true); })
      .finally(() => { if (rid === id.current) setLoading(false); });
    return () => { id.current += 1; };
  }, [employeeId, propertyId, month, retry]);

  const [y, m] = month.split('-').map(Number);
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const startDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const today = istDateKey();
  const mv = (d: number) => setMonth(new Date(Date.UTC(y, m - 1 + d, 1)).toISOString().slice(0, 7));

  return <Panel title="Attendance calendar" note="Blank days = no record, never an absence. Click a date for detail.">
    <div className="mt-2 flex items-center justify-between">
      <button aria-label="Previous month" onClick={() => mv(-1)} className="rounded px-2 py-1 text-sm text-[#697586] hover:bg-[#F7F8FA]">‹</button>
      <span className="text-xs font-semibold text-[#17212B]">{new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</span>
      <button aria-label="Next month" onClick={() => mv(1)} className="rounded px-2 py-1 text-sm text-[#697586] hover:bg-[#F7F8FA]">›</button>
    </div>
    {loading ? <BlockLoading label="Loading attendance" />
      : error ? <BlockFailure msg="Unable to load attendance." retry={() => setRetry((v) => v + 1)} />
      : !cal ? null : <>
        <div className="mt-2 grid grid-cols-7 gap-1 text-center">
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <span key={i} className="text-[10px] font-medium text-[#697586]">{d}</span>)}
          {Array.from({ length: startDow + dim }).map((_, i) => {
            const day = i - startDow + 1;
            if (day < 1) return <span key={i} />;
            const key = `${month}-${String(day).padStart(2, '0')}`;
            const rec = cal.days[key];
            const status = rec ? (rec.incomplete ? 'incomplete' : rec.status) : null;
            return <button key={i} aria-label={`${key} ${status || 'no record'}`} aria-pressed={sel === key}
              onClick={() => onSelect(key)}
              className={`flex h-7 flex-col items-center justify-center rounded-md text-[11px] ${key === today ? 'ring-1 ring-[#365D78]' : ''} ${sel === key ? 'ring-1 ring-[#17212B]' : ''} ${status ? 'font-semibold text-white' : 'text-[#697586] hover:bg-[#F7F8FA]'}`}
              style={status ? { backgroundColor: DAY_C[status] || '#697586', opacity: sel === key ? 1 : 0.85 } : undefined}>
              {day}{!status && <span className="mt-0.5 h-0.5 w-0.5 rounded-full bg-[#D8DEE6]" />}
            </button>;
          })}
        </div>
        <ul className="mt-2 flex flex-wrap gap-x-3 text-[10px] text-[#697586]">
          {[['Present', 'present'], ['Absent', 'absent'], ['Leave', 'leave'], ['Week off', 'week_off'], ['Incomplete', 'incomplete']].map(([l, k]) => (
            <li key={k} className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ backgroundColor: DAY_C[k] }} />{l}</li>))}
          <li className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#D8DEE6]" />No record</li>
        </ul>
        <p className="mt-2 border-t border-[#E9EDF2] pt-2 text-[10px] text-[#697586]">
          {cal.summary.recorded} recorded · {cal.summary.present} present · {cal.summary.absent} absent · {cal.summary.leave} leave · {cal.summary.week_off} week-off · {cal.summary.incomplete} incomplete
          {cal.summary.total_work_seconds ? ` · ${duration(cal.summary.total_work_seconds)} work` : ''}
        </p>
      </>}
  </Panel>;
}

function SummaryAndShift({ employeeId, propertyId, period }: {
  employeeId: string; propertyId: string; period: Period;
}) {
  const [data, setData] = useState<EmployeeAnalytics | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const id = useRef(0);
  useEffect(() => {
    const rid = ++id.current;
    setLoading(true); setError(false);
    void getEmployeeAnalytics(employeeId, propertyId, period.bounds, 'day')
      .then((d) => { if (rid === id.current) setData(d); })
      .catch(() => { if (rid === id.current) setError(true); })
      .finally(() => { if (rid === id.current) setLoading(false); });
    return () => { id.current += 1; };
  }, [employeeId, propertyId, period.bounds, retry]);
  if (loading) return <BlockLoading label="Loading attendance summary" />;
  if (error || !data) return <BlockFailure msg="Unable to load summary." retry={() => setRetry((v) => v + 1)} />;
  const a = data.attendance, s = data.shift_adherence;
  const counts: Record<string, number> = { present: 0, absent: 0, leave: 0, week_off: 0, incomplete: 0 };
  for (const d of Object.values(a.days)) {
    const k = d.status in counts ? d.status : (d.status === 'present' && d.started_at && !d.ended_at ? 'incomplete' : d.status);
    if (k in counts) counts[k] += 1;
  }
  const rows: [string, string | number][] = [
    ['Present days', counts.present], ['Absent days', counts.absent],
    ['Leave days', counts.leave], ['Week-offs', counts.week_off],
    ['Incomplete records', counts.incomplete + a.incomplete],
    ['Recorded work', a.total_work_seconds ? duration(a.total_work_seconds) : '—'],
    ['On-time arrivals', s.on_time], ['Late arrivals', s.late],
    ['Early departures', s.early_departures],
    ['Median lateness', s.median_late_seconds != null ? duration(s.median_late_seconds) : '—'],
    ['Avg lateness', s.avg_late_seconds != null ? duration(s.avg_late_seconds) : '—'],
    ['Unevaluated days', s.unclassified],
  ];
  const recorded = Object.keys(a.days).length;
  return <Panel title="Attendance & shift summary"
    note={`${recorded} recorded days in period · adherence vs the shift effective on each date (bitmap + overnight honored) · unevaluated never counts as late.`}>
    {recorded === 0 && s.evaluated === 0 ? <Empty msg="No attendance records in this period." /> : <>
      <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-3">
        {rows.map(([l, v]) => <li key={l} className="flex items-center justify-between gap-2">
          <span className="text-[#697586]">{l}</span>
          <span className="font-semibold tabular-nums text-[#17212B]">{v}</span></li>)}
      </ul>
      {s.evaluated > 0 && <div className="mt-3 border-t border-[#E9EDF2] pt-2">
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[#697586]">On-time vs late</p>
        <div className="flex h-2 overflow-hidden rounded-full bg-[#F1F3F6]" role="img" aria-label={`${s.on_time} on time, ${s.late} late`}>
          {[[C.success, s.on_time], [C.danger, s.late]].map(([c, v], i) => v ? <span key={i} style={{ width: `${(v as number) / s.evaluated * 100}%`, backgroundColor: c as string }} /> : null)}
        </div>
        {s.days.length > 0 && <ul className="mt-2 max-h-44 space-y-1 overflow-y-auto pr-1">
          {s.days.slice(0, 30).map((d) => <li key={d.date + d.shift_name} className="flex items-center justify-between gap-2 rounded bg-[#F7F8FA] px-2 py-1 text-[10px]">
            <span className="text-[#697586]">{d.date} · {d.shift_name}</span>
            <span className="text-[#17212B]">{d.scheduled_start && d.scheduled_end ? `${fmtTimeIST(d.scheduled_start)}–${fmtTimeIST(d.scheduled_end)}` : '—'} · arrived {d.actual_start ? fmtTimeIST(d.actual_start) : '—'}</span>
            <span className={`font-medium ${d.arrival === 'on_time' ? 'text-[#169B72]' : 'text-[#D76565]'}`}>{d.arrival === 'on_time' ? 'On time' : `Late ${Math.round((d.arrival_deviation_seconds || 0) / 60)}m`}{d.early_departure ? ' · early dep' : ''}</span>
          </li>)}
        </ul>}
      </div>}
    </>}
  </Panel>;
}

export function AttendanceTab({ employeeId, propertyId, period }: {
  employeeId: string; propertyId: string; period: Period;
}) {
  const [sel, setSel] = useState<string | null>(null);
  return <div className="grid items-start gap-3 lg:grid-cols-2">
    <div>
      <Calendar employeeId={employeeId} propertyId={propertyId} sel={sel}
        onSelect={(d) => setSel(sel === d ? null : d)} />
      {sel && <DayDetail employeeId={employeeId} propertyId={propertyId} date={sel} />}
    </div>
    <SummaryAndShift employeeId={employeeId} propertyId={propertyId} period={period} />
  </div>;
}
