import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, RefreshCw } from 'lucide-react';
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
import { CHART, HBarList, InteractiveLine, StackBar } from './charts';
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

const STATE_STYLE: Record<DataState, { label: string; cls: string }> = {
  available: { label: 'Available', cls: 'bg-success-soft text-success-ink border-[#BFE3D2]' },
  limited: { label: 'Limited data', cls: 'bg-warn-soft text-warn-ink border-[#F2D9AF]' },
  insufficient: { label: 'Insufficient data', cls: 'bg-hover text-ink-2 border-line-strong' },
  unverified: { label: 'Unverified', cls: 'bg-danger-soft text-danger-ink border-[#F0C8C8]' },
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
    <p className="font-num tabular-nums text-body font-semibold text-ink">{value}</p>
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
          <dd className="font-num tabular-nums text-ink">{v}</dd>
        </div>
      ))}
    </dl>
    {note && <p className="mt-1 text-micro text-ink-3">{note}</p>}
  </div>
);

/* ------------------------------------------------------------ view */

type UnitKind = 'rooms' | 'beds' | 'dorms';

export const DashboardView: React.FC = () => {
  const { activeProperty, activePropertyUid, currentRole, navigate } = useApp();
  const [period, setPeriod] = useState<DashboardPeriodKey>('today');
  const [granularity, setGranularity] = useState<DashboardGranularity>('day');
  const applyPeriod = (next: DashboardPeriodKey) => {
    setPeriod(next);
    setCustomError(null);
    if (next === 'last_6_months' || next === 'last_90_days') setGranularity('week');
    else if (next !== 'custom') setGranularity('day');
  };
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [applied, setApplied] = useState<{ from: string; to: string } | null>(null);
  const [customError, setCustomError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [unitKind, setUnitKind] = useState<UnitKind>('rooms');
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
  const unitDist = {
    rooms: {
      label: 'Rooms',
      total: rooms.total,
      parts: [
        { key: 'occupied', label: 'Occupied', value: rooms.occupied, color: CHART.occupied },
        { key: 'available', label: 'Available', value: rooms.vacant, color: CHART.available },
        { key: 'unavailable', label: 'Unavailable', value: rooms.maintenance + rooms.cleaning_verified + rooms.cleaning_unverified + rooms.other_state, color: CHART.unavailable },
      ],
      sub: `${pct(rooms.occupancy_pct)} occupied · ${rooms.maintenance} maintenance · ${rooms.cleaning_verified + rooms.cleaning_unverified} cleaning`,
      drill: 'property/spaces/units?tab=rooms',
    },
    beds: {
      label: 'Beds',
      total: beds.total,
      parts: [
        { key: 'occupied', label: 'Occupied', value: beds.occupied, color: CHART.occupied },
        { key: 'available', label: 'Available', value: beds.available, color: CHART.available },
        { key: 'unavailable', label: 'Unavailable', value: beds.maintenance + beds.cleaning_verified + beds.cleaning_unverified, color: CHART.unavailable },
      ],
      sub: `${pct(beds.occupancy_pct)} occupied · ${beds.maintenance} maintenance · ${beds.cleaning_verified + beds.cleaning_unverified} cleaning`,
      drill: 'property/spaces/units?tab=dorms',
    },
    dorms: {
      label: 'Dorms',
      total: dorms.total,
      parts: [
        { key: 'occupied', label: 'Occupied', value: dorms.occupied, color: CHART.occupied },
        { key: 'available', label: 'Available', value: dorms.vacant, color: CHART.available },
        { key: 'unavailable', label: 'Unavailable', value: dorms.maintenance + dorms.cleaning_verified + dorms.cleaning_unverified, color: CHART.unavailable },
      ],
      sub: `${pct(dorms.occupancy_pct)} occupied · ${dorms.maintenance} maintenance`,
      drill: 'property/spaces/units?tab=dorms',
    },
  }[unitKind];

  /* ---- occupancy trend: never draw a value before the first ledger record ---- */
  const firstRec = trend.first_record_date;
  const trendPoints = trend.points.map((p) => {
    const dayKey = p.date ?? p.bucket.slice(0, 10);
    const beforeFirst = firstRec != null && dayKey < firstRec;
    const y = beforeFirst ? null : p.occupancy_pct;
    let title: string;
    let rowLabel = 'Occupied units';
    if (trend.granularity === 'hour') {
      title = `${fmtDayLong(dayKey)} · ${p.label} IST`;
    } else if (trend.granularity === 'month') {
      title = new Date(`${p.bucket}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', month: 'long', year: 'numeric' });
      rowLabel = 'Average occupied units';
    } else if (trend.granularity === 'week') {
      title = `Week of ${fmtDayLong(p.bucket)}`;
      rowLabel = 'Average occupied units';
    } else {
      title = fmtDayLong(dayKey);
    }
    const tip = beforeFirst ? (
      <Tip title={title} rows={[]} note="No occupancy record for this day. Not shown as zero." />
    ) : (
      <Tip
        title={title}
        rows={[
          [rowLabel, num(p.occupied_units)],
          ['Total units', num(p.total_units)],
          ['Occupancy', pct(p.occupancy_pct)],
        ]}
      />
    );
    return { x: p.label, y, tip };
  });



  return (
    <div className="space-y-8">
      {header}

      {/* 1. Occupancy trend — primary */}
      <Section id="sec-trend" title="Occupancy trend" note={`${trend.granularity === 'hour' ? 'Hourly' : trend.granularity === 'day' ? 'Daily' : trend.granularity === 'week' ? 'Weekly average' : 'Monthly average'} · ${d.period.label}`}>
        <Panel className="p-4 sm:p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-meta font-semibold text-ink">
              Occupancy % of rooms
              {occ.combined?.occupancy_pct != null && (
                <span className="ml-2 font-num text-body-lg font-bold text-brand-ink">{occ.combined.occupancy_pct}%</span>
              )}
              <span className="ml-1 font-normal text-ink-3">now</span>
            </p>
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
                  height={300}
                />
              </>
            )}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line pt-3 sm:grid-cols-4">
            <Stat label="Average occupied" value={trend.average_occupied_units ?? trend.average_occupied_rooms ?? '—'} hint="units" />
            <Stat label="Peak" value={trend.peak ? `${trend.peak.occupied_units ?? trend.peak.occupied_rooms} units` : '—'} hint={trend.peak ? fmtDayShort(trend.peak.date.slice(0, 10)) : undefined} />
            <Stat label="Lowest" value={trend.low ? `${trend.low.occupied_units ?? trend.low.occupied_rooms} units` : '—'} hint={trend.low ? fmtDayShort(trend.low.date.slice(0, 10)) : undefined} />
            <Stat label="Check-ins · check-outs" value={`${occ.period_activity.check_ins} · ${occ.period_activity.check_outs}`} hint="in period" />
          </div>
        </Panel>
      </Section>

      {/* 2. Space distribution */}
      <Section id="sec-space" title="Space distribution" note="Current state · occupied means an open occupancy record">
        <div className="grid gap-4 lg:grid-cols-12">
          <Panel className="lg:col-span-5">
            <div className="flex items-center justify-between gap-2">
              <div className="inline-flex rounded-lg border border-line bg-canvas p-0.5" role="group" aria-label="Unit kind">
                {(['rooms', 'beds', 'dorms'] as UnitKind[]).map((k) => (
                  <button
                    key={k}
                    onClick={() => setUnitKind(k)}
                    aria-pressed={unitKind === k}
                    className={`rounded-[7px] px-3 py-1 text-meta font-semibold capitalize transition-colors ${
                      unitKind === k ? 'bg-surface text-ink shadow-sm' : 'text-ink-3 hover:text-ink'
                    }`}
                  >
                    {k}
                  </button>
                ))}
              </div>
              <button onClick={() => go(unitDist.drill)} className="inline-flex items-center gap-1 text-meta font-medium text-brand-ink hover:underline">
                Open {unitDist.label.toLowerCase()} <ArrowRight className="h-3 w-3" />
              </button>
            </div>
            <p className="mt-3 text-meta text-ink-2">{unitDist.sub}</p>
            <div className="mt-3">
              <StackBar parts={unitDist.parts} />
            </div>
            <ul className="mt-3 space-y-1.5 border-t border-line pt-3">
              {unitDist.parts.map((s) => (
                <li key={s.key} className="flex items-center justify-between gap-3 text-body">
                  <span className="flex items-center gap-2 text-ink-2">
                    <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
                    {s.label}
                  </span>
                  <span className="font-num tabular-nums text-ink">
                    {s.value} <span className="text-ink-3">· {pct(unitDist.total ? Math.round((s.value / unitDist.total) * 1000) / 10 : null)}</span>
                  </span>
                </li>
              ))}
            </ul>
            {(rooms.state_ledger_mismatch > 0 || rooms.cleaning_unverified + beds.cleaning_unverified > 0) && (
              <p className="mt-3 text-meta text-danger-ink">
                {rooms.cleaning_unverified + beds.cleaning_unverified > 0 &&
                  `${rooms.cleaning_unverified + beds.cleaning_unverified} units show cleaning with no open task. `}
                {rooms.state_ledger_mismatch > 0 && `${rooms.state_ledger_mismatch} rooms disagree between recorded state and the occupancy ledger.`}
              </p>
            )}
          </Panel>

          <Panel className="lg:col-span-4">
            <p className="text-meta font-semibold text-ink">Occupancy by zone</p>
            <div className="mt-3">
              <HBarList
                rows={occ.by_zone.map((z) => ({
                  key: z.zone_name,
                  label: z.zone_name,
                  value: z.occupied,
                  secondary: `${z.occupied} of ${z.rooms} · ${pct(z.occupancy_pct)}`,
                  onSelect: () => go('property/spaces/zones'),
                }))}
                emptyText="No zones with rooms in this property."
              />
            </div>
          </Panel>
          <Panel className="lg:col-span-3">
            <p className="text-meta font-semibold text-ink">By room type</p>
            <div className="mt-3">
              <HBarList
                rows={occ.by_room_type.map((t) => ({
                  key: t.type,
                  label: t.type,
                  value: t.occupied,
                  secondary: `${t.occupied}/${t.rooms} · ${pct(t.occupancy_pct)}`,
                  onSelect: () => go('property/spaces/units?tab=rooms'),
                }))}
                emptyText="No room types recorded."
              />
            </div>
          </Panel>
        </div>
      </Section>

      {/* 3. Recent activity + data quality */}
      <Section id="sec-activity" title="Recent activity" note="Real records only">
        <div className="grid gap-4 lg:grid-cols-12">
          <Panel className="lg:col-span-7">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-meta font-semibold text-ink">Latest events · {d.period.label}</p>
              {currentRole === 'super_admin' && (
                <button onClick={() => go('insights/audit')} className="inline-flex items-center gap-1 text-meta font-medium text-brand-ink hover:underline">
                  View all <ArrowRight className="h-3 w-3" />
                </button>
              )}
            </div>
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
                      <span className="font-num shrink-0 text-micro tabular-nums text-ink-3">{fmtWhen(a.at)}</span>
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
