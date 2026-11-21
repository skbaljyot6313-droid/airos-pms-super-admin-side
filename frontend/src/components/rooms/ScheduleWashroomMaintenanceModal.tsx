import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Camera, X } from 'lucide-react';
import { fixtureMeta, isCustomKind } from '../../lib/washroomFixtures';
import { useEvidenceUploads } from '../../hooks/useEvidenceUploads';
import {
  ALLOWED_COMPLETION_IMAGE_TYPES,
  MAX_UPLOAD_BYTES,
} from '../../lib/mediaLimits';
import { Dorm, MaintenancePriority, WashroomFixture, Zone } from '../../types';

interface ScheduleWashroomMaintenanceModalProps {
  washroomUid: string;
  washroomName: string;
  fixtures: WashroomFixture[];
  presetFixture: WashroomFixture | null;
  /** Multi-select mode — one ticket per fixture in a single batch */
  presetFixtures?: WashroomFixture[];
  dorm: Dorm | null;
  zone: Zone | null;
  /** Called after tickets are successfully created */
  onSuccess?: () => void;
  onClose: () => void;

}

// Same values as the backend MAINTENANCE_TYPES enum (schemas/maintenance.py)
const MAINTENANCE_TYPES = [
  ['plumbing', 'Plumbing'],
  ['electrical', 'Electrical'],
  ['civil', 'Civil'],
  ['carpentry', 'Carpentry'],
  ['hvac', 'HVAC'],
  ['painting', 'Painting'],
  ['furniture', 'Furniture'],
  ['appliance', 'Appliance'],
  ['internet', 'Internet'],
  ['water_drainage', 'Water & Drainage'],
  ['cleaning_equipment', 'Cleaning Equipment'],
  ['safety_security', 'Safety & Security'],
  ['other', 'Other'],
] as const;
const PRIORITIES: MaintenancePriority[] = ['low', 'medium', 'high', 'critical'];

const inputCls =
  'w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]';
const labelCls =
  'block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body';

export const ScheduleWashroomMaintenanceModal: React.FC<
  ScheduleWashroomMaintenanceModalProps
> = ({ washroomUid, washroomName, fixtures, presetFixture, presetFixtures, dorm, zone, onSuccess, onClose }) => {
  const {
    createMaintenanceBatch,
    assignMaintenanceTicket,
    currentPropertyEmployees,
    activeProperty,
    addToast,
  } = useApp();

  const bulkTargets =
    presetFixtures && presetFixtures.length > 1 ? presetFixtures : null;
  const [scope, setScope] = useState<'washroom' | 'fixture'>(
    presetFixture || bulkTargets ? 'fixture' : 'washroom'
  );
  const [fixtureId, setFixtureId] = useState<string>(
    presetFixture?.fixture_uid ?? fixtures[0]?.fixture_uid ?? ''
  );
  const [maintenanceType, setMaintenanceType] = useState('plumbing');
  const [priority, setPriority] = useState<MaintenancePriority>('medium');
  const [employeeUid, setEmployeeUid] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [description, setDescription] = useState('');
  const evidence = useEvidenceUploads({
    propertyUid: activeProperty?.property_uid,
    maxCount: 10,
    allowedTypes: ALLOWED_COMPLETION_IMAGE_TYPES,
    maxBytes: MAX_UPLOAD_BYTES,
    onToast: addToast,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const evidenceRef = useRef(evidence);
  evidenceRef.current = evidence;

  // Release object URLs on unmount — they outlive the files themselves
  useEffect(() => () => evidenceRef.current.reset(), []);

  const selectedFixture = fixtures.find((f) => f.fixture_uid === fixtureId) || null;
  const targetFixtures = bulkTargets ?? (selectedFixture ? [selectedFixture] : []);
  const canSubmit = scope === 'washroom' || targetFixtures.length > 0;
  const assignableEmployees = currentPropertyEmployees.filter(
    (e) => e.status?.toLowerCase() === 'active'
  );

  const locationLabel = [
    activeProperty?.name,
    zone?.name,
    dorm?.name,
    washroomName,
  ]
    .filter(Boolean)
    .join(' → ');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || isSubmitting || evidence.busy) return;
    setIsSubmitting(true);
    try {
      const scopeLabel = bulkTargets
        ? `${bulkTargets.length} fixtures`
        : selectedFixture?.label ?? 'Entire washroom';
      const typeLabel =
        MAINTENANCE_TYPES.find(([v]) => v === maintenanceType)?.[1] ??
        maintenanceType;
      // Photos were compressed + uploaded at selection — reuse URLs.
      const attachment_urls = evidence.readyUrls;
      const targets = scope === 'washroom' ? [null] : targetFixtures;
      const batches = await createMaintenanceBatch(
        targets.map((f) => ({
          washroom_uid: washroomUid,
          washroom_fixture_uid: f?.fixture_uid,
          maintenance_type: maintenanceType,
          issue: `${typeLabel} — ${f?.label ?? 'Entire washroom'}`,
          description: description.trim() || undefined,
          priority,
          due_date: dueDate || undefined,
          attachment_urls,
        }))
      );
      // Explicit assignee → real ticket assignment on every created record
      const created = batches.flatMap((b) => b.tickets);
      if (employeeUid) {
        for (const t of created) {
          if (t.ticket_uid) {
            await assignMaintenanceTicket(t.ticket_uid, employeeUid);
          }
        }
      }
      addToast({
        type: 'success',
        title: 'Maintenance Allocated',
        description: `Request created for ${scopeLabel.toLowerCase()}.`,
      });
      onSuccess?.();
      onClose();
    } catch {
      // toast handled by context
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Allocate Maintenance"
      description={locationLabel}
      maxWidth="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Location — real hierarchy from the database */}
        <div className="rounded-[10px] border border-[#E7E5E4] bg-[#FFFFFF] px-3 py-2">
          <span className="block text-[10px] font-semibold text-[#667085] uppercase tracking-wider mb-0.5">
            Location
          </span>
          <span className="text-xs font-medium text-[#0D1C42]">{locationLabel}</span>
        </div>

        <div>
          <label className={labelCls}>Maintenance Target</label>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { v: 'washroom', label: 'Entire Washroom' },
                { v: 'fixture', label: 'Specific Fixture' },
              ] as const
            ).map((o) => (
              <button
                key={o.v}
                type="button"
                onClick={() => setScope(o.v)}
                className={`px-3 py-2 rounded-[10px] border text-sm font-medium transition-colors cursor-pointer ${
                  scope === o.v
                    ? 'border-[#800020] bg-[#F7E9EE] text-[#0D1C42]'
                    : 'border-[#D6D3D1] bg-[#FFFFFF] text-[#667085] hover:border-[#CDC9C7]'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {scope === 'fixture' &&
          (bulkTargets ? (
            <div>
              <label className={labelCls}>Selected Fixtures</label>
              <div className="px-3.5 py-2 bg-[#F7E9EE] border border-[#EAD3DB] rounded-[10px] text-sm font-medium text-[#0D1C42]">
                {bulkTargets.length} fixtures —{' '}
                {bulkTargets.map((f) => f.label).join(', ')}
              </div>
              <p className="text-[10px] text-[#667085] mt-1">
                One maintenance ticket is created per fixture — all in a
                single allocation batch.
              </p>
            </div>
          ) : fixtures.length === 0 ? (
            <p className="text-xs text-[#667085] -mt-1">
              No fixtures configured for this washroom.
            </p>
          ) : (
            <div>
              <label className={labelCls}>Target Fixture</label>
              <select
                value={fixtureId}
                onChange={(e) => setFixtureId(e.target.value)}
                className={inputCls}
              >
                {fixtures.map((f) => (
                  <option key={f.fixture_uid} value={f.fixture_uid}>
                    {f.label} — {fixtureMeta(f.fixture_type, isCustomKind(f.fixture_type)).plural}
                  </option>
                ))}
              </select>
            </div>
          ))}

        <div className="grid grid-cols-2 gap-3.5">
          <div>
            <label className={labelCls}>Maintenance Type</label>
            <select
              value={maintenanceType}
              onChange={(e) => setMaintenanceType(e.target.value)}
              className={inputCls}
            >
              {MAINTENANCE_TYPES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Priority</label>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as MaintenancePriority)}
              className={inputCls}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3.5">
          <div>
            <label className={labelCls}>Assign To</label>
            <select
              value={employeeUid}
              onChange={(e) => setEmployeeUid(e.target.value)}
              className={inputCls}
            >
              <option value="">(Auto-assign by zone)</option>
              {assignableEmployees.map((emp) => (
                <option key={emp.employee_uid} value={emp.employee_uid}>
                  {emp.name} — {emp.job_title || emp.department}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-[#667085] mt-1">
              {assignableEmployees.length === 0
                ? 'No active employees — the ticket will stay unassigned.'
                : 'Or leave blank for zone round-robin allocation.'}
            </p>
          </div>
          <div>
            <label className={labelCls}>Scheduled Date</label>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className={inputCls}
            />
          </div>
        </div>

        <div>
          <label className={labelCls}>Description / Notes</label>
          <textarea
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the issue, parts needed, access notes..."
            className={inputCls}
          />
        </div>

        {/* Evidence photos — compressed + uploaded at selection, attached to
            every ticket created by this batch */}
        <div>
          <label className={labelCls}>Photos</label>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            multiple
            className="hidden"
            onChange={(e) => {
              evidence.add(Array.from(e.target.files || []));
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-[10px] border border-dashed border-[#CDC9C7] bg-[#FFFCFA] text-left hover:border-[#800020]/60 hover:bg-[#F6F4F2] transition-colors cursor-pointer"
          >
            <span className="w-8 h-8 rounded-[8px] bg-white border border-[#E7E5E4] flex items-center justify-center shrink-0 text-[#667085]">
              <Camera className="w-4 h-4" />
            </span>
            <span>
              <span className="block text-[13px] font-medium text-[#0D1C42]">
                {evidence.items.length > 0 ? 'Add another photo' : 'Upload photo'}
              </span>
              <span className="block text-[10px] text-[#667085] mt-0.5">
                Optional — helps the technician locate the issue
              </span>
            </span>
          </button>
          {evidence.items.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {evidence.items.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-3 px-3 py-2 rounded-[10px] border border-[#D6D3D1] bg-white"
                >
                  <img
                    src={p.previewUrl}
                    alt={p.file.name}
                    className="w-10 h-10 rounded-[7px] object-cover border border-[#F6F4F2] shrink-0"
                  />
                  <span className="flex-1 text-[13px] text-[#0D1C42] truncate">
                    {p.file.name}
                  </span>
                  <span className="text-[11px] text-[#667085] shrink-0">
                    {p.status === 'ready'
                      ? '✓ uploaded'
                      : p.status === 'error'
                        ? 'failed'
                        : p.status === 'compressing'
                          ? 'preparing…'
                          : 'uploading…'}
                  </span>
                  {p.status === 'error' && (
                    <button
                      type="button"
                      onClick={() => evidence.retry(p.id)}
                      className="text-[11px] font-semibold text-[#A83434] shrink-0 cursor-pointer"
                    >
                      retry
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${p.file.name}`}
                    onClick={() => evidence.remove(p.id)}
                    className="w-7 h-7 rounded-[7px] flex items-center justify-center text-[#667085] hover:text-[#A83434] hover:bg-[#FAEBEB] transition-colors cursor-pointer shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-[#F6F4F2]">
          <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit} isLoading={isSubmitting}>
            Allocate Maintenance
          </Button>
        </div>
      </form>
    </Modal>
  );
};
