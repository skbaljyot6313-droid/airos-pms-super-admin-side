import React, { ReactNode, useEffect } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  /** Optional sticky action bar — stays pinned below the scrollable content. */
  footer?: ReactNode;
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  description,
  children,
  maxWidth = 'md',
  footer,
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.body.style.overflow = 'unset';
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const maxWidthStyles = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    '2xl': 'max-w-5xl',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 overflow-y-auto">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-[#0D1C42]/40 backdrop-blur-xs transition-opacity ea-fade"
        onClick={onClose}
      />

      {/* Surface Card Modal */}
      <div
        className={cn(
          'relative w-full bg-[#ffffff] border border-[#E7E5E4] rounded-[18px] shadow-[0_20px_45px_rgba(0,0,0,0.12)] p-6 z-10 my-8 transition-all flex flex-col max-h-[85vh]',
          maxWidthStyles[maxWidth]
        )}
      >
        <div className="flex items-start justify-between gap-4 pb-4 border-b border-[#F6F4F2] mb-5 shrink-0">
          <div>
            <h2 className="font-display font-bold text-xl text-[#0D1C42] tracking-tight">
              {title}
            </h2>
            {description && (
              <p className="text-sm text-[#667085] mt-1 font-body">{description}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center text-[#667085] hover:text-[#0D1C42] hover:bg-[#F6F4F2] rounded-lg transition-colors cursor-pointer"
            aria-label="Close"
          >
            <X className="w-[18px] h-[18px]" />
          </button>
        </div>

        <div
          className={cn(
            'overflow-y-auto pr-1',
            footer ? 'max-h-[calc(85vh-170px)]' : 'max-h-[75vh]'
          )}
        >
          {children}
        </div>

        {footer && (
          <div className="pt-4 mt-1 border-t border-[#F6F4F2] shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};
