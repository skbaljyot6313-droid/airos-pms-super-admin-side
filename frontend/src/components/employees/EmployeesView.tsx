import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BarChart3, CalendarOff, ClipboardList, Clock, LayoutGrid, List, MapPin, Plus, UserX } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { Button } from '../ui/Button';
import { ZoneBoard } from './ZoneBoard';
import { EmployeeDirectory } from './EmployeeDirectory';
import { CreateEmployeeModal } from './CreateEmployeeModal';
import { LiveLocationMap } from './LiveLocationMap';
import { LeavesPanel } from './LeavesPanel';
import { ShiftManager } from './ShiftManager';
import { AttendanceBoard } from './AttendanceBoard';
import { TeamAnalyticsTab } from './analysis/TeamAnalytics';
import { BackButton } from '../ui/BackButton';
import { isEmployeeDeactivated } from '../../lib/employeeUtils';

// Compact metric pill — quiet statistics, not dashboard cards
const MetricPill: React.FC<{
  value: number;
  label: string;
  tone?: 'default' | 'warn';
}> = ({ value, label, tone = 'default' }) => (
  <div
    className={`flex items-baseline gap-1.5 px-3 py-1.5 rounded-[8px] ${
      tone === 'warn' ? 'bg-[#FDF3E2]' : 'bg-[#F6F4F2]'
    }`}
  >
    <span
      className={`font-display text-lg font-bold leading-none tabular-nums ${
        tone === 'warn' ? 'text-[#A56514]' : 'text-[#0D1C42]'
      }`}
    >
      {String(value).padStart(2, '0')}
    </span>
    <span
      className={`text-[10px] font-medium uppercase tracking-wider ${
        tone === 'warn' ? 'text-[#A56514]' : 'text-[#800020]'
      }`}
    >
      {label}
    </span>
  </div>
);

export const EmployeesView: React.FC = () => {
  const { currentPropertyEmployees, currentPropertyUnallocatedEmployees, activeProperty, currentUser } =
    useApp();

  const isStaff = currentUser?.role === 'super_admin' || currentUser?.role === 'property_manager';
  type EmpTab = 'board' | 'directory' | 'deactivated' | 'live' | 'leaves' | 'shifts' | 'attendance' | 'analytics';
  const EMP_TABS: EmpTab[] = ['board', 'directory', 'deactivated', 'live', 'leaves', 'shifts', 'attendance', 'analytics'];
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<EmpTab>(() => {
    const t = searchParams.get('tab');
    return EMP_TABS.includes(t as EmpTab) ? (t as EmpTab) : 'board';
  });
  // Sidebar links change ?tab= while this component stays mounted — keep in sync.
  useEffect(() => {
    const t = searchParams.get('tab');
    setActiveTab((prev) => {
      const next = EMP_TABS.includes(t as EmpTab) ? (t as EmpTab) : 'board';
      return prev === next ? prev : next;
    });
  }, [searchParams]);
  const setTab = (t: EmpTab) => {
    setActiveTab(t);
    setSearchParams((prev) => {
      const q = new URLSearchParams(prev);
      q.set('tab', t);
      return q;
    });
  };
  const [createModalOpen, setCreateModalOpen] = useState(false);

  const activeEmployees = currentPropertyEmployees.filter(
    (e) => !isEmployeeDeactivated(e)
  );
  const deactivatedEmployees = currentPropertyEmployees.filter(isEmployeeDeactivated);
  const assignedCount = activeEmployees.filter(
    (e) => e.zone_uid || e.area_uid || e.covers_property
  ).length;

  return (
    <div className="space-y-5">
      {/* Header — title hierarchy + primary action */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <div className="mb-2">
            <BackButton to={`/property/${activeProperty?.property_uid}/overview`} />
          </div>
          <h1 className="font-display font-semibold text-[28px] text-[#0D1C42] tracking-tight leading-tight">
            Employee Management
          </h1>
          <p className="font-body text-sm text-[#800020] mt-1">
            Physical zone assignments, staff roster, and team scheduling for{' '}
            <span className="text-[#0D1C42] font-medium">{activeProperty?.name}</span>
          </p>

          {/* Compact staffing summary */}
          <div className="flex items-center gap-2 mt-3">
            <MetricPill value={activeEmployees.length} label="Active Staff" />
            <MetricPill value={assignedCount} label="Assigned" />
            <MetricPill
              value={currentPropertyUnallocatedEmployees.length}
              label="Unallocated"
              tone={currentPropertyUnallocatedEmployees.length > 0 ? 'warn' : 'default'}
            />
          </div>
        </div>

        <Button
          variant="primary"
          onClick={() => setCreateModalOpen(true)}
          className="self-start gap-2 !bg-[#800020] hover:!bg-[#0D1C42] !rounded-[8px]"
        >
          <Plus className="w-4 h-4" />
          <span>Add Staff Member</span>
        </Button>
      </div>


      {/* Segmented control + exception chip */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="inline-flex p-1 rounded-[10px] bg-[#F6F4F2] w-fit">
          <button
            onClick={() => setTab('board')}
            className={`px-4 py-1.5 rounded-[8px] text-xs font-semibold transition-all duration-150 cursor-pointer inline-flex items-center gap-2 ${
              activeTab === 'board'
                ? 'bg-white text-[#0D1C42] shadow-[0_1px_2px_rgba(20,30,24,0.10)]'
                : 'text-[#800020] hover:text-[#0D1C42]'
            }`}
          >
            <LayoutGrid
              className={`w-3.5 h-3.5 ${activeTab === 'board' ? 'text-[#800020]' : ''}`}
            />
            <span>Zone Board</span>
          </button>
          <button
            onClick={() => setTab('directory')}
            className={`px-4 py-1.5 rounded-[8px] text-xs font-semibold transition-all duration-150 cursor-pointer inline-flex items-center gap-2 ${
              activeTab === 'directory'
                ? 'bg-white text-[#0D1C42] shadow-[0_1px_2px_rgba(20,30,24,0.10)]'
                : 'text-[#800020] hover:text-[#0D1C42]'
            }`}
          >
            <List
              className={`w-3.5 h-3.5 ${activeTab === 'directory' ? 'text-[#800020]' : ''}`}
            />
            <span>Active Staff</span>
            <span
              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-[5px] ${
                activeTab === 'directory'
                  ? 'bg-[#F7E9EE] text-[#800020]'
                  : 'bg-[#E7E5E4] text-[#800020]'
              }`}
            >
              {activeEmployees.length}
            </span>
          </button>
          <button
            onClick={() => setTab('deactivated')}
            className={`px-4 py-1.5 rounded-[8px] text-xs font-semibold transition-all duration-150 cursor-pointer inline-flex items-center gap-2 ${
              activeTab === 'deactivated'
                ? 'bg-white text-[#0D1C42] shadow-[0_1px_2px_rgba(20,30,24,0.10)]'
                : 'text-[#800020] hover:text-[#0D1C42]'
            }`}
          >
            <UserX
              className={`w-3.5 h-3.5 ${activeTab === 'deactivated' ? 'text-[#A83434]' : ''}`}
            />
            <span>Deactivated Staff</span>
            <span
              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-[5px] ${
                activeTab === 'deactivated'
                  ? 'bg-[#FAEBEB] text-[#A83434]'
                  : 'bg-[#E7E5E4] text-[#800020]'
              }`}
            >
              {deactivatedEmployees.length}
            </span>
          </button>
          <button
            onClick={() => setTab('shifts')}
            className={`px-4 py-1.5 rounded-[8px] text-xs font-semibold transition-all duration-150 cursor-pointer inline-flex items-center gap-2 ${
              activeTab === 'shifts'
                ? 'bg-white text-[#0D1C42] shadow-[0_1px_2px_rgba(20,30,24,0.10)]'
                : 'text-[#800020] hover:text-[#0D1C42]'
            }`}
          >
            <Clock
              className={`w-3.5 h-3.5 ${activeTab === 'shifts' ? 'text-[#800020]' : ''}`}
            />
            <span>Shifts</span>
          </button>
          <button
            onClick={() => setTab('attendance')}
            className={`px-4 py-1.5 rounded-[8px] text-xs font-semibold transition-all duration-150 cursor-pointer inline-flex items-center gap-2 ${
              activeTab === 'attendance'
                ? 'bg-white text-[#0D1C42] shadow-[0_1px_2px_rgba(20,30,24,0.10)]'
                : 'text-[#800020] hover:text-[#0D1C42]'
            }`}
          >
            <ClipboardList
              className={`w-3.5 h-3.5 ${activeTab === 'attendance' ? 'text-[#800020]' : ''}`}
            />
            <span>Attendance</span>
          </button>
          <button
            onClick={() => setTab('analytics')}
            className={`px-4 py-1.5 rounded-[8px] text-xs font-semibold transition-all duration-150 cursor-pointer inline-flex items-center gap-2 ${
              activeTab === 'analytics'
                ? 'bg-white text-[#0D1C42] shadow-[0_1px_2px_rgba(20,30,24,0.10)]'
                : 'text-[#800020] hover:text-[#0D1C42]'
            }`}
          >
            <BarChart3
              className={`w-3.5 h-3.5 ${activeTab === 'analytics' ? 'text-[#2457A8]' : ''}`}
            />
            <span>Analytics</span>
          </button>
          {isStaff && (
            <>
              <button
                onClick={() => setTab('live')}
                className={`px-4 py-1.5 rounded-[8px] text-xs font-semibold transition-all duration-150 cursor-pointer inline-flex items-center gap-2 ${
                  activeTab === 'live'
                    ? 'bg-white text-[#0D1C42] shadow-[0_1px_2px_rgba(20,30,24,0.10)]'
                    : 'text-[#800020] hover:text-[#0D1C42]'
                }`}
              >
                <MapPin
                  className={`w-3.5 h-3.5 ${activeTab === 'live' ? 'text-[#800020]' : ''}`}
                />
                <span>Live Location</span>
              </button>
              <button
                onClick={() => setTab('leaves')}
                className={`px-4 py-1.5 rounded-[8px] text-xs font-semibold transition-all duration-150 cursor-pointer inline-flex items-center gap-2 ${
                  activeTab === 'leaves'
                    ? 'bg-white text-[#0D1C42] shadow-[0_1px_2px_rgba(20,30,24,0.10)]'
                    : 'text-[#800020] hover:text-[#0D1C42]'
                }`}
              >
                <CalendarOff
                  className={`w-3.5 h-3.5 ${activeTab === 'leaves' ? 'text-[#800020]' : ''}`}
                />
                <span>Leaves</span>
              </button>
            </>
          )}
        </div>

        {currentPropertyUnallocatedEmployees.length > 0 && (
          <div className="text-[11px] font-medium text-[#A56514] bg-[#FDF3E2] px-2.5 py-1 rounded-[8px] inline-flex items-center gap-1.5 w-fit">
            <span className="w-1.5 h-1.5 rounded-full bg-[#A56514]" />
            <span>
              {currentPropertyUnallocatedEmployees.length} staff unallocated to physical zones
            </span>
          </div>
        )}
      </div>

      {/* Tab Views */}
      {activeTab === 'board' ? (
        <ZoneBoard onOpenCreateModal={() => setCreateModalOpen(true)} />
      ) : activeTab === 'live' ? (
        <LiveLocationMap />
      ) : activeTab === 'shifts' ? (
        <ShiftManager />
      ) : activeTab === 'attendance' ? (
        <AttendanceBoard />
      ) : activeTab === 'analytics' ? (
        <TeamAnalyticsTab />
      ) : activeTab === 'leaves' ? (
        <LeavesPanel />
      ) : (
        <EmployeeDirectory deactivated={activeTab === 'deactivated'} />
      )}

      {/* Add Employee Modal */}
      <CreateEmployeeModal
        isOpen={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
      />
    </div>
  );
};
