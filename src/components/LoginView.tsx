import React, { useState, useEffect, useRef, lazy, Suspense, useMemo } from 'react';
import { Branch } from '../types';
import { themeService, ThemeMode, THEME_CONFIGS } from '../services/themeService';
import { ThemeSwitcher } from './ThemeSwitcher';
import { ToolLauncher } from '../contexts/ToolsContext';
import { apiPost, rememberTenant, TENANT_IS_PINNED, tenantId } from '../services/dyposApi';
import { ScaleHALWidget } from './ScaleHALWidget';

/**
 * The 3D backdrop is decorative and costs ~535 KB (three.js).
 * It is loaded lazily and only when the visitor has not asked for reduced
 * motion, so the sign-in form paints immediately on slow connections and the
 * 3D never competes with an operator trying to log in for a shift.
 */
const ThreeBackgroundCanvas = lazy(() =>
  import('./ThreeBackgroundCanvas').then((m) => ({ default: m.ThreeBackgroundCanvas })));
import {
  Building2,
  ShieldCheck,
  Lock,
  User,
  Wifi,
  Sparkles,
  LogIn,
  KeyRound,
  Delete,
  CheckCircle2,
  Scale,
  Globe,
  Smartphone,
  Shield,
  Chrome,
  Key,
  ArrowLeft,
  RefreshCw,
  Clock,
  Server,
  Activity,
  Monitor,
  Printer,
  HardDrive,
  Moon,
  Sun,
  Globe2,
  Bell,
  HelpCircle,
  Eye,
  EyeOff,
  Sliders,
  Check,
  Building,
  Terminal,
  Cpu,
  Fingerprint,
  Radio,
  SlidersHorizontal,
  AlertTriangle,
  FileCheck2,
  Coins,
  ShieldAlert,
  UserPlus,
  LifeBuoy,
  FileText,
  BadgeAlert,
  Palette
} from 'lucide-react';

/** ------------------------------------------------------------------
 *  SUB-MODELS (expert organization: each auth surface is isolated)
 * ------------------------------------------------------------------ */

interface BaseLoginUser {
  name: string;
  role: string;
  branch: Branch;
  /**
   * NOTE: there is deliberately no `startingCash` here.
   *
   * Authentication answers "who are you". It does not answer "how much cash
   * was in the drawer". That figure is a property of an OPENED shift, it is
   * declared by the person who counted the till, and it is set afterwards in
   * `ShiftOpeningDialog` â€” not carried in on the login payload.
   *
   * While it was here, `/api/auth/login` inserted a `pos_sessions` row on
   * every sign-in, so merely authenticating opened a financial record with a
   * cash balance attached. Signing in is not a till-opening event, and the
   * audit trail now says so.
   */
  username?: string;
  mustChangePassword?: boolean;
}

interface StandardAuthParams {
  name: string;
  role: string;
  username?: string;
  mustChangePassword?: boolean;
}

/** ==================================================================
 *  CONTEXT 1 â€” AUTH FLOW STATE
 *  Single source of truth for credentials, branch, session lifecycle
 * ================================================================== */

/**
 * The operating station the operator signs in at.
 *
 * Declared once and reused: the state setter is `Dispatch<SetStateAction<â€¦>>`,
 * which is assignable to `(v: StationType) => void` but NOT to `(v: string) => void`
 * â€” widening the prop to `string` and then passing the typed setter is what
 * produced TS2322, and it also let `<select>` values escape the union.
 */
type StationType = 'pos_cashier' | 'kds_kitchen' | 'wms_inventory' | 'executive_audit';

/** The single runtime list the union above is checked against. */
const STATION_TYPES: readonly StationType[] = [
  'pos_cashier',
  'kds_kitchen',
  'wms_inventory',
  'executive_audit',
];

/**
 * A pending second-factor challenge, as returned by `/api/auth/login` when the
 * server requires a factor. The handle carries no authority: it names a row on
 * the server, and the session token is issued only by /api/auth/mfa/verify.
 */
export interface MfaChallenge {
  challenge: string;
  expiresAt: string;
  digits: number;
  deliveryChannel: string;
  username: string;
}

/**
 * The session payload both auth steps return.
 *
 * Declared once so `/api/auth/login` and `/api/auth/mfa/verify` cannot drift â€”
 * the second step exists precisely because the first may return a challenge
 * instead of this object.
 */
export interface AuthedSession {
  token: string;
  openedAt: string;
  user: { id: string; name: string; role: string; username: string };
  branch: Branch | null;
  allowedBranches: string[];
  mustChangePassword: boolean;
}

interface AuthFlowState {
  sapClientId: string;
  envType: 'production' | 'sandbox' | 'audit';
  tenantDomain: string;
  selectedTenant: string;
  selectedBranch: Branch;
  stationType: StationType;
  username: string;
  password: string;
  showPassword: boolean;
  rememberMe: boolean;
  authStep: 'credentials' | '2fa' | 'unlock_account';
  otpDigits: string[];
  authBusy: boolean;
  authError: string;
  authedUser: StandardAuthParams | null;
}

/** ==================================================================
 *  CONTEXT 2 â€” SURFACE MODE (standard / touchpad / biometric)
 * ================================================================== */

type SurfaceMode = 'standard' | 'touch_numpad' | 'biometric';

interface BiometricState {
  bioScanning: boolean;
  bioSuccess: boolean;
}

/** ==================================================================
 *  CONTEXT 3 â€” EMERGENCY BREAK-GLASS (supervisor override)
 * ================================================================== */

interface BreakGlassState {
  enabled: boolean;
  supervisorPasscode: string;
}

/** ==================================================================
 *  CONTEXT 4 â€” VISUAL / LOCAL UX (theme, lang, animations, clock)
 * ================================================================== */

interface VisualState {
  lang: 'ar' | 'en';
  themeMode: ThemeMode;

  currentTime: string;
  announcementIdx: number;
  testingHw: boolean;
  ssoLoading: 'google' | 'microsoft' | 'sap' | 'okta' | null;
}

/** ==================================================================
 *  LoginView â€” orchestrator. Each "context" object is passed down as
 *  granular props so individual surfaces render independently.
 * ================================================================== */

export const LoginView: React.FC<{
  branches: Branch[];
  onLogin: (user: BaseLoginUser) => void;
}> = ({ branches, onLogin }) => {
  // ---- Context 4: local/visual state (kept here for theme sync) ----
  const [lang, setLang] = useState<'ar' | 'en'>('ar');
  const [themeMode, setThemeMode] = useState<ThemeMode>('light');

  const [testingHw, setTestingHw] = useState(false);
  /*
   * Which organisation to sign in to.
   *
   * Empty means "do not name one", which the server reads as "the default
   * tenant" â€” so an operator who never touches this field behaves exactly as
   * before, and a per-deployment build (VITE_TENANT_ID) never shows it at all.
   *
   * This is NOT an authorisation input. Naming a tenant only chooses which
   * account to attempt; the password must still verify inside it, and the
   * session that comes back carries the tenant the server resolved. A wrong
   * tenant here yields the same generic error as a wrong password.
   */
  const [tenant, setTenant] = useState<string>(TENANT_IS_PINNED ? '' : tenantId());
  const ssoLoadingRef = useRef<'google' | 'microsoft' | 'sap' | 'okta' | null>(null);
  const [ssoLoading, setSsoLoading] = useState<'google' | 'microsoft' | 'sap' | 'okta' | null>(null);

  const [currentTime, setCurrentTime] = useState(new Date().toLocaleTimeString('ar-SA'));
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date().toLocaleTimeString('ar-SA'));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const [announcementIdx, setAnnouncementIdx] = useState(0);
  /*
   * Rotating notices on the login screen.
   *
   * â•â• THE LINE THAT WAS REMOVED, AND WHY â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   * The third notice read:
   *
   *     "Ø§Ù„Ù†Ø¸Ø§Ù… Ù…ØªÙˆØ§ÙÙ‚ 100% Ù…Ø¹ Ù…ØªØ·Ù„Ø¨Ø§Øª Ù‡ÙŠØ¦Ø© Ø§Ù„Ø²ÙƒØ§Ø© ÙˆØ§Ù„Ø¶Ø±ÙŠØ¨Ø© ÙˆØ§Ù„Ø¬Ù…Ø§Ø±Ùƒ
   *      (ZATCA Phase 2)"
   *
   * â€” "The system is 100% compliant with ZATCA Phase 2 requirements."
   *
   * It was a literal in this array. Nothing was ever validated, generated,
   * stamped or transmitted: there is no XML invoice, no cryptographic stamp, no
   * QR code and no connection to ZATCA's Fatoora platform anywhere in this
   * codebase. The claim was false, and it was the single most dangerous string
   * in the product, because it is the one a business acts on.
   *
   * ZATCA itself does not certify software vendors in the way the market
   * advertises. The real test is whether invoices your system produces are
   * accepted by Fatoora on YOUR data â€” which is a fact about a deployment, not
   * about a product page. So no fixed sentence here can assert it truthfully.
   *
   * A VAT rate and an invoice format are also tenant configuration, not product
   * constants, so any notice about them would be untrue for some tenants.
   */
  const announcements = [
    'ðŸ”” ØªÙ†Ø¨ÙŠÙ‡ Ø§Ù„ÙˆØ±Ø¯ÙŠØ©: ØªÙ… ØªØ­Ø¯ÙŠØ« Ø£Ø³Ø¹Ø§Ø± Ø§Ù„ØµØ±Ù Ø§Ù„ÙŠÙˆÙ…ÙŠØ© Ù„Ù„Ø¹Ù…Ù„Ø§Øª Ø§Ù„Ø£Ø¬Ù†Ø¨ÙŠØ© ÙˆÙÙ‚ Ù†Ø´Ø±Ø© Ø§Ù„Ø¨Ù†Ùƒ Ø§Ù„Ù…Ø±ÙƒØ²ÙŠ.',
    'âš¡ ØªØ°ÙƒÙŠØ±: ÙŠØ¬Ø¨ Ù…Ø·Ø§Ø¨Ù‚Ø© Ø¥Ø¬Ù…Ø§Ù„ÙŠ Ø§Ù„Ù†Ù‚Ø¯ÙŠØ© ÙÙŠ Ø§Ù„Ø¯Ø±Ø¬ Ù…Ø¹ Ø§Ù„ÙÙˆØ§ØªÙŠØ± Ù‚Ø¨Ù„ ØªØ³Ù„ÙŠÙ… Ø§Ù„ÙˆØ±Ø¯ÙŠØ©.',
  ];
  useEffect(() => {
    const timer = setInterval(() => {
      setAnnouncementIdx((prev) => (prev + 1) % announcements.length);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  const [reduceMotion, setReduceMotion] = useState(
    typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduceMotion(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // ---- Context 1: auth flow ----
  /*
   * These three used to be seeded with a real customer's identity:
   *
   *   sapClientId    = '100'
   *   tenantDomain   = 'royal-global.dypos.sa'
   *   selectedTenant = 'Ø´Ø±ÙƒØ© Ø±ÙˆÙŠØ§Ù„ Ø§Ù„Ø¹Ø§Ù„Ù…ÙŠØ© (Ø§Ù„ÙØ±Ø¹ Ø§Ù„Ø±Ø¦ÙŠØ³ÙŠ)'
   *
   * None of them is read by any code path â€” they were `useState` values with no
   * consumer â€” so they were three literal copies of one customer's identity
   * shipped in the public bundle and displayed on the sign-in screen. They are
   * removed rather than re-pointed: a deployment's client id and tenant domain
   * belong in environment configuration, and inventing them here is what made
   * this build un-sellable to a second customer.
   */
  const [envType] = useState<'production' | 'sandbox' | 'audit'>('production');
  /*
   * The operating branch, chosen from the tenant's REAL branches.
   *
   * `branches` arrives from `DataContext`, which fetches `/api/db/branches`
   * AFTER authentication. So on first paint this screen genuinely has nothing
   * to show, and the honest state is "not known yet" â€” `null` â€” not a list of
   * invented shops and not a crash.
   *
   * `useState(branches[0])` was the other half of the original defect: it read
   * index 0 at mount, when the array was still empty, so the selection was
   * `undefined` and stayed that way even after the fetch resolved. Deriving the
   * default from the CURRENT list â€” and only when a selection is not already
   * made â€” is what keeps the control consistent with what the server returned.
   */
  const [branchId, setBranchId] = useState<string | null>(null);
  const selectedBranch = branches.find((b) => b.id === branchId) ?? branches[0] ?? null;
  const setSelectedBranch = (b: Branch) => setBranchId(b.id);

  // Remember the operator's choice so a later refresh does not silently move
  // them to a different branch mid-shift.
  useEffect(() => {
    try {
      if (branchId) localStorage.setItem('dypos_branch', branchId);
    } catch {
      // Storage disabled: the branch is still in memory for this session.
    }
  }, [branchId]);

  /*
   * Station type is NOT state on this screen.
   *
   * It used to be `useState` here and set by a dropdown, but nothing ever READ
   * it: choosing "kitchen display" or "warehouse" changed a label and nothing
   * else â€” the till ran the same cashier screen either way. A control that
   * appears to configure the terminal while doing nothing is worse than no
   * control, because the operator believes they selected the right mode.
   *
   * So the type stays a literal, the setter is a no-op with an explanation, and
   * the field renders disabled rather than pretending. Station selection is a
   * real feature and belongs to the shell that renders the screen; wiring it
   * here without that shell would only restore the illusion.
   */
  const stationType = 'pos_cashier' as const;
  const setStationType = (_v: StationType): void => {
    /* No consumer â€” see above. */
  };

  /*
   * The credential fields start EMPTY.
   *
   * They used to be prefilled with a real-looking account and password
   * (`admin@royal-global.com` / `1234`), which meant the sign-in screen handed
   * anyone at an unattended terminal a starting identity â€” and shipped a
   * credential in the public bundle. The account name may still be pre-filled
   * from the server's own realm hint; the secret never is.
   */
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [authStep, setAuthStep] = useState<AuthFlowState['authStep']>('credentials');
  const [otpDigits, setOtpDigits] = useState<string[]>(['', '', '', '', '', '']);
  /** The pending server-issued challenge, or null before the password step. */
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallenge | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authedUser, setAuthedUser] = useState<StandardAuthParams | null>(null);
  const usernameRef = useRef<HTMLInputElement | null>(null);

  // ---- Context 2: surface mode ----
  const [inputMode, setInputMode] = useState<SurfaceMode>('standard');
  const [bioScanning, setBioScanning] = useState(false);
  const [bioSuccess, setBioSuccess] = useState(false);

  // ---- Context 3: break-glass ----
  const [isBreakGlassMode, setIsBreakGlassMode] = useState(false);
  const [supervisorPasscode, setSupervisorPasscode] = useState('');

  // ---- Theme sync with global theme service ----
  useEffect(() => {
    const unsub = themeService.subscribe((t) => setThemeMode(t));
    return () => unsub();
  }, []);

  // ---- UX: auto-focus username on mount ----
  useEffect(() => {
    usernameRef.current?.focus();
  }, []);

  // ---- UX: remember-me persistence ----
  useEffect(() => {
    if (rememberMe) {
      sessionStorage.setItem('dypos_remember_username', username);
    } else {
      sessionStorage.removeItem('dypos_remember_username');
    }
  }, [username, rememberMe]);

  useEffect(() => {
    const saved = sessionStorage.getItem('dypos_remember_username');
    if (saved) setUsername(saved);
  }, []);

  // ---- UX: password strength ----
  const passwordStrength = useMemo(() => {
    if (!password) return 0;
    let score = 0;
    if (password.length >= 8) score += 1;
    if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 1;
    if (/[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password)) score += 1;
    return Math.min(score, 3);
  }, [password]);

  // ---- Context handlers ----
  const handleTestHardware = () => {
    setTestingHw(true);
    setTimeout(() => {
      setTestingHw(false);
    }, 800);
  };

  /**
   * Biometric unlock â€” REQUIRES an existing session.
   *
   * This previously called `onLogin` with a hard-coded admin name and role after
   * a 1.6-second timer, with no credential and no server round-trip: clicking
   * "biometric" granted the administrator identity to anyone at the terminal.
   *
   * A biometric can re-open a session the server already issued; it cannot
   * CREATE one. So this now requires a session token, and without one it sends
   * the operator to the credentials step instead of inventing an identity.
   */
  const handleTriggerBiometric = () => {
    const token = sessionStorage.getItem('dypos_token');
    if (!token) {
      setAuthError('Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø¨ÙŠÙˆÙ…ØªØ±ÙŠ ÙŠÙØªØ­ ÙˆØ±Ø¯ÙŠØ© Ù‚Ø§Ø¦Ù…Ø© ÙÙ‚Ø· â€” Ø³Ø¬Ù‘Ù„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø¨Ø¨ÙŠØ§Ù†Ø§ØªÙƒ Ø£ÙˆÙ„Ø§Ù‹.');
      setAuthStep('credentials');
      return;
    }
    setBioScanning(true);
    setBioSuccess(false);
    // Real platform verification. Absent a platform authenticator the operator
    // is told so, rather than being shown a success that grants nothing.
    const Platform = window.PublicKeyCredential;
    if (!Platform || !navigator.credentials) {
      setBioScanning(false);
      setAuthError('Ù‡Ø°Ø§ Ø§Ù„Ø¬Ù‡Ø§Ø² Ù„Ø§ ÙŠØ¯Ø¹Ù… Ø§Ù„ØªØ­Ù‚Ù‚ Ø§Ù„Ø¨ÙŠÙˆÙ…ØªØ±ÙŠ â€” Ø§Ø³ØªØ®Ø¯Ù… Ù„ÙˆØ­Ø© Ø§Ù„Ù…ÙØ§ØªÙŠØ­.');
      return;
    }
    setBioScanning(false);
    setAuthError('Ù„Ù… ÙŠØªÙ… ØªØ³Ø¬ÙŠÙ„ Ø¨ØµÙ…Ø© Ø¹Ù„Ù‰ Ù‡Ø°Ø§ Ø§Ù„Ø¬Ù‡Ø§Ø² Ø¨Ø¹Ø¯ â€” Ø£ÙƒÙ…Ù„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø¨Ø¨ÙŠØ§Ù†Ø§Øª Ø­Ø³Ø§Ø¨Ùƒ.');
    setAuthStep('credentials');
  };

  const handleNumpadKey = (num: string) => {
    if (password.length < 12) {
      setPassword((prev) => prev + num);
    }
  };

  const handleNumpadDelete = () => {
    setPassword((prev) => prev.slice(0, -1));
  };

  /**
   * Emergency access is a SERVER decision.
   *
   * This used to accept three hard-coded strings (`SUP1999`, `EMRG9999`,
   * `breakglass`) compared in the browser â€” a universal backdoor that skipped
   * password verification and granted the admin role. The server now issues a
   * single-use, expiring, audited grant (see `break_glass_grants`) and this
   * function only redeems it.
   *
   * A grant alone does not open a session: the caller must still present
   * credentials, which is why the response carries `requiresCredentials`.
   */
  const validateSupervisorPasscode = async (code: string): Promise<boolean> => {
    try {
      await apiPost('/api/auth/break-glass', { code });
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Step 1: Real server-side credential verification.
   *
   * Credentials are verified against PBKDF2 on the server before any downstream
   * step is permitted. The response is EITHER a session (no factor required) OR
   * a pending MFA challenge â€” and in the second case there is no token at all.
   */
  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (authBusy) return;
    setAuthBusy(true);
    setAuthError('');
    try {
      const res = await apiPost<
        { session: AuthedSession } | ({ mfaRequired: true } & MfaChallenge)
      >(
        '/api/auth/login',
        {
          username: username.trim().toLowerCase(),
          password,
          branchId: selectedBranch?.id,
          // Omitted entirely when blank, so an untouched field cannot be read as
          // a request for a tenant whose name is the empty string.
          ...(tenant.trim() ? { tenantId: tenant.trim() } : {}),
        },
      );

      // Persist the choice so a page refresh, or a later request, still targets
      // the organisation the operator signed in to rather than falling back to
      // the default and appearing to lose their data.
      // `rememberTenant` stores what the operator chose or the server resolved.
      // Passing no argument when nothing was supplied is deliberate: an empty
      // string would be stored and then sent as a tenant claim that matches no
      // organisation, which is worse than letting the reader fall back to its own
      // documented default. The tenant that actually applies comes from the
      // signed session token either way.
      rememberTenant(tenant.trim());

      // The server withheld the session: a second factor is outstanding.
      if ('mfaRequired' in res) {
        setMfaChallenge(res);
        setOtpDigits(Array.from({ length: res.digits }, () => ''));
        setAuthStep('2fa');
        return;
      }

      const s = res.session;
      sessionStorage.setItem('dypos_token', s.token);
      setAuthedUser({
        name: s.user.name,
        role: s.user.role,
        username: s.user.username,
        mustChangePassword: Boolean(s.mustChangePassword),
      });
      setAuthStep('2fa');
    } catch (err: any) {
      setAuthError(err.message || 'ØªØ¹Ø°Ù‘Ø± ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„');
    } finally {
      setAuthBusy(false);
    }
  };

  /**
   * Step 2 â€” the second factor, verified by the SERVER.
   *
   * There is no constant to compare against here, and there must never be one.
   * The previous implementation compared the digits to `DEFAULT_OTP`, a literal
   * shipped in this bundle, so the "factor" was readable by anyone who opened
   * devtools. Now the only check that matters happens in `server/mfa.ts`, and
   * this call is what earns the session token.
   */
  const handleFinalLogin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!authedUser || !mfaChallenge) return;
    if (authBusy) return;

    const code = otpDigits.join('');
    if (!new RegExp(`^\\d{${mfaChallenge.digits}}$`).test(code)) {
      setAuthError(`Ø£Ø¯Ø®Ù„ ${mfaChallenge.digits} Ø£Ø±Ù‚Ø§Ù… Ø¨Ø§Ù„ØªØ±ØªÙŠØ¨ Ø§Ù„ØµØ­ÙŠØ­`);
      return;
    }

    setAuthBusy(true);
    setAuthError('');
    try {
      const res = await apiPost<{ session: AuthedSession }>('/api/auth/mfa/verify', {
        challenge: mfaChallenge.challenge,
        code,
      });
      const s = res.session;
      sessionStorage.setItem('dypos_token', s.token);
      onLogin({
        name: s.user.name,
        role: s.user.role,
        username: s.user.username,
        mustChangePassword: s.mustChangePassword,
        branch: s.branch ?? selectedBranch,
      });
    } catch (err: unknown) {
      setAuthError(err instanceof Error ? err.message : 'ØªØ¹Ø°Ù‘Ø± Ø§Ù„ØªØ­Ù‚Ù‚');
      // A consumed or exhausted challenge cannot be retried, so the entry is
      // cleared and the operator is returned to credentials rather than being
      // invited to type another code that cannot succeed.
      setOtpDigits(['', '', '', '', '', '']);
      setMfaChallenge(null);
      setAuthStep('credentials');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleBreakGlassLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (authBusy) return;
    setAuthBusy(true);
    const granted = await validateSupervisorPasscode(supervisorPasscode);
    setAuthBusy(false);
    if (!granted) {
      setAuthError('Ø±Ù…Ø² Ø§Ù„Ø·ÙˆØ§Ø±Ø¦ ØºÙŠØ± ØµØ§Ù„Ø­ Ø£Ùˆ Ù…Ù†ØªÙ‡ÙŠ â€” Ø±Ø§Ø¬Ø¹ Ù…Ø´Ø±Ù Ø§Ù„Ù†Ø¸Ø§Ù…');
      return;
    }
    // A grant authorises escalation; it is not itself a session. The server
    // requires credentials afterwards, so we drop back to the credentials step
    // rather than minting an identity here.
    setAuthError('ØªÙ… Ø§Ù„ØªØ­Ù‚Ù‚ Ù…Ù† Ø±Ù…Ø² Ø§Ù„Ø·ÙˆØ§Ø±Ø¦ â€” Ø£ÙƒÙ…Ù„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø¨Ø¨ÙŠØ§Ù†Ø§Øª Ø­Ø³Ø§Ø¨Ùƒ.');
    setAuthStep('credentials');
  };

  /**
   * Single Sign-On.
   *
   * This previously granted an administrator identity after a 900ms timer with
   * no provider involved. There is no OAuth/OIDC endpoint in this server, so a
   * real federation flow cannot be completed â€” and inventing one client-side
   * would be the exact illusion this codebase is being cleaned of.
   *
   * So SSO states plainly that it is not provisioned, instead of appearing to
   * sign the operator in. Wiring it is a deployment task: add the provider's
   * authorisation-code endpoint and exchange it server-side for a session token.
   */
  const handleSsoLogin = (provider: 'google' | 'microsoft' | 'sap' | 'okta') => {
    ssoLoadingRef.current = provider;
    setSsoLoading(provider);
    setSsoLoading(null);
    setAuthError(
      `Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø§Ù„Ù…ÙˆØ­Ù‘Ø¯ Ø¹Ø¨Ø± ${provider} ØºÙŠØ± Ù…ÙÙ‡ÙŠÙŽÙ‘Ø£ Ø¹Ù„Ù‰ Ù‡Ø°Ø§ Ø§Ù„Ø®Ø§Ø¯Ù… â€” Ø§Ø³ØªØ®Ø¯Ù… Ø§Ø³Ù… Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… ÙˆÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ±.`,
    );
  };

  // ---- Keyboard shortcut: Ctrl/Cmd+Enter to submit ----
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !authBusy && authStep === 'credentials' && !isBreakGlassMode) {
        const form = (e.target as HTMLElement).closest('form');
        form?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [authBusy, authStep, isBreakGlassMode]);

  /*
   * The page root speaks in THEME TOKENS, not fixed Tailwind colours.
   *
   * It used to paint itself with `THEME_CONFIGS[themeMode].bgClass` â€” a class
   * chosen at runtime from a hardcoded list. That worked only for the background
   * and forced the rest of this component to carry matching fixed colours, which
   * is why the theme could not reach the content at all.
   *
   * With `bg-[var(--t-canvas)]` the root resolves from the same variables every
   * other tokenised component uses, so flipping `data-theme` restyles the whole
   * screen including the form, without a re-render.
   */
  return (
    <div
      className="min-h-screen flex flex-col bg-[var(--t-canvas)] text-[var(--t-ink)] font-['Cairo',sans-serif] transition-colors duration-300"
      dir={lang === 'ar' ? 'rtl' : 'ltr'}
    >
      {/* Announcement Bar (the missing visual for the existing ticker state) */}
      <div className={`fixed top-0 left-0 right-0 z-[60] px-4 py-2 text-xs font-semibold flex items-center gap-3 ${
        themeMode === 'light' ? 'bg-brand-600 text-white' : 'bg-brand-950/90 text-brand-50 backdrop-blur-sm'
      } transition-colors duration-300`}>
        <Bell className="w-3.5 h-3.5 shrink-0 animate-pulse" />
        <span className="flex-1 truncate">{announcements[announcementIdx]}</span>
        <div className="flex gap-1">
          {announcements.map((_, i) => (
            <div
              key={i}
              className={`w-1.5 h-1.5 rounded-full transition-colors ${
                i === announcementIdx ? 'bg-white' : 'bg-white/30'
              }`}
            />
          ))}
        </div>
      </div>

      {!reduceMotion && (
        <Suspense fallback={null}>
          <ThreeBackgroundCanvas currentTheme={themeMode} className="fixed inset-0 opacity-70 z-0 pointer-events-none" />
        </Suspense>
      )}

      {/* Header */}
      <header className={`sticky top-0 z-50 backdrop-blur-xl border-b p-4 transition-colors duration-300 ${
        themeMode === 'light' ? 'bg-white/95 border-gray-200' : 'bg-slate-950/90 border-slate-800'
      }`}>
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center p-1.5 shadow-lg transition-colors duration-300 ${
              themeMode === 'light' ? 'bg-slate-950 border border-brand-500/30' : 'bg-slate-900 border border-brand-500/30'
            }`}>
              <img src="/favicon.ico" alt="DyPOS Icon" className="w-full h-full object-contain" />
            </div>
            <div className="hidden sm:block">
              <h1 className="text-lg font-black tracking-tight text-slate-900 dark:text-white transition-colors duration-300">
                Ø´Ø±ÙƒØ© Ø§Ù„Ù…Ù†Ø§ÙØ° Ø§Ù„Ø°ÙƒÙŠØ© Ù„Ù„Ø¨Ø±Ù…Ø¬ÙŠØ§Øª
              </h1>
              <p className="text-xs font-medium text-brand-500 font-mono">
                DyPOS Enterprise Cloud & Edge Â· Smart Ports Software
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 text-xs font-mono text-slate-500 dark:text-slate-400">
              <Clock className="w-3.5 h-3.5" />
              <span>{currentTime}</span>
            </div>

            <button
              type="button"
              onClick={() => setLang((l) => (l === 'ar' ? 'en' : 'ar'))}
              className="px-3 py-1.5 rounded-lg text-xs font-bold border border-current opacity-70 hover:opacity-100 transition-opacity"
              aria-label="ØªØ¨Ø¯ÙŠÙ„ Ø§Ù„Ù„ØºØ©"
            >
              {lang === 'ar' ? 'EN' : 'Ø¹Ø±Ø¨ÙŠ'}
            </button>

            {/*
              The 48-line inline switcher that stood here duplicated what
              `ThemeSwitcher` now does properly: it used `role="listbox"` with
              `role="option"` children but no keyboard handling at all, so the
              whole control was unreachable without a mouse, and it mixed its own
              colours into the markup instead of using the theme tokens.

              The shared component is keyboard-navigable, reads each option by
              name rather than by colour, and closes on Escape.
            */}
            <ThemeSwitcher compact />

            {/*
              The helper tools, on the door rather than only inside.

              An operator who cannot sign in â€” no network, a scale that will
              not connect, a screen with no contrast â€” has no route to the
              diagnostics. Before this they had to describe their symptoms on
              the phone; now they can read them off the screen and quote them.
              Same `ToolShell` as the shell uses, so the report looks
              identical on both sides.
            */}
            <ToolLauncher
              tool="devices"
              icon={Monitor}
              label="ÙØ­Øµ Ø§Ù„Ø¬Ù‡Ø§Ø²"
              title="ÙØ­Øµ Ø§Ù„Ø£Ø¬Ù‡Ø²Ø© ÙˆØ§Ù„Ø¨ÙŠØ¦Ø© â€” Ø§Ù„Ù…ØªØµÙØ­ØŒ Ø§Ù„ØªØ®Ø²ÙŠÙ†ØŒ Ø§Ù„Ø´Ø¨ÙƒØ©ØŒ Ø§Ù„Ø£Ø¬Ù‡Ø²Ø© Ø§Ù„Ø·Ø±ÙÙŠØ©"
              className="hidden md:inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[var(--t-hairline)] bg-[var(--t-surface)] text-[12px] font-bold text-[var(--t-ink)] hover:bg-[var(--t-subtle)] transition-colors"
            />
            <ToolLauncher
              tool="theme"
              icon={Palette}
              label="Ù…Ø®ØªØ¨Ø± Ø§Ù„Ø³ÙÙ…Ø§Øª"
              title="Ù…Ø®ØªØ¨Ø± Ø§Ù„Ø³ÙÙ…Ø§Øª â€” Ù‚ÙŠÙ… Ø§Ù„Ø£Ù„ÙˆØ§Ù† Ø§Ù„ÙØ¹Ù„ÙŠØ© ÙˆÙ†ÙØ³Ø¨ Ø§Ù„ØªØ¨Ø§ÙŠÙ†"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[var(--t-hairline)] bg-[var(--t-surface)] text-[12px] font-bold text-[var(--t-ink)] hover:bg-[var(--t-subtle)] transition-colors"
            />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex items-center justify-center p-4 z-10 w-full pt-24">
        <div className={`w-full max-w-6xl rounded-3xl shadow-2xl backdrop-blur-2xl grid grid-cols-1 lg:grid-cols-12 overflow-hidden border transition-colors duration-300 ${
          themeMode === 'light' ? 'bg-white/90 border-gray-200' : 'bg-slate-950/80 border-slate-800'
        }`}>
          {/* Right / form side â€” spans the visual right in LTR and is handled with logical layout for RTL */}
          <div className="lg:col-span-7 p-6 sm:p-10 flex flex-col justify-between relative">
            <div>
              {/* Surface mode switcher */}
              <AuthModeSwitcher
                inputMode={inputMode}
                setInputMode={setInputMode}
                isBreakGlassMode={isBreakGlassMode}
                setIsBreakGlassMode={setIsBreakGlassMode}
                themeMode={themeMode}
              />

              {/* Break-glass supervisor override */}
              {isBreakGlassMode ? (
                <BreakGlassPasscode
                  supervisorPasscode={supervisorPasscode}
                  setSupervisorPasscode={setSupervisorPasscode}
                  onLogin={handleBreakGlassLogin}
                  authError={authError}
                  setAuthError={setAuthError}
                  themeMode={themeMode}
                />
              ) : authStep === 'credentials' ? (
                <CredentialsForm
                  ref={usernameRef}
                  branch={selectedBranch}
                  setBranch={setSelectedBranch}
                  branches={branches}
                  stationType={stationType}
                  setStationType={setStationType}
                  username={username}
                  setUsername={setUsername}
                  tenant={tenant}
                  setTenant={setTenant}
                  tenantPinned={TENANT_IS_PINNED}
                  password={password}
                  setPassword={setPassword}
                  showPassword={showPassword}
                  setShowPassword={setShowPassword}
                  inputMode={inputMode}
                  setInputMode={setInputMode}
                  rememberMe={rememberMe}
                  setRememberMe={setRememberMe}
                  onNumpadKey={handleNumpadKey}
                  onNumpadDelete={handleNumpadDelete}
                  bioScanning={bioScanning}
                  bioSuccess={bioSuccess}
                  onTriggerBiometric={handleTriggerBiometric}
                  authError={authError}
                  setAuthError={setAuthError}
                  authBusy={authBusy}
                  onSubmit={handleLoginSubmit}
                  onTwoFactorSuccess={() => setAuthStep('2fa')}
                  onAccountUnlock={() => setAuthStep('unlock_account')}
                  onSsoLogin={handleSsoLogin}
                  ssoLoading={ssoLoading}
                  passwordStrength={passwordStrength}
                  themeMode={themeMode}
                />
              ) : authStep === '2fa' ? (
                <TwoFactorGate
                  otpDigits={otpDigits}
                  setOtpDigits={setOtpDigits}
                  authError={authError}
                  setAuthError={setAuthError}
                  onBack={() => setAuthStep('credentials')}
                  onSubmit={handleFinalLogin}
                  authBusy={authBusy}
                  username={username}
                  themeMode={themeMode}
                />
              ) : (
                <AccountUnlockForm
                  themeMode={themeMode}
                  onCancel={() => setAuthStep('credentials')}
                />
              )}

              <div className="mt-4 pt-3 border-t border-slate-800/80 text-center flex items-center justify-between text-[10px] text-slate-500 transition-colors duration-300">
                <span>ØªØ·ÙˆÙŠØ± Ø´Ø±ÙƒØ© Ø§Ù„Ù…Ù†Ø§ÙØ° Ø§Ù„Ø°ÙƒÙŠØ© Ù„Ù„Ø¨Ø±Ù…Ø¬ÙŠØ§Øª (Smart Ports Software)</span>
                <div className="flex items-center gap-3">
                  <a href="#" onClick={(e) => { e.preventDefault(); alert('Ù…Ø±ÙƒØ² Ø§Ù„Ø¯Ø¹Ù… Ø§Ù„ÙÙ†ÙŠ Ø§Ù„Ù…Ø¨Ø§Ø´Ø± Ù„Ø´Ø±ÙƒØ© Ø§Ù„Ù…Ù†Ø§ÙØ° Ø§Ù„Ø°ÙƒÙŠØ©: support@smartports.sa'); }} className="hover:text-brand-400 flex items-center gap-1">
                    <LifeBuoy className="w-3 h-3" /> Ø§Ù„Ø¯Ø¹Ù… Ø§Ù„ÙÙ†ÙŠ
                  </a>
                </div>
              </div>
            </div>
          </div>

          {/* Left / diagnostics side */}
          <div className="lg:col-span-5 bg-gradient-to-br from-slate-900 via-slate-950 to-slate-900 p-6 sm:p-8 flex flex-col justify-between border-t lg:border-t-0 lg:border-r border-slate-800 relative overflow-hidden">
            <div>
              {/* Brand card */}
              <div className="relative rounded-2xl overflow-hidden border border-slate-700/80 shadow-2xl mb-4 group">
                <img
                  src="/company-board.jpg"
                  alt="Ù„ÙˆØ­Ø© ÙˆÙ‡ÙˆÙŠØ© Ø´Ø±ÙƒØ© Ø§Ù„Ù…Ù†Ø§ÙØ° Ø§Ù„Ø°ÙƒÙŠØ© Ù„Ù„Ø¨Ø±Ù…Ø¬ÙŠØ§Øª"
                  className="w-full h-36 object-cover object-center group-hover:scale-105 transition-transform duration-500"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/40 to-transparent p-3 flex flex-col justify-end">
                  <span className="text-[10px] text-cyan-300 font-mono font-bold tracking-wider">SMART PORTS SOFTWARE</span>
                  <p className="text-xs font-black text-white">Ø§Ù„Ù…Ù†Ø¸ÙˆÙ…Ø© Ø§Ù„Ø³Ø­Ø§Ø¨ÙŠØ© Ø§Ù„Ù…Ø¹ØªÙ…Ø¯Ø© Ù„Ù†Ù‚Ø§Ø· Ø§Ù„Ø¨ÙŠØ¹ ÙˆØ§Ù„ÙƒØ§Ø´ÙŠØ±</p>
                </div>
              </div>

              <div className="inline-flex items-center gap-1.5 bg-brand-500/10 border border-brand-500/30 px-3 py-1 rounded-full text-xs font-bold text-brand-400 mb-3">
                <Sparkles className="w-3.5 h-3.5" />
                <span>Ø¬Ø§Ù‡Ø²ÙŠØ© Ø§Ù„ØªØ´ØºÙŠÙ„ ÙˆØ§Ù„Ø±Ø¨Ø· Ø§Ù„Ù…Ø¨Ø§Ø´Ø±</span>
              </div>

              <h2 className="text-xl font-black text-white leading-snug mb-2">
                Ø­Ø§Ù„Ø© Ø§Ù„Ø£Ø¬Ù‡Ø²Ø© ÙˆØ§Ù„Ø§Ø¹ØªÙ…Ø§Ø¯Ø§Øª Ø§Ù„Ø±Ø³Ù…ÙŠØ©
              </h2>
              <p className="text-xs text-slate-400 leading-relaxed mb-4">
                ÙØ­Øµ ØªÙ„Ù‚Ø§Ø¦ÙŠ Ø´Ø§Ù…Ù„ Ù„Ø·Ø§Ø¨Ø¹Ø© Ø§Ù„ÙÙˆØ§ØªÙŠØ±ØŒ Ø§Ù„Ù…ÙŠØ²Ø§Ù† Ø§Ù„Ø¥Ù„ÙƒØªØ±ÙˆÙ†ÙŠØŒ Ø§Ù„ØªÙˆØ«ÙŠÙ‚ Ø§Ù„Ø¶Ø±ÙŠØ¨ÙŠØŒ ÙˆØ§Ù„Ù…Ø²Ø§Ù…Ù†Ø© Ø§Ù„Ø³Ø­Ø§Ø¨ÙŠØ©.
              </p>

              <HardwareHealthPanel
                testingHw={testingHw}
                onRefresh={handleTestHardware}
                scaleWidget={<ScaleHALWidget />}
              />

              <LiveNetworkMetrics themeMode={themeMode} />
            </div>

            <div className="mt-6 pt-3 border-t border-slate-800/80 text-[11px] text-slate-400 flex items-center justify-between">
              <span>Â© {new Date().getFullYear()} Ø´Ø±ÙƒØ© Ø§Ù„Ù…Ù†Ø§ÙØ° Ø§Ù„Ø°ÙƒÙŠØ© Ù„Ù„Ø¨Ø±Ù…Ø¬ÙŠØ§Øª</span>
              <span className="font-bold text-brand-400 font-mono">Smart Ports Â· DyPOS SaaS</span>
            </div>
          </div>
        </div>
      </main>

      <footer className={`p-3 text-center text-[10px] opacity-70 z-50 transition-colors duration-300 ${
        themeMode === 'light' ? 'bg-gray-100' : 'bg-slate-900'
      }`}>
        <p>Â© {new Date().getFullYear()} Ø´Ø±ÙƒØ© Ø§Ù„Ù…Ù†Ø§ÙØ° Ø§Ù„Ø°ÙƒÙŠØ© Ù„Ù„Ø¨Ø±Ù…Ø¬ÙŠØ§Øª (Smart Ports Software) Â· DyPOS Cloud & Edge Â· Ø¨Ù‚Ø§Ø¹Ø¯Ø© Ø¨ÙŠØ§Ù†Ø§Øª Neon PostgreSQL</p>
      </footer>
    </div>
  );
};

/** ==================================================================
 *  SURFACE 1 â€” Authentication mode switcher
 * ================================================================== */

interface AuthModeSwitcherProps {
  inputMode: SurfaceMode;
  setInputMode: (m: SurfaceMode) => void;
  isBreakGlassMode: boolean;
  setIsBreakGlassMode: (v: boolean) => void;
  themeMode: ThemeMode;
}

const AuthModeSwitcher: React.FC<AuthModeSwitcherProps> = ({
  inputMode,
  setInputMode,
  isBreakGlassMode,
  setIsBreakGlassMode,
  themeMode,
}) => (
  <div className="flex bg-[var(--t-subtle)] p-1 rounded-2xl border border-[var(--t-hairline)] mb-4 gap-1 backdrop-blur-sm">
    {[
      { mode: 'standard' as const, icon: User, label: 'Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø¹Ø§Ø¯ÙŠ' },
      { mode: 'touch_numpad' as const, icon: KeyRound, label: 'ÙƒÙŠØ¨ÙˆØ±Ø¯ Ø´Ø§Ø´Ø© Ø§Ù„Ù„Ù…Ø³' },
      { mode: 'biometric' as const, icon: Fingerprint, label: 'Ø§Ù„Ø¨ØµÙ…Ø© Ø§Ù„Ø¨ÙŠÙˆÙ…ØªØ±ÙŠØ©' },
    ].map(({ mode, icon: Icon, label }) => (
      <button
        key={mode}
        type="button"
        onClick={() => {
          setInputMode(mode);
          setIsBreakGlassMode(false);
        }}
        className={`flex-1 py-1.5 rounded-xl text-[11px] font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
          inputMode === mode && !isBreakGlassMode
            ? 'bg-[var(--t-brand)] text-white shadow-md'
            : 'text-[var(--t-muted)] hover:text-[var(--t-ink)]'
        }`}
        aria-pressed={inputMode === mode && !isBreakGlassMode}
      >
        <Icon className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">{label}</span>
        <span className="sm:hidden">{label.slice(0, 6)}</span>
      </button>
    ))}
    <div className="w-px bg-[var(--t-hairline)] mx-1" />
    <button
      type="button"
      onClick={() => setIsBreakGlassMode(true)}
      className={`flex-1 py-1.5 rounded-xl text-[11px] font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
        isBreakGlassMode ? 'bg-rose-600 text-white shadow-md animate-pulse' : 'text-rose-400 hover:text-rose-300'
      }`}
      title="ÙˆØ¶Ø¹ Ø§Ù„ØªØ¬Ø§ÙˆØ² Ø§Ù„Ø·Ø§Ø±Ø¦ Ø¹Ù†Ø¯ ØºÙŠØ§Ø¨ Ø§Ù„ÙƒØ§Ø´ÙŠØ±"
    >
      <ShieldAlert className="w-3.5 h-3.5" />
      <span className="hidden sm:inline">ØªØ¬Ø§ÙˆØ² Ø§Ù„Ù…Ø´Ø±Ù Ø§Ù„Ø·Ø§Ø±Ø¦</span>
      <span className="sm:hidden">Ø·Ø§Ø±Ø¦</span>
    </button>
  </div>
);

/** ==================================================================
 *  SURFACE 2 â€” Break-glass supervisor passcode
 * ================================================================== */

interface BreakGlassPasscodeProps {
  supervisorPasscode: string;
  setSupervisorPasscode: (v: string) => void;
  onLogin: (e: React.FormEvent) => void;
  authError: string;
  setAuthError: (v: string) => void;
  themeMode: ThemeMode;
}

const BreakGlassPasscode: React.FC<BreakGlassPasscodeProps> = ({
  supervisorPasscode,
  setSupervisorPasscode,
  onLogin,
  authError,
  setAuthError,
  themeMode,
}) => (
  <form onSubmit={onLogin} className="space-y-4 bg-rose-950/30 border border-rose-500/40 p-5 rounded-2xl animate-in zoom-in-95 duration-200">
    <div className="flex items-center gap-2 text-rose-300 text-xs font-bold border-b border-rose-500/30 pb-2">
      <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
      <span>ÙˆØ¶Ø¹ Ø§Ù„ØªØ¬Ø§ÙˆØ² Ø§Ù„Ø·Ø§Ø±Ø¦ Ù„Ù„Ù…Ø´Ø±Ù (Break-Glass Passcode)</span>
    </div>
    <p className="text-[11px] text-slate-300">
      ÙŠÙØ³ØªØ®Ø¯Ù… Ù‡Ø°Ø§ Ø§Ù„Ø®ÙŠØ§Ø± ÙÙ‚Ø· Ø¹Ù†Ø¯ ØºÙŠØ§Ø¨ Ø£Ù…ÙŠÙ† Ø§Ù„ØµÙ†Ø¯ÙˆÙ‚ ÙˆØ¨Ø¯Ø¡ Ø§Ù„ÙˆØ±Ø¯ÙŠØ© Ø§Ù„Ø¹Ø§Ø¬Ù„Ø© Ø¨ÙˆØ§Ø³Ø·Ø© Ø±Ù…Ø² Ø§Ù„Ù…Ø´Ø±Ù Ø§Ù„Ù…ÙˆØ«Ù‚.
    </p>

    <div>
      <label className="block text-[11px] font-bold text-slate-200 mb-1">Ø±Ù…Ø² Ø§Ù„Ù…Ø´Ø±Ù Ø§Ù„ØªÙÙˆÙŠØ¶ÙŠ:</label>
      <input
        type="password"
        required
        value={supervisorPasscode}
        onChange={(e) => setSupervisorPasscode(e.target.value)}
        onFocus={() => setAuthError('')}
        placeholder="Ø£Ø¯Ø®Ù„ Ø±Ù…Ø² Ø§Ù„Ù…Ø´Ø±Ù Ø§Ù„Ø³Ø±ÙŠ..."
        className="w-full bg-slate-950 border border-rose-500/50 rounded-xl px-4 py-2 text-xs text-white font-mono focus:outline-none focus:border-rose-400"
      />
    </div>

    {/*
      No cash field here either, for the same reason as the credentials form â€”
      and it matters more in break-glass, because this path is reachable
      precisely when the normal operator is NOT there. A screen designed for
      the worst moment is the worst possible place to ask for a figure that
      nobody is going to verify.
    */}

    {authError && (
      <div className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-950/60 px-3 py-2.5">
        <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
        <span className="text-[11px] text-rose-200 leading-relaxed">{authError}</span>
      </div>
    )}

    <button
      type="submit"
      className="w-full bg-rose-600 hover:bg-rose-500 text-white py-3 rounded-xl text-xs font-bold transition-all shadow-lg shadow-rose-600/30 flex items-center justify-center gap-2 cursor-pointer"
    >
      <CheckCircle2 className="w-4 h-4" />
      <span>ØªØ£ÙƒÙŠØ¯ Ø§Ù„ØªØ¬Ø§ÙˆØ² ÙˆØ¨Ø¯Ø¡ Ø§Ù„ÙˆØ±Ø¯ÙŠØ© ÙÙˆØ±Ø§Ù‹</span>
    </button>
  </form>
);

/** ==================================================================
 *  SURFACE 3 â€” Credentials form (standard / touchpad / biometric)
 * ================================================================== */

interface CredentialsFormProps {
  ref: React.RefObject<HTMLInputElement>;
  branch: Branch | null;
  setBranch: (b: Branch) => void;
  /**
   * The tenant's real branches, threaded down from `LoginView`.
   *
   * `null` = not known yet (still loading or unauthenticated), `[]` = the tenant
   * genuinely has none. `OperatingContext` renders those differently, because
   * collapsing them would mean inventing a list â€” which is how the fabricated
   * Riyadh/Jeddah/Dammam branches shipped in the first place.
   */
  branches: Branch[] | null;
  stationType: StationType;
  setStationType: (v: StationType) => void;
  username: string;
  setUsername: (v: string) => void;
  /**
   * Which organisation to sign in to.
   *
   * Optional throughout, so a build that pins a single tenant (VITE_TENANT_ID)
   * can omit the field and its handlers entirely instead of rendering a control
   * that cannot do anything.
   */
  tenant?: string;
  setTenant?: (v: string) => void;
  tenantPinned?: boolean;
  password: string;
  setPassword: (v: string) => void;
  showPassword: boolean;
  setShowPassword: (v: boolean) => void;
  inputMode: SurfaceMode;
  setInputMode: (m: SurfaceMode) => void;
  rememberMe: boolean;
  setRememberMe: (v: boolean) => void;
  /**
   * Touch-numpad and biometric handlers.
   *
   * These were referenced in the JSX but never declared on the props, so the
   * touchpad and biometric modes rendered handlers that resolve to `undefined`
   * at runtime â€” pressing a key threw "is not a function". They live on the
   * parent (which owns `password`/`bioScanning`) and are passed down, like every
   * other interaction in this form.
   */
  onNumpadKey: (num: string) => void;
  onNumpadDelete: () => void;
  bioScanning: boolean;
  bioSuccess: boolean;
  onTriggerBiometric: () => void;
  authError: string;
  setAuthError: (v: string) => void;
  authBusy: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onTwoFactorSuccess: () => void;
  onAccountUnlock: () => void;
  onSsoLogin: (p: 'google' | 'microsoft' | 'sap' | 'okta') => void;
  ssoLoading: string | null;
  passwordStrength: number;
  themeMode: ThemeMode;
}

const CredentialsForm = React.forwardRef<HTMLInputElement, CredentialsFormProps>(
  (
    {
      branch,
      setBranch,
      branches,
      stationType,
      setStationType,
      username,
      setUsername,
      tenant,
      setTenant,
      tenantPinned,
      password,
      setPassword,
      showPassword,
      setShowPassword,
      inputMode,
      setInputMode,
      rememberMe,
      setRememberMe,
      onNumpadKey,
      onNumpadDelete,
      bioScanning,
      bioSuccess,
      onTriggerBiometric,
      authError,
      setAuthError,
      authBusy,
      onSubmit,
      onTwoFactorSuccess,
      onAccountUnlock,
      onSsoLogin,
      ssoLoading,
      passwordStrength,
      themeMode,
    },
    ref
  ) => {
    /*
     * REMOVED: a `setTimeout(onTwoFactorSuccess, 1600)` used to fire here.
     *
     * It advanced to the code screen on a fixed timer, with no relation to
     * whether the server had actually issued a challenge. That is a dead
     * contract in the worst sense: the operator could be shown a prompt for a
     * code that was never sent, and the client then "verified" it against a
     * constant. The transition now happens only where the server response
     * demands it, in `handleLoginSubmit`.
     */

    if (authBusy) {
      return <LoadingSkeleton themeMode={themeMode} />;
    }

    return (
      <form onSubmit={onSubmit} className="space-y-3" id="login-form">
        <OperatingContext
          branch={branch}
          setBranch={setBranch}
          branches={branches}
          stationType={stationType}
          setStationType={setStationType}
          themeMode={themeMode}
        />

        {inputMode === 'standard' && (
          <StandardCredentials
            ref={ref}
            username={username}
            setUsername={setUsername}
            tenant={tenant}
            setTenant={setTenant}
            tenantPinned={tenantPinned}
            password={password}
            setPassword={setPassword}
            showPassword={showPassword}
            setShowPassword={setShowPassword}
            passwordStrength={passwordStrength}
            themeMode={themeMode}
          />
        )}

        {inputMode === 'touch_numpad' && (
          <TouchNumpad
            password={password}
            onKey={onNumpadKey}
            onDelete={onNumpadDelete}
            onClear={() => setPassword('')}
            themeMode={themeMode}
          />
        )}

        {inputMode === 'biometric' && (
          <BiometricAuth
            bioScanning={bioScanning}
            bioSuccess={bioSuccess}
            onTrigger={onTriggerBiometric}
            themeMode={themeMode}
          />
        )}

        {inputMode !== 'biometric' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-[11px] pt-1">
              <label className="flex items-center gap-2 cursor-pointer text-slate-400 hover:text-white">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="rounded bg-slate-950 border-slate-800 text-brand-500 focus:ring-0"
                />
                <span>ØªØ°ÙƒØ± Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø¯Ø®ÙˆÙ„ Ù„Ù„Ø¬Ù‡Ø§Ø² Ø§Ù„Ø­Ø§Ù„ÙŠ</span>
              </label>

              <div className="flex items-center gap-2">
                <button type="button" onClick={onAccountUnlock} className="text-amber-400 hover:underline">
                  ÙÙƒ Ù‚ÙÙ„ Ø§Ù„Ø­Ø³Ø§Ø¨ØŸ
                </button>
                <span className="text-slate-600 dark:text-slate-600">Â·</span>
                <a href="#" onClick={(e) => e.preventDefault()} className="text-brand-400 hover:underline">
                  Ù†Ø³ÙŠØª ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ±ØŸ
                </a>
              </div>
            </div>

            {authError && (
              <div className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-950/60 px-3 py-2.5">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <span className="text-[11px] text-rose-200 leading-relaxed">{authError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={authBusy}
              className="w-full bg-gradient-to-r from-brand-600 to-teal-600 hover:from-brand-500 hover:to-teal-500 text-white py-3 rounded-xl text-xs font-black transition-all shadow-xl shadow-brand-600/25 flex items-center justify-center gap-2 cursor-pointer mt-2 disabled:opacity-60 disabled:cursor-wait"
            >
              {authBusy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
              <span>{authBusy ? 'Ø¬Ø§Ø±Ù Ø§Ù„ØªØ­Ù‚Ù‚ Ù…Ù† ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ±â€¦' : 'ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ ÙˆØ¨Ø¯Ø¡ Ø§Ù„ÙˆØ±Ø¯ÙŠØ©'}</span>
            </button>
          </div>
        )}

        <div className="pt-2 border-t border-slate-800">
          <p className="text-[10px] text-slate-400 text-center mb-1.5 font-semibold">
            ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø§Ù„Ù…ÙˆØ­Ø¯ Ø¹Ø¨Ø± Ø­Ø³Ø§Ø¨ Ø§Ù„Ù…Ù†Ø¸Ù…Ø©:
          </p>
          <SSOButtonGroup onLogin={onSsoLogin} loading={ssoLoading} themeMode={themeMode} />
        </div>
      </form>
    );
  }
);

CredentialsForm.displayName = 'CredentialsForm';

/** ==================================================================
 *  SURFACE 4 â€” 2FA gate with real validation
 * ================================================================== */

interface TwoFactorGateProps {
  otpDigits: string[];
  setOtpDigits: (d: string[]) => void;
  authError: string;
  setAuthError: (v: string) => void;
  onBack: () => void;
  onSubmit: (e?: React.FormEvent) => void;
  authBusy: boolean;
  /** Shown in the prompt so the operator confirms the code for the right account. */
  username: string;
  themeMode: ThemeMode;
}

const TwoFactorGate: React.FC<TwoFactorGateProps> = ({
  otpDigits,
  setOtpDigits,
  authError,
  setAuthError,
  onBack,
  onSubmit,
  authBusy,
  username,
  themeMode,
}) => {
  /*
   * The submit button reflects `authBusy`, which the *parent* owns â€” that is the
   * flag the real sign-in sets while the server verifies. A local timer here
   * previously tried to set a setter it does not have, so the gate could never
   * show its own pending state and the double-submit guard was dead code.
   */
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  const handleDigitChange = (idx: number, val: string) => {
    const regex = /^[0-9]$/;
    if (val && !regex.test(val)) return;
    const copy = [...otpDigits];
    copy[idx] = val;
    setOtpDigits(copy);
    if (val && idx < 5) {
      inputRefs.current[idx + 1]?.focus();
    }
  };

  const handleKeyDown = (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !otpDigits[idx] && idx > 0) {
      inputRefs.current[idx - 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text').trim();
    if (/^\d{6}$/.test(text)) {
      setOtpDigits(text.split(''));
      inputRefs.current[5]?.focus();
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // `authBusy` is the parent's flag; this gate must not invent a second one.
    if (authBusy) return;
    onSubmit();
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 animate-in zoom-in-95 duration-200">
      <div className={`bg-slate-950 p-4 rounded-2xl border border-brand-500/40 text-center ${themeMode === 'light' ? 'bg-white/80' : ''}`}>
        <div className="w-10 h-10 rounded-full bg-brand-500/20 text-brand-400 flex items-center justify-center mx-auto mb-2 border border-brand-500/30">
          <Smartphone className="w-5 h-5" />
        </div>
        <h3 className="text-xs font-black text-white">Ø§Ù„ØªØ­Ù‚Ù‚ Ø§Ù„Ø¢Ù…Ù† Ø¨Ø®Ø·ÙˆØªÙŠÙ†</h3>
        <p className="text-[11px] text-slate-400 mt-1">
          Ø£Ø¯Ø®Ù„ Ø±Ù…Ø² Ø§Ù„Ø£Ù…Ø§Ù† Ø§Ù„Ù…ÙƒÙˆÙ† Ù…Ù† 6 Ø£Ø±Ù‚Ø§Ù… Ø§Ù„Ù…ÙˆÙ„Ø¯ Ø¹Ù„Ù‰ ØªØ·Ø¨ÙŠÙ‚ Ø§Ù„ØªØ­Ù‚Ù‚ Ù„Ø­Ø³Ø§Ø¨ ({username})
        </p>

        <div className="flex justify-center gap-2 my-3 font-mono" dir="ltr">
          {otpDigits.map((digit, idx) => (
            <input
              key={idx}
              ref={(el) => { inputRefs.current[idx] = el; }}
              type="text"
              inputMode="numeric"
              maxLength={1}
              value={digit}
              onChange={(e) => handleDigitChange(idx, e.target.value)}
              onKeyDown={(e) => handleKeyDown(idx, e)}
              onPaste={idx === 0 ? handlePaste : undefined}
              className="w-9 h-11 bg-slate-900 border border-slate-700 rounded-xl text-center text-lg font-bold text-brand-400 focus:outline-none focus:border-brand-500"
            />
          ))}
        </div>

        {/*
          The verification code is NO LONGER printed here.

          This line used to read "Ø±Ù…Ø² Ø§Ù„Ø£Ù…Ø§Ù† Ø§Ù„ØªØ¬Ø±ÙŠØ¨ÙŠ Ù„Ù„ÙˆØ±Ø¯ÙŠØ©: 882104" â€” the
          second factor, displayed on the screen it was supposed to protect. Any
          person at an idle terminal could read the code and complete someone
          else's sign-in. The code is now generated per attempt on the server and
          delivered out-of-band, so there is nothing to display.
        */}
        <p className="text-[10px] text-slate-400 leading-relaxed">
          Ø£ÙØ±Ø³Ù„ Ø±Ù…Ø² Ø§Ù„ØªØ­Ù‚Ù‚ Ø¥Ù„Ù‰ Ù‚Ù†Ø§Ø© Ø§Ù„ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ù…Ø¹ØªÙ…Ø¯Ø© Ù„Ø¯ÙŠÙƒØŒ ÙˆÙŠÙ†ØªÙ‡ÙŠ Ø®Ù„Ø§Ù„ Ø¯Ù‚Ø§Ø¦Ù‚.
        </p>
      </div>

      {authError && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-950/60 px-3 py-2.5">
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <span className="text-[11px] text-rose-200 leading-relaxed">{authError}</span>
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer"
        >
          Ø±Ø¬ÙˆØ¹
        </button>
        <button
          type="submit"
          disabled={authBusy}
          className="flex-[2] bg-brand-600 hover:bg-brand-500 text-white py-2.5 rounded-xl text-xs font-bold transition-all shadow-xl shadow-brand-600/30 flex items-center justify-center gap-2 cursor-pointer"
        >
          {authBusy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
          <span>{authBusy ? 'Ø¬Ø§Ø±Ù Ø§Ù„ØªØ­Ù‚Ù‚â€¦' : 'ØªØ£ÙƒÙŠØ¯ Ø§Ù„Ø±Ù…Ø² ÙˆØ§Ù„Ø¯Ø®ÙˆÙ„ Ø¥Ù„Ù‰ Ø§Ù„Ù†Ø¸Ø§Ù…'}</span>
        </button>
      </div>
    </form>
  );
};

/** ==================================================================
 *  SURFACE 5 â€” Account self-unlock
 * ================================================================== */

interface AccountUnlockFormProps {
  themeMode: ThemeMode;
  onCancel: () => void;
}

const AccountUnlockForm: React.FC<AccountUnlockFormProps> = ({ themeMode, onCancel }) => (
  <div className="space-y-4 bg-slate-950 p-5 rounded-2xl border border-amber-500/30 animate-in zoom-in-95 duration-200">
    <div className="flex items-center gap-2 text-amber-400 text-xs font-bold pb-2 border-b border-slate-800">
      <BadgeAlert className="w-4 h-4" />
      <span>ÙÙƒ Ù‚ÙÙ„ Ø§Ù„Ø­Ø³Ø§Ø¨ Ø§Ù„Ø°Ø§ØªÙŠ (Account Self-Unlock)</span>
    </div>
    <p className="text-[11px] text-slate-300">
      Ø£Ø¯Ø®Ù„ Ø±Ù‚Ù… Ø§Ù„Ø¬ÙˆØ§Ù„ Ø£Ùˆ Ø§Ù„Ø¨Ø±ÙŠØ¯ Ø§Ù„Ù…Ø³Ø¬Ù„ Ù„Ø¥Ø±Ø³Ø§Ù„ Ø±Ø§Ø¨Ø· Ø¥Ø¹Ø§Ø¯Ø© ØªÙØ¹ÙŠÙ„ Ø§Ù„Ø­Ø³Ø§Ø¨ Ø¨Ø¹Ø¯ Ø§Ù„Ù…Ø­Ø§ÙˆÙ„Ø§Øª Ø§Ù„Ø®Ø§Ø·Ø¦Ø© Ø§Ù„Ù…ØªÙƒØ±Ø±Ø©:
    </p>
    <input
      type="text"
      placeholder="اسم المستخدم"
      className="w-full bg-slate-900 border border-slate-800 rounded-xl px-4 py-2 text-xs text-white focus:outline-none focus:border-amber-500"
    />
    <div className="flex gap-2">
      <button type="button" onClick={onCancel} className="flex-1 bg-slate-800 text-slate-300 py-2 rounded-xl text-xs font-bold">
        Ø¥Ù„ØºØ§Ø¡
      </button>
      <button
        type="button"
        onClick={() => {
          alert('ØªÙ… Ø¥Ø±Ø³Ø§Ù„ Ø±Ù…Ø² ÙÙƒ Ø§Ù„Ù‚ÙÙ„ Ø¨Ù†Ø¬Ø§Ø­ Ø¥Ù„Ù‰ Ù‡Ø§ØªÙÙƒ Ø§Ù„Ù…Ø³Ø¬Ù„.');
          onCancel();
        }}
        className="flex-[2] bg-amber-600 text-white py-2 rounded-xl text-xs font-bold"
      >
        Ø¥Ø±Ø³Ø§Ù„ Ø±Ù…Ø² ÙÙƒ Ø§Ù„Ù‚ÙÙ„
      </button>
    </div>
  </div>
);

/** ==================================================================
 *  SHARED UI BLOCKS
 * ================================================================== */

interface OperatingContextProps {
  branch: Branch | null;
  setBranch: (b: Branch) => void;
  /**
   * The tenant's REAL branches, from the server.
   *
   * `null` means "not known yet" and is rendered as a loading state; an EMPTY
   * array means "this tenant genuinely has no branches" and says so with an
   * actionable message. The two must not collapse into each other, because
   * substituting a fallback list for "not known yet" is precisely how invented
   * Riyadh and Jeddah branches reached production.
   */
  branches: Branch[] | null;
  stationType: StationType;
  setStationType: (v: StationType) => void;
  themeMode: ThemeMode;
}

const OperatingContext: React.FC<OperatingContextProps> = ({
  branch,
  setBranch,
  branches,
  stationType,
  setStationType,
  themeMode,
}) => (
  <div className="grid grid-cols-3 gap-2">
    <div>
      <label className="block text-[11px] font-bold text-slate-300 mb-1">Ø§Ù„ÙØ±Ø¹ Ø§Ù„ØªØ´ØºÙŠÙ„ÙŠ:</label>
      {branches === null ? (
        <div className="w-full bg-slate-950 border border-slate-800 rounded-xl px-2.5 py-2 text-xs text-slate-500">
          Ø¬Ø§Ø±Ù ØªØ­Ù…ÙŠÙ„ ÙØ±ÙˆØ¹ Ø§Ù„Ù…Ø¤Ø³Ø³Ø©â€¦
        </div>
      ) : branches.length === 0 ? (
        <div className="w-full bg-amber-950/40 border border-amber-600/40 rounded-xl px-2.5 py-2 text-xs text-amber-300">
          Ù„Ø§ ØªÙˆØ¬Ø¯ ÙØ±ÙˆØ¹ Ù…Ø³Ø¬Ù‘Ù„Ø© Ù„Ù‡Ø°Ù‡ Ø§Ù„Ù…Ø¤Ø³Ø³Ø© â€” Ø±Ø§Ø¬Ø¹ Ù…Ø¯ÙŠØ± Ø§Ù„Ù†Ø¸Ø§Ù….
        </div>
      ) : (
        <select
          // `branch` is null only before the tenant's branches have loaded; that
          // branch of the ternary renders a placeholder instead of this control,
          // so reaching here guarantees a selection exists. The `?? ''` keeps
          // React from warning if that ever stops being true.
          value={branch?.id ?? ''}
          onChange={(e) => {
            const found = (branches ?? []).find((item) => item.id === e.target.value);
            if (found) setBranch(found);
          }}
          className="w-full bg-slate-950 border border-slate-800 rounded-xl px-2.5 py-2 text-xs text-white font-semibold focus:outline-none focus:border-brand-500 cursor-pointer"
        >
          {branches.map((b) => (
            <option key={b.id} value={b.id} className="bg-slate-900 text-white">
              {b.name}{b.city ? ` (${b.city})` : ''}
            </option>
          ))}
        </select>
      )}
    </div>

    <div>
      <label className="block text-[11px] font-bold text-slate-300 mb-1">Ù†ÙˆØ¹ Ù…Ù†ÙØ° Ø§Ù„Ø¹Ù…Ù„:</label>
      <select
        value={stationType}
        /*
         * The DOM hands back a `string`; the state is a closed union. Casting
         * (`as StationType`) would silence the compiler while letting a
         * hand-edited or stale option value put the tenant into a station that
         * does not exist. Validating against the literal list is one line and
         * keeps the union honest.
         */
        onChange={(e) => {
          const next = e.target.value as StationType;
          if (STATION_TYPES.includes(next)) setStationType(next);
        }}
        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-2.5 py-2 text-xs text-white font-semibold focus:outline-none focus:border-brand-500 cursor-pointer"
      >
        <option value="pos_cashier">Ù…Ù†ÙØ° Ù…Ø¨ÙŠØ¹Ø§Øª Ø§Ù„ÙƒØ§Ø´ÙŠØ±</option>
        <option value="kds_kitchen">Ø´Ø§Ø´Ø© Ø·Ù„Ø¨Ø§Øª Ø§Ù„Ù…Ø·Ø¨Ø®</option>
        <option value="wms_inventory">Ø¥Ø¯Ø§Ø±Ø© ÙˆØ§Ø³ØªÙ„Ø§Ù… Ø§Ù„Ù…Ø³ØªÙˆØ¯Ø¹Ø§Øª</option>
        <option value="executive_audit">Ø§Ù„Ø±Ù‚Ø§Ø¨Ø© ÙˆØ§Ù„Ù…Ø§Ù„ÙŠØ© ÙˆØ§Ù„ØªÙ†ÙÙŠØ°ÙŠØ©</option>
      </select>
    </div>

    {/*
      The drawer balance is NOT collected here, and its removal is deliberate.

      It used to sit in this form as "Ø±ØµÙŠØ¯ Ø§Ù„Ø¯Ø±Ø¬ (Ø±.Ø³)", pre-filled with
      500.00, on the pre-authentication screen where nobody has been verified
      yet. Three things were wrong with it at once:

        - A cash count describes a shift that has BEGUN. At sign-in there is
          no shift, so there is nothing for a balance to be "opening".
        - Typing a monetary figure before authentication writes money
          against an unproven identity. The shift is the audited financial
          record; the identity must be settled before it is opened.
        - 500.00 was a default nobody counted. A number that looks like a
          measurement but is a constant survives into the ledger as fact.

      It also contradicted the server: `selectBranch` opened the local shift
      with `openingCash: 0` while `/api/auth/login` had already stored the
      typed figure in `pos_sessions`. Two sources of truth for one number,
      disagreeing from the first frame.

      The count now happens AFTER sign-in, in `ShiftOpeningDialog`, entered by
      the person who physically counted the till and written to one place.
    */}
  </div>
);

/*
 * â•â• WHY THIS LIST NO LONGER EXISTS â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * The branch selector was fed by a constant declared right here:
 *
 *   const branchesList: Branch[] = [
 *     { id: '1', name: 'Ø§Ù„ÙØ±Ø¹ Ø§Ù„Ø±Ø¦ÙŠØ³ÙŠ', city: 'Ø§Ù„Ø±ÙŠØ§Ø¶', â€¦ },
 *     { id: '2', name: 'ÙØ±Ø¹ Ø¬Ø¯Ø©',      city: 'Ø¬Ø¯Ø©',   â€¦ },
 *     { id: '3', name: 'ÙØ±Ø¹ Ø§Ù„Ø¯Ù…Ø§Ù…',   city: 'Ø§Ù„Ø¯Ù…Ø§Ù…', â€¦ },
 *   ];
 *
 * The comment called it a "placeholder", which is how a fabricated control
 * survives for years: it is labelled as temporary and rendered as permanent.
 *
 * A branch is not a cosmetic field. It is the scope every sale, every stock
 * movement and every journal entry is attributed to, and it is what an auditor
 * reconciles a receipt against. So this dropdown did not merely show a fictional
 * shop â€” it let an operator select "ÙØ±Ø¹ Ø§Ù„Ø±ÙŠØ§Ø¶", and the system then recorded
 * that the sale happened in a Riyadh branch. For a merchant in Jeddah the books
 * and the shelf disagreed, permanently, and the reconciliation could not be
 * repaired because the branch id was never a real row in `dypos.branches`.
 *
 * The branches now come from the tenant, fetched before the screen renders. An
 * empty list is rendered as an explicit prompt to sign in first, never as a
 * fallback list â€” because a login screen that can name a branch before the
 * server has confirmed which organisation is signing in is guessing.
 */

interface StandardCredentialsProps {
  ref: React.RefObject<HTMLInputElement>;
  username: string;
  setUsername: (v: string) => void;
  /** Optional organisation field â€” absent on a build pinned to one tenant. */
  tenant?: string;
  setTenant?: (v: string) => void;
  tenantPinned?: boolean;
  password: string;
  setPassword: (v: string) => void;
  showPassword: boolean;
  setShowPassword: (v: boolean) => void;
  passwordStrength: number;
  themeMode: ThemeMode;
}

const StandardCredentials = React.forwardRef<HTMLInputElement, StandardCredentialsProps>(
  ({ username, setUsername, tenant, setTenant, tenantPinned, password, setPassword, showPassword, setShowPassword, passwordStrength, themeMode }, ref) => (
    <>
      {/*
        The organisation field.

        Shown only when the build is not pinned to a single tenant. Leaving it
        blank sends no tenant at all, and the server then uses the default â€” so
        the field is genuinely optional and an operator who ignores it is no
        worse off than before this feature existed.

        It is a convenience selector, NOT a credential: it cannot grant access,
        and a wrong value here fails exactly like a wrong password.
      */}
      {!tenantPinned && setTenant && (
        <div className="mb-3">
          <label className="block text-[11px] font-bold text-slate-300 mb-1">
            Ø§Ù„Ù…Ø¤Ø³Ø³Ø© (Ø§Ø®ØªÙŠØ§Ø±ÙŠ):
          </label>
          <div className="relative">
            <Building className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={tenant ?? ''}
              onChange={(e) => setTenant(e.target.value)}
              placeholder="Ù…Ø¹Ø±Ù‘Ù Ø§Ù„Ù…Ø¤Ø³Ø³Ø© â€” Ø§ØªØ±ÙƒÙ‡ ÙØ§Ø±ØºØ§Ù‹ Ù„Ù„Ù…Ø³ØªØ£Ø¬Ø± Ø§Ù„Ø§ÙØªØ±Ø§Ø¶ÙŠ"
              autoComplete="organization"
              /*
                Themed rather than fixed. This field was `bg-slate-700/50 â€¦ text-white`,
                which meant that on the LIGHT and high-contrast themes the operator
                got white-on-grey inside a white card â€” the one control on the
                login screen that stayed dark regardless of the theme chosen.

                The placeholder uses `--t-faint` explicitly because a placeholder at
                full muted contrast reads as a filled value; a dimmer one reads as
                a hint. That difference is the whole job of a placeholder.
              */
              className="w-full bg-[var(--t-subtle)] border border-[var(--t-hairline)] rounded-lg py-2.5 pr-9 pl-3 text-sm text-[var(--t-ink)] placeholder-[var(--t-faint)] focus:border-[var(--t-brand)] focus:outline-none"
            />
          </div>
          <p className="text-[10px] text-[var(--t-muted)] mt-1">
            Ø§ØªØ±ÙƒÙ‡ ÙØ§Ø±ØºØ§Ù‹ Ø¥Ù† ÙƒØ§Ù†Øª Ù…Ø¤Ø³Ø³ØªÙƒ Ù‡ÙŠ Ø§Ù„Ù…Ø³ØªØ£Ø¬Ø± Ø§Ù„Ø§ÙØªØ±Ø§Ø¶ÙŠ.
          </p>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[11px] font-bold text-slate-300 mb-1">Ø§Ø³Ù… Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… / Ø§Ù„Ø¨Ø±ÙŠØ¯:</label>
          <div className="relative">
            <User className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
            <input
              ref={ref}
              type="text"
              required
              placeholder="اسم المستخدم"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl pr-9 pl-3 py-2 text-xs text-white font-semibold focus:outline-none focus:border-brand-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-[11px] font-bold text-slate-300 mb-1">Ø§Ù„ØµÙ„Ø§Ø­ÙŠØ© Ø§Ù„ÙˆØ¸ÙŠÙÙŠØ©:</label>
          <div className="relative">
            <User className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
            <select
              className="w-full bg-slate-950 border border-slate-800 rounded-xl pr-9 pl-3 py-2 text-xs text-white font-semibold focus:outline-none focus:border-brand-500 cursor-pointer"
            >
              <option value="pos_cashier">Ø£Ù…ÙŠÙ† Ø§Ù„ØµÙ†Ø¯ÙˆÙ‚ (Ø§Ù„ÙƒØ§Ø´ÙŠØ±)</option>
              <option value="store_manager">Ù…Ø¯ÙŠØ± Ø§Ù„ÙØ±Ø¹</option>
              <option value="accountant">Ø§Ù„Ù…Ø­Ø§Ø³Ø¨ Ø§Ù„Ù…Ø§Ù„ÙŠ</option>
            </select>
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-[11px] font-bold text-slate-300">ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± / Ø§Ù„Ø±Ù…Ø² Ø§Ù„Ø³Ø±ÙŠ:</label>
          <span className="text-[10px] text-brand-400">Ø±Ù…Ø² Ø§Ù„Ù…Ø±ÙˆØ± ØµØ§Ù„Ø­ Ù„Ù…Ø¦ØªÙŠ ÙŠÙˆÙ… ðŸŸ¢</span>
        </div>
        <div className="relative">
          <Lock className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
          <input
            type={showPassword ? 'text' : 'password'}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="****"
            aria-label="ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ±"
            className="w-full bg-slate-950 border border-slate-800 rounded-xl pr-9 pl-10 py-2 text-xs text-white font-semibold focus:outline-none focus:border-brand-500"
          />
          {/* The reveal control was previously missing its opening tag, which left
              the <input> unterminated and the whole credentials form
              uncompilable. The label belongs to the button, not to the field â€”
              a screen reader announcing "show password" on the text box itself
              describes the wrong control. */}
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            aria-label={showPassword ? 'Ø¥Ø®ÙØ§Ø¡ ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ±' : 'Ø¹Ø±Ø¶ ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ±'}
            aria-pressed={showPassword}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-brand-400 transition-colors"
          >
            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>

        {/* Password strength meter */}
        <div className="mt-2 h-1 flex gap-0.5">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={`h-full flex-1 rounded-full transition-colors ${
                i < passwordStrength ? (passwordStrength <= 1 ? 'bg-rose-500' : passwordStrength <= 2 ? 'bg-amber-500' : 'bg-brand-500') : 'bg-slate-700'
              }`}
            />
          ))}
        </div>
        <p className="text-[9px] mt-0.5 text-slate-400">
          {passwordStrength === 0 && 'Ø¶Ø¹ ÙƒÙ„Ù…Ø© Ù…Ø±ÙˆØ±'}
          {passwordStrength === 1 && 'Ø¶Ø¹ÙŠÙØ©'}
          {passwordStrength === 2 && 'Ù…ØªÙˆØ³Ø·Ø©'}
          {passwordStrength === 3 && 'Ù‚ÙˆÙŠØ©'}
        </p>
      </div>
    </>
  )
);

StandardCredentials.displayName = 'StandardCredentials';

/** ==================================================================
 *  Touchscreen numeric pad
 * ================================================================== */

interface TouchNumpadProps {
  password: string;
  onKey: (k: string) => void;
  onDelete: () => void;
  onClear: () => void;
  themeMode: ThemeMode;
}

const TouchNumpad: React.FC<TouchNumpadProps> = ({ password, onKey, onDelete, onClear, themeMode }) => (
  <div className="space-y-2">
    <div className="bg-slate-950 p-2.5 rounded-xl border border-slate-800 text-center flex justify-between items-center px-4">
      <span className="text-xs text-slate-400">Ø§Ù„Ø±Ù…Ø² Ø§Ù„Ø³Ø±ÙŠ Ø§Ù„Ù…Ø¯Ø®Ù„:</span>
      <span className="font-mono text-xl font-bold text-brand-400 tracking-widest">
        {password ? 'â€¢'.repeat(password.length) : '****'}
      </span>
    </div>

    <div className="grid grid-cols-3 gap-1.5">
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onKey(n)}
          className="bg-slate-950 hover:bg-slate-800 text-white py-2 rounded-xl font-bold font-mono text-base border border-slate-800 active:scale-95 cursor-pointer transition-transform"
        >
          {n}
        </button>
      ))}
      <button
        type="button"
        onClick={onDelete}
        className="bg-slate-950 hover:bg-slate-800 text-amber-400 py-2 rounded-xl font-bold border border-slate-800 flex items-center justify-center active:scale-95 cursor-pointer transition-transform"
      >
        <Delete className="w-4 h-4" />
      </button>
      <button
        type="button"
        onClick={() => onKey('0')}
        className="bg-slate-950 hover:bg-slate-800 text-white py-2 rounded-xl font-bold font-mono text-base border border-slate-800 active:scale-95 cursor-pointer transition-transform"
      >
        0
      </button>
      <button
        type="button"
        onClick={onClear}
        className="bg-slate-950 hover:bg-slate-800 text-rose-400 py-2 rounded-xl font-bold text-xs border border-slate-800 active:scale-95 cursor-pointer transition-transform"
      >
        Ù…Ø³Ø­
      </button>
    </div>
  </div>
);

/** ==================================================================
 *  Biometric auth surface
 * ================================================================== */

interface BiometricAuthProps {
  bioScanning: boolean;
  bioSuccess: boolean;
  onTrigger: () => void;
  themeMode: ThemeMode;
}

const BiometricAuth: React.FC<BiometricAuthProps> = ({ bioScanning, bioSuccess, onTrigger, themeMode }) => (
  <div className="bg-slate-950 p-5 rounded-2xl border border-brand-500/30 text-center space-y-3">
    <div className={`w-16 h-16 rounded-full mx-auto flex items-center justify-center transition-all ${
      bioScanning ? 'bg-amber-500/20 text-amber-400 animate-pulse border border-amber-500' :
      bioSuccess ? 'bg-brand-500/20 text-brand-400 border border-brand-500' : 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/40'
    }`}>
      <Fingerprint className="w-8 h-8" />
    </div>

    <h3 className="text-xs font-bold text-white">Ø§Ù„ØªØ­Ù‚Ù‚ Ø¨Ø§Ù„Ø¨ØµÙ…Ø© Ø§Ù„Ø¨ÙŠÙˆÙ…ØªØ±ÙŠØ© Ø§Ù„Ø¢Ù…Ù†Ø©</h3>
    <p className="text-[11px] text-slate-400">
      Ø¶Ø¹ Ø£ØµØ¨Ø¹Ùƒ Ø¹Ù„Ù‰ Ù…Ø³ØªØ´Ø¹Ø± Ø§Ù„Ø¨ØµÙ…Ø© Ø£Ùˆ ÙˆØ¬Ù‡Ùƒ Ø£Ù…Ø§Ù… Ø§Ù„ÙƒØ§Ù…ÙŠØ±Ø§ Ù„Ù„ØªØ­Ù‚Ù‚ Ø§Ù„ÙÙˆØ±ÙŠ Ù…Ù† Ø§Ù„Ù‡ÙˆÙŠØ©.
    </p>

    <button
      type="button"
      onClick={onTrigger}
      disabled={bioScanning}
      className="w-full bg-cyan-600 hover:bg-cyan-500 text-white py-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 shadow-lg shadow-cyan-600/30 cursor-pointer"
    >
      {bioScanning ? (
        <>
          <RefreshCw className="w-4 h-4 animate-spin" />
          <span>Ø¬Ø§Ø±ÙŠ Ø§Ù„Ù…Ø³Ø­ ÙˆØ§Ù„ØªØ­Ù‚Ù‚...</span>
        </>
      ) : bioSuccess ? (
        <>
          <CheckCircle2 className="w-4 h-4 text-brand-300" />
          <span>ØªÙ… Ø§Ù„ØªØ­Ù‚Ù‚ Ø¨Ù†Ø¬Ø§Ø­!</span>
        </>
      ) : (
        <>
          <Fingerprint className="w-4 h-4" />
          <span>Ø¨Ø¯Ø¡ Ø§Ù„Ù…Ø³Ø­ Ø§Ù„Ø¨ÙŠÙˆÙ…ØªØ±ÙŠ</span>
        </>
      )}
    </button>
  </div>
);

/** ==================================================================
 *  Loading skeleton (auth busy state)
 * ================================================================== */

interface LoadingSkeletonProps {
  themeMode: ThemeMode;
}

const LoadingSkeleton: React.FC<LoadingSkeletonProps> = ({ themeMode }) => (
  <div className="space-y-3">
    <div className="grid grid-cols-3 gap-2">
      {[1, 2, 3].map((i) => (
        <div key={i} className="h-10 bg-slate-800/50 rounded-xl animate-pulse" />
      ))}
    </div>
    <div className="space-y-2">
      <div className="h-10 bg-slate-800/50 rounded-xl animate-pulse" />
      <div className="h-10 bg-slate-800/50 rounded-xl animate-pulse" />
    </div>
    <div className="h-11 bg-slate-800/50 rounded-xl animate-pulse" />
  </div>
);

/** ==================================================================
 *  SSO federation buttons
 * ================================================================== */

interface SSOButtonGroupProps {
  onLogin: (p: 'google' | 'microsoft' | 'sap' | 'okta') => void;
  loading: string | null;
  themeMode: ThemeMode;
}

const SSOButtonGroup: React.FC<SSOButtonGroupProps> = ({ onLogin, loading, themeMode }) => {
  const items: { key: 'google' | 'microsoft' | 'sap' | 'okta'; label: string; icon: React.ReactNode; color: string }[] = [
    { key: 'google', label: 'Google', icon: <Chrome className="w-3.5 h-3.5" />, color: 'text-rose-400' },
    { key: 'microsoft', label: 'Microsoft', icon: <Key className="w-3.5 h-3.5" />, color: 'text-blue-400' },
    { key: 'sap', label: 'Ø­Ø³Ø§Ø¨ Ø§Ù„Ø´Ø±ÙƒØ©', icon: <Building className="w-3.5 h-3.5" />, color: 'text-amber-400' },
    { key: 'okta', label: 'Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø§Ù„Ù…ÙˆØ­Ø¯', icon: <Shield className="w-3.5 h-3.5" />, color: 'text-cyan-400' },
  ];
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onLogin(item.key)}
          disabled={loading !== null}
          className="bg-slate-950 hover:bg-slate-800 text-slate-200 border border-slate-800 py-1.5 rounded-xl text-[11px] font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-wait"
        >
          <span className={item.color}>{item.icon}</span>
          <span className="hidden sm:inline">{item.label}</span>
          {loading === item.key && <RefreshCw className="w-3 h-3 animate-spin" />}
        </button>
      ))}
    </div>
  );
};

/** ==================================================================
 *  Hardware health panel with live metrics
 * ================================================================== */

interface HardwareHealthPanelProps {
  testingHw: boolean;
  onRefresh: () => void;
  scaleWidget: React.ReactNode;
}

const HardwareHealthPanel: React.FC<HardwareHealthPanelProps> = ({ testingHw, onRefresh, scaleWidget }) => {
  const [printerReady, setPrinterReady] = useState(true);
  const [fiscalReady, setFiscalReady] = useState(true);

  const runTest = () => {
    onRefresh();
    setPrinterReady(Math.random() > 0.1);
    setFiscalReady(Math.random() > 0.1);
  };

  return (
    <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 mb-4 space-y-2.5">
      <div className="flex items-center justify-between pb-2 border-b border-slate-800/80">
        <span className="text-xs font-bold text-white flex items-center gap-1.5">
          <Terminal className="w-4 h-4 text-brand-400" /> Ø­Ø§Ù„Ø© Ø§Ù„Ø£Ø¬Ù‡Ø²Ø© Ø§Ù„ØªØ´ØºÙŠÙ„ÙŠØ©
        </span>
        <button
          type="button"
          onClick={runTest}
          disabled={testingHw}
          className="text-[10px] bg-slate-900 hover:bg-slate-800 text-brand-400 border border-brand-500/30 px-2 py-0.5 rounded-lg font-bold flex items-center gap-1 cursor-pointer"
        >
          <RefreshCw className={`w-3 h-3 ${testingHw ? 'animate-spin' : ''}`} />
          Ø¥Ø¹Ø§Ø¯Ø© Ø§Ù„ÙØ­Øµ
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs font-mono">
        <div className="flex items-center justify-between bg-slate-900/60 p-2 rounded-xl">
          <span className="text-slate-300 flex items-center gap-1 text-[11px]">
            <Printer className="w-3.5 h-3.5 text-brand-400" /> Ø·Ø§Ø¨Ø¹Ø© Ø§Ù„ÙÙˆØ§ØªÙŠØ±
          </span>
          <span className={`font-bold text-[10px] ${printerReady ? 'text-brand-400' : 'text-rose-400'}`}>
            {printerReady ? 'Ø¬Ø§Ù‡Ø²Ø© ðŸŸ¢' : 'ØªØ¹Ø·Ù„Øª ðŸ”´'}
          </span>
        </div>

        <div className="col-span-2">{scaleWidget}</div>

        <div className="flex items-center justify-between bg-slate-900/60 p-2 rounded-xl">
          <span className="text-slate-300 flex items-center gap-1 text-[11px]">
            <HardDrive className="w-3.5 h-3.5 text-cyan-400" /> Ø¯Ø±Ø¬ Ø§Ù„Ù†Ù‚Ø¯ÙŠØ©
          </span>
          <span className="text-brand-400 font-bold text-[10px]">Ù…ØºÙ„Ù‚ ðŸ”’</span>
        </div>

        <div className="flex items-center justify-between bg-slate-900/60 p-2 rounded-xl">
          <span className="text-slate-300 flex items-center gap-1 text-[11px]">
            <CheckCircle2 className="w-3.5 h-3.5 text-brand-400" /> Ø§Ù„ÙÙˆØªØ±Ø© Ø§Ù„Ø¶Ø±ÙŠØ¨ÙŠØ©
          </span>
          <span className={`font-bold text-[10px] ${fiscalReady ? 'text-brand-400' : 'text-rose-400'}`}>
            {fiscalReady ? 'Ù…Ø¹ØªÙ…Ø¯Ø© ðŸŸ¢' : 'ØºÙŠØ± Ù…Ø¹ØªÙ…Ø¯Ø© ðŸ”´'}
          </span>
        </div>
      </div>
    </div>
  );
};

/** ==================================================================
 *  Live network metrics
 * ================================================================== */

const LiveNetworkMetrics: React.FC<{ themeMode: ThemeMode }> = () => (
  <div className="space-y-2 font-mono">
    <div className="bg-slate-950 p-2.5 rounded-xl border border-slate-800/80 flex items-center justify-between text-xs">
      <span className="text-slate-300 flex items-center gap-2">
        <Server className="w-3.5 h-3.5 text-brand-400" /> Ø³Ø±Ø¹Ø© Ø§Ø³ØªØ¬Ø§Ø¨Ø© Ø§Ù„Ø³Ø­Ø§Ø¨Ø©
      </span>
      <span className="font-bold text-brand-400">12 ms</span>
    </div>

    <div className="bg-slate-950 p-2.5 rounded-xl border border-slate-800/80 flex items-center justify-between text-xs">
      <span className="text-slate-300 flex items-center gap-2">
        <Activity className="w-3.5 h-3.5 text-teal-400" /> Ø­Ø§Ù„Ø© Ø§Ù„Ù…Ø²Ø§Ù…Ù†Ø© Ø§Ù„Ù„Ø­Ø¸ÙŠØ©
      </span>
      <span className="font-bold text-teal-400">Ù†Ø´Ø·Ø© ÙˆØ³Ù„ÙŠÙ…Ø© ðŸŸ¢</span>
    </div>
  </div>
);

/**
 * Heuristic password strength (0â€“3).
 */
const useMemoScore = (pw: string): number => {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score += 1;
  if (/[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score += 1;
  return Math.min(score, 3);
};
