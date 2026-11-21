import React, { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  ChevronDown,
  ChevronRight,
  Clock,
  LogOut,
  Menu,
  Search,
  Settings,
  Shield,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { getInitials } from '../../lib/utils';
import { CommandMenu } from './CommandMenu';

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
      className="hidden xl:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-canvas border border-line text-ink-2"
      title="Indian Standard Time"
    >
      <Clock className="w-3.5 h-3.5 text-brand-ink" />
      <span className="font-num text-[12.5px] font-semibold tracking-tight">
        {time.replace(/\s+/g, ' ')}
      </span>
      <span className="text-[10px] font-medium text-ink-3">IST</span>
    </div>
  );
};

const SECTION_LABELS: Record<string, string> = {
  overview: 'Overview',
  workforce: 'Workforce',
  dashboard: 'Dashboard',
  employees: 'Employees',
  departments: 'Departments',
  salaries: 'Payroll',
  property: 'Property',
  spaces: 'Spaces',
  zones: 'Zones',
  units: 'Units',
  video: 'Video',
  operations: 'Operations',
  tasks: 'Tasks',
  history: 'History',
  insights: 'Insights',
  audit: 'Activity logs',
  profile: 'Profile',
  admin: 'Administration',
  properties: 'Properties',
  settings: 'Settings',
  logs: 'Logs',
};

/** Path-derived breadcrumbs. */
const Breadcrumbs: React.FC = () => {
  const location = useLocation();
  const { currentPropertyEmployees, activePropertyUid, navigate } = useApp();
  const propertyRoot = `/property/${activePropertyUid}`;

  let crumbs: { label: string; rel: string }[] = [];
  if (location.pathname.startsWith('/admin')) {
    crumbs = location.pathname
      .split('/')
      .filter(Boolean)
      .map((seg, i, arr) => ({
        label: SECTION_LABELS[seg] ?? seg,
        rel: '/' + arr.slice(0, i + 1).join('/'),
      }));
  } else if (location.pathname.startsWith(`${propertyRoot}/`)) {
    const segs = location.pathname.slice(propertyRoot.length).split('/').filter(Boolean);
    let acc = '';
    for (const seg of segs) {
      acc += `/${seg}`;
      let label = SECTION_LABELS[seg];
      if (!label) {
        label =
          currentPropertyEmployees.find((e) => e.employee_uid === seg)?.name ??
          'Detail';
      }
      crumbs.push({ label, rel: `${propertyRoot}${acc}` });
    }
  }
  if (crumbs.length <= 1) return null;
  return (
    <nav aria-label="Breadcrumb" className="hidden md:flex items-center gap-1 text-[12px] text-ink-3 min-w-0">
      {crumbs.map((c, i) => (
        <React.Fragment key={c.rel}>
          {i > 0 && <ChevronRight className="w-3 h-3 text-line-strong shrink-0" />}
          {i === crumbs.length - 1 ? (
            <span className="font-semibold text-ink truncate">{c.label}</span>
          ) : (
            <button
              type="button"
              onClick={() => navigate(c.rel)}
              className="hover:text-ink cursor-pointer truncate"
            >
              {c.label}
            </button>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
};

export const Header: React.FC<{ onOpenMobileNav: () => void }> = ({ onOpenMobileNav }) => {
  const { currentUser, currentRole, activePropertyUid, navigate, logout } = useApp();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const isSA = currentRole === 'super_admin';
  const propertyRoot = `/property/${activePropertyUid}`;

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node))
        setUserMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  return (
    <>
      <header className="sticky top-0 z-40 flex h-12 items-center gap-3 border-b border-line bg-surface px-3 sm:px-4">
        {/* Mobile nav trigger */}
        <button
          type="button"
          onClick={onOpenMobileNav}
          aria-label="Open navigation"
          className="rounded-md p-1.5 text-ink-2 hover:bg-hover lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>

        <Breadcrumbs />

        <div className="flex-1" />

        {/* Command menu trigger */}
        <button
          type="button"
          onClick={() =>
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
          }
          className="hidden sm:flex items-center gap-2 rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-[12px] text-ink-3 hover:bg-hover"
        >
          <Search className="h-3.5 w-3.5" />
          <span>Search</span>
          <kbd className="rounded border border-line bg-surface px-1 text-[10px] font-medium">Ctrl K</kbd>
        </button>

        <ISTClock />

        {currentUser && (
          <div className="relative" ref={userMenuRef}>
            <button
              onClick={() => setUserMenuOpen((v) => !v)}
              className="flex items-center gap-1.5 cursor-pointer"
            >
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-brand text-[11px] font-semibold text-white">
                {getInitials(currentUser.name)}
              </div>
              <ChevronDown className="h-3.5 w-3.5 text-ink-3" />
            </button>
            {userMenuOpen && (
              <div className="absolute right-0 top-full z-50 mt-1.5 w-56 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-lg">
                <div className="border-b border-line px-3.5 py-2">
                  <p className="text-[13px] font-semibold text-ink">{currentUser.name}</p>
                  <p className="text-[11px] text-ink-2 capitalize">{currentUser.role.replace('_', ' ')}</p>
                </div>
                {activePropertyUid && (
                  <button
                    onClick={() => {
                      navigate(`${propertyRoot}/profile`);
                      setUserMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-[13px] text-ink-2 hover:bg-hover"
                  >
                    <Settings className="h-3.5 w-3.5 text-ink-3" /> Profile
                  </button>
                )}
                {isSA && (
                  <div className="mt-1 border-t border-line pt-1">
                    <p className="flex items-center gap-1 px-3.5 pb-0.5 pt-1 text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
                      <Shield className="h-3 w-3" /> Administration
                    </p>
                    {[
                      { label: 'Properties', path: '/admin/properties' },
                      { label: 'Settings', path: '/admin/settings' },
                      { label: 'Logs', path: '/admin/logs' },
                    ].map((l) => (
                      <button
                        key={l.path}
                        onClick={() => {
                          navigate(l.path);
                          setUserMenuOpen(false);
                        }}
                        className="block w-full px-3.5 py-2 text-left text-[13px] text-ink-2 hover:bg-hover"
                      >
                        {l.label}
                      </button>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => {
                    setUserMenuOpen(false);
                    logout();
                  }}
                  className="mt-1 flex w-full items-center gap-2 border-t border-line px-3.5 py-2 pt-2.5 text-left text-[13px] text-danger-ink hover:bg-danger-soft"
                >
                  <LogOut className="h-3.5 w-3.5" /> Logout
                </button>
              </div>
            )}
          </div>
        )}
      </header>
      <CommandMenu />
    </>
  );
};
