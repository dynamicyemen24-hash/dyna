import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { apiGet, apiPost } from '../services/dyposApi';
import { useAuthz } from './AuthzContext';
import { useIndustry } from './IndustryContext';
import {
  ALL_SCREEN_IDS, capabilitiesForProfile, getProfileById,
  resolveScreenEntitlement, type ScreenDenial,
} from '../config/industryProfiles';
import { resolveIdentity, type ResolvedIdentity } from '../services/tenantIdentity';
import {
  readReferenceSnapshot,
  readSignedIdentity,
  writeReferenceSnapshot,
} from '../services/referenceSnapshot';

/**
 * What the signed-in user, in this organisation, on this branch, is allowed to
 * open — resolved from four levels and answered once.
 *
 * WHO DECIDES
 * -----------
 * The server decides (`GET /api/erp/entitlements`). This context holds the
 * answer, shows it, and refreshes it when the sector changes. It is not a
 * security control: the server re-checks every route, and a client that edits
 * the array still gets a 403. What it prevents is a shell that navigates a user
 * to screens they were never entitled to — the confusing half of a licence.
 *
 * WHEN THE SERVER CANNOT BE ASKED
 * -------------------------------
 * Three answers are possible and they are deliberately distinguishable:
 *
 *   'server' — the licence was verified. Normal.
 *   'client' — the endpoint is unavailable (an edge build without the route).
 *              The same resolver runs locally on data the client may read, and
 *              the shell says the check was local.
 *   'local'  — even that failed. Sector defaults from the tenant's stored
 *              profile are used so the operator is not locked out of their own
 *              till, and `verificationFailed` is true so the UI can say the
 *              subscription was not verified.
 *
 * An unverifiable licence degrades to *fewer* gates (sector only), never to
 * zero gates — hiding every screen because one request failed is what makes an
 * outage look like a cancellation.
 */

export type EntitlementAuthority = 'server' | 'client' | 'local';

export interface EntitlementBranch {
  id: string;
  name: string;
  city: string;
  phone: string;
  address: string;
  manager: string;
  allowed: boolean;
}

interface EntitlementSnapshot {
  tenant: NonNullable<EntitlementContextType['tenant']> & { plan?: string | null };
  sector: { id: string; nameAr: string; nameEn: string; isProvisioned: boolean };
  capabilities: string[];
  grantsFromDatabase: boolean;
  branches: EntitlementBranch[];
}

interface EntitlementContextType {
  status: 'idle' | 'loading' | 'ready' | 'error';
  authority: EntitlementAuthority;
  error: string;
  /** Source and snapshot time are surfaced so offline data is never presented as live. */
  snapshotFetchedAt: string | null;
  /** True when the subscription could not be verified this session. */
  verificationFailed: boolean;

  sector: string;
  sectorName: string;
  plan: string | null;
  tenant: {
    name: string; ownerCompany: string; baseCurrency: string;
    countryCode: string; taxNumber: string | null; commercialReg: string | null;
  } | null;

  capabilities: string[];
  grantsFromDatabase: boolean;

  screens: string[];
  licensedScreens: string[];
  blocked: ScreenDenial[];
  branches: EntitlementBranch[];

  /**
   * The printable company / branch / VAT identity, resolved from the server.
   *
   * Screens MUST NOT hard-code any of these. `source === 'unresolved'` means a
   * required legal field is missing, and the screen must say so rather than
   * substitute a default — a blank tax number is a support ticket, a wrong one
   * is a regulatory finding.
   */
  identity: ResolvedIdentity;

  allowsScreen: (id: string) => boolean;
  can: (...permissions: string[]) => boolean;

  switchingSector: boolean;
  setSector: (profileId: string) => Promise<void>;
  setBranchId: (id: string | null) => void;
  refresh: () => void;
}

const EntitlementContext = createContext<EntitlementContextType | undefined>(undefined);

/*
 * ══ THE ONE FETCH PER SESSION ══════════════════════════════════════════════
 * `GET /api/erp/entitlements` already returns the tenant row, the branch list,
 * the sector and the capability set in a single round trip. This context is the
 * only thing that calls it, and everything else reads the answer from here.
 *
 * That matters for correctness, not just for tidiness. The alternative — each
 * screen calling `/api/db/tenant/profile` or `/api/db/branches` itself — is what
 * produced the disagreement this product shipped with: one screen resolved the
 * tenant, another resolved the branch, and a third used a constant, so a receipt
 * could name a VAT number the settings screen could not display and a branch
 * picker could offer a shop that the invoice never mentioned.
 *
 * One fetch also means one moment of truth. When the operator switches sector or
 * the licence is narrowed, `refresh()` re-reads once and every consumer changes
 * together; there is no window in which two screens disagree about the same
 * tenant.
 *
 * The request is fired ONCE per session identity (keyed on the principal), so
 * navigation between screens does not refetch — the answer is already correct
 * for the signed-in user.
 */
const SECTOR_KEY = 'dypos_industry_profile';

/** Sector defaults read before any request returns, so the nav is never blank. */
const localSector = (): string => {
  try {
    return getProfileById(localStorage.getItem(SECTOR_KEY) || 'retail').id;
  } catch {
    return 'retail';
  }
};


export const EntitlementProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const authz = useAuthz();
  const { setProfile } = useIndustry();

  const [status, setStatus] = useState<EntitlementContextType['status']>('idle');
  const [authority, setAuthority] = useState<EntitlementAuthority>('local');
  const [error, setError] = useState('');
    const [snapshotFetchedAt, setSnapshotFetchedAt] = useState<string | null>(null);
  const [verificationFailed, setVerificationFailed] = useState(false);

  const [sector, setSectorState] = useState<string>(() => localSector());
  const [plan, setPlan] = useState<string | null>(null);
  const [tenant, setTenant] = useState<EntitlementContextType['tenant']>(null);
  const [capabilities, setCapabilities] = useState<string[]>(
    () => capabilitiesForProfile(localSector()),
  );
  const [grantsFromDatabase, setGrantsFromDatabase] = useState(false);
  const [screens, setScreens] = useState<string[]>(() =>
    resolveScreenEntitlement({
      available: ALL_SCREEN_IDS,
      profileId: localSector(),
      capabilities: capabilitiesForProfile(localSector()),
      permissions: null,
      grantsFromDatabase: false,
    }).allowed,
  );
  const [licensedScreens, setLicensedScreens] = useState<string[]>(() =>
    resolveScreenEntitlement({
      available: ALL_SCREEN_IDS,
      profileId: localSector(),
      capabilities: capabilitiesForProfile(localSector()),
      permissions: null,
      grantsFromDatabase: false,
    }).licensed,
  );
  const [blocked, setBlocked] = useState<ScreenDenial[]>([]);
  const [branches, setBranches] = useState<EntitlementBranch[]>([]);
  const [switchingSector, setSwitchingSector] = useState(false);
  const [nonce, setNonce] = useState(0);

  /*
   * The branch the current session is operating at.
   *
   * This is the ONE legitimate remaining use of a default: an app with no stored
   * branch must still boot, and "no branch selected" is a real state. It is NOT
   * a company name, a tax number or any other legal identity — those come from
   * the server or they are unresolved. An unknown stored id resolves to no
   * branch rather than to a named one.
   */
  const [branchId, setBranchIdState] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem('dypos_branch') ?? null;
    } catch {
      return null;
    }
  });

  // Listen for branch changes from other tabs (storage event) or same-tab
  // dispatchers (custom event). The DataContext writes to sessionStorage and
  // dispatches a 'dypos:branch-changed' event so all contexts stay in sync.
  useEffect(() => {
    const STORAGE_KEY = 'dypos_branch';

    const syncFromStorage = () => {
      try {
        const next = sessionStorage.getItem(STORAGE_KEY);
        setBranchIdState((current) => (current !== next ? next : current));
      } catch { /* storage optional */ }
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY || e.key === null) syncFromStorage();
    };
    const onBranchChanged = () => {
      syncFromStorage();
      // Branch creation changes the server entitlement snapshot, not just the
      // selected id. Re-read it so the new real branch enters the workspace.
      setNonce((current) => current + 1);
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener('dypos:branch-changed', onBranchChanged);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('dypos:branch-changed', onBranchChanged);
    };
  }, []);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const token = sessionStorage.getItem('dypos_token');
    if (!token) return;

    let alive = true;
    const profileId = localSector();
    const permissions = authz.principal && Array.isArray(authz.principal.permissions) ? [...authz.principal.permissions] : [];
    const isSuperuser = Boolean(authz.principal?.isSuperuser);

    const apply = (
      next: ReturnType<typeof resolveScreenEntitlement>,
      nextSector: string,
      nextCaps: string[],
      fromDatabase: boolean,
    ) => {
      if (!alive) return;
      setSectorState(nextSector);
      setCapabilities(nextCaps);
      setGrantsFromDatabase(fromDatabase);
      setScreens(next.allowed);
      setLicensedScreens(next.licensed);
      setBlocked(next.blocked);
      setError('');
    };

    const localResolve = (nextSector: string, nextCaps: string[], fromDatabase: boolean) =>
      apply(
        resolveScreenEntitlement({
          available: ALL_SCREEN_IDS,
          profileId: nextSector,
          capabilities: nextCaps,
          permissions,
          isSuperuser,
          grantsFromDatabase: fromDatabase,
        }),
        nextSector,
        nextCaps,
        fromDatabase,
      );

    (async () => {
      setStatus('loading');
      const identity = readSignedIdentity();

      // 1 — the server's answer.
      try {
        const res = await apiGet<any>('/api/erp/entitlements');
        if (!alive) return;
        if (!identity || res.tenant?.id !== identity.tenantId) {
          throw new Error('تعذر التحقق من تطابق المؤسسة مع الجلسة الحالية');
        }
        const nextSector = res.sector?.id || profileId;
        const nextCaps: string[] = Array.isArray(res.capabilities) ? res.capabilities : [];
        setAuthority('server');
        setPlan(res.tenant?.plan ?? null);
        setTenant(res.tenant ?? null);
        setBranches(res.branches ?? []);
          setSnapshotFetchedAt(null);
        setVerificationFailed(false);
        apply(
          resolveScreenEntitlement({
            available: ALL_SCREEN_IDS,
            profileId: nextSector,
            capabilities: nextCaps,
            permissions: Array.isArray(res.user?.permissions) ? res.user.permissions : null,
            isSuperuser: Boolean(res.user?.isSuperuser),
            grantsFromDatabase: res.grantsFromDatabase !== false,
          }),
          nextSector,
          nextCaps,
          res.grantsFromDatabase !== false,
        );
        const snapshot: EntitlementSnapshot = {
          tenant: res.tenant,
          sector: res.sector,
          capabilities: nextCaps,
          grantsFromDatabase: res.grantsFromDatabase !== false,
          branches: res.branches ?? [],
        };
        await writeReferenceSnapshot(identity, snapshot, 'entitlements').catch(() => {});
        setStatus('ready');
        return;
      } catch (e: any) {
        if (!alive) return;
        setError(e?.message || 'تعذّر التحقق من اشتراك المؤسسة');
      }

      const cached = identity
        ? await readReferenceSnapshot<EntitlementSnapshot>(identity, 'entitlements').catch(() => null)
        : null;
      if (!alive) return;
      if (cached) {
        const snapshot = cached.data;
        const nextSector = snapshot.sector?.id || profileId;
        const nextCaps = Array.isArray(snapshot.capabilities)
          ? snapshot.capabilities
          : capabilitiesForProfile(nextSector);
        setAuthority('client');
        setPlan(snapshot.tenant?.plan ?? null);
        setTenant(snapshot.tenant ?? null);
        setBranches(snapshot.branches ?? []);
        setSnapshotFetchedAt(cached.fetchedAt);
        setVerificationFailed(true);
        localResolve(nextSector, nextCaps, snapshot.grantsFromDatabase);
        setStatus('ready');
        setError(`نسخة محلية محفوظة — آخر تحديث ${new Date(cached.fetchedAt).toLocaleString('ar-SA')}`);
        return;
      }

      // No signed-identity cache: do not guess the tenant, branches, or grants.
      setAuthority('local');
      setVerificationFailed(true);
      setBranches([]);
      setSnapshotFetchedAt(null);
      localResolve(profileId, capabilitiesForProfile(profileId), false);
      setError('لا تتوفر نسخة محلية موثقة لبيانات هذه المؤسسة. اتصل بالشبكة لإكمال التحقق.');
      setStatus('error');
    })();

    return () => { alive = false; };
    // `error` is intentionally not a dependency: it would re-run this effect
    // on every message it sets, which is a fetch loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, authz.principal]);

  // Cloud remains authoritative. Revalidate its snapshot on reconnect, focus,
  // and periodically while the workspace is open; never merge client edits.
  useEffect(() => {
    const refreshFromCloud = () => {
      if (navigator.onLine) setNonce((current) => current + 1);
    };
    const timer = window.setInterval(refreshFromCloud, 15 * 60 * 1000);
    window.addEventListener('online', refreshFromCloud);
    window.addEventListener('focus', refreshFromCloud);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', refreshFromCloud);
      window.removeEventListener('focus', refreshFromCloud);
    };
  }, []);


  /**
   * Switches the organisation's sector and re-reads the licence.
   *
   * The POST is the authoritative write; `setProfile` from IndustryContext only
   * updates the local mirror so both contexts agree in the same tick.
   */
  const setSector = useCallback(async (profileId: string) => {
    setSwitchingSector(true);
    try {
      if (authority !== 'server' || !authz.principal?.verified) {
        throw new Error('تغيير قطاع المؤسسة يتطلب اتصالاً موثقاً بالخادم');
      }
      await apiPost<{ profileId: string }>('/api/db/tenant/profile', { profileId });
      setProfile(profileId);
      setSectorState(profileId);
      setNonce((n) => n + 1);
    } finally {
      setSwitchingSector(false);
    }
  }, [authority, authz.principal?.verified, setProfile]);

  /**
   * Updates the active branch, persisting to sessionStorage and notifying
   * other contexts via a custom event so the whole app switches together.
   */
  const setBranchId = useCallback((id: string | null) => {
    try {
      if (id === null) {
        sessionStorage.removeItem('dypos_branch');
      } else {
        sessionStorage.setItem('dypos_branch', id);
      }
    } catch { /* storage optional */ }
    setBranchIdState(id);
    window.dispatchEvent(new CustomEvent('dypos:branch-changed'));
  }, []);

  const screenSet = useMemo(() => new Set(screens), [screens]);

  /*
   * ══ THE ONE IDENTITY THE UI MAY PRINT ═════════════════════════════════════
   * Screens used to hard-code the company name, the branch and the VAT number.
   * A tax number on a fiscal document is a legal assertion, so a compiled-in one
   * means this build cannot lawfully be issued to a second customer: it would
   * print that customer's receipts under this company's registration.
   *
   * The tenant row and the branch list are already loaded above. Resolving the
   * printable identity here — once, from the server's own answer — means a
   * screen cannot invent a legal identity even by accident, and a second branch
   * reading the same context gets the same answer rather than its own literal.
   *
   * `branchId` is looked up against the branches this tenant may actually use, so
   * the receipt names the branch the sale was recorded at. An unknown id yields
   * `null` (honest) rather than falling back to "main branch" (a lie).
   */
  const identity = useMemo(() => {
    const row = branches.find((b) => b.id === branchId) ?? null;
    return resolveIdentity(tenant, row);
  }, [tenant, branches, branchId]);

  const allowsScreen = useCallback(
    (id: string) => screenSet.has(id),
    [screenSet],
  );

  const can = useCallback((...permissions: string[]) => {
    // No verified identity: do not claim a grant the server may refuse, and do
    // not claim a denial either — permission-gated chrome simply stays out of
    // the way until the identity is known.
    if (!authz.principal) return false;
    if (authz.principal.isSuperuser) return true;
    if (permissions.length === 0) return true;
    const perms = authz.principal && Array.isArray(authz.principal.permissions) ? authz.principal.permissions : [];
    return perms.some((p) => permissions.includes(p));
  }, [authz.principal]);

  const value = useMemo<EntitlementContextType>(() => ({
    status,
    authority,
    error,
    verificationFailed,
    snapshotFetchedAt,
    sector,
    sectorName: getProfileById(sector).name_ar,
    plan,
    tenant,
    capabilities,
    grantsFromDatabase,
    screens,
    licensedScreens,
    blocked,
    branches,
    identity,
    allowsScreen,
    can,
    switchingSector,
    setSector,
    setBranchId,
    refresh,
  }), [
    status, authority, error, verificationFailed, snapshotFetchedAt, sector, plan, tenant,
    capabilities, grantsFromDatabase, screens, licensedScreens, blocked,
    branches, identity, allowsScreen, can, switchingSector, setSector, setBranchId, refresh,
  ]);

  return <EntitlementContext.Provider value={value}>{children}</EntitlementContext.Provider>;
};

/**
 * Reads the resolved licence.
 *
 * Throws outside the provider rather than returning an all-allowing default —
 * a permissive default is exactly the failure this module exists to prevent.
 */
export const useEntitlement = (): EntitlementContextType => {
  const ctx = useContext(EntitlementContext);
  if (!ctx) throw new Error('useEntitlement must be used inside EntitlementProvider');
  return ctx;
};

export default EntitlementProvider;

