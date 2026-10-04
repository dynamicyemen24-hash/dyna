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

interface EntitlementContextType {
  status: 'idle' | 'loading' | 'ready' | 'error';
  authority: EntitlementAuthority;
  error: string;
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
  const [branchId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('dypos_branch') ?? null;
    } catch {
      return null;
    }
  });

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const token = sessionStorage.getItem('dypos_token');
    if (!token) return;

    let alive = true;
    const profileId = localSector();
    const permissions = authz.principal ? [...authz.principal.permissions] : null;
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

      // 1 — the server's answer.
      try {
        const res = await apiGet<any>('/api/erp/entitlements');
        if (!alive) return;
        const nextSector = res.sector?.id || profileId;
        const nextCaps: string[] = Array.isArray(res.capabilities) ? res.capabilities : [];
        setAuthority('server');
        setPlan(res.tenant?.plan ?? null);
        setTenant(res.tenant ?? null);
        setBranches(res.branches ?? []);
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
        setStatus('ready');
        return;
      } catch (e: any) {
        if (!alive) return;
        setError(e?.message || 'تعذّر التحقق من اشتراك المؤسسة');
      }

      // 2 — the endpoint is unavailable (an edge build without the route, or a
      //     session that cannot reach it). The licence is then read from data
      //     the client is allowed to read and resolved locally.
      try {
        const p = await apiGet<any>('/api/db/tenant/profile?tenantId=royal-global-hq');
        if (!alive) return;
        const nextSector = p.profileId || profileId;
        const nextCaps = Array.isArray(p.enabledCapabilities) && p.enabledCapabilities.length
          ? p.enabledCapabilities
          : capabilitiesForProfile(nextSector);
        const fromDatabase = p.grantsFromDatabase !== false && nextCaps.length > 0;
        setAuthority('client');
        setPlan(p.plan ?? null);
        setBranches([]);
        setVerificationFailed(true);
        localResolve(nextSector, nextCaps, fromDatabase);
        setStatus('ready');
      } catch (e: any) {
        if (!alive) return;
        // 3 — nothing could be read. Sector defaults only, never an empty nav.
        setAuthority('local');
        setVerificationFailed(true);
        localResolve(profileId, capabilitiesForProfile(profileId), false);
        setError(e?.message || error);
        setStatus('error');
      }
    })();

    return () => { alive = false; };
    // `error` is intentionally not a dependency: it would re-run this effect
    // on every message it sets, which is a fetch loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, authz.principal]);


  /**
   * Switches the organisation's sector and re-reads the licence.
   *
   * The POST is the authoritative write; `setProfile` from IndustryContext only
   * updates the local mirror so both contexts agree in the same tick.
   */
  const setSector = useCallback(async (profileId: string) => {
    setSwitchingSector(true);
    try {
      await apiPost<{ profileId: string }>('/api/db/tenant/profile', { profileId });
      setProfile(profileId);
      setSectorState(profileId);
      setNonce((n) => n + 1);
    } finally {
      setSwitchingSector(false);
    }
  }, [setProfile]);

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
    return authz.principal.permissions.some((p) => permissions.includes(p));
  }, [authz.principal]);

  const value = useMemo<EntitlementContextType>(() => ({
    status,
    authority,
    error,
    verificationFailed,
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
    refresh,
  }), [
    status, authority, error, verificationFailed, sector, plan, tenant,
    capabilities, grantsFromDatabase, screens, licensedScreens, blocked,
    branches, identity, allowsScreen, can, switchingSector, setSector, refresh,
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

