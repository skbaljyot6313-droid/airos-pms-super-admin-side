import React, { useMemo, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { AlertTriangle } from 'lucide-react';
import { zoneSupportsUnits } from '../../lib/zoneUtils';

interface CreateRoomModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultZoneUid?: string;
}

export const ROOM_TYPES = [
  'Private Deluxe',
  'Double Classic',
  'Triple Suite',
  'Family Suite',
  'Balcony Executive',
  'Standard Single',
  'Studio Suite',
];

export const CreateRoomModal: React.FC<CreateRoomModalProps> = ({ isOpen, onClose, defaultZoneUid }) => {
  const { createRoom, currentPropertyZones, currentPropertyRooms } = useApp();

  const [roomNumber, setRoomNumber] = useState('');
  const [type, setType] = useState(ROOM_TYPES[0]);
  const [customType, setCustomType] = useState('');
  const [areaSqft, setAreaSqft] = useState('260');
  const [bedCount, setBedCount] = useState('1');
  const [zoneUid, setZoneUid] = useState<string>(defaultZoneUid ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Instant name-conflict feedback — same check the backend enforces (409)
  const roomNumberTaken = useMemo(() => {
    const n = roomNumber.trim().toLowerCase();
    return n !== '' && currentPropertyRooms.some(
      (r) => r.room_number.toLowerCase().trim() === n
    );
  }, [roomNumber, currentPropertyRooms]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomNumber.trim() || roomNumberTaken || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await createRoom({
        room_number: roomNumber.trim(),
        type: type === 'Custom...' ? customType.trim() || 'Private Room' : type,
        area_sqft: parseInt(areaSqft) || 260,
        bed_count: parseInt(bedCount) || 1,
        zone_uid: zoneUid ? zoneUid : null,
      });

      setRoomNumber('');
      setZoneUid('');
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
      title="Create Single Room"
      description="Add an individual private guest accommodation"
      maxWidth="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
            Room Number *
          </label>
          <input
            type="text"
            required
            value={roomNumber}
            onChange={(e) => setRoomNumber(e.target.value)}
            placeholder="e.g. 205"
            className={`w-full px-3.5 py-2 bg-[#FFFFFF] border rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 ${
              roomNumberTaken
                ? 'border-[#B34A68] focus:ring-[#D64545]'
                : 'border-[#D6D3D1] focus:ring-[#800020]'
            }`}
          />
          {roomNumberTaken && (
            <p className="text-[11px] text-[#A83434] font-body mt-1 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3 shrink-0" />
              A room named "{roomNumber.trim()}" already exists in this property.
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div>
            <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
              Room Type *
            </label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
            >
              {ROOM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
              <option value="Custom...">Custom Type...</option>
            </select>
          </div>

          {type === 'Custom...' && (
            <div>
              <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
                Specify Custom Type
              </label>
              <input
                type="text"
                required
                value={customType}
                onChange={(e) => setCustomType(e.target.value)}
                placeholder="e.g. Presidential Penthouse"
                className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
              Area (Sq Ft)
            </label>
            <input
              type="number"
              value={areaSqft}
              onChange={(e) => setAreaSqft(e.target.value)}
              className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
              Bed Count
            </label>
            <input
              type="number"
              min="1"
              max="5"
              value={bedCount}
              onChange={(e) => setBedCount(e.target.value)}
              className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
              Assign to Zone
            </label>
            <select
              value={zoneUid}
              onChange={(e) => setZoneUid(e.target.value)}
              className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
            >
              <option value="">(Unallocated)</option>
              {currentPropertyZones.filter((z) => zoneSupportsUnits(z)).map((z) => (
                <option key={z.zone_uid} value={z.zone_uid}>
                  {z.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-[#F6F4F2]">
          <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={roomNumberTaken} isLoading={isSubmitting}>
            Create Room
          </Button>
        </div>
      </form>
    </Modal>
  );
};
