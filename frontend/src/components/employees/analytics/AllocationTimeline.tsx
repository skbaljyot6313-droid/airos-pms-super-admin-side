import React, { useEffect, useRef, useState } from 'react';
import { DateBounds, EmployeePage, EmployeeRecord, getEmployeeRecords } from '../../../api/employees';
import { fmtDateTimeIST, fmtDateIST, fmtTimeIST } from '../../../lib/datetime';
import { Button } from '../../ui/Button';
import { card } from '../analysis/kit';

const NAVY = '#2457A8', GREEN = '#800020', AMBER = '#A56514', BLUE = '#3478D4', RED = '#D64545', MUTED = '#7FA8CE', BORDER = '#EAF1FB', TRACK = '#EAF1FB';

type Dir = 'all' | 'received' | 'away';
type Kind = 'all' | 'task' | 'maintenance';

interface Lifecycle {
  kind: 'task' | 'maintenance';
  current_status: string;
  submitted_at?: string | null; submitted_by?: string | null;
  submission_status?: string | null; reviewed_at?: string | null; reviewed_by?: string | null;
  completed_at?: string | null; abandoned_at?: string | null;
  admin_closed_by?: string | null; admin_closed_at?: string | null;
  assigned_to?: string | null; resolved_at?: string | null; closed_at?: string | null;
}

interface Stage { label: string; state: 'done' | 'current' | 'pending'; color: string; actor?: string }

function workflow(l: Lifecycle): { stages: Stage[]; outcome: { label: string; color: string } } {
  if (l.kind === 'maintenance') {
    const st = l.current_status;
    const cancelled = st === 'cancelled';
    const resolved = !!l.resolved_at || st === 'resolved' || st === 'closed';
    const inProg = resolved || st === 'in_progress' || st === 'on_hold';
    const closed = st === 'closed' || cancelled;
    const open = !resolved && !closed;
    const reached = [true, inProg, resolved, closed];
    const nextIdx = reached.findIndex((r) => !r);
    const steps: [string, string, string?][] = [
      ['Allocated', NAVY, l.assigned_to ? `assigned to ${l.assigned_to}` : undefined],
      ['In progress', BLUE, undefined],
      ['Resolved', GREEN, l.resolved_at ? fmtDateTimeIST(l.resolved_at) : undefined],
      [cancelled ? 'Cancelled' : 'Closed', cancelled ? RED : GREEN, l.closed_at ? fmtDateTimeIST(l.closed_at) : undefined]];
    return { stages: steps.map(([label, color, actor], i) => ({
      label, color, actor,
      state: reached[i] ? 'done' : open && i === nextIdx ? 'current' : 'pending' })),
      outcome: cancelled ? { label: 'Cancelled', color: RED }
        : st === 'closed' ? { label: 'Closed', color: GREEN }
        : resolved ? { label: 'Resolved', color: GREEN } : { label: 'Open', color: AMBER } };
  }
  const submitted = !!l.submitted_at;
  const decided = l.submission_status === 'approved' || l.submission_status === 'disapproved';
  const redo = l.submission_status === 'disapproved';
  const abandoned = !!l.abandoned_at || l.current_status === 'abandoned';
  const completed = l.current_status === 'completed' || !!l.completed_at;
  // Staff-side close bypasses submit→review — never imply an approval happened.
  const staffClosed = completed && !!l.admin_closed_by && l.submission_status !== 'approved';
  const open = !completed && !abandoned;
  const reached = [true, submitted, decided, completed || abandoned];
  const nextIdx = reached.findIndex((r) => !r);
  const reviewLabel = decided ? (redo ? 'Sent for redo' : 'Approved')
    : staffClosed ? 'No review' : abandoned ? 'Not reviewed' : 'Awaiting review';
  const steps: [string, string, string?][] = [
    ['Allocated', NAVY, undefined],
    ['Submitted', BLUE, l.submitted_by ? `by ${l.submitted_by}` : undefined],
    [reviewLabel, redo ? AMBER : GREEN, l.reviewed_by ? `by ${l.reviewed_by}` : undefined],
    [abandoned ? 'Abandoned' : staffClosed ? 'Closed by staff' : 'Completed',
      abandoned ? RED : staffClosed ? NAVY : GREEN,
      staffClosed
        ? `by ${l.admin_closed_by}${l.admin_closed_at ? ` · ${fmtDateTimeIST(l.admin_closed_at)}` : ''}`
        : (completed && l.completed_at) ? fmtDateTimeIST(l.completed_at)
        : (abandoned && l.abandoned_at) ? fmtDateTimeIST(l.abandoned_at) : undefined]];
  return { stages: steps.map(([label, color, actor], i) => ({
    label, color, actor,
    state: reached[i] ? 'done' : open && i === nextIdx ? 'current' : 'pending' })),
    outcome: abandoned
        ? { label: submitted && !decided ? 'Abandoned before review' : 'Abandoned', color: RED }
      : staffClosed ? { label: 'Closed by staff', color: NAVY }
      : completed ? { label: 'Completed', color: GREEN }
      : redo ? { label: 'Redo requested', color: AMBER }
      : l.submission_status === 'pending' ? { label: 'Pending review', color: AMBER }
      : { label: 'Open', color: AMBER } };
}

function Stepper({ lifecycle }: { lifecycle: Lifecycle }) {
  const { stages, outcome } = workflow(lifecycle);
  return <div className="min-w-[220px]">
    <div className="flex items-center" role="img"
      aria-label={`Progress: ${stages.map((s) => `${s.label} ${s.state}`).join(', ')} — ${outcome.label}`}>
      {stages.map((s, i) => <React.Fragment key={s.label}>
        {i > 0 && <span className="h-px flex-1" style={{ backgroundColor: s.state === 'done' || stages[i - 1].state === 'done' ? BORDER : TRACK }} />}
        <span className="flex h-2 w-2 flex-none rounded-full"
          style={s.state === 'done' ? { backgroundColor: s.color }
            : s.state === 'current' ? { border: `2px solid ${s.color}` }
            : { border: '2px solid #C3D6F0' }} />
      </React.Fragment>)}
    </div>
    <div className="mt-1.5 flex">
      {stages.map((s) => <div key={s.label} className="flex-1 first:text-left text-center last:text-right">
        <p className="text-[9px] font-medium leading-tight"
          style={{ color: s.state === 'done' ? s.color : s.state === 'current' ? s.color : '#C3D6F0' }}>{s.label}</p>
        {s.actor && s.state !== 'pending' && <p className="text-[9px] leading-tight text-[#7FA8CE]">{s.actor}</p>}
      </div>)}
    </div>
    <p className="mt-1 text-right">
      <span className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
        style={{ color: outcome.color, backgroundColor: `${outcome.color}14` }}>{outcome.label}</span>
    </p>
  </div>;
}

export function AllocationTimeline({ employeeId, propertyId, bounds }: {
  employeeId: string; propertyId: string; bounds: DateBounds;
}) {
  const [dir, setDir] = useState<Dir>('all');
  const [kind, setKind] = useState<Kind>('all');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<EmployeePage<EmployeeRecord> | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const id = useRef(0);
  useEffect(() => setPage(1), [dir, kind, bounds.date_from, bounds.date_to]);
  useEffect(() => {
    const rid = ++id.current;
    setLoading(true); setError(false);
    void getEmployeeRecords(employeeId, propertyId, 'allocations', page, bounds,
      { direction: dir === 'all' ? undefined : dir, ticket_kind: kind === 'all' ? undefined : kind })
      .then((d) => { if (rid === id.current) setData(d); })
      .catch(() => { if (rid === id.current) setError(true); })
      .finally(() => { if (rid === id.current) setLoading(false); });
    return () => { id.current += 1; };
  }, [employeeId, propertyId, page, dir, kind, bounds.date_from, bounds.date_to, retry]);

  const pill = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-150 ${
      active ? 'border-[#2457A8] bg-[#2457A8] text-white' : 'border-[#EAF1FB] text-[#2457A8] hover:border-[#C3D6F0] hover:text-[#2457A8]'}`;

  return <section aria-label="Allocation history" className={card}>
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#EAF1FB] p-5">
      <div>
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[#2457A8]">Allocation History</h2>
        <p className="mt-0.5 text-xs text-[#7FA8CE]">Complete chronological record of task assignments and transfers · newest first</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Allocation filters">
        {([['all', 'All'], ['task', 'Tasks'], ['maintenance', 'Maintenance']] as [Kind, string][]).map(([k, l]) => (
          <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)} className={pill(kind === k)}>{l}</button>))}
        <span className="mx-1 h-4 w-px bg-[#EAF1FB]" />
        {([['all', 'All direction'], ['received', 'Assigned to employee'], ['away', 'Reassigned away']] as [Dir, string][]).map(([k, l]) => (
          <button key={k} aria-pressed={dir === k} onClick={() => setDir(k)} className={pill(dir === k)}>{l}</button>))}
      </div>
    </div>
    {loading ? <div role="status" className="space-y-3 p-6">{[0, 1, 2].map((n) => <div key={n} className="h-16 animate-pulse rounded-lg bg-[#FFFCFA]" />)}</div>
      : error ? <div role="alert" className="p-8 text-center"><p className="text-[13px] text-[#2457A8]">Unable to load allocation history.</p><div className="mt-3"><Button size="sm" variant="outline" onClick={() => setRetry((v) => v + 1)}>Retry</Button></div></div>
      : !data?.items.length ? <p className="p-10 text-center text-[13px] text-[#7FA8CE]">No allocation records for these filters.</p>
      : <ol className="relative ml-6 space-y-0 border-l border-[#EAF1FB] px-0">
        {data.items.map((r) => {
          const away = r.previous_employee_uid === employeeId;
          const isMaint = r.ticket_kind === 'maintenance';
          const dot = away ? AMBER : isMaint ? BLUE : GREEN;
          const who = away
            ? `Reassigned away${r.employee_name ? ` → ${r.employee_name}` : ''}`
            : `${r.previous_employee_name ? `Reassigned: ${r.previous_employee_name} → ` : 'Assigned to '}${r.employee_name || 'unknown'}`;
          return <li key={String(r.record_uid)} className="relative border-b border-[#FFFCFA] px-6 py-4 transition-colors duration-150 last:border-0 hover:bg-[#FFFFFF]">
            <span className="absolute -left-[9px] top-6 h-2.5 w-2.5 rounded-full border-2 border-white" style={{ backgroundColor: dot }} />
            <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
              {/* LEFT — timestamp */}
              <div className="w-24 flex-none pt-0.5">
                <p className="text-xs font-semibold text-[#2457A8]">{r.created_at ? fmtDateIST(String(r.created_at)) : '—'}</p>
                <p className="text-[11px] text-[#7FA8CE]">{r.created_at ? fmtTimeIST(String(r.created_at)) : 'Time not recorded'}</p>
              </div>
              {/* CENTER — event detail */}
              <div className="min-w-[220px] flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[13px] font-semibold text-[#2457A8]">{who}</span>
                  <span className="rounded-md bg-[#FFFCFA] px-1.5 py-0.5 text-[10px] font-medium" style={{ color: isMaint ? BLUE : NAVY }}>{isMaint ? 'Maintenance' : 'Task'}</span>
                  {r.ticket_number ? <span className="text-[11px] tabular-nums text-[#7FA8CE]">#{String(r.ticket_number)}</span> : null}
                </div>
                <p className="mt-1 text-xs text-[#2457A8]">
                  {[r.allocation_method && String(r.allocation_method).replace(/_/g, ' '),
                    r.actor_name && `by ${String(r.actor_name)}`,
                    r.reason && String(r.reason),
                    r.property_name && String(r.property_name)].filter(Boolean).join(' · ')}
                </p>
              </div>
              {/* RIGHT — workflow */}
              <div className="flex-none lg:w-[280px]">
                {r.lifecycle ? <Stepper lifecycle={r.lifecycle as unknown as Lifecycle} />
                  : <span className="text-[11px] text-[#C3D6F0]">No lifecycle data</span>}
              </div>
            </div>
          </li>;
        })}
      </ol>}
    {data && data.total > data.items.length && <div className="flex items-center justify-between border-t border-[#EAF1FB] px-5 py-3 text-xs text-[#2457A8]">
      <span>{data.total} records · page {page} of {Math.ceil(data.total / data.limit)}</span>
      <span className="flex gap-1">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</Button>
        <Button size="sm" variant="ghost" disabled={page * data.limit >= data.total} onClick={() => setPage((p) => p + 1)}>Next</Button>
      </span>
    </div>}
  </section>;
}
