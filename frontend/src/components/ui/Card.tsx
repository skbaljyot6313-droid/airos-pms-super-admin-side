import React, { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  className?: string;
  hoverEffect?: boolean;
}

export const Card: React.FC<CardProps> = ({
  children,
  className,
  hoverEffect = false,
  ...props
}) => {
  return (
    <div
      className={cn(
        'bg-[#ffffff] border border-[#E7E5E4] rounded-[16px] p-5 shadow-[0_1px_3px_rgba(0,0,0,0.03)] transition-all duration-200',
        hoverEffect && 'hover:border-[#D6D3D1] hover:shadow-[0_4px_12px_rgba(36,34,31,0.05)]',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
};

export const CardHeader: React.FC<{ children: ReactNode; className?: string }> = ({
  children,
  className,
}) => (
  <div className={cn('flex items-center justify-between gap-3 pb-3 border-b border-[#F6F4F2] mb-4', className)}>
    {children}
  </div>
);

export const CardTitle: React.FC<{ children: ReactNode; className?: string }> = ({
  children,
  className,
}) => (
  <h3 className={cn('font-display font-semibold text-[17px] text-[#0D1C42] tracking-tight leading-snug', className)}>
    {children}
  </h3>
);
