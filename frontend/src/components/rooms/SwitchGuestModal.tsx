import React, { useState } from 'react';
import { ArrowRightLeft, BedDouble, DoorOpen, Sparkles } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';

/** The unit the guest is moved OUT of. */
export interface SwitchSource {
  kind: 'room' | 'bed';
  uid: string;
  /** Display label, e.g. "Room 204" or "Dorm 101 — Bed 03". */
  label: string;
  guest: string | null;
}

interface SwitchGuestModalProps {
  isOpen: boolean;
  source: SwitchSource | null;
  onClose: () => void;
}

/**
 * Guest switch — move an open occupancy to any other available unit in
 * the property (room→room, bed→bed, or across kinds). Also asks whether
 * the vacated unit needs cleaning: unchecked releases it straight to
 * Available, checked flags it Cleaning and spawns the housekeeping task.
 */
export const SwitchGuestModal: React.FC<SwitchGuestModalProps> = ({
  isOpen,
  source,
  onClose,
}) => {
  const { currentPropertyRooms, currentPropertyDorms, switchOccupancy } =
    useApp();
  const [target, setTarget] = useState('');
  const [cleanVacated, setCleanVacated] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Available units only — a guest can never be moved onto occupied,
  // cleaning, maintenance or inactive stock (server enforces the same).
  const roomTargets = currentPropertyRooms.filter(
    (r) =>
      r.status === 'available' &&
      !r.is_occupied &&
      !(source?.kind === 'room' && r.room_uid === source?.uid)
  );
  const dormTargets = currentPropertyDorms
    .filter((d) => d.is_active)
    .map((d) => ({
      dorm: d,
      beds: d.beds.filter(
        (b) =>
          b.status === 'available' &&
          !b.is_occupied &&
          !(source?.kind === 'bed' && b.bed_uid === source?.uid)
      ),
    }))
    .filter((g) => g.beds.length > 0);
  const hasTargets = roomTargets.length > 0 || dormTargets.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!source || !target || isSubmitting) return;
    const [kind, uid] = target.split(':', 2) as ['room' | 'bed', string];
    setIsSubmitting(true);
    try {
      const ok = await switchOccupancy({
        source_type: source.kind,
        source_uid: source.uid,
        target_type: kind,
        target_uid: uid,
        clean_vacated: cleanVacated,
      });
      if (ok) {
        setTarget('');
        setCleanVacated(true);
        onClose();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Switch guest — ${source?.label ?? ''}`}
      description="Move the guest to another available unit in this property."
      maxWidth="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="flex items-center gap-3 p-3 rounded-[12px] bg-[#EAF1FB] border border-[#EAD3DB]">
          <div className="w-10 h-10 rounded-[10px] bg-white text-[#800020] flex items-center justify-center border border-[#EAD3DB]">
            <ArrowRightLeft className="w-5 h-5" />
          </div>
          <div>
            <p className="text-sm font-semibold text-[#0D1C42]">
              {source?.guest || 'Guest'} — currently in {source?.label}
            </p>
            <p className="text-xs text-[#667085]">
              The stay record moves with the guest; no checkout is lost.
            </p>
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-2 font-body">
            Move to
          </label>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            disabled={!hasTargets}
            className="w-full bg-[#FFFFFF] border border-[#D6D3D1] rounded-[8px] px-3 py-2 text-sm text-[#0D1C42] focus:outline-none focus:ring-1 focus:ring-[#800020] disabled:opacity-60"
          >
            <option value="">
              {hasTargets
                ? 'Select a destination unit…'
                : 'No available units in this property'}
            </option>
            {roomTargets.length > 0 && (
              <optgroup label="Private rooms">
                {roomTargets.map((r) => (
                  <option key={r.room_uid} value={`room:${r.room_uid}`}>
                    Room {r.room_number}
                  </option>
                ))}
              </optgroup>
            )}
            {dormTargets.map(({ dorm, beds }) => (
              <optgroup key={dorm.dorm_uid} label={dorm.name}>
                {beds.map((b) => (
                  <option key={b.bed_uid} value={`bed:${b.bed_uid}`}>
                    {b.bed_number}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        {/* Does the vacated unit need cleaning? — drives whether the
            checkout pipeline spawns the housekeeping task or releases
            the unit straight to Available. */}
        <label className="flex items-start gap-3 p-3 rounded-[10px] border border-[#D6D3D1] bg-[#FFFFFF] cursor-pointer">
          <input
            type="checkbox"
            checked={cleanVacated}
            onChange={(e) => setCleanVacated(e.target.checked)}
            className="mt-0.5 w-4 h-4 rounded border-[#CDC9C7] text-[#800020] focus:ring-[#800020]"
          />
          <span className="text-xs text-[#0D1C42]">
            <span className="flex items-center gap-1.5 font-semibold text-[#0D1C42]">
              <Sparkles className="w-3.5 h-3.5 text-[#800020]" />
              The vacated unit needs cleaning
            </span>
            Unchecked releases {source?.kind === 'bed' ? 'the bed' : 'the room'}{' '}
            straight to Available — use only when the guest left it clean.
          </span>
        </label>

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!target || isSubmitting}
            className="inline-flex items-center gap-1.5"
          >
            {source?.kind === 'room' ? (
              <DoorOpen className="w-3.5 h-3.5" />
            ) : (
              <BedDouble className="w-3.5 h-3.5" />
            )}
            {isSubmitting ? 'Switching…' : 'Switch guest'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
