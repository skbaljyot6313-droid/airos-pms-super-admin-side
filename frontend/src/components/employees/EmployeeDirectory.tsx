import React, { useEffect, useState } from 'react';
import {
  Search,
  Filter,
  Mail,
  Phone,
  Calendar,
  MoreVertical,
  UserX,
  Edit,
  Trash2,
  RotateCcw,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { DEPARTMENTS } from './CreateEmployeeModal';
import { listDepartments } from '../../api/departments';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';
import { Employee } from '../../types';
import { getInitials } from '../../lib/utils';
import { isEmployeeDeactivated } from '../../lib/employeeUtils';
import { fmtDateTimeIST } from '../../lib/datetime';

export const EmployeeDirectory: React.FC<{ deactivated?: boolean }> = ({
  deactivated = false,
}) => {
  const {
    currentPropertyEmployees,
    currentPropertyZones,
    currentPropertyAreas,
    updateEmployee,
    deactivateEmployee,
    reactivateEmployee,
    deleteEmployee,
    assignEmployeeToZone,
    assignEmployeeToArea,
    assignEmployeeToPropertyWide,
    assignEmployeeSecondaryZone,
    navigate,
    activePropertyUid,
  } = useApp();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedZone, setSelectedZone] = useState('all');
  const [selectedDept, setSelectedDept] = useState('all');
  const [selectedStatus, setSelectedStatus] = useState('all');

  const [activeMenuEmpUid, setActiveMenuEmpUid] = useState<string | null>(null);
  const [empToDeactivate, setEmpToDeactivate] = useState<Employee | null>(null);
  const [empToDelete, setEmpToDelete] = useState<Employee | null>(null);

  // Live managed departments — static canonical list as fallback.
  const [deptOptions, setDeptOptions] = useState<string[]>(DEPARTMENTS);
  useEffect(() => {
    if (!activePropertyUid) return;
    let live = true;
    listDepartments({ property_uid: activePropertyUid })
      .then((ds) => {
        if (live && ds.length) setDeptOptions(ds.map((d) => d.name));
      })
      .catch(() => {/* keep static fallback */});
    return () => {
      live = false;
    };
  }, [activePropertyUid]);

  // Edit employee modal state
  const [editingEmp, setEditingEmp] = useState<Employee | null>(null);
  const [editName, setEditName] = useState('');
  const [editJobTitle, setEditJobTitle] = useState('');
  const [editDept, setEditDept] = useState('');
  const [editPhone, setEditPhone] = useState('');

  const directoryEmployees = currentPropertyEmployees.filter(
    (emp) => isEmployeeDeactivated(emp) === deactivated
  );

  // Filtering
  const filteredEmployees = directoryEmployees.filter((emp) => {
    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchName = emp.name.toLowerCase().includes(q);
      const matchEmail = emp.email.toLowerCase().includes(q);
      const matchId = emp.employee_uid.toLowerCase().includes(q);
      const matchRole = emp.job_title.toLowerCase().includes(q);
      if (!matchName && !matchEmail && !matchId && !matchRole) return false;
    }

    // Zone filter
    if (selectedZone !== 'all') {
      if (selectedZone === 'unallocated' && (emp.zone_uid || emp.area_uid)) return false;
      if (selectedZone !== 'unallocated' && emp.zone_uid !== selectedZone) return false;
    }

    // Department filter
    if (selectedDept !== 'all' && emp.department !== selectedDept) return false;

    // Status filter
    if (!deactivated && selectedStatus !== 'all' &&
        emp.status.toLowerCase() !== selectedStatus.toLowerCase()) return false;

    return true;
  });

  const handleStartEdit = (emp: Employee) => {
    setEditingEmp(emp);
    setEditName(emp.name);
    setEditJobTitle(emp.job_title);
    setEditDept(emp.department);
    setEditPhone(emp.phone);
    setActiveMenuEmpUid(null);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingEmp || !editName.trim()) return;
    try {
      await updateEmployee(editingEmp.employee_uid, {
        name: editName.trim(),
        job_title: editJobTitle.trim(),
        department: editDept as any,
        phone: editPhone.trim(),
      });
      setEditingEmp(null);
    } catch {
      // Error toast handled by the context layer — keep dialog open
    }
  };

  return (
    <div className="space-y-5">
      {/* Search and Filter Controls */}
      <div className="p-4 rounded-[14px] bg-[#FFFFFF] border border-[#E7E5E4] space-y-3">
        {/* Search Input */}
        <div className="relative">
          <Search className="w-4 h-4 text-[#667085] absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by name, employee ID (e.g. EMP-001), job title, or email..."
            className="w-full pl-10 pr-4 py-2 bg-white border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] placeholder:text-[#98A2B3] focus:outline-none focus:ring-2 focus:ring-[#800020]/25 focus:border-[#800020]"
          />
        </div>

        {/* Filter Selectors */}
        <div className={`grid grid-cols-1 ${deactivated ? 'sm:grid-cols-2' : 'sm:grid-cols-3'} gap-3 text-xs`}>
          <div className="flex items-center gap-1.5">
            <span className="text-[#667085] font-medium shrink-0">Zone:</span>
            <select
              value={selectedZone}
              onChange={(e) => setSelectedZone(e.target.value)}
              className="w-full bg-white border border-[#D6D3D1] rounded-[8px] px-2.5 py-1.5 text-xs text-[#0D1C42] focus:outline-none"
            >
              <option value="all">All Zones</option>
              <option value="unallocated">Unallocated Pool</option>
              {currentPropertyZones.map((z) => (
                <option key={z.zone_uid} value={z.zone_uid}>
                  {z.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-[#667085] font-medium shrink-0">Dept:</span>
            <select
              value={selectedDept}
              onChange={(e) => setSelectedDept(e.target.value)}
              className="w-full bg-white border border-[#D6D3D1] rounded-[8px] px-2.5 py-1.5 text-xs text-[#0D1C42] focus:outline-none"
            >
              <option value="all">All Departments</option>
              {deptOptions.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>

          {!deactivated && (
            <div className="flex items-center gap-1.5">
              <span className="text-[#667085] font-medium shrink-0">Status:</span>
              <select
                value={selectedStatus}
                onChange={(e) => setSelectedStatus(e.target.value)}
                className="w-full bg-white border border-[#D6D3D1] rounded-[8px] px-2.5 py-1.5 text-xs text-[#0D1C42] focus:outline-none"
              >
                <option value="all">All Statuses</option>
                <option value="Active">Active</option>
                <option value="On Leave">On Leave</option>
                <option value="Off Duty">Off Duty</option>
                <option value="Probation">Probation</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Employees Grid */}
      {filteredEmployees.length === 0 ? (
        <Card className="p-10 text-center border-dashed">
          <p className="font-semibold text-sm text-[#0D1C42]">
            {deactivated ? 'No deactivated staff' : 'No employees found'}
          </p>
          <p className="text-xs text-[#667085] mt-1">
            {deactivated
              ? 'Staff moved here retain their history but cannot receive new work.'
              : 'Try adjusting your search query or clear active filters.'}
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredEmployees.map((emp) => {
            const isDeactivated = isEmployeeDeactivated(emp);
            const isMenuOpen = activeMenuEmpUid === emp.employee_uid;

            return (
              <Card
                key={emp.employee_uid}
                className="p-4 flex flex-col justify-between hover:border-[#800020] relative cursor-pointer"
                onClick={(e) => {
                  if (!(e.target as HTMLElement).closest('button, a, input, select, textarea, label, [role="menu"]'))
                    navigate(`/property/${emp.property_uid}/workforce/employees/${emp.employee_uid}`);
                }}
              >
                <div>
                  {/* Top Bar: Initials avatar + Actions Kebab */}
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-10 h-10 rounded-full text-white flex items-center justify-center font-bold text-sm shrink-0 shadow-xs"
                        style={{ backgroundColor: emp.avatar_color || '#800020' }}
                      >
                        {getInitials(emp.name)}
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <h4 className="font-semibold text-sm text-[#0D1C42] leading-tight">
                            <button type="button" onClick={() => navigate(`/property/${emp.property_uid}/workforce/employees/${emp.employee_uid}`)} aria-label={`View employee profile for ${emp.name}`} className="text-left hover:text-[#800020] hover:underline focus-visible:outline-2 focus-visible:outline-[#800020]">{emp.name}</button>
                          </h4>
                          {isDeactivated && (
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-[#FAEBEB] text-[#A83434] font-medium">
                              Deactivated
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-[#667085] font-body mt-0.5">
                          {emp.job_title}
                        </p>
                      </div>
                    </div>

                    {/* Kebab Menu */}
                    <div className="relative">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveMenuEmpUid(isMenuOpen ? null : emp.employee_uid);
                        }}
                        className="p-1 text-[#667085] hover:text-[#0D1C42] hover:bg-[#F6F4F2] rounded-[6px] transition-colors cursor-pointer"
                        aria-label="Actions"
                      >
                        <MoreVertical className="w-4 h-4" />
                      </button>

                      {isMenuOpen && (
                        <div
                          className="absolute right-0 top-7 z-30 w-40 bg-white border border-[#D6D3D1] rounded-[10px] shadow-lg py-1 pop-in"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            onClick={() => handleStartEdit(emp)}
                            className="w-full px-3 py-1.5 text-xs text-[#0D1C42] hover:bg-[#FFFCFA] flex items-center gap-2 text-left cursor-pointer"
                          >
                            <Edit className="w-3.5 h-3.5 text-[#667085]" />
                            <span>Edit Details</span>
                          </button>
                          <div className="my-1 border-t border-[#F6F4F2]" />
                          {isDeactivated ? (
                            <button
                              onClick={() => {
                                void reactivateEmployee(emp.employee_uid);
                                setActiveMenuEmpUid(null);
                              }}
                              className="w-full px-3 py-1.5 text-xs text-[#800020] hover:bg-[#F7E9EE] flex items-center gap-2 text-left cursor-pointer"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              <span>Reactivate</span>
                            </button>
                          ) : (
                            <button
                              onClick={() => {
                                setEmpToDeactivate(emp);
                                setActiveMenuEmpUid(null);
                              }}
                              className="w-full px-3 py-1.5 text-xs text-[#A56514] hover:bg-[#FDF3E2] flex items-center gap-2 text-left cursor-pointer"
                            >
                              <UserX className="w-3.5 h-3.5" />
                              <span>Deactivate Staff</span>
                            </button>
                          )}
                          <button
                            onClick={() => {
                              setEmpToDelete(emp);
                              setActiveMenuEmpUid(null);
                            }}
                            className="w-full px-3 py-1.5 text-xs text-[#D64545] hover:bg-[#FAEBEB] flex items-center gap-2 text-left cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>Delete Permanently</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* ID & Department Tag */}
                  <div className="flex items-center justify-between text-xs mb-3">
                    <span className="font-mono text-[11px] text-[#667085] px-1.5 py-0.5 rounded bg-[#FFFFFF] border border-[#E7E5E4]">
                      {emp.employee_uid}
                    </span>
                    <span className="text-[11px] font-medium text-[#0D1C42] bg-[#F6F4F2] px-2 py-0.5 rounded-full truncate max-w-[170px]">
                      {emp.department}
                    </span>
                  </div>

                  {/* Contact Info */}
                  <div className="space-y-1 text-xs text-[#667085] font-body mb-3">
                    <div className="flex items-center gap-2 truncate">
                      <Mail className="w-3.5 h-3.5 text-[#98A2B3] shrink-0" />
                      <span className="truncate">{emp.email}</span>
                    </div>
                    {emp.phone && (
                      <div className="flex items-center gap-2">
                        <Phone className="w-3.5 h-3.5 text-[#98A2B3] shrink-0" />
                        <span>{emp.phone}</span>
                      </div>
                    )}
                  </div>

                  {/* Zone / Area Assignment Dropdown */}
                  <div className="mb-2">
                    <label className="block text-[10px] font-semibold text-[#667085] uppercase tracking-wider mb-1 font-body">
                      {isDeactivated ? 'Last Zone / Area' : 'Assigned Zone / Area'}
                    </label>
                    <select
                      value={
                        emp.covers_property
                          ? 'property-wide'
                          : emp.area_uid
                          ? `area:${emp.area_uid}`
                          : emp.zone_uid || ''
                      }
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === 'property-wide') {
                          assignEmployeeToPropertyWide(emp.employee_uid);
                        } else if (v.startsWith('area:')) {
                          assignEmployeeToArea(emp.employee_uid, v.slice(5));
                        } else {
                          assignEmployeeToZone(emp.employee_uid, v || null);
                        }
                      }}
                      disabled={isDeactivated}
                      className="w-full bg-[#FFFFFF] border border-[#D6D3D1] rounded-[8px] px-2.5 py-1 text-xs text-[#0D1C42] focus:outline-none disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      <option value="">(Unallocated Pool)</option>
                      <option value="property-wide">Whole property — every zone</option>
                      {currentPropertyAreas.map((a) => (
                        <option key={a.area_uid} value={`area:${a.area_uid}`}>
                          {a.name} — whole area
                        </option>
                      ))}
                      {currentPropertyZones.map((z) => (
                        <option key={z.zone_uid} value={z.zone_uid}>
                          {z.name} ({z.floor})
                        </option>
                      ))}
                    </select>
                    {/* Second-zone coverage — only meaningful for zone-assigned staff */}
                    {Boolean(emp.zone_uid && !emp.area_uid && !emp.covers_property) && (
                      <select
                        value={emp.secondary_zone_uid || ''}
                        onChange={(e) =>
                          assignEmployeeSecondaryZone(
                            emp.employee_uid,
                            e.target.value || null
                          )
                        }
                        disabled={isDeactivated}
                        title="More zone allocation — cover a second zone"
                        className="mt-1 w-full bg-[#FFFFFF] border border-[#D6D3D1] rounded-[8px] px-2.5 py-1 text-xs text-[#0D1C42] focus:outline-none disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        <option value="">+ Second zone…</option>
                        {currentPropertyZones
                          .filter((z) => z.zone_uid !== emp.zone_uid)
                          .map((z) => (
                            <option key={z.zone_uid} value={z.zone_uid}>
                              Also: {z.name} ({z.floor})
                            </option>
                          ))}
                      </select>
                    )}
                  </div>
                </div>

                {/* Footer: Leave Balance / Status */}
                <div className="pt-2.5 border-t border-[#F6F4F2] flex items-center justify-between text-xs text-[#667085]">
                  <div className="flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5 text-[#667085]" />
                    <span>
                      Leave balance: <strong>{emp.leave_balance_days ?? '—'}</strong> days
                    </span>
                  </div>

                  {isDeactivated ? (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#FAEBEB] text-[#A83434]">
                      Deactivated{emp.deactivated_at ? ` · ${fmtDateTimeIST(emp.deactivated_at)}` : ''}
                    </span>
                  ) : emp.status === 'On Leave' || emp.leave_status ? (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#FDF3E2] text-[#A56514]">
                      On Leave
                    </span>
                  ) : (
                    <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-[#F7E9EE] text-[#0D1C42]">
                      Active On Duty
                    </span>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Edit Employee Modal */}
      {editingEmp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#0D1C42]/40">
          <div className="w-full max-w-md bg-white border border-[#E7E5E4] rounded-[18px] p-6 shadow-xl">
            <h3 className="font-display font-bold text-lg text-[#0D1C42] mb-4">
              Edit Employee Details
            </h3>
            <form onSubmit={handleSaveEdit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1">
                  Full Name
                </label>
                <input
                  type="text"
                  required
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1">
                  Job Title
                </label>
                <input
                  type="text"
                  required
                  value={editJobTitle}
                  onChange={(e) => setEditJobTitle(e.target.value)}
                  className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1">
                  Department
                </label>
                <select
                  value={editDept}
                  onChange={(e) => setEditDept(e.target.value)}
                  className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
                >
                  {deptOptions.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-[#0D1C42] uppercase tracking-wider mb-1">
                  Phone Number
                </label>
                <input
                  type="tel"
                  value={editPhone}
                  onChange={(e) => setEditPhone(e.target.value)}
                  className="w-full px-3.5 py-2 bg-[#FFFFFF] border border-[#D6D3D1] rounded-[10px] text-sm text-[#0D1C42] focus:outline-none focus:ring-2 focus:ring-[#800020]"
                />
              </div>
              <div className="flex justify-end gap-2.5 pt-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditingEmp(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary">
                  Save Changes
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Deactivate Employee Confirmation */}
      {empToDeactivate && (
        <ConfirmationDialog
          isOpen={!!empToDeactivate}
          onClose={() => setEmpToDeactivate(null)}
          onConfirm={() => void deactivateEmployee(empToDeactivate.employee_uid)}
          entityType="Employee"
          entityName={empToDeactivate.name}
          title="Deactivate Staff?"
          warningTitle="Staff access will be paused."
          impactMessage="This staff member will be unassigned from their zone and no longer available for allocation, task assignment, or new work until they are reactivated."
          promptMessage="Existing assignments and task history remain unchanged. Their login will be disabled until they are reactivated."
          confirmLabel="Deactivate"
          confirmVariant="primary"
        />
      )}

      {/* Permanent Employee Delete Confirmation */}
      {empToDelete && (
        <ConfirmationDialog
          isOpen={!!empToDelete}
          onClose={() => setEmpToDelete(null)}
          onConfirm={() => void deleteEmployee(empToDelete.employee_uid)}
          entityType="Staff"
          entityName={empToDelete.name}
          title="Permanently Delete Staff?"
          impactMessage={`Permanently deleting ${empToDelete.name} removes their record and login, unassigns their open tasks, and preserves past task history. This cannot be undone.`}
          promptMessage={`Type ${empToDelete.name} to permanently delete this staff account.`}
          confirmLabel="Permanently Delete"
          confirmationText={empToDelete.name}
        />
      )}
    </div>
  );
};
