import React, { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Crown, Users, ArrowLeftRight, Pencil } from 'lucide-react';
import {
  DepartmentDetail,
  DepartmentTransferRecord,
  departmentDetail,
  departmentTransfers,
  listDepartments,
  Department,
} from '../../../api/departments';
import { departmentWorkApi, type DeptRoster } from '../../../api/departmentWork';
import { useApp } from '../../../context/AppContext';
import { BackButton } from '../../ui/BackButton';
import { Button } from '../../ui/Button';
import { DepartmentFormModal } from './DepartmentFormModal';
import { TransferModal } from './TransferModal';
import {
  DeptEmployeesTab,
  DeptWorkTab,
  DeptCalendarTab,
  DeptPerformanceTab,
} from './DepartmentWorkTabs';

type DeptTab = 'overview' | 'employees' | 'work' | 'calendar' | 'performance';
const DEPT_TABS: { id: DeptTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'employees', label: 'Employees' },
  { id: 'work', label: 'Work Allocation' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'performance', label: 'Performance' },
];

export const DepartmentDetailView: React.FC = () => {
  const { propertyUid, departmentUid } = useParams<{
    propertyUid: string;
    departmentUid: string;
  }>();
  const { currentPropertyEmployees } = useApp();
  const [dept, setDept] = useState<DepartmentDetail | null>(null);
  const [allDepts, setAllDepts] = useState<Department[]>([]);
  const [history, setHistory] = useState<DepartmentTransferRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [tab, setTab] = useState<DeptTab>('overview');
  const [roster, setRoster] = useState<DeptRoster | null>(null);

  const loadRoster = () => {
    if (!departmentUid) return;
    departmentWorkApi
      .roster(departmentUid)
      .then(setRoster)
      .catch(() => setRoster(null));
  };
  useEffect(loadRoster, [departmentUid]);

  const load = async () => {
    if (!propertyUid || !departmentUid) return;
    setLoading(true);
    try {
      const [d, all, h] = await Promise.all([
        departmentDetail(departmentUid),
        listDepartments({ property_uid: propertyUid, include_inactive: true }),
        departmentTransfers({ property_uid: propertyUid, limit: 50 }),
      ]);
      setDept(d);
      setAllDepts(all);
      setHistory(
        h.filter(
          (t) =>
            t.from_department_uid === departmentUid ||
            t.to_department_uid === departmentUid
        )
      );
      setError(null);
    } catch (e) {
      setError((e as { message?: string })?.message || 'Failed to load department.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyUid, departmentUid]);

  const headOf = useMemo(() => {
    const m: Record<string, string> = {};
    allDepts.forEach((d) => {
      if (d.head) m[d.head.employee_uid] = d.name;
    });
    return m;
  }, [allDepts]);

  const staffOptions = currentPropertyEmployees
    .filter((e) => !(e as { deactivated_at?: string | null }).deactivated_at)
    .map((e) => ({ employee_uid: e.employee_uid, name: e.name }));

  if (loading)
    return <div className="font-body text-sm text-[#800020]">Loading…</div>;
  if (error || !dept)
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 font-body">
        {error || 'Department not found.'}
      </div>
    );

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <div className="mb-2">
            <BackButton to={`/property/${propertyUid}/workforce/departments`} />
          </div>
          <h1 className="font-display font-semibold text-[28px] text-[#0D1C42] tracking-tight leading-tight">
            {dept.name}
            {dept.code && (
              <span className="ml-2 font-body text-sm text-[#667085] font-normal">
                {dept.code}
              </span>
            )}
          </h1>
          <p className="font-body text-sm text-[#800020] mt-1">
            {dept.description || 'Department roster, head and activity'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setEditOpen(true)}>
            <Pencil className="w-4 h-4 mr-1.5" /> Edit
          </Button>
          <Button onClick={() => setTransferOpen(true)}>
            <ArrowLeftRight className="w-4 h-4 mr-1.5" /> Manage employees
          </Button>
        </div>
      </div>

      {/* Work Management tabs */}
      <div className="flex items-center gap-1 border-b border-[#E7E5E4] -mb-1 overflow-x-auto">
        {DEPT_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3.5 py-2 text-[13px] font-body font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
              tab === t.id
                ? 'border-[#800020] text-[#800020]'
                : 'border-transparent text-[#667085] hover:text-[#0D1C42]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'employees' && <DeptEmployeesTab roster={roster} />}
      {tab === 'work' && (
        <DeptWorkTab
          departmentUid={departmentUid!}
          roster={roster}
          onChanged={loadRoster}
        />
      )}
      {tab === 'calendar' && <DeptCalendarTab departmentUid={departmentUid!} />}
      {tab === 'performance' && (
        <DeptPerformanceTab departmentUid={departmentUid!} />
      )}

      {tab === 'overview' && (<>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-[#E7E5E4] bg-white/60 px-4 py-3">
          <div className="font-display text-xl font-bold text-[#0D1C42] tabular-nums">
            {dept.employee_count}
          </div>
          <div className="font-body text-xs text-[#800020] mt-1.5">Total staff</div>
        </div>
        <div className="rounded-xl border border-[#E7E5E4] bg-white/60 px-4 py-3">
          <div className="font-display text-xl font-bold text-[#0D1C42] tabular-nums">
            {dept.active_employee_count}
          </div>
          <div className="font-body text-xs text-[#800020] mt-1.5">Active</div>
        </div>
        <div className="rounded-xl border border-[#E7E5E4] bg-white/60 px-4 py-3">
          <div className="font-display text-xl font-bold text-[#0D1C42] tabular-nums">
            {dept.employee_count - dept.active_employee_count}
          </div>
          <div className="font-body text-xs text-[#800020] mt-1.5">Inactive</div>
        </div>
        <div className="rounded-xl border border-[#E7E5E4] bg-white/60 px-4 py-3">
          <div className="font-body text-sm text-[#0D1C42] flex items-center gap-1.5 mt-0.5">
            {dept.head ? (
              <>
                <Crown className="w-4 h-4 text-[#A56514]" /> {dept.head.name}
              </>
            ) : (
              <span className="text-[#667085]">No head</span>
            )}
          </div>
          <div className="font-body text-xs text-[#800020] mt-1.5">
            Department head
          </div>
        </div>
      </div>

      {/* Roster */}
      <div className="space-y-2">
        <h2 className="font-display font-semibold text-lg text-[#0D1C42] flex items-center gap-2">
          <Users className="w-4 h-4" /> Roster
        </h2>
        {dept.employees.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#D6D3D1] bg-white/40 px-6 py-8 text-center font-body text-sm text-[#800020]">
            No employees in this department. Use “Manage employees” to add staff.
          </div>
        ) : (
          <div className="rounded-xl border border-[#E7E5E4] bg-white/60 overflow-hidden">
            <table className="w-full text-sm font-body">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-[#667085] border-b border-[#E7E5E4]">
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Job title</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium text-right">Role</th>
                </tr>
              </thead>
              <tbody>
                {dept.employees.map((e) => (
                  <tr
                    key={e.employee_uid}
                    className="border-b border-[#F6F4F2] last:border-0 hover:bg-[#FFFCFA]"
                  >
                    <td className="px-4 py-2.5">
                      <Link
                        to={`/property/${propertyUid}/workforce/employees/${e.employee_uid}`}
                        className="font-medium text-[#0D1C42] hover:underline"
                      >
                        {e.name}
                      </Link>
                      <div className="text-[11px] text-[#667085]">{e.email}</div>
                    </td>
                    <td className="px-4 py-2.5 text-[#800020]">
                      {e.job_title || '—'}
                    </td>
                    <td className="px-4 py-2.5 text-[#800020]">{e.status}</td>
                    <td className="px-4 py-2.5 text-right">
                      {e.is_head && (
                        <span className="inline-flex items-center gap-1 text-xs text-[#A56514]">
                          <Crown className="w-3.5 h-3.5" /> Head
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Transfer history */}
      <div className="space-y-2">
        <h2 className="font-display font-semibold text-lg text-[#0D1C42]">
          Recent transfers
        </h2>
        {history.length === 0 ? (
          <div className="font-body text-sm text-[#667085]">
            No transfers recorded for this department yet.
          </div>
        ) : (
          <div className="rounded-xl border border-[#E7E5E4] bg-white/60 divide-y divide-[#F6F4F2]">
            {history.map((t) => (
              <div
                key={t.transfer_uid}
                className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-body"
              >
                <span className="font-medium text-[#0D1C42]">
                  {t.employee_name || 'Employee'}
                </span>
                <span className="text-[#800020]">
                  {t.from_department_name || 'Unassigned'} →{' '}
                  {t.to_department_name || 'Unassigned'}
                </span>
                {t.reason && (
                  <span className="text-[#667085] text-xs">“{t.reason}”</span>
                )}
                <span className="ml-auto text-[11px] text-[#667085]">
                  {t.changed_by_name || 'System'} ·{' '}
                  {t.created_at
                    ? new Date(t.created_at).toLocaleString()
                    : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      </>)}

      <DepartmentFormModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        propertyUid={propertyUid!}
        department={dept}
        onSaved={() => void load()}
      />

      <TransferModal
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        propertyUid={propertyUid!}
        employees={dept.employees.map((e) => ({
          employee_uid: e.employee_uid,
          name: e.name,
          department_uid: dept.department_uid,
          department: dept.name,
        }))}
        departments={allDepts}
        headOf={headOf}
        staffOptions={staffOptions}
        onDone={() => void load()}
      />
    </div>
  );
};
