import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';

interface CreateAreaModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const CreateAreaModal: React.FC<CreateAreaModalProps> = ({ isOpen, onClose }) => {
  const { createArea, currentPropertySections } = useApp();
  const [name, setName] = useState('');
  const [sectionUid, setSectionUid] = useState('');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await createArea({
        name: name.trim(),
        section_uid: sectionUid || null,
        description: description.trim() || undefined,
      });
      setName('');
      setSectionUid('');
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
      title="Create Property Area / Floor"
      description="Add a physical floor level, elevation, or building sector to organize zones."
      maxWidth="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
            Area Name *
          </label>
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Third Floor, Rooftop Terrace, Courtyard Wing"
            className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] placeholder:text-[#98A2B3] focus:outline-none focus:ring-2 focus:ring-[#800020]/25 focus:border-[#800020]"
          />
        </div>

        {currentPropertySections.length > 0 && (
          <div>
            <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
              Section
            </label>
            <select
              value={sectionUid}
              onChange={(e) => setSectionUid(e.target.value)}
              className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]/25 focus:border-[#800020]"
            >
              <option value="">No section</option>
              {currentPropertySections.map((s) => (
                <option key={s.section_uid} value={s.section_uid}>
                  {s.name}
                </option>
              ))}
            </select>
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
            placeholder="Specify physical features, elevator access, or operational details..."
            className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] placeholder:text-[#98A2B3] focus:outline-none focus:ring-2 focus:ring-[#800020]/25 focus:border-[#800020]"
          />
        </div>

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-[#F6F4F2]">
          <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" isLoading={isSubmitting}>
            Create Area
          </Button>
        </div>
      </form>
    </Modal>
  );
};
