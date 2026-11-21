import React, { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useApp } from '../../../context/AppContext';
import { departmentOverview, DepartmentOverview } from '../../../api/departments';
import { getPropertyDashboard, type PropertyDashboard } from '../../../api/dashboard';
import { Skeleton } from '../../ui/Skeleton';
import { CHART, HBarList, InteractiveLine, StackBar } from '../../dashboard/charts';

const fmtDayLong = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', {
    timeZone: 'UTC', day: '2-digit', month: 'long', year: 'numeric',
  });
const pct = (v: number | null | undefined) => (v == null ? '—' : `${v}%`);

const Panel: React.FC<{ title: string; note?: string; className?: string; children: React.ReactNode }> = ({
  title, note, className = '', children,
}) => (
  <section className={`rounded-[12px] border border-line bg-surface p-4 ${className}`}>
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="font-display text-section font-semibold text-ink">{title}</h2>
      {note && <p className="text-meta text-ink-3">{note}</p>}
    </div>
    <div className="mt-3">{children}</div>
  </section>
);

const Tip: React.FC<{ title: string; rows: [string, React.ReactNode][]; note?: string }> = ({ title, rows, note }) => (
  <div>
    <p className="font-semibold text-ink">{title}</p>
    <dl className="mt-1 space-y-0.5">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4">
          <dt className="text-ink-2">{k}</dt>
          <dd className="font-num tabular-nums text-ink">{v}</dd>
        </div>
      ))}
    </dl>
    {note && <p className="mt-1 text-micro text-ink-3">{note}</p>}
  </div>
);

/** Operational-status distribution — same board vocabulary as the property dashboard. */
function statusParts(d: PropertyDashboard) {
  const sc = d.workforce.attendance_period.status_counts ?? {};
  if (Object.keys(sc).length > 0) {
    return [
      { key: 'working', label: 'On duty', value: sc['working'] ?? 0, color: CHART.success },
      { key: 'on_break', label: 'On break', value: sc['on_break'] ?? 0, color: CHART.unavailable },
      { key: 'completed', label: 'Shift completed', value: sc['completed'] ?? 0, color: '#0F6847' },
      { key: 'absent', label: 'Absent', value: sc['absent'] ?? 0, color: CHART.maintenance },
      { key: 'scheduled', label: 'Scheduled', value: (sc['scheduled'] ?? 0) + (sc['awaiting'] ?? 0) + (sc['unscheduled'] ?? 0), color: CHART.vacant },
      { key: 'off', label: 'Off / leave', value: (sc['off_day'] ?? 0) + (sc['leave'] ?? 0) + (sc['week_off'] ?? 0), color: CHART.info },
    ].filter((p) => p.value > 0);
  }
  const wf = d.workforce;
  return [
    { key: 'present', label: 'Present', value: wf.present_today, color: CHART.success },
    { key: 'leave', label: 'On leave', value: wf.on_leave_today, color: CHART.info },
    { key: 'absent', label: 'Absent', value: wf.absent_today, color: CHART.maintenance },
    { key: 'unmarked', label: 'Not yet marked', value: wf.not_yet_marked_today, color: CHART.vacant },
  ].filter((p) => p.value > 0);
}

/**
 * Workforce dashboard — distribution and efficiency, not headcount cards.
 * Two data sources, fetched once each: the property dashboard (trends and
 * task performance) and the department overview (heads, staffing health).
 */
export const EmployeeDashboard: React.FC = () => {
  const { propertyUid } = useParams<{ propertyUid: string }>();
  const { navigate } = useApp();
  const [ov, setOv] = useState<DepartmentOverview | null>(null);
  const [dash, setDash] = useState<PropertyDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!propertyUid) return;
    let live = true;
    setLoading(true);
    Promise.all([
      departmentOverview(propertyUid),
      getPropertyDashboard(propertyUid, { period: 'last_30_days', granularity: 'day' }),
    ])
      .then(([o, d]) => {
        if (!live) return;
        setOv(o);
        setDash(d);
      })
      .catch((e) => live && setError(e?.message || 'Failed to load workforce overview'))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [propertyUid]);

  const attPoints = useMemo(
    () =>
      (dash?.workforce.attendance_series.points ?? []).map((p) => ({
        x: p.label,
        y: p.state === 'available' ? p.attendance_pct : null,
        tip:
          p.state === 'no_records' ? (
            <Tip title={fmtDayLong(p.date)} rows={[]} note="No attendance recorded — not shown as absence." />
          ) : (
            <Tip
              title={fmtDayLong(p.date)}
              rows={[
                ['Expected', p.expected],
                ['Present', p.present],
                ['Absent', p.absent],
                ['On leave', p.on_leave],
                ['Attendance', pct(p.attendance_pct)],
              ]}
            />
          ),
      })),
    [dash],
  );

  if (error) {
    return (
      <div className="rounded-[12px] border border-line bg-surface p-5">
        <p className="text-body font-semibold text-ink">The workforce overview could not be loaded.</p>
        <p className="mt-1 text-meta text-ink-2">{error}</p>
      </div>
    );
  }

  if (loading || !ov || !dash) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-52 w-full rounded-[12px]" />
        <Skeleton className="h-52 w-full rounded-[12px]" />
      </div>
    );
  }

  const depts = dash.departments.filter((d) => d.employees > 0);
  const parts = statusParts(dash);
  const root = `/property/${propertyUid}`;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-title font-bold text-ink">Workforce</h1>
          <p className="text-meta text-ink-2">
            {ov.active_employees} active of {ov.total_employees} staff · {ov.total_departments} departments
            {ov.unassigned_employees > 0 && ` · ${ov.unassigned_employees} unassigned`}
            {ov.departments_without_head > 0 && ` · ${ov.departments_without_head} dept${ov.departments_without_head === 1 ? '' : 's'} without a head`}
          </p>
        </div>
        <button
          onClick={() => navigate(`${root}/workforce/departments`)}
          className="text-meta font-medium text-brand-ink hover:underline"
        >
          Manage departments →
        </button>
      </header>

      <div className="grid gap-4 lg:grid-cols-12">
        {/* Distribution by operational status */}
        <Panel title="On duty today" note="Live attendance status" className="lg:col-span-4">
          {parts.length === 0 ? (
            <p className="text-body text-ink-3">No attendance recorded today yet.</p>
          ) : (
            <StackBar parts={parts} />
          )}
          <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3 text-body">
            <div><dt className="text-meta text-ink-3">On operational work</dt><dd className="font-num tabular-nums text-ink">{dash.workforce.assigned_to_operational_work}</dd></div>
            <div><dt className="text-meta text-ink-3">Unallocated to a zone</dt><dd className="font-num tabular-nums text-ink">{dash.workforce.unallocated}</dd></div>
          </dl>
        </Panel>

        {/* Attendance trend */}
        <Panel
          title="Attendance trend"
          note={`${dash.workforce.attendance_series.recorded_days} of ${dash.workforce.attendance_series.period_days} days recorded`}
          className="lg:col-span-8"
        >
          {dash.workforce.attendance_series.recorded_days === 0 ? (
            <p className="rounded-[10px] bg-hover px-3 py-6 text-center text-body text-ink-2">
              No attendance recorded in the last 30 days.
            </p>
          ) : (
            <InteractiveLine points={attPoints} yMax={100} yFormat={(v) => `${Math.round(v)}%`} ariaLabel="Attendance percentage per day" height={210} />
          )}
        </Panel>

        {/* Staff by department */}
        <Panel title="Staff by department" note="Active and inactive counts" className="lg:col-span-4">
          <HBarList
            rows={ov.departments.map((d) => ({
              key: d.department_uid,
              label: d.name + (d.status !== 'active' ? ' (inactive)' : ''),
              value: d.employee_count,
              secondary: d.head ? `head: ${d.head.name}` : 'no head',
              onSelect: () => navigate(`${root}/workforce/departments/${d.department_uid}`),
            }))}
            emptyText="No departments yet."
          />
        </Panel>

        {/* Task completion by department */}
        <Panel title="Tasks completed, last 30 days" note="Drill down into a department" className="lg:col-span-4">
          <HBarList
            rows={depts.map((d) => ({
              key: d.department_uid,
              label: d.department_name,
              value: d.tasks_completed,
              secondary: `${pct(d.completion_pct)} of ${d.tasks_created}`,
              onSelect: () => navigate(`${root}/workforce/departments/${d.department_uid}`),
            }))}
            emptyText="No task activity by department in this period."
          />
        </Panel>

        {/* Workload distribution */}
        <Panel title="Open work right now" note="Unfinished tasks and tickets per department" className="lg:col-span-4">
          <HBarList
            rows={depts.map((d) => ({
              key: d.department_uid,
              label: d.department_name,
              value: d.open_now,
              secondary: `${d.present_today} present today`,
              onSelect: () => navigate(`${root}/workforce/departments/${d.department_uid}`),
            }))}
            color={CHART.unavailable}
            emptyText="No open work."
          />
        </Panel>
      </div>
    </div>
  );
};
