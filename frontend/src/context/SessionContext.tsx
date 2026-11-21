import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  ReactNode,
  useCallback,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthUser, Company, UserRole } from '../types';
import { ApiError, getAuthToken, setUnauthorizedHandler } from '../api/client';
import { disconnectRealtime } from '../realtime/client';
import * as authApi from '../api/auth';
import * as companiesApi from '../api/companies';
import { RegisterCompanyRequest } from '../api/types';

/**
 * Session lifecycle events — the bridge back into AppContext. Session
 * state lives HERE; anything that touches server collections, the toast
 * queue, or employees-cache patching is emitted for AppContext to apply
 * (it owns those stores). Keeps this provider free of collection imports
 * — which is what makes the split directional instead of circular.
 */
export type SessionEvent =
  | { type: 'established' } // user authenticated (sign-in or bootstrap) → load workspace
  | { type: 'cleared' } // session wiped (logout / expired 401) → drop collections
  | {
      type: 'employee-patch';
      employee_uid: string;
      updates: { name?: string; phone?: string; email?: string };
    }
  | {
      type: 'toast';
      toast: {
        type: 'success' | 'error' | 'info' | 'warning';
        title: string;
        description?: string;
      };
    };

type SessionListener = (ev: SessionEvent) => void;

export interface SessionContextType {
  currentUser: AuthUser | null;
  company: Company | null;
  activePropertyUid: string;
  currentRole: UserRole;
  isAuthenticated: boolean;
  setActivePropertyUid: (uid: string) => void;
  signIn: (session: { user: AuthUser; company: Company }) => void;
  logout: () => void;
  registerCompanyAccount: (payload: RegisterCompanyRequest) => Promise<void>;
  updateProfile: (updates: {
    name?: string;
    phone?: string;
    email?: string;
  }) => Promise<void>;
  updateCompanyDetails: (updates: {
    name?: string;
    legal_name?: string;
    brand_name?: string;
    email?: string;
    phone?: string;
    address?: string;
    pin_code?: string;
    operational_day_start?: string;
  }) => Promise<void>;
  subscribeSessionEvents: (fn: SessionListener) => () => void;
}

const SessionContext = createContext<SessionContextType | undefined>(undefined);

const apiErrorMessage = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback;

export const SessionProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [activePropertyUid, setActivePropertyUid] = useState<string>('');
  const routerNavigate = useNavigate();

  const listeners = useRef(new Set<SessionListener>());
  const emit = useCallback((ev: SessionEvent) => {
    listeners.current.forEach((fn) => fn(ev));
  }, []);
  const subscribeSessionEvents = useCallback(
    (fn: SessionListener): (() => void) => {
      listeners.current.add(fn);
      return () => {
        listeners.current.delete(fn);
      };
    },
    []
  );

  const currentRole: UserRole = currentUser?.role || 'super_admin';
  const isAuthenticated = !!currentUser;

  const wipeSession = useCallback(() => {
    setCurrentUser(null);
    setCompany(null);
    setActivePropertyUid('');
    emit({ type: 'cleared' });
  }, [emit]);

  // -------------------------------------------------------------------
  // Session bootstrap: token present → GET /auth/me → established event
  // (AppContext loads the workspace off that event).
  // -------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      // No stored access token → no session to restore. Skip /auth/me
      // entirely — calling it would produce a doomed 401 that fires the
      // unauthorized handler and bounces public pages to /login.
      if (!getAuthToken()) return;
      try {
        const { user, company: userCompany } = await authApi.me();
        if (cancelled) return;
        setCurrentUser(user);
        setCompany(userCompany);
        if (user.property_uid) setActivePropertyUid(user.property_uid);
        emit({ type: 'established' });
      } catch {
        // No/invalid session — stay on the public routes
      }
    };
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [emit]);

  // Session expiry: API client fires this when a 401 survives the
  // single refresh retry — clear the full session, not just the user.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      wipeSession();
      routerNavigate('/login');
    });
    return () => setUnauthorizedHandler(null);
  }, [routerNavigate, wipeSession]);

  // -------------------------------------------------------------------
  // Auth operations
  // -------------------------------------------------------------------
  const signIn = useCallback(
    (session: { user: AuthUser; company: Company }) => {
      const { user, company: userCompany } = session;
      setCurrentUser(user);
      setCompany(userCompany);
      if (user.property_uid) setActivePropertyUid(user.property_uid);
      emit({ type: 'established' });

      if (user.role === 'super_admin') {
        routerNavigate('/admin/properties');
      } else if (user.role === 'property_manager') {
        routerNavigate(`/property/${user.property_uid}/zones`);
      } else {
        routerNavigate('/');
      }
    },
    [emit, routerNavigate]
  );

  const logout = useCallback(() => {
    void authApi.logout(); // best-effort server-side invalidation
    disconnectRealtime(); // drop the socket + scoped tokens with the session
    wipeSession();
    routerNavigate('/');
    emit({
      type: 'toast',
      toast: {
        type: 'info',
        title: 'Logged Out',
        description: 'You have been signed out of Management Tool.',
      },
    });
  }, [routerNavigate, emit, wipeSession]);

  const registerCompanyAccount = useCallback(
    async (payload: RegisterCompanyRequest) => {
      const res = await authApi.registerCompany(payload);
      signIn({ user: res.user, company: res.company });
      emit({
        type: 'toast',
        toast: {
          type: 'success',
          title: 'Organization Registered',
          description: `${res.company.name} setup completed. Welcome to Management Tool!`,
        },
      });
    },
    [signIn, emit]
  );

  const updateProfile = useCallback(
    async (updates: { name?: string; phone?: string; email?: string }) => {
      try {
        const updated = await authApi.updateProfile(updates);
        setCurrentUser(updated);
        if (updated.employee_uid) {
          emit({
            type: 'employee-patch',
            employee_uid: updated.employee_uid,
            updates,
          });
        }
        emit({
          type: 'toast',
          toast: {
            type: 'success',
            title: 'Profile Updated',
            description: 'Your details were saved.',
          },
        });
      } catch (err) {
        emit({
          type: 'toast',
          toast: {
            type: 'error',
            title: 'Profile Update Failed',
            description: apiErrorMessage(err, 'Could not save profile changes.'),
          },
        });
        throw err;
      }
    },
    [emit]
  );

  const updateCompanyDetails = useCallback(
    async (updates: {
      name?: string;
      legal_name?: string;
      brand_name?: string;
      email?: string;
      phone?: string;
      address?: string;
      pin_code?: string;
      operational_day_start?: string;
    }) => {
      if (!company) return;
      const updated = await companiesApi.updateCompany(
        company.company_uid,
        updates
      );
      setCompany(updated);
    },
    [company]
  );

  const value: SessionContextType = {
    currentUser,
    company,
    activePropertyUid,
    currentRole,
    isAuthenticated,
    setActivePropertyUid,
    signIn,
    logout,
    registerCompanyAccount,
    updateProfile,
    updateCompanyDetails,
    subscribeSessionEvents,
  };

  return (
    <SessionContext.Provider value={value}>
      {children}
    </SessionContext.Provider>
  );
};

export const useSession = (): SessionContextType => {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within a SessionProvider');
  return ctx;
};
