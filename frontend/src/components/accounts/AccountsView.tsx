import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Inbox,
  KeyRound,
  RefreshCw,
  Search,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { Card } from '../ui/Card';
import { ApiError } from '../../api/client';
import { Account, listAccounts } from '../../api/accounts';
import { getEmployeeRequestsPendingCount } from '../../api/employeeRequests';
import { EmployeeRequestsView } from '../employees/EmployeeRequestsView';
import { OrganizationCodes } from '../organization/OrganizationCodes';
import { BackButton } from '../ui/BackButton';
import { UserRole } from '../../types';

const ROLE_META: Record<UserRole, { label: string; access: string; tone: string }> = {
  super_admin: {
    label: 'Super Admin',
    access: 'Full access — every property, org settings, codes & requests',
    tone: 'bg-[#F7E9EE] text-[#800020]',
  },
  property_manager: {
    label: 'Property Manager',
    access: 'Operations, staff & tasks — assigned property only',
    tone: 'bg-[#E9F0FA] text-[#0D1C42]',
  },
  human_resource: {
    label: 'Human Resource',
    access: 'Payroll surface — assigned property only',
    tone: 'bg-[#E9F0FA] text-[#0D1C42]',
  },
  department_manager: {
    label: 'Dept. Manager',
    access: 'Task calendar — assigned property only',
    tone: 'bg-[#F6F4F2] text-[#667085]',
  },
  employee: {
    label: 'Employee',
    access: 'Employee app only — no console access',
    tone: 'bg-[#F6F4F2] text-[#667085]',
  },
};

const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString() : 'Never';

type AccountsTab = 'accounts' | 'requests' | 'codes';
const TABS: AccountsTab[] = ['accounts', 'requests', 'codes'];

export const AccountsView: React.FC = () => {
  const { activeProperty, currentUser, currentRole } = useApp();
  const isSuperAdmin =
    (currentUser?.role ?? currentRole) === 'super_admin';
  // Property isolation: default to the selected property's accounts and
  // requests; "All properties" is the explicit org-wide view. Only
  // super_admin gets that option — a property manager is always
  // property-scoped (the backend pins them server-side regardless).
  const [scopeAll, setScopeAll] = useState(false);
  const orgWide = isSuperAdmin && scopeAll;
  const scopedPropertyUid = orgWide
    ? undefined
    : activeProperty?.property_uid;

  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<AccountsTab>(() => {
    const t = searchParams.get('tab');
    return TABS.includes(t as AccountsTab) ? (t as AccountsTab) : 'accounts';
  });
  useEffect(() => {
    const t = searchParams.get('tab');
    setActiveTab(TABS.includes(t as AccountsTab) ? (t as AccountsTab) : 'accounts');
  }, [searchParams]);
  const setTab = (t: AccountsTab) => {
    setActiveTab(t);
    setSearchParams((prev) => {
      const q = new URLSearchParams(prev);
      q.set('tab', t);
      return q;
    });
  };

  // Pending registration count decorates the Requests tab.
  const [pendingRequests, setPendingRequests] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const poll = () =>
      getEmployeeRequestsPendingCount()
        .then((r) => !cancelled && setPendingRequests(r.pending))
        .catch(() => undefined);
    void poll();
    const t = window.setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const loadAccounts = useCallback(() => {
    setAccountsError(null);
    listAccounts(scopedPropertyUid)
      .then((r) => setAccounts(r.items))
      .catch((e) =>
        setAccountsError(
          e instanceof ApiError ? e.message : 'Could not load accounts.',
        ),
      );
  }, [scopedPropertyUid]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  const q = query.trim().toLowerCase();
  const filtered = (accounts ?? []).filter(
    (a) =>
      !q ||
      a.name.toLowerCase().includes(q) ||
      a.username.toLowerCase().includes(q) ||
      a.email.toLowerCase().includes(q) ||
      (a.property_name ?? '').toLowerCase().includes(q),
  );

  const tabBtn = (t: AccountsTab, icon: React.ReactNode, label: string, badge?: number) => (
    <button
      key={t}
      onClick={() => setTab(t)}
      className={`px-4 py-1.5 rounded-[8px] text-xs font-semibold transition-all duration-150 cursor-pointer inline-flex items-center gap-2 ${
        activeTab === t
          ? 'bg-white text-[#0D1C42] shadow-[0_1px_2px_rgba(20,30,24,0.10)]'
          : 'text-[#800020] hover:text-[#0D1C42]'
      }`}
    >
      <span className={`w-3.5 h-3.5 ${activeTab === t ? 'text-[#800020]' : ''}`}>
        {icon}
      </span>
      <span>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span
          className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-[5px] ${
            activeTab === t
              ? 'bg-[#F7E9EE] text-[#800020]'
              : 'bg-[#E7E5E4] text-[#800020]'
          }`}
        >
          {badge}
        </span>
      )}
    </button>
  );

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <div className="mb-2">
          <BackButton to={`/property/${activeProperty?.property_uid}/overview`} />
        </div>
        <h1 className="font-display font-semibold text-[28px] text-[#0D1C42] tracking-tight leading-tight">
          Accounts
        </h1>
        <p className="font-body text-sm text-[#800020] mt-1">
          Login accounts, roles &amp; permissions, registration requests, and
          organization codes for{' '}
          <span className="text-[#0D1C42] font-medium">
            {orgWide ? 'the whole organization' : (activeProperty?.name ?? 'this property')}
          </span>
        </p>
      </div>

      {/* Segmented control + property scope */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="inline-flex p-1 rounded-[10px] bg-[#F6F4F2] w-fit">
          {tabBtn('accounts', <ShieldCheck className="w-3.5 h-3.5" />, 'Accounts', accounts?.length)}
          {tabBtn('requests', <Inbox className="w-3.5 h-3.5" />, 'Requests', pendingRequests)}
          {tabBtn('codes', <KeyRound className="w-3.5 h-3.5" />, 'Codes')}
        </div>
        {activeTab !== 'codes' && isSuperAdmin && (
          <div className="inline-flex p-1 rounded-[10px] bg-[#F6F4F2] w-fit">
            <button
              onClick={() => setScopeAll(false)}
              className={`px-3 py-1 rounded-[8px] text-[11px] font-semibold transition-all duration-150 cursor-pointer ${
                !scopeAll
                  ? 'bg-white text-[#0D1C42] shadow-[0_1px_2px_rgba(20,30,24,0.10)]'
                  : 'text-[#800020] hover:text-[#0D1C42]'
              }`}
            >
              {activeProperty?.name ?? 'This property'}
            </button>
            <button
              onClick={() => setScopeAll(true)}
              className={`px-3 py-1 rounded-[8px] text-[11px] font-semibold transition-all duration-150 cursor-pointer ${
                scopeAll
                  ? 'bg-white text-[#0D1C42] shadow-[0_1px_2px_rgba(20,30,24,0.10)]'
                  : 'text-[#800020] hover:text-[#0D1C42]'
              }`}
            >
              All properties
            </button>
          </div>
        )}
      </div>

      {activeTab === 'requests' && (
        <EmployeeRequestsView
          onCountChange={setPendingRequests}
          propertyUid={scopedPropertyUid}
        />
      )}

      {activeTab === 'codes' && <OrganizationCodes />}

      {activeTab === 'accounts' && (
        <Card className="p-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2">
              <UserCheck className="w-4 h-4 text-[#800020]" />
              <h3 className="font-display font-bold text-base text-[#0D1C42]">
                All Accounts
              </h3>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-[#667085] absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search name, username, email…"
                  className="pl-8 pr-3 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] w-64 focus:outline-none focus:ring-2 focus:ring-[#800020]"
                />
              </div>
              <button
                type="button"
                onClick={loadAccounts}
                title="Refresh accounts"
                className="p-2 rounded-[10px] border border-[#D6D3D1] text-[#800020] hover:bg-[#F6F4F2] transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {accountsError && (
            <div
              role="alert"
              className="mb-4 p-3 rounded-[10px] bg-[#FAEBEB] border border-[#F0C8C8] text-[#A83434] text-xs font-medium"
            >
              {accountsError}
            </div>
          )}

          <div className="rounded-[10px] border border-[#E7E5E4] overflow-hidden overflow-x-auto">
            <table className="w-full text-left min-w-[760px]">
              <thead>
                <tr className="bg-[#F6F4F2] text-[10px] font-semibold uppercase tracking-[0.08em] text-[#667085]">
                  <th className="px-4 py-2.5">Account</th>
                  <th className="px-4 py-2.5">Role</th>
                  <th className="px-4 py-2.5">Permissions</th>
                  <th className="px-4 py-2.5">Property</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Last login</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E7E5E4]">
                {accounts === null && !accountsError && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-xs text-[#667085]">
                      Loading accounts…
                    </td>
                  </tr>
                )}
                {accounts !== null && filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-xs text-[#667085]">
                      {q ? 'No accounts match the search.' : 'No accounts found.'}
                    </td>
                  </tr>
                )}
                {filtered.map((a) => {
                  const meta = ROLE_META[a.role] ?? {
                    label: a.role,
                    access: '—',
                    tone: 'bg-[#F6F4F2] text-[#667085]',
                  };
                  return (
                    <tr key={a.account_uid} className="hover:bg-[#FBFAF9] align-top">
                      <td className="px-4 py-3">
                        <p className="font-body text-sm font-semibold text-[#0D1C42]">
                          {a.name}
                        </p>
                        <p className="text-xs text-[#667085]">
                          @{a.username} · {a.email}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-[6px] text-[10px] font-semibold ${meta.tone}`}
                        >
                          {meta.label}
                        </span>
                        {a.job_title && (
                          <p className="text-[11px] text-[#667085] mt-1">{a.job_title}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-[#667085] max-w-[220px]">
                        {meta.access}
                      </td>
                      <td className="px-4 py-3 text-xs text-[#0D1C42]">
                        {a.property_name ?? (
                          <span className="text-[#667085]">Organization-wide</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-[6px] text-[10px] font-semibold ${
                            a.is_active
                              ? 'bg-[#EDF7EE] text-[#386641]'
                              : 'bg-[#FAEBEB] text-[#A83434]'
                          }`}
                        >
                          {a.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-[#667085] whitespace-nowrap">
                        {fmtDate(a.last_login_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-[#667085] font-body mt-3">
            Roles decide what each account can reach. Employee and department
            accounts sign in on the employee app, not this console.
          </p>
        </Card>
      )}
    </div>
  );
};
