import React from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

/*
 * Shared AiROS chart kit (Recharts). Palette = design tokens; every chart has
 * a text equivalent (legend, labels or accessible name) so colour is never
 * the only carrier of meaning. Nulls break lines — missing history is never
 * drawn as a value.
 */

export const CHART = {
  brand: '#800020',
  brandDark: '#66001A',
  success: '#16865B',
  available: '#1E3B2F',
  occupied: '#1B365D',
  cleaning: '#F4BE38',
  mxState: '#790D16',
  progress: '#7554C8',
  scheduled: '#14616B',
  vacant: '#D6D3D1',
  maintenance: '#790D16',
  unavailable: '#E99A23',
  inactive: '#7A8495',
  info: '#3478D4',
  pending: '#7554C8',
  navy: '#0D1C42',
  orange: '#FF9137',
  danger: '#D64545',
  track: '#F6F4F2',
  axis: '#98A2B3',
  grid: '#E7E5E4',
  ink: '#0D1C42',
  ink2: '#667085',
  /** Coordinated multi-series accents — use the minimum needed per chart. */
  accents: ['#800020', '#0D1C42', '#FF9137', '#7554C8', '#3478D4', '#16865B', '#B34A68'],
} as const;

/* ------------------------------------------------------------------ tips */

interface TipRow {
  x?: string;
  tip?: React.ReactNode;
}

const TipShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="min-w-[170px] rounded-[10px] border border-line bg-surface px-3 py-2 text-body text-ink shadow-sm">
    {children}
  </div>
);

const TrendTip: React.FC<{ active?: boolean; payload?: { payload?: TipRow }[] }> = ({
  active,
  payload,
}) => {
  if (!active || !payload?.length) return null;
  const tip = payload[0]?.payload?.tip;
  return tip ? <TipShell>{tip}</TipShell> : null;
};

const CountTip: React.FC<{
  active?: boolean;
  payload?: { payload?: { label: string; value: number } }[];
  label?: string;
}> = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  if (!p) return null;
  return (
    <TipShell>
      <p className="font-semibold text-ink">{p.label ?? label}</p>
      <p className="font-num tabular-nums text-ink-2">{p.value}</p>
    </TipShell>
  );
};

/* ------------------------------------------------------------- primitives */

export interface TrendPoint {
  x: string;
  y: number | null;
  tip?: React.ReactNode;
}

/**
 * Area/line trend. Gaps (null values) break the line so missing history is
 * never drawn as a value. `tip` on a point renders the tooltip body.
 */
export const InteractiveLine: React.FC<{
  points: TrendPoint[];
  yMax: number;
  yFormat: (v: number) => string;
  ariaLabel: string;
  height?: number;
  series?: { key: string; color: string }[];
}> = ({ points, yMax, yFormat, ariaLabel, height = 300 }) => {
  return (
    <div role="img" aria-label={ariaLabel} style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <AreaChart data={points} margin={{ top: 10, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART.brand} stopOpacity={0.16} />
              <stop offset="100%" stopColor={CHART.brand} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={CHART.grid} />
          <XAxis
            dataKey="x"
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
            minTickGap={40}
            tick={{ fontSize: 11, fill: CHART.axis }}
            tickMargin={8}
          />
          <YAxis
            domain={[0, yMax]}
            tickLine={false}
            axisLine={false}
            width={42}
            tick={{ fontSize: 11, fill: CHART.axis }}
            tickFormatter={(v: number) => yFormat(v)}
          />
          <Tooltip content={<TrendTip />} cursor={{ stroke: CHART.ink2, strokeDasharray: '3 3' }} />
          <Area
            type="monotone"
            dataKey="y"
            stroke={CHART.brand}
            strokeWidth={2.25}
            fill="url(#trendFill)"
            connectNulls={false}
            dot={false}
            activeDot={{ r: 4, fill: CHART.brand, stroke: '#fff', strokeWidth: 1.5 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};

/** Simple single-series trend (same visual language as InteractiveLine). */
export const LineTrend: React.FC<{
  points: { label: string; value: number }[];
  yMax: number;
  height?: number;
  format?: (v: number) => string;
  ariaLabel: string;
}> = ({ points, yMax, height = 170, format = (v) => String(Math.round(v)), ariaLabel }) => (
  <InteractiveLine
    points={points.map((p) => ({ x: p.label, y: p.value }))}
    yMax={yMax}
    yFormat={format}
    ariaLabel={ariaLabel}
    height={height}
  />
);

/** Vertical columns for counts per bucket. */
export const ColumnChart: React.FC<{
  bars: { label: string; value: number; color?: string }[];
  height?: number;
  ariaLabel: string;
}> = ({ bars, height = 160, ariaLabel }) => {
  return (
    <div role="img" aria-label={ariaLabel} style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <BarChart data={bars} margin={{ top: 14, right: 4, bottom: 0, left: 4 }} barCategoryGap="30%">
          <CartesianGrid vertical={false} stroke={CHART.grid} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
            minTickGap={30}
            tick={{ fontSize: 11, fill: CHART.axis }}
            tickMargin={8}
          />
          <YAxis hide domain={[0, 'auto']} />
          <Tooltip content={<CountTip />} cursor={{ fill: CHART.track }} />
          <Bar dataKey="value" radius={[3, 3, 0, 0]} maxBarSize={36}>
            {bars.map((b, i) => (
              <Cell key={i} fill={b.color ?? CHART.brand} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};

const GroupTip: React.FC<{
  active?: boolean;
  payload?: { payload?: { label: string; a: number; b: number } }[];
  label?: string;
  series: { label: string; color: string }[];
}> = ({ active, payload, series }) => {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  if (!p) return null;
  return (
    <TipShell>
      <p className="font-semibold text-ink">{p.label}</p>
      <p className="font-num tabular-nums text-ink-2">
        <span className="mr-3"><span style={{ color: series[0].color }}>●</span> {series[0].label} {p.a}</span>
        <span><span style={{ color: series[1].color }}>●</span> {series[1].label} {p.b}</span>
      </p>
    </TipShell>
  );
};

/** Grouped two-series columns — e.g. generated vs completed per bucket. */
export const GroupBar: React.FC<{
  rows: { label: string; a: number; b: number }[];
  series: [{ label: string; color: string }, { label: string; color: string }];
  height?: number;
  ariaLabel: string;
}> = ({ rows, series, height = 200, ariaLabel }) => {
  return (
    <div role="img" aria-label={ariaLabel} style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ top: 14, right: 4, bottom: 0, left: 4 }} barCategoryGap="30%" barGap={3}>
          <CartesianGrid vertical={false} stroke={CHART.grid} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
            minTickGap={30}
            tick={{ fontSize: 11, fill: CHART.axis }}
            tickMargin={8}
          />
          <YAxis hide domain={[0, 'auto']} />
          <Tooltip
            content={<GroupTip series={[{ label: series[0].label, color: series[0].color }, { label: series[1].label, color: series[1].color }]} />}
            cursor={{ fill: CHART.track }}
          />
          <Bar dataKey="a" name={series[0].label} fill={series[0].color} radius={[3, 3, 0, 0]} maxBarSize={22} />
          <Bar dataKey="b" name={series[1].label} fill={series[1].color} radius={[3, 3, 0, 0]} maxBarSize={22} />
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-1 flex items-center gap-4 text-meta text-ink-2">
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full" style={{ background: series[0].color }} />{series[0].label}</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full" style={{ background: series[1].color }} />{series[1].label}</span>
      </div>
    </div>
  );
};

/** Horizontal bars for ranked comparisons (departments, zones). */
export const HBarList: React.FC<{
  rows: { key: string; label: string; value: number; secondary?: string; onSelect?: () => void }[];
  max?: number;
  color?: string;
  emptyText: string;
}> = ({ rows, max, color = CHART.brand, emptyText }) => {
  if (!rows.length) return <p className="text-body text-ink-3">{emptyText}</p>;
  const top = Math.max(max ?? 0, ...rows.map((r) => r.value), 1);
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.key}>
          <button
            type="button"
            onClick={r.onSelect}
            disabled={!r.onSelect}
            className={`w-full text-left group ${r.onSelect ? 'cursor-pointer' : 'cursor-default'}`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-body text-ink truncate group-hover:text-brand-ink">{r.label}</span>
              <span className="font-num text-meta text-ink-2 tabular-nums shrink-0">
                {r.value}
                {r.secondary ? <span className="text-ink-3"> · {r.secondary}</span> : null}
              </span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-shell">
              <div className="h-full rounded-full" style={{ width: `${(r.value / top) * 100}%`, background: color }} />
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
};

/** Single stacked bar: counts per part of a whole. */
export const StackBar: React.FC<{
  parts: { key: string; label: string; value: number; color: string }[];
}> = ({ parts }) => {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-shell" role="img"
        aria-label={parts.map((p) => `${p.label} ${p.value}`).join(', ')}>
        {total > 0 &&
          parts.map((p) => (
            <div key={p.key} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />
          ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-1.5 text-meta text-ink-2">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: p.color }} />
            <span>{p.label}</span>
            <span className="font-num tabular-nums text-ink">{p.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

export interface DonutSegment {
  key: string;
  label: string;
  count: number;
  pct: number | null;
  color: string;
  onSelect?: () => void;
}

/** Donut for simple proportions — centre shows the total. */
export const DonutChart: React.FC<{ segments: DonutSegment[]; total: number; centerLabel: string }> = ({
  segments,
  total,
  centerLabel,
}) => (
  <div className="relative h-36 w-36 shrink-0" role="img" aria-label={`${total} ${centerLabel}`}>
    <ResponsiveContainer>
      <PieChart>
        <Pie
          data={segments.filter((s) => s.count > 0)}
          dataKey="count"
          nameKey="label"
          innerRadius={52}
          outerRadius={68}
          strokeWidth={0}
          isAnimationActive={false}
        >
          {segments
            .filter((s) => s.count > 0)
            .map((s) => (
              <Cell key={s.key} fill={s.color} onClick={s.onSelect} style={s.onSelect ? { cursor: 'pointer' } : undefined} />
            ))}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
      <span className="font-display text-[22px] font-bold text-ink">{total}</span>
      <span className="text-[11px] text-ink-2">{centerLabel}</span>
    </div>
  </div>
);
