import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { PasswordInput } from '../auth/PasswordInput';
import { ApiError } from '../../api/client';
import { istDateKey } from '../../lib/datetime';
import { shiftsApi } from '../../api/shifts';

interface CreateEmployeeModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DEPARTMENTS = [
  'Front Desk Operations',
  'Housekeeping & Cleanliness',
  'Maintenance & Engineering',
  'Food & Beverage',
  'Guest Experience & Community',
  'Security & Safety',
  'Accounts & Administration',
];

export const CreateEmployeeModal: React.FC<CreateEmployeeModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { createEmployee, currentPropertyZones, activeProperty, addToast } = useApp();

  const [name, setName] = useState('');
  const [jobTitle, setJobTitle] = useState('Front Desk Associate');
  const [department, setDepartment] = useState(DEPARTMENTS[0]);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [zoneUid, setZoneUid] = useState('');
  const [startDate, setStartDate] = useState(istDateKey());
  const [shiftStart, setShiftStart] = useState('');
  const [shiftEnd, setShiftEnd] = useState('');
  const [shiftError, setShiftError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return; // prevent duplicate submissions

    // Validation — required fields, credential rules, duplicates
    if (!name.trim() || !email.trim()) return;

    let valid = true;
    setPasswordError(null);
    setConfirmError(null);
    setEmailError(null);

    if (password.length < 8) {
      setPasswordError('Password must be at least 8 characters.');
      valid = false;
    }
    if (confirmPassword !== password) {
      setConfirmError('Passwords do not match.');
      valid = false;
    }
    if (!valid) return;

    // Shift times are optional but must be given as a pair
    setShiftError(null);
    if ((shiftStart && !shiftEnd) || (!shiftStart && shiftEnd)) {
      setShiftError('Enter both a shift start and end time, or neither.');
      return;
    }

    setIsSubmitting(true);
    try {
      // POST /employees — creates the staff record and its login credential
      const created = await createEmployee({
        name: name.trim(),
        job_title: jobTitle.trim(),
        department: department as any,
        email: email.trim(),
        phone: phone.trim() || undefined,
        password,
        zone_uid: zoneUid ? zoneUid : null,
        start_date: startDate,
      });

      // Optional shift — reuse an active definition with matching times or
      // create one (all-days working pattern; editable under Shifts), then
      // assign it effective from the joining date. Employee creation must
      // not fail if this step does — warn instead.
      if (shiftStart && shiftEnd && activeProperty?.property_uid) {
        try {
          const { items } = await shiftsApi.list(activeProperty.property_uid);
          let shift = items.find(
            (s) =>
              s.is_active &&
              s.start_time === shiftStart &&
              s.end_time === shiftEnd
          );
          if (!shift) {
            shift = await shiftsApi.create({
              property_uid: activeProperty.property_uid,
              name: `${shiftStart}–${shiftEnd} shift`,
              start_time: shiftStart,
              end_time: shiftEnd,
            });
          }
          await shiftsApi.assign(created.employee_uid, {
            shift_uid: shift.shift_uid,
            effective_from: startDate,
          });
        } catch (err) {
          addToast({
            type: 'error',
            title: 'Shift Not Assigned',
            description:
              err instanceof ApiError
                ? err.message
                : 'Employee created, but the shift could not be assigned — set it under the Shifts tab.',
          });
        }
      }

      setName('');
      setEmail('');
      setPhone('');
      setZoneUid('');
      setShiftStart('');
      setShiftEnd('');
      setPassword('');
      setConfirmPassword('');
      onClose();
    } catch (err) {
      if (err instanceof ApiError && (err.field === 'email' || err.field === 'username')) {
        setEmailError(err.message);
      }
      // Context already surfaced a generic error toast for non-field failures
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Add Property Staff Member"
      description="Register an operational employee. Auto-generates an immutable Employee ID."
      maxWidth="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-semibold text-[#45413B] uppercase tracking-wider mb-1 font-body">
            Full Name *
          </label>
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Anjali Nair"
            className="w-full px-3.5 py-2 bg-[#FAF8F5] border border-[#DDD7CB] rounded-[10px] text-sm text-[#24221F] focus:outline-none focus:ring-2 focus:ring-[#386641]"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div>
            <label className="block text-xs font-semibold text-[#45413B] uppercase tracking-wider mb-1 font-body">
              Job Title / Designation *
            </label>
            <input
              type="text"
              required
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder="e.g. Head Housekeeper"
              className="w-full px-3.5 py-2 bg-[#FAF8F5] border border-[#DDD7CB] rounded-[10px] text-sm text-[#24221F] focus:outline-none focus:ring-2 focus:ring-[#386641]"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#45413B] uppercase tracking-wider mb-1 font-body">
              Department *
            </label>
            <select
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              className="w-full px-3.5 py-2 bg-[#FAF8F5] border border-[#DDD7CB] rounded-[10px] text-sm text-[#24221F] focus:outline-none focus:ring-2 focus:ring-[#386641]"
            >
              {DEPARTMENTS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div>
            <label className="block text-xs font-semibold text-[#45413B] uppercase tracking-wider mb-1 font-body">
              Work Email *
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setEmailError(null);
              }}
              placeholder="anjali.nair@zostel.com"
              aria-invalid={!!emailError}
              className={`w-full px-3.5 py-2 bg-[#FAF8F5] border rounded-[10px] text-sm text-[#24221F] focus:outline-none focus:ring-2 focus:ring-[#386641] ${
                emailError ? 'border-[#D96C6C]' : 'border-[#DDD7CB]'
              }`}
            />
            {emailError && (
              <p className="text-[11px] text-[#A32A2A] font-medium mt-1">{emailError}</p>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#45413B] uppercase tracking-wider mb-1 font-body">
              Phone Number
            </label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91 98765 43210"
              className="w-full px-3.5 py-2 bg-[#FAF8F5] border border-[#DDD7CB] rounded-[10px] text-sm text-[#24221F] focus:outline-none focus:ring-2 focus:ring-[#386641]"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div>
            <label className="block text-xs font-semibold text-[#45413B] uppercase tracking-wider mb-1 font-body">
              Initial Zone Allocation
            </label>
            <select
              value={zoneUid}
              onChange={(e) => setZoneUid(e.target.value)}
              className="w-full px-3.5 py-2 bg-[#FAF8F5] border border-[#DDD7CB] rounded-[10px] text-sm text-[#24221F] focus:outline-none focus:ring-2 focus:ring-[#386641]"
            >
              <option value="">(Unallocated Pool)</option>
              {currentPropertyZones.map((z) => (
                <option key={z.zone_uid} value={z.zone_uid}>
                  {z.name} ({z.floor})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#45413B] uppercase tracking-wider mb-1 font-body">
              Joining Date
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full px-3.5 py-2 bg-[#FAF8F5] border border-[#DDD7CB] rounded-[10px] text-sm text-[#24221F] focus:outline-none focus:ring-2 focus:ring-[#386641]"
            />
          </div>
        </div>

        {/* Optional shift — feeds schedule-aware attendance metrics */}
        <div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div>
              <label className="block text-xs font-semibold text-[#45413B] uppercase tracking-wider mb-1 font-body">
                Shift Start (IST)
              </label>
              <input
                type="time"
                value={shiftStart}
                onChange={(e) => {
                  setShiftStart(e.target.value);
                  setShiftError(null);
                }}
                aria-invalid={!!shiftError}
                className={`w-full px-3.5 py-2 bg-[#FAF8F5] border rounded-[10px] text-sm text-[#24221F] focus:outline-none focus:ring-2 focus:ring-[#386641] ${
                  shiftError ? 'border-[#D96C6C]' : 'border-[#DDD7CB]'
                }`}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-[#45413B] uppercase tracking-wider mb-1 font-body">
                Shift End (IST)
              </label>
              <input
                type="time"
                value={shiftEnd}
                onChange={(e) => {
                  setShiftEnd(e.target.value);
                  setShiftError(null);
                }}
                aria-invalid={!!shiftError}
                className={`w-full px-3.5 py-2 bg-[#FAF8F5] border rounded-[10px] text-sm text-[#24221F] focus:outline-none focus:ring-2 focus:ring-[#386641] ${
                  shiftError ? 'border-[#D96C6C]' : 'border-[#DDD7CB]'
                }`}
              />
            </div>
          </div>
          {shiftError ? (
            <p className="text-[11px] text-[#A32A2A] font-medium mt-1">
              {shiftError}
            </p>
          ) : (
            <p className="text-[11px] text-[#8C867C] mt-1.5 font-body">
              Optional. An end ≤ start counts as an overnight shift. Assigned
              every day from the joining date — adjust days or grace under the
              Shifts tab.
            </p>
          )}
        </div>

        {/* Login credentials — the employee signs in with these */}
        <div className="pt-2 border-t border-[#F2ECE3]">
          <p className="text-[11px] font-semibold text-[#8C867C] uppercase tracking-widest mb-3">
            Staff Login Credentials
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <PasswordInput
              id="emp-password"
              label="Password"
              value={password}
              onChange={(v) => {
                setPassword(v);
                setPasswordError(null);
              }}
              placeholder="Create a password"
              error={passwordError || undefined}
              autoComplete="new-password"
            />
            <PasswordInput
              id="emp-confirm-password"
              label="Confirm Password"
              value={confirmPassword}
              onChange={(v) => {
                setConfirmPassword(v);
                setConfirmError(null);
              }}
              placeholder="Confirm the password"
              error={confirmError || undefined}
              autoComplete="new-password"
            />
          </div>
          <p className="text-[11px] text-[#8C867C] mt-2 font-body">
            The employee uses their work email and this password to sign in to their workspace.
          </p>
        </div>

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-[#F0ECE4]">
          <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" isLoading={isSubmitting}>
            Add Staff Member
          </Button>
        </div>
      </form>
    </Modal>
  );
};
