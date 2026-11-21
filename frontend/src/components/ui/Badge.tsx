import React, { ReactNode } from 'react';
import { RefreshCw, Zap, CheckCircle2, Clock, AlertCircle, CalendarClock, Pin } from 'lucide-react';
import { cn } from '../../lib/utils';
import { RoomStatus, BedStatus, TaskStatus, TaskType } from '../../types';
import { TASK_STATUS_LABELS, TASK_TYPE_LABELS } from '../../lib/taskUtils';

export interface BadgeProps {
  children: ReactNode;
  variant?: 'sage' | 'orange' | 'red' | 'lavender' | 'info' | 'neutral' | 'outline';
  size?: 'sm' | 'md';
  className?: string;
}

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = 'neutral',
  size = 'md',
  className,
}) => {
  const sizeStyles = {
    sm: 'text-[11px] px-2 py-0.5 font-medium rounded-full',
    md: 'text-xs px-2.5 py-1 font-medium rounded-full',
  };

  const variantStyles = {
    sage: 'bg-[#E6F4EE] text-[#0F6847] border border-[#BFE3D2]',
    orange: 'bg-[#FDF3E2] text-[#A56514] border border-[#F2D9AF]',
    red: 'bg-[#FAEBEB] text-[#A83434] border border-[#F0C8C8]',
    lavender: 'bg-[#F0EBFA] text-[#5C41A5] border border-[#D8CAF0]',
    info: 'bg-[#EAF1FB] text-[#2457A8] border border-[#C3D6F0]',
    neutral: 'bg-[#EFF1F4] text-[#5F6776] border border-[#D9DDE3]',
    outline: 'bg-transparent text-[#667085] border border-[#D6D3D1]',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap leading-none transition-colors',
        sizeStyles[size],
        variantStyles[variant],
        className
      )}
    >
      {children}
    </span>
  );
};

// ---------------------------------------------------------------------------
// THE canonical resource visual resolver — the only place the UI decides a
// unit's color. It consumes the backend's two-axis state contract
// (`visual_state` emitted by ResourceStateService) and NEVER reconstructs
// state from task/ticket history.
//
//   maintenance              → red
//   cleaning                 → beige   (occupied + cleaning is STILL beige —
//                                       the operational blocker drives the
//                                       temporary visual state; occupancy is
//                                       an axis, not a color)
//   inactive                 → neutral
//   occupied + operational   → violet
//   unoccupied + available   → green
//   unknown / stale payload  → neutral + dev warning (never beige — a
//                              guessed color masks real data problems)
// ---------------------------------------------------------------------------
export type UnitVisualState = 'green' | 'purple' | 'beige' | 'red' | 'neutral';

export interface UnitStateInput {
  status: string;
  /** server-resolved axes — preferred source of truth */
  visual_state?: string | null;
  operational_state?: string | null;
  occupancy_state?: string | null;
  is_occupied?: boolean;
  /** legacy aliases still accepted for unserialized callers */
  occupied?: boolean;
  blocked?: boolean;
}

export function unitVisualState(input: UnitStateInput): UnitVisualState {
  // 1. the backend's canonical classification wins outright — the
  //    frontend must not reinterpret it
  switch (input.visual_state) {
    case 'maintenance':
      return 'red';
    case 'cleaning':
      return 'beige';
    case 'inactive':
      return 'neutral';
    case 'occupied':
      return 'purple';
    case 'available':
      return 'green';
  }
  // 2. fallback for objects serialized before the contract existed —
  //    derive from the two axes exactly like the backend does
  const operational =
    input.operational_state ??
    (input.status === 'occupied' ? 'available' : input.status);
  if (operational === 'inactive') return 'neutral';
  if (operational === 'maintenance') return 'red';
  if (operational === 'cleaning' || input.blocked) return 'beige';
  const occupied =
    input.is_occupied === true ||
    input.occupied === true ||
    input.occupancy_state === 'occupied' ||
    input.status === 'occupied';
  if (
    operational === 'available' ||
    operational === 'operational' ||
    operational === 'occupied'
  ) {
    return occupied ? 'purple' : 'green';
  }
  if (import.meta.env.DEV) {
    console.warn('unitVisualState: unrecognized resource state', input);
  }
  return 'neutral';
}

export const WASHROOM_TILE = 'bg-[#3C3D37] border-[#3C3D37] text-white';

export const UNIT_VISUAL_TINT: Record<UnitVisualState, string> = {
  green: 'bg-[#1E3B2F] border-[#1E3B2F] text-white',
  purple: 'bg-[#1B365D] border-[#1B365D] text-white',
  beige: 'bg-[#FBF5DD] border-[#EBDFAE] text-[#0D1C42]',
  red: 'bg-[#790D16] border-[#790D16] text-white',
  neutral: 'bg-[#7A8495] border-[#7A8495] text-white',
};

/** Dot accent color per visual state — shared by every status list. */
export const UNIT_VISUAL_DOT: Record<UnitVisualState, string> = {
  green: 'bg-[#1E3B2F]',
  purple: 'bg-[#1B365D]',
  beige: 'bg-[#F4BE38]',
  red: 'bg-[#790D16]',
  neutral: 'bg-[#7A8495]',
};

/** Text accent color per visual state. */
export const UNIT_VISUAL_TEXT: Record<UnitVisualState, string> = {
  green: 'text-[#1E3B2F]',
  purple: 'text-[#1B365D]',
  beige: 'text-[#A56514]',
  red: 'text-[#790D16]',
  neutral: 'text-[#5F6776]',
};

/** Badge variant per visual state — status pills go through the resolver too. */
export const UNIT_VISUAL_BADGE_VARIANT: Record<
  UnitVisualState,
  BadgeProps['variant']
> = {
  green: 'sage',
  purple: 'lavender',
  beige: 'orange',
  red: 'red',
  neutral: 'neutral',
};

/** Canonical label per visual state. */
export const UNIT_VISUAL_LABEL: Record<UnitVisualState, string> = {
  green: 'Available',
  purple: 'Occupied',
  beige: 'Cleaning',
  red: 'Maintenance',
  neutral: 'Inactive',
};

export const RoomStatusBadge: React.FC<{ status: RoomStatus; size?: 'sm' | 'md' }> = ({
  status,
  size = 'sm',
}) => {
  switch (status) {
    case 'available':
      return (
        <Badge variant="sage" size={size} className="bg-[#1E3B2F] text-white border-[#1E3B2F]">
          <span className="w-1.5 h-1.5 rounded-full bg-white" />
          Available
        </Badge>
      );
    case 'occupied':
      return (
        <Badge variant="lavender" size={size} className="bg-[#1B365D] text-white border-[#1B365D]">
          <span className="w-1.5 h-1.5 rounded-full bg-white" />
          Occupied
        </Badge>
      );
    case 'cleaning':
      return (
        <Badge variant="orange" size={size} className="bg-[#FBF5DD] text-[#0D1C42] border-[#EBDFAE]">
          <span className="w-1.5 h-1.5 rounded-full bg-[#0D1C42]" />
          Cleaning
        </Badge>
      );
    case 'maintenance':
      return (
        <Badge variant="red" size={size} className="bg-[#790D16] text-white border-[#790D16]">
          <span className="w-1.5 h-1.5 rounded-full bg-white" />
          Maintenance
        </Badge>
      );
    default:
      return <Badge size={size}>{status}</Badge>;
  }
};

export const BedStatusBadge: React.FC<{ status: BedStatus; size?: 'sm' | 'md' }> = ({
  status,
  size = 'sm',
}) => {
  switch (status) {
    case 'available':
      return (
        <Badge variant="sage" size={size} className="bg-[#1E3B2F] text-white border-[#1E3B2F]">
          <span className="w-1.5 h-1.5 rounded-full bg-white" />
          Available
        </Badge>
      );
    case 'occupied':
      return (
        <Badge variant="lavender" size={size} className="bg-[#1B365D] text-white border-[#1B365D]">
          <span className="w-1.5 h-1.5 rounded-full bg-white" />
          Occupied
        </Badge>
      );
    case 'cleaning':
      return (
        <Badge variant="orange" size={size} className="bg-[#FBF5DD] text-[#0D1C42] border-[#EBDFAE]">
          <span className="w-1.5 h-1.5 rounded-full bg-[#0D1C42]" />
          Cleaning
        </Badge>
      );
    case 'maintenance':
      return (
        <Badge variant="red" size={size} className="bg-[#790D16] text-white border-[#790D16]">
          <span className="w-1.5 h-1.5 rounded-full bg-white" />
          Maintenance
        </Badge>
      );
    default:
      return <Badge size={size}>{status}</Badge>;
  }
};

export const TaskStatusBadge: React.FC<{ status: TaskStatus; size?: 'sm' | 'md' }> = ({
  status,
  size = 'sm',
}) => {
  switch (status) {
    case 'completed':
      return (
        <Badge variant="sage" size={size}>
          <CheckCircle2 className="w-3 h-3" />
          {TASK_STATUS_LABELS[status]}
        </Badge>
      );
    case 'in_progress':
      return (
        <Badge variant="lavender" size={size}>
          <Clock className="w-3 h-3" />
          {TASK_STATUS_LABELS[status]}
        </Badge>
      );
    case 'pending':
      return (
        <Badge variant="orange" size={size} className="bg-[#FBF5DD] text-[#0D1C42] border-[#EBDFAE]">
          <Clock className="w-3 h-3" />
          {TASK_STATUS_LABELS[status]}
        </Badge>
      );
    case 'overdue':
      return (
        <Badge variant="red" size={size}>
          <AlertCircle className="w-3 h-3" />
          {TASK_STATUS_LABELS[status]}
        </Badge>
      );
    case 'scheduled':
      return (
        <Badge variant="lavender" size={size}>
          <CalendarClock className="w-3 h-3" />
          {TASK_STATUS_LABELS[status]}
        </Badge>
      );
    case 'assigned':
      return (
        <Badge variant="lavender" size={size}>
          <CheckCircle2 className="w-3 h-3" />
          {TASK_STATUS_LABELS[status]}
        </Badge>
      );
    case 'submitted':
      return (
        <Badge variant="lavender" size={size} className="bg-[#1B365D] text-white border-[#1B365D]">
          <Clock className="w-3 h-3" />
          {TASK_STATUS_LABELS[status]}
        </Badge>
      );
    case 'reopened':
      return (
        <Badge variant="orange" size={size}>
          <AlertCircle className="w-3 h-3" />
          {TASK_STATUS_LABELS[status]}
        </Badge>
      );
    case 'cancelled':
      return (
        <Badge variant="neutral" size={size}>
          {TASK_STATUS_LABELS[status]}
        </Badge>
      );
    case 'abandoned':
      return (
        <Badge variant="neutral" size={size} className="bg-[#EFF1F4] text-[#5F6776] border-[#D9DDE3]">
          <AlertCircle className="w-3 h-3" />
          {TASK_STATUS_LABELS[status]}
        </Badge>
      );
    default:
      return <Badge size={size}>{status}</Badge>;
  }
};

export const TaskTypeBadge: React.FC<{ type: TaskType; size?: 'sm' | 'md' }> = ({
  type,
  size = 'sm',
}) => {
  switch (type) {
    case 'repetitive':
      return (
        <Badge variant="lavender" size={size}>
          <RefreshCw className="w-3 h-3" />
          {TASK_TYPE_LABELS[type]}
        </Badge>
      );
    case 'automated':
      return (
        <Badge variant="lavender" size={size} className="bg-[#1B365D] text-white border-[#1B365D]">
          <Zap className="w-3 h-3" />
          {TASK_TYPE_LABELS[type]}
        </Badge>
      );
    case 'fixed':
    default:
      return (
        <Badge variant="neutral" size={size}>
          <Pin className="w-3 h-3" />
          {TASK_TYPE_LABELS[type]}
        </Badge>
      );
  }
};

