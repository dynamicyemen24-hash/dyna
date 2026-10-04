import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiGet } from '../services/dyposApi';

/**
 * Client-side RBAC mirror of the server's authority model.
 *
 * This is strictly a *rendering* aid: the server re-checks every permission on
 * every route, so hiding a button here is a usability measure, not a control.
 * A user who edits the DOM still gets a 403.
 */

export interface RoleSummary {
  id: string;
  code: string;
  name: string;
  sodGroup: string | null;
}

export interface Principal {
  username: string;
  name: string;
  roles: RoleSummary[];
  permissions: string[];
  isSuperuser: boolean;
  branchIds: string[];
}

interface AuthzContextType {
  principal: Principal | null;
  loading: boolean;
  error: string;
  /** True when the signed-in user holds the permission. */
  can: (...permissions: string[]) => boolean;
  /** True only for the superuser/admin role. */
  isAdmin: boolean;
  refresh: () => void;
}

const AuthzContext = createContext<AuthzContextType | undefined>(undefined);

export const AuthzProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // There is no identity switcher any more. Which user you are is decided by
  // the server-signed session token; the client cannot choose a different one,
  // so a "swap actor" helper would be a privilege-escalation button.
  //
  // No token means nobody is signed in yet: asking the server "who am I?" can
  // only ever answer 401, which showed up as a console error on the sign-in
  // screen and set a misleading "could not load permissions" state.
  useEffect(() => {
    const token = sessionStorage.getItem('dypos_token');
    if (!token) {
      setPrincipal(null);
      setError('');
      setLoading(false);
      return;
    }

    let alive = true;
    (async () => {
      try {
        setLoading(true);
        const me = await apiGet<Principal>('/api/erp/me');
        if (alive) { setPrincipal(me); setError(''); }
      } catch (e: any) {
        if (alive) { setPrincipal(null); setError(e.message || 'تعذّر تحميل الصلاحيات'); }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [nonce]);

  const can = useCallback(
    (...permissions: string[]) => {
      if (!principal) return false;
      if (principal.isSuperuser) return true;
      // Any-of semantics: a comma-separated list acts as an OR group.
      return permissions.some((p) => principal.permissions.includes(p));
    },
    [principal],
  );

  const value = useMemo<AuthzContextType>(
    () => ({
      principal,
      loading,
      error,
      can,
      isAdmin: Boolean(principal?.isSuperuser),
      refresh,
    }),
    [principal, loading, error, can, refresh],
  );

  return <AuthzContext.Provider value={value}>{children}</AuthzContext.Provider>;
};

export const useAuthz = () => {
  const ctx = useContext(AuthzContext);
  if (!ctx) throw new Error('useAuthz must be used inside AuthzProvider');
  return ctx;
};