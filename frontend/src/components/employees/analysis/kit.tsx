import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, TrendingDown, TrendingUp } from 'lucide-react';
import { Button } from '../../ui/Button';

export const C = {
  bg: '#FFFFFF', surface: '#ffffff', text: '#2457A8', muted: '#2457A8', faint: '#7FA8CE',
  navy: '#2457A8', blue: '#3478D4', success: '#16865B', warning: '#A56514', danger: '#D64545',
  border: '#EAF1FB', hairline: '#EAF1FB', track: '#FFFCFA', mutedSurface: '#FFFCFA',
  successBg: '#E6F4EE', warningBg: '#FFFCFA', dangerBg: '#FAEBEB', nested: '#FFFFFF',
};

export const card = 'rounded-xl border border-[#EAF1FB] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]';

/** Open surface — the primary section treatment. No box: just a header row
 *  over a hairline-divided body. */
export function Section({ title, note, action, children, className }: {
  title: string; note?: string; action?: React.ReactNode;
  children: React.ReactNode; className?: string;
}) {
  return <section aria-label={title} className={className || ''}>
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[#EAF1FB] pb-3">
      <div>
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[#2457A8]">{title}</h2>
        {note && <p className="mt-0.5 text-xs text-[#7FA8CE]">{note}</p>}
      </div>
      {action}
    </div>
    {children}
  </section>;
}

/** Floating/elevated panel — dropdowns, overlays, the lone framed surface. */
export function Panel({ title, note, action, children, className }: {
  title: string; note?: string; action?: React.ReactNode;
  children: React.ReactNode; className?: string;
}) {
  return <section aria-label={title} className={`${card} p-5 ${className || ''}`}>
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[#2457A8]">{title}</h2>
      {action}
    </div>
    {note && <p className="mt-0.5 text-xs leading-relaxed text-[#7FA8CE]">{note}</p>}
    {children}
  </section>;
}

/** Staggered entrance wrapper — plays once on mount, honors reduced-motion. */
export function FadeIn({ children, i = 0, className }: {
  children: React.ReactNode; i?: 0 | 1 | 2 | 3 | 4; className?: string;
}) {
  return <div className={`ea-rise ${i ? `ea-rise-${i}` : ''} ${className || ''}`}>{children}</div>;
}

/** Tweened numeric value — animates on change only, skips on reduced-motion. */
export function AnimatedNumber({ value, format }: {
  value: number | null; format?: (v: number) => string;
}) {
  const fmt = format || ((v: number) => `${Math.round(v)}`);
  const [display, setDisplay] = useState<number | null>(value);
  const from = useRef<number | null>(value);
  useEffect(() => {
    if (value == null || value === from.current) { setDisplay(value); return; }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches
        || from.current == null) {
      setDisplay(value); from.current = value; return;
    }
    const start = from.current!, delta = value - start, t0 = performance.now(), D = 420;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / D), e = 1 - Math.pow(1 - p, 3);
      setDisplay(start + delta * e);
      if (p < 1) raf = requestAnimationFrame(tick); else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span className="tabular-nums">{display == null ? '—' : fmt(display)}</span>;
}

export const Empty = ({ msg }: { msg: string }) => (
  <p className="mt-4 rounded-lg bg-[#FFFFFF] px-4 py-6 text-center text-[13px] text-[#7FA8CE]">{msg}</p>
);

export const BlockLoading = ({ label = 'Loading' }: { label?: string }) => (
  <div role="status" aria-label={label} className="space-y-3 p-2">
    {[0, 1, 2].map((n) => <div key={n} className="h-14 animate-pulse rounded-lg bg-[#FFFCFA]" />)}
  </div>
);

export function BlockFailure({ msg, retry }: { msg: string; retry: () => void }) {
  return <div role="alert" className="p-8 text-center">
    <AlertTriangle size={18} className="mx-auto text-[#A56514]" />
    <p className="mt-2 text-[13px] text-[#2457A8]">{msg}</p>
    <div className="mt-3"><Button size="sm" variant="outline" onClick={retry}>Retry</Button></div>
  </div>;
}

export function HBar({ label, value, max, color, title }: {
  label: string; value: number; max: number; color: string; title?: string;
}) {
  return <li className="grid grid-cols-[110px_1fr_34px] items-center gap-2" title={title || label}>
    <span className="truncate text-xs text-[#2457A8]">{label}</span>
    <span className="h-1.5 overflow-hidden rounded-full bg-[#FFFCFA]">
      <span className="block h-full rounded-full" style={{ width: `${Math.round(value / Math.max(1, max) * 100)}%`, backgroundColor: color }} />
    </span>
    <span className="text-right text-xs font-semibold tabular-nums text-[#2457A8]">{value}</span>
  </li>;
}

/** Previous-period delta. `invert` = more is worse. Rates pass `unit: 'pp'`. */
export function Delta({ current, previous, invert = false, unit }: {
  current: number | null; previous: number | null;
  invert?: boolean; unit?: 'pp' | 'pct' | 'abs';
}) {
  if (current == null || previous == null) return null;
  const diff = current - previous;
  const col = (d: number) => (invert ? d < 0 : d > 0) ? C.success : C.danger;
  if (unit === 'pp') {
    if (Math.abs(diff) < 0.0005) return <span className="text-[11px] text-[#7FA8CE]">±0 pp</span>;
    return <span className="inline-flex items-center gap-0.5 text-[11px] font-medium" style={{ color: col(diff) }}>
      {diff > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
      {diff > 0 ? '+' : ''}{Math.round(diff * 100)} pp
    </span>;
  }
  if (!diff) return <span className="text-[11px] text-[#7FA8CE]">±0 vs prev</span>;
  const pct = previous !== 0 && unit !== 'abs'
    ? ` (${diff > 0 ? '+' : ''}${Math.round(diff / Math.abs(previous) * 100)}%)` : '';
  return <span className="inline-flex items-center gap-0.5 text-[11px] font-medium" style={{ color: col(diff) }}>
    {diff > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
    {diff > 0 ? '+' : ''}{Math.abs(diff) < 1 && diff % 1 !== 0 ? diff.toFixed(1) : Math.round(diff)}{pct}
  </span>;
}

export const TabBtn = ({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) => (
  <button aria-pressed={active} onClick={onClick}
    className={`rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:outline-[#2457A8] ${
      active ? 'bg-[#2457A8] text-white' : 'text-[#2457A8] hover:bg-white hover:text-[#2457A8]'}`}>
    {children}
  </button>
);

export const STATUS_COLORS: Record<string, string> = {
  present: C.success, absent: C.danger, leave: C.blue, week_off: '#C3D6F0',
  incomplete: C.warning, partial: C.warning,
  completed: C.success, approved: C.success, pending: C.warning,
  disapproved: C.danger, rejected: C.danger, abandoned: C.danger,
  in_progress: C.blue, assigned: C.blue, reopened: C.warning, submitted: C.warning,
  resolved: C.success, closed: C.success, open: C.blue, on_hold: C.warning,
  cancelled: '#C3D6F0', overdue: C.danger,
};

export const pct = (rate: number | null | undefined) =>
  rate == null ? '—' : `${(rate * 100).toFixed(1)}%`;
