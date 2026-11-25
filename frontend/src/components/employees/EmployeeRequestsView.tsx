import React, { useCallback, useEffect, useState } from 'react';
import {
  Building2,
  CheckCircle2,
  Inbox,
  RefreshCw,
  Search,
  UserCheck,
  UserX,
  XCircle,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import {
  approveEmployeeRequest,
  EmployeeRequest,
  getEmployeeRequest,
  listEmployeeRequests,
  RegistrationStatus,
  rejectEmployeeRequest,
} from '../../api/employeeRequests';
import { listZones } from '../../api/zones';
import { Zone } from '../../types';

const STATUS_FILTERS: Array<{ key: RegistrationStatus | 'all'; label: string }> = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'all', label: 'All' },
];

const STATUS_STYLE: Record<RegistrationStatus, string> = {
  pending: 'bg-[#FDF3E2] text-[#A56514]',
  approved: 'bg-[#EDF7EE] text-[#386641]',
  rejected: 'bg-[#FAEBEB] text-[#A83434]',
};

const fmt = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString() : '—';

const DetailRow: React.FC<{ label: string; value?: string | null }> = ({
  label,
  value,
}) => (
  <div>
    <p className="text-micro font-semibold uppercase tracking-[0.08em] text-ink-3">
      {label}
    </p>
    <p className="font-body text-sm text-[#0D1C42] mt-0.5 break-words">
      {value || '—'}
    </p>
  </div>
);

export const EmployeeRequestsView: React.FC<{
  onCountChange?: (pending: number) => void;
}> = ({ onCountChange }) => {
  const { properties, activeProperty } = useApp();
  const [statusFilter, setStatusFilter] =
    useState<RegistrationStatus | 'all'>('pending');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<EmployeeRequest[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<EmployeeRequest | null>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [approvePropertyUid, setApprovePropertyUid] = useState('');
  const [approveZoneUid, setApproveZoneUid] = useState('');
  const [zones, setZones] = useState<Zone[]>([]);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listEmployeeRequests({
        status: statusFilter === 'all' ? undefined : statusFilter,
        search: search || undefined,
        limit: 100,
      });
      setItems(res.items);
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load requests.');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search]);

  useEffect(() => {
    void load();
  }, [load]);

  // Bubble the pending count up so the parent tab badge stays fresh.
  useEffect(() => {
    if (!onCountChange) return;
    let cancelled = false;
    void listEmployeeRequests({ status: 'pending', limit: 1 })
      .then((r) => !cancelled && onCountChange(r.total))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [items, onCountChange]);

  const openDetail = async (req: EmployeeRequest) => {
    setSelected(req);
    try {
      setSelected(await getEmployeeRequest(req.request_uid));
    } catch {
      /* detail fetch is best-effort — list row already has everything */
    }
  };

  const openApprove = () => {
    setApprovePropertyUid(activeProperty?.property_uid ?? '');
    setApproveZoneUid('');
    setActionError(null);
    setApproveOpen(true);
  };

  useEffect(() => {
    if (!approveOpen || !approvePropertyUid) {
      setZones([]);
      return;
    }
    let cancelled = false;
    void listZones(approvePropertyUid)
      .then((r) => !cancelled && setZones(r.items))
      .catch(() => !cancelled && setZones([]));
    return () => {
      cancelled = true;
    };
  }, [approveOpen, approvePropertyUid]);

  const doApprove = async () => {
    if (!selected || !approvePropertyUid) return;
    setActing(true);
    setActionError(null);
    try {
      await approveEmployeeRequest(selected.request_uid, {
        property_uid: approvePropertyUid,
        zone_uid: approveZoneUid || null,
      });
      setApproveOpen(false);
      setSelected(null);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Approval failed.');
    } finally {
      setActing(false);
    }
  };

  const doReject = async () => {
    if (!selected) return;
    setActing(true);
    setActionError(null);
    try {
      await rejectEmployeeRequest(
        selected.request_uid,
        rejectReason.trim() || null,
      );
      setRejectOpen(false);
      setRejectReason('');
      setSelected(null);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Rejection failed.');
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Toolbar — status filter + search + refresh */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="inline-flex p-1 rounded-[10px] bg-[#F6F4F2] w-fit">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              className={`px-3.5 py-1.5 rounded-[8px] text-xs font-semibold transition-all duration-150 cursor-pointer ${
                statusFilter === f.key
                  ? 'bg-white text-[#0D1C42] shadow-[0_1px_2px_rgba(20,30,24,0.10)]'
                  : 'text-[#800020] hover:text-[#0D1C42]'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, username or email"
              className="pl-8 pr-3 py-2 rounded-[10px] border border-line bg-white text-[13px] text-[#0D1C42] w-64 focus:outline-none focus:ring-2 focus:ring-[#800020]/20"
            />
          </div>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="py-16 text-center text-sm text-ink-3">
          Loading registration requests…
        </div>
      ) : error ? (
        <div className="py-16 text-center">
          <p className="text-sm text-[#A83434]">{error}</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => void load()}
          >
            Retry
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className="py-16 flex flex-col items-center gap-2 text-center">
          <Inbox className="w-8 h-8 text-ink-3" />
          <p className="font-display text-base font-semibold text-[#0D1C42]">
            No {statusFilter === 'all' ? '' : statusFilter} requests
          </p>
          <p className="text-xs text-ink-3 max-w-sm">
            Employee registration requests submitted through the mobile app
            appear here for review.
          </p>
        </div>
      ) : (
        <div className="rounded-[14px] border border-line overflow-hidden">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-[#F6F4F2] text-micro font-semibold uppercase tracking-[0.08em] text-ink-3">
                <th className="px-4 py-2.5">Employee</th>
                <th className="px-4 py-2.5 hidden md:table-cell">Contact</th>
                <th className="px-4 py-2.5 hidden lg:table-cell">Requested Role</th>
                <th className="px-4 py-2.5 hidden lg:table-cell">Submitted</th>
                <th className="px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((r) => (
                <tr
                  key={r.request_uid}
                  onClick={() => void openDetail(r)}
                  className="cursor-pointer hover:bg-[#FFFCFA] transition-colors"
                >
                  <td className="px-4 py-3">
                    <p className="font-body text-sm font-semibold text-[#0D1C42]">
                      {r.full_name}
                    </p>
                    <p className="text-xs text-ink-3">@{r.username}</p>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <p className="text-[13px] text-[#0D1C42]">{r.email}</p>
                    <p className="text-xs text-ink-3">{r.phone || '—'}</p>
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell">
                    <p className="text-[13px] text-[#0D1C42]">
                      {r.designation || '—'}
                    </p>
                    <p className="text-xs text-ink-3">
                      {r.department || '—'}
                      {r.employment_type ? ` · ${r.employment_type}` : ''}
                    </p>
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell">
                    <p className="text-xs text-ink-3">{fmt(r.created_at)}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded-[6px] ${STATUS_STYLE[r.status]}`}
                    >
                      {r.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {total > items.length && (
            <p className="px-4 py-2 text-xs text-ink-3 border-t border-line">
              Showing {items.length} of {total}
            </p>
          )}
        </div>
      )}

      {/* Detail + decision modal */}
      <Modal
        isOpen={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.full_name ?? 'Request'}
        description={
          selected ? `@${selected.username} · submitted ${fmt(selected.created_at)}` : ''
        }
        maxWidth="lg"
        footer={
          selected?.status === 'pending' ? (
            <div className="flex items-center justify-end gap-2.5 pt-4 border-t border-line">
              <Button
                variant="destructive"
                onClick={() => {
                  setRejectReason('');
                  setActionError(null);
                  setRejectOpen(true);
                }}
              >
                <UserX className="w-4 h-4" />
                Reject Request
              </Button>
              <Button variant="primary" onClick={openApprove}>
                <UserCheck className="w-4 h-4" />
                Accept Request
              </Button>
            </div>
          ) : undefined
        }
      >
        {selected && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3.5">
              <DetailRow label="Email" value={selected.email} />
              <DetailRow label="Mobile" value={selected.phone} />
              <DetailRow label="Date of Birth" value={selected.date_of_birth} />
              <DetailRow label="Gender" value={selected.gender} />
              <DetailRow label="Designation" value={selected.designation} />
              <DetailRow label="Department" value={selected.department} />
              <DetailRow
                label="Employment Type"
                value={selected.employment_type}
              />
              <DetailRow label="Joining Date" value={selected.joining_date} />
              <DetailRow
                label="Reporting Manager"
                value={selected.reporting_manager}
              />
              <DetailRow label="Salary / CTC" value={selected.salary} />
              <DetailRow
                label="Salary Frequency"
                value={selected.salary_frequency}
              />
              <DetailRow
                label="Status"
                value={selected.status.toUpperCase()}
              />
            </div>
            {selected.status !== 'pending' && (
              <div className="rounded-[10px] bg-[#F6F4F2] p-3.5 text-[13px] text-[#0D1C42]">
                <p>
                  {selected.status === 'approved' ? 'Approved' : 'Rejected'}
                  {selected.reviewed_by_name
                    ? ` by ${selected.reviewed_by_name}`
                    : ''}
                  {selected.reviewed_at ? ` on ${fmt(selected.reviewed_at)}` : ''}
                </p>
                {selected.rejection_reason && (
                  <p className="mt-1 text-[#A83434]">
                    Reason: {selected.rejection_reason}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Approve — pick the property the employee lands in */}
      <Modal
        isOpen={approveOpen}
        onClose={() => setApproveOpen(false)}
        title="Accept registration request"
        description={
          selected
            ? `${selected.full_name} will be created as an employee and can sign in immediately.`
            : ''
        }
        footer={
          <div className="flex items-center justify-end gap-2.5 pt-4 border-t border-line">
            <Button variant="secondary" onClick={() => setApproveOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              isLoading={acting}
              disabled={!approvePropertyUid}
              onClick={() => void doApprove()}
            >
              <CheckCircle2 className="w-4 h-4" />
              Approve &amp; Create Employee
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-micro font-semibold uppercase tracking-[0.08em] text-ink-3 mb-1.5">
              Assign to property <span className="text-[#A83434]">*</span>
            </label>
            <div className="relative">
              <Building2 className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
              <select
                value={approvePropertyUid}
                onChange={(e) => {
                  setApprovePropertyUid(e.target.value);
                  setApproveZoneUid('');
                }}
                className="w-full pl-9 pr-3 py-2.5 rounded-[10px] border border-line bg-white text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]/20"
              >
                <option value="">Select a property…</option>
                {properties.map((p) => (
                  <option key={p.property_uid} value={p.property_uid}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-[11px] text-ink-3 mt-1">
              Registration requests are organization-level — choose which
              property this employee works in.
            </p>
          </div>
          <div>
            <label className="block text-micro font-semibold uppercase tracking-[0.08em] text-ink-3 mb-1.5">
              Initial zone (optional)
            </label>
            <select
              value={approveZoneUid}
              onChange={(e) => setApproveZoneUid(e.target.value)}
              disabled={!approvePropertyUid}
              className="w-full px-3 py-2.5 rounded-[10px] border border-line bg-white text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]/20 disabled:opacity-50"
            >
              <option value="">No initial zone</option>
              {zones.map((z) => (
                <option key={z.zone_uid} value={z.zone_uid}>
                  {z.name} ({z.code})
                </option>
              ))}
            </select>
          </div>
          {actionError && (
            <p className="text-xs text-[#A83434] bg-[#FAEBEB] rounded-[8px] px-3 py-2">
              {actionError}
            </p>
          )}
        </div>
      </Modal>

      {/* Reject — confirmation + optional reason */}
      <Modal
        isOpen={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title="Reject registration request?"
        description={
          selected
            ? `${selected.full_name} — no account will be created and the request is kept for audit.`
            : ''
        }
        footer={
          <div className="flex items-center justify-end gap-2.5 pt-4 border-t border-line">
            <Button variant="secondary" onClick={() => setRejectOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              isLoading={acting}
              onClick={() => void doReject()}
            >
              <XCircle className="w-4 h-4" />
              Reject Request
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-[13px] text-ink-2 leading-relaxed">
            The applicant will see this rejection when they next try to sign
            in to the mobile app.
          </p>
          <div>
            <label className="block text-micro font-semibold uppercase tracking-[0.08em] text-ink-3 mb-1.5">
              Rejection reason (optional)
            </label>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="Shown to the applicant on their next login attempt"
              className="w-full px-3.5 py-2.5 rounded-[10px] border border-line bg-white text-sm text-[#0D1C42] resize-none focus:outline-none focus:ring-2 focus:ring-[#800020]/20"
            />
          </div>
          {actionError && (
            <p className="text-xs text-[#A83434] bg-[#FAEBEB] rounded-[8px] px-3 py-2">
              {actionError}
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
};
