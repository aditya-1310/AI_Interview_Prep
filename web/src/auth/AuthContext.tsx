// Session state: bootstrap from GET /auth/me, login/register/logout, and the
// route guards for protected vs anonymous-only pages.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { authApi, type AuthUser } from '../api/kits';
import { FullPageSpinner } from '../components/primitives';

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<AuthUser | null>;
  register: (email: string, password: string) => Promise<AuthUser | null>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authApi.me();
        if (!cancelled && res && typeof res === 'object' && res.user) {
          setUser(res.user);
        }
      } catch {
        // Signed out or server unreachable: stay anonymous, pages handle it.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchMe = useCallback(async (): Promise<AuthUser | null> => {
    try {
      const res = await authApi.me();
      const next = res && typeof res === 'object' && res.user ? res.user : null;
      setUser(next);
      return next;
    } catch {
      setUser(null);
      return null;
    }
  }, []);

  const login = useCallback(
    async (email: string, password: string): Promise<AuthUser | null> => {
      await authApi.login(email, password);
      return fetchMe();
    },
    [fetchMe],
  );

  const register = useCallback(
    async (email: string, password: string): Promise<AuthUser | null> => {
      await authApi.register(email, password);
      return fetchMe();
    },
    [fetchMe],
  );

  const logout = useCallback(async (): Promise<void> => {
    try {
      await authApi.logout();
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, register, logout }),
    [user, loading, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/** Renders the child route only when a session exists; remembers where we came from. */
export function ProtectedRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <FullPageSpinner label="Checking your session…" />;
  if (!user) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  }
  return <Outlet />;
}

/** Wraps /login and /register so signed-in users bounce to the dashboard. */
export function AnonymousOnly({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <FullPageSpinner label="Checking your session…" />;
  if (user) return <Navigate to="/" replace />;
  return <>{children}</>;
}
