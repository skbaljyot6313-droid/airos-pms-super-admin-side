import React from 'react';

/*
 * Dependency-free SVG charts for the Dashboard. Colours are the approved warm
 * palette (brand green, existing danger/amber and neutral line tones). Every
 * chart has a text equivalent (legend or labels) so colour is never the only
 * carrier of meaning.
 */

export const CHART = {
  brand: '#386641',
  vacant: '#DDD7CB',
  maintenance: '#A32A2A',
  unavailable: '#C98232',
  track: '#F2ECE3',
  axis: '#8C867C',
  grid: '#EAE5DC',
  ink: '#24221F',
  ink2: '#6C675F',
} as const;

export interface DonutSegment {
  key: string;
  label: string;
  count: number;
  pct: number | null;
  color: string;
  onSelect?: () => void;
}

export const DonutChart: React.FC<{ segments: DonutSegment[]; total: number; centerLabel: string }> = ({
  segments,
  total,
  centerLabel,
}) => {
  const r = 52;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg viewBox="0 0 140 140" className="w-36 h-36 shrink-0" role="img" aria-label={`${total} ${centerLabel}`}>
      <circle cx="70" cy="70" r={r} fill="none" stroke={CHART.track} strokeWidth="16" />
      {total > 0 &&
        segments.map((s) => {
          const len = (s.count / total) * c;
          const el = (
            <circle
              key={s.key}
              cx="70"
              cy="70"
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth="16"
              strokeDasharray={`${Math.max(len - 0.5, 0)} ${c}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 70 70)"
              className={s.onSelect ? 'cursor-pointer' : undefined}
              onClick={s.onSelect}
            >
              <title>{`${s.label}: ${s.count}${s.pct != null ? ` (${s.pct}%)` : ''}`}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
      <text x="70" y="68" textAnchor="middle" fontSize="22" fontWeight="700" fill={CHART.ink} className="font-display">
        {total}
      </text>
      <text x="70" y="86" textAnchor="middle" fontSize="11" fill={CHART.ink2}>
        {centerLabel}
      </text>
    </svg>
  );
};

/** Area/line trend with a y-axis from zero to `yMax`. */
export const LineTrend: React.FC<{
  points: { label: string; value: number }[];
  yMax: number;
  height?: number;
  format?: (v: number) => string;
  ariaLabel: string;
}> = ({ points, yMax, height = 170, format = (v) => String(Math.round(v)), ariaLabel }) => {
  const W = 640;
  const H = height;
  const padL = 36;
  const padB = 22;
  const padT = 10;
  const innerW = W - padL - 8;
  const innerH = H - padB - padT;
  const max = Math.max(yMax, 1);
  const x = (i: number) => padL + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => padT + innerH - (Math.min(v, max) / max) * innerH;
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = points.length
    ? `${path} L${x(points.length - 1).toFixed(1)},${padT + innerH} L${x(0).toFixed(1)},${padT + innerH} Z`
    : '';
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f * 10) / 10);
  const labelEvery = Math.max(1, Math.ceil(points.length / 7));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={ariaLabel}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={padL} x2={W - 8} y1={y(t)} y2={y(t)} stroke={CHART.grid} />
          <text x={padL - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill={CHART.axis}>
            {format(t)}
          </text>
        </g>
      ))}
      {area && <path d={area} fill={CHART.brand} opacity="0.12" />}
      {path && <path d={path} fill="none" stroke={CHART.brand} strokeWidth="2" strokeLinejoin="round" />}
      {points.map((p, i) => (
        <g key={p.label + i}>
          <circle cx={x(i)} cy={y(p.value)} r="3" fill={CHART.brand}>
            <title>{`${p.label}: ${format(p.value)}`}</title>
          </circle>
          {i % labelEvery === 0 && (
            <text x={x(i)} y={H - 6} textAnchor="middle" fontSize="11" fill={CHART.axis}>
              {p.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
};

/** Vertical columns for counts per bucket, with value labels. */
export const ColumnChart: React.FC<{
  bars: { label: string; value: number; color?: string }[];
  height?: number;
  ariaLabel: string;
}> = ({ bars, height = 160, ariaLabel }) => {
  const W = 640;
  const H = height;
  const padB = 22;
  const padT = 14;
  const innerH = H - padB - padT;
  const max = Math.max(1, ...bars.map((b) => b.value));
  const slot = bars.length ? (W - 8) / bars.length : 0;
  const labelEvery = Math.max(1, Math.ceil(bars.length / 8));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={ariaLabel}>
      {bars.map((b, i) => {
        const h = (b.value / max) * innerH;
        const bx = 4 + i * slot + slot * 0.18;
        const bw = slot * 0.64;
        return (
          <g key={b.label + i}>
            <rect x={bx} y={padT + innerH - h} width={bw} height={Math.max(h, b.value > 0 ? 2 : 0)}
              rx="3" fill={b.color ?? CHART.brand}>
              <title>{`${b.label}: ${b.value}`}</title>
            </rect>
            {b.value > 0 && bars.length <= 31 && (
              <text x={bx + bw / 2} y={padT + innerH - h - 4} textAnchor="middle" fontSize="11" fill={CHART.ink2}>
                {b.value}
              </text>
            )}
            {i % labelEvery === 0 && (
              <text x={bx + bw / 2} y={H - 6} textAnchor="middle" fontSize="11" fill={CHART.axis}>
                {b.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
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
              <span className="text-body text-ink truncate group-hover:text-brand">{r.label}</span>
              <span className="text-meta text-ink-2 tabular-nums shrink-0">
                {r.value}
                {r.secondary ? <span className="text-ink-3"> · {r.secondary}</span> : null}
              </span>
            </div>
            <div className="mt-1 h-2 rounded-full bg-[#F2ECE3] overflow-hidden">
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
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-[#F2ECE3]" role="img"
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
            <span className="tabular-nums text-ink">{p.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/**
 * Line chart with hover/touch tooltips. Gaps (null values) break the line so
 * missing history is never drawn as a value. `tip` renders the tooltip body.
 */
export const InteractiveLine: React.FC<{
  points: { x: string; y: number | null; tip: React.ReactNode }[];
  yMax: number;
  yFormat: (v: number) => string;
  ariaLabel: string;
  height?: number;
}> = ({ points, yMax, yFormat, ariaLabel, height = 300 }) => {
  const [hover, setHover] = React.useState<number | null>(null);
  const ref = React.useRef<HTMLDivElement>(null);
  const W = 800;
  const H = height;
  const padL = 46;
  const padB = 28;
  const padT = 12;
  const innerW = W - padL - 12;
  const innerH = H - padB - padT;
  const max = Math.max(yMax, 1);
  const n = points.length;
  const x = (i: number) => padL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => padT + innerH - (Math.min(v, max) / max) * innerH;
  // break the path at null values
  const segments: string[] = [];
  let cur = '';
  points.forEach((p, i) => {
    if (p.y == null) {
      if (cur) segments.push(cur);
      cur = '';
      return;
    }
    cur += `${cur ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)} `;
  });
  if (cur) segments.push(cur);
  const labelEvery = Math.max(1, Math.ceil(n / 8));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => max * f);

  const onMove = (clientX: number) => {
    const el = ref.current;
    if (!el || n === 0) return;
    const rect = el.getBoundingClientRect();
    const rel = (clientX - rect.left) / rect.width; // 0..1 across the svg
    const svgX = rel * W;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(x(i) - svgX);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHover(best);
  };
  const hp = hover != null ? points[hover] : null;
  return (
    <div ref={ref} className="relative w-full select-none"
      onPointerMove={(e) => onMove(e.clientX)}
      onPointerDown={(e) => onMove(e.clientX)}
      onPointerLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={ariaLabel}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - 12} y1={y(t)} y2={y(t)} stroke={CHART.grid} />
            <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize="12" fill={CHART.axis}>
              {yFormat(t)}
            </text>
          </g>
        ))}
        {segments.map((d, i) => (
          <path key={i} d={d} fill="none" stroke={CHART.brand} strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {points.map((p, i) =>
          p.y == null ? null : (
            <circle key={p.x + i} cx={x(i)} cy={y(p.y)} r={hover === i ? 5 : 2.5} fill={CHART.brand} />
          ),
        )}
        {points.map((p, i) =>
          i % labelEvery === 0 ? (
            <text key={'l' + p.x + i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="12" fill={CHART.axis}>
              {p.x}
            </text>
          ) : null,
        )}
        {hover != null && (
          <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + innerH} stroke={CHART.ink2} strokeDasharray="3 3" />
        )}
      </svg>
      {hp && hover != null && (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-[180px] rounded-[10px] border border-line bg-surface px-3 py-2 text-body text-ink shadow-sm"
          style={{ left: `clamp(0px, calc(${(x(hover) / W) * 100}% - 90px), calc(100% - 190px))` }}
        >
          {hp.tip}
        </div>
      )}
    </div>
  );
};
