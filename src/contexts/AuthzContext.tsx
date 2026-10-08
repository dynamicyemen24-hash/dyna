import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiGet } from '../services/dyposApi';
import {
  readReferenceSnapshot,
  readSignedIdentity,
  writeReferenceSnapshot,
} from '../services/referenceSnapshot';

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
  userId: string;
  tenantId: string;
  username: string;
  name: string;
  roles: RoleSummary[];
  permissions: string[];
  isSuperuser: boolean;
  branchIds: string[];
  verified: boolean;
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
  const token = sessionStorage.getItem('dypos_token');

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // There is no identity switcher any more. Which user you are is decided by
  // the server-signed session token; the client cannot choose a different one,
  // so a "swap actor" helper would be a privilege-escalation button.
  //
  // No token means nobody is signed in yet: asking the server "who am I?" can
  // only ever answer 401, which showed up as a console error on the sign-in
  // screen and set a misleading "could not load permissions" state.
  useEffect(() => {
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
        const me = await apiGet<Omit<Principal, 'verified'>>('/api/erp/me');
        const verifiedPrincipal: Principal = { ...me, verified: true };
        const identity = readSignedIdentity();
        if (identity && identity.tenantId === me.tenantId && identity.userId === me.userId) {
          await writeReferenceSnapshot(identity, verifiedPrincipal, 'principal').catch(() => {});
        }
        if (alive) { setPrincipal(verifiedPrincipal); setError(''); }
      } catch (e: any) {
        const identity = readSignedIdentity();
        const cached = identity
          ? await readReferenceSnapshot<Principal>(identity, 'principal').catch(() => null)
          : null;
        if (alive) {
          setPrincipal(cached ? { ...cached.data, verified: false } : null);
          setError(cached
            ? 'بيانات الهوية محفوظة محلياً؛ صلاحيات الكتابة تتطلب اتصالاً بالخادم.'
            : e.message || 'تعذّر تحميل الصلاحيات');
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [nonce, token]);

  const can = useCallback(
    (...permissions: string[]) => {
      if (!principal) return false;
      if (!principal.verified) return false;
      if (principal.isSuperuser) return true;
      // Any-of semantics: a comma-separated list acts as an OR group.
      const perms = principal && Array.isArray(principal.permissions) ? principal.permissions : [];
      return permissions.some((p) => perms.includes(p));
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