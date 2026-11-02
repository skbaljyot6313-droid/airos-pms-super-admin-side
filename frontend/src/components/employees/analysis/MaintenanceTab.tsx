import React, { useEffect, useRef, useState } from 'react';
import { DateBounds, EmployeeAnalytics, EmployeePage, EmployeeRecord, getEmployeeAnalytics, getEmployeeRecords } from '../../../api/employees';
import { fmtAuditDateTimeIST, fmtDateTimeIST } from '../../../lib/datetime';
import { MAINTENANCE_STATUS_LABELS } from '../../../lib/maintenanceUtils';
import { duration } from '../EmployeeDetailView';
import { Button } from '../../ui/Button';
import { Panel, BlockLoading, BlockFailure, Empty, HBar, C, pct } from './kit';
import { bucketFor, Period } from './PeriodSelector';

function MaintenanceHistory({ employeeId, propertyId, bounds }: { employeeId: string; propertyId: string; bounds: DateBounds }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<EmployeePage<EmployeeRecord> | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const id = useRef(0);
  useEffect(() => setPage(1), [bounds.date_from, bounds.date_to]);
  useEffect(() => {
    const rid = ++id.current;
    setLoading(true); setError(false);
    void getEmployeeRecords(employeeId, propertyId, 'maintenance', page, bounds)
      .then((d) => { if (rid === id.current) setData(d); })
      .catch(() => { if (rid === id.current) setError(true); })
      .finally(() => { if (rid === id.current) setLoading(false); });
    return () => { id.current += 1; };
  }, [employeeId, propertyId, page, bounds.date_from, bounds.date_to, retry]);
  if (loading) return <BlockLoading label="Loading maintenance history" />;
  if (error) return <BlockFailure msg="Unable to load maintenance history." retry={() => setRetry((v) => v + 1)} />;
  if (!data?.items.length) return <Empty msg="No maintenance tickets allocated in this period." />;
  return <>
    <ul className="mt-3 space-y-1.5">{data.items.map((r) => (
      <li key={String(r.record_uid)} className="rounded-md border border-[#E9EDF2] p-3 text-[11px]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold text-[#17212B]">{String(r.issue || r.maintenance_type || 'Ticket')}</span>
          <span className="rounded bg-[#F1F3F6] px-1.5 py-0.5 text-[10px] font-medium text-[#697586]">{MAINTENANCE_STATUS_LABELS[String(r.status) as keyof typeof MAINTENANCE_STATUS_LABELS] || String(r.status)}</span>
        </div>
        <p className="mt-0.5 text-[#697586]">
          {r.ticket_number ? `#${r.ticket_number}` : ''}{r.maintenance_type ? ` · ${r.maintenance_type}` : ''}
          {r.property_name ? ` · ${r.property_name}` : ''}{r.assigned_to_name ? ` · assigned to ${r.assigned_to_name}` : ''}
        </p>
        <p className="mt-0.5 text-[10px] text-[#697586]">
          Created {r.created_at ? fmtDateTimeIST(String(r.created_at)) : '—'}
          {r.resolved_at ? ` · resolved ${fmtDateTimeIST(String(r.resolved_at))}` : ''}
          {r.closed_at ? ` · closed ${fmtDateTimeIST(String(r.closed_at))}` : ''}
        </p>
      </li>))}
    </ul>
    {data.total > data.limit && <div className="flex items-center justify-between border-t border-[#E9EDF2] px-1 pt-2 text-xs text-[#697586]">
      <span>{data.total} tickets</span>
      <span className="flex gap-1">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</Button>
        <Button size="sm" variant="ghost" disabled={page * data.limit >= data.total} onClick={() => setPage((p) => p + 1)}>Next</Button>
      </span>
    </div>}
  </>;
}

export function MaintenanceTab({ employeeId, propertyId, period }: {
  employeeId: string; propertyId: string; period: Period;
}) {
  const [data, setData] = useState<EmployeeAnalytics | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const id = useRef(0);
  useEffect(() => {
    const rid = ++id.current;
    setLoading(true); setError(false);
    void getEmployeeAnalytics(employeeId, propertyId, period.bounds, bucketFor(period.bounds))
      .then((d) => { if (rid === id.current) setData(d); })
      .catch(() => { if (rid === id.current) setError(true); })
      .finally(() => { if (rid === id.current) setLoading(false); });
    return () => { id.current += 1; };
  }, [employeeId, propertyId, period.bounds, retry]);

  if (loading) return <BlockLoading label="Loading maintenance" />;
  if (error || !data) return <BlockFailure msg="Unable to load maintenance analytics." retry={() => setRetry((v) => v + 1)} />;
  const m = data.maintenance;
  const zones = Object.entries(m.by_zone).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return <div className="grid gap-4 lg:grid-cols-2">
    <Panel title="Maintenance contribution"
      note="Ledger-attributed tickets — separate from routine tasks. 'Resolved' counts tickets the employee was allocated to that are now resolved/closed; resolution authorship isn't independently recorded.">
      <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {[['Allocated', m.allocated], ['Resolved/closed', m.resolved], ['Still open', m.open],
          ['Reassigned away', m.reassigned_away], ['Currently assigned', m.currently_assigned],
          ['Resolution rate', pct(m.resolution_rate)]].map(([l, v]) => (
          <li key={l as string} className="rounded-md border border-[#E9EDF2] py-2 text-center">
            <p className="text-base font-semibold tabular-nums text-[#17212B]">{v}</p>
            <p className="text-[10px] text-[#697586]">{l}</p></li>))}
      </ul>
      <p className="mt-3 text-[11px] text-[#697586]">
        Median resolution time (ticket created → resolved): {m.median_resolution_seconds != null ? duration(m.median_resolution_seconds) : '—'}
      </p>
      {zones.length > 0 && <div className="mt-3 border-t border-[#E9EDF2] pt-3">
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[#697586]">Allocated tickets by zone</p>
        <ul className="space-y-2">{zones.map(([z, n]) => <HBar key={z} label={z} value={n} max={zones[0][1]} color={C.warning} />)}</ul>
      </div>}
    </Panel>
    <Panel title="Maintenance history" note={`${fmtAuditDateTimeIST(period.bounds.date_from || '') !== '—' ? period.label : 'All time'} · newest first`}>
      <MaintenanceHistory employeeId={employeeId} propertyId={propertyId} bounds={period.bounds} />
    </Panel>
  </div>;
}
