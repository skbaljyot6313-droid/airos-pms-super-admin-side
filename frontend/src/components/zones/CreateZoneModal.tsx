import React, { useEffect, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { ZoneType } from '../../types';
import { ZONE_TYPE_OPTIONS, slugifyZoneType, zoneTypeLabel } from '../../lib/zoneUtils';

interface CreateZoneModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultAreaUid?: string;
}

export const CreateZoneModal: React.FC<CreateZoneModalProps> = ({
  isOpen,
  onClose,
  defaultAreaUid,
}) => {
  const { createZone, currentPropertyAreas, currentPropertySections } = useApp();
  const [name, setName] = useState('');
  const [areaUid, setAreaUid] = useState(defaultAreaUid || '');
  const [zoneType, setZoneType] = useState<ZoneType>('stay');
  const [customType, setCustomType] = useState('');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Re-sync the preselected area each time the modal opens
  useEffect(() => {
    if (isOpen) setAreaUid(defaultAreaUid || '');
  }, [isOpen, defaultAreaUid]);

  // When the zone's area lives in a functional section (Kitchen, Pool…), the
  // section already defines the zone's purpose — the fixed type grid is
  // replaced by an optional custom label. Stay sections and ungrouped areas
  // keep the grid since unit support depends on it.
  const selectedArea = currentPropertyAreas.find((a) => a.area_uid === areaUid);
  const areaSection = currentPropertySections.find(
    (s) => s.section_uid === selectedArea?.section_uid
  );
  const sectionDriven =
    !!areaSection && areaSection.name.trim().toLowerCase() !== 'stay';
  const resolvedZoneType: ZoneType = sectionDriven
    ? ((slugifyZoneType(customType) ||
        slugifyZoneType(areaSection.name) ||
        'common') as ZoneType)
    : zoneType;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await createZone({
        name: name.trim(),
        area_uid: areaUid || null,
        zone_type: resolvedZoneType,
        description: description.trim() || undefined,
      });
      setName('');
      setAreaUid('');
      setZoneType('stay');
      setCustomType('');
      setDescription('');
      onClose();
    } catch {
      // Error toast handled by the context layer
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Create Physical Zone"
      description="Create a distinct physical wing, room sector, or operational zone in this property."
      maxWidth="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
            Zone Name *
          </label>
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Zone D — East Garden Wing"
            className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] placeholder:text-[#98A2B3] focus:outline-none focus:ring-2 focus:ring-[#800020]/25 focus:border-[#800020]"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
            Area
          </label>
          <select
            value={areaUid}
            onChange={(e) => setAreaUid(e.target.value)}
            className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]/25 focus:border-[#800020] cursor-pointer"
          >
            <option value="">Unassigned</option>
            {currentPropertyAreas.map((a) => (
              <option key={a.area_uid} value={a.area_uid}>
                {a.name}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-[#667085] mt-1.5 font-body">
            {currentPropertyAreas.length === 0
              ? 'No areas yet — the zone will be unassigned. Create an area first to group zones.'
              : 'Which area this zone belongs to. Leave unassigned to assign later.'}
          </p>
        </div>

        {sectionDriven ? (
          <div>
            <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
              Zone Type (optional)
            </label>
            <input
              type="text"
              value={customType}
              onChange={(e) => setCustomType(e.target.value)}
              placeholder={`${zoneTypeLabel({ zone_type: slugifyZoneType(areaSection.name) })} — or enter anything custom`}
              className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] placeholder:text-[#98A2B3] focus:outline-none focus:ring-2 focus:ring-[#800020]/25 focus:border-[#800020]"
            />
            <p className="text-[11px] text-[#667085] mt-1.5 font-body">
              Zones under {areaSection.name} can't contain rooms, dorms or beds — only staff and tasks.
            </p>
          </div>
        ) : (
        <div>
          <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
            Zone Type *
          </label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {ZONE_TYPE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setZoneType(opt.value)}
                className={`p-2.5 rounded-[10px] border text-left transition-all cursor-pointer ${
                  zoneType === opt.value
                    ? 'border-[#800020] bg-[#F7E9EE] ring-1 ring-[#800020]/30'
                    : 'border-[#D6D3D1] bg-[#FFFFFF] hover:bg-[#F6F4F2]'
                }`}
              >
                <span
                  className={`block text-xs font-semibold ${
                    zoneType === opt.value ? 'text-[#0D1C42]' : 'text-[#667085]'
                  }`}
                >
                  {opt.label}
                </span>
                <span className="block text-[10px] text-[#667085] mt-0.5 leading-tight">
                  {opt.hint}
                </span>
              </button>
            ))}
          </div>
          <p className="text-[11px] text-[#667085] mt-1.5 font-body">
            {zoneType === 'stay'
              ? 'Stay zones can contain rooms, dorms and beds.'
              : 'This zone type cannot contain rooms, dorms or beds — only staff and tasks.'}
          </p>
        </div>
        )}

        <div>
          <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
            Description & Purpose (Optional)
          </label>
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the physical boundaries, facilities, and staff assignments..."
            className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] placeholder:text-[#98A2B3] focus:outline-none focus:ring-2 focus:ring-[#800020]/25 focus:border-[#800020]"
          />
        </div>

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-[#F6F4F2]">
          <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" isLoading={isSubmitting}>
            Create Zone
          </Button>
        </div>
      </form>
    </Modal>
  );
};
