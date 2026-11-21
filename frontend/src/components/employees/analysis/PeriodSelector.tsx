import React, { useMemo, useState } from 'react';
import { CalendarDays, ChevronDown } from 'lucide-react';
import { DateBounds } from '../../../api/employees';
import { fmtDateIST, istDateKey, istDateKeyOffset } from '../../../lib/datetime';

export type Preset = 'today' | '7' | '30' | 'this_month' | 'last_month' | 'all' | 'custom';
export interface Period { preset: Preset; bounds: DateBounds; label: string }

const istDay = (key: string) => `${key}T00:00:00+05:30`;
const toIso = (key: string) => new Date(istDay(key)).toISOString();
const excl = (key: string) => new Date(new Date(istDay(key)).getTime() + 86400000).toISOString();
const keyOf = (d: Date) => istDateKey(d);

export function resolvePeriod(preset: Preset, from: string, to: string): Period {
  const today = istDateKey();
  if (preset === 'today')
    return { preset, bounds: { date_from: toIso(today), date_to: excl(today) }, label: 'Today' };
  if (preset === '7' || preset === '30') {
    const n = Number(preset);
    return { preset, bounds: { date_from: toIso(istDateKeyOffset(-(n - 1))), date_to: excl(today) },
      label: `Last ${n} days` };
  }
  if (preset === 'this_month' || preset === 'last_month') {
    const [y, m] = today.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - (preset === 'this_month' ? 1 : 2), 1));
    const start = keyOf(d), end = preset === 'this_month' ? today
      : keyOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
    const label = preset === 'this_month' ? 'This month'
      : `${fmtDateIST(`${start}T00:00:00+05:30`)} – ${fmtDateIST(`${end}T00:00:00+05:30`)}`;
    return { preset, bounds: { date_from: toIso(start), date_to: excl(end) }, label };
  }
  if (preset === 'custom' && from && to && from <= to)
    return { preset, bounds: { date_from: toIso(from), date_to: excl(to) },
      label: `${fmtDateIST(`${from}T00:00:00+05:30`)} – ${fmtDateIST(`${to}T00:00:00+05:30`)}` };
  return { preset, bounds: {}, label: 'All time' };
}

const PRESETS: [Preset, string][] = [
  ['today', 'Today'], ['7', 'Last 7 days'], ['30', 'Last 30 days'],
  ['this_month', 'This month'], ['last_month', 'Last month'], ['all', 'All time'], ['custom', 'Custom'],
];

export function PeriodSelector({ period, onChange }: { period: Period; onChange: (p: Period) => void }) {
  const today = istDateKey();
  const [from, setFrom] = useState(istDateKeyOffset(-29));
  const [to, setTo] = useState(today);
  const [open, setOpen] = useState(false);
  const customValid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)
    && from <= to && to <= today;
  const apply = (f: string, t: string) => {
    if (f && t && f <= t && t <= today) onChange(resolvePeriod('custom', f, t));
  };
  return <nav aria-label="Reporting period" className="relative">
    <button aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((v) => !v)}
      className="flex items-center gap-2 rounded-lg border border-[#EAF1FB] bg-white px-3 py-2 text-xs font-medium text-[#2457A8] hover:border-[#C3D6F0] focus-visible:outline-2 focus-visible:outline-[#2457A8]">
      <CalendarDays size={14} className="text-[#2457A8]" />
      <span>{period.label}</span>
      <ChevronDown size={13} className={`text-[#2457A8] transition ${open ? 'rotate-180' : ''}`} />
    </button>
    {open && <div role="menu" className="absolute right-0 z-30 mt-1 w-72 rounded-lg border border-[#EAF1FB] bg-white p-2 shadow-lg">
      <div className="grid grid-cols-2 gap-1">
        {PRESETS.map(([key, label]) => (
          <button key={key} role="menuitem" aria-pressed={period.preset === key}
            onClick={() => {
              if (key === 'custom') return; // stay open for inputs
              onChange(resolvePeriod(key, from, to)); setOpen(false);
            }}
            className={`rounded-md px-3 py-1.5 text-left text-xs ${period.preset === key ? 'bg-[#2457A8] font-medium text-white' : 'text-[#2457A8] hover:bg-[#FFFFFF]'}`}>
            {label}
          </button>))}
      </div>
      <div className="mt-2 border-t border-[#EAF1FB] pt-2">
        <p className="mb-1.5 px-1 text-[10px] font-medium uppercase tracking-wide text-[#2457A8]">Custom range (IST)</p>
        <div className="flex items-center gap-1.5 px-1">
          <input type="date" aria-label="Start date" value={from} max={to} onChange={(e) => setFrom(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-[#EAF1FB] px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#2457A8]/25" />
          <span className="text-[10px] text-[#2457A8]">to</span>
          <input type="date" aria-label="End date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-[#EAF1FB] px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#2457A8]/25" />
        </div>
        <div className="mt-1.5 flex items-center justify-between px-1">
          {customValid
            ? <span className="text-[10px] text-[#2457A8]">{fmtDateIST(`${from}T00:00:00+05:30`)} – {fmtDateIST(`${to}T00:00:00+05:30`)}</span>
            : <span role="alert" className="text-[10px] text-[#D64545]">{from > to ? 'Start must be on or before end' : 'End cannot be in the future'}</span>}
          <button disabled={!customValid} onClick={() => { apply(from, to); if (customValid) setOpen(false); }}
            className="rounded-md bg-[#2457A8] px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-40">Apply</button>
        </div>
      </div>
    </div>}
  </nav>
}

export const usePeriod = (): [Period, (p: Period) => void] => {
  const [period, setPeriod] = useState<Period>(() => resolvePeriod('30', '', ''));
  return [period, setPeriod];
};

export const daysIn = (bounds: DateBounds) =>
  bounds.date_from && bounds.date_to
    ? Math.round((Date.parse(bounds.date_to) - Date.parse(bounds.date_from)) / 86400000) : null;

export const bucketFor = (bounds: DateBounds): 'day' | 'week' | 'month' => {
  const d = daysIn(bounds);
  if (d == null) return 'month';
  return d <= 45 ? 'day' : d <= 370 ? 'week' : 'month';
};

export const useMemoizedPeriod = useMemo;
