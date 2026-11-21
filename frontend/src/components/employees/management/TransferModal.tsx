import React, { useMemo, useState } from 'react';
import { Modal } from '../../ui/Modal';
import { Button } from '../../ui/Button';
import {
  Department,
  transferEmployees,
} from '../../../api/departments';

interface EmployeeLite {
  employee_uid: string;
  name: string;
  department_uid?: string | null;
  department?: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  propertyUid: string;
  employees: EmployeeLite[];          // preselected
  departments: Department[];
  /** heads: employee_uid → dept name (to flag head-of-dept employees) */
  headOf: Record<string, string>;
  /** active staff eligible as replacement heads */
  staffOptions: EmployeeLite[];
  onDone: () => void;
}

export const TransferModal: React.FC<Props> = ({
  open,
  onClose,
  propertyUid,
  employees,
  departments,
  headOf,
  staffOptions,
  onDone,
}) => {
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [headAction, setHeadAction] = useState<'clear' | 'replace'>('clear');
  const [replacement, setReplacement] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeDepts = departments.filter((d) => d.status === 'active');
  const involvesHead = useMemo(
    () => employees.some((e) => headOf[e.employee_uid]),
    [employees, headOf]
  );

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await transferEmployees({
        property_uid: propertyUid,
        employee_uids: employees.map((e) => e.employee_uid),
        to_department_uid: target || null,
        reason: reason.trim() || null,
        ...(involvesHead
          ? {
              head_action: headAction,
              ...(headAction === 'replace' && replacement
                ? { replacement_head_uid: replacement }
                : {}),
            }
          : {}),
      });
      onDone();
      onClose();
    } catch (e) {
      setError((e as { message?: string })?.message || 'Transfer failed.');
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    'w-full rounded-lg border border-[#D8D0BF] bg-white px-3 py-2 text-sm font-body text-[#17221B] focus:outline-none focus:border-[#4A5D4F]';

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={`Transfer ${employees.length} employee${employees.length > 1 ? 's' : ''}`}
      description="Move staff between departments"
    >
      <div className="space-y-4">
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700 font-body">
            {error}
          </div>
        )}

        <div className="rounded-lg bg-[#F6F3EC] px-3 py-2 max-h-32 overflow-y-auto">
          {employees.map((e) => (
            <div
              key={e.employee_uid}
              className="flex items-center justify-between font-body text-sm py-0.5"
            >
              <span className="text-[#17221B]">{e.name}</span>
              <span className="text-[#9A9484] text-xs">
                {e.department || 'Unassigned'}
                {headOf[e.employee_uid] ? ` · heads ${headOf[e.employee_uid]}` : ''}
              </span>
            </div>
          ))}
        </div>

        <div>
          <label className="block font-body text-xs font-medium text-[#66706A] mb-1">
            Destination department
          </label>
          <select
            className={inputCls}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">— Unassigned (remove from department) —</option>
            {activeDepts.map((d) => (
              <option key={d.department_uid} value={d.department_uid}>
                {d.name} ({d.employee_count} staff)
              </option>
            ))}
          </select>
        </div>

        {involvesHead && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 space-y-2">
            <p className="font-body text-xs text-amber-800">
              Selection includes a department head — choose how to handle the
              head assignment.
            </p>
            <div className="flex items-center gap-3 font-body text-sm">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={headAction === 'clear'}
                  onChange={() => setHeadAction('clear')}
                />
                Remove head
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={headAction === 'replace'}
                  onChange={() => setHeadAction('replace')}
                />
                Replace with
              </label>
            </div>
            {headAction === 'replace' && (
              <select
                className={inputCls}
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
              >
                <option value="">Select replacement head…</option>
                {staffOptions.map((e) => (
                  <option key={e.employee_uid} value={e.employee_uid}>
                    {e.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        <div>
          <label className="block font-body text-xs font-medium text-[#66706A] mb-1">
            Reason (optional)
          </label>
          <input
            className={inputCls}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Restructure, new assignment"
            maxLength={2000}
          />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={run} disabled={busy}>
            {busy ? 'Transferring…' : 'Confirm transfer'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
