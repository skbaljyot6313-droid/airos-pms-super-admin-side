import React, { useState } from 'react';
import { ConciergeBell } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Bed, Dorm, Room } from '../../types';

// Guest amenity request catalogue — the picked label lands in the task
// title so both this dashboard and the employee app read it directly.
export const GUEST_REQUEST_OPTIONS = [
  'Towel',
  'Extra Mattress',
  'Comforter / Blanket',
  'Extra Pillow',
  'Bed Linen Change',
  'Toiletries Kit',
  'Drinking Water',
  'Tea / Coffee Kit',
  'Laundry Pickup',
  'Iron & Ironing Board',
  'Room Cleaning',
  'Medical Assistance',
] as const;

const OTHER = 'Other';

interface RequestItemModalProps {
  isOpen: boolean;
  /** Exactly one target: a room, or a bed inside a dorm. */
  room?: Room;
  dorm?: Dorm;
  bed?: Bed;
  onClose: () => void;
}

export const RequestItemModal: React.FC<RequestItemModalProps> = ({
  isOpen,
  room,
  dorm,
  bed,
  onClose,
}) => {
  const { createTask, addToast } = useApp();
  const targetLabel = room
    ? `Room ${room.room_number}`
    : `${dorm?.name ?? 'Dorm'} — ${bed?.bed_number ?? 'Bed'}`;
  const [item, setItem] = useState('');
  const [otherText, setOtherText] = useState('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const resolvedItem =
    item === OTHER ? otherText.trim() : item;
  const canSubmit = resolvedItem.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await createTask({
        title: `Guest Request — ${resolvedItem}`,
        task_type: 'fixed',
        work_type: 'housekeeping',
        room_uid: room?.room_uid,
        dorm_uid: room ? undefined : dorm?.dorm_uid,
        bed_uids: room ? undefined : bed ? [bed.bed_uid] : undefined,
        priority: 'urgent',
        is_guest_request: true,
        description:
          [`${targetLabel} — ${resolvedItem}`, notes.trim() || null]
            .filter(Boolean)
            .join('\n'),
      });
      addToast({
        type: 'success',
        title: 'Request Raised',
        description: `${resolvedItem} for ${targetLabel} — marked urgent.`,
      });
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
      title={`New Request — ${targetLabel}`}
      description="Guest requests are created as urgent tasks and surface first for staff."
      maxWidth="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="flex items-center gap-3 p-3 rounded-[12px] bg-[#FDF3EC] border border-[#F2DCC8]">
          <div className="w-10 h-10 rounded-[10px] bg-white text-[#B45309] flex items-center justify-center border border-[#EBD4BC]">
            <ConciergeBell className="w-5 h-5" />
          </div>
          <div>
            <p className="text-sm font-semibold text-[#24221F]">Guest Request</p>
            <p className="text-xs text-[#6C675F]">
              Allocated like regular work, but carried at the highest priority.
            </p>
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-[#45413B] uppercase tracking-wider mb-2 font-body">
            What is the request for? *
          </label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {[...GUEST_REQUEST_OPTIONS, OTHER].map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setItem(opt)}
                className={`px-3 py-2 rounded-[10px] border text-[13px] font-medium text-left transition-all cursor-pointer ${
                  item === opt
                    ? 'border-[#386641] bg-[#EBF3EC] text-[#244E2C] ring-1 ring-[#386641]/30'
                    : 'border-[#DDD7CB] bg-[#FAF8F5] text-[#555047] hover:border-[#B9B2A4]'
                }`}
              >
                {opt}
              </button>
            ))}
          </div>
          {item === OTHER && (
            <input
              type="text"
              required
              autoFocus
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
              placeholder="Describe the request, e.g. Electric kettle"
              className="mt-2 w-full px-3.5 py-2 bg-[#FAF8F5] border border-[#DDD7CB] rounded-[10px] text-sm text-[#24221F] focus:outline-none focus:ring-2 focus:ring-[#386641]"
            />
          )}
        </div>

        <div>
          <label className="block text-xs font-semibold text-[#45413B] uppercase tracking-wider mb-1 font-body">
            Notes (Optional)
          </label>
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Quantity, timing, guest instructions..."
            className="w-full px-3.5 py-2 bg-[#FAF8F5] border border-[#DDD7CB] rounded-[10px] text-sm text-[#24221F] focus:outline-none focus:ring-2 focus:ring-[#386641]"
          />
        </div>

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-[#F0ECE4]">
          <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit} isLoading={isSubmitting}>
            Raise Request
          </Button>
        </div>
      </form>
    </Modal>
  );
};
