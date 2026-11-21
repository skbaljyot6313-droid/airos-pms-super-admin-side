import React from 'react';
import { useApp } from '../../context/AppContext';
import { useNavigate } from 'react-router-dom';
import {
  BarChart3,
  Users,
  ClipboardList,
  Wrench,
  ScrollText,
  ArrowRight,
  ShieldCheck,
} from 'lucide-react';

interface InsightLink {
  title: string;
  desc: string;
  to: string;
  icon: React.ReactNode;
  saOnly?: boolean;
}

/**
 * Insights hub — a directory into the analytical surfaces that already exist
 * elsewhere in the app, plus the SA-only activity/audit view.
 */
export const InsightsView: React.FC = () => {
  const { activePropertyUid, currentRole } = useApp();
  const navigate = useNavigate();
  const root = `/property/${activePropertyUid}`;

  const links: InsightLink[] = [
    {
      title: 'Workforce analytics',
      desc: 'Team performance, attendance and allocation insights across a period.',
      to: `${root}/workforce/employees?tab=analytics`,
      icon: <Users className="w-4 h-4" />,
    },
    {
      title: 'Task history & day analysis',
      desc: 'Day-by-day task outcomes, completion rates and abandoned work.',
      to: `${root}/operations/tasks?tab=history`,
      icon: <ClipboardList className="w-4 h-4" />,
    },
    {
      title: 'Maintenance trends',
      desc: 'Maintenance calendar and per-day ticket analysis.',
      to: `${root}/operations/tasks?tab=maintenance`,
      icon: <Wrench className="w-4 h-4" />,
    },
    {
      title: 'Operational calendar',
      desc: 'Month-level view of scheduled and generated work.',
      to: `${root}/operations/tasks?tab=calendar`,
      icon: <BarChart3 className="w-4 h-4" />,
    },
    {
      title: 'Activity & audit feed',
      desc: 'System audit trail — task journeys, attachments, property activity.',
      to: `${root}/insights/audit`,
      icon: <ScrollText className="w-4 h-4" />,
      saOnly: true,
    },
    {
      title: 'Pending reviews',
      desc: 'Employee-submitted work awaiting staff approval.',
      to: `${root}/operations/tasks?tab=review`,
      icon: <ShieldCheck className="w-4 h-4" />,
    },
  ];

  const visible = links.filter((l) => !l.saOnly || currentRole === 'super_admin');

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-[20px] font-bold text-[#24221F]">Insights</h1>
        <p className="text-[12.5px] text-[#8C867C] mt-0.5">
          Analytical and system-level visibility into this property's operations.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {visible.map((l) => (
          <button
            key={l.to}
            onClick={() => navigate(l.to)}
            className="rounded-[12px] border border-[#E7E1D6] bg-white p-4 text-left hover:border-[#B9C9BC] transition-colors cursor-pointer group"
          >
            <div className="flex items-center gap-2 text-[#386641]">
              {l.icon}
              <h3 className="text-[13.5px] font-semibold text-[#24221F]">{l.title}</h3>
            </div>
            <p className="text-[12px] text-[#78736A] mt-1.5">{l.desc}</p>
            <span className="mt-2.5 inline-flex items-center gap-1 text-[11.5px] font-medium text-[#386641] group-hover:underline">
              Open <ArrowRight className="w-3 h-3" />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};
