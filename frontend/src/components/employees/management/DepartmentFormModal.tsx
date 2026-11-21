import React, { useEffect, useState } from 'react';
import { Modal } from '../../ui/Modal';
import { Button } from '../../ui/Button';
import {
  Department,
  DepartmentCreateRequest,
  DepartmentUpdateRequest,
  createDepartment,
  updateDepartment,
} from '../../../api/departments';
import { useApp } from '../../../context/AppContext';

interface Props {
  open: boolean;
  onClose: () => void;
  propertyUid: string;
  department?: Department | null;
  onSaved: (d: Department) => void;
}

export const DepartmentFormModal: React.FC<Props> = ({
  open,
  onClose,
  propertyUid,
  department,
  onSaved,
}) => {
  const { currentPropertyEmployees } = useApp();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<'active' | 'inactive'>('active');
  const [headUid, setHeadUid] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(department?.name ?? '');
      setCode(department?.code ?? '');
      setDescription(department?.description ?? '');
      setStatus(department?.status ?? 'active');
      setHeadUid(department?.head?.employee_uid ?? '');
      setError(null);
    }
  }, [open, department]);

  const activeStaff = currentPropertyEmployees.filter(
    (e) => !(e as { deactivated_at?: string | null }).deactivated_at
  );

  const save = async () => {
    if (!name.trim()) {
      setError('Department name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (department) {
        const req: DepartmentUpdateRequest = {
          name: name.trim(),
          code: code.trim() || null,
          description: description.trim() || null,
          status,
        };
        if (headUid !== (department.head?.employee_uid ?? '')) {
          if (headUid) req.head_employee_uid = headUid;
          else req.clear_head = true;
        }
        onSaved(await updateDepartment(department.department_uid, req));
      } else {
        const req: DepartmentCreateRequest = {
          property_uid: propertyUid,
          name: name.trim(),
          code: code.trim() || null,
          description: description.trim() || null,
          status,
          head_employee_uid: headUid || null,
        };
        onSaved(await createDepartment(req));
      }
      onClose();
    } catch (e) {
      setError(
        (e as { message?: string })?.message || 'Failed to save department.'
      );
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    'w-full rounded-lg border border-[#D8D0BF] bg-white px-3 py-2 text-sm font-body text-[#17221B] focus:outline-none focus:border-[#4A5D4F]';

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={department ? 'Edit department' : 'New department'}
      description={
        department
          ? `Update ${department.name}`
          : 'Organise staff into a named department'
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700 font-body">
            {error}
          </div>
        )}
        <div>
          <label className="block font-body text-xs font-medium text-[#66706A] mb-1">
            Name *
          </label>
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            placeholder="e.g. Housekeeping"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block font-body text-xs font-medium text-[#66706A] mb-1">
              Code
            </label>
            <input
              className={inputCls}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={32}
              placeholder="HK"
            />
          </div>
          <div>
            <label className="block font-body text-xs font-medium text-[#66706A] mb-1">
              Status
            </label>
            <select
              className={inputCls}
              value={status}
              onChange={(e) => setStatus(e.target.value as 'active' | 'inactive')}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
        </div>
        <div>
          <label className="block font-body text-xs font-medium text-[#66706A] mb-1">
            Department head
          </label>
          <select
            className={inputCls}
            value={headUid}
            onChange={(e) => setHeadUid(e.target.value)}
          >
            <option value="">— none —</option>
            {activeStaff.map((e) => (
              <option key={e.employee_uid} value={e.employee_uid}>
                {e.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block font-body text-xs font-medium text-[#66706A] mb-1">
            Description
          </label>
          <textarea
            className={`${inputCls} min-h-[72px]`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? 'Saving…' : department ? 'Save changes' : 'Create department'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
