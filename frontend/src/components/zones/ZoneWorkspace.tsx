import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Layers,
  Building2,
  Bed,
  Users,
  CheckCircle2,
  Clock,
  Plus,
  Check,
  CheckSquare,
  Square,
  Sparkles,
  LogOut,
  X,
  AlertCircle,
  Wrench,
  Bath,
  ConciergeBell,
  ArrowRightLeft,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import {
  RoomStatusBadge,
  Badge,
  unitVisualState,
  UNIT_VISUAL_TINT,
  WASHROOM_TILE,
  UNIT_VISUAL_BADGE_VARIANT,
  UNIT_VISUAL_LABEL,
} from '../ui/Badge';
import { Bed as BedUnit, Dorm, Room, Zone, MaintenanceTicket, Washroom } from '../../types';
import { getEffectiveTaskStatus } from '../../lib/taskUtils';
import { zoneTypeLabel, zoneSupportsUnits, unitIcon, normalizeZoneUnits } from '../../lib/zoneUtils';
import { isBlockingTicket } from '../../lib/maintenanceUtils';
import { fixtureCountsFor, fixtureMeta, isCustomKind } from '../../lib/washroomFixtures';
import { CreateMaintenanceModal, MaintenanceTarget } from '../maintenance/CreateMaintenanceModal';
import { WashroomDetailModal } from '../rooms/WashroomDetailModal';
import { WashroomModal, WashroomCreateDefaults } from '../rooms/WashroomModal';
import { CreateRoomModal } from '../rooms/CreateRoomModal';
import { BulkCreateRoomsModal } from '../rooms/BulkCreateRoomsModal';
import { CreateDormModal } from '../rooms/CreateDormModal';
import { BulkCreateDormsModal } from '../rooms/BulkCreateDormsModal';
import { BulkCreateWashroomsModal } from '../rooms/BulkCreateWashroomsModal';
import { OccupancyToggle } from '../rooms/OccupancyToggle';
import { RequestItemModal } from '../rooms/RequestItemModal';
import { SwitchGuestModal, SwitchSource } from '../rooms/SwitchGuestModal';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';

interface ZoneWorkspaceProps {
  zone: Zone;
  onBack: () => void;
}

/**
 * Cleaning eligibility — occupancy is a separate axis from operational
 * work: an OCCUPIED room/bed is still cleanable. Only the operational
 * state gates cleaning (cleaning = duplicate-protection, maintenance =
 * blocked, inactive = not actionable).
 */
const isCleanable = (u: {
  operational_state?: string | null;
  status: string;
  is_occupied?: boolean;
}): boolean =>
  (u.operational_state ??
    (u.is_occupied || u.status === 'occupied' ? 'available' : u.status)) ===
  'available';

const facilityCount = (count: number, singular: string) =>
  `${count} ${singular}${count === 1 ? '' : 's'}`;

export const ZoneWorkspace: React.FC<ZoneWorkspaceProps> = ({ zone, onBack }) => {
  const {
    currentPropertyAreas,
    currentPropertyRooms,
    currentPropertyDorms,
    currentPropertyWashrooms,
    currentPropertyTasks,
    navigate,
    activePropertyUid,
    checkoutDorm,
    bulkUpdateUnits,
    checkInRoom,
    checkOutRoom,
    checkInBed,
    checkOutBed,
    currentPropertyMaintenance,
    currentRole,
    updateWashroom,
    subscribeUnitDeselect,
  } = useApp();

  // Employees use the same visual workspace but are strictly read-only on unit
  // state — they may only raise maintenance tickets (backend enforces coverage).
  const isEmployee = currentRole === 'employee';

  // Multi-Selection State for Rooms and Beds in this Zone
  const [selectedRoomUids, setSelectedRoomUids] = useState<string[]>([]);
  const [selectedBedUids, setSelectedBedUids] = useState<string[]>([]);

  // Release container selection when its task workflow completes — the
  // event carries exact target uids, so sibling selections survive.
  useEffect(
    () =>
      subscribeUnitDeselect((target) => {
        if (target.room_uids?.length)
          setSelectedRoomUids((prev) =>
            prev.filter((uid) => !target.room_uids!.includes(uid))
          );
        if (target.bed_uids?.length)
          setSelectedBedUids((prev) =>
            prev.filter((uid) => !target.bed_uids!.includes(uid))
          );
      }),
    [subscribeUnitDeselect]
  );
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [requestTarget, setRequestTarget] = useState<{
    room?: Room;
    dorm?: Dorm;
    bed?: BedUnit;
  } | null>(null);
  const [maintenanceTarget, setMaintenanceTarget] = useState<MaintenanceTarget | null>(null);
  const [maintenanceTargetList, setMaintenanceTargetList] = useState<MaintenanceTarget[] | null>(null);

  // Occupancy commands — check-in is a pure occupancy toggle (unnamed
  // occupancy allowed); checkout goes through a confirmation. `busyUnits`
  // locks a unit's controls while its command is in flight so
  // double-clicks can't fire duplicate requests.
  const [checkoutTarget, setCheckoutTarget] = useState<{
    kind: 'room' | 'bed';
    uid: string;
    label: string;
    guest: string | null;
  } | null>(null);
  // Guest switch — the occupied unit whose guest is being moved
  const [switchSource, setSwitchSource] = useState<SwitchSource | null>(null);
  const [busyUnits, setBusyUnits] = useState<Set<string>>(new Set());

  const runUnitAction = async (key: string, fn: () => Promise<void>) => {
    if (busyUnits.has(key)) return;
    setBusyUnits((prev) => new Set(prev).add(key));
    try {
      await fn();
    } finally {
      setBusyUnits((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const requestCheckout = (kind: 'room' | 'bed', uid: string, label: string, guest: string | null) => {
    if (busyUnits.has(`${kind}:${uid}`)) return;
    setCheckoutTarget({ kind, uid, label, guest });
  };

  const confirmCheckout = () => {
    if (!checkoutTarget) return;
    const { kind, uid } = checkoutTarget;
    void runUnitAction(`${kind}:${uid}`, () =>
      kind === 'room' ? checkOutRoom(uid) : checkOutBed(uid)
    );
  };

  // Dorm-attached washroom — detail view + create/edit flow. `washroom: null`
  // means the dorm only declares a facility; the detail modal can then offer
  // "Configure" to materialize the real Washroom record.
  const [washroomDetail, setWashroomDetail] = useState<{
    washroom: Washroom | null;
    declaredName: string | null;
    dorm: Dorm | null;
  } | null>(null);
  const [washroomModalOpen, setWashroomModalOpen] = useState(false);
  const [editingWashroom, setEditingWashroom] = useState<Washroom | null>(null);
  const [washroomDefaults, setWashroomDefaults] =
    useState<WashroomCreateDefaults | undefined>(undefined);

  // Stay-zone unit creation — each modal is mounted only while open so it
  // always starts fresh with this zone preselected.
  const [createModal, setCreateModal] = useState<
    'room' | 'bulkRoom' | 'dorm' | 'bulkDorm' | 'bulkWashroom' | null
  >(null);

  // entity_uid → active ticket maps for room / dorm / bed maintenance actions
  const { ticketsByRoom, ticketsByDorm, ticketsByBed, ticketsByWashroom } = useMemo(() => {
    const rooms = new Map<string, MaintenanceTicket>();
    const dorms = new Map<string, MaintenanceTicket>();
    const beds = new Map<string, MaintenanceTicket>();
    const washrooms = new Map<string, MaintenanceTicket>();
    for (const t of currentPropertyMaintenance) {
      if (!isBlockingTicket(t.status)) continue;
      if (t.room_uid && !rooms.has(t.room_uid)) rooms.set(t.room_uid, t);
      // dorm-wide tickets (no specific bed) map to the dorm; bed tickets map to the bed
      if (t.dorm_uid && !t.bed_uid && !dorms.has(t.dorm_uid)) dorms.set(t.dorm_uid, t);
      if (t.bed_uid && !beds.has(t.bed_uid)) beds.set(t.bed_uid, t);
      if (t.washroom_uid && !washrooms.has(t.washroom_uid)) {
        washrooms.set(t.washroom_uid, t);
      }
    }
    return {
      ticketsByRoom: rooms,
      ticketsByDorm: dorms,
      ticketsByBed: beds,
      ticketsByWashroom: washrooms,
    };
  }, [currentPropertyMaintenance]);

  // Resolve Area
  const associatedArea = currentPropertyAreas.find(
    (a) => a.area_uid === zone.area_uid || (!zone.area_uid && a.name === zone.floor)
  );

  const zoneRooms = currentPropertyRooms.filter((r) => r.zone_uid === zone.zone_uid);
  const zoneDorms = currentPropertyDorms.filter((d) => d.zone_uid === zone.zone_uid);
  // Zone-level washrooms only — dorm-owned washrooms (dorm_uid set, zone
  // inherited from the dorm) already render as tiles inside the dorm cards,
  // so listing them again here would duplicate them.
  const zoneWashrooms = currentPropertyWashrooms.filter(
    (w) => w.zone_uid === zone.zone_uid && !w.dorm_uid
  );
  const zoneOpenTasks = currentPropertyTasks.filter(
    (t) => t.zone_uid === zone.zone_uid && getEffectiveTaskStatus(t) !== 'completed'
  );

  const supportsUnits = zoneSupportsUnits(zone);
  const zoneUnits = normalizeZoneUnits(zone.custom_units);
  const totalCustomUnits = zoneUnits.reduce((a, u) => a + (u.qty || 1), 0);

  // Non-stay zones list their equipment/assets instead of guest units.
  const unitsSection = !supportsUnits ? (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-display font-semibold text-lg text-[#0D1C42] flex items-center gap-2">
          <Layers className="w-4 h-4 text-[#7554C8]" />
          <span>Zone Units ({totalCustomUnits})</span>
        </h3>
      </div>
      {zoneUnits.length === 0 ? (
        <Card className="p-6 text-center text-xs text-[#667085] border-dashed">
          No units listed yet — add equipment on this zone's card back on the Zones view.
        </Card>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {zoneUnits.map((u, i) => {
            const Icon = unitIcon(u.name);
            return (
              <Card key={`${u.name}-${i}`} className="p-3.5 flex items-center gap-3">
                <span className="w-9 h-9 rounded-[10px] bg-[#F7E9EE] text-[#800020] flex items-center justify-center shrink-0">
                  <Icon className="w-4 h-4" />
                </span>
                <p className="text-sm font-semibold text-[#0D1C42] truncate flex-1 min-w-0">
                  {u.name}
                </p>
                {u.qty > 1 && (
                  <Badge variant="lavender" size="sm">×{u.qty}</Badge>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  ) : null;

  const allZoneBeds = zoneDorms.flatMap((d) => d.beds);
  const totalSelectedCount = selectedRoomUids.length + selectedBedUids.length;

  // Toggle selection helpers
  const toggleRoomSelection = (roomUid: string) => {
    setSelectedRoomUids((prev) =>
      prev.includes(roomUid) ? prev.filter((id) => id !== roomUid) : [...prev, roomUid]
    );
  };

  const toggleBedSelection = (bedUid: string) => {
    setSelectedBedUids((prev) =>
      prev.includes(bedUid) ? prev.filter((id) => id !== bedUid) : [...prev, bedUid]
    );
  };

  const clearSelection = () => {
    setSelectedRoomUids([]);
    setSelectedBedUids([]);
  };

  // Quick multi-selection filters
  const selectAllOccupied = () => {
    const occupiedRooms = zoneRooms
      .filter((r) => r.is_occupied ?? r.status === 'occupied')
      .map((r) => r.room_uid);
    const occupiedBeds = allZoneBeds
      .filter((b) => b.is_occupied ?? b.status === 'occupied')
      .map((b) => b.bed_uid);
    setSelectedRoomUids(occupiedRooms);
    setSelectedBedUids(occupiedBeds);
    setIsMultiSelectMode(true);
  };

  const selectAllCleaning = () => {
    const cleaningRooms = zoneRooms.filter((r) => r.status === 'cleaning').map((r) => r.room_uid);
    const cleaningBeds = allZoneBeds.filter((b) => b.status === 'cleaning').map((b) => b.bed_uid);
    setSelectedRoomUids(cleaningRooms);
    setSelectedBedUids(cleaningBeds);
    setIsMultiSelectMode(true);
  };

  const selectAllUnits = () => {
    setSelectedRoomUids(zoneRooms.map((r) => r.room_uid));
    setSelectedBedUids(allZoneBeds.map((b) => b.bed_uid));
    setIsMultiSelectMode(true);
  };

  // Bulk Actions Handlers
  const handleBulkCleaning = () => {
    if (totalSelectedCount === 0) return;
    bulkUpdateUnits({
      action: 'cleaning',
      roomUids: selectedRoomUids,
      bedUids: selectedBedUids,
    });
    clearSelection();
  };

  const handleBulkCheckout = () => {
    if (totalSelectedCount === 0) return;
    bulkUpdateUnits({
      action: 'checkout',
      roomUids: selectedRoomUids,
      bedUids: selectedBedUids,
    });
    clearSelection();
  };

  const handleBulkAvailable = () => {
    if (totalSelectedCount === 0) return;
    bulkUpdateUnits({
      action: 'available',
      roomUids: selectedRoomUids,
      bedUids: selectedBedUids,
    });
    clearSelection();
  };

  // Bulk maintenance opens the ticket form — one ticket per selected unit,
  // matching the Rooms view (ticket-first, never a bare status flip).
  const handleBulkMaintenance = () => {
    if (totalSelectedCount === 0) return;
    const targets: MaintenanceTarget[] = [];
    for (const room of zoneRooms) {
      if (selectedRoomUids.includes(room.room_uid)) {
        targets.push({ kind: 'room', room });
      }
    }
    for (const dorm of zoneDorms) {
      for (const bed of dorm.beds) {
        if (selectedBedUids.includes(bed.bed_uid)) {
          targets.push({ kind: 'bed', dorm, bed });
        }
      }
    }
    if (targets.length > 0) setMaintenanceTargetList(targets);
  };

  const washroomSection = (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-display font-semibold text-lg text-[#0D1C42] flex items-center gap-2">
          <Bath className="w-4 h-4 text-[#2457A8]" />
          <span>Washrooms ({zoneWashrooms.length})</span>
        </h3>
      </div>
      {zoneWashrooms.length === 0 ? (
        <Card className="p-6 text-center text-xs text-[#667085] border-dashed">
          No washrooms assigned to this zone yet.
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
          {zoneWashrooms.map((washroom) => (
            <Card
              key={washroom.washroom_uid}
              onClick={() =>
                setWashroomDetail({
                  washroom,
                  declaredName: null,
                  dorm: null,
                })
              }
              className="p-4 cursor-pointer transition-all hover:border-[#D6D3D1] hover:shadow-xs"
              title={`${washroom.name} — view facility details`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-[8px] bg-[#EAF1FB] border border-[#C3D6F0] text-[#2457A8] flex items-center justify-center">
                    <Bath className="w-4 h-4" />
                  </div>
                  <span className="font-display font-bold text-lg text-[#0D1C42] truncate">
                    {washroom.name}
                  </span>
                </div>
                <Badge
                  variant={
                    UNIT_VISUAL_BADGE_VARIANT[unitVisualState(washroom)]
                  }
                  size="sm"
                >
                  {UNIT_VISUAL_LABEL[unitVisualState(washroom)]}
                </Badge>
              </div>
              <p className="text-xs font-medium text-[#0D1C42] capitalize">
                {washroom.washroom_type} washroom
              </p>
              <p className="text-[11px] text-[#667085] mt-1">
                {facilityCount(washroom.stall_count, 'stall')} ·{' '}
                {facilityCount(washroom.urinal_count, 'urinal')} ·{' '}
                {facilityCount(washroom.shower_count, 'shower')}
              </p>
              <div className="mt-3 pt-2.5 border-t border-[#F6F4F2] flex items-center justify-end">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMaintenanceTarget({ kind: 'washroom', washroom });
                  }}
                  className={`text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer ${
                    ticketsByWashroom.has(washroom.washroom_uid)
                      ? 'text-[#A83434] hover:underline'
                      : 'text-[#667085] hover:underline'
                  }`}
                  title={
                    ticketsByWashroom.has(washroom.washroom_uid)
                      ? `Active ticket ${
                          ticketsByWashroom.get(washroom.washroom_uid)?.ticket_number
                        }`
                      : 'Report a maintenance issue for this washroom'
                  }
                >
                  <Wrench className="w-3 h-3" />
                  {ticketsByWashroom.has(washroom.washroom_uid)
                    ? 'Maintenance ●'
                    : 'Maintenance'}
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Header with Back button */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[#E7E5E4]">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft className="w-4 h-4 mr-1" />
            <span>All Zones</span>
          </Button>

          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-[#F6F4F2] text-[#667085]">
                {zone.code}
              </span>
              <h1 className="font-display font-bold text-2xl text-[#0D1C42] tracking-tight">
                {zone.name}
              </h1>
              <Badge variant={supportsUnits ? 'sage' : 'lavender'} size="sm">
                {zoneTypeLabel(zone)}
              </Badge>
              {associatedArea && (
                <Badge variant="sage" size="sm">
                  Area: {associatedArea.name} ({associatedArea.code})
                </Badge>
              )}
            </div>
            {zone.description && (
              <p className="text-xs text-[#667085] font-body mt-0.5">
                {zone.description}
              </p>
            )}
          </div>
        </div>

        {/* Action jump buttons — manager routes; hidden for employees */}
        {!isEmployee && (
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(`/property/${activePropertyUid}/operations/tasks`)}
            >
              <CheckSquare className="w-4 h-4 mr-1.5" />
              <span>Zone Tasks ({zoneOpenTasks.length})</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(`/property/${activePropertyUid}/property/spaces/units`)}
            >
              <Bed className="w-4 h-4 mr-1.5" />
              <span>Rooms & Dorms</span>
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => navigate(`/property/${activePropertyUid}/workforce/employees`)}
            >
              <Users className="w-4 h-4 mr-1.5" />
              <span>Zone Staff Board</span>
            </Button>
          </div>
        )}
      </div>

      {/* ── Rooms, Dorms & Washrooms ──────────────────────────────────── */}
      <div className="space-y-6">

      {/* Unit creation for this stay zone — managers only */}
      {supportsUnits && !isEmployee && (
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="primary" size="sm" onClick={() => setCreateModal('room')}>
            <Plus className="w-4 h-4 mr-1.5" />
            <span>Add Room</span>
          </Button>
          <Button variant="outline" size="sm" onClick={() => setCreateModal('bulkRoom')}>
            <span>Bulk Create Rooms</span>
          </Button>
          <Button variant="primary" size="sm" onClick={() => setCreateModal('dorm')}>
            <Bed className="w-4 h-4 mr-1.5" />
            <span>Add Dorm</span>
          </Button>
          <Button variant="outline" size="sm" onClick={() => setCreateModal('bulkDorm')}>
            <span>Bulk Create Dorms</span>
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setEditingWashroom(null);
              setWashroomDefaults({ zone_uid: zone.zone_uid });
              setWashroomModalOpen(true);
            }}
          >
            <Bath className="w-4 h-4 mr-1.5" />
            <span>Add Washroom</span>
          </Button>
          <Button variant="outline" size="sm" onClick={() => setCreateModal('bulkWashroom')}>
            <span>Bulk Create Washrooms</span>
          </Button>
        </div>
      )}

      {/* Multi-Select Toolbar & Bulk Operations Dock — only meaningful for stay zones */}
      {supportsUnits && (
      <Card
        className={`p-4 transition-all duration-200 ${
          totalSelectedCount > 0
            ? 'bg-[#FFFCFA] border-[#800020] ring-2 ring-[#800020]/20 shadow-sm'
            : 'bg-white border-[#E7E5E4]'
        }`}
      >
        {/* Row 1: selection controls — toggle, quick picks, count hint */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => {
                if (isMultiSelectMode && totalSelectedCount > 0) {
                  clearSelection();
                }
                setIsMultiSelectMode(!isMultiSelectMode);
              }}
              className={`px-3 py-1.5 rounded-[10px] text-xs font-semibold transition-all cursor-pointer inline-flex items-center gap-1.5 ${
                isMultiSelectMode
                  ? 'bg-[#800020] text-white shadow-xs'
                  : 'bg-[#FFFFFF] text-[#667085] hover:bg-[#F6F4F2] border border-[#D6D3D1]'
              }`}
            >
              {isMultiSelectMode ? (
                <CheckSquare className="w-3.5 h-3.5" />
              ) : (
                <Square className="w-3.5 h-3.5" />
              )}
              <span>{isMultiSelectMode ? 'Multi-Select Active' : 'Enable Multi-Select'}</span>
            </button>

            <span className="text-[#CDC9C7] text-xs hidden sm:inline mx-0.5">|</span>

            <button
              type="button"
              onClick={selectAllOccupied}
              className="text-xs px-2.5 py-1 rounded-[8px] bg-[#EAF1FB] hover:bg-[#C3D6F0] text-[#2457A8] font-medium transition-colors cursor-pointer"
            >
              Select Occupied
            </button>
            <button
              type="button"
              onClick={selectAllCleaning}
              className="text-xs px-2.5 py-1 rounded-[8px] bg-[#FDF3E2] hover:bg-[#F2D9AF] text-[#A56514] font-medium transition-colors cursor-pointer"
            >
              Select In Cleaning
            </button>
            <button
              type="button"
              onClick={selectAllUnits}
              className="text-xs px-2.5 py-1 rounded-[8px] bg-[#FFFFFF] hover:bg-[#F6F4F2] text-[#667085] font-medium transition-colors cursor-pointer border border-[#D6D3D1]"
            >
              Select All
            </button>
            {totalSelectedCount > 0 && (
              <button
                type="button"
                onClick={clearSelection}
                className="text-xs px-2.5 py-1 rounded-[8px] text-red-600 hover:bg-red-50 font-medium transition-colors cursor-pointer inline-flex items-center gap-1"
              >
                <X className="w-3 h-3" />
                <span>Clear ({totalSelectedCount})</span>
              </button>
            )}
          </div>

          <span className="text-xs whitespace-nowrap">
            {totalSelectedCount > 0 ? (
              <span className="font-semibold text-[#0D1C42]">
                {selectedRoomUids.length > 0 && `${selectedRoomUids.length} room${selectedRoomUids.length > 1 ? 's' : ''}`}
                {selectedRoomUids.length > 0 && selectedBedUids.length > 0 && ' & '}
                {selectedBedUids.length > 0 && `${selectedBedUids.length} bed${selectedBedUids.length > 1 ? 's' : ''}`}{' '}
                selected
              </span>
            ) : (
              <span className="text-[#667085]">Click rooms or beds below to select</span>
            )}
          </span>
        </div>

        {/* Row 2: bulk actions on the selected units — ops actions are
            manager-only; employees can only raise maintenance tickets */}
        <div className="flex items-center justify-end gap-2 flex-wrap mt-3 pt-3 border-t border-[#F6F4F2]">
          {!isEmployee && (
            <>
          {/* Action 1: Bulk Check Out */}
          <Button
            variant="outline"
            size="sm"
            disabled={totalSelectedCount === 0}
            onClick={handleBulkCheckout}
            className={`text-xs gap-1.5 ${
              totalSelectedCount > 0
                ? 'border-[#A56514] text-[#A56514] hover:bg-[#FDF3E2] bg-white'
                : 'opacity-50'
            }`}
            title="Check out guests from all selected units and flag them for cleaning"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Bulk Check Out ({totalSelectedCount})</span>
          </Button>

          {/* Action 2: Bulk Cleaning */}
          <Button
            variant="primary"
            size="sm"
            disabled={totalSelectedCount === 0}
            onClick={handleBulkCleaning}
            className={`text-xs gap-1.5 ${
              totalSelectedCount > 0
                ? 'bg-[#800020] hover:bg-[#0D1C42] text-white shadow-xs'
                : 'opacity-50'
            }`}
            title="Queue all selected units for housekeeping cleaning"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Clean ({totalSelectedCount})</span>
          </Button>

          {/* Action 3: Mark Cleaned / Available */}
          {totalSelectedCount > 0 && (
            <Button
              variant="sage"
              size="sm"
              onClick={handleBulkAvailable}
              className="text-xs gap-1.5 bg-white border-[#800020] text-[#0D1C42]"
              title="Release selected units to Available — closes occupancy and blocking cleaning/maintenance work"
            >
              <CheckCircle2 className="w-3.5 h-3.5 text-[#16865B]" />
              <span>Available</span>
            </Button>
          )}
            </>
          )}

          {/* Action 4: Send selected rooms/beds to maintenance */}
          <Button
            variant="outline"
            size="sm"
            disabled={totalSelectedCount === 0}
            onClick={handleBulkMaintenance}
            className={`text-xs gap-1.5 ${
              totalSelectedCount > 0
                ? 'border-[#D64545] text-[#A83434] hover:bg-[#FAEBEB] bg-white'
                : 'opacity-50'
            }`}
            title="Flag all selected units as under maintenance"
          >
            <Wrench className="w-3.5 h-3.5" />
            <span>Maintenance ({totalSelectedCount})</span>
          </Button>
        </div>
      </Card>
      )}

          {!supportsUnits && zoneWashrooms.length === 0 && zoneUnits.length === 0 ? (
            <Card className="p-8 text-center border-dashed border-[#D6D3D1]">
              <div className="w-12 h-12 rounded-full bg-[#EAF1FB] text-[#2457A8] flex items-center justify-center mx-auto mb-3">
                <Layers className="w-6 h-6" />
              </div>
              <h3 className="font-display font-semibold text-lg text-[#0D1C42]">
                {zoneTypeLabel(zone)} zone — no guest units
              </h3>
              <p className="font-body text-sm text-[#667085] max-w-md mx-auto mt-1">
                This zone type doesn't contain rooms, dorms, beds, or washrooms. Manage its staff on the
                Zone Staff Board and its work through the Tasks module.
              </p>
              {zone.description && (
                <p className="text-xs text-[#667085] font-body mt-3">{zone.description}</p>
              )}
            </Card>
          ) : (
            <>
          {supportsUnits && (
          <>
          {/* Private Rooms in Zone */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display font-semibold text-lg text-[#0D1C42] flex items-center gap-2">
                <Building2 className="w-4 h-4 text-[#3478D4]" />
                <span>Private Rooms ({zoneRooms.length})</span>
              </h3>
              {zoneRooms.length > 0 && (
                <span className="text-[11px] text-[#667085]">
                  {isEmployee
                    ? 'Click checkbox to select rooms for a maintenance ticket'
                    : 'Click checkbox to multi-select for cleaning or checkout'}
                </span>
              )}
            </div>

            {zoneRooms.length === 0 ? (
              <Card className="p-6 text-center text-xs text-[#667085] border-dashed">
                No private rooms allocated to this zone yet. Allocate rooms from the Rooms & Dorms view.
              </Card>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
                {zoneRooms.map((room) => {
                  const isSelected = selectedRoomUids.includes(room.room_uid);
                  const vs = unitVisualState(room);
                  const darkTint = vs === 'purple' || vs === 'red' || vs === 'neutral';

                  return (
                    <Card
                      key={room.room_uid}
                      onClick={() => {
                        if (isMultiSelectMode) {
                          toggleRoomSelection(room.room_uid);
                        }
                      }}
                      className={`p-4 transition-all relative ${
                        UNIT_VISUAL_TINT[vs]
                      } ${
                        isSelected
                          ? 'border-[#800020] ring-2 ring-[#800020]/20 shadow-xs'
                          : 'hover:border-[#D6D3D1]'
                      } ${isMultiSelectMode ? 'cursor-pointer select-none' : ''}`}
                    >
                      {/* Top Row with Selection Checkbox & Room Number */}
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2.5">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleRoomSelection(room.room_uid);
                            }}
                            className={`w-5 h-5 rounded-[6px] border flex items-center justify-center transition-all cursor-pointer ${
                              isSelected
                                ? 'bg-[#800020] border-[#800020] text-white'
                                : 'bg-[#FFFFFF] border-[#D6D3D1] text-transparent hover:border-[#800020]'
                            }`}
                            title={isSelected ? 'Deselect room' : 'Select room'}
                          >
                            <Check className="w-3.5 h-3.5" strokeWidth={3} />
                          </button>

                          <span
                            className={`font-display font-bold text-lg ${
                              darkTint ? 'text-white' : 'text-[#0D1C42]'
                            }`}
                          >
                            {room.room_number}
                          </span>
                        </div>
                        <RoomStatusBadge status={room.status} />
                      </div>

                      <p
                        className={`text-xs font-medium ${
                          darkTint ? 'text-white' : 'text-[#0D1C42]'
                        }`}
                      >
                        {room.type}
                      </p>
                      <div
                        className={`text-[11px] mt-1.5 flex items-center justify-between ${
                          darkTint ? 'text-white/70' : 'text-[#667085]'
                        }`}
                      >
                        <span>{room.area_sqft} sq ft · {room.bed_count} Bed</span>
                        {room.current_guest ? (
                          <span
                            className={`font-medium truncate max-w-[120px] ${
                              darkTint ? 'text-white' : 'text-[#3478D4]'
                            }`}
                          >
                            {room.current_guest}
                          </span>
                        ) : (
                          <span
                            className={`italic ${
                              darkTint ? 'text-white/60' : 'text-[#667085]'
                            }`}
                          >
                            No guest assigned
                          </span>
                        )}
                      </div>

                      {/* Occupancy toggle + workflow actions — commands only,
                          ResourceStateService stays the authority */}
                      <div
                        className={`mt-3 pt-2.5 border-t flex items-center justify-between gap-2 flex-wrap ${
                          darkTint ? 'border-white/20' : 'border-[#F6F4F2]'
                        }`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {!isEmployee ? (
                          <OccupancyToggle
                            status={room.status}
                            isOccupied={room.is_occupied}
                            busy={busyUnits.has(`room:${room.room_uid}`)}
                            onCheckIn={() =>
                              void runUnitAction(`room:${room.room_uid}`, () =>
                                checkInRoom(room.room_uid)
                              )
                            }
                            onCheckOut={() =>
                              requestCheckout(
                                'room',
                                room.room_uid,
                                `Room ${room.room_number}`,
                                room.current_guest ?? null
                              )
                            }
                          />
                        ) : (
                          <span />
                        )}
                        <div className="flex items-center gap-1.5">
                          {!isEmployee && (
                            <>
                          <button
                            type="button"
                            disabled={
                              !isCleanable(room) ||
                              busyUnits.has(`room:${room.room_uid}`)
                            }
                            onClick={() =>
                              void runUnitAction(`room:${room.room_uid}`, () =>
                                bulkUpdateUnits({
                                  action: 'cleaning',
                                  roomUids: [room.room_uid],
                                })
                              )
                            }
                            className={`px-2 py-1 rounded-[7px] text-[11px] font-semibold border transition-colors focus:outline-none focus:ring-1 focus:ring-[#800020] ${
                              isCleanable(room) &&
                              !busyUnits.has(`room:${room.room_uid}`)
                                ? 'text-[#800020] border-[#EAD3DB] bg-[#FFFCFA] hover:bg-[#F7E9EE] cursor-pointer'
                                : 'text-[#CDC9C7] border-[#E7E5E4] bg-[#FFFFFF] cursor-not-allowed'
                            }`}
                            title={
                              room.status === 'cleaning'
                                ? 'Cleaning already in progress'
                                : (room.is_occupied ?? room.status === 'occupied')
                                  ? 'Queue this room for cleaning — guest stays checked in'
                                  : room.status === 'available'
                                    ? 'Queue this room for cleaning'
                                    : `Room is ${room.status} — cleaning not available`
                            }
                          >
                            Cleaning
                          </button>
                          <button
                            type="button"
                            disabled={
                              !(room.is_occupied ?? room.status === 'occupied') ||
                              busyUnits.has(`room:${room.room_uid}`)
                            }
                            onClick={() =>
                              requestCheckout(
                                'room',
                                room.room_uid,
                                `Room ${room.room_number}`,
                                room.current_guest ?? null
                              )
                            }
                            className={`px-2 py-1 rounded-[7px] text-[11px] font-semibold border transition-colors focus:outline-none focus:ring-1 focus:ring-[#A56514] ${
                              (room.is_occupied ?? room.status === 'occupied') &&
                              !busyUnits.has(`room:${room.room_uid}`)
                                ? 'text-[#A56514] border-[#F2D9AF] bg-[#FFFCFA] hover:bg-[#F2D9AF] cursor-pointer'
                                : 'text-[#CDC9C7] border-[#E7E5E4] bg-[#FFFFFF] cursor-not-allowed'
                            }`}
                            title={
                              room.is_occupied ?? room.status === 'occupied'
                                ? 'Check out the guest — room moves to cleaning'
                                : 'No active occupancy'
                            }
                          >
                            Checkout
                          </button>
                          <button
                            type="button"
                            disabled={
                              !(room.is_occupied ?? room.status === 'occupied') ||
                              busyUnits.has(`room:${room.room_uid}`)
                            }
                            onClick={() =>
                              setSwitchSource({
                                kind: 'room',
                                uid: room.room_uid,
                                label: `Room ${room.room_number}`,
                                guest: room.current_guest ?? null,
                              })
                            }
                            className={`px-2 py-1 rounded-[7px] text-[11px] font-semibold border transition-colors inline-flex items-center gap-1 focus:outline-none focus:ring-1 focus:ring-[#800020] ${
                              (room.is_occupied ?? room.status === 'occupied') &&
                              !busyUnits.has(`room:${room.room_uid}`)
                                ? 'text-[#800020] border-[#EAD3DB] bg-[#FFFCFA] hover:bg-[#F7E9EE] cursor-pointer'
                                : 'text-[#CDC9C7] border-[#E7E5E4] bg-[#FFFFFF] cursor-not-allowed'
                            }`}
                            title={
                              room.is_occupied ?? room.status === 'occupied'
                                ? 'Move the guest to another room or dorm bed'
                                : 'No active occupancy'
                            }
                          >
                            <ArrowRightLeft className="w-3 h-3" />
                            Switch
                          </button>
                          <button
                            type="button"
                            onClick={() => setRequestTarget({ room })}
                            className="px-2 py-1 rounded-[7px] text-[11px] font-semibold border transition-colors inline-flex items-center gap-1 cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#A56514] text-[#A56514] border-[#F2D9AF] bg-[#FFFCFA] hover:bg-[#F2D9AF]"
                            title="Raise a guest request — towel, extra mattress, etc. (urgent priority)"
                          >
                            <ConciergeBell className="w-3 h-3" />
                            Request
                          </button>
                            </>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              setMaintenanceTarget({ kind: 'room', room })
                            }
                            className={`px-2 py-1 rounded-[7px] text-[11px] font-semibold border transition-colors inline-flex items-center gap-1 cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#A83434] ${
                              ticketsByRoom.has(room.room_uid)
                                ? 'text-[#A83434] border-[#F0C8C8] bg-[#FAEBEB] hover:bg-[#FAEBEB]'
                                : 'text-[#667085] border-[#E7E5E4] bg-white hover:bg-[#FFFFFF]'
                            }`}
                            title={
                              ticketsByRoom.has(room.room_uid)
                                ? `Active ticket ${ticketsByRoom.get(room.room_uid)?.ticket_number} — click to view`
                                : 'Report a maintenance issue'
                            }
                          >
                            <Wrench className="w-3 h-3" />
                            {ticketsByRoom.has(room.room_uid) ? 'Maint ●' : 'Maint'}
                          </button>
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>

          {/* Dorms with Visual Bed Grid in Zone */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display font-semibold text-lg text-[#0D1C42] flex items-center gap-2">
                <Bed className="w-4 h-4 text-[#A56514]" />
                <span>Shared Dorms ({zoneDorms.length})</span>
              </h3>
              {allZoneBeds.length > 0 && (
                <span className="text-[11px] text-[#667085]">
                  {isEmployee
                    ? 'Click bed checkboxes to select beds for a maintenance ticket'
                    : 'Click bed checkboxes to multi-select for cleaning or checkout'}
                </span>
              )}
            </div>

            {zoneDorms.length === 0 ? (
              <Card className="p-6 text-center text-xs text-[#667085] border-dashed">
                No dormitories assigned to this zone yet.
              </Card>
            ) : (
              <div className="space-y-4">
                {zoneDorms.map((dorm) => {
                  // Only active beds participate in dorm-level selection —
                  // 'inactive' bunks are kept for history, not actionable.
                  const selectableBeds = dorm.beds.filter((b) => b.status !== 'inactive');
                  // Washrooms OWNED by this dorm (dorm_uid) — the dorm's
                  // `washroom` field is only a declared label until a real
                  // record is configured for it.
                  const dormWashrooms = currentPropertyWashrooms.filter(
                    (w) => w.dorm_uid === dorm.dorm_uid
                  );
                  const washroomAvailable = dorm.washroom !== 'No Washroom';
                  const dormBedUids = selectableBeds.map((b) => b.bed_uid);
                  const selectedBedsInDorm = dormBedUids.filter((id) =>
                    selectedBedUids.includes(id)
                  );
                  const allBedsInDormSelected =
                    selectableBeds.length > 0 &&
                    selectedBedsInDorm.length === selectableBeds.length;
                  const someBedsInDormSelected = selectedBedsInDorm.length > 0;

                  const toggleSelectAllDormBeds = () => {
                    if (selectableBeds.length === 0) return;
                    if (allBedsInDormSelected) {
                      setSelectedBedUids((prev) =>
                        prev.filter((id) => !dormBedUids.includes(id))
                      );
                    } else {
                      setSelectedBedUids((prev) =>
                        Array.from(new Set([...prev, ...dormBedUids]))
                      );
                    }
                  };

                  return (
                    <Card key={dorm.dorm_uid} className="p-5">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 pb-3 border-b border-[#F6F4F2]">
                        <div>
                          <div className="flex items-center gap-2">
                            <h4 className="font-display font-bold text-base text-[#0D1C42]">
                              {dorm.name}
                            </h4>
                            <Badge variant="lavender" size="sm">
                              {dorm.dorm_type}
                            </Badge>
                            <Badge variant="neutral" size="sm">
                              {dorm.washroom}
                            </Badge>
                            {(dorm.status === 'maintenance' || ticketsByDorm.has(dorm.dorm_uid)) && (
                              <Badge variant="red" size="sm">
                                <span className="w-1.5 h-1.5 rounded-full bg-[#D64545]" />
                                Maintenance
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-[#667085] font-body mt-0.5">
                            {dorm.beds.length} Total Bunk Spots
                          </p>
                          {(() => {
                            const occ = dorm.beds.filter(
                              (b) => b.is_occupied ?? b.status === 'occupied'
                            ).length;
                            const av = dorm.beds.filter((b) => b.status === 'available').length;
                            const cl = dorm.beds.filter((b) => b.status === 'cleaning').length;
                            const mt = dorm.beds.filter((b) => b.status === 'maintenance').length;
                            return (
                              <p className="text-[11px] font-body mt-0.5 flex items-center gap-2 flex-wrap">
                                <span className="font-semibold text-[#2457A8]">
                                  {occ}/{dorm.beds.length} occupied
                                </span>
                                <span className="text-[#0D1C42]">Available {av}</span>
                                <span className="text-[#A56514]">Cleaning {cl}</span>
                                <span className="text-[#A83434]">Maintenance {mt}</span>
                              </p>
                            );
                          })()}
                        </div>

                        {/* Dorm Quick Select & Direct Actions */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <label
                            className={`inline-flex items-center gap-2 px-2.5 py-1.5 rounded-[8px] border text-xs font-medium transition-colors select-none ${
                              selectableBeds.length === 0
                                ? 'opacity-50 cursor-not-allowed bg-[#FFFFFF] border-[#D6D3D1] text-[#667085]'
                                : allBedsInDormSelected
                                ? 'cursor-pointer bg-[#F7E9EE] border-[#800020] text-[#0D1C42]'
                                : 'cursor-pointer bg-[#FFFFFF] border-[#D6D3D1] text-[#667085] hover:bg-[#F6F4F2]'
                            }`}
                            title={
                              selectableBeds.length === 0
                                ? 'No active beds in this dorm'
                                : 'Select every active bed in this dorm'
                            }
                          >
                            <input
                              type="checkbox"
                              checked={allBedsInDormSelected}
                              disabled={selectableBeds.length === 0}
                              ref={(el) => {
                                if (el) {
                                  el.indeterminate =
                                    someBedsInDormSelected && !allBedsInDormSelected;
                                }
                              }}
                              onChange={toggleSelectAllDormBeds}
                              className="accent-[#800020] w-3.5 h-3.5 cursor-pointer disabled:cursor-not-allowed"
                            />
                            Select Entire Dorm
                          </label>

                          {!isEmployee && (
                            <>
                          {(() => {
                            // Actions scope to the clicked beds when a
                            // selection exists; otherwise the whole dorm.
                            const selectedInDorm = selectableBeds.filter((b) =>
                              selectedBedUids.includes(b.bed_uid)
                            );
                            const actionBeds = someBedsInDormSelected
                              ? selectedInDorm
                              : selectableBeds;
                            const scopeNote = someBedsInDormSelected
                              ? `${selectedInDorm.length} selected bed${selectedInDorm.length === 1 ? '' : 's'}`
                              : 'all beds';
                            const occupiedScope = actionBeds.filter(
                              (b) => b.is_occupied ?? b.status === 'occupied'
                            );
                            // Occupancy is a separate axis — occupied beds
                            // are cleanable; only operationally-busy beds
                            // (cleaning/maintenance/inactive) are excluded.
                            const cleanableScope = actionBeds.filter(
                              (b) => isCleanable(b)
                            );
                            return (
                              <>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={occupiedScope.length !== 1}
                            onClick={() => {
                              const b = occupiedScope[0];
                              setSwitchSource({
                                kind: 'bed',
                                uid: b.bed_uid,
                                label: `${dorm.name} — ${b.bed_number}`,
                                guest: b.guest_name ?? null,
                              });
                            }}
                            title={
                              occupiedScope.length === 1
                                ? `Move ${occupiedScope[0].guest_name || 'the guest'} to another room or bed`
                                : 'Select exactly one occupied bed to switch its guest'
                            }
                          >
                            <ArrowRightLeft className="w-3.5 h-3.5 mr-1" />
                            Switch
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={occupiedScope.length === 0}
                            onClick={() =>
                              bulkUpdateUnits({
                                action: 'checkout',
                                bedUids: occupiedScope.map((b) => b.bed_uid),
                              })
                            }
                            title={
                              occupiedScope.length === 0
                                ? `No occupied beds in ${scopeNote}`
                                : `Check out ${occupiedScope.length} occupied bed${occupiedScope.length === 1 ? '' : 's'} (${scopeNote})`
                            }
                          >
                            Check Out
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={cleanableScope.length === 0}
                            onClick={() =>
                              bulkUpdateUnits({
                                action: 'cleaning',
                                bedUids: cleanableScope.map((b) => b.bed_uid),
                              })
                            }
                            title={
                              cleanableScope.length === 0
                                ? 'No cleanable beds — all are already cleaning, under maintenance, or inactive'
                                : `Queue ${cleanableScope.length} bed${cleanableScope.length === 1 ? '' : 's'} for cleaning (${scopeNote})`
                            }
                          >
                            <Sparkles className="w-3.5 h-3.5 mr-1" />
                            Send to Clean
                          </Button>
                          <Button
                            variant="sage"
                            size="sm"
                            disabled={actionBeds.length === 0}
                            onClick={() =>
                              bulkUpdateUnits({
                                action: 'available',
                                bedUids: actionBeds.map((b) => b.bed_uid),
                              })
                            }
                            title={`Release ${scopeNote} to Available — closes occupancy and blocking cleaning/maintenance work`}
                          >
                            Available
                          </Button>
                              </>
                            );
                          })()}
                            </>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              if (someBedsInDormSelected) {
                                // Selection-scoped — a ticket per selected bed,
                                // or ONE dorm ticket when every bed is picked.
                                setMaintenanceTargetList(
                                  allBedsInDormSelected
                                    ? [{ kind: 'dorm', dorm }]
                                    : selectableBeds
                                        .filter((b) =>
                                          selectedBedUids.includes(b.bed_uid)
                                        )
                                        .map((bed) => ({
                                          kind: 'bed' as const,
                                          dorm,
                                          bed,
                                        }))
                                );
                                setSelectedBedUids((prev) =>
                                  prev.filter((id) => !dormBedUids.includes(id))
                                );
                              } else {
                                setMaintenanceTarget({ kind: 'dorm', dorm });
                              }
                            }}
                            title={
                              ticketsByDorm.has(dorm.dorm_uid)
                                ? `Active ticket ${ticketsByDorm.get(dorm.dorm_uid)?.ticket_number} — click to view`
                                : someBedsInDormSelected
                                ? allBedsInDormSelected
                                  ? 'Raise one maintenance ticket for the whole dorm'
                                  : 'Raise a maintenance ticket per selected bed'
                                : 'Send the whole dorm to maintenance'
                            }
                            className={
                              ticketsByDorm.has(dorm.dorm_uid)
                                ? 'border-[#D64545] text-[#A83434]'
                                : ''
                            }
                          >
                            <Wrench className="w-3.5 h-3.5 mr-1" />
                            {ticketsByDorm.has(dorm.dorm_uid)
                              ? 'Maintenance ●'
                              : someBedsInDormSelected
                              ? `Maintenance (${selectedBedsInDorm.length})`
                              : 'Maintenance'}
                          </Button>
                        </div>
                      </div>

                      {/* Visual Bed Grid with Interactive Checkbox Selection */}
                      <div>
                        <div className="flex items-center justify-between mb-2.5">
                          <span className="text-[11px] font-semibold text-[#667085] uppercase tracking-wider block font-body">
                            Visual Bed Grid — Click a bed to select it
                          </span>
                          {selectedBedsInDorm.length > 0 && (
                            <span className="text-xs font-semibold text-[#800020]">
                              {selectedBedsInDorm.length}/{selectableBeds.length} beds selected
                            </span>
                          )}
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                          {/* Attached washroom facility tile — leads the bed
                              grid, same as the Rooms & Dorms view. A declared
                              facility (no Washroom row yet) still renders so
                              the facility is visible and configurable. */}
                          {washroomAvailable &&
                            (dormWashrooms.length > 0 ? (
                              dormWashrooms.map((w) => {
                                const counts = fixtureCountsFor(w);
                                const totalFixtures = (
                                  Object.values(counts) as number[]
                                ).reduce((a, b) => a + b, 0);
                                const breakdown = Object.keys(counts)
                                  .filter((k) => counts[k] > 0)
                                  .map(
                                    (k) =>
                                      `${counts[k]} ${fixtureMeta(k, isCustomKind(k)).plural}`
                                  )
                                  .join(' · ');
                                return (
                                  <button
                                    key={w.washroom_uid}
                                    type="button"
                                    onClick={() =>
                                      setWashroomDetail({
                                        washroom: w,
                                        declaredName: null,
                                        dorm,
                                      })
                                    }
                                    className={`p-2.5 rounded-[12px] border text-left transition-all cursor-pointer hover:shadow-xs ${
                                      WASHROOM_TILE
                                    }`}
                                    title={`${w.name} — view facility details`}
                                  >
                                    <div className="flex items-center justify-between text-xs font-semibold">
                                      <span className="flex items-center gap-1 min-w-0">
                                        <Bath className="w-3 h-3 shrink-0" />
                                        <span className="truncate">{w.name}</span>
                                      </span>
                                      <span className="w-2 h-2 rounded-full bg-current shrink-0" />
                                    </div>
                                    <span className="text-[10px] font-medium capitalize block mt-1">
                                      {w.status.replace('_', ' ')}
                                    </span>
                                    <span className="text-[9px] opacity-70 block leading-tight mt-0.5">
                                      {totalFixtures} fixture{totalFixtures === 1 ? '' : 's'}
                                      {breakdown ? ` · ${breakdown}` : ''}
                                    </span>
                                  </button>
                                );
                              })
                            ) : (
                              <button
                                type="button"
                                onClick={() =>
                                  setWashroomDetail({
                                    washroom: null,
                                    declaredName: dorm.washroom,
                                    dorm,
                                  })
                                }
                                className="p-2.5 rounded-[12px] border text-left bg-[#EAF1FB] border-[#C3D6F0] text-[#2457A8] transition-all cursor-pointer hover:shadow-xs"
                                title={`${dorm.washroom} — declared facility`}
                              >
                                <div className="flex items-center justify-between text-xs font-semibold">
                                  <span className="flex items-center gap-1 min-w-0">
                                    <Bath className="w-3 h-3 shrink-0" />
                                    <span className="truncate">{dorm.washroom}</span>
                                  </span>
                                  <span className="w-2 h-2 rounded-full bg-current shrink-0" />
                                </div>
                                <span className="text-[9px] opacity-70 block leading-tight mt-1">
                                  Declared facility — no washroom record
                                </span>
                                <span className="text-[9px] font-semibold opacity-80 block mt-0.5">
                                  View details →
                                </span>
                              </button>
                            ))}
                          {dorm.beds.map((bed) => {
                            const isBedSelectable = bed.status !== 'inactive';
                            const isBedSelected = selectedBedUids.includes(bed.bed_uid);
                            // canonical resolver — the server's visual_state
                            // drives the tint when present
                            const tileBg =
                              UNIT_VISUAL_TINT[unitVisualState(bed)];

                            return (
                              <div
                                key={bed.bed_uid}
                                onClick={() => {
                                  if (isBedSelectable) toggleBedSelection(bed.bed_uid);
                                }}
                                className={`p-2.5 rounded-[12px] border ${tileBg} transition-all select-none relative ${
                                  isBedSelectable
                                    ? 'cursor-pointer hover:shadow-xs'
                                    : 'cursor-not-allowed opacity-75'
                                } ${
                                  isBedSelected
                                    ? 'ring-2 ring-[#800020] border-[#800020] shadow-xs'
                                    : ''
                                }`}
                                title={isBedSelectable ? undefined : 'Inactive bed — not selectable'}
                              >
                                <div className="flex items-center justify-between text-xs font-semibold">
                                  <span>{bed.bed_number}</span>

                                  {/* Selection Checkbox */}
                                  <button
                                    type="button"
                                    disabled={!isBedSelectable}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (isBedSelectable) toggleBedSelection(bed.bed_uid);
                                    }}
                                    className={`w-4 h-4 rounded-[4px] border flex items-center justify-center transition-all ${
                                      !isBedSelectable
                                        ? 'cursor-not-allowed bg-[#E7E5E4] border-[#D6D3D1] text-transparent'
                                        : isBedSelected
                                        ? 'cursor-pointer bg-[#800020] border-[#800020] text-white'
                                        : 'cursor-pointer bg-white/80 border-[#D6D3D1] text-transparent hover:border-[#800020]'
                                    }`}
                                    title={
                                      !isBedSelectable
                                        ? 'Inactive bed'
                                        : isBedSelected
                                        ? 'Deselect bed'
                                        : 'Select bed'
                                    }
                                  >
                                    <Check className="w-3 h-3" strokeWidth={3} />
                                  </button>
                                </div>

                                <span className="text-[10px] font-medium capitalize block mt-1">
                                  {bed.is_occupied && bed.status !== 'occupied'
                                    ? `occupied · ${bed.status}`
                                    : bed.status}
                                </span>
                                {bed.guest_name ? (
                                  <span className="text-[9px] truncate block opacity-85 mt-0.5 font-medium">
                                    {bed.guest_name}
                                  </span>
                                ) : (
                                  <span className="text-[9px] truncate block opacity-60 mt-0.5">
                                    No guest
                                  </span>
                                )}

                                {/* Occupancy toggle + workflow actions — status
                                    never changes by clicking the tile itself */}
                                <div
                                  className="mt-1.5 pt-1.5 border-t border-current/10 flex items-center justify-between gap-1"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {!isEmployee ? (
                                    <>
                                      <OccupancyToggle
                                        status={bed.status}
                                        isOccupied={bed.is_occupied}
                                        compact
                                        busy={busyUnits.has(`bed:${bed.bed_uid}`)}
                                        onCheckIn={() =>
                                          void runUnitAction(`bed:${bed.bed_uid}`, () =>
                                            checkInBed(bed.bed_uid)
                                          )
                                        }
                                        onCheckOut={() =>
                                          requestCheckout(
                                            'bed',
                                            bed.bed_uid,
                                            `${dorm.name} — ${bed.bed_number}`,
                                            bed.guest_name ?? null
                                          )
                                        }
                                      />
                                      {(bed.is_occupied || bed.status === 'occupied') && (
                                        <button
                                          type="button"
                                          onClick={() =>
                                            setSwitchSource({
                                              kind: 'bed',
                                              uid: bed.bed_uid,
                                              label: `${dorm.name} — ${bed.bed_number}`,
                                              guest: bed.guest_name ?? null,
                                            })
                                          }
                                          className="p-1 rounded-[6px] border transition-colors inline-flex items-center cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#800020] text-[#800020] border-[#EAD3DB] bg-[#FFFCFA] hover:bg-[#F7E9EE]"
                                          title="Switch — move the guest to another room or bed"
                                        >
                                          <ArrowRightLeft className="w-3 h-3" />
                                        </button>
                                      )}
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setRequestTarget({ dorm, bed })
                                        }
                                        className="p-1 rounded-[6px] border transition-colors inline-flex items-center cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#A56514] text-[#A56514] border-[#F2D9AF] bg-[#FFFCFA] hover:bg-[#F2D9AF]"
                                        title="Raise a guest request for this bed (urgent priority)"
                                      >
                                        <ConciergeBell className="w-3 h-3" />
                                      </button>
                                    </>
                                  ) : (
                                    <span />
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
          </>
          )}
          {unitsSection}
          {supportsUnits && washroomSection}
            </>
          )}
        </div>

      {/* Maintenance ticket flow — same modal as the Rooms view */}
      {(maintenanceTarget || maintenanceTargetList) && (
        <CreateMaintenanceModal
          targets={maintenanceTargetList ?? [maintenanceTarget!]}
          activeTicket={
            maintenanceTargetList || !maintenanceTarget
              ? null
              : maintenanceTarget.kind === 'room'
                ? ticketsByRoom.get(maintenanceTarget.room.room_uid) || null
                : maintenanceTarget.kind === 'dorm'
                  ? ticketsByDorm.get(maintenanceTarget.dorm.dorm_uid) || null
                  : maintenanceTarget.kind === 'washroom'
                    ? ticketsByWashroom.get(maintenanceTarget.washroom.washroom_uid) || null
                    : ticketsByBed.get(maintenanceTarget.bed.bed_uid) || null
          }
          onClose={() => {
            setMaintenanceTarget(null);
            setMaintenanceTargetList(null);
          }}
          onViewTicket={() => {
            clearSelection();
            navigate(`/property/${activePropertyUid}/operations/tasks?tab=maintenance`);
          }}
        />
      )}

      {/* Guest request flow — same modal as the Rooms view */}
      {/* Guest switch — move an open occupancy to any available unit */}
      <SwitchGuestModal
        isOpen={!!switchSource}
        source={switchSource}
        onClose={() => setSwitchSource(null)}
      />

      {requestTarget && (
        <RequestItemModal
          isOpen={!!requestTarget}
          room={requestTarget.room}
          dorm={requestTarget.dorm}
          bed={requestTarget.bed}
          onClose={() => setRequestTarget(null)}
        />
      )}

      {/* Washroom facility detail — real record shows fixtures/activity; a
          declared-only facility offers Configure (managers) to create it */}
      {washroomDetail && (
        <WashroomDetailModal
          key={
            washroomDetail.washroom?.washroom_uid ??
            `${washroomDetail.dorm?.dorm_uid}:declared`
          }
          washroom={washroomDetail.washroom}
          declaredName={washroomDetail.declaredName}
          dorm={washroomDetail.dorm}
          zone={zone}
          onClose={() => setWashroomDetail(null)}
          onEdit={
            isEmployee
              ? undefined
              : (w) => {
                  setEditingWashroom(w);
                  setWashroomDefaults(undefined);
                  setWashroomModalOpen(true);
                }
          }
          onConfigure={
            isEmployee
              ? undefined
              : () => {
                  // Declared facility → create a DORM-OWNED washroom record
                  setEditingWashroom(null);
                  setWashroomDefaults({
                    name: `${washroomDetail.dorm?.name} - Washroom`,
                    dorm_uid: washroomDetail.dorm?.dorm_uid,
                  });
                  setWashroomDetail(null);
                  setWashroomModalOpen(true);
                }
          }
        />
      )}

      {/* Checkout — closes the occupancy; backend queues cleaning */}
      <ConfirmationDialog
        isOpen={!!checkoutTarget}
        onClose={() => setCheckoutTarget(null)}
        onConfirm={confirmCheckout}
        entityType={checkoutTarget?.kind === 'bed' ? 'Bed' : 'Room'}
        entityName={checkoutTarget?.label ?? ''}
        title={`Check out ${checkoutTarget?.label ?? ''}?`}
        warningTitle="This will close the active occupancy."
        impactMessage={
          checkoutTarget?.guest
            ? `${checkoutTarget.guest} will be checked out and the ${checkoutTarget.kind} will move to Cleaning — a housekeeping task is generated automatically.`
            : `The ${checkoutTarget?.kind ?? 'unit'} will move to Cleaning and a housekeeping task is generated automatically.`
        }
        promptMessage={`Are you sure you want to check out ${checkoutTarget?.label ?? 'this unit'}?`}
        confirmLabel="Check Out"
        confirmVariant="primary"
        isLoading={
          !!checkoutTarget &&
          busyUnits.has(`${checkoutTarget.kind}:${checkoutTarget.uid}`)
        }
      />

      {createModal === 'room' && (
        <CreateRoomModal isOpen defaultZoneUid={zone.zone_uid} onClose={() => setCreateModal(null)} />
      )}
      {createModal === 'bulkRoom' && (
        <BulkCreateRoomsModal isOpen defaultZoneUid={zone.zone_uid} onClose={() => setCreateModal(null)} />
      )}
      {createModal === 'dorm' && (
        <CreateDormModal isOpen defaultZoneUid={zone.zone_uid} onClose={() => setCreateModal(null)} />
      )}
      {createModal === 'bulkDorm' && (
        <BulkCreateDormsModal isOpen defaultZoneUid={zone.zone_uid} onClose={() => setCreateModal(null)} />
      )}
      {createModal === 'bulkWashroom' && (
        <BulkCreateWashroomsModal isOpen defaultZoneUid={zone.zone_uid} onClose={() => setCreateModal(null)} />
      )}

      {washroomModalOpen && (
        <WashroomModal
          isOpen={washroomModalOpen}
          washroom={editingWashroom}
          defaults={washroomDefaults}
          onClose={() => {
            setWashroomModalOpen(false);
            setEditingWashroom(null);
            setWashroomDefaults(undefined);
          }}
        />
      )}
    </div>
  );
};
