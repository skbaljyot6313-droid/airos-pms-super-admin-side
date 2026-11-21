import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';

interface CreateSectionModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const SECTION_PRESETS = [
  'Stay',
  'Kitchen',
  'Café',
  'Bar',
  'Restaurant',
  'Pool',
  'Reception',
  'Lobby',
  'Common Areas',
  'Rooftop',
  'Gym & Fitness',
  'Spa & Wellness',
  'Laundry',
  'Housekeeping',
  'Back Office',
  'Staff Quarters',
  'Parking',
  'Outdoor & Garden',
  'Storage & Utility',
  'Washrooms',
] as const;

const CUSTOM_SECTION = '__custom__';

export const CreateSectionModal: React.FC<CreateSectionModalProps> = ({ isOpen, onClose }) => {
  const { createSection } = useApp();
  const [preset, setPreset] = useState<string>('Stay');
  const [customName, setCustomName] = useState('');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isCustom = preset === CUSTOM_SECTION;
  const resolvedName = isCustom ? customName.trim() : preset;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resolvedName || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await createSection({
        name: resolvedName,
        description: description.trim() || undefined,
      });
      setPreset('Stay');
      setCustomName('');
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
      title="Create Property Section"
      description="Group areas (floors) under a functional section like Stay, Kitchen, Pool or Reception."
      maxWidth="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
            Section *
          </label>
          <select
            required
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
            className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]/25 focus:border-[#800020]"
          >
            {SECTION_PRESETS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
            <option value={CUSTOM_SECTION}>Custom…</option>
          </select>
        </div>

        {isCustom && (
          <div>
            <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
              Custom Section Name *
            </label>
            <input
              type="text"
              required
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder="e.g. Co-working Space"
              className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] placeholder:text-[#98A2B3] focus:outline-none focus:ring-2 focus:ring-[#800020]/25 focus:border-[#800020]"
            />
          </div>
        )}

        <div>
          <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
            Description & Notes (Optional)
          </label>
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Which floors and zones belong to this section, who runs it…"
            className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] placeholder:text-[#98A2B3] focus:outline-none focus:ring-2 focus:ring-[#800020]/25 focus:border-[#800020]"
          />
        </div>

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-[#F6F4F2]">
          <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" isLoading={isSubmitting}>
            Create Section
          </Button>
        </div>
      </form>
    </Modal>
  );
};
