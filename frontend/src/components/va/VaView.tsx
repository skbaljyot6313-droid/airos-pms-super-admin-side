import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Cctv, MonitorPlay, SlidersHorizontal } from 'lucide-react';
import { VaVms } from './VaVms';
import { VaCameraSettings } from './VaCameraSettings';

/**
 * VA workspace shell — persistent secondary nav (VMS | Camera Settings)
 * over the two sub-views. Route: /property/:uid/va/:tab
 */
export const VaView: React.FC = () => {
  const { propertyUid, tab = 'vms' } = useParams<{
    propertyUid: string;
    tab: string;
  }>();
  const navigate = useNavigate();

  const items = [
    { key: 'vms', label: 'VMS', icon: <MonitorPlay className="w-4 h-4" /> },
    {
      key: 'camera-settings',
      label: 'Camera Settings',
      icon: <SlidersHorizontal className="w-4 h-4" />,
    },
  ];

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#FFFCFA]">
      <div className="px-4 sm:px-6 pt-4 pb-0 flex items-center gap-4 border-b border-[#E7E5E4]">
        <div className="flex items-center gap-2 text-[#0D1C42] font-semibold text-[15px] pr-2">
          <Cctv className="w-4.5 h-4.5 text-[#800020]" />
          Video Analytics
        </div>
        <nav className="flex items-center gap-1">
          {items.map((it) => (
            <button
              key={it.key}
              onClick={() =>
                navigate(`/property/${propertyUid}/property/video/${it.key}`)
              }
              className={`flex items-center gap-1.5 px-3.5 py-2.5 text-[13px] font-medium border-b-2 -mb-px transition-colors ${
                tab === it.key
                  ? 'border-[#800020] text-[#800020]'
                  : 'border-transparent text-[#667085] hover:text-[#667085]'
              }`}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </nav>
      </div>
      {tab === 'camera-settings' ? (
        <VaCameraSettings propertyUid={propertyUid!} />
      ) : (
        <VaVms propertyUid={propertyUid!} />
      )}
    </div>
  );
};
