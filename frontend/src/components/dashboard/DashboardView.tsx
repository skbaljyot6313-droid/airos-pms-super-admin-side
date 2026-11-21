import React, { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { ApiError } from '../../api/client';
import {
  getPropertyDashboard,
  type DashboardDataQualityItem,
  type DashboardGranularity,
  type DashboardPeriodKey,
  type DataState,
  type PropertyDashboard,
} from '../../api/dashboard';
import { Button } from '../ui/Button';
import { Skeleton } from '../ui/Skeleton';
import { CHART, ColumnChart, HBarList, InteractiveLine, StackBar } from './charts';
import { GRANULARITY_OPTIONS, PERIOD_OPTIONS, bucketKeys, validateCustomRange } from './period';

/* ------------------------------------------------------------------ utils */

const pct = (v: number | null | undefined) => (v == null ? '—' : `${v}%`);
const num = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('en-IN'));
const fmtWhen = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
      })
    : '—';
const fmtDayShort = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', day: '2-digit', month: 'short' });
const fmtDayLong = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', day: '2-digit', month: 'long', year: 'numeric' });
const minutes = (m: number | null) =>
  m == null ? '—' : m >= 60 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m)} min`;

const STATE_STYLE: Record<DataState, { label: string; cls: string }> = {
  available: { label: 'Available', cls: 'bg-brand-soft text-brand-ink border-brand-line' },
  limited: { label: 'Limited data', cls: 'bg-warn-soft text-warn-ink border-[#FCD9BD]' },
  insufficient: { label: 'Insufficient data', cls: 'bg-hover text-ink-2 border-line-strong' },
  unverified: { label: 'Unverified', cls: 'bg-danger-soft text-danger-ink border-[#F9C3C3]' },
  no_records: { label: 'No records', cls: 'bg-hover text-ink-3 border-line' },
};

/* ------------------------------------------------------------- primitives */

const Section: React.FC<{ id: string; title: string; note?: string; children: React.ReactNode }> = ({
  id, title, note, children,
}) => (
  <section aria-labelledby={id} className="space-y-3">
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 id={id} className="font-display text-section font-semibold text-ink">{title}</h2>
      {note && <p className="text-meta text-ink-3">{note}</p>}
    </div>
    {children}
  </section>
);

const Panel: React.FC<{ className?: string; children: React.ReactNode }> = ({ className = '', children }) => (
  <div className={`rounded-[12px] border border-line bg-surface p-4 ${className}`}>{children}</div>
);

const StateChip: React.FC<{ state: DataState }> = ({ state }) => (
  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-micro font-semibold whitespace-nowrap ${STATE_STYLE[state].cls}`}>
    {STATE_STYLE[state].label}
  </span>
);

const DataNote: React.FC<{ state: DataState; children: React.ReactNode }> = ({ state, children }) => (
  <div className={`rounded-[10px] border px-3 py-2 text-meta ${STATE_STYLE[state].cls}`}>
    <span className="font-semibold">{STATE_STYLE[state].label}. </span>
    {children}
  </div>
);

const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="rounded-[10px] bg-hover px-3 py-6 text-center text-body text-ink-2">{children}</p>
);

/** Inline text figures — deliberately not cards. */
const Stat: React.FC<{ label: string; value: React.ReactNode; hint?: string }> = ({ label, value, hint }) => (
  <div className="min-w-0">
    <p className="text-meta text-ink-3">{label}</p>
    <p className="tabular-nums text-body font-semibold text-ink">{value}</p>
    {hint && <p className="text-micro text-ink-3">{hint}</p>}
  </div>
);

const SkeletonDashboard: React.FC = () => (
  <div className="space-y-6" aria-busy="true" aria-label="Loading dashboard">
    <Skeleton className="h-[320px] w-full rounded-[12px]" />
    <Skeleton className="h-56 w-full rounded-[12px]" />
    <Skeleton className="h-56 w-full rounded-[12px]" />
  </div>
);

/* ------------------------------------------------------------- tooltips */

const Tip: React.FC<{ title: string; rows: [string, React.ReactNode][]; note?: string }> = ({ title, rows, note }) => (
  <div>
    <p className="font-semibold text-ink">{title}</p>
    <dl className="mt-1 space-y-0.5">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4">
          <dt className="text-ink-2">{k}</dt>
          <dd className="tabular-nums text-ink">{v}</dd>
        </div>
      ))}
    </dl>
    {note && <p className="mt-1 text-micro text-ink-3">{note}</p>}
  </div>
);

/* ------------------------------------------------------------ view */

export const DashboardView: React.FC = () => {
  const { activeProperty, activePropertyUid, navigate } = useApp();
  const [period, setPeriod] = useState<DashboardPeriodKey>('today');
  const [granularity, setGranularity] = useState<DashboardGranularity>('day');
  // Longer ranges read better as weekly or monthly averages; the user can override.
  const applyPeriod = (next: DashboardPeriodKey) => {
    setPeriod(next);
    setCustomError(null);
    if (next === 'last_6_months') setGranularity('week');
    else if (next === 'last_90_days') setGranularity('week');
    else if (next === 'last_30_days' || next === 'last_7_days' || next === 'this_month' || next === 'last_month') setGranularity('day');
  };
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [applied, setApplied] = useState<{ from: string; to: string } | null>(null);
  const [customError, setCustomError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [load, setLoad] = useState<{ status: 'loading' | 'ready' | 'error'; data?: PropertyDashboard; error?: string }>({
    status: 'loading',
  });

  const query = useMemo(
    () => ({
      period,
      granularity,
      from: period === 'custom' ? applied?.from : undefined,
      to: period === 'custom' ? applied?.to : undefined,
    }),
    [period, granularity, applied],
  );

  // One request per period change (plus Refresh). Cleanup aborts the superseded
  // request, which matters under StrictMode where effects run twice in development.
  useEffect(() => {
    if (!activePropertyUid) return;
    if (period === 'custom' && !applied) {
      setLoad((prev) => ({ ...prev, status: 'ready' }));
      return;
    }
    const controller = new AbortController();
    setLoad((prev) => ({ ...prev, status: 'loading' }));
    getPropertyDashboard(activePropertyUid, query, { signal: controller.signal })
      .then((data) => setLoad({ status: 'ready', data }))
      .catch((err) => {
        if (controller.signal.aborted) return;
        setLoad((prev) => ({
          status: 'error',
          data: prev.data,
          error: err instanceof ApiError ? err.message : 'Unable to load the dashboard. Please retry.',
        }));
      });
    return () => controller.abort();
  }, [activePropertyUid, query, reloadKey, period, applied]);

  const d = load.data;
  const root = `/property/${activePropertyUid}`;
  const go = (rel: string) => navigate(`${root}/${rel}`);

  const applyCustom = () => {
    const err = validateCustomRange(customFrom, customTo);
    setCustomError(err);
    if (!err) setApplied({ from: customFrom, to: customTo });
  };

  const header = (
    <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        <p className="text-meta text-ink-3 truncate">{activeProperty?.name ?? 'Property'}</p>
        <h1 className="font-display text-title font-bold text-ink">Dashboard</h1>
        <p className="text-meta text-ink-2">
          {d ? (
            <>
              {d.period.label}
              {d.period.label.includes('–') || d.period.from === d.period.to ? '' : ` · ${fmtDayShort(d.period.from)} – ${fmtDayShort(d.period.to)}`}
              <span className="text-ink-3"> · Updated {fmtWhen(d.generated_at)} IST</span>
            </>
          ) : 'Loading…'}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="dash-period">Reporting period</label>
        <select
          id="dash-period"
          value={period}
          onChange={(e) => applyPeriod(e.target.value as DashboardPeriodKey)}
          className="rounded-[9px] border border-line-strong bg-canvas px-2.5 py-1.5 text-body text-ink"
        >
          {PERIOD_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        {period === 'custom' && (
          <>
            <input type="date" aria-label="From" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-[9px] border border-line-strong bg-canvas px-2 py-1.5 text-body text-ink" />
            <input type="date" aria-label="To" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-[9px] border border-line-strong bg-canvas px-2 py-1.5 text-body text-ink" />
            <Button size="sm" variant="secondary" onClick={applyCustom}>Apply</Button>
          </>
        )}
        <label className="sr-only" htmlFor="dash-gran">Trend granularity</label>
        <select
          id="dash-gran"
          value={granularity}
          onChange={(e) => setGranularity(e.target.value as DashboardGranularity)}
          disabled={period === 'today' || period === 'yesterday'}
          title={period === 'today' || period === 'yesterday' ? 'Today and yesterday are shown hourly' : undefined}
          className="rounded-[9px] border border-line-strong bg-canvas px-2.5 py-1.5 text-body text-ink disabled:opacity-60"
        >
          {GRANULARITY_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <Button size="sm" variant="outline" onClick={() => setReloadKey((k) => k + 1)} disabled={load.status === 'loading'}>
          <RefreshCw className={`w-3.5 h-3.5 ${load.status === 'loading' ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>
      {customError && <p role="alert" className="text-meta text-danger-ink lg:basis-full">{customError}</p>}
    </header>
  );

  if (load.status === 'error' && !d) {
    return (
      <div className="space-y-4">
        {header}
        <Panel className="max-w-lg">
          <p className="text-body font-semibold text-ink">The dashboard could not be loaded.</p>
          <p className="mt-1 text-meta text-ink-2">{load.error}</p>
          <Button className="mt-3" size="sm" variant="primary" onClick={() => setReloadKey((k) => k + 1)}>Retry</Button>
        </Panel>
      </div>
    );
  }
  if (!d) return <div className="space-y-6">{header}<SkeletonDashboard /></div>;

  const occ = d.occupancy;
  const rooms = occ.rooms;
  const beds = occ.beds;
  const dorms = occ.dorms;
  const trend = occ.trend;
  const wf = d.workforce;
  const att = wf.attendance_period;
  const tasks = d.tasks;
  const cl = d.cleaning;
  const mx = d.maintenance;
  const noMarksToday = wf.present_today === 0 && wf.absent_today === 0 && wf.on_leave_today === 0;

  /* ---- occupancy trend: never draw a value before the first ledger record ---- */
  const firstRec = trend.first_record_date;
  const trendPoints = trend.points.map((p) => {
    const dayKey = p.date ?? p.bucket.slice(0, 10);
    const beforeFirst = firstRec != null && dayKey < firstRec;
    const y = beforeFirst ? null : p.occupancy_pct;
    let title: string;
    let rowLabel = 'Occupied rooms';
    if (trend.granularity === 'hour') {
      title = `${fmtDayLong(dayKey)} · ${p.label} IST`;
    } else if (trend.granularity === 'month') {
      title = new Date(`${p.bucket}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', month: 'long', year: 'numeric' });
      rowLabel = 'Average occupied rooms';
    } else if (trend.granularity === 'week') {
      title = `Week of ${fmtDayLong(p.bucket)}`;
      rowLabel = 'Average occupied rooms';
    } else {
      title = fmtDayLong(dayKey);
    }
    const tip = beforeFirst ? (
      <Tip title={title} rows={[]} note="No occupancy record for this day. Not shown as zero." />
    ) : (
      <Tip
        title={title}
        rows={[
          [rowLabel, num(p.occupied_rooms)],
          ['Total rooms', num(p.total_rooms)],
          ['Occupancy', pct(p.occupancy_pct)],
        ]}
      />
    );
    return { x: p.label, y, tip };
  });

  /* ---- attendance trend (leave excluded from the denominator) ---- */
  const attPoints = wf.attendance_series.points.map((p) => ({
    x: p.label,
    y: p.state === 'available' ? p.attendance_pct : null,
    tip:
      p.state === 'no_records' ? (
        <Tip title={fmtDayLong(p.date)} rows={[]} note="No attendance recorded for this day. Not shown as absence." />
      ) : (
        <Tip
          title={fmtDayLong(p.date)}
          rows={[
            ['Expected', num(p.expected)],
            ['Present', num(p.present)],
            ['Absent', num(p.absent)],
            ['On approved leave', num(p.on_leave)],
            ['Attendance', pct(p.attendance_pct)],
          ]}
          note="Expected = active staff minus approved leave."
        />
      ),
  }));

  /* ---- operations series ---- */
  const seriesKeys = bucketKeys(d.period.from, d.period.to, d.period.granularity as DashboardGranularity);
  const genMap = new Map(tasks.generated_trend.map((p) => [p.bucket, p.generated]));
  const doneMap = new Map(tasks.completion_trend.map((p) => [p.bucket, p.completed]));
  const barLabel = (k: string) => (granularity === 'month' ? k.slice(0, 7) : fmtDayShort(k));

  const roomStack = [
    { key: 'occupied', label: 'Occupied', value: rooms.occupied, color: CHART.brand },
    { key: 'vacant', label: 'Vacant', value: rooms.vacant, color: CHART.vacant },
    { key: 'maintenance', label: 'Under maintenance', value: rooms.maintenance, color: CHART.maintenance },
    { key: 'cleaning_v', label: 'Cleaning (verified)', value: rooms.cleaning_verified, color: CHART.unavailable },
    { key: 'cleaning_u', label: 'Cleaning (unverified)', value: rooms.cleaning_unverified, color: '#E6CBA6' },
  ];

  return (
    <div className="space-y-8">
      {header}

      {/* 1. Occupancy trend — primary */}
      <Section id="sec-trend" title="Occupancy trend" note={`${trend.granularity === 'hour' ? 'Hourly' : trend.granularity === 'day' ? 'Daily' : trend.granularity === 'week' ? 'Weekly average' : 'Monthly average'} · ${d.period.label}`}>
        <Panel className="p-4 sm:p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-meta font-semibold text-ink">Occupancy % of rooms</p>
            {firstRec && <p className="text-micro text-ink-3">Ledger history from {fmtDayLong(firstRec)}</p>}
          </div>
          <div className="mt-3">
            {!firstRec ? (
              <Empty>No occupancy has been recorded for this property yet. The trend appears once check-ins are logged.</Empty>
            ) : (
              <>
                {!trend.reliable && <div className="mb-3"><DataNote state="limited">{trend.reason}</DataNote></div>}
                <InteractiveLine
                  points={trendPoints}
                  yMax={100}
                  yFormat={(v) => `${Math.round(v)}%`}
                  ariaLabel={`Occupancy percentage, ${d.period.label}`}
                  height={320}
                />
              </>
            )}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line pt-3 sm:grid-cols-4">
            <Stat label="Average occupied" value={trend.average_occupied_rooms ?? '—'} hint="rooms" />
            <Stat label="Peak" value={trend.peak ? `${trend.peak.occupied_rooms} rooms` : '—'} hint={trend.peak ? fmtDayShort(trend.peak.date.slice(0, 10)) : undefined} />
            <Stat label="Lowest" value={trend.low ? `${trend.low.occupied_rooms} rooms` : '—'} hint={trend.low ? fmtDayShort(trend.low.date.slice(0, 10)) : undefined} />
            <Stat label="Check-ins · check-outs" value={`${occ.period_activity.check_ins} · ${occ.period_activity.check_outs}`} hint="in period" />
          </div>
          <p className="mt-3 text-micro text-ink-3">
            Denominator: current room inventory ({rooms.total} rooms). Earlier inventory is not recorded, so rooms added later also count in earlier periods.
            Previous-period comparison is not yet available.
          </p>
        </Panel>
      </Section>

      {/* 2. Occupancy breakdown */}
      <Section id="sec-breakdown" title="Occupancy breakdown" note="Current state as of now · rooms and beds are measured separately">
        <div className="grid gap-4 lg:grid-cols-12">
          <Panel className="lg:col-span-5">
            <p className="text-meta font-semibold text-ink">Rooms by status</p>
            <div className="mt-3">
              <StackBar parts={roomStack} />
            </div>
            <ul className="mt-4 space-y-1.5">
              {roomStack.map((s) => (
                <li key={s.key} className="flex items-center justify-between gap-3 text-body">
                  <span className="flex items-center gap-2 text-ink-2">
                    <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
                    {s.label}
                  </span>
                  <span className="tabular-nums text-ink">
                    {s.value} <span className="text-ink-3">· {pct(rooms.total ? Math.round((s.value / rooms.total) * 1000) / 10 : null)}</span>
                  </span>
                </li>
              ))}
            </ul>
            {rooms.cleaning_unverified > 0 && (
              <p className="mt-3 text-meta text-danger-ink">
                {rooms.cleaning_unverified} rooms show a cleaning state with no open cleaning task. Shown as unverified, not as cleaning activity.
              </p>
            )}
            {rooms.state_ledger_mismatch > 0 && (
              <p className="mt-1 text-meta text-danger-ink">{rooms.state_ledger_mismatch} rooms disagree between recorded state and the occupancy ledger.</p>
            )}
            <p className="mt-3 text-micro text-ink-3">Occupied means an open occupancy record. Recorded state is secondary.</p>
          </Panel>

          <Panel className="lg:col-span-4">
            <p className="text-meta font-semibold text-ink">Beds and dorms</p>
            {beds.total === 0 ? (
              <div className="mt-3"><Empty>No beds are configured in this property. Room occupancy only.</Empty></div>
            ) : (
              <>
                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
                  <Stat label="Total beds" value={num(beds.total)} />
                  <Stat label="Bed occupancy" value={pct(beds.occupancy_pct)} hint="occupied ÷ total beds" />
                  <Stat label="Occupied beds" value={num(beds.occupied)} />
                  <Stat label="Available beds" value={num(beds.available)} />
                  <Stat label="Unavailable beds" value={num(beds.maintenance + beds.cleaning_verified + beds.cleaning_unverified)} hint={`${beds.maintenance} maintenance · ${beds.cleaning_verified + beds.cleaning_unverified} cleaning`} />
                  <Stat label="Dorms occupied" value={`${dorms.occupied} of ${dorms.total}`} hint={pct(dorms.occupancy_pct)} />
                </div>
                {beds.cleaning_unverified > 0 && (
                  <p className="mt-3 text-meta text-danger-ink">{beds.cleaning_unverified} beds show cleaning without an open task. Unverified.</p>
                )}
              </>
            )}
          </Panel>

          <Panel className="lg:col-span-3">
            <p className="text-meta font-semibold text-ink">Dorm occupancy by dorm</p>
            <div className="mt-3">
              <HBarList
                rows={occ.by_dorm.slice(0, 12).map((x) => ({
                  key: x.dorm_name,
                  label: x.dorm_name,
                  value: x.beds_occupied,
                  secondary: `${x.beds_occupied}/${x.beds_total} beds`,
                }))}
                emptyText="No dorms in this property."
              />
            </div>
          </Panel>
        </div>
      </Section>

      {/* 3. Occupancy by zone and room type */}
      <Section id="sec-zones" title="Occupancy by zone and room type" note="Rooms; clicking a zone opens the Zones page">
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel>
            <p className="text-meta font-semibold text-ink">By zone</p>
            <div className="mt-3">
              <HBarList
                rows={occ.by_zone.map((z) => ({
                  key: z.zone_name,
                  label: z.zone_name,
                  value: z.occupied,
                  secondary: `${z.occupied} of ${z.rooms} · ${z.vacant} available · ${pct(z.occupancy_pct)}`,
                  onSelect: () => go('property/spaces/zones'),
                }))}
                emptyText="No zones with rooms in this property."
              />
            </div>
          </Panel>
          <Panel>
            <p className="text-meta font-semibold text-ink">By room type</p>
            <div className="mt-3">
              <HBarList
                rows={occ.by_room_type.map((t) => ({
                  key: t.type,
                  label: t.type,
                  value: t.occupied,
                  secondary: `${t.occupied} of ${t.rooms} · ${pct(t.occupancy_pct)}`,
                  onSelect: () => go('property/spaces/units?tab=rooms'),
                }))}
                emptyText="No room types recorded."
              />
            </div>
          </Panel>
        </div>
      </Section>

      {/* 4. Property condition and maintenance */}
      <Section id="sec-condition" title="Property condition and maintenance" note="Resource state is separate from task status">
        <div className="grid gap-4 lg:grid-cols-12">
          <Panel className="lg:col-span-5">
            <p className="text-meta font-semibold text-ink">Room condition</p>
            <ul className="mt-3 space-y-2 text-body">
              <li className="flex justify-between"><span className="text-ink-2">Ready for occupancy</span><span className="tabular-nums text-ink">{d.conditions.ready_for_occupancy}</span></li>
              <li className="flex justify-between"><span className="text-ink-2">Occupied (ledger)</span><span className="tabular-nums text-ink">{rooms.occupied}</span></li>
              <li className="flex justify-between"><span className="text-ink-2">Under maintenance</span><span className="tabular-nums text-ink">{rooms.maintenance}</span></li>
              <li className="flex justify-between"><span className="text-ink-2">Awaiting cleaning · verified</span><span className="tabular-nums text-ink">{d.conditions.cleaning_verified}</span></li>
              <li className="flex justify-between"><span className="text-ink-2">Awaiting cleaning · unverified</span><span className={`tabular-nums ${d.conditions.cleaning_unverified ? 'text-danger-ink' : 'text-ink'}`}>{d.conditions.cleaning_unverified}</span></li>
              <li className="flex justify-between"><span className="text-ink-2">Unavailable (other state)</span><span className="tabular-nums text-ink">{rooms.other_state}</span></li>
            </ul>
            <p className="mt-3 text-micro text-ink-3">Verified cleaning means an open cleaning task exists for the unit.</p>
          </Panel>
          <Panel className="lg:col-span-7">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-meta font-semibold text-ink">Open maintenance by age</p>
              <p className="text-micro text-ink-3">Open now · {mx.open_now} tickets · {mx.critical_open} high or critical</p>
            </div>
            <div className="mt-3">
              {mx.open_now === 0 ? (
                <Empty>No open maintenance tickets.</Empty>
              ) : (
                <ColumnChart
                  bars={[
                    { label: '< 1 day', value: mx.ageing.under_1d },
                    { label: '1–3 days', value: mx.ageing['1_to_3d'] },
                    { label: '3–7 days', value: mx.ageing['3_to_7d'] },
                    { label: '> 7 days', value: mx.ageing.over_7d, color: CHART.maintenance },
                  ]}
                  height={150}
                  ariaLabel="Open maintenance tickets by age"
                />
              )}
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-meta font-semibold text-ink">Open tickets by zone</p>
                <div className="mt-2">
                  <HBarList rows={mx.by_zone.map((z) => ({ key: z.zone_name, label: z.zone_name, value: z.open }))} color={CHART.maintenance} emptyText="No open tickets." />
                </div>
              </div>
              <div>
                <p className="text-meta font-semibold text-ink">Categories in period</p>
                <div className="mt-2">
                  <HBarList rows={mx.by_category.map((c) => ({ key: c.category, label: c.category.replace(/_/g, ' '), value: c.count }))} emptyText="No tickets created in this period." />
                </div>
              </div>
            </div>
            <p className="mt-3 text-micro text-ink-3">
              Median resolution {mx.median_resolution_hours == null ? '—' : `${mx.median_resolution_hours} h`} · Resolved in period {mx.resolved_in_period} · Last ticket {mx.last_ticket_created ? fmtDayLong(mx.last_ticket_created.slice(0, 10)) : 'none recorded'}
            </p>
            {mx.last_ticket_created == null && (
              <div className="mt-2"><DataNote state="no_records">No maintenance tickets are recorded for this property.</DataNote></div>
            )}
          </Panel>

          <Panel className="lg:col-span-12 overflow-x-auto p-0">
            <p className="px-4 pt-4 text-meta font-semibold text-ink">Maintenance tickets</p>
            {mx.table.length === 0 ? (
              <div className="p-4"><Empty>No maintenance tickets in this property.</Empty></div>
            ) : (
              <table className="mt-2 w-full min-w-[720px] text-body">
                <thead>
                  <tr className="text-left text-micro uppercase tracking-[0.04em] text-ink-3">
                    <th className="px-4 py-2 font-semibold">Unit</th>
                    <th className="px-4 py-2 font-semibold">Zone</th>
                    <th className="px-4 py-2 font-semibold">Issue</th>
                    <th className="px-4 py-2 font-semibold">Status</th>
                    <th className="px-4 py-2 font-semibold">Created</th>
                    <th className="px-4 py-2 text-right font-semibold">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {mx.table.map((t) => (
                    <tr key={t.ticket_number} className="border-t border-line">
                      <td className="px-4 py-2 text-ink">{t.unit}</td>
                      <td className="px-4 py-2 text-ink-2">{t.zone}</td>
                      <td className="px-4 py-2 text-ink">{t.issue}</td>
                      <td className="px-4 py-2 capitalize text-ink-2">{t.status.replace(/_/g, ' ')}</td>
                      <td className="px-4 py-2 tabular-nums text-ink-2">{fmtWhen(t.created)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-ink">{t.duration_hours} h</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      </Section>

      {/* 5. Workforce and attendance */}
      <Section id="sec-workforce" title="Workforce and attendance" note="Attendance is plotted only for days with records">
        <div className="grid gap-4 lg:grid-cols-12">
          <Panel className="lg:col-span-8 p-4 sm:p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-meta font-semibold text-ink">Attendance % per day</p>
              <p className="text-micro text-ink-3">{wf.attendance_series.recorded_days} of {wf.attendance_series.period_days} days recorded</p>
            </div>
            <div className="mt-3">
              {wf.attendance_series.recorded_days === 0 ? (
                <Empty>No attendance has been recorded in this period. The trend appears once staff clock in.</Empty>
              ) : (
                <>
                  {wf.attendance_series.recorded_days < 14 && (
                    <div className="mb-3"><DataNote state="insufficient">Attendance is recorded on only {wf.attendance_series.recorded_days} days. Trends need at least 14.</DataNote></div>
                  )}
                  <InteractiveLine points={attPoints} yMax={100} yFormat={(v) => `${Math.round(v)}%`} ariaLabel={`Attendance percentage per day, ${d.period.label}`} height={240} />
                </>
              )}
            </div>
            <p className="mt-3 text-micro text-ink-3">{wf.attendance_series.denominator_note}</p>
          </Panel>

          <Panel className="lg:col-span-4">
            <p className="text-meta font-semibold text-ink">Availability today</p>
            {noMarksToday ? (
              <div className="mt-3"><DataNote state="insufficient">No attendance recorded today. Staff are shown as not yet marked.</DataNote></div>
            ) : (
              <div className="mt-3">
                <StackBar
                  parts={[
                    { key: 'present', label: 'Present', value: wf.present_today, color: CHART.brand },
                    { key: 'leave', label: 'On approved leave', value: wf.on_leave_today, color: CHART.unavailable },
                    { key: 'absent', label: 'Absent', value: wf.absent_today, color: CHART.maintenance },
                    { key: 'unmarked', label: 'Not yet marked', value: wf.not_yet_marked_today, color: CHART.vacant },
                  ]}
                />
              </div>
            )}
            <dl className="mt-4 grid grid-cols-2 gap-3 text-body">
              <div><dt className="text-meta text-ink-3">Active staff</dt><dd className="tabular-nums text-ink">{wf.active}</dd></div>
              <div><dt className="text-meta text-ink-3">Unallocated to a zone</dt><dd className="tabular-nums text-ink">{wf.unallocated}</dd></div>
              <div><dt className="text-meta text-ink-3">Assigned to a department</dt><dd className="tabular-nums text-ink">{wf.assigned_to_department} of {wf.active}</dd></div>
              <div><dt className="text-meta text-ink-3">On operational work</dt><dd className="tabular-nums text-ink">{wf.assigned_to_operational_work}</dd></div>
            </dl>
            <p className="mt-3 text-micro text-ink-3">Assignment to work is not the same as physical presence. Late arrivals: {att.late_reason}</p>
          </Panel>

          <Panel className="lg:col-span-12">
            <p className="text-meta font-semibold text-ink">Staff by department</p>
            <div className="mt-3 grid gap-x-8 md:grid-cols-2">
              <HBarList
                rows={d.departments.filter((x) => x.employees > 0).map((x) => ({
                  key: x.department_uid,
                  label: x.department_name,
                  value: x.employees,
                  secondary: `${x.present_today} present · ${x.on_leave_today} on leave`,
                  onSelect: () => go(`workforce/departments/${x.department_uid}`),
                }))}
                emptyText="No staff are assigned to a department yet."
              />
            </div>
          </Panel>
        </div>
      </Section>

      {/* 6. Operational performance */}
      <Section id="sec-ops" title="Operational performance" note={`Tasks ${d.period.label.toLowerCase()} · cleaning from cleaning tasks only`}>
        <div className="grid gap-4 lg:grid-cols-12">
          <Panel className="lg:col-span-7">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-meta font-semibold text-ink">Tasks generated and completed per {granularity === 'month' ? 'month' : granularity === 'week' ? 'week' : 'day'}</p>
              <p className="text-micro text-ink-3">Median completion {minutes(tasks.median_completion_minutes)} · Median review {minutes(tasks.median_review_minutes)}</p>
            </div>
            <div className="mt-3 space-y-4">
              <div>
                <p className="text-micro text-ink-3">Generated</p>
                {seriesKeys.every((k) => !genMap.get(k)) ? <Empty>No tasks generated in this period.</Empty> : (
                  <ColumnChart bars={seriesKeys.map((k) => ({ label: barLabel(k), value: genMap.get(k) ?? 0 }))} height={120} ariaLabel="Tasks generated" />
                )}
              </div>
              <div>
                <p className="text-micro text-ink-3">Completed</p>
                {tasks.completed_in_period === 0 ? <Empty>No tasks were completed in this period.</Empty> : (
                  <ColumnChart bars={seriesKeys.map((k) => ({ label: barLabel(k), value: doneMap.get(k) ?? 0, color: CHART.ink2 }))} height={120} ariaLabel="Tasks completed" />
                )}
              </div>
            </div>
          </Panel>

          <Panel className="lg:col-span-5">
            <p className="text-meta font-semibold text-ink">Current status of tasks</p>
            <div className="mt-3">
              <StackBar
                parts={[
                  { key: 'pending', label: 'Pending', value: tasks.open_by_status.pending ?? 0, color: CHART.vacant },
                  { key: 'assigned', label: 'Assigned', value: tasks.open_by_status.assigned ?? 0, color: CHART.unavailable },
                  { key: 'in_progress', label: 'In progress', value: tasks.open_by_status.in_progress ?? 0, color: CHART.brand },
                  { key: 'reopened', label: 'Reopened', value: tasks.open_by_status.reopened ?? 0, color: CHART.maintenance },
                  { key: 'submitted', label: 'Awaiting review', value: tasks.awaiting_review, color: CHART.ink2 },
                ]}
              />
            </div>
            <div className="mt-4 border-t border-line pt-3">
              <p className="text-meta font-semibold text-ink">Reviews in period</p>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
                <Stat label="Reviewed" value={tasks.reviewed_in_period} />
                <Stat label="Approved" value={tasks.approved_in_period} />
                <Stat label="Rejected" value={tasks.rejected_in_period} />
                <Stat label="Median turnaround" value={minutes(tasks.median_review_minutes)} />
              </div>
              <p className="mt-2 text-micro text-ink-3">Awaiting review counts only tasks currently in review. Stale submission rows are excluded.</p>
            </div>
          </Panel>

          <Panel className="lg:col-span-6">
            <p className="text-meta font-semibold text-ink">Abandonment, by reason</p>
            <p className="mt-1 text-micro text-ink-3">Expiry by design is how recurring work ends. It is not a failure rate.</p>
            {tasks.abandoned_reasons.length === 0 ? (
              <div className="mt-3"><Empty>No abandoned tasks in this period.</Empty></div>
            ) : (
              <ul className="mt-3 space-y-1.5 text-body">
                {tasks.abandoned_reasons.map((r) => (
                  <li key={r.reason} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-ink-2">
                      {r.reason.replace(/_/g, ' ').toLowerCase()}
                      <span className="ml-2 text-micro text-ink-3">{r.class === 'expiry' ? 'expiry by design' : 'other'}</span>
                    </span>
                    <span className="tabular-nums text-ink">{r.count}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-micro text-ink-3">Completion rate {pct(tasks.completion_rate_pct)} of {tasks.completion_rate_base} tasks, excluding expiry by design.</p>
          </Panel>

          <Panel className="lg:col-span-6">
            <p className="text-meta font-semibold text-ink">Cleaning</p>
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              <Stat label="Generated" value={cl.created_in_period} />
              <Stat label="Completed" value={cl.completed_in_period} />
              <Stat label="Pending now" value={cl.pending_now} />
              <Stat label="Median turnaround" value={minutes(cl.median_turnaround_minutes)} />
            </div>
            <div className="mt-4">
              <HBarList rows={cl.by_zone.map((z) => ({ key: z.zone_name, label: z.zone_name, value: z.pending }))} emptyText="No pending cleaning tasks." />
            </div>
            <p className="mt-3 text-micro text-ink-3">{cl.note}</p>
          </Panel>

          <Panel className="lg:col-span-12 overflow-x-auto p-0">
            <p className="px-4 pt-4 text-meta font-semibold text-ink">Department task performance</p>
            {d.departments.length === 0 ? (
              <div className="p-4"><Empty>No departments are set up for this property yet.</Empty></div>
            ) : (
              <table className="mt-2 w-full min-w-[640px] text-body">
                <thead>
                  <tr className="text-left text-micro uppercase tracking-[0.04em] text-ink-3">
                    <th className="px-4 py-2 font-semibold">Department</th>
                    <th className="px-4 py-2 text-right font-semibold">Staff</th>
                    <th className="px-4 py-2 text-right font-semibold">Tasks created</th>
                    <th className="px-4 py-2 text-right font-semibold">Completed</th>
                    <th className="px-4 py-2 text-right font-semibold">Completion</th>
                    <th className="px-4 py-2 text-right font-semibold">Pending now</th>
                  </tr>
                </thead>
                <tbody>
                  {d.departments.map((x) => (
                    <tr key={x.department_uid} onClick={() => go(`workforce/departments/${x.department_uid}`)}
                      className="cursor-pointer border-t border-line hover:bg-hover">
                      <td className="px-4 py-2 text-ink">{x.department_name}{x.status === 'inactive' && <span className="ml-2 text-micro text-ink-3">inactive</span>}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{x.employees}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{x.tasks_created}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{x.tasks_completed}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{pct(x.completion_pct)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{x.open_now}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      </Section>

      {/* 7. Activity and data quality */}
      <Section id="sec-activity" title="Activity and data quality" note="Real records only">
        <div className="grid gap-4 lg:grid-cols-12">
          <Panel className="lg:col-span-7">
            <p className="text-meta font-semibold text-ink">Recent activity · {d.period.label}</p>
            {d.activity.length === 0 ? (
              <div className="mt-3"><Empty>No recorded activity in this period.</Empty></div>
            ) : (
              <ol className="mt-3 divide-y divide-line">
                {d.activity.map((a, i) => (
                  <li key={`${a.at}-${i}`}>
                    <button type="button" onClick={() => go(a.href)} className="flex w-full items-start justify-between gap-3 py-2 text-left cursor-pointer hover:bg-hover">
                      <span className="min-w-0">
                        <span className="block text-body text-ink">{a.label}</span>
                        <span className="block truncate text-meta text-ink-2">{a.detail ?? '—'}{a.actor ? ` · ${a.actor}` : ''}</span>
                      </span>
                      <span className="shrink-0 text-micro tabular-nums text-ink-3">{fmtWhen(a.at)}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
          <Panel className="lg:col-span-5">
            <p className="text-meta font-semibold text-ink">Data quality</p>
            <ul className="mt-3 space-y-3">
              {d.data_quality.map((q: DashboardDataQualityItem) => (
                <li key={q.key} className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-body text-ink">{q.label}</span>
                    <StateChip state={q.state} />
                  </div>
                  <p className="text-meta text-ink-2">{q.detail}</p>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </Section>

      <p className="text-micro text-ink-3">
        Business days run from {d.current.operational_day_start} IST. Figures reflect the database at {fmtWhen(d.generated_at)} IST.
      </p>
    </div>
  );
};
