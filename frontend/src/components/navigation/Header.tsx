import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Building2,
  LayoutDashboard,
  Users,
  BedDouble,
  ClipboardList,
  BarChart3,
  ChevronDown,
  ChevronRight,
  LogOut,
  Menu,
  X,
  Clock,
  Settings,
  Shield,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { getInitials } from '../../lib/utils';

/** Live clock pinned to Indian Standard Time, 12-hour format. */
const ISTClock: React.FC = () => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const time = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(now);
  return (
    <div
      className="hidden lg:flex items-center gap-1.5 px-2.5 py-1.5 rounded-[9px] bg-[#F7F5F0] border border-[#EAE5DC] text-[#58534C]"
      title="Indian Standard Time"
    >
      <Clock className="w-3.5 h-3.5 text-[#386641]" />
      <span className="text-[12.5px] font-semibold tabular-nums tracking-tight">
        {time.replace(/\s+/g, ' ')}
      </span>
      <span className="text-[10px] font-medium text-[#8C867C]">IST</span>
    </div>
  );
};

interface PrimaryItem {
  label: string;
  base: string; // path segment after /property/:uid/
  icon: React.ReactNode;
}

const PRIMARY_ITEMS: PrimaryItem[] = [
  { label: 'Dashboard', base: 'overview', icon: <LayoutDashboard className="w-4 h-4" /> },
  { label: 'Workforce', base: 'workforce', icon: <Users className="w-4 h-4" /> },
  { label: 'Property', base: 'property', icon: <BedDouble className="w-4 h-4" /> },
  { label: 'Operations', base: 'operations', icon: <ClipboardList className="w-4 h-4" /> },
  { label: 'Insights', base: 'insights', icon: <BarChart3 className="w-4 h-4" /> },
];

interface SubItem {
  label: string;
  path: string; // relative to property root
  match: (pathname: string, search: string) => boolean;
  /** When set, only these roles see the entry. */
  roles?: string[];
}

/** Contextual secondary navigation per primary destination. */
function subNavFor(base: string): SubItem[] {
  const tabMatch = (t: string) => (_p: string, s: string) =>
    new URLSearchParams(s).get('tab') === t;
  switch (base) {
    case 'workforce':
      return [
        { label: 'Dashboard', path: 'workforce/dashboard', match: (p) => p.includes('/workforce/dashboard') },
        { label: 'Employees', path: 'workforce/employees', match: (p) =>
            p.includes('/workforce/employees') && !p.includes('/workforce/employees/') },
        { label: 'Departments', path: 'workforce/departments', match: (p) => p.includes('/workforce/departments') },
        { label: 'Salaries', path: 'workforce/salaries', match: (p) => p.includes('/workforce/salaries'),
          roles: ['super_admin', 'human_resource'] },
      ];
    case 'property':
      return [
        { label: 'Zones & Areas', path: 'property/spaces/zones', match: (p) => p.includes('/spaces/zones') },
        { label: 'Units', path: 'property/spaces/units', match: (p) => p.includes('/spaces/units') },
        { label: 'Video Monitoring', path: 'property/video', match: (p) => p.includes('/property/video') },
      ];
    case 'operations':
      return [
        { label: 'Tasks', path: 'operations/tasks', match: (p, s) =>
            p.includes('/operations/tasks') && !s.includes('tab=') },
        { label: 'Abandoned', path: 'operations/tasks?tab=abandoned', match: tabMatch('abandoned') },
        { label: 'Reviews', path: 'operations/tasks?tab=review', match: tabMatch('review') },
        { label: 'Maintenance', path: 'operations/tasks?tab=maintenance', match: tabMatch('maintenance') },
        { label: 'Templates', path: 'operations/tasks?tab=templates', match: tabMatch('templates') },
        { label: 'History', path: 'operations/tasks?tab=history', match: (p, s) =>
            tabMatch('history')(p, s) || p.includes('/operations/history') },
        { label: 'Calendar', path: 'operations/tasks?tab=calendar', match: tabMatch('calendar') },
      ];
    case 'insights':
      return [
        { label: 'Overview', path: 'insights', match: (p) => p.endsWith('/insights') },
        { label: 'Activity & Audit', path: 'insights/audit', match: (p) => p.includes('/insights/audit') },
      ];
    default:
      return [];
  }
}

const SECTION_LABELS: Record<string, string> = {
  overview: 'Dashboard',
  workforce: 'Workforce',
  dashboard: 'Dashboard',
  employees: 'Employees',
  departments: 'Departments',
  property: 'Property',
  spaces: 'Spaces',
  zones: 'Zones & Areas',
  units: 'Units',
  video: 'Video Monitoring',
  operations: 'Operations',
  tasks: 'Tasks',
  history: 'History',
  insights: 'Insights',
  audit: 'Activity & Audit',
  profile: 'Profile',
  admin: 'Administration',
  properties: 'Properties',
  settings: 'Settings',
  logs: 'Logs',
};

/** Path-derived breadcrumbs for the content area. */
const Breadcrumbs: React.FC<{ propertyRoot: string }> = ({ propertyRoot }) => {
  const location = useLocation();
  const { currentPropertyEmployees, navigate } = useApp();
  // The property is already shown in the header selector, so the trail starts
  // at the section: /property/:uid/workforce/employees/:id → Workforce / Employees / …
  const segs = location.pathname
    .slice(propertyRoot.length)
    .split('/')
    .filter(Boolean);

  const crumbs: { label: string; rel: string }[] = [];
  let acc = '';
  for (const seg of segs) {
    acc += `/${seg}`;
    let label = SECTION_LABELS[seg];
    if (!label) {
      if (currentPropertyEmployees.some((e) => e.employee_uid === seg)) {
        label = currentPropertyEmployees.find((e) => e.employee_uid === seg)?.name || 'Employee';
      } else label = 'Detail';
    }
    crumbs.push({ label, rel: acc });
  }
  if (crumbs.length <= 1) return null;
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-[12px] text-[#8C867C] px-4 sm:px-6 lg:px-8 pt-3">
      {crumbs.map((c, i) => (
        <React.Fragment key={c.rel}>
          {i > 0 && <ChevronRight className="w-3 h-3 text-[#C9C2B8]" />}
          {i === crumbs.length - 1 ? (
            <span className="font-medium text-[#4E493F]">{c.label}</span>
          ) : (
            <button type="button" onClick={() => navigate(`${propertyRoot}${c.rel}`)} className="hover:text-[#386641] cursor-pointer">
              {c.label}
            </button>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
};

export const Header: React.FC = () => {
  const {
    currentUser,
    currentRole,
    activeProperty,
    activePropertyUid,
    companyProperties,
    currentPath,
    navigate,
    logout,
    setActivePropertyUid,
  } = useApp();
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [propMenuOpen, setPropMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const propMenuRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (propMenuRef.current && !propMenuRef.current.contains(e.target as Node)) setPropMenuOpen(false);
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setUserMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const inProperty = currentPath.startsWith(`/property/${activePropertyUid}`) && !!activePropertyUid;
  const isSA = currentRole === 'super_admin';

  // active primary destination derived from the URL
  const activeBase = useMemo(() => {
    if (!inProperty) return '';
    const rest = currentPath.slice(`/property/${activePropertyUid}/`.length);
    const first = rest.split('/')[0];
    return PRIMARY_ITEMS.some((i) => i.base === first) ? first : '';
  }, [currentPath, inProperty, activePropertyUid]);

  const subItems = subNavFor(activeBase).filter(
    (s) => !s.roles || (currentUser ? s.roles.includes(currentUser.role) : false)
  );
  const propertyRoot = `/property/${activePropertyUid}`;

  const switchProperty = (uid: string) => {
    setActivePropertyUid(uid);
    navigate(`/property/${uid}/overview`);
    setPropMenuOpen(false);
    setMobileMenuOpen(false);
  };

  return (
    <header className="bg-[#FFFFFF] border-b border-[#EAE5DC] sticky top-0 z-40">
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-14">
          {/* Brand + property selector */}
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="flex items-center gap-2 cursor-pointer select-none"
              onClick={() => navigate(isSA ? '/admin/properties' : `${propertyRoot}/overview`)}
            >
              <div className="w-8 h-8 rounded-[10px] bg-[#386641] flex items-center justify-center text-white font-display font-bold text-[11px] tracking-tight">
                AR
              </div>
              <span className="font-display font-bold text-[15px] text-[#24221F] leading-tight tracking-tight hidden sm:block">
                AiROS
              </span>
            </div>

            {/* Property selector */}
            {activeProperty && (
              <div className="relative" ref={propMenuRef}>
                <button
                  onClick={() => isSA && setPropMenuOpen((v) => !v)}
                  className={`flex items-center gap-1.5 pl-2.5 pr-2 py-1.5 rounded-[9px] border text-[12.5px] font-medium max-w-[190px] sm:max-w-[260px] ${
                    isSA
                      ? 'border-[#E2DCD1] bg-[#FAF8F4] text-[#35322E] hover:bg-[#F1EDE4] cursor-pointer'
                      : 'border-transparent bg-transparent text-[#4E493F] cursor-default'
                  }`}
                  title={isSA ? 'Switch property' : 'Current property'}
                >
                  <Building2 className="w-3.5 h-3.5 text-[#386641] shrink-0" />
                  <span className="truncate">{activeProperty.name}</span>
                  {isSA && <ChevronDown className="w-3.5 h-3.5 text-[#8C867C] shrink-0" />}
                </button>
                {propMenuOpen && isSA && (
                  <div className="absolute left-0 mt-1.5 w-64 bg-white border border-[#E5DFD4] rounded-[12px] shadow-lg py-1.5 z-50 max-h-72 overflow-auto">
                    {companyProperties.map((p) => (
                      <button
                        key={p.property_uid}
                        onClick={() => switchProperty(p.property_uid)}
                        className={`w-full text-left px-3.5 py-2 text-[13px] cursor-pointer hover:bg-[#F6F3EE] ${
                          p.property_uid === activePropertyUid
                            ? 'text-[#244E2C] font-semibold bg-[#EBF3EC]'
                            : 'text-[#35322E]'
                        }`}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Primary navigation — desktop */}
          {inProperty && (
            <nav className="hidden md:flex items-center gap-0.5">
              {PRIMARY_ITEMS.map((item) => {
                const active = activeBase === item.base;
                return (
                  <button
                    key={item.base}
                    onClick={() => navigate(`${propertyRoot}/${item.base}`)}
                    className={`px-3 py-1.5 rounded-[9px] text-[13px] font-medium transition-colors cursor-pointer inline-flex items-center gap-1.5 ${
                      active
                        ? 'bg-[#EBF3EC] text-[#244E2C] font-semibold'
                        : 'text-[#58534C] hover:text-[#24221F] hover:bg-[#F6F3EE]'
                    }`}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          )}

          {/* Right cluster */}
          <div className="hidden md:flex items-center gap-2.5">
            <ISTClock />
            {currentUser && (
              <div className="relative" ref={userMenuRef}>
                <button
                  onClick={() => setUserMenuOpen((v) => !v)}
                  className="flex items-center gap-2 pl-2 border-l border-[#EAE5DC] cursor-pointer"
                >
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-white"
                    style={{ backgroundColor: isSA ? '#24221F' : '#386641' }}
                  >
                    {getInitials(currentUser.name)}
                  </div>
                  <ChevronDown className="w-3.5 h-3.5 text-[#8C867C]" />
                </button>
                {userMenuOpen && (
                  <div className="absolute right-0 mt-1.5 w-56 bg-white border border-[#E5DFD4] rounded-[12px] shadow-lg py-1.5 z-50">
                    <div className="px-3.5 py-2 border-b border-[#F0ECE4]">
                      <p className="text-[13px] font-semibold text-[#24221F]">{currentUser.name}</p>
                      <p className="text-[11px] text-[#78736A] capitalize">{currentUser.role.replace('_', ' ')}</p>
                    </div>
                    {activePropertyUid && (
                      <button
                        onClick={() => { navigate(`${propertyRoot}/profile`); setUserMenuOpen(false); }}
                        className="w-full text-left px-3.5 py-2 text-[13px] text-[#35322E] hover:bg-[#F6F3EE] cursor-pointer flex items-center gap-2"
                      >
                        <Settings className="w-3.5 h-3.5 text-[#8C867C]" /> Profile
                      </button>
                    )}
                    {isSA && (
                      <div className="border-t border-[#F0ECE4] mt-1 pt-1">
                        <p className="px-3.5 pt-1 pb-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-[#A59F95] flex items-center gap-1">
                          <Shield className="w-3 h-3" /> Administration
                        </p>
                        {[
                          { label: 'Properties', path: '/admin/properties' },
                          { label: 'Settings', path: '/admin/settings' },
                          { label: 'Logs', path: '/admin/logs' },
                        ].map((l) => (
                          <button
                            key={l.path}
                            onClick={() => { navigate(l.path); setUserMenuOpen(false); }}
                            className="w-full text-left px-3.5 py-2 text-[13px] text-[#35322E] hover:bg-[#F6F3EE] cursor-pointer"
                          >
                            {l.label}
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      onClick={() => { setUserMenuOpen(false); logout(); }}
                      className="w-full text-left px-3.5 py-2 text-[13px] text-[#A82828] hover:bg-[#FDE8E8] cursor-pointer flex items-center gap-2 border-t border-[#F0ECE4] mt-1 pt-2"
                    >
                      <LogOut className="w-3.5 h-3.5" /> Logout
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Mobile hamburger */}
          <div className="flex md:hidden items-center gap-2">
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="p-2 rounded-[8px] text-[#58534C] hover:bg-[#F5F2EB] cursor-pointer"
              aria-label="Toggle navigation"
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {/* Contextual secondary navigation */}
        {inProperty && subItems.length > 0 && (
          <nav className="hidden md:flex items-center gap-0.5 -mb-px border-t border-[#F4F0E8] overflow-x-auto">
            {subItems.map((item) => {
              const active = item.match(currentPath, location.search);
              return (
                <button
                  key={item.path}
                  onClick={() => navigate(`${propertyRoot}/${item.path}`)}
                  className={`px-3 py-2 text-[12.5px] whitespace-nowrap border-b-2 transition-colors cursor-pointer ${
                    active
                      ? 'border-[#386641] text-[#244E2C] font-semibold'
                      : 'border-transparent text-[#736E65] hover:text-[#24221F]'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>
        )}
      </div>

      {/* Mobile drawer */}
      {mobileMenuOpen && (
        <div className="md:hidden border-t border-[#EAE5DC] bg-[#FFFFFF] px-4 pt-3 pb-5 space-y-1 animate-in slide-in-from-top-2">
          {inProperty &&
            PRIMARY_ITEMS.map((item) => (
              <div key={item.base}>
                <button
                  onClick={() => { navigate(`${propertyRoot}/${item.base}`); }}
                  className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-[10px] text-sm font-medium text-[#35322E] hover:bg-[#F5F2EB] text-left cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    {item.icon}
                    <span>{item.label}</span>
                  </div>
                  <ChevronRight className="w-4 h-4 text-[#A59F95]" />
                </button>
                {activeBase === item.base &&
                  subNavFor(item.base).filter(
                    (s) => !s.roles || (currentUser ? s.roles.includes(currentUser.role) : false)
                  ).map((s) => (
                    <button
                      key={s.path}
                      onClick={() => { navigate(`${propertyRoot}/${s.path}`); setMobileMenuOpen(false); }}
                      className="w-full text-left pl-11 pr-3 py-1.5 text-[13px] text-[#6C675F] hover:text-[#244E2C] cursor-pointer"
                    >
                      {s.label}
                    </button>
                  ))}
              </div>
            ))}

          {isSA && (
            <div className="pt-2 border-t border-[#F0ECE4]">
              <p className="px-3.5 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[#A59F95]">
                Administration
              </p>
              {[
                { label: 'Properties', path: '/admin/properties' },
                { label: 'Settings', path: '/admin/settings' },
                { label: 'Logs', path: '/admin/logs' },
              ].map((l) => (
                <button
                  key={l.path}
                  onClick={() => { navigate(l.path); setMobileMenuOpen(false); }}
                  className="w-full text-left px-3.5 py-2 text-sm text-[#35322E] hover:bg-[#F5F2EB] rounded-[10px] cursor-pointer"
                >
                  {l.label}
                </button>
              ))}
            </div>
          )}

          <div className="pt-3 border-t border-[#F0ECE4] flex items-center justify-between">
            <button
              onClick={() => { if (activePropertyUid) navigate(`${propertyRoot}/profile`); setMobileMenuOpen(false); }}
              className="flex items-center gap-2 cursor-pointer"
            >
              <div className="w-8 h-8 rounded-full bg-[#386641] text-white flex items-center justify-center text-xs font-semibold">
                {getInitials(currentUser?.name || 'User')}
              </div>
              <div className="text-left">
                <p className="text-xs font-semibold text-[#24221F]">{currentUser?.name}</p>
                <p className="text-[11px] text-[#78736A] capitalize">{currentUser?.role.replace('_', ' ')}</p>
              </div>
            </button>
            <button
              onClick={() => { logout(); setMobileMenuOpen(false); }}
              className="p-2 text-[#A82828] hover:bg-[#FDE8E8] rounded-lg transition-colors cursor-pointer"
              title="Logout"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Breadcrumbs for property-scoped pages */}
      {inProperty && <Breadcrumbs propertyRoot={propertyRoot} />}
    </header>
  );
};
