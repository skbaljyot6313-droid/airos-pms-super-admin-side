import React, { useEffect, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { PasswordInput } from '../auth/PasswordInput';
import { ApiError } from '../../api/client';
import { istDateKey } from '../../lib/datetime';
import { shiftsApi } from '../../api/shifts';
import { payrollApi } from '../../api/payroll';
import { listDepartments } from '../../api/departments';

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
  // Live managed departments — falls back to the canonical picklist when
  // the property's department set hasn't materialised yet.
  const [deptOptions, setDeptOptions] = useState<string[]>(DEPARTMENTS);
  useEffect(() => {
    if (!isOpen || !activeProperty?.property_uid) return;
    let live = true;
    listDepartments({ property_uid: activeProperty.property_uid })
      .then((ds) => {
        if (live && ds.length) setDeptOptions(ds.map((d) => d.name));
      })
      .catch(() => {/* keep static fallback */});
    return () => {
      live = false;
    };
  }, [isOpen, activeProperty?.property_uid]);

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

  // Compensation & statutory — optional. A salary structure is only created
  // when a basic amount is given; effective from the joining date.
  const [calcMethod, setCalcMethod] = useState<'monthly' | 'daily' | 'hourly'>('monthly');
  const [basic, setBasic] = useState('');
  const [hra, setHra] = useState('');
  const [incentive, setIncentive] = useState('');
  const [otRate, setOtRate] = useState('');
  const [deductions, setDeductions] = useState<{ code: string; value: string }[]>([]);
  const [allowances, setAllowances] = useState<{ name: string; amount: string }[]>([]);
  const [leaves, setLeaves] = useState<{ leave_type: string; days: string }[]>([]);
  const [salaryError, setSalaryError] = useState<string | null>(null);

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

    // Salary is optional — but if given it must parse cleanly, and any
    // enabled statutory deduction needs a value.
    setSalaryError(null);
    const salaryGiven = basic.trim() !== '';
    if (salaryGiven) {
      const amounts = [basic, hra, incentive, otRate];
      if (amounts.some((a) => a.trim() !== '' && (Number.isNaN(Number(a)) || Number(a) < 0))) {
        setSalaryError('Salary amounts must be non-negative numbers.');
        return;
      }
      if (Number.isNaN(Number(basic)) || Number(basic) < 0) {
        setSalaryError('Basic salary must be a non-negative number.');
        return;
      }
      const badDed = deductions.find(
        (d) => d.value.trim() === '' || Number.isNaN(Number(d.value)) || Number(d.value) < 0
      );
      if (badDed) {
        setSalaryError(`Enter a valid ${badDed.code} deduction amount, or remove the line.`);
        return;
      }
      const badAllow = allowances.find(
        (a) => a.name.trim() === '' || a.amount.trim() === '' || Number.isNaN(Number(a.amount)) || Number(a.amount) < 0
      );
      if (badAllow) {
        setSalaryError('Each allowance needs a name and a valid amount, or remove the line.');
        return;
      }
    } else if (allowances.length > 0) {
      setSalaryError('Enter a Basic salary to save compensation line items.');
      return;
    }

    // Leave lines are independent — each needs a valid positive day count.
    const badLeave = leaves.find(
      (l) => l.days.trim() === '' || Number.isNaN(Number(l.days)) || Number(l.days) <= 0
    );
    if (badLeave) {
      setSalaryError('Each leave needs a valid number of days, or remove the line.');
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

      // Optional salary structure — same failure policy as shift: employee
      // creation must not fail if this step does; warn instead.
      if (salaryGiven) {
        try {
          await payrollApi.createStructure(created.employee_uid, {
            calc_method: calcMethod,
            effective_from: startDate,
            basic: Number(basic),
            hra: hra.trim() === '' ? 0 : Number(hra),
            incentive: incentive.trim() === '' ? 0 : Number(incentive),
            overtime_rate: otRate.trim() === '' ? 0 : Number(otRate),
            allowances: allowances.map((a) => ({ name: a.name.trim(), amount: Number(a.amount) })),
            deductions: deductions.map(({ code, value }) => ({
              code, mode: 'fixed', value: Number(value), basis: 'basic',
            })),
          });
        } catch (err) {
          addToast({
            type: 'error',
            title: 'Salary Not Saved',
            description:
              err instanceof ApiError
                ? err.message
                : 'Employee created, but the salary structure could not be saved — set it under Payroll.',
          });
        }
      }

      // Optional opening leave entitlements — same non-blocking policy.
      if (leaves.length > 0) {
        try {
          await payrollApi.postLeaveEntries(
            created.employee_uid,
            leaves.map((l) => ({
              leave_type: l.leave_type,
              days: Number(l.days),
              reason: 'Opening leave entitlement',
            }))
          );
        } catch (err) {
          addToast({
            type: 'error',
            title: 'Leave Balance Not Saved',
            description:
              err instanceof ApiError
                ? err.message
                : 'Employee created, but the leave entitlements could not be saved — adjust them under Payroll.',
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
      setBasic('');
      setHra('');
      setIncentive('');
      setOtRate('');
      setDeductions([]);
      setAllowances([]);
      setLeaves([]);
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
          <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
            Full Name *
          </label>
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Anjali Nair"
            className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div>
            <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
              Job Title / Designation *
            </label>
            <input
              type="text"
              required
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder="e.g. Head Housekeeper"
              className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
              Department *
            </label>
            <select
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
            >
              {deptOptions.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div>
            <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
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
              className={`w-full px-3.5 py-2 bg-[#FFFFFF] border rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020] ${
                emailError ? 'border-[#D64545]' : 'border-[#D6D3D1]'
              }`}
            />
            {emailError && (
              <p className="text-[11px] text-[#A83434] font-medium mt-1">{emailError}</p>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
              Phone Number
            </label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91 98765 43210"
              className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div>
            <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
              Initial Zone Allocation
            </label>
            <select
              value={zoneUid}
              onChange={(e) => setZoneUid(e.target.value)}
              className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
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
            <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
              Joining Date
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
            />
          </div>
        </div>

        {/* Optional shift — feeds schedule-aware attendance metrics */}
        <div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div>
              <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
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
                className={`w-full px-3.5 py-2 bg-[#FFFFFF] border rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020] ${
                  shiftError ? 'border-[#D64545]' : 'border-[#D6D3D1]'
                }`}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
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
                className={`w-full px-3.5 py-2 bg-[#FFFFFF] border rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020] ${
                  shiftError ? 'border-[#D64545]' : 'border-[#D6D3D1]'
                }`}
              />
            </div>
          </div>
          {shiftError ? (
            <p className="text-[11px] text-[#A83434] font-medium mt-1">
              {shiftError}
            </p>
          ) : (
            <p className="text-[11px] text-[#667085] mt-1.5 font-body">
              Optional. An end ≤ start counts as an overnight shift. Assigned
              every day from the joining date — adjust days or grace under the
              Shifts tab.
            </p>
          )}
        </div>

        {/* Compensation & statutory — optional salary structure + deductions */}
        <div className="pt-2 border-t border-[#F6F4F2]">
          <p className="text-[11px] font-semibold text-[#667085] uppercase tracking-widest mb-3">
            Compensation &amp; Statutory
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div>
              <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
                Pay Basis
              </label>
              <select
                value={calcMethod}
                onChange={(e) => setCalcMethod(e.target.value as 'monthly' | 'daily' | 'hourly')}
                className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
              >
                <option value="monthly">Monthly</option>
                <option value="daily">Daily</option>
                <option value="hourly">Hourly</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
                Basic (₹)
              </label>
              <input
                type="number" min="0" step="0.01"
                value={basic}
                onChange={(e) => { setBasic(e.target.value); setSalaryError(null); }}
                placeholder="e.g. 22000"
                className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
                HRA (₹)
              </label>
              <input
                type="number" min="0" step="0.01"
                value={hra}
                onChange={(e) => { setHra(e.target.value); setSalaryError(null); }}
                placeholder="0"
                className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
                Incentive (₹)
              </label>
              <input
                type="number" min="0" step="0.01"
                value={incentive}
                onChange={(e) => { setIncentive(e.target.value); setSalaryError(null); }}
                placeholder="0"
                className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1 font-body">
                Overtime Rate (₹/hr)
              </label>
              <input
                type="number" min="0" step="0.01"
                value={otRate}
                onChange={(e) => { setOtRate(e.target.value); setSalaryError(null); }}
                placeholder="0"
                className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
              />
            </div>
          </div>

          <div className="mt-3.5">
            <p className="text-[11px] font-semibold text-[#667085] uppercase tracking-wider mb-2">
              Allowances &amp; Components
            </p>
            <div className="space-y-2">
              {allowances.map((a, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={a.name}
                    onChange={(e) =>
                      setAllowances((as) =>
                        as.map((x, j) => (j === i ? { ...x, name: e.target.value } : x))
                      )
                    }
                    placeholder="e.g. Night allowance"
                    className="flex-1 min-w-0 px-2.5 py-1.5 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[8px] text-sm text-[#0D1C42] placeholder:text-[#98A2B3] focus:outline-none focus:ring-2 focus:ring-[#800020]"
                  />
                  <div className="relative w-32">
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-[#667085]">₹</span>
                    <input
                      type="number" min="0" step="0.01"
                      value={a.amount}
                      onChange={(e) =>
                        setAllowances((as) =>
                          as.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x))
                        )
                      }
                      placeholder="0.00"
                      className="w-full pl-6 pr-2.5 py-1.5 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[8px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setAllowances((as) => as.filter((_, j) => j !== i))}
                    className="text-[#667085] hover:text-[#D64545] text-xs font-semibold px-1"
                    title="Remove allowance"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setAllowances((as) => [...as, { name: '', amount: '' }])}
                className="text-xs font-semibold text-[#800020] hover:underline"
              >
                + Add allowance
              </button>
            </div>
          </div>

          <div className="mt-3.5">
            <p className="text-[11px] font-semibold text-[#667085] uppercase tracking-wider mb-2">
              Deductions
            </p>
            <div className="space-y-2">
              {deductions.map((d, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select
                    value={d.code}
                    onChange={(e) =>
                      setDeductions((ds) =>
                        ds.map((x, j) => (j === i ? { ...x, code: e.target.value } : x))
                      )
                    }
                    className="w-28 px-2 py-1.5 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[8px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
                  >
                    {['PF', 'ESI', 'TDS', 'other'].map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <div className="relative flex-1 max-w-[160px]">
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-[#667085]">₹</span>
                    <input
                      type="number" min="0" step="0.01"
                      value={d.value}
                      onChange={(e) =>
                        setDeductions((ds) =>
                          ds.map((x, j) => (j === i ? { ...x, value: e.target.value } : x))
                        )
                      }
                      placeholder="0.00"
                      className="w-full pl-6 pr-2.5 py-1.5 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[8px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setDeductions((ds) => ds.filter((_, j) => j !== i))}
                    className="text-[#667085] hover:text-[#D64545] text-xs font-semibold px-1"
                    title="Remove deduction"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setDeductions((ds) => [...ds, { code: 'PF', value: '' }])}
                className="text-xs font-semibold text-[#800020] hover:underline"
              >
                + Add deduction
              </button>
            </div>
          </div>

          {salaryError ? (
            <p className="text-[11px] text-[#A83434] font-medium mt-2">{salaryError}</p>
          ) : (
            <p className="text-[11px] text-[#667085] mt-2.5 font-body">
              Optional. Leave Basic empty to skip — the structure is created effective from the
              joining date and can be revised under Payroll.
            </p>
          )}
        </div>

        {/* Leave entitlements — opening balances per leave type */}
        <div className="pt-2 border-t border-[#F6F4F2]">
          <p className="text-[11px] font-semibold text-[#667085] uppercase tracking-widest mb-3">
            Leaves
          </p>
          <div className="space-y-2">
            {leaves.map((l, i) => (
              <div key={i} className="flex items-center gap-2">
                <select
                  value={l.leave_type}
                  onChange={(e) =>
                    setLeaves((ls) =>
                      ls.map((x, j) => (j === i ? { ...x, leave_type: e.target.value } : x))
                    )
                  }
                  className="w-44 px-2 py-1.5 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[8px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
                >
                  <option value="CL">Casual Leave (CL)</option>
                  <option value="SL">Sick Leave (SL)</option>
                  <option value="EL">Earned Leave (EL)</option>
                  <option value="other">Other</option>
                </select>
                <div className="relative w-28">
                  <input
                    type="number" min="0.5" step="0.5"
                    value={l.days}
                    onChange={(e) =>
                      setLeaves((ls) =>
                        ls.map((x, j) => (j === i ? { ...x, days: e.target.value } : x))
                      )
                    }
                    placeholder="0"
                    className="w-full px-2.5 py-1.5 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[8px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
                  />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-[#98A2B3]">days</span>
                </div>
                <button
                  type="button"
                  onClick={() => setLeaves((ls) => ls.filter((_, j) => j !== i))}
                  className="text-[#667085] hover:text-[#D64545] text-xs font-semibold px-1"
                  title="Remove leave"
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setLeaves((ls) => [...ls, { leave_type: 'CL', days: '' }])}
              className="text-xs font-semibold text-[#800020] hover:underline"
            >
              + Add leave
            </button>
          </div>
          <p className="text-[11px] text-[#667085] mt-2.5 font-body">
            Optional. Opening entitlements posted to the leave ledger — balances can be
            adjusted later under Payroll.
          </p>
        </div>

        {/* Login credentials — the employee signs in with these */}
        <div className="pt-2 border-t border-[#F6F4F2]">
          <p className="text-[11px] font-semibold text-[#667085] uppercase tracking-widest mb-3">
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
          <p className="text-[11px] text-[#667085] mt-2 font-body">
            The employee uses their work email and this password to sign in to their workspace.
          </p>
        </div>

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-[#F6F4F2]">
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
