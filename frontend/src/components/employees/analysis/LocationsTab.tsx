import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, MapPin, Wrench } from 'lucide-react';
import { EmployeeLocations, getEmployeeLocations, LocationTasks, LocationZone } from '../../../api/employees';
import { BlockLoading, BlockFailure, Empty } from './kit';
import { Period } from './PeriodSelector';

const STATS: [string, (t: LocationTasks) => string][] = [
  ['Allocated', (t) => `${t.allocated}`], ['Completed', (t) => `${t.completed}`],
  ['Abandoned', (t) => `${t.abandoned}`], ['Open', (t) => `${t.open}`],
  ['Completion', (t) => t.completion_rate == null ? '—' : `${Math.round(t.completion_rate * 100)}%`]];

const StatRow = ({ t, subtle }: { t: LocationTasks; subtle?: boolean }) => (
  <div className="ml-auto flex items-baseline gap-6">
    {STATS.map(([l, f]) => <span key={l} className="flex items-baseline gap-1.5">
      <b className={`tabular-nums text-[13px] ${subtle ? 'font-medium' : 'font-semibold'} text-[#2457A8]`}>{f(t)}</b>
      <span className="text-[10px] text-[#7FA8CE]">{l}</span></span>)}
  </div>);

export function ZoneBlock({ zone }: { zone: LocationZone }) {
  const [open, setOpen] = useState(false);
  const [openAreas, setOpenAreas] = useState<Record<string, boolean>>({});
  const m = zone.maintenance;
  return <li className="overflow-hidden rounded-lg border border-[#EAF1FB] transition-colors hover:border-[#C3D6F0]">
    <button aria-expanded={open} onClick={() => setOpen((v) => !v)} disabled={!zone.areas.length}
      className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors duration-150 hover:bg-[#FFFFFF] disabled:cursor-default disabled:hover:bg-transparent">
      {zone.areas.length
        ? <span className={`flex h-5 w-5 items-center justify-center rounded-md text-[#2457A8] transition-transform duration-200 ${open ? 'rotate-180' : ''}`}><ChevronDown size={14} /></span>
        : <span className="w-5" />}
      <span className="flex items-center gap-2 text-[13px] font-semibold text-[#2457A8]">
        <MapPin size={14} className="text-[#2457A8]" />{zone.name}</span>
      <StatRow t={zone.tasks} />
      {m.allocated > 0 && <span className="flex items-center gap-1 rounded-md bg-[#FFFFFF] px-2 py-0.5 text-[10px] text-[#2457A8]" title="Maintenance tickets allocated · resolved">
        <Wrench size={10} />{m.allocated} maint · {m.resolved} resolved</span>}
    </button>
    {open && <ul className="border-t border-[#EAF1FB] bg-[#FFFFFF] px-4 py-2">
      {zone.areas.map((a) => <li key={a.name}>
        <button aria-expanded={!!openAreas[a.name]} onClick={() => setOpenAreas((s) => ({ ...s, [a.name]: !s[a.name] }))} disabled={!a.units.length}
          className="flex w-full items-center gap-3 py-2.5 pl-8 text-left disabled:cursor-default">
          {a.units.length ? (openAreas[a.name] ? <ChevronDown size={13} className="text-[#7FA8CE]" /> : <ChevronRight size={13} className="text-[#7FA8CE]" />) : <span className="w-[13px]" />}
          <span className="text-xs font-medium text-[#2457A8]">{a.name}</span>
          <StatRow t={a.tasks} subtle />
        </button>
        {openAreas[a.name] && <ul className="pb-2 pl-[52px] pr-1">
          {a.units.map((u) => <li key={`${u.kind}:${u.label}`} className="flex items-center gap-3 py-1.5">
            <span className="flex-none rounded bg-[#FFFCFA] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-[#2457A8]">{u.kind}</span>
            <span className="text-xs text-[#2457A8]">{u.label}</span>
            <StatRow t={u.tasks} subtle />
          </li>)}
        </ul>}
      </li>)}
    </ul>}
  </li>;
}

/** Fetch state for the location hierarchy — used inside the workload section. */
export function useEmployeeLocations(employeeId: string, propertyId: string, period: Period) {
  const [data, setData] = useState<EmployeeLocations | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const id = useRef(0);
  useEffect(() => {
    const rid = ++id.current;
    setLoading(true); setError(false);
    void getEmployeeLocations(employeeId, propertyId, period.bounds)
      .then((d) => { if (rid === id.current) setData(d); })
      .catch(() => { if (rid === id.current) setError(true); })
      .finally(() => { if (rid === id.current) setLoading(false); });
    return () => { id.current += 1; };
  }, [employeeId, propertyId, period.bounds, retry]);
  return { data, loading, error, retry: () => setRetry((v) => v + 1) };
}

export function LocationTree({ employeeId, propertyId, period }: {
  employeeId: string; propertyId: string; period: Period;
}) {
  const { data, loading, error, retry } = useEmployeeLocations(employeeId, propertyId, period);
  if (loading) return <BlockLoading label="Loading location workload" />;
  if (error) return <BlockFailure msg="Unable to load location workload." retry={retry} />;
  if (!data?.zones.length) return <Empty msg="No allocated work with a location in this period." />;
  return <ul className="mt-3 space-y-2">{data.zones.map((z) => <ZoneBlock key={z.name} zone={z} />)}</ul>;
}
