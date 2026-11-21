import React, { useEffect, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Modal } from '../../ui/Modal';
import { Button } from '../../ui/Button';
import { departmentWorkApi, type RosterItem } from '../../../api/departmentWork';
import { useApp } from '../../../context/AppContext';
import { ApiError } from '../../../api/client';

interface Props {
  open: boolean;
  onClose: () => void;
  departmentUid: string;
  roster: RosterItem[];
  zones: { zone_uid: string; name: string }[];
  onAllocated: () => void;
}

const WORK_TYPES = ['cleaning', 'maintenance', 'inspection', 'housekeeping', 'other'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

const field =
  'w-full px-3 py-2 bg-white border border-[#D6D3D1] rounded-[9px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]';
const lbl = 'block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1';

/** Allocate Work — department-scoped task creation with multi-assign. */
export const AllocateWorkModal: React.FC<Props> = ({
  open, onClose, departmentUid, roster, zones, onAllocated,
}) => {
  const { activePropertyUid, addToast } = useApp();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [workType, setWorkType] = useState('housekeeping');
  const [priority, setPriority] = useState('medium');
  const [assignees, setAssignees] = useState<Set<string>>(new Set());
  const [empSearch, setEmpSearch] = useState('');
  const [schedDate, setSchedDate] = useState('');
  const [schedTime, setSchedTime] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [zoneUid, setZoneUid] = useState('');
  const [checklist, setChecklist] = useState<{ title: string; required: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(''); setDescription(''); setWorkType('housekeeping');
    setPriority('medium'); setAssignees(new Set()); setEmpSearch('');
    setSchedDate(''); setSchedTime(''); setDueDate(''); setDueTime('');
    setZoneUid(''); setChecklist([]); setErr(null); setBusy(false);
  }, [open]);

  const filtered = useMemo(() => {
    const q = empSearch.trim().toLowerCase();
    return roster.filter((r) => !q || r.name.toLowerCase().includes(q));
  }, [roster, empSearch]);

  const toggle = (uid: string) =>
    setAssignees((s) => {
      const n = new Set(s);
      if (n.has(uid)) n.delete(uid); else n.add(uid);
      return n;
    });

  const submit = async () => {
    if (!title.trim()) return setErr('Work needs a title.');
    if (assignees.size === 0) return setErr('Assign the work to at least one employee.');
    setBusy(true);
    setErr(null);
    try {
      const scheduled_for =
        schedDate && schedTime ? `${schedDate}T${schedTime}:00`
          : schedDate ? `${schedDate}T09:00:00` : undefined;
      await departmentWorkApi.allocateWork(departmentUid, {
        property_uid: activePropertyUid!,
        title: title.trim(),
        description: description.trim() || undefined,
        work_type: workType,
        priority,
        employee_uids: [...assignees],
        zone_uid: zoneUid || undefined,
        due_date: dueDate || undefined,
        due_time: dueTime || undefined,
        scheduled_for,
        checklist: checklist
          .filter((c) => c.title.trim())
          .map((c) => ({ title: c.title.trim(), required: c.required })),
      });
      addToast({
        type: 'success', title: 'Work allocated',
        description: `${assignees.size} employee${assignees.size > 1 ? 's' : ''} assigned.`,
      });
      onAllocated();
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not allocate the work.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} title="Allocate Work" maxWidth="xl">
      <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
        {err && <p className="text-[12px] text-[#A83434] font-medium">{err}</p>}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className={lbl}>Work title *</label>
            <input className={field} value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Prepare Conference Hall" />
          </div>
          <div className="sm:col-span-2">
            <label className={lbl}>Instructions</label>
            <textarea className={field} rows={2} value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What needs to be done, and how" />
          </div>
          <div>
            <label className={lbl}>Work type</label>
            <select className={field} value={workType} onChange={(e) => setWorkType(e.target.value)}>
              {WORK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className={lbl}>Priority</label>
            <select className={field} value={priority} onChange={(e) => setPriority(e.target.value)}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className={lbl}>Scheduled date</label>
            <input type="date" className={field} value={schedDate} onChange={(e) => setSchedDate(e.target.value)} />
          </div>
          <div>
            <label className={lbl}>Start time</label>
            <input type="time" className={field} value={schedTime} onChange={(e) => setSchedTime(e.target.value)} />
          </div>
          <div>
            <label className={lbl}>Due date</label>
            <input type="date" className={field} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div>
            <label className={lbl}>Due time</label>
            <input type="time" className={field} value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
          </div>
          {zones.length > 0 && (
            <div className="sm:col-span-2">
              <label className={lbl}>Zone (optional)</label>
              <select className={field} value={zoneUid} onChange={(e) => setZoneUid(e.target.value)}>
                <option value="">No specific location</option>
                {zones.map((z) => <option key={z.zone_uid} value={z.zone_uid}>{z.name}</option>)}
              </select>
            </div>
          )}
        </div>

        {/* Assignees */}
        <div>
          <label className={lbl}>Assign to ({assignees.size} selected)</label>
          <input className={field} placeholder="Search employees…" value={empSearch}
            onChange={(e) => setEmpSearch(e.target.value)} />
          <div className="mt-2 space-y-1 max-h-44 overflow-y-auto">
            {filtered.map((r) => (
              <label key={r.employee_uid}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-[8px] border cursor-pointer text-sm ${
                  assignees.has(r.employee_uid)
                    ? 'border-[#800020] bg-[#F7E9EE]'
                    : 'border-[#E7E5E4] hover:border-[#D6D3D1]'
                }`}>
                <input type="checkbox" checked={assignees.has(r.employee_uid)}
                  onChange={() => toggle(r.employee_uid)} className="accent-[#800020]" />
                <span className="flex-1 min-w-0">
                  <span className="font-medium text-[#0D1C42]">{r.name}</span>
                  {r.is_head && <span className="ml-1 text-[10px] text-[#A56514]">Head</span>}
                  <span className="block text-[11px] text-[#667085]">
                    {r.shift?.scheduled
                      ? `${r.shift.name} ${r.shift.start_time}–${r.shift.end_time}`
                      : r.shift ? `${r.shift.name} — off today` : 'No shift'}
                    {r.attendance_status ? ` · ${r.attendance_status}` : ' · not marked'}
                  </span>
                </span>
                <span className={`text-[11px] font-semibold shrink-0 ${
                  r.open_tasks > 0 ? 'text-[#8A5A10]' : 'text-[#667085]'}`}>
                  {r.open_tasks} open
                </span>
              </label>
            ))}
            {filtered.length === 0 && (
              <p className="text-[12px] text-[#667085] py-2">No matching employees in this department.</p>
            )}
          </div>
        </div>

        {/* Checklist */}
        <div>
          <label className={lbl}>Checklist</label>
          <div className="space-y-1.5">
            {checklist.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <input className={`${field} flex-1`} placeholder={`Step ${i + 1}`}
                  value={c.title}
                  onChange={(e) => setChecklist((cs) => cs.map((x, j) => j === i ? { ...x, title: e.target.value } : x))} />
                <label className="flex items-center gap-1 text-[11px] text-[#667085] shrink-0">
                  <input type="checkbox" checked={c.required} className="accent-[#800020]"
                    onChange={(e) => setChecklist((cs) => cs.map((x, j) => j === i ? { ...x, required: e.target.checked } : x))} />
                  Req
                </label>
                <button type="button" onClick={() => setChecklist((cs) => cs.filter((_, j) => j !== i))}
                  className="text-[#667085] hover:text-[#D64545]"><X className="w-4 h-4" /></button>
              </div>
            ))}
            <button type="button"
              onClick={() => setChecklist((cs) => [...cs, { title: '', required: true }])}
              className="flex items-center gap-1 text-[12px] font-semibold text-[#800020] hover:underline">
              <Plus className="w-3.5 h-3.5" /> Add step
            </button>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between mt-5 pt-4 border-t border-[#F6F4F2]">
        <p className="text-[11px] text-[#667085]">
          {title.trim()
            ? `${title.trim()} · ${assignees.size} assignee${assignees.size !== 1 ? 's' : ''}${
                schedDate ? ` · ${schedDate}${schedTime ? ' ' + schedTime : ''}` : ''}${
                dueDate ? ` · due ${dueDate}${dueTime ? ' ' + dueTime : ''}` : ''}`
            : 'Fill the form — a summary appears here.'}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Allocating…' : 'Allocate'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
