import React, { useCallback, useEffect, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { ApiError, apiFetch } from '../../api/client';
import { payrollApi, type HalfDayGroup, type PayrollPeriodView, type PayrollPreviewRow } from '../../api/payroll';

const thisMonth = () => new Date().toISOString().slice(0, 7);

const money = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0;

export const SalariesView: React.FC = () => {
  const { activePropertyUid, currentUser } = useApp();
  const isSuper = currentUser?.role === 'super_admin';
  const [period, setPeriod] = useState(thisMonth);
  const [view, setView] = useState<PayrollPeriodView | null>(null);
  const [preview, setPreview] = useState<PayrollPreviewRow[]>([]);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
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
        ? 'No payroll generated for this month yet — the table below is the live month-to-date view.'
        : err instanceof ApiError ? err.message : 'Could not load payroll.');
    }
    try {
      setPreview((await payrollApi.getPreview(activePropertyUid, period)).items);
      setPreviewNote(null);
    } catch (err) {
      setPreview([]);
      setPreviewNote(err instanceof ApiError ? err.message : 'Live preview unavailable.');
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
        <h2 className="font-display text-[15px] font-semibold text-[#0D1C42]">Salaries — payroll</h2>
        <input
          type="month"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="px-2 py-1.5 rounded-[7px] border border-[#E7E5E4] text-[13px]"
        />
        {status && <span className="text-[12px] uppercase tracking-wide text-[#800020]">{status}</span>}
      </div>

      <div className="flex flex-wrap gap-2">
        <button disabled={busy} onClick={() => run(() => payrollApi.generate(activePropertyUid, period))}
          className="px-3 py-1.5 rounded-[8px] border border-[#D6D3D1] text-[13px]">
          {view ? 'Recalculate open lines' : 'Generate payroll'}
        </button>
        <button disabled={busy || status !== 'open'} onClick={() => run(() => payrollApi.submit(activePropertyUid, period))}
          className="px-3 py-1.5 rounded-[8px] border border-[#D6D3D1] text-[13px] disabled:opacity-40">
          Submit for approval
        </button>
        {isSuper && (
          <button disabled={busy || status !== 'submitted' || totals.review > 0}
            onClick={() => run(() => payrollApi.approve(activePropertyUid, period))}
            className="px-3 py-1.5 rounded-[8px] bg-[#800020] text-white text-[13px] disabled:opacity-40">
            Approve &amp; freeze
          </button>
        )}
        {isSuper && (
          <button disabled={busy || status !== 'approved'} onClick={markPaidWithDetails}
            className="px-3 py-1.5 rounded-[8px] border border-[#800020] text-[#800020] text-[13px] disabled:opacity-40">
            Mark as paid
          </button>
        )}
        {view && (
          <button onClick={downloadCsv}
            className="px-3 py-1.5 rounded-[8px] border border-[#D6D3D1] text-[13px]">
            Export CSV
          </button>
        )}
      </div>

      {preview.length > 0 && (
        <section className="rounded-[10px] border border-[#D6D3D1] bg-[#FFFFFF] overflow-hidden">
          <div className="flex items-baseline justify-between px-3 pt-3 pb-2">
            <h3 className="text-[13px] font-semibold text-[#0D1C42]">
              Month to date — live
            </h3>
            <span className="text-[11px] text-[#667085]">
              Attendance and earnings as they stand today — nothing saved yet
            </span>
          </div>
          <table className="w-full text-[13px]">
            <thead className="text-left text-[#667085] bg-[#F6F4F2]">
              <tr>
                <th className="py-1.5 px-3 font-semibold">Employee</th>
                <th className="font-semibold">Basis</th>
                <th className="text-right font-semibold">Present</th>
                <th className="text-right font-semibold">Half</th>
                <th className="text-right font-semibold">Absent</th>
                <th className="text-right font-semibold">Leave P/U</th>
                <th className="text-right font-semibold">Off+Hol</th>
                <th className="text-right font-semibold">Late</th>
                <th className="text-right font-semibold">OT h</th>
                <th className="text-right font-semibold">Gross</th>
                <th className="text-right font-semibold">Deductions</th>
                <th className="text-right font-semibold px-3">Net so far</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((r) => (
                <tr key={r.employee_uid} className="border-t border-[#F6F4F2] hover:bg-[#FFFCFA]">
                  <td className="py-1.5 px-3 font-medium">
                    {r.employee_name}
                    {r.anomalies.length > 0 && (
                      <span className="ml-1.5 text-[#A83434]" title={r.anomalies.map((a) => a.reason).join('; ')}>
                        ⚠
                      </span>
                    )}
                  </td>
                  <td className="text-[#667085]">
                    {r.rate !== null ? (
                      <>₹ {money(r.rate)} <span className="text-[11px]">{r.rate_label}</span></>
                    ) : (
                      <span className="text-[#A83434]">no structure</span>
                    )}
                  </td>
                  <td className="text-right">{num(r.metrics.present_days)}</td>
                  <td className="text-right">{num(r.metrics.half_days)}</td>
                  <td className="text-right">{num(r.metrics.absent_days)}</td>
                  <td className="text-right">
                    {num(r.metrics.paid_leave_days)} / {num(r.metrics.unpaid_leave_days)}
                  </td>
                  <td className="text-right">
                    {num(r.metrics.week_offs) + num(r.metrics.holidays)}
                  </td>
                  <td className="text-right">{num(r.metrics.late_entries)}</td>
                  <td className="text-right">{num(r.metrics.overtime_hours)}</td>
                  <td className="text-right">{money(r.gross)}</td>
                  <td className="text-right">{money(r.total_deductions)}</td>
                  <td className="text-right px-3 font-semibold">{money(r.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {previewNote && preview.length === 0 && (
        <p className="text-[12px] text-[#667085]">{previewNote}</p>
      )}

      {view && view.half_day_groups.length > 0 && (
        <section className="rounded-[10px] border border-[#D6D3D1] bg-[#FFFFFF] p-3">
          <h3 className="text-[13px] font-semibold text-[#0D1C42] mb-2">
            Half-day conversions (every 3 half-days → 1 CL or 1 day LOP)
          </h3>
          <ul className="space-y-1.5 text-[13px]">
            {view.half_day_groups.map((g) => (
              <li key={g.group_uid} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{g.employee_name}</span>
                <span className="text-[#800020]">group {g.group_index + 1} · {g.dates.join(', ')}</span>
                {g.decision === null || g.decision === 'cl_short' ? (
                  isSuper ? (
                    <>
                      <button disabled={busy} onClick={() => decide(g, 'cl')}
                        className="px-2 py-0.5 rounded-[6px] border border-[#800020] text-[#800020] disabled:opacity-40">
                        Deduct 1 CL
                      </button>
                      <button disabled={busy} onClick={() => decide(g, 'lop')}
                        className="px-2 py-0.5 rounded-[6px] border border-[#A83434] text-[#A83434] disabled:opacity-40">
                        Apply 1 day LOP
                      </button>
                    </>
                  ) : (
                    <span className="text-[#A83434]">Pending decision</span>
                  )
                ) : (
                  <span className="text-[#800020]">
                    {g.decision === 'cl' ? '→ 1 CL consumed' : '→ 1 day LOP'}
                    {g.decided_by ? ` by ${g.decided_by}` : ''}
                  </span>
                )}
                {g.decision === 'cl_short' && (
                  <span className="text-[#A83434]">CL balance insufficient ({g.cl_balance_at_decision}) — choose LOP or top up CL</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && <p role="alert" className="text-[13px] text-[#A83434]">{error}</p>}

      {view && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[13px]">
            <div><div className="text-[#800020]">Gross</div><div className="font-semibold">₹ {money(totals.gross)}</div></div>
            <div><div className="text-[#800020]">Deductions</div><div className="font-semibold">₹ {money(totals.ded)}</div></div>
            <div><div className="text-[#800020]">Net payable</div><div className="font-semibold">₹ {money(totals.net)}</div></div>
            <div><div className="text-[#800020]">Needs review</div><div className="font-semibold">{totals.review}</div></div>
          </div>

          <table className="w-full text-[13px]">
            <thead className="text-left text-[#800020]">
              <tr><th className="py-1">Employee</th><th>Status</th><th className="text-right">Gross</th>
                <th className="text-right">Deductions</th><th className="text-right">Net</th><th /></tr>
            </thead>
            <tbody>
              {view.lines.map((l) => (
                <React.Fragment key={l.line_uid}>
                  <tr className="border-t border-[#F6F4F2]">
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
                      <button className="text-[#800020] hover:underline" onClick={() => openSlip(l.line_uid)}>Slip PDF</button>
                    </td>
                  </tr>
                  {openLine === l.line_uid && (
                    <tr>
                      <td colSpan={6} className="pb-3 pl-2 text-[12px] text-[#0D1C42]">
                        {l.snapshot.metrics && (
                          <p className="mb-2 text-[#0D1C42]">
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
                                <span>{e.label}{e.basis ? <span className="text-[#800020]"> — {e.basis}</span> : null}</span>
                                <span>{money(e.amount)}</span>
                              </div>
                            ))}
                          </div>
                          <div>
                            <div className="font-semibold mb-1">Deductions</div>
                            {(l.snapshot.deductions ?? []).length === 0 && <div className="text-[#800020]">None</div>}
                            {(l.snapshot.deductions ?? []).map((d) => (
                              <div key={d.code + d.label} className="flex justify-between">
                                <span>{d.label}{d.basis ? <span className="text-[#800020]"> — {d.basis}</span> : null}</span>
                                <span>{money(d.amount)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                        {(l.snapshot.anomalies ?? []).length > 0 && (
                          <div className="mt-2 text-[#A83434]">
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
