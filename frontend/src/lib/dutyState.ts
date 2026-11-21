/**
 * Attendance-aware workforce state for the Zone Board.
 *
 * The status board (GET /attendance/status-board) is the authority for who is
 * on duty. Only `active` staff are available for new allocation — the backend
 * allocator applies the same on-duty rule (open workday, no open break).
 */

import type { DayStatusItem } from '../api/attendance';
import type { Task } from '../types';

export type DutyState = 'active' | 'on_break' | 'ended' | 'absent' | 'unknown';

export const DUTY_LABEL: Record<DutyState, string> = {
  active: 'Active',
  on_break: 'On break',
  ended: 'Ended',
  absent: 'Absent',
  unknown: 'Checking…',
};

export function dutyStateOf(item: DayStatusItem | undefined, boardReady: boolean): DutyState {
  if (!boardReady) return 'unknown';
  if (!item) return 'absent';
  switch (item.status) {
    case 'working':
      return 'active';
    case 'on_break':
      return 'on_break';
    case 'completed':
    case 'incomplete':
      return 'ended';
    default:
      return 'absent';
  }
}

export const isAvailable = (state: DutyState) => state === 'active';
export const isOffDuty = (state: DutyState) => state === 'ended' || state === 'absent';

export interface Workload {
  allocated: number;
  inProgress: number;
}

export interface ZoneWork {
  pendingUnallocated: number;
  allocated: number;
  inProgress: number;
  completed: number;
}

export interface DutyContextValue {
  states: Map<string, DutyState>;
  workload: Map<string, Workload>;
}

export const EMPTY_DUTY: DutyContextValue = { states: new Map(), workload: new Map() };

export function assigneeOf(task: Task): string | null {
  return task.employee_uid || task.assigned_to_uid || null;
}

export function workloadByEmployee(tasks: Task[]): Map<string, Workload> {
  const out = new Map<string, Workload>();
  for (const t of tasks) {
    const uid = assigneeOf(t);
    if (!uid) continue;
    const w = out.get(uid) ?? { allocated: 0, inProgress: 0 };
    if (t.status === 'assigned') w.allocated += 1;
    if (t.status === 'in_progress') w.inProgress += 1;
    out.set(uid, w);
  }
  return out;
}

/** Work in one zone (null = tasks with no zone). Terminal/scheduled work is
 *  excluded from the pending/allocated/in-progress counts. */
export function zoneWork(tasks: Task[], zoneUid: string | null): ZoneWork {
  const work: ZoneWork = { pendingUnallocated: 0, allocated: 0, inProgress: 0, completed: 0 };
  for (const t of tasks) {
    if ((t.zone_uid ?? null) !== zoneUid) continue;
    const assignee = assigneeOf(t);
    if (t.status === 'completed') work.completed += 1;
    else if (!assignee && t.status === 'pending') work.pendingUnallocated += 1;
    else if (t.status === 'assigned') work.allocated += 1;
    else if (t.status === 'in_progress') work.inProgress += 1;
  }
  return work;
}

export function pendingWorkTotal(tasks: Task[]): number {
  return tasks.filter((t) => !assigneeOf(t) && t.status === 'pending').length;
}
