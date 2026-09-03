import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';

export type Role = 'drafter' | 'reviewer' | 'approver' | 'manager' | 'viewer' | 'template_editor' | 'admin';
export interface Principal {
  userId: string;
  displayName: string;
  email?: string;
  roles: Role[];
  divisions: string[];
}

interface SessionState {
  principal: Principal | null;
  loading: boolean;
  refresh(): Promise<void>;
  logout(): Promise<void>;
  hasRole(...roles: Role[]): boolean;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setPrincipal(await api<Principal>('/me'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setPrincipal(null);
      else throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<SessionState>(
    () => ({
      principal,
      loading,
      refresh,
      async logout() {
        await api('/auth/logout', { method: 'POST' });
        setPrincipal(null);
      },
      hasRole: (...roles) => !!principal && roles.some((r) => principal.roles.includes(r)),
    }),
    [principal, loading, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}
