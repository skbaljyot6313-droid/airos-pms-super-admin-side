import React, { useState } from 'react';
import {
  Layers,
  Plus,
  MoreVertical,
  Edit,
  Trash2,
  Building2,
  Bed,
  Users,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Compass,
  MapPin,
  CheckCircle2,
  ExternalLink,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { CreateZoneModal } from './CreateZoneModal';
import { CreateAreaModal } from './CreateAreaModal';
import { CreateSectionModal } from './CreateSectionModal';
import { ZoneWorkspace } from './ZoneWorkspace';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';
import { Zone, Area, Section, ZoneType, ZoneCustomUnit } from '../../types';
import { zoneTypeLabel, slugifyZoneType, ZONE_TYPE_OPTIONS, zoneSupportsUnits, unitIcon, normalizeZoneUnits } from '../../lib/zoneUtils';
import { isEmployeeAssignable } from '../../lib/employeeUtils';

// Premade unit suggestions — shown in the styled picker, still free-typable.
const UNIT_SUGGESTIONS = [
  'Tandoor', 'Walk-in freezer', 'Chiller', 'Double-door fridge', 'Deep fryer',
  'Wet grinder', 'Mixer', 'Blender', 'Oven', 'Gas stove / range', 'Microwave',
  'Tawa / griddle', 'Dough kneader', 'Hot case / bain-marie', 'Prep counter',
  'Cutting station', 'Exhaust hood', 'Sink', 'Dishwasher', 'Ice machine',
  'Coffee machine', 'Tea / water boiler', 'Toaster', 'Storage rack',
  'Gas bank / manifold', 'Fire extinguisher', 'Washing machine', 'Dryer',
  'Iron press', 'AC unit', 'Ceiling fan', 'CCTV camera', 'TV',
  'Reception desk', 'POS terminal', 'Printer', 'Computer', 'Server rack',
  'Treadmill', 'Gym bench', 'Weight rack', 'Pool pump', 'Pool filter',
  'Sun lounger', 'Table', 'Chair', 'Sofa', 'Locker', 'Generator',
  'Inverter / UPS', 'Water tank', 'Lift / elevator',
];

export const ZonesView: React.FC = () => {
  const {
    currentPropertySections,
    currentPropertyAreas,
    currentPropertyZones,
    currentPropertyRooms,
    currentPropertyDorms,
    currentPropertyEmployees,
    openedZoneUid,
    setOpenedZoneUid,
    deleteZone,
    updateZone,
    deleteArea,
    updateArea,
    deleteSection,
    updateSection,
    activeProperty,
  } = useApp();

  // Modals & Dialogs
  const [createZoneModalOpen, setCreateZoneModalOpen] = useState(false);
  const [createAreaModalOpen, setCreateAreaModalOpen] = useState(false);
  const [activeAreaForNewZone, setActiveAreaForNewZone] = useState<string | undefined>(undefined);

  // Menu dropdowns
  const [activeMenuZoneUid, setActiveMenuZoneUid] = useState<string | null>(null);
  const [activeMenuAreaUid, setActiveMenuAreaUid] = useState<string | null>(null);

  // Deletions
  const [zoneToDelete, setZoneToDelete] = useState<Zone | null>(null);
  const [areaToDelete, setAreaToDelete] = useState<Area | null>(null);

  // Edit Zone Modal state
  const [editingZone, setEditingZone] = useState<Zone | null>(null);
  const [editName, setEditName] = useState('');
  const [editAreaUid, setEditAreaUid] = useState<string>('');
  const [editZoneType, setEditZoneType] = useState<ZoneType>('stay');
  const [editCustomType, setEditCustomType] = useState('');
  const [editDescription, setEditDescription] = useState('');

  // Edit Area Modal state
  const [editingArea, setEditingArea] = useState<Area | null>(null);
  const [editAreaName, setEditAreaName] = useState('');
  const [editAreaDescription, setEditAreaDescription] = useState('');

  // Section management
  const [createSectionModalOpen, setCreateSectionModalOpen] = useState(false);
  const [selectedSectionUid, setSelectedSectionUid] = useState('');
  const [activeMenuSectionUid, setActiveMenuSectionUid] = useState<string | null>(null);
  const [editingSection, setEditingSection] = useState<Section | null>(null);
  const [editSectionName, setEditSectionName] = useState('');
  const [editSectionDescription, setEditSectionDescription] = useState('');
  const [sectionToDelete, setSectionToDelete] = useState<Section | null>(null);

  // Edit area — section assignment
  const [editAreaSectionUid, setEditAreaSectionUid] = useState('');

  // Collapsed area groups
  const [collapsedAreas, setCollapsedAreas] = useState<Record<string, boolean>>({});

  // Collapsed "Units" bars on non-stay zone cards + inline add drafts
  const [expandedUnitZones, setExpandedUnitZones] = useState<Record<string, boolean>>({});
  const [unitDrafts, setUnitDrafts] = useState<Record<string, string>>({});
  const [unitQtyDrafts, setUnitQtyDrafts] = useState<Record<string, number>>({});
  const [unitSuggestOpen, setUnitSuggestOpen] = useState<Record<string, boolean>>({});

  // If a zone is actively opened, show its dedicated workspace
  const activeZone = currentPropertyZones.find((z) => z.zone_uid === openedZoneUid);
  if (activeZone) {
    return <ZoneWorkspace zone={activeZone} onBack={() => setOpenedZoneUid(null)} />;
  }

  // Toggle collapse state for an area section
  const toggleAreaCollapse = (areaKey: string) => {
    setCollapsedAreas((prev) => ({
      ...prev,
      [areaKey]: !prev[areaKey],
    }));
  };

  // Handlers for Zone Edit
  const handleStartEditZone = (zone: Zone) => {
    setEditingZone(zone);
    setEditName(zone.name);
    setEditAreaUid(zone.area_uid || '');
    const isPresetType = ZONE_TYPE_OPTIONS.some((o) => o.value === zone.zone_type);
    setEditZoneType(isPresetType ? zone.zone_type || 'stay' : 'stay');
    setEditCustomType(isPresetType ? '' : zoneTypeLabel(zone));
    setEditDescription(zone.description || '');
    setActiveMenuZoneUid(null);
  };

  const handleSaveEditZone = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingZone || !editName.trim()) return;
    const chosenArea = currentPropertyAreas.find((a) => a.area_uid === editAreaUid);
    const chosenSection = currentPropertySections.find(
      (s) => s.section_uid === chosenArea?.section_uid
    );
    const editSectionDriven =
      !!chosenSection && chosenSection.name.trim().toLowerCase() !== 'stay';
    try {
      await updateZone(editingZone.zone_uid, {
        name: editName.trim(),
        area_uid: editAreaUid ? editAreaUid : null,
        floor: chosenArea ? chosenArea.name : undefined,
        zone_type: editSectionDriven
          ? ((slugifyZoneType(editCustomType) ||
              slugifyZoneType(chosenSection.name) ||
              'common') as ZoneType)
          : editZoneType,
        description: editDescription.trim(),
      });
      setEditingZone(null);
    } catch {
      // Error toast handled by the context layer — keep dialog open
    }
  };

  // Handlers for Area Edit
  const handleStartEditArea = (area: Area) => {
    setEditingArea(area);
    setEditAreaName(area.name);
    setEditAreaSectionUid(area.section_uid || '');
    setEditAreaDescription(area.description || '');
    setActiveMenuAreaUid(null);
  };

  const handleSaveEditArea = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingArea || !editAreaName.trim()) return;
    try {
      await updateArea(editingArea.area_uid, {
        name: editAreaName.trim(),
        section_uid: editAreaSectionUid || null,
        description: editAreaDescription.trim() || undefined,
      });
      setEditingArea(null);
    } catch {
      // Error toast handled by the context layer — keep dialog open
    }
  };

  // Handlers for Section Edit
  const handleStartEditSection = (section: Section) => {
    setEditingSection(section);
    setEditSectionName(section.name);
    setEditSectionDescription(section.description || '');
    setActiveMenuSectionUid(null);
  };

  const handleSaveEditSection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSection || !editSectionName.trim()) return;
    try {
      await updateSection(editingSection.section_uid, {
        name: editSectionName.trim(),
        description: editSectionDescription.trim() || undefined,
      });
      setEditingSection(null);
    } catch {
      // Error toast handled by the context layer — keep dialog open
    }
  };

  // Group zones by area
  // Areas defined in property
  const areaGroups = currentPropertyAreas.map((area) => {
    // A zone belongs to this area if either zone.area_uid === area.area_uid OR floor matches area name
    const zonesInArea = currentPropertyZones.filter(
      (z) => z.area_uid === area.area_uid || (!z.area_uid && z.floor === area.name)
    );
    return {
      area,
      zones: zonesInArea,
    };
  });

  // Zones without matching area (unassigned / custom floor)
  const unassignedZones = currentPropertyZones.filter((z) => {
    if (z.area_uid && currentPropertyAreas.some((a) => a.area_uid === z.area_uid)) {
      return false;
    }
    if (!z.area_uid && currentPropertyAreas.some((a) => a.name === z.floor)) {
      return false;
    }
    return true;
  });

  // The property-bar Section selector scopes which areas render below —
  // '' shows everything, a section uid scopes to that section, and
  // UNGROUPED shows only areas (and standalone zones) with no section.
  const UNGROUPED_SECTION = '__ungrouped__';
  const selectedSection = currentPropertySections.find(
    (s) => s.section_uid === selectedSectionUid
  );
  const hasUnsectionedAreas = areaGroups.some((g) => !g.area.section_uid);
  const visibleAreaGroups = areaGroups.filter((g) => {
    if (!selectedSectionUid) return true;
    if (selectedSectionUid === UNGROUPED_SECTION) return !g.area.section_uid;
    return g.area.section_uid === selectedSectionUid;
  });
  const showUnassignedGroup =
    unassignedZones.length > 0 &&
    (!selectedSectionUid || selectedSectionUid === UNGROUPED_SECTION);

  // Renders an individual Zone Card
  const renderZoneCard = (zone: Zone) => {
    const zoneRooms = currentPropertyRooms.filter((r) => r.zone_uid === zone.zone_uid);
    const zoneDorms = currentPropertyDorms.filter((d) => d.zone_uid === zone.zone_uid);
    const zoneEmployees = currentPropertyEmployees.filter(
      (e) => e.zone_uid === zone.zone_uid && isEmployeeAssignable(e)
    );

    const zoneDormBeds = zoneDorms.reduce((acc, d) => acc + d.beds.length, 0);
    const zoneRoomBeds = zoneRooms.reduce((acc, r) => acc + r.bed_count, 0);
    const zoneTotalBeds = zoneDormBeds + zoneRoomBeds;

    const isMenuOpen = activeMenuZoneUid === zone.zone_uid;

    // Resolve Area name directly if present
    const referencedArea = currentPropertyAreas.find((a) => a.area_uid === zone.area_uid);

    // Non-stay zones carry a free-text unit list (freezer, fryer, counter…)
    const zoneUnits: ZoneCustomUnit[] = normalizeZoneUnits(zone.custom_units);
    const totalUnits = zoneUnits.reduce((a, u) => a + (u.qty || 1), 0);
    const unitsOpen = !!expandedUnitZones[zone.zone_uid];
    const unitDraft = unitDrafts[zone.zone_uid] || '';
    const unitQty = unitQtyDrafts[zone.zone_uid] ?? 1;
    const setUnitDraft = (v: string) =>
      setUnitDrafts((p) => ({ ...p, [zone.zone_uid]: v }));
    const setUnitQty = (v: number) =>
      setUnitQtyDrafts((p) => ({ ...p, [zone.zone_uid]: v }));
    const saveUnits = (next: ZoneCustomUnit[]) =>
      updateZone(zone.zone_uid, { custom_units: next });
    const addUnit = () => {
      const v = unitDraft.trim();
      if (!v) return;
      saveUnits([...zoneUnits, { name: v, qty: Math.max(1, unitQty | 0 || 1) }]);
      setUnitDraft('');
      setUnitQty(1);
    };
    const setUnitQuantity = (idx: number, qty: number) =>
      saveUnits(
        zoneUnits.map((u, j) =>
          j === idx ? { ...u, qty: Math.max(1, Math.min(qty | 0 || 1, 9999)) } : u
        )
      );
    const removeUnit = (idx: number) =>
      saveUnits(zoneUnits.filter((_, j) => j !== idx));

    return (
      <Card
        key={zone.zone_uid}
        hoverEffect
        className="flex flex-col justify-between group relative bg-white border-[#E7E5E4]"
      >
        <div>
          {/* Top Bar with ID and Menu */}
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-[#F6F4F2] text-[#667085] border border-[#E7E5E4]">
                {zone.code}
              </span>
              <Badge variant={zoneSupportsUnits(zone) ? 'sage' : 'lavender'} size="sm">
                {zoneTypeLabel(zone)}
              </Badge>
              {referencedArea && (
                <span className="text-[11px] font-medium text-[#800020] bg-[#F7E9EE] px-2 py-0.5 rounded-[6px] border border-[#EAD3DB] truncate max-w-[140px]">
                  {referencedArea.name}
                </span>
              )}
            </div>

            {/* 3-Dots Action Menu */}
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveMenuZoneUid(isMenuOpen ? null : zone.zone_uid);
                }}
                className="p-1 rounded-[8px] text-[#667085] hover:text-[#0D1C42] hover:bg-[#F6F4F2] transition-colors cursor-pointer"
                title="Zone options"
              >
                <MoreVertical className="w-4 h-4" />
              </button>

              {isMenuOpen && (
                <div className="absolute right-0 top-8 z-30 w-44 bg-white border border-[#E7E5E4] rounded-[12px] shadow-lg py-1">
                  <button
                    onClick={() => {
                      setActiveMenuZoneUid(null);
                      setOpenedZoneUid(zone.zone_uid);
                    }}
                    className="w-full text-left px-3.5 py-2 text-xs font-medium text-[#0D1C42] hover:bg-[#FFFFFF] flex items-center gap-2 cursor-pointer"
                  >
                    <ExternalLink className="w-3.5 h-3.5 text-[#667085]" />
                    <span>Open Workspace</span>
                  </button>
                  <button
                    onClick={() => handleStartEditZone(zone)}
                    className="w-full text-left px-3.5 py-2 text-xs font-medium text-[#0D1C42] hover:bg-[#FFFFFF] flex items-center gap-2 cursor-pointer"
                  >
                    <Edit className="w-3.5 h-3.5 text-[#667085]" />
                    <span>Edit Details</span>
                  </button>
                  <button
                    onClick={() => {
                      setActiveMenuZoneUid(null);
                      setZoneToDelete(zone);
                    }}
                    className="w-full text-left px-3.5 py-2 text-xs font-medium text-[#A83434] hover:bg-[#FAEBEB] flex items-center gap-2 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete Zone</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Zone Name */}
          <h3
            onClick={() => setOpenedZoneUid(zone.zone_uid)}
            className="font-display font-bold text-lg text-[#0D1C42] group-hover:text-[#800020] transition-colors cursor-pointer tracking-tight"
          >
            {zone.name}
          </h3>

          {zone.description && (
            <p className="text-xs text-[#667085] font-body mt-1 line-clamp-2">
              {zone.description}
            </p>
          )}

          {/* Formatted metrics string — stay zones show unit counts; other zone
              types are bed-free so only staff/tasks are meaningful */}
          <div className="my-4 p-3 bg-[#FFFFFF] border border-[#E7E5E4] rounded-[10px] text-xs text-[#0D1C42] font-body flex items-center justify-between flex-wrap gap-2">
            {zoneSupportsUnits(zone) ? (
              <>
                <div className="flex items-center gap-1.5">
                  <Building2 className="w-3.5 h-3.5 text-[#3478D4]" />
                  <span><strong>{zoneRooms.length}</strong> Rooms</span>
                </div>
                <span className="text-[#CDC9C7]">·</span>
                <div className="flex items-center gap-1.5">
                  <Bed className="w-3.5 h-3.5 text-[#A56514]" />
                  <span><strong>{zoneDorms.length}</strong> Dorms</span>
                </div>
                <span className="text-[#CDC9C7]">·</span>
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#3478D4]" />
                  <span><strong>{zoneTotalBeds}</strong> Beds</span>
                </div>
                <span className="text-[#CDC9C7]">·</span>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-[#7554C8]" />
                  <span><strong>{totalUnits}</strong> {totalUnits === 1 ? 'Unit' : 'Units'}</span>
                </div>
                <span className="text-[#CDC9C7]">·</span>
              </>
            )}
            <div className="flex items-center gap-1.5 text-[#0D1C42]">
              <Users className="w-3.5 h-3.5" />
              <span><strong>{zoneEmployees.length}</strong> Staff</span>
            </div>
          </div>

          {/* Collapsible unit list — non-stay zones only */}
          {!zoneSupportsUnits(zone) && (
            <div className="mb-4 border border-[#E7E5E4] rounded-[10px]">
              <button
                type="button"
                onClick={() =>
                  setExpandedUnitZones((p) => ({
                    ...p,
                    [zone.zone_uid]: !unitsOpen,
                  }))
                }
                className="w-full flex items-center justify-between px-3 py-2 bg-[#FFFCFA] hover:bg-[#F6F4F2] rounded-t-[10px] transition-colors cursor-pointer"
              >
                <span className="text-xs font-semibold text-[#0D1C42] flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-[#7554C8]" />
                  Units
                  <span className="text-[#667085] font-normal">
                    {zoneUnits.length === 0
                      ? '— add equipment, counters, stations…'
                      : `${totalUnits} total`}
                  </span>
                </span>
                {unitsOpen ? (
                  <ChevronDown className="w-4 h-4 text-[#667085]" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-[#667085]" />
                )}
              </button>
              {unitsOpen && (
                <div className="p-2.5 pt-1.5 space-y-1 border-t border-[#F6F4F2]">
                  {zoneUnits.map((u, i) => {
                    const Icon = unitIcon(u.name);
                    return (
                    <div
                      key={`${u.name}-${i}`}
                      className="flex items-center justify-between gap-2 px-2 py-1 rounded-[6px] hover:bg-[#FFFCFA] group/unit"
                    >
                      <span className="text-xs text-[#0D1C42] truncate flex-1 min-w-0 flex items-center gap-1.5">
                        <span className="w-5 h-5 rounded-[5px] bg-[#F7E9EE] text-[#800020] flex items-center justify-center shrink-0">
                          <Icon className="w-3 h-3" />
                        </span>
                        {u.name}
                      </span>
                      <span className="flex items-center gap-0.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => setUnitQuantity(i, u.qty - 1)}
                          disabled={u.qty <= 1}
                          className="w-5 h-5 flex items-center justify-center rounded-[5px] border border-[#E7E5E4] text-[#667085] hover:border-[#800020] hover:text-[#800020] disabled:opacity-35 text-xs font-semibold transition-colors cursor-pointer"
                          title="Decrease quantity"
                        >
                          −
                        </button>
                        <input
                          type="number"
                          min={1}
                          max={9999}
                          value={u.qty}
                          onChange={(e) => setUnitQuantity(i, parseInt(e.target.value, 10))}
                          className="w-10 px-0.5 py-0.5 text-center bg-white border border-[#E7E5E4] rounded-[5px] text-xs font-semibold text-[#0D1C42] focus:outline-none focus:ring-1 focus:ring-[#800020]/30 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <button
                          type="button"
                          onClick={() => setUnitQuantity(i, u.qty + 1)}
                          disabled={u.qty >= 9999}
                          className="w-5 h-5 flex items-center justify-center rounded-[5px] border border-[#E7E5E4] text-[#667085] hover:border-[#800020] hover:text-[#800020] disabled:opacity-35 text-xs font-semibold transition-colors cursor-pointer"
                          title="Increase quantity"
                        >
                          +
                        </button>
                      </span>
                      <button
                        type="button"
                        onClick={() => removeUnit(i)}
                        title="Remove unit"
                        className="p-0.5 rounded text-[#98A2B3] hover:text-[#D64545] opacity-0 group-hover/unit:opacity-100 transition-opacity cursor-pointer shrink-0"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                    );
                  })}
                  <div className="flex items-center gap-1.5 pt-1">
                    <div className="relative flex-1 min-w-0">
                      <input
                        type="text"
                        value={unitDraft}
                        onFocus={() =>
                          setUnitSuggestOpen((p) => ({ ...p, [zone.zone_uid]: true }))
                        }
                        onBlur={() =>
                          setUnitSuggestOpen((p) => ({ ...p, [zone.zone_uid]: false }))
                        }
                        onChange={(e) => setUnitDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addUnit();
                          }
                          if (e.key === 'Escape') {
                            setUnitSuggestOpen((p) => ({ ...p, [zone.zone_uid]: false }));
                          }
                        }}
                        placeholder="Type or pick — e.g. Walk-in freezer…"
                        className="w-full px-2 py-1.5 bg-white border border-[#D6D3D1] rounded-[8px] text-xs text-[#0D1C42] placeholder:text-[#98A2B3] focus:outline-none focus:ring-1 focus:ring-[#800020]/30 focus:border-[#800020]"
                      />
                      {unitSuggestOpen[zone.zone_uid] &&
                        (() => {
                          const q = unitDraft.trim().toLowerCase();
                          const matches = UNIT_SUGGESTIONS.filter(
                            (s) =>
                              (!q || s.toLowerCase().includes(q)) &&
                              !zoneUnits.some((u) => u.name.toLowerCase() === s.toLowerCase())
                          ).slice(0, 7);
                          return matches.length > 0 ? (
                            <div className="absolute left-0 right-0 top-full mt-1 z-40 bg-white border border-[#E7E5E4] rounded-[10px] shadow-lg py-1 max-h-48 overflow-y-auto">
                              {matches.map((s) => {
                                const Icon = unitIcon(s);
                                return (
                                  <button
                                    key={s}
                                    type="button"
                                    onMouseDown={(e) => {
                                      e.preventDefault();
                                      saveUnits([
                                        ...zoneUnits,
                                        { name: s, qty: Math.max(1, unitQty | 0 || 1) },
                                      ]);
                                      setUnitDraft('');
                                      setUnitQty(1);
                                    }}
                                    className="w-full text-left px-2.5 py-1.5 text-xs text-[#0D1C42] hover:bg-[#F7E9EE] flex items-center gap-2 cursor-pointer"
                                  >
                                    <span className="w-5 h-5 rounded-[5px] bg-[#F6F4F2] text-[#800020] flex items-center justify-center shrink-0">
                                      <Icon className="w-3 h-3" />
                                    </span>
                                    <span className="truncate">{s}</span>
                                    <Plus className="w-3 h-3 text-[#98A2B3] ml-auto shrink-0" />
                                  </button>
                                );
                              })}
                            </div>
                          ) : null;
                        })()}
                    </div>
                    <input
                      type="number"
                      min={1}
                      max={9999}
                      value={unitQty}
                      onChange={(e) => setUnitQty(parseInt(e.target.value, 10) || 1)}
                      title="Quantity"
                      className="w-14 px-1.5 py-1.5 text-center bg-white border border-[#D6D3D1] rounded-[8px] text-xs font-semibold text-[#0D1C42] focus:outline-none focus:ring-1 focus:ring-[#800020]/30 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    <button
                      type="button"
                      onClick={addUnit}
                      disabled={!unitDraft.trim()}
                      className="p-1.5 rounded-[8px] bg-[#F7E9EE] text-[#800020] hover:bg-[#800020] hover:text-white disabled:opacity-40 disabled:hover:bg-[#F7E9EE] disabled:hover:text-[#800020] transition-colors cursor-pointer"
                      title="Add unit"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Primary CTA */}
        <Button
          variant="sage"
          size="sm"
          className="w-full justify-between group-hover:bg-[#800020] group-hover:text-white transition-all cursor-pointer mt-2"
          onClick={() => setOpenedZoneUid(zone.zone_uid)}
        >
          <span>Open Zone Workspace</span>
          <ArrowRight className="w-4 h-4 ml-1" />
        </Button>
      </Card>
    );
  };

  // Renders one area group card (zones inside, collapse, actions).
  const renderAreaGroup = (area: Area, zones: Zone[]) => {
    const isCollapsed = !!collapsedAreas[area.area_uid];

    // Area aggregated statistics
    const areaRooms = currentPropertyRooms.filter((r) =>
      zones.some((z) => z.zone_uid === r.zone_uid)
    );
    const areaDorms = currentPropertyDorms.filter((d) =>
      zones.some((z) => z.zone_uid === d.zone_uid)
    );
    const areaEmployees = currentPropertyEmployees.filter((e) =>
      isEmployeeAssignable(e) && (
        e.area_uid === area.area_uid ||
        zones.some((z) => z.zone_uid === e.zone_uid)
      )
    );
    const areaDormBeds = areaDorms.reduce((acc, d) => acc + d.beds.length, 0);
    const areaRoomBeds = areaRooms.reduce((acc, r) => acc + r.bed_count, 0);
    const areaTotalBeds = areaDormBeds + areaRoomBeds;

    const isAreaMenuOpen = activeMenuAreaUid === area.area_uid;
    const areaSection = currentPropertySections.find(
      (s) => s.section_uid === area.section_uid
    );

            return (
              <div
                key={area.area_uid}
                className="bg-white border border-[#E7E5E4] rounded-[18px] p-5 shadow-xs transition-all"
              >
                {/* Area Header Row */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[#F6F4F2]">
                  <div className="flex items-start sm:items-center gap-3">
                    <button
                      onClick={() => toggleAreaCollapse(area.area_uid)}
                      className="p-1 rounded-[6px] hover:bg-[#FFFCFA] text-[#667085] cursor-pointer mt-0.5 sm:mt-0"
                      title={isCollapsed ? 'Expand Area' : 'Collapse Area'}
                    >
                      {isCollapsed ? (
                        <ChevronRight className="w-5 h-5" />
                      ) : (
                        <ChevronDown className="w-5 h-5" />
                      )}
                    </button>

                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-[#FFFCFA] text-[#0D1C42] border border-[#D6D3D1]">
                          {area.code}
                        </span>
                        <h2 className="font-display font-bold text-xl text-[#0D1C42] tracking-tight">
                          {area.name}
                        </h2>
                        {areaSection && (
                          <button
                            onClick={() => setSelectedSectionUid(areaSection.section_uid)}
                            title={`View the ${areaSection.name} section`}
                            className="text-[11px] font-semibold px-2 py-0.5 rounded-[6px] bg-[#F7E9EE] text-[#800020] border border-[#EAD3DB] hover:bg-[#800020] hover:text-white transition-colors cursor-pointer"
                          >
                            {areaSection.name}
                          </button>
                        )}
                      </div>
                      {area.description && (
                        <p className="text-xs text-[#667085] font-body mt-0.5">
                          {area.description}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Area Metrics & Actions */}
                  <div className="flex items-center gap-2 flex-wrap self-end sm:self-auto">
                    {/* Compact Area Metrics Pill */}
                    <div className="hidden lg:flex items-center gap-2 px-3 py-1 bg-[#FFFFFF] border border-[#E7E5E4] rounded-[10px] text-xs text-[#667085]">
                      <span><strong>{zones.length}</strong> {zones.length === 1 ? 'Zone' : 'Zones'}</span>
                      <span className="text-[#D6D3D1]">·</span>
                      <span><strong>{areaRooms.length}</strong> Rooms</span>
                      <span className="text-[#D6D3D1]">·</span>
                      <span><strong>{areaDorms.length}</strong> Dorms</span>
                      <span className="text-[#D6D3D1]">·</span>
                      <span><strong>{areaTotalBeds}</strong> Beds</span>
                      <span className="text-[#D6D3D1]">·</span>
                      <span className="text-[#0D1C42]"><strong>{areaEmployees.length}</strong> Staff</span>
                    </div>

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setActiveAreaForNewZone(area.area_uid);
                        setCreateZoneModalOpen(true);
                      }}
                      className="text-xs gap-1"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add Zone Here</span>
                    </Button>

                    {/* Area Options Menu */}
                    <div className="relative">
                      <button
                        onClick={() =>
                          setActiveMenuAreaUid(isAreaMenuOpen ? null : area.area_uid)
                        }
                        className="p-1.5 rounded-[8px] text-[#667085] hover:text-[#0D1C42] hover:bg-[#F6F4F2] transition-colors cursor-pointer"
                        title="Area Actions"
                      >
                        <MoreVertical className="w-4 h-4" />
                      </button>

                      {isAreaMenuOpen && (
                        <div className="absolute right-0 top-8 z-30 w-44 bg-white border border-[#E7E5E4] rounded-[12px] shadow-lg py-1">
                          <button
                            onClick={() => handleStartEditArea(area)}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium text-[#0D1C42] hover:bg-[#FFFFFF] flex items-center gap-2 cursor-pointer"
                          >
                            <Edit className="w-3.5 h-3.5 text-[#667085]" />
                            <span>Edit Area Details</span>
                          </button>
                          <button
                            onClick={() => {
                              setActiveMenuAreaUid(null);
                              setAreaToDelete(area);
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium text-[#A83434] hover:bg-[#FAEBEB] flex items-center gap-2 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>Delete Area</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Zones inside this Area */}
                {!isCollapsed && (
                  <div className="pt-4">
                    {zones.length === 0 ? (
                      <div className="p-8 text-center bg-[#FFFFFF] border border-dashed border-[#D6D3D1] rounded-[14px]">
                        <p className="text-sm font-medium text-[#667085]">
                          No operational zones mapped in {area.name}
                        </p>
                        <p className="text-xs text-[#98A2B3] mt-0.5">
                          Create a zone to allocate private rooms, dorms, and roster staff on this floor.
                        </p>
                        <Button
                          variant="sage"
                          size="sm"
                          onClick={() => {
                            setActiveAreaForNewZone(area.area_uid);
                            setCreateZoneModalOpen(true);
                          }}
                          className="mt-3.5 gap-1.5"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>Create Zone in {area.name}</span>
                        </Button>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {zones.map((zone) => renderZoneCard(zone))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
  };

  const sortedZones = [...currentPropertyZones].sort((a, b) => a.name.localeCompare(b.name));

  // Zone switcher is scoped by the section selector — a selected section
  // only offers zones living under that section's areas.
  const switcherZones = sortedZones.filter((z) => {
    if (!selectedSectionUid) return true;
    const zoneArea =
      currentPropertyAreas.find((a) => a.area_uid === z.area_uid) ||
      (!z.area_uid
        ? currentPropertyAreas.find((a) => a.name === z.floor)
        : undefined);
    if (selectedSectionUid === UNGROUPED_SECTION) {
      return !zoneArea || !zoneArea.section_uid;
    }
    return zoneArea?.section_uid === selectedSectionUid;
  });

  return (
    <div className="space-y-6">
      {/* Header with Title and CTAs */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="font-display font-bold text-2xl sm:text-[28px] text-[#0D1C42] tracking-tight">
              Zones & Areas Management
            </h1>
            <div className="flex items-center gap-1.5">
              {currentPropertySections.length > 0 && (
                <Badge variant="lavender" size="md">
                  {currentPropertySections.length} Sections
                </Badge>
              )}
              <Badge variant="sage" size="md">
                {currentPropertyAreas.length} Areas
              </Badge>
              <Badge variant="neutral" size="md">
                {currentPropertyZones.length} Zones
              </Badge>
            </div>
          </div>
          <p className="font-body text-sm text-[#667085] mt-1">
            Sections, floors and operational zones mapped across{' '}
            <strong className="text-[#0D1C42] font-semibold">{activeProperty?.name}</strong>
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2.5 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCreateSectionModalOpen(true)}
            className="gap-1.5"
          >
            <Layers className="w-4 h-4 text-[#800020]" />
            <span>Add Section</span>
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setCreateAreaModalOpen(true)}
            className="gap-1.5"
          >
            <Compass className="w-4 h-4 text-[#800020]" />
            <span>Add Area (Floor)</span>
          </Button>

          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setActiveAreaForNewZone(undefined);
              setCreateZoneModalOpen(true);
            }}
            className="gap-1.5"
          >
            <Plus className="w-4 h-4" />
            <span>Add Zone</span>
          </Button>
        </div>
      </div>

      {/* Property bar — zone switcher */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 bg-white border border-[#E7E5E4] rounded-[14px]">
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className="text-xs font-semibold text-[#667085] uppercase tracking-wider">
            Property
          </span>
          <span className="text-sm font-semibold text-[#0D1C42]">{activeProperty?.name}</span>
          <span className="text-[#D6D3D1]">·</span>
          <label className="flex items-center gap-2">
            <span className="text-xs font-semibold text-[#667085] uppercase tracking-wider">
              Section
            </span>
            <select
              value={selectedSectionUid}
              onChange={(e) => {
                setSelectedSectionUid(e.target.value);
                setActiveMenuSectionUid(null);
              }}
              className="px-2.5 py-1.5 bg-white border border-[#D6D3D1] rounded-[8px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020] cursor-pointer"
            >
              <option value="">All Sections</option>
              {currentPropertySections.map((s) => (
                <option key={s.section_uid} value={s.section_uid}>
                  {s.name}
                </option>
              ))}
              {(hasUnsectionedAreas || unassignedZones.length > 0) && (
                <option value={UNGROUPED_SECTION}>Ungrouped</option>
              )}
            </select>
          </label>
          <span className="text-[#D6D3D1]">·</span>
          <label className="flex items-center gap-2">
            <span className="text-xs font-semibold text-[#667085] uppercase tracking-wider">
              Zone
            </span>
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) setOpenedZoneUid(e.target.value);
              }}
              className="px-2.5 py-1.5 bg-white border border-[#D6D3D1] rounded-[8px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020] cursor-pointer"
            >
              <option value="">
                {selectedSectionUid ? 'Zones in this section…' : 'Switch to a zone…'}
              </option>
              {switcherZones.map((z) => (
                <option key={z.zone_uid} value={z.zone_uid}>
                  {z.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-xs text-[#667085]">
          {currentPropertySections.length} sections · {currentPropertyAreas.length} areas · {currentPropertyZones.length} zones
        </p>
      </div>

      {/* Main Content Area */}
      {currentPropertyZones.length === 0 && currentPropertyAreas.length === 0 ? (
        <Card className="p-12 text-center border-dashed border-[#D6D3D1]">
          <div className="w-12 h-12 rounded-full bg-[#F7E9EE] text-[#800020] flex items-center justify-center mx-auto mb-3">
            <Layers className="w-6 h-6" />
          </div>
          <h3 className="font-display font-semibold text-lg text-[#0D1C42]">
            No Areas or Zones Created Yet
          </h3>
          <p className="font-body text-sm text-[#667085] max-w-sm mx-auto mt-1 mb-5">
            Create a section, floors (Areas) and operational Zones to organize rooms, dorms, and staff.
          </p>
          <div className="flex items-center justify-center gap-3">
            <Button variant="outline" onClick={() => setCreateSectionModalOpen(true)}>
              <Layers className="w-4 h-4 mr-1.5" />
              <span>Create Section</span>
            </Button>
            <Button variant="outline" onClick={() => setCreateAreaModalOpen(true)}>
              <Compass className="w-4 h-4 mr-1.5" />
              <span>Create Floor Area</span>
            </Button>
            <Button variant="primary" onClick={() => setCreateZoneModalOpen(true)}>
              <Plus className="w-4 h-4 mr-1.5" />
              <span>Create First Zone</span>
            </Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-5">
          {/* Selected-section context bar */}
          {selectedSection && (
            <div className="flex items-center justify-between gap-3 px-4 py-3 bg-[#F7E9EE] border border-[#EAD3DB] rounded-[14px]">
              <div className="flex items-center gap-2.5 flex-wrap min-w-0">
                <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-white text-[#800020] border border-[#EAD3DB]">
                  {selectedSection.code}
                </span>
                <h2 className="font-display font-bold text-lg text-[#0D1C42] tracking-tight">
                  {selectedSection.name}
                </h2>
                <Badge variant="neutral" size="sm">
                  {visibleAreaGroups.length} {visibleAreaGroups.length === 1 ? 'area' : 'areas'}
                </Badge>
                {selectedSection.description && (
                  <span className="text-xs text-[#667085] hidden md:inline truncate">
                    {selectedSection.description}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => setSelectedSectionUid('')}
                  className="text-xs font-semibold text-[#800020] hover:text-[#0D1C42] px-2 py-1 transition-colors cursor-pointer"
                >
                  Show all
                </button>
                <div className="relative">
                  <button
                    onClick={() =>
                      setActiveMenuSectionUid(
                        activeMenuSectionUid === selectedSection.section_uid
                          ? null
                          : selectedSection.section_uid
                      )
                    }
                    className="p-1.5 rounded-[8px] text-[#667085] hover:text-[#0D1C42] hover:bg-white transition-colors cursor-pointer"
                    title="Section actions"
                  >
                    <MoreVertical className="w-4 h-4" />
                  </button>
                  {activeMenuSectionUid === selectedSection.section_uid && (
                    <div className="absolute right-0 top-8 z-30 w-44 bg-white border border-[#E7E5E4] rounded-[12px] shadow-lg py-1">
                      <button
                        onClick={() => handleStartEditSection(selectedSection)}
                        className="w-full text-left px-3.5 py-2 text-xs font-medium text-[#0D1C42] hover:bg-[#FFFFFF] flex items-center gap-2 cursor-pointer"
                      >
                        <Edit className="w-3.5 h-3.5 text-[#667085]" />
                        <span>Edit Section</span>
                      </button>
                      <button
                        onClick={() => {
                          setActiveMenuSectionUid(null);
                          setSectionToDelete(selectedSection);
                        }}
                        className="w-full text-left px-3.5 py-2 text-xs font-medium text-[#A83434] hover:bg-[#FAEBEB] flex items-center gap-2 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Delete Section</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Areas -> zones (scoped by the section selector) */}
          {visibleAreaGroups.length === 0 ? (
            <div className="p-6 text-center bg-white border border-dashed border-[#D6D3D1] rounded-[14px]">
              <p className="text-sm text-[#667085]">
                {selectedSection
                  ? `No areas in ${selectedSection.name} yet — assign one when creating or editing an area.`
                  : 'No ungrouped areas — every floor belongs to a section.'}
              </p>
            </div>
          ) : (
            visibleAreaGroups.map(({ area, zones }) => renderAreaGroup(area, zones))
          )}

          {/* Unassigned / Other Zones */}
          {showUnassignedGroup && (
            <div className="bg-white border border-[#E7E5E4] rounded-[18px] p-5 shadow-xs">
              <div className="flex items-center justify-between pb-4 border-b border-[#F6F4F2]">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-[#F6F4F2] text-[#667085] border border-[#D6D3D1]">
                      OTHER
                    </span>
                    <h2 className="font-display font-bold text-lg text-[#0D1C42]">
                      Standalone & Custom Zones
                    </h2>
                    <Badge variant="neutral" size="sm">
                      {unassignedZones.length} Zones
                    </Badge>
                  </div>
                  <p className="text-xs text-[#667085] mt-0.5">
                    Zones not directly linked to a predefined floor Area.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-4">
                {unassignedZones.map((zone) => renderZoneCard(zone))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Create Zone Modal */}
      <CreateZoneModal
        isOpen={createZoneModalOpen}
        onClose={() => setCreateZoneModalOpen(false)}
        defaultAreaUid={activeAreaForNewZone}
      />

      {/* Create Area Modal */}
      {/* Create Section Modal */}
      <CreateSectionModal
        isOpen={createSectionModalOpen}
        onClose={() => setCreateSectionModalOpen(false)}
      />

      <CreateAreaModal
        isOpen={createAreaModalOpen}
        onClose={() => setCreateAreaModalOpen(false)}
      />

      {/* Edit Zone Modal */}
      {editingZone && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#0D1C42]/40">
          <div className="w-full max-w-md bg-white border border-[#E7E5E4] rounded-[18px] p-6 shadow-xl">
            <h3 className="font-display font-bold text-lg text-[#0D1C42] mb-4">
              Edit Zone Details
            </h3>
            <form onSubmit={handleSaveEditZone} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1">
                  Zone Name
                </label>
                <input
                  type="text"
                  required
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
                />
              </div>

              {(() => {
                const editArea = currentPropertyAreas.find(
                  (a) => a.area_uid === editAreaUid
                );
                const editSection = currentPropertySections.find(
                  (s) => s.section_uid === editArea?.section_uid
                );
                const sectionDriven =
                  !!editSection && editSection.name.trim().toLowerCase() !== 'stay';
                return sectionDriven ? (
                  <div>
                    <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1">
                      Zone Type (optional)
                    </label>
                    <input
                      type="text"
                      value={editCustomType}
                      onChange={(e) => setEditCustomType(e.target.value)}
                      placeholder={`${editSection.name} — or enter anything custom`}
                      className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] placeholder:text-[#98A2B3] focus:outline-none focus:ring-2 focus:ring-[#800020]"
                    />
                    <p className="text-[11px] text-[#667085] mt-1.5">
                      Zones under {editSection.name} can't contain rooms, dorms or beds — only staff and tasks.
                    </p>
                  </div>
                ) : (
              <div>
                <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1">
                  Zone Type
                </label>
                <select
                  value={editZoneType}
                  onChange={(e) => setEditZoneType(e.target.value as ZoneType)}
                  className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
                >
                  {ZONE_TYPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label} — {o.hint}
                    </option>
                  ))}
                </select>
                {editZoneType !== 'stay' && editingZone && zoneSupportsUnits(editingZone) &&
                  (currentPropertyRooms.some((r) => r.zone_uid === editingZone.zone_uid) ||
                    currentPropertyDorms.some((d) => d.zone_uid === editingZone.zone_uid)) && (
                  <p className="text-[11px] text-[#A56514] mt-1.5 font-medium">
                    Switching to a non-stay type will move this zone's rooms and dorms to
                    Unallocated.
                  </p>
                )}
              </div>
                );
              })()}

              {currentPropertyAreas.length > 0 && (
                <div>
                  <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1">
                    Belongs to Area
                  </label>
                  <select
                    value={editAreaUid}
                    onChange={(e) => setEditAreaUid(e.target.value)}
                    className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
                  >
                    {currentPropertyAreas.map((area) => (
                      <option key={area.area_uid} value={area.area_uid}>
                        {area.name} ({area.code})
                      </option>
                    ))}
                    <option value="">Unassigned</option>
                  </select>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1">
                  Description
                </label>
                <textarea
                  rows={3}
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
                />
              </div>

              <div className="flex justify-end gap-2.5 pt-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditingZone(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary">
                  Save Changes
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Area Modal */}
      {editingArea && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#0D1C42]/40">
          <div className="w-full max-w-md bg-white border border-[#E7E5E4] rounded-[18px] p-6 shadow-xl">
            <h3 className="font-display font-bold text-lg text-[#0D1C42] mb-4">
              Edit Area / Floor Details
            </h3>
            <form onSubmit={handleSaveEditArea} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1">
                  Area Name *
                </label>
                <input
                  type="text"
                  required
                  value={editAreaName}
                  onChange={(e) => setEditAreaName(e.target.value)}
                  className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1">
                  Section
                </label>
                <select
                  value={editAreaSectionUid}
                  onChange={(e) => setEditAreaSectionUid(e.target.value)}
                  className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
                >
                  <option value="">No section</option>
                  {currentPropertySections.map((x) => (
                    <option key={x.section_uid} value={x.section_uid}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1">
                  Description
                </label>
                <textarea
                  rows={3}
                  value={editAreaDescription}
                  onChange={(e) => setEditAreaDescription(e.target.value)}
                  className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
                />
              </div>

              <div className="flex justify-end gap-2.5 pt-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditingArea(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary">
                  Save Changes
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Section Modal */}
      {editingSection && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#0D1C42]/40">
          <div className="w-full max-w-md bg-white border border-[#E7E5E4] rounded-[18px] p-6 shadow-xl">
            <h3 className="font-display font-bold text-lg text-[#0D1C42] mb-4">
              Edit Section
            </h3>
            <form onSubmit={handleSaveEditSection} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1">
                  Section Name *
                </label>
                <input
                  type="text"
                  required
                  value={editSectionName}
                  onChange={(e) => setEditSectionName(e.target.value)}
                  className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1">
                  Description
                </label>
                <textarea
                  rows={3}
                  value={editSectionDescription}
                  onChange={(e) => setEditSectionDescription(e.target.value)}
                  className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
                />
              </div>

              <div className="flex justify-end gap-2.5 pt-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditingSection(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary">
                  Save Changes
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Section Confirmation Dialog */}
      {sectionToDelete && (
        <ConfirmationDialog
          isOpen={!!sectionToDelete}
          onClose={() => setSectionToDelete(null)}
          onConfirm={() => {
            deleteSection(sectionToDelete.section_uid);
            if (selectedSectionUid === sectionToDelete.section_uid) {
              setSelectedSectionUid('');
            }
            setSectionToDelete(null);
          }}
          entityType="Section"
          entityName={sectionToDelete.name}
          impactMessage={`Deleting this Section will NOT delete its areas or zones — they become ungrouped and can be reassigned to another section.`}
        />
      )}

      {/* Delete Zone Confirmation Dialog */}
      {zoneToDelete && (
        <ConfirmationDialog
          isOpen={!!zoneToDelete}
          onClose={() => setZoneToDelete(null)}
          onConfirm={() => deleteZone(zoneToDelete.zone_uid)}
          entityType="Zone"
          entityName={zoneToDelete.name}
          impactMessage={`Deleting this Zone will permanently delete its Rooms, Dorms, Beds, Washrooms and other resources belonging to this Zone. Employees and task/ticket history are kept but unlinked.`}
        />
      )}

      {/* Delete Area Confirmation Dialog */}
      {areaToDelete && (
        <ConfirmationDialog
          isOpen={!!areaToDelete}
          onClose={() => setAreaToDelete(null)}
          onConfirm={() => deleteArea(areaToDelete.area_uid)}
          entityType="Area"
          entityName={areaToDelete.name}
          impactMessage={`Deleting this Area will permanently delete its Zones and all resources belonging to those Zones (rooms, dorms, beds, washrooms). Employees and task/ticket history are kept but unlinked.`}
        />
      )}
    </div>
  );
};
