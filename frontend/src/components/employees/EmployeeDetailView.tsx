import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ArrowLeft, ChevronDown, Mail, Phone, RefreshCw, Search, UserRound } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import {
  DateBounds, EmployeePage, EmployeeProfile, EmployeeRecord, EmployeeRecordKind,
  EmployeeTaskFilter, EmployeeTaskRecord, getEmployeeProfile, getEmployeeRecords, getEmployeeTasks,
} from '../../api/employees';
import { getTask } from '../../api/tasks';
import { TASK_STATUS_LABELS } from '../../api/logs';
import { Task } from '../../types';
import { fmtAuditDateTimeIST, fmtDateLongIST } from '../../lib/datetime';
import { readable } from '../../lib/activityLogs';
import { getInitials } from '../../lib/utils';
import { Button } from '../ui/Button';
import { PeriodSelector, usePeriod } from './analysis/PeriodSelector';
import { OverviewTab } from './analysis/OverviewTab';
import { AttendanceTab } from './analysis/AttendanceTab';
import { MaintenanceTab } from './analysis/MaintenanceTab';
import { DevicesTab } from './analysis/DevicesTab';
import { AllocationTimeline } from './analytics/AllocationTimeline';
import { BlockLoading, TabBtn, card } from './analysis/kit';

const input = 'min-w-0 rounded-md border border-[#E9EDF2] bg-white px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#365D78]/25';
const filters: Record<EmployeeTaskFilter, string> = {
  all: 'All related tasks', allocated: 'Allocated to employee', completed: 'Approved completions',
  abandoned: 'Recorded abandonment while assigned', rejected: 'Submitted work rejected',
  pending_review: 'Pending review', current_open: 'Currently assigned open work',
};
const RECORD_TABS: Record<'tasks' | EmployeeRecordKind, string> = {
  tasks: 'Task history', submissions: 'Submissions & reviews', attendance: 'Attendance',
  leaves: 'Leaves & week-offs', shifts: 'Shift history', allocations: 'Allocation history',
  maintenance: 'Maintenance history',
};
type Tab = 'overview' | 'allocations' | 'maintenance' | 'records' | 'attendance' | 'device';
const TABS: [Tab, string][] = [
  ['overview', 'Overview'], ['allocations', 'Allocations'],
];

const dateTime = (value: string | null | undefined) =>
  value ? `${fmtAuditDateTimeIST(value)} IST` : 'Not recorded';
const dateOnly = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) ? fmtDateLongIST(`${value}T00:00:00+05:30`) : value;

/** "1h 30m 0s" — returns 'Not available' for missing/invalid input. */
export function duration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return 'Not available';
  const n = Math.floor(seconds);
  return `${Math.floor(n / 3600)}h ${Math.floor(n % 3600 / 60)}m ${n % 60}s`;
}

function Failure({ retry }: { retry: () => void }) {
  return <div role="alert" className="p-8 text-center">
    <h2 className="text-sm font-semibold text-[#17212B]">Unable to load employee</h2>
    <p className="my-2 text-xs text-[#697586]">The employee may be unavailable, outside your property access, or the connection may be interrupted.</p>
    <Button size="sm" variant="outline" onClick={retry}>Retry</Button>
  </div>;
}
function Fields({ fields }: { fields: Record<string, React.ReactNode> }) {
  return <dl className="grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2 lg:grid-cols-3">{Object.entries(fields).map(([label, value]) => (
    <div key={label} className="min-w-0">
      <dt className="text-[#697586]">{label}</dt>
      <dd className="mt-1 whitespace-pre-wrap break-words font-medium text-[#17212B]">{value ?? 'Not recorded'}</dd>
    </div>))}
  </dl>;
}
function Pager({ data, page, setPage }: { data: EmployeePage<unknown>; page: number; setPage: (page: number) => void }) {
  return <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[#E9EDF2] p-4 text-xs text-[#697586]">
    <span>{data.total.toLocaleString()} records · Page {page} of {Math.max(1, Math.ceil(data.total / data.limit))}</span>
    <div className="flex gap-2">
      <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
      <Button size="sm" variant="outline" disabled={page * data.limit >= data.total} onClick={() => setPage(page + 1)}>Next</Button>
    </div>
  </footer>;
}

export const EmployeeDetailView: React.FC = () => {
  const { employeeUid, propertyUid } = useParams<{ employeeUid: string; propertyUid: string }>();
  const { navigate } = useApp();
  const [profile, setProfile] = useState<EmployeeProfile | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [tab, setTab] = useState<Tab>('overview');
  const [period, setPeriod] = usePeriod();
  const request = useRef(0);
  useEffect(() => {
    const id = ++request.current;
    setLoading(true); setError(false); setProfile(null);
    if (!employeeUid || !propertyUid) { setError(true); setLoading(false); return; }
    void getEmployeeProfile(employeeUid, propertyUid, period.bounds)
      .then((data) => { if (id === request.current) setProfile(data); })
      .catch(() => { if (id === request.current) setError(true); })
      .finally(() => { if (id === request.current) setLoading(false); });
    return () => { request.current += 1; };
  }, [employeeUid, propertyUid, refresh, period.bounds]);

  const back = <Button variant="ghost" size="sm" onClick={() => navigate(`/property/${propertyUid}/employees`)}>
    <ArrowLeft size={14} /> Back to employees</Button>;
  if (loading) return <section>{back}<BlockLoading label="Loading employee" /></section>;
  if (error || !profile || !employeeUid || !propertyUid)
    return <section>{back}<Failure retry={() => setRefresh((v) => v + 1)} /></section>;

  const { employee, context, tasks, attendance, leave_requests } = profile;
  const active = employee.status === 'Active';
  return <section className="mx-auto w-full max-w-[1440px] min-w-0 space-y-5">
    {/* Compact identity header — identity left, reporting controls right */}
    <header className={`${card} px-5 py-4`}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <button onClick={() => navigate(`/property/${propertyUid}/employees`)}
          className="flex items-center gap-1.5 self-start pt-1 text-xs font-medium text-[#697586] transition-colors hover:text-[#17212B]">
          <ArrowLeft size={14} /> Employees</button>
        <div className="flex items-center gap-3.5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold text-white"
            style={{ backgroundColor: employee.avatar_color || '#365D78' }}>{getInitials(employee.name)}</span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <h1 className="break-words text-[22px] font-semibold leading-tight tracking-[-0.01em] text-[#17212B]">{employee.name}</h1>
              <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: active ? '#169B72' : '#98A2B3' }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: active ? '#169B72' : '#98A2B3' }} />{employee.status}</span>
              {!!employee.leave_status && <span className="text-xs font-medium text-[#D99532]">· On leave</span>}
              {tasks.current_open > 0 && <span className="text-xs text-[#697586]">· {tasks.current_open} open {tasks.current_open === 1 ? 'task' : 'tasks'}</span>}
            </div>
            <p className="mt-0.5 text-[13px] text-[#697586]">
              {employee.job_title || 'Employee'}{employee.department ? ` · ${employee.department}` : ''}
              {employee.shift ? ` · ${employee.shift}` : ''}
            </p>
            <p className="text-xs text-[#98A2B3]">
              {context.property_name}{context.zone_name || context.area_name ? ` · ${context.zone_name || context.area_name}` : ' · Unallocated'}
              <span className="mx-2 text-[#D8DEE6]">|</span>
              <span className="font-mono text-[11px]">ID {employee.employee_uid.slice(0, 8)}</span>
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="hidden flex-col items-end gap-0.5 text-xs text-[#697586] lg:flex">
            {employee.email && <span className="flex items-center gap-1.5"><Mail size={11} className="text-[#98A2B3]" />{employee.email}</span>}
            {employee.phone && <span className="flex items-center gap-1.5"><Phone size={11} className="text-[#98A2B3]" />{employee.phone}</span>}
          </div>
          <span className="hidden h-8 w-px bg-[#E9EDF2] lg:block" />
          <PeriodSelector period={period} onChange={setPeriod} />
          <Button size="sm" variant="ghost" aria-label="Refresh" onClick={() => setRefresh((v) => v + 1)}><RefreshCw size={14} /></Button>
        </div>
      </div>
    </header>

    {/* Tab navigation + reporting-period metadata */}
    <div className="flex flex-wrap items-center justify-between gap-2">
      <nav aria-label="Employee analysis sections"
        className="flex w-fit max-w-full gap-1 rounded-lg bg-[#F1F3F6] p-1">
        {TABS.map(([key, label]) => (
          <TabBtn key={key} active={tab === key} onClick={() => setTab(key)}>{label}</TabBtn>))}
      </nav>
      <p className="text-xs text-[#98A2B3]">
        Reporting period: <span className="font-medium text-[#697586]">{period.label}</span> · IST
      </p>
    </div>

    {tab === 'overview' && <>
      <OverviewTab employeeId={employeeUid} propertyId={propertyUid} period={period} />
      <ProfileDisclosure employee={employee} context={context}
        attendance={attendance} leave_requests={leave_requests} />
    </>}
    {tab === 'allocations' && <AllocationTimeline key={`${employeeUid}:${propertyUid}:${refresh}`}
      employeeId={employeeUid} propertyId={propertyUid} bounds={period.bounds} />}
    {tab === 'maintenance' && <MaintenanceTab employeeId={employeeUid} propertyId={propertyUid} period={period} />}
    {tab === 'records' && <RecordsSection key={`${employeeUid}:${propertyUid}:${refresh}`}
      employeeId={employeeUid} propertyId={propertyUid} bounds={period.bounds} />}
    {tab === 'attendance' && <AttendanceTab employeeId={employeeUid} propertyId={propertyUid} period={period} />}
    {tab === 'device' && <DevicesTab employeeId={employeeUid} propertyId={propertyUid} />}
  </section>;
};

/* ---------------- Compact profile disclosure — non-analytic details ---------------- */

function ProfileDisclosure({ employee, context, attendance, leave_requests }: {
  employee: EmployeeProfile['employee']; context: EmployeeProfile['context'];
  attendance: EmployeeProfile['attendance']; leave_requests: EmployeeProfile['leave_requests'];
}) {
  const [open, setOpen] = useState(false);
  const fields: Record<string, React.ReactNode> = {};
  if (employee.email) fields.Email = employee.email;
  if (employee.phone) fields.Phone = employee.phone;
  if (employee.username) fields.Username = employee.username;
  if (context.zone_name || context.area_name) fields['Current zone / area'] = context.zone_name || context.area_name;
  if (employee.start_date) fields['Employment start'] = dateOnly(employee.start_date);
  if (employee.joined_date) fields['Record created'] = dateOnly(employee.joined_date);
  if (employee.salary?.trim()) fields['Recorded salary'] = employee.salary;
  if (employee.shift) fields['Legacy shift label'] = employee.shift;
  if (employee.leave_balance_days != null) fields['Leave balance'] = `${employee.leave_balance_days} days`;
  if (employee.deactivated_at) fields['Deactivated at'] = dateTime(employee.deactivated_at);
  if (employee.reactivated_at) fields['Reactivated at'] = dateTime(employee.reactivated_at);
  if (leave_requests.pending_requests) fields['Pending leave requests'] = leave_requests.pending_requests;
  if (attendance.recorded_days) fields['Recorded work (closed days)'] = duration(attendance.recorded_work_seconds);
  if (!Object.keys(fields).length) return null;
  return <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    className="rounded-lg border border-[#E9EDF2] bg-white">
    <summary className="flex cursor-pointer items-center gap-2 px-4 py-2.5 text-xs font-medium text-[#697586] hover:text-[#17212B]">
      <UserRound size={13} /> Employee profile details
      <ChevronDown size={13} className={`ml-auto transition ${open ? 'rotate-180' : ''}`} />
    </summary>
    <div className="border-t border-[#E9EDF2] px-4 py-3"><Fields fields={fields} /></div>
  </details>;
}

/* ---------------- Preserved: task history tab ---------------- */

function EmployeeTasks({ employeeId, propertyId, bounds }: {
  employeeId: string; propertyId: string; bounds: DateBounds;
}) {
  const [filter, setFilter] = useState<EmployeeTaskFilter>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1), [retry, setRetry] = useState(0);
  const [data, setData] = useState<EmployeePage<EmployeeTaskRecord> | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const request = useRef(0), previousSearch = useRef('');
  useEffect(() => { setPage(1); }, [filter, bounds.date_from, bounds.date_to]);
  useEffect(() => {
    const id = ++request.current;
    setLoading(true); setError(false); setData(null); setOpen(null);
    const delay = search === previousSearch.current ? 0 : 350;
    previousSearch.current = search;
    const timer = window.setTimeout(() => {
      void getEmployeeTasks(employeeId, propertyId, { filter, search: search.trim() || undefined, page, ...bounds }).then((result) => {
        if (id !== request.current) return;
        const last = Math.max(1, Math.ceil(result.total / result.limit));
        if (page > last) { setPage(last); return; }
        setData(result);
      }).catch(() => { if (id === request.current) setError(true); }).finally(() => { if (id === request.current) setLoading(false); });
    }, delay);
    return () => { window.clearTimeout(timer); request.current += 1; };
  }, [employeeId, propertyId, filter, search, page, retry, bounds.date_from, bounds.date_to]);
  return <section aria-label="Employee task history" className="overflow-hidden rounded-lg border border-[#E9EDF2] bg-white">
    <div className="space-y-3 border-b border-[#E9EDF2] p-4">
      <div className="flex flex-wrap gap-3">
        <label className="relative min-w-48 flex-1">
          <Search size={14} className="absolute left-3 top-2.5 text-[#697586]" />
          <input aria-label="Search employee tasks" placeholder="Search task name, ticket or task ID" maxLength={200}
            value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className={`${input} w-full pl-9`} />
        </label>
        <select aria-label="Employee task outcome" value={filter}
          onChange={(e) => { setPage(1); setFilter(e.target.value as EmployeeTaskFilter); }} className={input}>
          {Object.entries(filters).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </div>
      <p className="text-xs leading-relaxed text-[#697586]">Current task status is separate from this employee's submission/review. Elapsed start → submission is shown only with a recorded allocation to this employee and no intervening reassignment; it includes pauses and is not measured active working time. Task counts exclude maintenance tickets; allocation history includes both.</p>
    </div>
    {loading ? <BlockLoading /> : error ? <Failure retry={() => setRetry((v) => v + 1)} />
      : !data?.items.length ? <div className="p-8 text-center text-sm text-[#697586]">No matching task records.
        <Button size="sm" variant="ghost" onClick={() => { setSearch(''); setFilter('all'); }}>Clear filters</Button></div>
      : <ul className="divide-y divide-[#E9EDF2]">{data.items.map((task) => <li key={task.task_uid} className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><h3 className="text-sm font-semibold text-[#17212B]">{task.title}</h3>
            <p className="mt-1 text-xs text-[#697586]">{task.ticket_number || 'No ticket number'} · {task.property_name}</p></div>
          <span className="rounded border border-[#E9EDF2] bg-[#F7F8FA] px-2 py-1 text-xs">Current: {TASK_STATUS_LABELS[task.current_status] || readable(task.current_status)}</span>
        </div>
        <div className="my-4"><Fields fields={{
          'Current assignee': task.current_assignee || 'Unassigned',
          'This employee’s latest matching review': task.review_status === 'disapproved' ? 'Rejected' : task.review_status ? readable(task.review_status) : 'No attributed submission',
          'Submission attempt': task.attempt_number ?? 'Not recorded',
          'Task created': dateTime(task.created_at),
          'Recorded final completion': dateTime(task.completed_at),
          ...(task.abandoned_at ? { 'Recorded abandonment': dateTime(task.abandoned_at) } : {}),
          'Recorded task start': dateTime(task.recorded_start_at),
          'Employee submission': dateTime(task.submitted_at),
          'Start → submission elapsed': duration(task.start_to_submission_seconds),
          'Reviewed by': task.reviewed_by || 'Not recorded',
          'Review timestamp': dateTime(task.reviewed_at),
          ...(task.review_comment ? { 'Review comment': task.review_comment } : {}),
          ...(task.abandoned_reason ? { 'Recorded abandonment reason': readable(task.abandoned_reason) } : {}),
        }} /></div>
        <Button size="sm" variant="ghost" aria-expanded={open === task.task_uid} aria-controls={`history-${task.task_uid}`}
          onClick={() => setOpen(open === task.task_uid ? null : task.task_uid)}>
          {open === task.task_uid ? 'Hide task history' : 'View full task history'}<ChevronDown size={13} />
        </Button>
        {open === task.task_uid && <div id={`history-${task.task_uid}`}><TaskHistory taskId={task.task_uid} /></div>}
      </li>)}</ul>}
    {!loading && !error && data && <Pager data={data} page={page} setPage={setPage} />}
  </section>;
}

function TaskHistory({ taskId }: { taskId: string }) {
  const [data, setData] = useState<Task | null>(null), [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setData(null); setError(false);
    void getTask(taskId).then((task) => { if (active) setData(task); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [taskId, retry]);
  if (error) return <Failure retry={() => setRetry((v) => v + 1)} />;
  if (!data) return <BlockLoading />;
  return <div className="mt-3 rounded-lg border border-[#E9EDF2] bg-[#F7F8FA] p-4">
    <h4 className="text-xs font-semibold text-[#17212B]">Available task history · all actors · oldest first</h4>
    <p className="mt-1 text-[11px] text-[#697586]">This is the task's full available history, not a claim that this employee performed every action.</p>
    {!data.history?.length ? <p className="mt-4 text-xs text-[#697586]">No task-history events recorded.</p>
      : <ol className="mt-4">{[...data.history].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.event_uid.localeCompare(b.event_uid)).map((event) => (
        <li key={event.event_uid} className="relative ml-1 border-l border-[#E9EDF2] pb-4 pl-4">
          <span className="absolute -left-1 top-1 h-2 w-2 rounded-full bg-[#365D78]" />
          <div className="flex flex-wrap justify-between gap-2 text-xs">
            <span className="font-medium text-[#17212B]">{readable(event.type)}</span>
            <time dateTime={event.at} className="text-[#697586]">{dateTime(event.at)}</time>
          </div>
          <p className="mt-1 text-xs text-[#697586]">{event.actor_name || 'Actor not recorded'}</p>
          {event.note && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-[#697586]">{event.note}</p>}
          {!!event.photos?.length && <p className="mt-1 text-[11px] text-[#697586]">{event.photos.length} evidence attachment reference(s) recorded</p>}
        </li>))}
      </ol>}
  </div>;
}

/* ---------------- Preserved: raw record sections ---------------- */

const recordLabels: Record<string, string> = {
  attendance_date: 'Attendance date', work_seconds: 'Recorded work', break_seconds: 'Recorded break',
  employee_name: 'Assigned to', previous_employee_name: 'Previously assigned to', created_at: 'Recorded at',
  reviewed_at: 'Reviewed at', reviewed_by_name: 'Reviewed by', created_by_name: 'Assigned by',
  start_time: 'Shift starts (IST)', end_time: 'Shift ends (IST)', effective_from: 'Effective from',
  effective_until: 'Effective through', working_days: 'Working days (Monday first)',
  grace_minutes: 'Arrival grace (minutes)', early_exit_minutes: 'Early-exit tolerance (minutes)',
  issue: 'Issue', maintenance_type: 'Maintenance type', assigned_to_name: 'Currently assigned to',
  resolved_at: 'Resolved at', closed_at: 'Closed at', ticket_number: 'Ticket',
};
function recordValue(key: string, value: unknown): React.ReactNode {
  if (value == null || value === '') return 'Not recorded';
  if (key.endsWith('_seconds')) return duration(Number(value));
  if (key.endsWith('_at')) return dateTime(String(value));
  if (['attendance_date', 'from_date', 'to_date', 'effective_from', 'effective_until'].includes(key)) return dateOnly(String(value));
  if (key === 'working_days') return String(value).split('').map((v, i) => v === '1' ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i] : null).filter(Boolean).join(', ') || 'None recorded';
  if (['status', 'leave_type', 'request_type', 'allocation_method', 'ticket_kind'].includes(key)) return readable(String(value));
  return String(value);
}

function RecordsSection({ employeeId, propertyId, bounds }: {
  employeeId: string; propertyId: string; bounds: DateBounds;
}) {
  const [kind, setKind] = useState<keyof typeof RECORD_TABS>('tasks');
  return <div className="space-y-3">
    <nav aria-label="Record type" className="flex w-fit max-w-full flex-wrap gap-1 rounded-lg border border-[#E9EDF2] bg-[#F7F8FA] p-1">
      {Object.entries(RECORD_TABS).map(([key, label]) => (
        <TabBtn key={key} active={kind === key} onClick={() => setKind(key as keyof typeof RECORD_TABS)}>{label}</TabBtn>))}
    </nav>
    {kind === 'tasks'
      ? <EmployeeTasks employeeId={employeeId} propertyId={propertyId} bounds={bounds} />
      : <EmployeeRecords key={kind} employeeId={employeeId} propertyId={propertyId} kind={kind} bounds={bounds} />}
  </div>;
}

function EmployeeRecords({ employeeId, propertyId, kind, bounds }: {
  employeeId: string; propertyId: string; kind: EmployeeRecordKind; bounds: DateBounds;
}) {
  const [page, setPage] = useState(1), [retry, setRetry] = useState(0);
  const [data, setData] = useState<EmployeePage<EmployeeRecord> | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  useEffect(() => { setPage(1); }, [bounds.date_from, bounds.date_to]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(false); setData(null);
    void getEmployeeRecords(employeeId, propertyId, kind, page, bounds).then((result) => {
      if (!active) return;
      const last = Math.max(1, Math.ceil(result.total / result.limit));
      if (page > last) { setPage(last); return; }
      setData(result);
    }).catch(() => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [employeeId, propertyId, kind, page, retry, bounds.date_from, bounds.date_to]);
  return <section aria-label={RECORD_TABS[kind]} className="overflow-hidden rounded-lg border border-[#E9EDF2] bg-white">
    <h2 className="border-b border-[#E9EDF2] p-4 text-sm font-semibold text-[#17212B]">{RECORD_TABS[kind]}
      <span className="ml-2 text-xs font-normal text-[#697586]">Recorded history · newest first</span></h2>
    {loading ? <BlockLoading /> : error ? <Failure retry={() => setRetry((v) => v + 1)} />
      : !data?.items.length ? <p className="p-8 text-center text-sm text-[#697586]">No {RECORD_TABS[kind].toLowerCase()} records available.</p>
      : <ul className="divide-y divide-[#E9EDF2]">{data.items.map((record) => (
        <li key={record.record_uid} className="p-4">
          <Fields fields={Object.fromEntries(Object.entries(record)
            .filter(([key]) => !['record_uid', 'lifecycle', 'work_uid'].includes(key))
            .map(([key, value]) => [recordLabels[key] || readable(key), recordValue(key, value)]))} />
        </li>))}
      </ul>}
    {!loading && !error && data && <Pager data={data} page={page} setPage={setPage} />}
  </section>;
}
