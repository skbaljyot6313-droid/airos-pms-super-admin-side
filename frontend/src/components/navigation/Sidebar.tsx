import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Boxes,
  Bed,
  Cctv,
  ClipboardList,
  Wrench,
  Users,
  Network,
  CalendarCheck,
  CalendarDays,
  Wallet,
  ScrollText,
  Building2,
  Settings,
  CircleUserRound,
  ChevronsLeft,
  ChevronsRight,
  ChevronDown,
  Check,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { cn } from '../../lib/utils';

const COLLAPSED_KEY = 'airos_sa_nav_collapsed';

interface NavItem {
  label: string;
  /** Path relative to the property root, or absolute when `absolute`. */
  path: string;
  icon: React.ReactNode;
  absolute?: boolean;
  roles?: string[];
  /** Extra matcher beyond prefix — used for tab-pinned links. */
  active?: (pathname: string, search: string) => boolean;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

function tabIs(search: string, t: string) {
  return new URLSearchParams(search).get('tab') === t;
}

function buildGroups(): NavGroup[] {
  return [
    {
      title: 'Workspace',
      items: [
        {
          label: 'Overview',
          path: 'overview',
          icon: <LayoutDashboard className="w-[18px] h-[18px]" />,
          active: (p) => p.endsWith('/overview'),
        },
        {
          label: 'Spaces',
          path: 'property/spaces/zones',
          icon: <Boxes className="w-[18px] h-[18px]" />,
          active: (p) =>
            p.includes('/property/spaces') && !p.includes('/property/spaces/units'),
        },
        {
          label: 'Stay Units',
          path: 'property/spaces/units',
          icon: <Bed className="w-[18px] h-[18px]" />,
          active: (p) => p.includes('/property/spaces/units'),
        },
        {
          label: 'Video',
          path: 'property/video',
          icon: <Cctv className="w-[18px] h-[18px]" />,
          roles: ['super_admin', 'property_manager'],
          active: (p) => p.includes('/property/video'),
        },
      ],
    },
    {
      title: 'Operations',
      items: [
        {
          label: 'Tasks',
          path: 'operations/tasks',
          icon: <ClipboardList className="w-[18px] h-[18px]" />,
          active: (p, s) =>
            (p.includes('/operations/tasks') &&
              !tabIs(s, 'maintenance') &&
              !tabIs(s, 'templates')) ||
            p.includes('/operations/history/tasks'),
        },
        {
          label: 'Maintenance',
          path: 'operations/tasks?tab=maintenance',
          icon: <Wrench className="w-[18px] h-[18px]" />,
          active: (p, s) =>
            tabIs(s, 'maintenance') || p.includes('/operations/history/maintenance'),
        },
        {
          label: 'Calendar',
          path: 'operations/calendar',
          icon: <CalendarDays className="w-[18px] h-[18px]" />,
          active: (p) => p.includes('/operations/calendar'),
        },
      ],
    },
    {
      title: 'Workforce',
      items: [
        {
          label: 'Employees',
          path: 'workforce/employees',
          icon: <Users className="w-[18px] h-[18px]" />,
          active: (p) =>
            p.includes('/workforce/employees') || p.includes('/workforce/dashboard'),
        },
        {
          label: 'Departments',
          path: 'workforce/departments',
          icon: <Network className="w-[18px] h-[18px]" />,
          active: (p) => p.includes('/workforce/departments'),
        },
        {
          label: 'Attendance',
          path: 'workforce/employees?tab=attendance',
          icon: <CalendarCheck className="w-[18px] h-[18px]" />,
          active: (p, s) => p.includes('/workforce/employees') && tabIs(s, 'attendance'),
        },
        {
          label: 'Payroll',
          path: 'workforce/salaries',
          icon: <Wallet className="w-[18px] h-[18px]" />,
          roles: ['super_admin', 'human_resource'],
          active: (p) => p.includes('/workforce/salaries'),
        },
      ],
    },
  ];
}

const ADMIN_ITEMS: NavItem[] = [
  {
    label: 'Properties',
    path: '/admin/properties',
    icon: <Building2 className="w-[18px] h-[18px]" />,
    absolute: true,
    roles: ['super_admin'],
    active: (p) => p === '/admin/properties',
  },
  {
    label: 'Settings',
    path: '/admin/settings',
    icon: <Settings className="w-[18px] h-[18px]" />,
    absolute: true,
    roles: ['super_admin'],
    active: (p) => p === '/admin/settings',
  },
  {
    label: 'Activity logs',
    path: '/admin/logs',
    icon: <ScrollText className="w-[18px] h-[18px]" />,
    absolute: true,
    roles: ['super_admin'],
    active: (p) => p === '/admin/logs',
  },
];

const PropertySwitcher: React.FC<{ collapsed: boolean }> = ({ collapsed }) => {
  const { activeProperty, activePropertyUid, companyProperties, currentRole, navigate, setActivePropertyUid } =
    useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const canSwitch = currentRole === 'super_admin' && companyProperties.length > 1;

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  if (!activeProperty) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => canSwitch && setOpen((v) => !v)}
        title={activeProperty.name}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg border border-line bg-canvas px-2.5 py-2 text-left',
          canSwitch && 'cursor-pointer hover:bg-hover',
          collapsed && 'justify-center px-0 border-transparent bg-transparent'
        )}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand-ink">
          <Building2 className="h-4 w-4" />
        </span>
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
              {activeProperty.name}
            </span>
            {canSwitch && <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-3" />}
          </>
        )}
      </button>
      {open && canSwitch && (
        <div className="absolute left-0 top-full z-50 mt-1.5 w-60 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-lg">
          {companyProperties.map((p) => (
            <button
              key={p.property_uid}
              onClick={() => {
                setActivePropertyUid(p.property_uid);
                navigate(`/property/${p.property_uid}/overview`);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-[13px] text-ink hover:bg-hover"
            >
              <span className="truncate">{p.name}</span>
              {p.property_uid === activePropertyUid && <Check className="h-3.5 w-3.5 text-brand" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export const Sidebar: React.FC<{ mobileOpen: boolean; onCloseMobile: () => void }> = ({
  mobileOpen,
  onCloseMobile,
}) => {
  const {
    currentRole,
    currentUser,
    activePropertyUid,
    currentPath,
    navigate,
  } = useApp();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== 'undefined' && localStorage.getItem(COLLAPSED_KEY) === '1'
  );

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      localStorage.setItem(COLLAPSED_KEY, v ? '0' : '1');
      return !v;
    });
  };

  const inProperty = !!activePropertyUid;
  const propertyRoot = `/property/${activePropertyUid}`;
  const groups = useMemo(buildGroups, []);
  const role = currentUser?.role ?? currentRole;

  const visible = (item: NavItem) => !item.roles || (role ? item.roles.includes(role) : false);
  const go = (item: NavItem) => {
    navigate(item.absolute ? item.path : `${propertyRoot}/${item.path}`);
    onCloseMobile();
  };

  const body = (
    <div className="flex h-full flex-col">
      {/* Brand + property */}
      <div className={cn('space-y-3 px-3 pb-3 pt-4', collapsed && 'px-2')}>
        <div className={cn('flex items-center gap-2.5', collapsed && 'justify-center')}>
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand font-display text-[12px] font-extrabold tracking-tight text-white">
            AR
          </div>
          {!collapsed && (
            <span className="font-display text-[15px] font-bold tracking-tight text-ink">AiROS</span>
          )}
        </div>
        {inProperty && <PropertySwitcher collapsed={collapsed} />}
      </div>

      {/* Nav groups */}
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-4 pt-1">
        {inProperty &&
          groups.map((group) => {
            const items = group.items.filter(visible);
            if (!items.length) return null;
            return (
              <div key={group.title}>
                {!collapsed && (
                  <p className="px-2 pb-1.5 text-micro font-semibold uppercase tracking-[0.08em] text-ink-3">
                    {group.title}
                  </p>
                )}
                <div className="space-y-0.5">
                  {items.map((item) => {
                    const active = item.active
                      ? item.active(currentPath, location.search)
                      : currentPath.includes(item.path);
                    return (
                      <button
                        key={item.path}
                        type="button"
                        onClick={() => go(item)}
                        title={collapsed ? item.label : undefined}
                        className={cn(
                          'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors',
                          collapsed && 'justify-center px-0',
                          active
                            ? 'bg-brand-soft font-semibold text-brand-ink'
                            : 'font-medium text-ink-2 hover:bg-hover hover:text-ink'
                        )}
                      >
                        <span className={cn('shrink-0', active ? 'text-brand-ink' : 'text-ink-3')}>
                          {item.icon}
                        </span>
                        {!collapsed && <span className="truncate">{item.label}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
      </nav>

      {/* Bottom */}
      <div className="space-y-0.5 border-t border-line px-3 py-3">
        {ADMIN_ITEMS.filter(visible).map((item) => {
          const active = item.active ? item.active(currentPath, location.search) : false;
          return (
            <button
              key={item.path}
              type="button"
              onClick={() => go(item)}
              title={collapsed ? item.label : undefined}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors',
                collapsed && 'justify-center px-0',
                active
                  ? 'bg-brand-soft font-semibold text-brand-ink'
                  : 'font-medium text-ink-2 hover:bg-hover hover:text-ink'
              )}
            >
              <span className={cn('shrink-0', active ? 'text-brand-ink' : 'text-ink-3')}>
                {item.icon}
              </span>
              {!collapsed && <span className="truncate">{item.label}</span>}
            </button>
          );
        })}
        {inProperty && (
          <button
            type="button"
            onClick={() => go({ label: 'Profile', path: 'profile', icon: null })}
            title={collapsed ? 'Profile' : undefined}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors',
              collapsed && 'justify-center px-0',
              currentPath.endsWith('/profile')
                ? 'bg-brand-soft font-semibold text-brand-ink'
                : 'font-medium text-ink-2 hover:bg-hover hover:text-ink'
            )}
          >
            <span
              className={cn(
                'shrink-0',
                currentPath.endsWith('/profile') ? 'text-brand-ink' : 'text-ink-3'
              )}
            >
              <CircleUserRound className="w-[18px] h-[18px]" />
            </span>
            {!collapsed && <span className="truncate">Profile</span>}
          </button>
        )}
        <button
          type="button"
          onClick={toggleCollapsed}
          className="hidden w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12px] font-medium text-ink-3 transition-colors hover:bg-hover hover:text-ink lg:flex"
          style={collapsed ? { justifyContent: 'center', paddingLeft: 0, paddingRight: 0 } : undefined}
        >
          {collapsed ? (
            <ChevronsRight className="h-4 w-4 shrink-0" />
          ) : (
            <>
              <ChevronsLeft className="h-4 w-4 shrink-0" />
              <span>Collapse</span>
            </>
          )}
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop rail */}
      <aside
        className={cn(
          'sticky top-0 hidden h-screen shrink-0 border-r border-line bg-surface transition-[width] duration-200 lg:block',
          collapsed ? 'w-[64px]' : 'w-[232px]'
        )}
      >
        {body}
      </aside>

      {/* Mobile slide-over */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-ink/40" onClick={onCloseMobile} />
          <aside className="absolute left-0 top-0 h-full w-[264px] border-r border-line bg-surface shadow-xl">
            <button
              type="button"
              onClick={onCloseMobile}
              aria-label="Close navigation"
              className="absolute right-3 top-4 rounded-md p-1.5 text-ink-3 hover:bg-hover"
            >
              <X className="h-4 w-4" />
            </button>
            {body}
          </aside>
        </div>
      )}
    </>
  );
};

/** Shared by the command menu + header search — the flattened nav surface. */
export function useNavDestinations() {
  const { activePropertyUid, currentUser, currentRole, companyProperties } = useApp();
  const role = currentUser?.role ?? currentRole;
  return useMemo(() => {
    const root = `/property/${activePropertyUid}`;
    const all: { label: string; path: string; group: string }[] = [];
    if (activePropertyUid) {
      for (const g of buildGroups())
        for (const i of g.items)
          if (!i.roles || (role && i.roles.includes(role)))
            all.push({ label: i.label, path: `${root}/${i.path}`, group: g.title });
      all.push({ label: 'Profile', path: `${root}/profile`, group: 'Account' });
    }
    for (const i of ADMIN_ITEMS)
      if (!i.roles || (role && i.roles.includes(role)))
        all.push({ label: i.label, path: i.path, group: 'Administration' });
    const props = companyProperties.map((p) => ({
      label: `Switch to ${p.name}`,
      path: `/property/${p.property_uid}/overview`,
      group: 'Properties',
    }));
    return [...all, ...props];
  }, [activePropertyUid, role, companyProperties]);
}
