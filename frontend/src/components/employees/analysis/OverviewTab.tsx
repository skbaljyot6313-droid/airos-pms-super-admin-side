import React, { useEffect, useRef, useState } from 'react';
import { EmployeeAnalytics, getEmployeeAnalytics, KpiValue } from '../../../api/employees';
import { C, Delta, Empty, Panel, BlockLoading, BlockFailure, pct, card } from './kit';
import { duration } from '../EmployeeDetailView';
import { bucketFor, Period } from './PeriodSelector';
import { LocationTree } from './LocationsTab';

/* ---------- KPI modules — five separate metric cards ---------- */

const KPI_DEFS: { key: keyof EmployeeAnalytics['kpis']; title: string; note: string; invert?: boolean; fmt: (v: number | null) => string }[] = [
  { key: 'tasks_allocated', title: 'Allocated', note: 'Distinct tasks assigned in the period.', fmt: (v) => `${v ?? '—'}` },
  { key: 'tasks_completed', title: 'Completed', note: 'Distinct tasks with an approved submission.', fmt: (v) => `${v ?? '—'}` },
  { key: 'tasks_open', title: 'Open now', note: 'Currently assigned open work — point in time.', fmt: (v) => `${v ?? '—'}` },
  { key: 'tasks_abandoned', title: 'Abandoned', note: 'Abandoned while this employee was assignee.', invert: true, fmt: (v) => `${v ?? '—'}` },
  { key: 'completion_rate', title: 'Completion rate', note: 'Completed ÷ allocated. Delta in percentage points.', fmt: pct },
];

function KpiGrid({ kpis }: { kpis: EmployeeAnalytics['kpis'] }) {
  return <div role="list" aria-label="Key metrics" className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
    {KPI_DEFS.map((def) => {
      const k: KpiValue = kpis[def.key];
      const isRate = def.key.includes('rate');
      return <div role="listitem" key={def.key} title={def.note} className={`${card} px-5 py-4`}>
        <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-[#7FA8CE]">{def.title}</p>
        <p className="mt-1.5 text-[30px] font-semibold leading-none tabular-nums text-[#2457A8]">{def.fmt(k.current)}</p>
        <div className="mt-2 h-4">
          {def.key === 'tasks_open'
            ? <span className="text-[11px] text-[#7FA8CE]">Currently active tasks</span>
            : <Delta current={k.current} previous={k.previous} invert={def.invert} unit={isRate ? 'pp' : 'pct'} />}
        </div>
      </div>;
    })}
  </div>;
}

/* ---------- Work activity chart — refined grouped bars + custom tooltip ---------- */

const SERIES: [string, string, 'allocated' | 'approved' | 'abandoned'][] = [
  ['Allocated', C.blue, 'allocated'], ['Completed', C.success, 'approved'], ['Abandoned', C.danger, 'abandoned']];

function ActivityChart({ data }: { data: EmployeeAnalytics['series'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const rows = data.slice(-60);
  if (!rows.length) return <Empty msg="No work activity recorded in this period." />;
  const W = Math.max(400, rows.length * 24), H = 270, BOT = 30, TOP = 18;
  const nice = Math.max(1, Math.ceil(Math.max(...rows.flatMap((r) => [r.allocated, r.approved, r.abandoned])) / 4) * 4);
  const slot = W / rows.length, bw = Math.min(6, slot / 4 - 1), plot = H - TOP - BOT;
  const every = Math.max(1, Math.ceil(rows.length / 12));
  return <figure className="relative mt-3">
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-[270px] w-full" role="img"
      aria-label={rows.map((r) => `${r.bucket}: ${r.allocated} allocated, ${r.approved} completed, ${r.abandoned} abandoned`).join('; ')}>
      {[0, 1, 2, 3, 4].map((i) => { const y = TOP + plot - (i / 4) * plot; return <g key={i}>
        {i > 0 && <line x1="0" x2={W} y1={y} y2={y} stroke="#EAF1FB" vectorEffect="non-scaling-stroke" />}
        <text x="0" y={y - 3} fontSize="10" fill="#7FA8CE">{Math.round(nice * i / 4)}</text></g>; })}
      {rows.map((r, i) => {
        const x = i * slot + slot / 2;
        const dim = hover != null && hover !== i;
        return <g key={r.bucket} opacity={dim ? 0.35 : 1}
          onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
          <rect x={i * slot} y={TOP} width={slot} height={plot} fill="transparent" />
          {SERIES.map(([, color, key], j) => { const v = r[key];
            const h = v ? Math.max(3, (v / nice) * plot) : 0;
            return <rect key={key} x={x + (j - 1) * (bw + 1.5) - bw / 2} y={TOP + plot - h} width={bw} height={h} fill={color} rx="2" />; })}
          {i % every === 0 && <text x={x} y={H - 10} fontSize="10" textAnchor="middle" fill="#7FA8CE">{r.bucket}</text>}
        </g>; })}
      {hover != null && <line x1={hover * slot + slot / 2} x2={hover * slot + slot / 2}
        y1={TOP} y2={TOP + plot} stroke="#C3D6F0" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
    </svg>
    {hover != null && <div role="tooltip"
      className="pointer-events-none absolute rounded-lg border border-[#EAF1FB] bg-white px-3 py-2 shadow-[0_4px_12px_rgba(16,24,40,0.10)]"
      style={{ left: `${((hover + 0.5) * slot) / W * 100}%`, top: -8, transform: `translateX(${hover * slot > W / 2 ? '-110%' : '10%'})` }}>
      <p className="text-[11px] font-semibold text-[#2457A8]">{rows[hover].bucket}</p>
      {SERIES.map(([l, c, k]) => <p key={k} className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[#2457A8]">
        <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: c }} />{l} <b className="ml-auto pl-3 tabular-nums text-[#2457A8]">{rows[hover][k]}</b></p>)}
    </div>}
    <ul className="mt-2 flex flex-wrap gap-x-4 text-xs text-[#2457A8]">
      {SERIES.map(([l, c]) => <li key={l} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ backgroundColor: c }} />{l}</li>)}
    </ul>
  </figure>;
}

/* ---------- Submission & review quality ---------- */

function QualityPanel({ data }: { data: EmployeeAnalytics }) {
  const s = data.submissions, r = data.review;
  const pctv = (n: number) => s.total ? `${n / s.total * 100}%` : '0%';
  const rate = s.approval_rate;
  return <Panel title="Submission & review quality"
    note="Submission attempts — distinct from unique tasks. Turnaround = reviewer processing time.">
    {s.total === 0 ? <Empty msg="No submission attempts in this period." /> : <>
      <div className="mt-4 flex items-end justify-between gap-3">
        <div>
          <p className="text-[32px] font-semibold leading-none tabular-nums" style={{ color: rate != null ? C.success : C.faint }}>
            {rate != null ? `${(rate * 100).toFixed(0)}%` : '—'}</p>
          <p className="mt-1 text-xs text-[#7FA8CE]">Approval rate · {s.total} attempts · {s.approved + s.disapproved} decided</p>
        </div>
      </div>
      <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-[#FFFCFA]" role="img"
        aria-label={`${s.approved} approved, ${s.disapproved} rejected, ${s.pending} pending`}>
        {[[C.success, s.approved], [C.danger, s.disapproved], [C.warning, s.pending]].map(([c, v], i) =>
          v ? <span key={i} style={{ width: pctv(v as number), backgroundColor: c as string }} /> : null)}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 text-xs text-[#2457A8]">
        {[['Approved', s.approved, C.success], ['Rejected', s.disapproved, C.danger], ['Pending', s.pending, C.warning]].map(([l, v, c]) => (
          <li key={l as string} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: c as string }} />{l}
            <b className="tabular-nums text-[#2457A8]">{v}</b></li>))}
      </ul>
      <dl className="mt-4 divide-y divide-[#FFFCFA] border-t border-[#EAF1FB] text-[13px]">
        {[['First-attempt approval', r.first_attempt_approval_rate != null ? `${(r.first_attempt_approval_rate * 100).toFixed(0)}% of ${r.first_attempt_decided} decided` : '—'],
          ['Tasks needing rework', `${r.tasks_with_rework} of ${r.tasks_with_attempts}`],
          ['Median review turnaround', r.turnaround_median_seconds != null ? duration(r.turnaround_median_seconds) : '—'],
          ['Avg review turnaround', r.turnaround_avg_seconds != null ? duration(r.turnaround_avg_seconds) : '—'],
        ].map(([k, v]) => <div key={k as string} className="flex items-baseline justify-between gap-3 py-2"><dt className="text-[#2457A8]">{k}</dt><dd className="font-medium tabular-nums text-[#2457A8]">{v}</dd></div>)}
      </dl>
    </>}
  </Panel>;
}

/* ---------- Workload breakdown — location hierarchy ---------- */

function WorkloadBreakdown({ employeeId, propertyId, period }: {
  employeeId: string; propertyId: string; period: Period;
}) {
  return <Panel title="Workload breakdown"
    note="Task distribution across assigned locations. Expand a zone for its areas and units.">
    <LocationTree employeeId={employeeId} propertyId={propertyId} period={period} />
  </Panel>;
}

/* ---------- Operational insights — editorial layout ---------- */

const INSIGHT_CATEGORY: [RegExp, string][] = [
  [/abandon/i, 'Abandonment'], [/complet|done/i, 'Completion'], [/allocat|workload/i, 'Workload'],
  [/approv|first|rework|review/i, 'Quality'], [/maint/i, 'Maintenance'], [/zone|area|location/i, 'Location']];
const catOf = (id: string) => INSIGHT_CATEGORY.find(([re]) => re.test(id))?.[1] ?? 'Observation';
const INSIGHT_COLOR: Record<string, string> = {
  Abandonment: C.danger, Completion: C.success, Workload: C.navy,
  Quality: C.blue, Maintenance: C.warning, Location: C.blue, Observation: C.navy };

function Insights({ insights, periodLabel }: { insights: EmployeeAnalytics['insights']; periodLabel: string }) {
  const shown = insights.slice(0, 3);
  return <Panel title="Operational insights" note={`Evidence-based observations · ${periodLabel}`}>
    {!shown.length ? <Empty msg="Insufficient data or no significant change to report." />
      : <ul className="mt-3 divide-y divide-[#FFFCFA]">{shown.map((i) => {
        const cat = catOf(i.id);
        return <li key={i.id} className="flex gap-3 py-2.5 first:pt-0 last:pb-0">
          <span className="mt-0.5 flex h-5 w-16 flex-none items-center justify-center rounded-md text-[9px] font-semibold uppercase tracking-wide"
            style={{ color: INSIGHT_COLOR[cat], backgroundColor: `${INSIGHT_COLOR[cat]}14` }}>{cat}</span>
          <p className="text-[13px] leading-relaxed text-[#2457A8]">{i.text}</p>
        </li>; })}
      </ul>}
  </Panel>;
}

/* ---------- Overview ---------- */

export function OverviewTab({ employeeId, propertyId, period }: {
  employeeId: string; propertyId: string; period: Period;
}) {
  const [bucket, setBucket] = useState<'day' | 'week' | 'month'>(() => bucketFor(period.bounds));
  useEffect(() => setBucket(bucketFor(period.bounds)), [period.bounds]);
  const [data, setData] = useState<EmployeeAnalytics | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const id = useRef(0);
  useEffect(() => {
    const rid = ++id.current;
    setLoading(true); setError(false);
    void getEmployeeAnalytics(employeeId, propertyId, period.bounds, bucket)
      .then((d) => { if (rid === id.current) setData(d); })
      .catch(() => { if (rid === id.current) setError(true); })
      .finally(() => { if (rid === id.current) setLoading(false); });
    return () => { id.current += 1; };
  }, [employeeId, propertyId, period.bounds, bucket, retry]);

  if (loading) return <BlockLoading label="Loading work analytics" />;
  if (error || !data) return <BlockFailure msg="Unable to load work analytics." retry={() => setRetry((v) => v + 1)} />;
  const segBtn = (active: boolean) =>
    `rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors duration-150 ${active ? 'bg-[#2457A8] text-white' : 'text-[#2457A8] hover:bg-white'}`;
  return <div className="space-y-5">
    <KpiGrid kpis={data.kpis} />
    <div className="grid gap-5 lg:grid-cols-5">
      <Panel title="Work activity" className="lg:col-span-3"
        note={`Allocated · completed · abandoned — ${data.bucket}ly, IST`}
        action={<div className="flex gap-0.5 rounded-lg bg-[#FFFCFA] p-0.5">
          {(['day', 'week', 'month'] as const).map((b) => (
            <button key={b} aria-pressed={bucket === b} onClick={() => setBucket(b)} className={segBtn(bucket === b)}>{b}</button>))}
        </div>}>
        <ActivityChart data={data.series} />
      </Panel>
      <div className="lg:col-span-2"><QualityPanel data={data} /></div>
    </div>
    <div className="grid gap-5 lg:grid-cols-5">
      <div className="lg:col-span-3"><WorkloadBreakdown employeeId={employeeId} propertyId={propertyId} period={period} /></div>
      <div className="lg:col-span-2"><Insights insights={data.insights} periodLabel={period.label} /></div>
    </div>
  </div>;
}
