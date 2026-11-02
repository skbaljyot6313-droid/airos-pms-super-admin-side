import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { getTeamAnalytics, TeamAnalytics, TeamAnalyticsRow } from '../../../api/employees';
import { useApp } from '../../../context/AppContext';
import { C, Empty, BlockLoading, BlockFailure, card, pct } from './kit';
import { PeriodSelector, usePeriod } from './PeriodSelector';

type SortKey = 'allocated' | 'completed' | 'abandoned' | 'open' | 'completion_rate' | 'name';

export function TeamAnalyticsTab() {
  const { activeProperty, navigate } = useApp();
  const propertyId = activeProperty?.property_uid || '';
  const [period, setPeriod] = usePeriod();
  const [data, setData] = useState<TeamAnalytics | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [sort, setSort] = useState<SortKey>('allocated');
  const [asc, setAsc] = useState(false);
  const id = useRef(0);

  useEffect(() => {
    if (!propertyId) return;
    const rid = ++id.current;
    setLoading(true); setError(false);
    void getTeamAnalytics(propertyId, period.bounds)
      .then((d) => { if (rid === id.current) setData(d); })
      .catch(() => { if (rid === id.current) setError(true); })
      .finally(() => { if (rid === id.current) setLoading(false); });
    return () => { id.current += 1; };
  }, [propertyId, period.bounds, retry]);

  const sortBy = (k: SortKey) => {
    if (sort === k) setAsc((v) => !v); else { setSort(k); setAsc(k === 'name'); }
  };
  const rows = [...(data?.employees || [])].sort((a, b) => {
    const av = a[sort], bv = b[sort];
    const cmp = typeof av === 'string' || av == null || bv == null
      ? String(av || '').localeCompare(String(bv || ''))
      : (av as number) - (bv as number);
    return asc ? cmp : -cmp;
  });

  const Th = ({ k, label, className }: { k: SortKey; label: string; className?: string }) => (
    <th className={`px-3 py-2.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-[#98A2B3] ${className || ''}`}>
      <button onClick={() => sortBy(k)} className="inline-flex items-center gap-0.5 hover:text-[#17212B]">
        {label}{sort === k && (asc ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
      </button>
    </th>);

  const team = data?.team;
  const teamRate = team && team.allocated ? team.completed / team.allocated : null;
  const cols: [string, number][] = [
    ['Allocated', team?.allocated ?? 0], ['Completed', team?.completed ?? 0],
    ['Abandoned', team?.abandoned ?? 0], ['Open now', team?.open ?? 0]];
  const activeCount = data?.employees.filter((e) => e.allocated > 0).length || 0;

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-[16px] font-semibold tracking-[-0.01em] text-[#17212B]">Team performance</h2>
        <p className="mt-0.5 text-xs text-[#98A2B3]">Workload and completion across all staff · {data?.total ?? 0} employees</p>
      </div>
      <PeriodSelector period={period} onChange={setPeriod} />
    </div>

    {loading ? <BlockLoading label="Loading team analytics" />
      : error ? <div className={card}><BlockFailure msg="Unable to load team analytics." retry={() => setRetry((v) => v + 1)} /></div>
      : !data?.employees.length ? <div className={card}><Empty msg="No employees on this property." /></div>
      : <>
        {/* Team summary strip */}
        <div role="list" aria-label="Team metrics" className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {cols.map(([l, v]) => <div role="listitem" key={l} className={`${card} px-5 py-4`}>
            <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-[#98A2B3]">{l}</p>
            <p className="mt-1.5 text-[28px] font-semibold leading-none tabular-nums text-[#17212B]">{v}</p>
          </div>)}
          <div role="listitem" className={`${card} px-5 py-4`} title="Team completed ÷ allocated">
            <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-[#98A2B3]">Completion rate</p>
            <p className="mt-1.5 text-[28px] font-semibold leading-none tabular-nums text-[#17212B]">{pct(teamRate)}</p>
          </div>
        </div>

        {/* Per-employee table */}
        <section aria-label="Employee performance table" className={`${card} overflow-hidden`}>
          <div className="flex items-center justify-between border-b border-[#E9EDF2] px-5 py-3.5">
            <p className="text-[13px] font-semibold text-[#17212B]">By employee
              <span className="ml-2 text-xs font-normal text-[#98A2B3]">{activeCount} of {data.total} allocated work · sorted by {sort}</span></p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left">
              <thead><tr className="border-b border-[#E9EDF2] bg-[#FAFBFC]">
                <Th k="name" label="Employee" />
                <th className="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-[#98A2B3]">Zone</th>
                <Th k="allocated" label="Allocated" />
                <Th k="completed" label="Done" />
                <Th k="abandoned" label="Aband." />
                <Th k="open" label="Open" />
                <Th k="completion_rate" label="Rate" />
                <th className="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-[#98A2B3]">Share</th>
              </tr></thead>
              <tbody>{rows.map((e: TeamAnalyticsRow) => {
                const share = team && team.allocated ? e.allocated / team.allocated : 0;
                return <tr key={e.employee_uid}
                  className="border-b border-[#F1F3F6] transition-colors last:border-0 hover:bg-[#FAFBFC] cursor-pointer"
                  onClick={() => navigate(`/property/${propertyId}/employees/${e.employee_uid}`)}>
                  <td className="px-3 py-2.5">
                    <p className="text-[13px] font-medium text-[#17212B]">{e.name}</p>
                    <p className="text-[10px] text-[#98A2B3]">{e.job_title || 'Employee'}{e.status && e.status !== 'Active' ? ` · ${e.status}` : ''}</p>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-[#697586]">{e.zone_name || '—'}</td>
                  <td className="px-3 py-2.5 text-[13px] font-semibold tabular-nums text-[#17212B]">{e.allocated}</td>
                  <td className="px-3 py-2.5 text-[13px] tabular-nums text-[#17212B]">{e.completed}</td>
                  <td className="px-3 py-2.5 text-[13px] tabular-nums" style={{ color: e.abandoned > 0 ? C.danger : C.faint }}>{e.abandoned}</td>
                  <td className="px-3 py-2.5 text-[13px] tabular-nums text-[#17212B]">{e.open}</td>
                  <td className="px-3 py-2.5 text-[13px] tabular-nums" style={{ color: e.completion_rate != null ? (e.completion_rate >= 0.7 ? C.success : e.completion_rate < 0.3 ? C.danger : C.text) : C.faint }}>
                    {pct(e.completion_rate)}</td>
                  <td className="w-32 px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#F1F3F6]">
                        <span className="block h-full rounded-full bg-[#6686A0]" style={{ width: `${Math.round(share * 100)}%` }} /></span>
                      <span className="text-[10px] tabular-nums text-[#98A2B3]">{Math.round(share * 100)}%</span>
                    </div>
                  </td>
                </tr>; })}
              </tbody>
            </table>
          </div>
        </section>
        <p className="text-[11px] text-[#98A2B3]">
          Allocated = distinct tasks via ledger or current assignment · Completed = approved submissions ·
          Abandoned = last assignee before abandonment · Open = current point-in-time (not period-bound) ·
          Rate = completed ÷ allocated. Click a row to open the employee's full analysis.
        </p>
      </>}
  </div>;
}
