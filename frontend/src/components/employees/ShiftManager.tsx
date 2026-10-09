import React, { useCallback, useEffect, useState } from 'react';
import {
  DndContext,
  useDraggable,
  useDroppable,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  Clock,
  GripVertical,
  Plus,
  RefreshCw,
  UserX,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { ApiError } from '../../api/client';
import {
  shiftsApi,
  type Shift,
  type ShiftAssignment,
} from '../../api/shifts';
import type { Employee } from '../../types';
import { Button } from '../ui/Button';
import { Skeleton } from '../ui/Skeleton';
import { getInitials } from '../../lib/utils';
import { istDateKey, istDateKeyOffset } from '../../lib/datetime';
import { isEmployeeDeactivated } from '../../lib/employeeUtils';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const EMPTY_FORM = {
  name: '',
  start_time: '09:00',
  end_time: '18:00',
  grace_minutes: 15,
  early_exit_minutes: 15,
  working_days: '1111100',
};

const formatDays = (bitmap: string) =>
  bitmap === '1111111'
    ? 'Daily'
    : bitmap === '1111100'
    ? 'Mon–Fri'
    : bitmap === '0000011'
    ? 'Weekends'
    : DAY_LABELS.filter((_, i) => bitmap[i] === '1').join(', ') || 'None';

const UNASSIGNED = 'unassigned';

// ---------------------------------------------------------------------------
// Draggable staff card — same shell as the Zone Board card
// ---------------------------------------------------------------------------
const DraggableEmployeeCard: React.FC<{
  employee: Employee;
  isOverlay?: boolean;
}> = ({ employee, isOverlay = false }) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: employee.employee_uid,
    data: { employee },
  });

  const style = isDragging && !isOverlay ? { opacity: 0.35 } : undefined;

  return (
    <div
      ref={isOverlay ? undefined : setNodeRef}
      style={style}
      {...(isOverlay ? {} : listeners)}
      {...(isOverlay ? {} : attributes)}
      className={`bg-white rounded-[10px] px-3 py-2.5 border border-[#E9E4DA] shadow-[0_1px_3px_rgba(20,30,24,0.06)] hover:shadow-[0_4px_12px_rgba(20,30,24,0.08)] hover:border-[#2F6B45]/40 transition-[box-shadow,border-color] duration-150 select-none touch-none ${
        isOverlay
          ? 'shadow-[0_8px_24px_rgba(20,30,24,0.14)] rotate-1 scale-[1.03] cursor-grabbing ring-2 ring-[#2F6B45]'
          : 'cursor-grab active:cursor-grabbing'
      }`}
    >
      <div className="flex items-center gap-2.5">
        <div
          className="w-8 h-8 rounded-full text-white flex items-center justify-center font-semibold text-[11px] shrink-0"
          style={{ backgroundColor: employee.avatar_color || '#2F6B45' }}
        >
          {getInitials(employee.name)}
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="font-semibold text-[13px] text-[#17221B] leading-tight truncate">
            {employee.name}
          </h4>
          <p className="text-[11px] text-[#66706A] font-body truncate">
            {employee.job_title}
            {employee.department ? ` · ${employee.department}` : ''}
          </p>
        </div>
        <div
          className="text-[#B8B2A4] p-0.5 shrink-0"
          title="Drag to another shift"
        >
          <GripVertical className="w-3.5 h-3.5" />
        </div>
      </div>

      {(employee.status === 'On Leave' || employee.leave_status) && (
        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-[#F2EFE8] text-[10px]">
          <span className="px-1.5 py-0.5 rounded-[5px] bg-[#FFF3E4] text-[#C98232] font-semibold text-[9px] uppercase tracking-wide">
            On Leave
          </span>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Droppable shift column — 'unassigned' is the Employees pool
// ---------------------------------------------------------------------------
const ShiftColumn: React.FC<{
  id: string;
  title: string;
  subtitle?: string;
  unassigned?: boolean;
  inactive?: boolean;
  employees: Employee[];
  onEdit?: () => void;
}> = ({
  id,
  title,
  subtitle,
  unassigned = false,
  inactive = false,
  employees,
  onEdit,
}) => {
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col rounded-[12px] border p-2.5 w-[228px] shrink-0 transition-colors duration-150 ${
        unassigned
          ? 'bg-[#FDF8F0] border-[#EFE0C8]'
          : 'bg-white border-[#E9E4DA]'
      } ${isOver ? 'border-[#2F6B45] bg-[#E7F0E9] ring-1 ring-[#2F6B45]/30' : ''}`}
    >
      {/* Column header */}
      <div className="flex items-start justify-between gap-2 mb-2 px-0.5">
        <div className="flex items-center gap-1.5 min-w-0">
          {unassigned ? (
            <UserX className="w-3.5 h-3.5 text-[#C98232] shrink-0" />
          ) : (
            <Clock className="w-3.5 h-3.5 text-[#66706A] shrink-0" />
          )}
          <div className="min-w-0">
            <h3 className="font-semibold text-[13px] text-[#17221B] leading-tight truncate">
              {title}
              {inactive && (
                <span className="ml-1 text-[9px] font-semibold uppercase tracking-wide text-[#8A918C]">
                  inactive
                </span>
              )}
            </h3>
            {subtitle && (
              <p className="text-[10px] text-[#8A918C] leading-tight mt-0.5">
                {subtitle}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0 mt-0.5">
          {onEdit && (
            <button
              onClick={onEdit}
              className="text-[10px] font-medium text-[#66706A] hover:text-[#2F6B45] transition-colors cursor-pointer"
            >
              Edit
            </button>
          )}
          <span
            className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide ${
              employees.length > 0
                ? unassigned
                  ? 'text-[#C98232]'
                  : 'text-[#2F6B45]'
                : 'text-[#8A918C]'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                employees.length > 0
                  ? unassigned
                    ? 'bg-[#C98232]'
                    : 'bg-[#2F6B45]'
                  : 'bg-[#CFC9BB]'
              }`}
            />
            {employees.length}
          </span>
        </div>
      </div>

      {/* Staff cards / compact empty drop target */}
      <div className="flex-1 space-y-2">
        {employees.length === 0 ? (
          <div
            className={`flex items-center justify-center h-[52px] rounded-[8px] border border-dashed text-[11px] transition-colors duration-150 ${
              isOver
                ? 'border-[#2F6B45] text-[#2F6B45] bg-white/60 font-medium'
                : 'border-[#DDD6C7] text-[#8A918C]'
            }`}
          >
            Drop staff here
          </div>
        ) : (
          <>
            {employees.map((emp) => (
              <DraggableEmployeeCard
                key={emp.employee_uid}
                employee={emp}
              />
            ))}
            <p
              className={`text-center text-[10px] pt-0.5 transition-colors ${
                isOver ? 'text-[#2F6B45] font-medium' : 'text-[#A9A49A]'
              }`}
            >
              {isOver ? 'Drop staff here' : 'Drop to assign'}
            </p>
          </>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Shift board — every shift a container, 'Employees' the unassigned pool.
// Dragging a card assigns that shift effective today (IST); a same-day
// assignment is replaced, an older one is closed yesterday so history
// stays intact.
// ---------------------------------------------------------------------------
export const ShiftManager: React.FC = () => {
  const {
    activeProperty,
    currentPropertyEmployees,
    addToast,
  } = useApp();
  const propertyUid = activeProperty?.property_uid;

  const [shifts, setShifts] = useState<Shift[]>([]);
  const [current, setCurrent] = useState<ShiftAssignment[]>([]);
  const [exemptUids, setExemptUids] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading'
  );
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const [editing, setEditing] = useState<Shift | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [activeDragEmp, setActiveDragEmp] = useState<Employee | null>(
    null
  );
  const [moving, setMoving] = useState(false);

  // SA/PM-linked staff work 24×7 — no shift, not part of the board pool.
  const employees = currentPropertyEmployees.filter(
    (e) =>
      !isEmployeeDeactivated(e) && !exemptUids.has(e.employee_uid)
  );
  const exemptEmployees = currentPropertyEmployees.filter(
    (e) =>
      !isEmployeeDeactivated(e) && exemptUids.has(e.employee_uid)
  );

  const load = useCallback(async () => {
    if (!propertyUid) return;
    try {
      const [shiftRes, assignRes] = await Promise.all([
        shiftsApi.list(propertyUid, true),
        shiftsApi.listCurrent(propertyUid),
      ]);
      setShifts(shiftRes?.items ?? []);
      setCurrent(assignRes?.items ?? []);
      setExemptUids(new Set(assignRes?.exempt_employee_uids ?? []));
      setError(null);
      setStatus('ready');
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not load shifts.'
      );
      setStatus('error');
    }
  }, [propertyUid]);

  useEffect(() => {
    void load();
  }, [load]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  // emp_uid → currently effective assignment
  const currentByEmp = new Map(
    current.map((a) => [a.employee_uid, a])
  );

  const closeAssignment = async (a: ShiftAssignment) => {
    const today = istDateKey();
    if (a.effective_from >= today) {
      // Same-day or future window — covers no worked day, safe to remove.
      await shiftsApi.deleteAssignment(a.assignment_uid);
    } else {
      await shiftsApi.endAssignment(
        a.assignment_uid,
        istDateKeyOffset(-1)
      );
    }
  };

  const handleDragStart = (event: DragStartEvent) => {
    const emp = event.active.data.current?.employee as
      | Employee
      | undefined;
    if (emp) setActiveDragEmp(emp);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragEmp(null);
    if (!over || moving) return;

    const employeeUid = active.id as string;
    const target = over.id as string;
    const existing = currentByEmp.get(employeeUid);
    if (target !== UNASSIGNED && existing?.shift_uid === target) return;
    if (target === UNASSIGNED && !existing) return;

    setMoving(true);
    try {
      if (existing) await closeAssignment(existing);
      if (target !== UNASSIGNED) {
        await shiftsApi.assign(employeeUid, {
          shift_uid: target,
          effective_from: istDateKey(),
        });
      }
      await load();
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Reassignment Failed',
        description:
          err instanceof ApiError
            ? err.message
            : 'Could not update the shift assignment.',
      });
      await load();
    } finally {
      setMoving(false);
    }
  };

  // --- shift definition CRUD (unchanged inline form) ----------------------
  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (s: Shift) => {
    setEditing(s);
    setForm({
      name: s.name,
      start_time: s.start_time,
      end_time: s.end_time,
      grace_minutes: s.grace_minutes,
      early_exit_minutes: s.early_exit_minutes,
      working_days: s.working_days,
    });
    setFormError(null);
    setFormOpen(true);
  };

  const saveShift = async () => {
    if (!propertyUid) return;
    setSaving(true);
    setFormError(null);
    try {
      if (editing) {
        await shiftsApi.update(editing.shift_uid, form);
      } else {
        await shiftsApi.create({ ...form, property_uid: propertyUid });
      }
      setFormOpen(false);
      await load();
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : 'Could not save shift.'
      );
    } finally {
      setSaving(false);
    }
  };

  const visibleShifts = shifts.filter((s) => showInactive || s.is_active);

  const columnStaff = (shiftUid: string) =>
    employees.filter(
      (e) => currentByEmp.get(e.employee_uid)?.shift_uid === shiftUid
    );
  const unassignedStaff = employees.filter(
    (e) => !currentByEmp.has(e.employee_uid)
  );

  return (
    <div className="space-y-4">
      {/* Info strip — mirrors the Zone Board header row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 px-3 py-2 rounded-[10px] bg-[#F1EEE7] text-[11px] text-[#66706A]">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-[#2F6B45] shrink-0" />
          <span>
            <strong className="font-semibold text-[#17221B]">
              Shift Board
            </strong>
            <span className="hidden sm:inline">
              {' '}
              — drag staff between shifts to reassign (effective today,
              IST).
            </span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="accent-[#2F6B45]"
            />
            Show inactive
          </label>
          <button
            onClick={() => void load()}
            className="inline-flex items-center gap-1 text-[#66706A] hover:text-[#17221B] transition-colors cursor-pointer"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-1 font-medium text-[#2F6B45] hover:text-[#245538] transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New shift</span>
          </button>
        </div>
      </div>

      {/* Board */}
      {status === 'loading' ? (
        <div className="flex gap-3">
          <Skeleton className="h-40 w-[228px]" />
          <Skeleton className="h-40 w-[228px]" />
          <Skeleton className="h-40 w-[228px]" />
        </div>
      ) : status === 'error' ? (
        <div className="rounded-[12px] border border-[#E9E4DA] bg-white p-4">
          <p className="text-xs text-[#A82828]">{error}</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load()}
            className="mt-2"
          >
            Retry
          </Button>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={(e) => void handleDragEnd(e)}
        >
          <div className="flex gap-4 items-start">
            {/* Unassigned pool — pinned left like Unallocated Staff */}
            <ShiftColumn
              id={UNASSIGNED}
              title="Employees"
              subtitle={`${unassignedStaff.length} without a shift`}
              unassigned
              employees={unassignedStaff}
            />

            <div className="flex-1 min-w-0 flex flex-wrap gap-3">
              {visibleShifts.map((s) => (
                <ShiftColumn
                  key={s.shift_uid}
                  id={s.shift_uid}
                  title={s.name}
                  subtitle={`${s.start_time} – ${s.end_time}${
                    s.overnight ? ' (+1d)' : ''
                  } · ${formatDays(s.working_days)}`}
                  inactive={!s.is_active}
                  employees={columnStaff(s.shift_uid)}
                  onEdit={() => openEdit(s)}
                />
              ))}
              {visibleShifts.length === 0 && (
                <div className="rounded-[12px] border border-dashed border-[#DDD6C7] bg-white/60 px-5 py-4 text-[12px] text-[#66706A]">
                  No shifts yet — create one to start assigning staff.
                </div>
              )}
            </div>
          </div>

          <DragOverlay>
            {activeDragEmp ? (
              <DraggableEmployeeCard employee={activeDragEmp} isOverlay />
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {/* Management staff — 24×7 by default, never shift-bound */}
      {status === 'ready' && exemptEmployees.length > 0 && (
        <div className="rounded-[12px] border border-[#E9E4DA] bg-white px-3.5 py-2.5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#8A918C]">
              <Clock className="w-3.5 h-3.5" />
              Always on duty — 24×7
            </span>
            {exemptEmployees.map((e) => (
              <span
                key={e.employee_uid}
                className="inline-flex items-center gap-1.5 text-[12px] text-[#17221B]"
              >
                <span
                  className="w-5 h-5 rounded-full text-white flex items-center justify-center font-semibold text-[8px]"
                  style={{
                    backgroundColor: e.avatar_color || '#2F6B45',
                  }}
                >
                  {getInitials(e.name)}
                </span>
                {e.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Create / edit form */}
      {formOpen && (
        <div className="rounded-[12px] border border-[#2F6B45]/30 bg-white p-4">
          <h3 className="font-display font-semibold text-[14px] text-[#17221B] mb-3">
            {editing ? `Edit — ${editing.name}` : 'New shift'}
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <label className="col-span-2 sm:col-span-1 text-[11px] text-[#66706A]">
              Name
              <input
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                className="mt-1 w-full px-2 py-1.5 rounded-[7px] border border-[#E9E4DA] text-[13px] text-[#17221B] focus:outline-none focus:border-[#2F6B45]"
                placeholder="Morning shift"
              />
            </label>
            <label className="text-[11px] text-[#66706A]">
              Start (IST)
              <input
                type="time"
                value={form.start_time}
                onChange={(e) =>
                  setForm((f) => ({ ...f, start_time: e.target.value }))
                }
                className="mt-1 w-full px-2 py-1.5 rounded-[7px] border border-[#E9E4DA] text-[13px] text-[#17221B] focus:outline-none focus:border-[#2F6B45]"
              />
            </label>
            <label className="text-[11px] text-[#66706A]">
              End (IST)
              <input
                type="time"
                value={form.end_time}
                onChange={(e) =>
                  setForm((f) => ({ ...f, end_time: e.target.value }))
                }
                className="mt-1 w-full px-2 py-1.5 rounded-[7px] border border-[#E9E4DA] text-[13px] text-[#17221B] focus:outline-none focus:border-[#2F6B45]"
              />
            </label>
            <label className="text-[11px] text-[#66706A]">
              Grace (min)
              <input
                type="number"
                min={0}
                max={120}
                value={form.grace_minutes}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    grace_minutes: Number(e.target.value) || 0,
                  }))
                }
                className="mt-1 w-full px-2 py-1.5 rounded-[7px] border border-[#E9E4DA] text-[13px] text-[#17221B] focus:outline-none focus:border-[#2F6B45]"
              />
            </label>
            <label className="text-[11px] text-[#66706A]">
              Early-exit (min)
              <input
                type="number"
                min={0}
                max={120}
                value={form.early_exit_minutes}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    early_exit_minutes: Number(e.target.value) || 0,
                  }))
                }
                className="mt-1 w-full px-2 py-1.5 rounded-[7px] border border-[#E9E4DA] text-[13px] text-[#17221B] focus:outline-none focus:border-[#2F6B45]"
              />
            </label>
          </div>
          <div className="mt-3">
            <span className="text-[11px] text-[#66706A]">Working days</span>
            <div className="flex gap-1 mt-1">
              {DAY_LABELS.map((d, i) => (
                <button
                  key={d}
                  onClick={() =>
                    setForm((f) => {
                      const chars = f.working_days.split('');
                      chars[i] = chars[i] === '1' ? '0' : '1';
                      return { ...f, working_days: chars.join('') };
                    })
                  }
                  className={`px-2.5 py-1 rounded-[7px] text-[11px] font-medium transition-colors cursor-pointer ${
                    form.working_days[i] === '1'
                      ? 'bg-[#2F6B45] text-white'
                      : 'bg-[#F1EEE7] text-[#66706A] hover:bg-[#E7E3D9]'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
            {form.end_time <= form.start_time && (
              <p className="text-[11px] text-[#C98232] mt-2">
                End ≤ start — this will be treated as an overnight shift
                (ends the following day).
              </p>
            )}
          </div>
          {formError && (
            <p className="text-xs text-[#A82828] mt-2">{formError}</p>
          )}
          <div className="flex gap-2 mt-4">
            <Button
              variant="primary"
              size="sm"
              disabled={saving || !form.name.trim()}
              onClick={() => void saveShift()}
            >
              {saving
                ? 'Saving…'
                : editing
                ? 'Save changes'
                : 'Create shift'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFormOpen(false)}
            >
              Cancel
            </Button>
            {editing && (
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  await shiftsApi.update(editing.shift_uid, {
                    is_active: !editing.is_active,
                  });
                  setFormOpen(false);
                  await load();
                }}
              >
                {editing.is_active ? 'Deactivate' : 'Activate'}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
