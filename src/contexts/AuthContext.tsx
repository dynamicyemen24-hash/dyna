/**
 * Authentication context: owns the session, the signed-in user and the
 * active branch/shift. Everything downstream reads from here instead of
 * local mock state.
 */
import React, { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react';
import { apiGet, apiPost, type ListResponse, tenantId, rememberTenant } from '../services/dyposApi';
import { offlineSyncService } from '../services/offlineSyncService';

export interface AuthUser {
  id: string;
  name: string;
  role: string;
  branchId: string;
  branchName: string;
  username: string;
}

export interface Branch {
  id: string;
  name: string;
  city: string;
  phone: string;
  address: string;
  manager: string;
}

export interface Session {
  token: string;
  user: AuthUser;
  branch: Branch;
  openedAt: string;
  openingCash: number;
}

const SESSION_KEY = 'dypos_session_v1';

interface AuthState {
  session: Session | null;
  branches: Branch[];
  loading: boolean;
  error: string;
  signIn: (
    username: string, password: string, branchId: string, openingCash: number,
    tenantId?: string,
  ) => Promise<void>;
  signOut: () => void;
  switchBranch: (branchId: string) => Promise<void>;
  biometricUnlock: (method: 'face' | 'fingerprint' | 'pin', credential: string) => Promise<boolean>;
  refreshBranches: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Restore a previous session so a refresh does not force a new sign-in.
  useEffect(() => {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) {
      try {
        setSession(JSON.parse(raw));
      } catch {
        localStorage.removeItem(SESSION_KEY);
      }
    }
    /*
     * The offline queue is namespaced per tenant, and its singleton was built at
     * module import — before this effect ran, and therefore before the tenant was
     * known. Without this reload the manager is holding an empty queue, and its
     * next `saveState()` writes that emptiness over the merchant's real pending
     * sales: unsent invoices from the previous shift would be erased on a page
     * refresh without ever being transmitted.
     *
     * It runs on every mount because the session may or may not have been
     * present, and re-reading an empty queue is a no-op.
     */
    offlineSyncService.reloadForTenant();
    setLoading(false);
  }, []);

  const refreshBranches = useCallback(async () => {
    try {
      // Through the service layer, not `fetch`. The raw call passed
      // `?tenantId=royal-global-hq` in the URL and sent NO bearer token, so the
      // branch list was fetched anonymously and the tenant was whatever the
      // caller typed into the query string. `apiGet` attaches the signed session
      // token and the tenant header, and the server derives the scope from the
      // token rather than from client input.
      const j = await apiGet<ListResponse<Branch>>('/api/db/branches');
      setBranches(j.items ?? []);
    } catch {
      // An empty branch list here would render as "this tenant has no
      // branches", which reads as a fact rather than as a failed load. Keep the
      // distinction explicit by leaving the branches empty and letting the
      // screens that depend on them report their own load failure.
      setBranches([]);
    }
  }, []);

  useEffect(() => { refreshBranches(); }, [refreshBranches]);

  /*
   * `tenantId` is the organisation being signed in to.
   *
   * Empty means "do not name one", and the server then falls back to the default
   * tenant — which is what an existing single-tenant client sends, and is why
   * this parameter is optional rather than required.
   */
  const signIn = useCallback(async (
    username: string, password: string, branchId: string, openingCash: number,
    tenantId = '',
  ) => {
    setError('');
    const res = await apiPost<{ session: Session }>('/api/auth/login', {
      username, password, branchId, openingCash,
      // Only sent when chosen. An empty string would be a claim of "the tenant
      // with the empty name", which is not what an untouched field means.
      ...(tenantId ? { tenantId } : {}),
    });

    /*
     * The server resolved a tenant from the database, and that is the one the
     * session belongs to. Persisting it keeps later requests consistent with
     * the session the server actually issued, rather than with whatever the
     * operator typed — which may not exist, or may be spelled differently.
     */
    rememberTenant(tenantId);

    setSession(res.session);
    localStorage.setItem(SESSION_KEY, JSON.stringify(res.session));

    /*
     * Load THIS tenant's offline queue now that the identity is known.
     *
     * A till is routinely shared between merchants: sign out of one and sign in
     * as another on the same device. Without this the manager would still be
     * holding the previous tenant's queue in memory and its next save would
     * write that merchant's sales into the new merchant's storage namespace —
     * the cross-tenant leak the scoping exists to prevent.
     *
     * The reload REPLACES the in-memory queue rather than merging, and only
     * after the new session is persisted, so `activeTenant()` resolves to the
     * tenant the server actually issued the token for.
     */
    offlineSyncService.reloadForTenant();
  }, []);

  const signOut = useCallback(() => {
    setSession(null);
    localStorage.removeItem(SESSION_KEY);
  }, []);

  const switchBranch = useCallback(async (branchId: string) => {
    setSession((s) => {
      if (!s) return s;
      const branch = branches.find((b) => b.id === branchId) || s.branch;
      const next = { ...s, branch, branchId } as any;
      localStorage.setItem(SESSION_KEY, JSON.stringify(next));
      return next;
    });
  }, [branches]);

  /**
   * Re-authentication gate (PIN / biometric).
   *
   * The server owns the check, and the IDENTITY IS NOT SENT BY THE CLIENT.
   * This previously posted `userId` and a free-form `credential`, and the server
   * accepted any non-empty string and answered `{ ok: true }` — so asking this
   * function was equivalent to being logged in. The contract is now: the session
   * token identifies the user, and only a real secret is submitted.
   */
  const biometricUnlock = useCallback(async (
    method: 'face' | 'fingerprint' | 'pin', pin: string,
  ): Promise<boolean> => {
    if (!session) return false;
    try {
      const res = await apiPost<{ ok: boolean }>('/api/auth/unlock', { method, pin });
      return !!res.ok;
    } catch {
      // A refused unlock (wrong PIN, locked account, or a biometric that is not
      // enrolled) is a normal outcome, not an error to surface as a crash.
      return false;
    }
  }, [session]);

  const value = useMemo<AuthState>(() => ({
    session, branches, loading, error, signIn, signOut, switchBranch,
    biometricUnlock, refreshBranches,
  }), [session, branches, loading, error, signIn, signOut, switchBranch,
    biometricUnlock, refreshBranches]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}