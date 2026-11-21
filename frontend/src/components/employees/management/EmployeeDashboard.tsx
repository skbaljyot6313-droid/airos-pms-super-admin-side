import React, { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Users, Building2, UserX, Crown } from 'lucide-react';
import { departmentOverview, DepartmentOverview } from '../../../api/departments';
import { BackButton } from '../../ui/BackButton';

const StatCard: React.FC<{
  label: string;
  value: string | number;
  sub?: string;
}> = ({ label, value, sub }) => (
  <div className="rounded-xl border border-[#E4DED1] bg-white/60 px-4 py-3">
    <div className="font-display text-xl font-bold text-[#17221B] tabular-nums leading-none">
      {value}
    </div>
    <div className="font-body text-xs text-[#66706A] mt-1.5">{label}</div>
    {sub && <div className="font-body text-[11px] text-[#9A9484] mt-0.5">{sub}</div>}
  </div>
);

export const EmployeeDashboard: React.FC = () => {
  const { propertyUid } = useParams<{ propertyUid: string }>();
  const [data, setData] = useState<DepartmentOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!propertyUid) return;
    let live = true;
    setLoading(true);
    departmentOverview(propertyUid)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e?.message || 'Failed to load overview'))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [propertyUid]);

  const maxCount = useMemo(
    () => Math.max(1, ...(data?.departments.map((d) => d.employee_count) ?? [1])),
    [data]
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <div className="mb-2">
            <BackButton to={`/property/${propertyUid}/overview`} />
          </div>
          <h1 className="font-display font-semibold text-[28px] text-[#17221B] tracking-tight leading-tight">
            Employee Management
          </h1>
          <p className="font-body text-sm text-[#66706A] mt-1">
            Organisation overview, departments and staffing health
          </p>
        </div>
      </div>


      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 font-body">
          {error}
        </div>
      )}

      {loading ? (
        <div className="font-body text-sm text-[#66706A]">Loading overview…</div>
      ) : data ? (
        <>
          {/* A. Organisation overview */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            <StatCard label="Total employees" value={data.total_employees} />
            <StatCard label="Active" value={data.active_employees} />
            <StatCard label="Inactive" value={data.inactive_employees} />
            <StatCard label="Departments" value={data.total_departments} />
            <StatCard label="Unassigned" value={data.unassigned_employees} />
            <StatCard label="Depts w/o head" value={data.departments_without_head} />
            <StatCard label="Avg per dept" value={data.avg_employees_per_department} />
          </div>

          {/* B + C. Department analytics + cards */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-display font-semibold text-lg text-[#17221B]">
                Departments
              </h2>
              <Link
                to={`/property/${propertyUid}/workforce/departments`}
                className="font-body text-sm text-[#4A5D4F] hover:underline"
              >
                Manage departments →
              </Link>
            </div>

            {data.departments.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[#D8D0BF] bg-white/40 px-6 py-10 text-center">
                <Building2 className="w-8 h-8 text-[#B8B0A0] mx-auto mb-2" />
                <p className="font-body text-sm text-[#66706A]">
                  No departments yet. Create one to start organising staff.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {data.departments.map((d) => (
                  <Link
                    key={d.department_uid}
                    to={`/property/${propertyUid}/workforce/departments/${d.department_uid}`}
                    className="rounded-xl border border-[#E4DED1] bg-white/60 p-4 hover:border-[#C8BFAA] transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-display font-semibold text-[#17221B] truncate">
                            {d.name}
                          </span>
                          {d.status !== 'active' && (
                            <span className="text-[10px] font-body uppercase tracking-wide bg-[#EAE4D6] text-[#8A8271] px-1.5 py-0.5 rounded">
                              {d.status}
                            </span>
                          )}
                        </div>
                        <div className="font-body text-xs text-[#66706A] mt-0.5 flex items-center gap-1">
                          {d.head ? (
                            <>
                              <Crown className="w-3 h-3 text-[#B08D3E]" />
                              {d.head.name}
                            </>
                          ) : (
                            <span className="text-[#9A9484]">No head assigned</span>
                          )}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-display font-bold text-[#17221B] tabular-nums">
                          {d.employee_count}
                        </div>
                        <div className="font-body text-[10px] text-[#9A9484] uppercase tracking-wide">
                          staff
                        </div>
                      </div>
                    </div>

                    {/* distribution bar: active vs inactive */}
                    <div className="mt-3 h-1.5 rounded-full bg-[#EFEAE0] overflow-hidden">
                      <div
                        className="h-full bg-[#4A5D4F] rounded-full transition-all"
                        style={{
                          width: `${Math.round((d.employee_count / maxCount) * 100)}%`,
                        }}
                      />
                    </div>
                    <div className="mt-1.5 flex items-center gap-3 font-body text-[11px] text-[#9A9484]">
                      <span className="flex items-center gap-1">
                        <Users className="w-3 h-3" /> {d.active_employee_count} active
                      </span>
                      {d.employee_count - d.active_employee_count > 0 && (
                        <span className="flex items-center gap-1">
                          <UserX className="w-3 h-3" />{' '}
                          {d.employee_count - d.active_employee_count} inactive
                        </span>
                      )}
                      {d.created_at && (
                        <span className="ml-auto">
                          since {new Date(d.created_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
};
