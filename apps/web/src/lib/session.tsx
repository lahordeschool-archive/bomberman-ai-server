import type { PublicUser, SessionResponse } from '@bomberman/protocol';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { identifyUser } from './analytics.ts';
import { api, setCsrfToken } from './api.ts';
import { resetSocket } from './socket.ts';

interface SessionContextValue {
  user: PublicUser | null;
  loading: boolean;
  apply(session: SessionResponse): void;
  logout(): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  const apply = useCallback((session: SessionResponse) => {
    setCsrfToken(session.csrfToken);
    setUser(session.user);
    identifyUser(session.user);
    resetSocket();
  }, []);

  useEffect(() => {
    api
      .session()
      .then(apply)
      .catch(() => apply({ user: null, csrfToken: null }))
      .finally(() => setLoading(false));
  }, [apply]);

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    apply({ user: null, csrfToken: null });
  }, [apply]);

  return (
    <SessionContext.Provider value={{ user, loading, apply, logout }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
