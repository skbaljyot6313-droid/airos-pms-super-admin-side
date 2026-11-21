import React from 'react';
import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from 'lucide-react';
import { useApp } from '../../context/AppContext';

export const ToastContainer: React.FC = () => {
  const { toasts, dismissToast } = useApp();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2.5 max-w-sm w-full pointer-events-none">
      {toasts.map((toast) => {
        let icon = <Info className="w-4 h-4 text-[#2457A8]" />;
        let borderColor = 'border-[#C3D6F0]';
        let bgColor = 'bg-[#ffffff]';

        if (toast.type === 'success') {
          icon = <CheckCircle2 className="w-4 h-4 text-[#16865B]" />;
          borderColor = 'border-[#BFE3D2]';
        } else if (toast.type === 'warning') {
          icon = <AlertTriangle className="w-4 h-4 text-[#A56514]" />;
          borderColor = 'border-[#F2D9AF]';
        } else if (toast.type === 'error') {
          icon = <AlertCircle className="w-4 h-4 text-[#A83434]" />;
          borderColor = 'border-[#F0C8C8]';
        }

        return (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-start gap-3 p-3.5 rounded-[14px] border ${borderColor} ${bgColor} shadow-[0_8px_20px_rgba(0,0,0,0.08)] ea-rise`}
          >
            <div className="mt-0.5 shrink-0">{icon}</div>
            <div className="flex-1 min-w-0">
              <h4 className="text-xs font-semibold text-[#0D1C42] font-body leading-tight">
                {toast.title}
              </h4>
              {toast.description && (
                <p className="text-xs text-[#667085] font-body mt-0.5 leading-snug">
                  {toast.description}
                </p>
              )}
            </div>
            <button
              onClick={() => dismissToast(toast.id)}
              className="p-1 text-[#667085] hover:text-[#0D1C42] rounded transition-colors cursor-pointer shrink-0"
              aria-label="Dismiss toast"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
