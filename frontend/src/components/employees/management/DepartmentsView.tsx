import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, Search, Crown, ArrowLeftRight } from 'lucide-react';
import {
  Department,
  listDepartments,
  deleteDepartment,
} from '../../../api/departments';
import { useApp } from '../../../context/AppContext';
import { BackButton } from '../../ui/BackButton';
import { Button } from '../../ui/Button';
import { ConfirmationDialog } from '../../ui/ConfirmationDialog';
import { DepartmentFormModal } from './DepartmentFormModal';
import { TransferModal } from './TransferModal';

export const DepartmentsView: React.FC = () => {
  const { propertyUid } = useParams<{ propertyUid: string }>();
  const navigate = useNavigate();
  const { currentPropertyEmployees } = useApp();
  const [depts, setDepts] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [sortBy, setSortBy] = useState<'name' | 'employees'>('name');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Department | null>(null);
  const [deleting, setDeleting] = useState<Department | null>(null);
  const [transferDept, setTransferDept] = useState<Department | null>(null);

  const load = async () => {
    if (!propertyUid) return;
    setLoading(true);
    try {
      setDepts(
        await listDepartments({ property_uid: propertyUid, include_inactive: true })
      );
      setError(null);
    } catch (e) {
      setError((e as { message?: string })?.message || 'Failed to load.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyUid]);

  const headOf = useMemo(() => {
    const m: Record<string, string> = {};
    depts.forEach((d) => {
      if (d.head) m[d.head.employee_uid] = d.name;
    });
    return m;
  }, [depts]);

  const rows = useMemo(() => {
    let r = depts;
    if (!showInactive) r = r.filter((d) => d.status === 'active');
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      r = r.filter(
        (d) =>
          d.name.toLowerCase().includes(q) ||
          (d.code || '').toLowerCase().includes(q) ||
          (d.head?.name || '').toLowerCase().includes(q)
      );
    }
    return [...r].sort((a, b) =>
      sortBy === 'name'
        ? a.name.localeCompare(b.name)
        : b.employee_count - a.employee_count
    );
  }, [depts, search, showInactive, sortBy]);

  const transferEmployees = transferDept
    ? currentPropertyEmployees
        .filter((e) => (e as { department_uid?: string }).department_uid === transferDept.department_uid)
        .map((e) => ({
          employee_uid: e.employee_uid,
          name: e.name,
          department_uid: (e as { department_uid?: string }).department_uid,
          department: (e as { department?: string }).department,
        }))
    : [];

  const staffOptions = currentPropertyEmployees
    .filter((e) => !(e as { deactivated_at?: string | null }).deactivated_at)
    .map((e) => ({ employee_uid: e.employee_uid, name: e.name }));

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <div className="mb-2">
            <BackButton to={`/property/${propertyUid}/overview`} />
          </div>
          <h1 className="font-display font-semibold text-[28px] text-[#0D1C42] tracking-tight leading-tight">
            Departments
          </h1>
          <p className="font-body text-sm text-[#800020] mt-1">
            Organisational groupings, heads and staff transfers
          </p>
        </div>
        <Button onClick={() => { setEditing(null); setFormOpen(true); }}>
          <Plus className="w-4 h-4 mr-1.5" /> New department
        </Button>
      </div>


      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#667085]" />
          <input
            className="w-full rounded-lg border border-[#D6D3D1] bg-white pl-9 pr-3 py-2 text-sm font-body text-[#0D1C42] focus:outline-none focus:border-[#800020]"
            placeholder="Search departments or heads…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-1.5 font-body text-sm text-[#800020]">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show inactive
        </label>
        <select
          className="rounded-lg border border-[#D6D3D1] bg-white px-2.5 py-1.5 text-sm font-body text-[#0D1C42]"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as 'name' | 'employees')}
        >
          <option value="name">Sort: name</option>
          <option value="employees">Sort: staff count</option>
        </select>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 font-body">
          {error}
        </div>
      )}

      {loading ? (
        <div className="font-body text-sm text-[#800020]">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[#D6D3D1] bg-white/40 px-6 py-10 text-center font-body text-sm text-[#800020]">
          {depts.length === 0
            ? 'No departments yet — create the first one.'
            : 'No departments match your filters.'}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((d) => (
            <div
              key={d.department_uid}
              role="link"
              tabIndex={0}
              onClick={() => navigate(`/property/${propertyUid}/workforce/departments/${d.department_uid}`)}
              onKeyDown={(e) => {
                if (e.key === 'Enter')
                  navigate(`/property/${propertyUid}/workforce/departments/${d.department_uid}`);
              }}
              className="rounded-xl border border-[#E7E5E4] bg-white p-4 flex flex-col gap-3 cursor-pointer transition-shadow hover:shadow-[0_2px_8px_rgba(13,28,66,0.06)] hover:border-[#EAD3DB]"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-display font-semibold text-[15px] text-[#0D1C42] leading-tight">
                    {d.name}
                  </p>
                  <div className="flex items-center gap-1.5 mt-1">
                    {d.is_system && (
                      <span className="text-[10px] font-body uppercase tracking-wide bg-[#F7E9EE] text-[#800020] px-1.5 py-0.5 rounded">
                        Default
                      </span>
                    )}
                    {d.code && (
                      <span className="text-[11px] text-[#667085] font-num">{d.code}</span>
                    )}
                  </div>
                </div>
                <span
                  className={`shrink-0 text-[10.5px] uppercase tracking-wide px-1.5 py-0.5 rounded font-semibold ${
                    d.status === 'active'
                      ? 'bg-[#E6F4EE] text-[#0F6847]'
                      : 'bg-[#EFF1F4] text-[#5F6776]'
                  }`}
                >
                  {d.status}
                </span>
              </div>

              <div className="flex items-center justify-between text-sm">
                <span className="inline-flex items-center gap-1.5 text-[#667085]">
                  {d.head ? (
                    <>
                      <Crown className="w-3.5 h-3.5 text-[#A56514]" />
                      <span className="text-[#0D1C42]">{d.head.name}</span>
                    </>
                  ) : (
                    <span className="text-[#98A2B3]">No head assigned</span>
                  )}
                </span>
                <span className="font-num tabular-nums text-[#0D1C42] font-semibold">
                  {d.employee_count}
                  <span className="text-[#667085] text-xs font-normal">
                    {' '}({d.active_employee_count} active)
                  </span>
                </span>
              </div>

              <div className="flex items-center gap-3 border-t border-[#F6F4F2] pt-3">
                <button
                  className="text-[#800020] hover:underline text-xs font-semibold"
                  onClick={(e) => { e.stopPropagation(); setTransferDept(d); }}
                  title="Move staff in/out of this department"
                >
                  <ArrowLeftRight className="w-3.5 h-3.5 inline -mt-0.5 mr-0.5" />
                  Transfer
                </button>
                <button
                  className="text-[#800020] hover:underline text-xs font-semibold"
                  onClick={(e) => { e.stopPropagation(); setEditing(d); setFormOpen(true); }}
                >
                  Edit
                </button>
                {!d.is_system && (
                  <button
                    className="ml-auto text-[#D64545] hover:underline text-xs font-semibold disabled:opacity-40 disabled:no-underline"
                    disabled={d.employee_count > 0}
                    title={
                      d.employee_count > 0
                        ? 'Transfer all employees out before deleting'
                        : 'Delete department'
                    }
                    onClick={(e) => { e.stopPropagation(); setDeleting(d); }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <DepartmentFormModal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        propertyUid={propertyUid!}
        department={editing}
        onSaved={() => void load()}
      />

      <ConfirmationDialog
        isOpen={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          await deleteDepartment(deleting.department_uid);
          setDeleting(null);
          void load();
        }}
        title={`Delete ${deleting?.name}?`}
        entityType="Department"
        entityName={deleting?.name ?? ''}
        impactMessage="The department will be permanently removed. Employee records, task history and allocations are preserved."
        confirmLabel="Delete department"
        confirmVariant="destructive"
      />

      <TransferModal
        open={!!transferDept}
        onClose={() => setTransferDept(null)}
        propertyUid={propertyUid!}
        employees={transferEmployees}
        departments={depts}
        headOf={headOf}
        staffOptions={staffOptions}
        onDone={() => void load()}
      />
    </div>
  );
};
