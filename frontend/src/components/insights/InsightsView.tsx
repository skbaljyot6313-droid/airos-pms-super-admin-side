import React from 'react';
import { useApp } from '../../context/AppContext';
import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

interface InsightLink {
  title: string;
  desc: string;
  to: string;
  saOnly?: boolean;
}

const GROUPS: { title: string; links: InsightLink[] }[] = [
  {
    title: 'Occupancy',
    links: [
      {
        title: 'Occupancy trend & space distribution',
        desc: 'Occupancy over time, by zone and room type, with data-quality flags.',
        to: 'overview',
      },
    ],
  },
  {
    title: 'Workforce',
    links: [
      {
        title: 'Workforce analytics',
        desc: 'Team performance, submission and rejection trends per employee.',
        to: 'workforce/employees?tab=analytics',
      },
      {
        title: 'Workforce distribution',
        desc: 'Staff by department, duty status and workload.',
        to: 'workforce/dashboard',
      },
    ],
  },
  {
    title: 'Tasks',
    links: [
      {
        title: 'Task history & day analysis',
        desc: 'Day-by-day outcomes, completion rates and abandoned work.',
        to: 'operations/tasks?tab=history',
      },
      {
        title: 'Operational calendar',
        desc: 'Month-level view of scheduled and generated work.',
        to: 'operations/tasks?tab=calendar',
      },
    ],
  },
  {
    title: 'Maintenance',
    links: [
      {
        title: 'Maintenance trends',
        desc: 'Ticket ageing, resolution times and per-zone load.',
        to: 'operations/tasks?tab=maintenance',
      },
    ],
  },
  {
    title: 'Attendance',
    links: [
      {
        title: 'Attendance board',
        desc: 'Per-employee daily status, exceptions and needs-review flags.',
        to: 'workforce/employees?tab=attendance',
      },
    ],
  },
  {
    title: 'Audit & activity',
    links: [
      {
        title: 'Activity & audit feed',
        desc: 'Full audit trail — task journeys, attachments, property activity.',
        to: 'insights/audit',
        saOnly: true,
      },
      {
        title: 'Pending reviews',
        desc: 'Employee-submitted work awaiting staff approval.',
        to: 'operations/tasks?tab=review',
      },
    ],
  },
];

/**
 * Insights — an organised index into the analytical surfaces of the app.
 * Grouped by the operational question, not by route.
 */
export const InsightsView: React.FC = () => {
  const { activePropertyUid, currentRole } = useApp();
  const navigate = useNavigate();
  const root = `/property/${activePropertyUid}`;

  return (
    <div className="space-y-7">
      <header>
        <h1 className="font-display text-title font-bold text-ink">Insights</h1>
        <p className="text-meta text-ink-2">Analytical views of this property's operations.</p>
      </header>

      <div className="grid gap-x-8 gap-y-7 lg:grid-cols-2">
        {GROUPS.map((g) => {
          const links = g.links.filter((l) => !l.saOnly || currentRole === 'super_admin');
          if (!links.length) return null;
          return (
            <section key={g.title}>
              <h2 className="text-meta font-semibold uppercase tracking-[0.05em] text-ink-3">{g.title}</h2>
              <div className="mt-2 divide-y divide-line rounded-[12px] border border-line bg-surface">
                {links.map((l) => (
                  <button
                    key={l.to}
                    onClick={() => navigate(`${root}/${l.to}`)}
                    className="group flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-hover"
                  >
                    <span className="min-w-0">
                      <span className="block text-body font-semibold text-ink group-hover:text-brand-ink">{l.title}</span>
                      <span className="mt-0.5 block text-meta text-ink-2">{l.desc}</span>
                    </span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-ink-3 group-hover:text-brand-ink" />
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
};
