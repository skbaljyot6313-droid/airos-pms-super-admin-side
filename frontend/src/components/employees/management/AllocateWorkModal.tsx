import React, { useEffect, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Modal } from '../../ui/Modal';
import { Button } from '../../ui/Button';
import {
  departmentWorkApi,
  ConflictError,
  type RosterItem,
  type ScheduleConflict,
} from '../../../api/departmentWork';
import { listDepartments, type Department } from '../../../api/departments';
import { useApp } from '../../../context/AppContext';
import { ApiError } from '../../../api/client';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Fixed department scope (department page). When omitted the modal is
   *  the organisation-wide Assign Work surface — a department picker is
   *  shown and assignees may span several departments (one request per
   *  department, shared batch semantics). */
  departmentUid?: string;
  roster?: RosterItem[];
  zones: { zone_uid: string; name: string }[];
  onAllocated: () => void;
}

const WORK_TYPES = ['cleaning', 'maintenance', 'inspection', 'housekeeping', 'other'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

const field =
  'w-full px-3 py-2 bg-white border border-[#D6D3D1] rounded-[9px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]';
const lbl = 'block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1';

const hm = (v: string) => v.slice(0, 5);
const toMin = (v: string) => {
  const [h, m] = v.split(':').map(Number);
  return h * 60 + m;
};

interface SelectedEmp { uid: string; name: string; department_uid: string }

/** Assign Work — multi-employee allocation with the shared schedule
 * window contract, conflict surfacing and explicit override. */
export const AllocateWorkModal: React.FC<Props> = ({
  open, onClose, departmentUid, roster: rosterProp, zones, onAllocated,
}) => {
  const { activePropertyUid, currentUser, addToast } = useApp();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [notes, setNotes] = useState('');
  const [workType, setWorkType] = useState('housekeeping');
  const [priority, setPriority] = useState('medium');
  const [assignees, setAssignees] = useState<Map<string, SelectedEmp>>(new Map());
  const [empSearch, setEmpSearch] = useState('');
  const [workDate, setWorkDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [breakStart, setBreakStart] = useState('');
  const [breakEnd, setBreakEnd] = useState('');
  const [estMinutes, setEstMinutes] = useState('');
  const [estTouched, setEstTouched] = useState(false);
  const [dueTime, setDueTime] = useState('');
  const [zoneUid, setZoneUid] = useState('');
  const [checklist, setChecklist] = useState<{ title: string; required: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ScheduleConflict[] | null>(null);

  // Org-wide mode state — departments + per-department rosters.
  const orgWide = !departmentUid;
  const [departments, setDepartments] = useState<Department[]>([]);
  const [pickedDept, setPickedDept] = useState('');
  const [rosters, setRosters] = useState<Record<string, RosterItem[]>>({});

  useEffect(() => {
    if (!open) return;
    setTitle(''); setDescription(''); setNotes(''); setWorkType('housekeeping');
    setPriority('medium'); setAssignees(new Map()); setEmpSearch('');
    setWorkDate(''); setStartTime(''); setEndTime('');
    setBreakStart(''); setBreakEnd(''); setEstMinutes(''); setEstTouched(false);
    setDueTime(''); setZoneUid(''); setChecklist([]); setErr(null);
    setConflicts(null); setBusy(false);
    if (orgWide && activePropertyUid) {
      setPickedDept('');
      setRosters({});
      listDepartments({ property_uid: activePropertyUid })
        .then((ds) => {
          setDepartments(ds.filter((d) => d.status !== 'inactive'));
          if (ds.length) setPickedDept(ds[0].department_uid);
        })
        .catch(() => setDepartments([]));
    }
  }, [open, orgWide, activePropertyUid]);

  // Lazy-load a department roster when picked (org-wide mode only).
  useEffect(() => {
    if (!orgWide || !pickedDept || rosters[pickedDept]) return;
    departmentWorkApi.roster(pickedDept)
      .then((r) => setRosters((m) => ({ ...m, [pickedDept]: r.items })))
      .catch(() => setRosters((m) => ({ ...m, [pickedDept]: [] })));
  }, [orgWide, pickedDept, rosters]);

  const roster = useMemo<RosterItem[]>(() => {
    if (!orgWide) return rosterProp ?? [];
    const out: RosterItem[] = [];
    for (const items of Object.values(rosters)) out.push(...items);
    return out;
  }, [orgWide, rosterProp, rosters]);

  const deptOf = useMemo(() => {
    const m = new Map<string, string>();
    if (!orgWide) return m;
    for (const [dept, items] of Object.entries(rosters))
      for (const r of items) m.set(r.employee_uid, dept);
    return m;
  }, [orgWide, rosters]);

  const deptName = useMemo(
    () => new Map(departments.map((d) => [d.department_uid, d.name])),
    [departments]);

  const filtered = useMemo(() => {
    const q = empSearch.trim().toLowerCase();
    const pool = orgWide ? (rosters[pickedDept] ?? []) : roster;
    return pool.filter((r) => !q || r.name.toLowerCase().includes(q));
  }, [orgWide, roster, rosters, pickedDept, empSearch]);

  // Estimated duration = window minus break, unless the user typed one.
  const autoEst = useMemo(() => {
    if (!startTime || !endTime) return null;
    let span = toMin(endTime) - toMin(startTime);
    if (span <= 0) span += 24 * 60; // overnight window
    if (breakStart && breakEnd) span -= Math.max(0, toMin(breakEnd) - toMin(breakStart));
    return span > 0 ? span : null;
  }, [startTime, endTime, breakStart, breakEnd]);

  const toggle = (r: RosterItem) =>
    setAssignees((s) => {
      const n = new Map(s);
      if (n.has(r.employee_uid)) n.delete(r.employee_uid);
      else n.set(r.employee_uid, {
        uid: r.employee_uid, name: r.name,
        department_uid: orgWide
          ? (deptOf.get(r.employee_uid) ?? pickedDept)
          : departmentUid!,
      });
      return n;
    });

  const submit = async (allowConflicts: boolean) => {
    if (!title.trim()) return setErr('Work needs a title.');
    if (assignees.size === 0) return setErr('Assign the work to at least one employee.');
    if ((breakStart && !breakEnd) || (!breakStart && breakEnd))
      return setErr('Break needs both a start and an end.');
    setBusy(true);
    setErr(null);
    setConflicts(null);
    try {
      const scheduled_for = workDate
        ? `${workDate}T${startTime || '09:00'}:00`
        : undefined;
      const est = estTouched && estMinutes
        ? Number(estMinutes)
        : autoEst ?? undefined;
      const byDept = new Map<string, string[]>();
      for (const a of assignees.values()) {
        const list = byDept.get(a.department_uid) ?? [];
        list.push(a.uid);
        byDept.set(a.department_uid, list);
      }
      for (const [dept, uids] of byDept) {
        await departmentWorkApi.allocateWork(dept, {
          property_uid: activePropertyUid!,
          title: title.trim(),
          description: description.trim() || undefined,
          notes: notes.trim() || undefined,
          work_type: workType,
          priority,
          employee_uids: uids,
          zone_uid: zoneUid || undefined,
          due_date: workDate || undefined,
          due_time: dueTime || undefined,
          scheduled_for,
          start_time: startTime || undefined,
          end_time: endTime || undefined,
          break_start_time: breakStart || undefined,
          break_end_time: breakEnd || undefined,
          estimated_minutes: est,
          checklist: checklist
            .filter((c) => c.title.trim())
            .map((c) => ({ title: c.title.trim(), required: c.required })),
          allow_conflicts: allowConflicts,
        });
      }
      addToast({
        type: 'success', title: 'Work allocated',
        description: `${assignees.size} employee${assignees.size > 1 ? 's' : ''} assigned.`,
      });
      onAllocated();
      onClose();
    } catch (e) {
      if (e instanceof ConflictError) {
        setConflicts(e.conflicts);
        setErr('This schedule conflicts with existing work — review below or assign anyway.');
      } else {
        setErr(e instanceof ApiError ? e.message : 'Could not allocate the work.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} title="Assign Work" maxWidth="xl">
      <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
        {err && <p className="text-[12px] text-[#A83434] font-medium">{err}</p>}
        {conflicts && (
          <div className="rounded-[10px] border border-[#D64545]/30 bg-[#FBE6E6]/60 p-3 space-y-1.5">
            <p className="text-[11px] font-bold text-[#A83434] uppercase tracking-wide">
              Scheduling conflicts
            </p>
            {conflicts.map((c) => (
              <p key={c.task_uid} className="text-[12px] text-[#667085]">
                <span className="font-semibold text-[#A83434]">
                  {c.kind === 'duplicate' ? 'Duplicate' : 'Overlap'}
                </span>
                {' · '}{c.employee_name ?? 'Employee'}{' · '}{c.title}
                {c.day ? ` · ${c.day}` : ''}
                {c.start_time ? ` · ${hm(c.start_time)}${c.end_time ? `–${hm(c.end_time)}` : ''}` : ''}
              </p>
            ))}
          </div>
        )}

        {/* Work information */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className={lbl}>Work title *</label>
            <input className={field} value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Prepare Conference Hall" />
          </div>
          <div className="sm:col-span-2">
            <label className={lbl}>Description / instructions</label>
            <textarea className={field} rows={2} value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What needs to be done, and how" />
          </div>
          <div className="sm:col-span-2">
            <label className={lbl}>Additional notes</label>
            <textarea className={field} rows={1} value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional context for the assignee — appended to the description" />
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
          {zones.length > 0 && (
            <div className="sm:col-span-2">
              <label className={lbl}>Physical location / zone (optional)</label>
              <select className={field} value={zoneUid} onChange={(e) => setZoneUid(e.target.value)}>
                <option value="">No specific location</option>
                {zones.map((z) => <option key={z.zone_uid} value={z.zone_uid}>{z.name}</option>)}
              </select>
            </div>
          )}
        </div>

        {/* Scheduling */}
        <div>
          <label className={lbl}>Scheduling</label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] text-[#667085] mb-1">Work date</label>
              <input type="date" className={field} value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
            </div>
            <div>
              <label className="block text-[11px] text-[#667085] mb-1">Start time</label>
              <input type="time" className={field} value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </div>
            <div>
              <label className="block text-[11px] text-[#667085] mb-1">End time</label>
              <input type="time" className={field} value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </div>
            <div>
              <label className="block text-[11px] text-[#667085] mb-1">Break start</label>
              <input type="time" className={field} value={breakStart} onChange={(e) => setBreakStart(e.target.value)} />
            </div>
            <div>
              <label className="block text-[11px] text-[#667085] mb-1">Break end</label>
              <input type="time" className={field} value={breakEnd} onChange={(e) => setBreakEnd(e.target.value)} />
            </div>
            <div>
              <label className="block text-[11px] text-[#667085] mb-1">Est. duration (min)</label>
              <input type="number" min={0} className={field} value={estMinutes || (estTouched ? '' : autoEst ?? '')}
                onChange={(e) => { setEstTouched(true); setEstMinutes(e.target.value); }}
                placeholder={autoEst != null ? String(autoEst) : '—'} />
            </div>
          </div>
        </div>

        {/* Assignees */}
        <div>
          <div className="flex items-end gap-2">
            {orgWide && (
              <div className="w-44 shrink-0">
                <label className={lbl}>Department</label>
                <select className={field} value={pickedDept} onChange={(e) => setPickedDept(e.target.value)}>
                  {departments.map((d) => (
                    <option key={d.department_uid} value={d.department_uid}>{d.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex-1">
              <label className={lbl}>Assign to ({assignees.size} selected)</label>
              <input className={field} placeholder="Search employees…" value={empSearch}
                onChange={(e) => setEmpSearch(e.target.value)} />
            </div>
          </div>
          <div className="mt-2 space-y-1 max-h-44 overflow-y-auto">
            {filtered.map((r) => (
              <label key={r.employee_uid}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-[8px] border cursor-pointer text-sm ${
                  assignees.has(r.employee_uid)
                    ? 'border-[#800020] bg-[#F7E9EE]'
                    : 'border-[#E7E5E4] hover:border-[#D6D3D1]'
                }`}>
                <input type="checkbox" checked={assignees.has(r.employee_uid)}
                  onChange={() => toggle(r)} className="accent-[#800020]" />
                <span className="flex-1 min-w-0">
                  <span className="font-medium text-[#0D1C42]">{r.name}</span>
                  {r.is_head && <span className="ml-1 text-[10px] text-[#A56514]">Head</span>}
                  <span className="block text-[11px] text-[#667085]">
                    {orgWide ? `${deptName.get(deptOf.get(r.employee_uid) ?? '') ?? ''} · ` : ''}
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
              <p className="text-[12px] text-[#667085] py-2">No matching employees.</p>
            )}
          </div>
          {assignees.size > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {[...assignees.values()].map((a) => (
                <span key={a.uid}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-[7px] bg-[#F6F4F2] border border-[#E7E5E4] text-[11px] text-[#0D1C42]">
                  {a.name}
                  {orgWide && deptName.get(a.department_uid) && (
                    <span className="text-[#98A2B3]">· {deptName.get(a.department_uid)}</span>
                  )}
                  <button type="button" onClick={() => setAssignees((s) => {
                    const n = new Map(s); n.delete(a.uid); return n;
                  })} className="text-[#98A2B3] hover:text-[#D64545]">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
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
                workDate ? ` · ${workDate}${startTime ? ' ' + startTime : ''}${endTime ? '–' + endTime : ''}` : ''
              } · by ${currentUser?.name ?? 'you'}`
            : 'Fill the form — a summary appears here.'}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {conflicts ? (
            <Button variant="primary" onClick={() => void submit(true)} disabled={busy}>
              {busy ? 'Assigning…' : 'Assign anyway'}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void submit(false)} disabled={busy}>
              {busy ? 'Assigning…' : 'Assign'}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
};
