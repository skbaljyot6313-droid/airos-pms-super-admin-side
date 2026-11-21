import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
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
  Layers,
  UserX,
  CheckSquare,
  GripVertical,
  MapPin,
  MapPinPlus,
  MapPinX,
  Building2,
  Plus,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { Employee, Zone } from '../../types';
import { getInitials } from '../../lib/utils';
import { isEmployeeAssignable } from '../../lib/employeeUtils';
import { attendanceApi, type DayStatusBoard } from '../../api/attendance';
import { usePolling } from '../../hooks/usePolling';
import { useRealtimeChannel, propChannel } from '../../realtime/useRealtimeChannel';
import {
  DUTY_LABEL,
  EMPTY_DUTY,
  dutyStateOf,
  isOffDuty,
  pendingWorkTotal,
  workloadByEmployee,
  zoneWork,
  type DutyContextValue,
  type DutyState,
  type ZoneWork,
} from '../../lib/dutyState';

interface ZoneBoardProps {
  onOpenCreateModal: () => void;
}

const DutyContext = createContext<DutyContextValue>(EMPTY_DUTY);

const DUTY_CHIP: Record<DutyState, string> = {
  active: 'bg-[#E7F0E9] text-[#2F6B45]',
  on_break: 'bg-[#FFF3E4] text-[#8A5A1E]',
  ended: 'bg-[#EEF0F2] text-[#4B5563]',
  absent: 'bg-[#F6EDEE] text-[#8C4A52]',
  unknown: 'bg-[#F3F3F1] text-[#8C867C]',
};

interface ColumnSummary {
  work: ZoneWork;
  available: number;
  noCover: boolean;
}

// ---------------------------------------------------------------------------
// Draggable staff card — avatar is the visual anchor; grip stays subtle
// ---------------------------------------------------------------------------
const DraggableEmployeeCard: React.FC<{
  employee: Employee;
  isOverlay?: boolean;
  /** Zone column this card sits in — lets the badge mark primary vs. 2nd zone */
  laneZoneId?: string;
  /** Lane this card sits in — multi-area staff render in several lanes, so
   *  the draggable id + drag payload carry the source lane (drop targets use
   *  it to remove ONE area instead of clearing all coverage). */
  laneId?: string;
}> = ({ employee, isOverlay = false, laneZoneId, laneId }) => {
  const {
    tasks,
    navigate,
    currentPropertyZones,
    currentPropertyAreas,
    assignEmployeeToZone,
    unallocateEmployee,
    assignEmployeeToPropertyWide,
    assignEmployeeSecondaryZone,
    addEmployeeAreaCoverage,
    removeEmployeeAreaCoverage,
  } = useApp();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `${employee.employee_uid}@${isOverlay ? 'overlay' : (laneId ?? 'card')}`,
    data: { employee, laneId },
  });

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const secondaryZone = currentPropertyZones.find(
    (z) => z.zone_uid === employee.secondary_zone_uid
  );
  const secondZoneCandidates = currentPropertyZones.filter(
    (z) =>
      z.zone_uid !== employee.zone_uid &&
      z.zone_uid !== employee.secondary_zone_uid
  );
  const primaryZone = currentPropertyZones.find(
    (z) => z.zone_uid === employee.zone_uid
  );

  // Multi-area coverage — the employee can cover several whole areas at
  // once; the card menu lets you add/remove them individually.
  const coveredAreaUids = employee.area_uids?.length
    ? employee.area_uids
    : employee.area_uid
      ? [employee.area_uid]
      : [];
  const areaMenuAreas = currentPropertyAreas;
  // One coverage menu for EVERY staff card — whole property, each whole
  // area, and specific zones are offered uniformly regardless of the
  // employee's current mode.
  const canManageAllocation =
    employee.covers_property ||
    areaMenuAreas.length > 0 ||
    currentPropertyZones.length > 0;

  const duty = useContext(DutyContext);
  const dutyState = duty.states.get(employee.employee_uid) ?? 'unknown';
  const work = duty.workload.get(employee.employee_uid) ?? { allocated: 0, inProgress: 0 };
  const activeTasksCount = work.allocated + work.inProgress;

  const style =
    isDragging && !isOverlay
      ? { opacity: 0.35 }
      : dutyState !== 'active' && !isOverlay
      ? { opacity: 0.7 }
      : undefined;

  return (
    <div
      ref={isOverlay ? undefined : setNodeRef}
      style={style}
      {...(isOverlay ? {} : listeners)}
      {...(isOverlay ? {} : attributes)}
      className={`relative bg-white rounded-[10px] px-3 py-2.5 border border-[#DDD7CB] shadow-[0_1px_3px_rgba(20,30,24,0.06)] hover:shadow-[0_4px_12px_rgba(20,30,24,0.08)] hover:border-[#2F6B45]/40 transition-[box-shadow,border-color] duration-150 select-none touch-none ${
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
            <button type="button" disabled={isOverlay} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); navigate(`/property/${employee.property_uid}/workforce/employees/${employee.employee_uid}`); }} aria-label={`View employee profile for ${employee.name}`} className="max-w-full truncate text-left hover:underline focus-visible:outline-2 focus-visible:outline-[#386641]">{employee.name}</button>
          </h4>
          <p className="text-[11px] text-[#66706A] font-body truncate">
            {employee.job_title}
            {employee.department ? ` · ${employee.department}` : ''}
          </p>
          <span
            className={`mt-1 inline-block rounded-full px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide ${DUTY_CHIP[dutyState]}`}
          >
            {DUTY_LABEL[dutyState]}
          </span>
        </div>
        {!isOverlay && canManageAllocation && (
          <div className="relative shrink-0" ref={menuRef}>
            <button
              type="button"
              title="Manage coverage — zones and whole areas"
              aria-label={`Manage coverage for ${employee.name}`}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              className={`p-0.5 rounded transition-colors ${
                menuOpen || employee.secondary_zone_uid || coveredAreaUids.length > 0
                  ? 'text-[#2F6B45]'
                  : 'text-[#8C867C] hover:text-[#2F6B45]'
              }`}
            >
              <MapPinPlus className="w-3.5 h-3.5" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-[calc(100%+4px)] z-40 w-52 rounded-[10px] border border-[#DDD7CB] bg-white shadow-[0_8px_24px_rgba(20,30,24,0.14)] p-1 max-h-72 overflow-y-auto">
                {/* Whole property */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    if (employee.covers_property) {
                      unallocateEmployee(employee.employee_uid);
                    } else {
                      assignEmployeeToPropertyWide(employee.employee_uid);
                    }
                  }}
                  className={`w-full flex items-center gap-1.5 px-2 py-1.5 rounded-[7px] text-left text-[11px] transition-colors ${
                    employee.covers_property
                      ? 'text-[#A32A2A] hover:bg-[#FDE8E8]'
                      : 'text-[#24221F] hover:bg-[#E9EDF2]'
                  }`}
                >
                  {employee.covers_property ? (
                    <MapPinX className="w-3 h-3 shrink-0" />
                  ) : (
                    <Building2 className="w-3 h-3 text-[#2F6B45] shrink-0" />
                  )}
                  <span className="truncate">
                    {employee.covers_property
                      ? 'Remove whole-property coverage'
                      : 'Whole property'}
                  </span>
                </button>

                {/* Whole areas — additive multi-area coverage */}
                {areaMenuAreas.length > 0 && (
                  <>
                    <p className="px-2 py-1 mt-1 border-t border-[#EFEAE0] pt-2 text-[9px] font-semibold uppercase tracking-wider text-[#8C867C]">
                      Whole-area coverage
                    </p>
                    {areaMenuAreas.map((a) => {
                      const covered = coveredAreaUids.includes(a.area_uid);
                      return (
                        <button
                          key={a.area_uid}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuOpen(false);
                            if (covered) {
                              removeEmployeeAreaCoverage(employee.employee_uid, a.area_uid);
                            } else {
                              addEmployeeAreaCoverage(employee.employee_uid, a.area_uid);
                            }
                          }}
                          className={`w-full flex items-center gap-1.5 px-2 py-1.5 rounded-[7px] text-left text-[11px] transition-colors ${
                            covered
                              ? 'text-[#A32A2A] hover:bg-[#FDE8E8]'
                              : 'text-[#24221F] hover:bg-[#E9EDF2]'
                          }`}
                        >
                          {covered ? (
                            <MapPinX className="w-3 h-3 shrink-0" />
                          ) : (
                            <MapPinPlus className="w-3 h-3 text-[#2F6B45] shrink-0" />
                          )}
                          <span className="truncate">
                            {covered ? `Remove ${a.name}` : `Entire ${a.name}`}
                            {a.code && !covered ? ` (${a.code})` : ''}
                          </span>
                        </button>
                      );
                    })}
                  </>
                )}

                {/* Specific zones — primary (± one secondary) for zone
                    staff; a direct zone assign for everyone else */}
                {currentPropertyZones.length > 0 && (
                  <>
                    <p className="px-2 py-1 mt-1 border-t border-[#EFEAE0] pt-2 text-[9px] font-semibold uppercase tracking-wider text-[#8C867C]">
                      Zone allocation
                    </p>
                    {employee.zone_uid && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuOpen(false);
                          assignEmployeeToZone(employee.employee_uid, null);
                        }}
                        className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-[7px] text-left text-[11px] text-[#A32A2A] hover:bg-[#FDE8E8] transition-colors"
                      >
                        <MapPinX className="w-3 h-3 shrink-0" />
                        <span className="truncate">
                          Remove {primaryZone?.name || 'primary zone'}
                        </span>
                      </button>
                    )}
                    {employee.secondary_zone_uid && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuOpen(false);
                          assignEmployeeSecondaryZone(employee.employee_uid, null);
                        }}
                        className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-[7px] text-left text-[11px] text-[#A32A2A] hover:bg-[#FDE8E8] transition-colors"
                      >
                        <MapPinX className="w-3 h-3 shrink-0" />
                        <span className="truncate">
                          Remove {secondaryZone?.name || 'second zone'}
                        </span>
                      </button>
                    )}
                    {(employee.zone_uid ? secondZoneCandidates : currentPropertyZones).map((z) => (
                      <button
                        key={z.zone_uid}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuOpen(false);
                          if (employee.zone_uid) {
                            assignEmployeeSecondaryZone(employee.employee_uid, z.zone_uid);
                          } else {
                            assignEmployeeToZone(employee.employee_uid, z.zone_uid);
                          }
                        }}
                        className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-[7px] text-left text-[11px] text-[#24221F] hover:bg-[#E9EDF2] transition-colors"
                      >
                        <MapPinPlus className="w-3 h-3 text-[#2F6B45] shrink-0" />
                        <span className="truncate">
                          {z.name}
                          {z.code ? ` (${z.code})` : ''}
                        </span>
                      </button>
                    ))}
                    {employee.zone_uid &&
                      secondZoneCandidates.length === 0 &&
                      !employee.secondary_zone_uid && (
                        <p className="px-2 py-1.5 text-[10px] text-[#8C867C]">
                          No other zones available
                        </p>
                      )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
        <div
          className="text-[#B8B2A4] p-0.5 shrink-0"
          title="Drag to another zone or area"
        >
          <GripVertical className="w-3.5 h-3.5" />
        </div>
      </div>

      {((employee.status === 'On Leave' || employee.leave_status) ||
        activeTasksCount > 0 ||
        employee.secondary_zone_uid ||
        coveredAreaUids.length > 0 ||
        employee.covers_property) && (
        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-[#E9EDF2] text-[10px]">
          {(employee.status === 'On Leave' || employee.leave_status) && (
            <span className="px-1.5 py-0.5 rounded-[5px] bg-[#FFF3E4] text-[#C98232] font-semibold text-[9px] uppercase tracking-wide">
              On Leave
            </span>
          )}
          {employee.covers_property && (
            <span className="px-1.5 py-0.5 rounded-[5px] bg-[#EBF3EC] text-[#2F6B45] font-semibold text-[9px] uppercase tracking-wide">
              Whole property
            </span>
          )}
          {employee.secondary_zone_uid && (
            <span
              className="px-1.5 py-0.5 rounded-[5px] bg-[#F3F6EF] text-[#2F6B45] font-semibold text-[9px] uppercase tracking-wide"
              title={`Also covers ${secondaryZone?.name || 'a second zone'}`}
            >
              {laneZoneId === employee.secondary_zone_uid ? '2nd zone' : '+1 zone'}
            </span>
          )}
          {coveredAreaUids.length > 0 && (
            <span
              className="px-1.5 py-0.5 rounded-[5px] bg-[#F3F6EF] text-[#2F6B45] font-semibold text-[9px] uppercase tracking-wide"
              title={`Covers ${coveredAreaUids.length} whole area${coveredAreaUids.length === 1 ? '' : 's'}`}
            >
              {coveredAreaUids.length === 1 ? 'area' : `${coveredAreaUids.length} areas`}
            </span>
          )}
          {activeTasksCount > 0 && (
            <span
              className="inline-flex items-center gap-1 text-[#2F6B45] font-semibold"
              title={`${work.allocated} allocated · ${work.inProgress} in progress`}
            >
              <CheckSquare className="w-3 h-3" />
              <span>{activeTasksCount}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Droppable column — zone lane / area-wide lane / unallocated lane
// ---------------------------------------------------------------------------
const DroppableColumn: React.FC<{
  id: string;
  title: string;
  subtitle?: string;
  kind?: 'zone' | 'area' | 'property' | 'unallocated';
  employees: Employee[];
  minHeight?: string;
  summary?: ColumnSummary;
}> = ({ id, title, subtitle, kind = 'zone', employees, summary }) => {
  const { setNodeRef, isOver } = useDroppable({ id });

  const shell =
    kind === 'unallocated'
      ? 'bg-[#FDF6EC] border-[#EFDDBE]'
      : kind === 'property'
      ? 'bg-[#EBF3EC] border-[#8EDCB9]'
      : kind === 'area'
      ? 'bg-[#EDF3ED] border-[#D5E2D7] border-dashed'
      : 'bg-white border-[#E9E4DA]';

  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col rounded-[12px] border p-2.5 w-[228px] shrink-0 transition-colors duration-150 ${shell} ${
        isOver
          ? 'border-[#2F6B45] bg-[#E7F0E9] ring-1 ring-[#2F6B45]/30'
          : ''
      }`}
    >
      {/* Column header */}
      <div className="flex items-start justify-between gap-2 mb-2 px-0.5">
        <div className="flex items-center gap-1.5 min-w-0">
          {kind === 'unallocated' ? (
            <UserX className="w-3.5 h-3.5 text-[#C98232] shrink-0" />
          ) : kind === 'property' ? (
            <Building2 className="w-3.5 h-3.5 text-[#2F6B45] shrink-0" />
          ) : kind === 'area' ? (
            <MapPin className="w-3.5 h-3.5 text-[#2F6B45] shrink-0" />
          ) : (
            <Layers className="w-3.5 h-3.5 text-[#66706A] shrink-0" />
          )}
          <div className="min-w-0">
            <h3 className="font-semibold text-[13px] text-[#17221B] leading-tight truncate">
              {title}
            </h3>
            {subtitle && (
              <p className="text-[10px] text-[#8A918C] leading-tight mt-0.5">
                {subtitle}
              </p>
            )}
          </div>
        </div>
        <span
          className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide shrink-0 mt-0.5 ${
            employees.length > 0
              ? kind === 'unallocated'
                ? 'text-[#C98232]'
                : 'text-[#2F6B45]'
              : 'text-[#8A918C]'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              employees.length > 0
                ? kind === 'unallocated'
                  ? 'bg-[#C98232]'
                  : 'bg-[#2F6B45]'
                : 'bg-[#CFC9BB]'
            }`}
          />
          {employees.length}
        </span>
      </div>

      {summary && (
        <div className="mb-2 px-0.5 text-[10px] leading-relaxed text-[#66706A]">
          <span className="font-semibold text-[#2F6B45]">{summary.available}</span> available ·{' '}
          {summary.work.allocated} allocated · {summary.work.inProgress} in progress ·{' '}
          {summary.work.completed} done ·{' '}
          <span className={summary.work.pendingUnallocated > 0 ? 'font-semibold text-[#C98232]' : ''}>
            {summary.work.pendingUnallocated} pending
          </span>
          {summary.noCover && (
            <span className="mt-0.5 block font-medium text-[#C98232]">
              No on-duty staff — pending work waits for cover
            </span>
          )}
        </div>
      )}

      {/* Staff cards / compact empty drop target */}
      <div className="flex-1 space-y-2">
        {employees.length === 0 ? (
          <div
            className={`flex items-center justify-center h-[52px] rounded-[8px] border border-dashed text-[11px] transition-colors duration-150 ${
              isOver
                ? 'border-[#2F6B45] text-[#2F6B45] bg-white/60 font-medium'
                : kind === 'area' || kind === 'property'
                ? 'border-[#CFE4D1] text-[#8C867C]'
                : 'border-[#DDD7CB] text-[#8C867C]'
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
                laneZoneId={kind === 'zone' ? id : undefined}
                laneId={id}
              />
            ))}
            <p
              className={`text-center text-[10px] pt-0.5 transition-colors ${
                isOver ? 'text-[#2F6B45] font-medium' : 'text-[#A9A49A]'
              }`}
            >
              {isOver ? 'Drop staff here' : 'Drop to add staff'}
            </p>
          </>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Zone board — areas as floor containers, zones wrap inside, unallocated
// pinned left. No horizontal scroll: zones wrap, areas flow vertically.
// ---------------------------------------------------------------------------
export const ZoneBoard: React.FC<ZoneBoardProps> = ({ onOpenCreateModal }) => {
  const {
    currentPropertyAreas,
    currentPropertyZones,
    currentPropertyEmployees,
    assignEmployeeToZone,
    unallocateEmployee,
    addEmployeeAreaCoverage,
    removeEmployeeAreaCoverage,
    assignEmployeeToPropertyWide,
    activeProperty,
    tasks,
  } = useApp();

  const [activeDragEmp, setActiveDragEmp] = useState<Employee | null>(null);

  const propertyUid = activeProperty?.property_uid;
  const [board, setBoard] = useState<DayStatusBoard | null>(null);
  const loadBoard = useCallback(async () => {
    if (!propertyUid) return;
    try {
      setBoard(await attendanceApi.statusBoard(propertyUid));
    } catch {
      // Keep the last good board; the next realtime event or poll retries.
    }
  }, [propertyUid]);
  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);
  useRealtimeChannel(
    propertyUid ? propChannel(propertyUid, 'attendance') : null,
    true,
    () => void loadBoard(),
  );
  usePolling(loadBoard, 120_000, true, 'ZoneBoard');

  const boardReady = board !== null;
  const boardItems = new Map((board?.employees ?? []).map((e) => [e.employee_uid, e]));
  const dutyStates = new Map<string, DutyState>(
    currentPropertyEmployees.map((e) => [
      e.employee_uid,
      dutyStateOf(boardItems.get(e.employee_uid), boardReady),
    ])
  );
  const dutyValue: DutyContextValue = {
    states: dutyStates,
    workload: workloadByEmployee(tasks),
  };
  const stateOf = (uid: string): DutyState => dutyStates.get(uid) ?? 'unknown';

  // Ended and absent staff leave the zone columns: they are not part of the
  // available workforce and are listed under "Off duty today" instead.
  // On-break staff stay in their columns — visible, but not counted as available.
  const assignableAll = currentPropertyEmployees.filter(isEmployeeAssignable);
  const assignableEmployees = assignableAll.filter(
    (e) => !isOffDuty(stateOf(e.employee_uid))
  );
  const offDutyEmployees = assignableAll.filter((e) =>
    isOffDuty(stateOf(e.employee_uid))
  );
  const availableCount = assignableEmployees.filter(
    (e) => stateOf(e.employee_uid) === 'active'
  ).length;
  const pendingTotal = pendingWorkTotal(tasks);
  const summaryFor = (zoneUid: string | null, employees: Employee[]): ColumnSummary => {
    const work = zoneWork(tasks, zoneUid);
    const available = employees.filter((e) => stateOf(e.employee_uid) === 'active').length;
    return { work, available, noCover: work.pendingUnallocated > 0 && available === 0 };
  };
  const assignableUnallocatedEmployees = assignableEmployees.filter(
    (e) =>
      !e.zone_uid &&
      !e.area_uid &&
      !(e.area_uids && e.area_uids.length > 0) &&
      !e.covers_property
  );
  const propertyWideEmployees = assignableEmployees.filter(
    (e) => e.covers_property
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const emp = event.active.data.current?.employee as Employee | undefined;
    if (emp) setActiveDragEmp(emp);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragEmp(null);

    if (!over) return;

    const employeeUid = String(active.id).split('@')[0];
    const targetColumnId = over.id as string;
    const sourceLane = active.data.current?.laneId as string | undefined;

    if (targetColumnId === 'unallocated') {
      // Dragging a lane's card out removes only THAT lane's coverage —
      // zones and areas are additive now.
      if (sourceLane?.startsWith('area:')) {
        removeEmployeeAreaCoverage(employeeUid, sourceLane.slice(5));
      } else if (sourceLane === 'property-wide') {
        unallocateEmployee(employeeUid); // whole clear (nothing else held)
      } else if (sourceLane !== 'unallocated') {
        assignEmployeeToZone(employeeUid, null); // clears the zone pair only
      }
    } else if (targetColumnId === 'property-wide') {
      if (sourceLane !== targetColumnId) assignEmployeeToPropertyWide(employeeUid);
    } else if (targetColumnId.startsWith('area:')) {
      // Multi-area: dropping on an area ADDS it to the coverage set —
      // existing areas survive (first drop lands on the primary area).
      if (sourceLane !== targetColumnId) {
        addEmployeeAreaCoverage(employeeUid, targetColumnId.slice(5));
      }
    } else {
      assignEmployeeToZone(employeeUid, targetColumnId);
    }
  };

  // Group zones under their area containers — zones with no area render flat
  const sortedAreas = [...currentPropertyAreas].sort(
    (a, b) => a.level_number - b.level_number
  );
  const zonesByArea = new Map<string, Zone[]>();
  const ungroupedZones: Zone[] = [];
  for (const z of currentPropertyZones) {
    if (z.area_uid) {
      const list = zonesByArea.get(z.area_uid) || [];
      list.push(z);
      zonesByArea.set(z.area_uid, list);
    } else {
      ungroupedZones.push(z);
    }
  }

  const renderZoneColumn = (zone: Zone) => {
    const employees = assignableEmployees.filter(
      (e) =>
        e.zone_uid === zone.zone_uid ||
        e.secondary_zone_uid === zone.zone_uid
    );
    return (
      <DroppableColumn
        key={zone.zone_uid}
        id={zone.zone_uid}
        title={zone.name}
        subtitle={zone.code}
        employees={employees}
        summary={summaryFor(zone.zone_uid, employees)}
      />
    );
  };

  return (
    <DutyContext.Provider value={dutyValue}>
    <div className="space-y-4">
      {/* Compact operational info strip */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 px-3 py-2 rounded-[10px] bg-[#F1EEE7] text-[11px] text-[#66706A]">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-[#2F6B45] shrink-0" />
          <span>
            <strong className="font-semibold text-[#17221B]">
              Spatial Staff Allocation
            </strong>
            <span className="hidden sm:inline">
              {' '}
              — drag staff between zones to assign physical coverage.
            </span>
          </span>
        </div>
        <span className="text-[#8A918C]">
          <strong className="font-semibold text-[#2F6B45]">{availableCount}</strong> available ·{' '}
          {offDutyEmployees.length} off duty · {pendingTotal} pending allocation ·{' '}
          Changes save automatically
        </span>
      </div>

      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="flex flex-col lg:flex-row gap-5 items-start min-h-[55vh]">
          {/* Unallocated lane — pinned left, warm accent for the exception */}
          <div className="w-full lg:w-[248px] lg:shrink-0">
            <div className="flex items-center justify-between mb-2 px-0.5">
              <div>
                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[#8A918C]">
                  Unallocated
                </h2>
                <p className="text-[10px] text-[#B0AA9C]">Floating property pool</p>
              </div>
              <button
                onClick={onOpenCreateModal}
                title="Add staff member"
                className="inline-flex items-center gap-1 text-[11px] font-medium text-[#2F6B45] hover:text-[#245538] transition-colors cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add staff</span>
              </button>
            </div>
            <DroppableColumn
              id="unallocated"
              title="Unallocated Staff"
              subtitle={`${assignableUnallocatedEmployees.length} person${
                assignableUnallocatedEmployees.length === 1 ? '' : 's'
              }`}
              kind="unallocated"
              employees={assignableUnallocatedEmployees}
              summary={summaryFor(null, assignableUnallocatedEmployees)}
            />
          </div>

          {/* Floor / area containers — stack vertically, zones wrap inside */}
          <div className="flex-1 min-w-0 space-y-4">
            {/* Whole-property lane — staff eligible for work in every zone */}
            <section className="rounded-[14px] border border-[#DDD7CB] bg-[#F7F8FA] p-4">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div className="flex items-center gap-2 min-w-0">
                  <Building2 className="w-4 h-4 text-[#2F6B45] shrink-0" />
                  <h2 className="font-display font-semibold text-[15px] text-[#24221F] tracking-tight truncate">
                    Whole Property
                  </h2>
                </div>
                <span
                  className={`text-[10px] font-semibold uppercase tracking-wider shrink-0 ${
                    propertyWideEmployees.length > 0
                      ? 'text-[#2F6B45]'
                      : 'text-[#8C867C]'
                  }`}
                >
                  {propertyWideEmployees.length} staff
                </span>
              </div>
              <div className="flex flex-wrap gap-3">
                <DroppableColumn
                  id="property-wide"
                  title="Whole property"
                  subtitle="Covers every zone in this property"
                  kind="property"
                  employees={propertyWideEmployees}
                />
              </div>
            </section>

            {sortedAreas.map((area) => {
              const areaZones = zonesByArea.get(area.area_uid) || [];
              const areaEmployees = assignableEmployees.filter(
                (e) =>
                  e.area_uids?.includes(area.area_uid) ||
                  e.area_uid === area.area_uid
              );
              const zoneStaff = assignableEmployees.filter((e) =>
                areaZones.some(
                  (z) =>
                    z.zone_uid === e.zone_uid ||
                    z.zone_uid === e.secondary_zone_uid
                )
              ).length;
              return (
                <section
                  key={area.area_uid}
                  className="rounded-[14px] border border-[#E7E3D9] bg-[#F5F3EE] p-4"
                >
                  {/* Floor header — visually dominates its zones */}
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <MapPin className="w-4 h-4 text-[#2F6B45] shrink-0" />
                      <h2 className="font-display font-semibold text-[15px] text-[#17221B] tracking-tight truncate">
                        {area.name}
                      </h2>
                    </div>
                    <div className="flex items-center gap-3 text-[10px] font-semibold uppercase tracking-wider text-[#8A918C] shrink-0">
                      <span>{area.code}</span>
                      <span className="text-[#D8D2C4]">·</span>
                      <span>
                        {areaZones.length} zone{areaZones.length === 1 ? '' : 's'}
                      </span>
                      <span className="text-[#D8D2C4]">·</span>
                      <span className={zoneStaff + areaEmployees.length > 0 ? 'text-[#2F6B45]' : ''}>
                        {zoneStaff + areaEmployees.length} staff
                      </span>
                    </div>
                  </div>

                  {/* Area-wide lane first, then wrapped zone cards */}
                  <div className="flex flex-wrap gap-3">
                    <DroppableColumn
                      id={`area:${area.area_uid}`}
                      title={`Entire ${area.name}`}
                      subtitle="Covers every zone in this area"
                      kind="area"
                      employees={areaEmployees}
                    />
                    {areaZones.map(renderZoneColumn)}
                  </div>
                </section>
              );
            })}

            {/* Zones not inside any area */}
            {ungroupedZones.length > 0 && (
              <section
                className={
                  sortedAreas.length
                    ? 'rounded-[14px] border border-[#E7E3D9] bg-[#F5F3EE] p-4'
                    : ''
                }
              >
                {sortedAreas.length > 0 && (
                  <div className="flex items-center gap-2 mb-3">
                    <Layers className="w-4 h-4 text-[#66706A] shrink-0" />
                    <h2 className="font-display font-semibold text-[15px] text-[#17221B] tracking-tight">
                      Other Zones
                    </h2>
                  </div>
                )}
                <div className="flex flex-wrap gap-3">
                  {ungroupedZones.map(renderZoneColumn)}
                </div>
              </section>
            )}

            {currentPropertyZones.length === 0 && (
              <div className="rounded-[14px] border border-dashed border-[#DDD6C7] p-8 text-center text-[12px] text-[#8A918C]">
                No zones configured for {activeProperty?.name || 'this property'} yet.
              </div>
            )}
          </div>
        </div>

        {/* Drag Overlay for smooth preview */}
        <DragOverlay>
          {activeDragEmp ? (
            <DraggableEmployeeCard employee={activeDragEmp} isOverlay />
          ) : null}
        </DragOverlay>
      </DndContext>

      {offDutyEmployees.length > 0 && (
        <section className="rounded-[14px] border border-[#E9E4DA] bg-white p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-[15px] font-semibold tracking-tight text-[#17221B]">
                Off duty today
              </h2>
              <p className="text-[10px] text-[#8A918C]">
                Not available for new allocation. Work already assigned to them stays on their record.
              </p>
            </div>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#8C867C]">
              {offDutyEmployees.length} staff
            </span>
          </div>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {offDutyEmployees.map((employee) => {
              const state = stateOf(employee.employee_uid);
              const zone = currentPropertyZones.find((z) => z.zone_uid === employee.zone_uid);
              return (
                <li
                  key={employee.employee_uid}
                  className="flex items-center gap-2.5 rounded-[10px] border border-[#EEEAE1] px-3 py-2"
                >
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
                    style={{ backgroundColor: employee.avatar_color || '#8C867C' }}
                  >
                    {getInitials(employee.name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold text-[#17221B]">{employee.name}</p>
                    <p className="truncate text-[11px] text-[#66706A]">
                      {employee.job_title}
                      {zone ? ` · ${zone.name}` : ''}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide ${DUTY_CHIP[state]}`}
                  >
                    {DUTY_LABEL[state]}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
    </DutyContext.Provider>
  );
};
