import React, { useCallback, useEffect, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { ApiError, apiFetch } from '../../api/client';
import { payrollApi, type HalfDayGroup, type PayrollPeriodView } from '../../api/payroll';

const thisMonth = () => new Date().toISOString().slice(0, 7);

const money = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const SalariesView: React.FC = () => {
  const { activePropertyUid, currentUser } = useApp();
  const isSuper = currentUser?.role === 'super_admin';
  const [period, setPeriod] = useState(thisMonth);
  const [view, setView] = useState<PayrollPeriodView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openLine, setOpenLine] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activePropertyUid) return;
    try {
      setView(await payrollApi.getPeriod(activePropertyUid, period));
      setError(null);
    } catch (err) {
      setView(null);
      setError(err instanceof ApiError && err.status === 404
        ? 'No payroll generated for this month yet.'
        : err instanceof ApiError ? err.message : 'Could not load payroll.');
    }
  }, [activePropertyUid, period]);

  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<PayrollPeriodView>) => {
    setBusy(true);
    setError(null);
    try {
      setView(await fn());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  };

  const openSlip = async (lineUid: string) => {
    try {
      const blob = await apiFetch<Blob>(`/payroll/lines/${lineUid}/slip.pdf`, { responseType: 'blob' });
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not download the slip.');
    }
  };

  const downloadCsv = async () => {
    try {
      const blob = await apiFetch<Blob>(`/payroll/periods/${period}/export.csv`, {
        query: { property_uid: activePropertyUid }, responseType: 'blob',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `payroll-${period}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not export payroll.');
    }
  };

  const decide = async (g: HalfDayGroup, decision: 'cl' | 'lop') => {
    setBusy(true);
    setError(null);
    try {
      await payrollApi.decideGroup(g.group_uid, decision);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Decision failed.');
    } finally {
      setBusy(false);
    }
  };

  const markPaidWithDetails = async () => {
    const method = window.prompt('Payment method (e.g. bank_transfer, upi, cash):', 'bank_transfer');
    if (method === null) return;
    const reference = window.prompt('Payment reference / batch (optional):') ?? '';
    await run(() => payrollApi.markPaid(activePropertyUid, period, {
      payment_method: method || undefined, payment_reference: reference || undefined,
    }));
  };

  const totals = (view?.lines ?? []).reduce(
    (t, l) => ({
      gross: t.gross + Number(l.gross),
      ded: t.ded + Number(l.total_deductions),
      net: t.net + Number(l.net),
      review: t.review + (l.status === 'needs_review' ? 1 : 0),
    }),
    { gross: 0, ded: 0, net: 0, review: 0 },
  );
  const status = view?.status ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-display text-[15px] font-semibold text-[#17221B]">Salaries — payroll</h2>
        <input
          type="month"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="px-2 py-1.5 rounded-[7px] border border-[#E9E4DA] text-[13px]"
        />
        {status && <span className="text-[12px] uppercase tracking-wide text-[#66706A]">{status}</span>}
      </div>

      <div className="flex flex-wrap gap-2">
        <button disabled={busy} onClick={() => run(() => payrollApi.generate(activePropertyUid, period))}
          className="px-3 py-1.5 rounded-[8px] border border-[#DDD7CB] text-[13px]">
          {view ? 'Recalculate open lines' : 'Generate payroll'}
        </button>
        <button disabled={busy || status !== 'open'} onClick={() => run(() => payrollApi.submit(activePropertyUid, period))}
          className="px-3 py-1.5 rounded-[8px] border border-[#DDD7CB] text-[13px] disabled:opacity-40">
          Submit for approval
        </button>
        {isSuper && (
          <button disabled={busy || status !== 'submitted' || totals.review > 0}
            onClick={() => run(() => payrollApi.approve(activePropertyUid, period))}
            className="px-3 py-1.5 rounded-[8px] bg-[#2F6B45] text-white text-[13px] disabled:opacity-40">
            Approve &amp; freeze
          </button>
        )}
        {isSuper && (
          <button disabled={busy || status !== 'approved'} onClick={markPaidWithDetails}
            className="px-3 py-1.5 rounded-[8px] border border-[#2F6B45] text-[#2F6B45] text-[13px] disabled:opacity-40">
            Mark as paid
          </button>
        )}
        {view && (
          <button onClick={downloadCsv}
            className="px-3 py-1.5 rounded-[8px] border border-[#DDD7CB] text-[13px]">
            Export CSV
          </button>
        )}
      </div>

      {view && view.half_day_groups.length > 0 && (
        <section className="rounded-[10px] border border-[#E4D9C4] bg-[#FDFAF3] p-3">
          <h3 className="text-[13px] font-semibold text-[#4B4630] mb-2">
            Half-day conversions (every 3 half-days → 1 CL or 1 day LOP)
          </h3>
          <ul className="space-y-1.5 text-[13px]">
            {view.half_day_groups.map((g) => (
              <li key={g.group_uid} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{g.employee_name}</span>
                <span className="text-[#8A918C]">group {g.group_index + 1} · {g.dates.join(', ')}</span>
                {g.decision === null || g.decision === 'cl_short' ? (
                  isSuper ? (
                    <>
                      <button disabled={busy} onClick={() => decide(g, 'cl')}
                        className="px-2 py-0.5 rounded-[6px] border border-[#2F6B45] text-[#2F6B45] disabled:opacity-40">
                        Deduct 1 CL
                      </button>
                      <button disabled={busy} onClick={() => decide(g, 'lop')}
                        className="px-2 py-0.5 rounded-[6px] border border-[#A23B3B] text-[#A23B3B] disabled:opacity-40">
                        Apply 1 day LOP
                      </button>
                    </>
                  ) : (
                    <span className="text-[#A23B3B]">Pending decision</span>
                  )
                ) : (
                  <span className="text-[#66706A]">
                    {g.decision === 'cl' ? '→ 1 CL consumed' : '→ 1 day LOP'}
                    {g.decided_by ? ` by ${g.decided_by}` : ''}
                  </span>
                )}
                {g.decision === 'cl_short' && (
                  <span className="text-[#A23B3B]">CL balance insufficient ({g.cl_balance_at_decision}) — choose LOP or top up CL</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && <p role="alert" className="text-[13px] text-[#A23B3B]">{error}</p>}

      {view && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[13px]">
            <div><div className="text-[#66706A]">Gross</div><div className="font-semibold">₹ {money(totals.gross)}</div></div>
            <div><div className="text-[#66706A]">Deductions</div><div className="font-semibold">₹ {money(totals.ded)}</div></div>
            <div><div className="text-[#66706A]">Net payable</div><div className="font-semibold">₹ {money(totals.net)}</div></div>
            <div><div className="text-[#66706A]">Needs review</div><div className="font-semibold">{totals.review}</div></div>
          </div>

          <table className="w-full text-[13px]">
            <thead className="text-left text-[#66706A]">
              <tr><th className="py-1">Employee</th><th>Status</th><th className="text-right">Gross</th>
                <th className="text-right">Deductions</th><th className="text-right">Net</th><th /></tr>
            </thead>
            <tbody>
              {view.lines.map((l) => (
                <React.Fragment key={l.line_uid}>
                  <tr className="border-t border-[#EEEAE1]">
                    <td className="py-1.5">
                      <button className="text-left hover:underline" onClick={() => setOpenLine(openLine === l.line_uid ? null : l.line_uid)}>
                        {l.employee_name}
                      </button>
                    </td>
                    <td>{l.status.replace('_', ' ')}</td>
                    <td className="text-right">{money(l.gross)}</td>
                    <td className="text-right">{money(l.total_deductions)}</td>
                    <td className="text-right font-semibold">{money(l.net)}</td>
                    <td className="text-right">
                      <button className="text-[#2F6B45] hover:underline" onClick={() => openSlip(l.line_uid)}>Slip PDF</button>
                    </td>
                  </tr>
                  {openLine === l.line_uid && (
                    <tr>
                      <td colSpan={6} className="pb-3 pl-2 text-[12px] text-[#4B4640]">
                        {l.snapshot.metrics && (
                          <p className="mb-2 text-[#4B4640]">
                            Present {String(l.snapshot.metrics.present_days ?? 0)} ·
                            Half {String(l.snapshot.metrics.half_days ?? 0)} ·
                            Absent {String(l.snapshot.metrics.absent_days ?? 0)} ·
                            Paid leave {String(l.snapshot.metrics.paid_leave_days ?? 0)} ·
                            Unpaid leave {String(l.snapshot.metrics.unpaid_leave_days ?? 0)} ·
                            Week offs {String(l.snapshot.metrics.week_offs ?? 0)} ·
                            Holidays {String(l.snapshot.metrics.holidays ?? 0)} ·
                            Late {String(l.snapshot.metrics.late_entries ?? 0)} ({String(l.snapshot.metrics.late_minutes_total ?? 0)} min) ·
                            Worked {String(l.snapshot.metrics.worked_hours ?? 0)} h ·
                            Break {String(l.snapshot.metrics.break_hours ?? 0)} h ·
                            OT {String(l.snapshot.metrics.overtime_hours ?? 0)} h ·
                            CL used {String(l.snapshot.metrics.cl_consumed ?? 0)} ·
                            LOP groups {String(l.snapshot.metrics.lop_group_days ?? 0)}
                          </p>
                        )}
                        <div className="grid md:grid-cols-2 gap-4">
                          <div>
                            <div className="font-semibold mb-1">Earnings</div>
                            {(l.snapshot.earnings ?? []).map((e) => (
                              <div key={e.code + e.label} className="flex justify-between">
                                <span>{e.label}{e.basis ? <span className="text-[#8A918C]"> — {e.basis}</span> : null}</span>
                                <span>{money(e.amount)}</span>
                              </div>
                            ))}
                          </div>
                          <div>
                            <div className="font-semibold mb-1">Deductions</div>
                            {(l.snapshot.deductions ?? []).length === 0 && <div className="text-[#8A918C]">None</div>}
                            {(l.snapshot.deductions ?? []).map((d) => (
                              <div key={d.code + d.label} className="flex justify-between">
                                <span>{d.label}{d.basis ? <span className="text-[#8A918C]"> — {d.basis}</span> : null}</span>
                                <span>{money(d.amount)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                        {(l.snapshot.anomalies ?? []).length > 0 && (
                          <div className="mt-2 text-[#A23B3B]">
                            Review: {(l.snapshot.anomalies ?? []).map((a) => `${a.date} — ${a.reason}`).join('; ')}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
};
