import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { perfLog } from './dev/perf';
import { AppProvider, useApp } from './context/AppContext';
import { SessionProvider } from './context/SessionContext';
import { Header } from './components/navigation/Header';
import { ToastContainer } from './components/ui/ToastContainer';
import { Skeleton } from './components/ui/Skeleton';
import { Card } from './components/ui/Card';
import { Button } from './components/ui/Button';
import { AlertTriangle } from 'lucide-react';
import { LandingPage } from './components/landing/LandingPage';
import { Login } from './components/auth/Login';
import { Signup } from './components/auth/Signup';

// Route-level code splitting — heavy workspace views load on demand,
// so the first screen doesn't wait for the entire bundle.
const PropertiesView = React.lazy(() =>
  import('./components/properties/PropertiesView').then((m) => ({ default: m.PropertiesView }))
);
const ZonesView = React.lazy(() =>
  import('./components/zones/ZonesView').then((m) => ({ default: m.ZonesView }))
);
const RoomsDormsView = React.lazy(() =>
  import('./components/rooms/RoomsDormsView').then((m) => ({ default: m.RoomsDormsView }))
);
const EmployeesView = React.lazy(() =>
  import('./components/employees/EmployeesView').then((m) => ({ default: m.EmployeesView }))
);
const SalariesView = React.lazy(() =>
  import('./components/payroll/SalariesView').then((m) => ({ default: m.SalariesView }))
);
const EmployeeDetailView = React.lazy(() =>
  import('./components/employees/EmployeeDetailView').then((m) => ({ default: m.EmployeeDetailView }))
);
const EmployeeDashboard = React.lazy(() =>
  import('./components/employees/management/EmployeeDashboard').then((m) => ({ default: m.EmployeeDashboard }))
);
const DepartmentsView = React.lazy(() =>
  import('./components/employees/management/DepartmentsView').then((m) => ({ default: m.DepartmentsView }))
);
const DepartmentDetailView = React.lazy(() =>
  import('./components/employees/management/DepartmentDetailView').then((m) => ({ default: m.DepartmentDetailView }))
);
const TasksView = React.lazy(() =>
  import('./components/tasks/TasksView').then((m) => ({ default: m.TasksView }))
);
const TaskDayAnalysisView = React.lazy(() =>
  import('./components/tasks/TaskDayAnalysisView').then((m) => ({ default: m.TaskDayAnalysisView }))
);
const MaintenanceDayAnalysisView = React.lazy(() =>
  import('./components/maintenance/MaintenanceDayAnalysisView').then((m) => ({ default: m.MaintenanceDayAnalysisView }))
);
const ProfileView = React.lazy(() =>
  import('./components/profile/ProfileView').then((m) => ({ default: m.ProfileView }))
);
const VaView = React.lazy(() =>
  import('./components/va/VaView').then((m) => ({ default: m.VaView }))
);
const AdminSettingsView = React.lazy(() =>
  import('./components/admin/AdminSettingsView').then((m) => ({ default: m.AdminSettingsView }))
);
const LogsView = React.lazy(() =>
  import('./components/admin/LogsView').then((m) => ({ default: m.LogsView }))
);
const DashboardView = React.lazy(() =>
  import('./components/dashboard/DashboardView').then((m) => ({ default: m.DashboardView }))
);
const InsightsView = React.lazy(() =>
  import('./components/insights/InsightsView').then((m) => ({ default: m.InsightsView }))
);

/**
 * Route guard: unauthenticated visitors can never reach internal screens.
 */
const RequireAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated } = useApp();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
};

/**
 * Wraps authenticated screens with workspace data states — loading skeleton
 * while collections load, a retryable error state if the API is unreachable,
 * and the real view otherwise. Never renders fabricated data.
 */
const WorkspaceGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isLoadingData, dataError, retryLoad, properties } = useApp();

  if (dataError) {
    return (
      <Card className="p-10 max-w-lg mx-auto text-center mt-10">
        <div className="w-12 h-12 rounded-full bg-[#FDE8E8] text-[#A32A2A] flex items-center justify-center mx-auto mb-3">
          <AlertTriangle className="w-6 h-6" />
        </div>
        <h2 className="font-display font-semibold text-lg text-[#24221F]">
          Unable to load workspace data
        </h2>
        <p className="font-body text-sm text-[#6C675F] mt-1.5 mb-5">{dataError}</p>
        <Button variant="primary" onClick={retryLoad}>
          Retry
        </Button>
      </Card>
    );
  }

  if (isLoadingData && properties.length === 0) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-72" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-44 w-full rounded-[16px]" />
          ))}
        </div>
      </div>
    );
  }

  return <>{children}</>;
};

/**
 * Handles property-scoped views while ensuring activePropertyUid is synchronized
 */
const PropertyScopedView: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { propertyUid } = useParams<{ propertyUid: string }>();
  const { activePropertyUid, setActivePropertyUid, companyProperties, currentRole, currentUser } =
    useApp();

  useEffect(() => {
    if (propertyUid && propertyUid !== activePropertyUid) {
      if (companyProperties.some((p) => p.property_uid === propertyUid)) {
        setActivePropertyUid(propertyUid);
      }
    }
  }, [propertyUid, activePropertyUid, companyProperties, setActivePropertyUid]);

  if (currentRole === 'employee' || currentRole === 'human_resource' || currentRole === 'department_manager') {
    return <Navigate to="/" replace />;
  }

  // Property Managers are scoped to their single assigned property
  if (
    currentRole === 'property_manager' &&
    currentUser?.property_uid &&
    propertyUid !== currentUser.property_uid
  ) {
    return <Navigate to={`/property/${currentUser.property_uid}/overview`} replace />;
  }

  // Super Admins cannot open another company's property via URL
  if (
    currentRole === 'super_admin' &&
    propertyUid &&
    companyProperties.length > 0 &&
    !companyProperties.some((p) => p.property_uid === propertyUid)
  ) {
    return <Navigate to="/admin/properties" replace />;
  }

  return <WorkspaceGate>{children}</WorkspaceGate>;
};

/** Redirect preserving route params (:date, :employeeUid…) and query params. */
const LegacyRedirect: React.FC<{ to: string }> = ({ to }) => {
  const params = useParams();
  const [searchParams] = useSearchParams();
  // If `to` already carries a query string, merge legacy params after it.
  const [path, inlineQ] = to.split('?');
  const resolved = path.replace(/:([A-Za-z_]+)/g, (_, k) => params[k] || '');
  const q = [inlineQ, searchParams.toString()].filter(Boolean).join('&');
  return <Navigate to={`/property/${params.propertyUid}/${resolved}${q ? `?${q}` : ''}`} replace />;
};

/**
 * Restricts a route to specific roles — employees can never reach admin or
 * property-management screens, and managers/admins never see employee views.
 */
const RequireRole: React.FC<{ roles: string[]; children: React.ReactNode }> = ({
  roles,
  children,
}) => {
  const { currentRole, activePropertyUid } = useApp();
  if (!roles.includes(currentRole)) {
    if (currentRole === 'employee' || currentRole === 'human_resource' || currentRole === 'department_manager')
      return <Navigate to="/" replace />;
    if (currentRole === 'property_manager')
      return <Navigate to={`/property/${activePropertyUid}/overview`} replace />;
    return <Navigate to="/admin/properties" replace />;
  }
  return <>{children}</>;
};

/**
 * Directs the user to the canonical landing page for their active role
 */
const RootRedirect: React.FC = () => {
  const { currentRole, activePropertyUid, isAuthenticated } = useApp();

  if (!isAuthenticated) {
    return <Navigate to="/" replace />;
  }
  if (currentRole === 'super_admin') {
    return <Navigate to="/admin/properties" replace />;
  }
  if (currentRole === 'property_manager') {
    return <Navigate to={`/property/${activePropertyUid}/overview`} replace />;
  }
  return <Navigate to="/" replace />;
};

const AppContent: React.FC = () => {
  const { currentPath, isAuthenticated } = useApp();
  const isPublicPage =
    currentPath === '/' || currentPath === '/login' || currentPath === '/signup';

  return (
    <div className="min-h-screen bg-[#F7F4EE] text-[#24221F] font-body flex flex-col selection:bg-[#386641] selection:text-white">
      {/* Main Navigation Header (hidden on public landing/auth pages and when signed out) */}
      {isAuthenticated && !isPublicPage && <Header />}

      {/* Main Content Area — public pages manage their own full-width layout */}
      <main
        className={
          isPublicPage
            ? 'flex-1 w-full'
            : 'flex-1 w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6'
        }
      >
        <React.Suspense
          fallback={
            <div className="flex items-center justify-center py-24">
              <Skeleton className="h-8 w-40" />
            </div>
          }
        >
        <Routes>
          {/* Public routes */}
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />

          {/* Super Admin company-level routes */}
          <Route path="/admin/properties" element={<RequireAuth><RequireRole roles={['super_admin']}><WorkspaceGate><PropertiesView /></WorkspaceGate></RequireRole></RequireAuth>} />
          <Route path="/admin/settings" element={<RequireAuth><RequireRole roles={['super_admin']}><WorkspaceGate><AdminSettingsView /></WorkspaceGate></RequireRole></RequireAuth>} />
          <Route path="/admin/logs" element={<RequireAuth><RequireRole roles={['super_admin']}><WorkspaceGate><LogsView /></WorkspaceGate></RequireRole></RequireAuth>} />

          {/* Property workspace — new five-destination IA */}
          <Route path="/property/:propertyUid/overview" element={<RequireAuth><PropertyScopedView><DashboardView /></PropertyScopedView></RequireAuth>} />

          <Route path="/property/:propertyUid/workforce" element={<RequireAuth><Navigate to="dashboard" replace /></RequireAuth>} />
          <Route path="/property/:propertyUid/workforce/dashboard" element={<RequireAuth><PropertyScopedView><EmployeeDashboard /></PropertyScopedView></RequireAuth>} />
          <Route path="/property/:propertyUid/workforce/employees" element={<RequireAuth><PropertyScopedView><EmployeesView /></PropertyScopedView></RequireAuth>} />
          <Route path="/property/:propertyUid/workforce/employees/:employeeUid" element={<RequireAuth><PropertyScopedView><EmployeeDetailView /></PropertyScopedView></RequireAuth>} />
          <Route path="/property/:propertyUid/workforce/salaries" element={<RequireAuth><PropertyScopedView><RequireRole roles={['super_admin', 'human_resource']}><SalariesView /></RequireRole></PropertyScopedView></RequireAuth>} />
          <Route path="/property/:propertyUid/workforce/departments" element={<RequireAuth><PropertyScopedView><DepartmentsView /></PropertyScopedView></RequireAuth>} />
          <Route path="/property/:propertyUid/workforce/departments/:departmentUid" element={<RequireAuth><PropertyScopedView><DepartmentDetailView /></PropertyScopedView></RequireAuth>} />

          <Route path="/property/:propertyUid/property" element={<RequireAuth><Navigate to="spaces/zones" replace /></RequireAuth>} />
          <Route path="/property/:propertyUid/property/spaces" element={<RequireAuth><Navigate to="zones" replace /></RequireAuth>} />
          <Route path="/property/:propertyUid/property/spaces/zones" element={<RequireAuth><PropertyScopedView><ZonesView /></PropertyScopedView></RequireAuth>} />
          <Route path="/property/:propertyUid/property/spaces/units" element={<RequireAuth><PropertyScopedView><RoomsDormsView /></PropertyScopedView></RequireAuth>} />
          <Route path="/property/:propertyUid/property/video/:tab" element={<RequireAuth><RequireRole roles={['super_admin', 'property_manager']}><WorkspaceGate><VaView /></WorkspaceGate></RequireRole></RequireAuth>} />
          <Route path="/property/:propertyUid/property/video" element={<RequireAuth><Navigate to="vms" replace /></RequireAuth>} />

          <Route path="/property/:propertyUid/operations" element={<RequireAuth><Navigate to="tasks" replace /></RequireAuth>} />
          <Route path="/property/:propertyUid/operations/tasks" element={<RequireAuth><PropertyScopedView><TasksView /></PropertyScopedView></RequireAuth>} />
          <Route path="/property/:propertyUid/operations/history/tasks/:date" element={<RequireAuth><RequireRole roles={['super_admin', 'property_manager']}><PropertyScopedView><TaskDayAnalysisView /></PropertyScopedView></RequireRole></RequireAuth>} />
          <Route path="/property/:propertyUid/operations/history/maintenance/:date" element={<RequireAuth><RequireRole roles={['super_admin', 'property_manager']}><PropertyScopedView><MaintenanceDayAnalysisView /></PropertyScopedView></RequireRole></RequireAuth>} />

          <Route path="/property/:propertyUid/insights" element={<RequireAuth><PropertyScopedView><InsightsView /></PropertyScopedView></RequireAuth>} />
          <Route path="/property/:propertyUid/insights/audit" element={<RequireAuth><RequireRole roles={['super_admin']}><WorkspaceGate><LogsView /></WorkspaceGate></RequireRole></RequireAuth>} />
          <Route path="/property/:propertyUid/profile" element={<RequireAuth><WorkspaceGate><ProfileView /></WorkspaceGate></RequireAuth>} />

          {/* Legacy route redirects (query params preserved) */}
          <Route path="/property/:propertyUid/zones" element={<RequireAuth><LegacyRedirect to="property/spaces/zones" /></RequireAuth>} />
          <Route path="/property/:propertyUid/rooms" element={<RequireAuth><LegacyRedirect to="property/spaces/units" /></RequireAuth>} />
          <Route path="/property/:propertyUid/employees" element={<RequireAuth><LegacyRedirect to="workforce/dashboard" /></RequireAuth>} />
          <Route path="/property/:propertyUid/employees/staff" element={<RequireAuth><LegacyRedirect to="workforce/employees" /></RequireAuth>} />
          <Route path="/property/:propertyUid/employees/departments" element={<RequireAuth><LegacyRedirect to="workforce/departments" /></RequireAuth>} />
          <Route path="/property/:propertyUid/employees/departments/:departmentUid" element={<RequireAuth><LegacyRedirect to="workforce/departments/:departmentUid" /></RequireAuth>} />
          <Route path="/property/:propertyUid/employees/:employeeUid" element={<RequireAuth><LegacyRedirect to="workforce/employees/:employeeUid" /></RequireAuth>} />
          <Route path="/property/:propertyUid/tasks" element={<RequireAuth><LegacyRedirect to="operations/tasks" /></RequireAuth>} />
          <Route path="/property/:propertyUid/tasks/history/:date" element={<RequireAuth><LegacyRedirect to="operations/history/tasks/:date" /></RequireAuth>} />
          <Route path="/property/:propertyUid/maintenance" element={<RequireAuth><LegacyRedirect to="operations/tasks?tab=maintenance" /></RequireAuth>} />
          <Route path="/property/:propertyUid/maintenance/history/:date" element={<RequireAuth><LegacyRedirect to="operations/history/maintenance/:date" /></RequireAuth>} />
          <Route path="/property/:propertyUid/templates" element={<RequireAuth><LegacyRedirect to="operations/tasks?tab=templates" /></RequireAuth>} />
          <Route path="/property/:propertyUid/va/:tab" element={<RequireAuth><LegacyRedirect to="property/video/:tab" /></RequireAuth>} />
          <Route path="/property/:propertyUid/va" element={<RequireAuth><LegacyRedirect to="property/video" /></RequireAuth>} />
          <Route path="/property/:propertyUid" element={<RequireAuth><Navigate to="overview" replace /></RequireAuth>} />

          {/* Role-based fallback redirects */}
          <Route path="*" element={<RootRedirect />} />
        </Routes>
        </React.Suspense>
      </main>

      {/* Global Toast Notifications Container */}
      <ToastContainer />
    </div>
  );
};

export function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <AppProvider>
        {/* dev-only render instrumentation — Profiler counts/measures
            commits caused by each refresh; production tree unchanged */}
        <React.Profiler
          id="app"
          onRender={(_id, _phase, actualDuration, baseDuration, startTime) => {
            perfLog(
              `[RENDER] commit actual=${actualDuration.toFixed(1)}ms ` +
              `base=${baseDuration.toFixed(1)}ms at=${startTime.toFixed(0)}`
            );
          }}
        >
          <AppContent />
        </React.Profiler>
        </AppProvider>
      </SessionProvider>
    </BrowserRouter>
  );
}

export default App;
