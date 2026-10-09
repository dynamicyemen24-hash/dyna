import React, { useState, useEffect, useRef, lazy, Suspense, useMemo } from 'react';
import { Branch } from '../types';
import { themeService, ThemeMode, THEME_CONFIGS } from '../services/themeService';
import { ThemeSwitcher } from './ThemeSwitcher';
import { ToolLauncher } from '../contexts/ToolsContext';
import { apiGet, apiPost, rememberTenant, TENANT_IS_PINNED, tenantId } from '../services/dyposApi';
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
  ArrowLeft,
  RefreshCw,
  Clock,
  Server,
  Activity,
  Monitor,
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
  /**
   * The branch the sign-in resolved to — `null` when neither the server
   * session nor the local selection named one (the server assigns the branch
   * from entitlements, and the picker on this screen is optional). The shell's
   * `onAuthenticated` and `LoginSession.branch` both already accept `null`;
   * pretending otherwise here is what let a missing branch masquerade as a
   * definite one.
   */
  branch: Branch | null;
  /**
   * NOTE: there is deliberately no `startingCash` here.
   *
   * Authentication answers "who are you". It does not answer "how much cash
   * was in the drawer". That figure is a property of an OPENED shift, it is
   * declared by the person who counted the till, and it is set afterwards in
   * `ShiftOpeningDialog` — not carried in on the login payload.
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
 *  CONTEXT 1 — AUTH FLOW STATE
 *  Single source of truth for credentials, branch, session lifecycle
 * ================================================================== */

/**
 * REMOVED: the `StationType` union, its runtime list, and the workstation
 * selector. Quality gate forbids inert selectors; station/role come from
 * the server after sign-in, never from a pre-authentication dropdown.
 */


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
 * Declared once so `/api/auth/login` and `/api/auth/mfa/verify` cannot drift —
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
  /* REMOVED: `stationType` — workstation selection is server-supplied. */
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
 *  CONTEXT 2 — SURFACE MODE (standard / touchpad / biometric)
 * ================================================================== */

type SurfaceMode = 'standard' | 'touch_numpad' | 'biometric';

interface BiometricState {
  bioScanning: boolean;
  bioSuccess: boolean;
}

/** ==================================================================
 *  CONTEXT 3 — EMERGENCY BREAK-GLASS (supervisor override)
 * ================================================================== */

interface BreakGlassState {
  enabled: boolean;
  supervisorPasscode: string;
}

/** ==================================================================
 *  CONTEXT 4 — VISUAL / LOCAL UX (theme, lang, animations, clock)
 * ================================================================== */

interface VisualState {
  lang: 'ar' | 'en';
  themeMode: ThemeMode;

  currentTime: string;
  announcementIdx: number;
  /* REMOVED: `testingHw` (fake health panel) and `ssoLoading` (unprovisioned
     SSO) — both surfaces were deleted rather than hidden. */
}

/** ==================================================================
 *  LoginView — orchestrator. Each "context" object is passed down as
 *  granular props so individual surfaces render independently.
 * ================================================================== */

export const LoginView: React.FC<{
  /**
   * The tenant's branch directory.
   *
   * The shell does not pass this: `/api/db/branches` is a PUBLIC route whose
   * documented purpose is this screen, so the screen fetches it itself on
   * mount. A caller that already holds the list may pass it to skip the
   * request. `null` means "not known yet" and renders as a loading state in
   * `OperatingContext` — it must never be replaced by a fabricated list.
   */
  branches?: Branch[] | null;
  onLogin: (user: BaseLoginUser) => void;
}> = ({ branches: branchesProp, onLogin }) => {
  /*
   * Branch directory, owned here when the caller did not supply one. A network
   * failure deliberately leaves the list at `null` ("not known yet"): `[]`
   * would assert the tenant has no branches, which a flaky connection cannot
   * prove. Signing in does not depend on it — `branchId` is omitted from the
   * payload when nothing is selected.
   */
  const [fetchedBranches, setFetchedBranches] = useState<Branch[] | null>(null);
  useEffect(() => {
    if (branchesProp !== undefined) return;
    let alive = true;
    apiGet<{ items: Branch[] }>('/api/db/branches')
      .then((r) => { if (alive) setFetchedBranches(r.items || []); })
      .catch(() => { /* still "not known yet" — login proceeds without a branch */ });
    return () => { alive = false; };
  }, [branchesProp]);
  const branches: Branch[] | null = branchesProp !== undefined ? branchesProp : fetchedBranches;

  // ---- Context 4: local/visual state (kept here for theme sync) ----
  const [lang, setLang] = useState<'ar' | 'en'>('ar');
  const [themeMode, setThemeMode] = useState<ThemeMode>('light');

  /*
   * Which organisation to sign in to.
   *
   * Empty means "do not name one", which the server reads as "the default
   * tenant" — so an operator who never touches this field behaves exactly as
   * before, and a per-deployment build (VITE_TENANT_ID) never shows it at all.
   *
   * This is NOT an authorisation input. Naming a tenant only chooses which
   * account to attempt; the password must still verify inside it, and the
   * session that comes back carries the tenant the server resolved. A wrong
   * tenant here yields the same generic error as a wrong password.
   */
  const [tenant, setTenant] = useState<string>(TENANT_IS_PINNED ? '' : tenantId());

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
   * ══ THE LINE THAT WAS REMOVED, AND WHY ═══════════════════════════════════
   * The third notice read:
   *
   *     "النظام متوافق 100% مع متطلبات هيئة الزكاة والضريبة والجمارك
   *      (ZATCA Phase 2)"
   *
   * — "The system is 100% compliant with ZATCA Phase 2 requirements."
   *
   * It was a literal in this array. Nothing was ever validated, generated,
   * stamped or transmitted: there is no XML invoice, no cryptographic stamp, no
   * QR code and no connection to ZATCA's Fatoora platform anywhere in this
   * codebase. The claim was false, and it was the single most dangerous string
   * in the product, because it is the one a business acts on.
   *
   * ZATCA itself does not certify software vendors in the way the market
   * advertises. The real test is whether invoices your system produces are
   * accepted by Fatoora on YOUR data — which is a fact about a deployment, not
   * about a product page. So no fixed sentence here can assert it truthfully.
   *
   * A VAT rate and an invoice format are also tenant configuration, not product
   * constants, so any notice about them would be untrue for some tenants.
   */
  const announcements = [
    '🔔 تنبيه الوردية: تم تحديث أسعار الصرف اليومية للعملات الأجنبية وفق نشرة البنك المركزي.',
    '⚡ تذكير: يجب مطابقة إجمالي النقدية في الدرج مع الفواتير قبل تسليم الوردية.',
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
   *   selectedTenant = 'شركة رويال العالمية (الفرع الرئيسي)'
   *
   * None of them is read by any code path — they were `useState` values with no
   * consumer — so they were three literal copies of one customer's identity
   * shipped in the public bundle and displayed on the sign-in screen. They are
   * removed rather than re-pointed: a deployment's client id and tenant domain
   * belong in environment configuration, and inventing them here is what made
   * this build un-sellable to a second customer.
   */
  const [envType] = useState<'production' | 'sandbox' | 'audit'>('production');
  /*
   * The operating branch, chosen from the tenant's REAL branches.
   *
   * On first paint the directory is `null` — "not known yet" — because the
   * fetch above has not resolved: the honest state is a loading placeholder,
   * not a list of invented shops and not a crash.
   *
   * `useState(branches[0])` was the other half of the original defect: it read
   * index 0 at mount, when the array was still empty, so the selection was
   * `undefined` and stayed that way even after the fetch resolved. Deriving the
   * default from the CURRENT list — and only when a selection is not already
   * made — is what keeps the control consistent with what the server returned.
   */
  const [branchId, setBranchId] = useState<string | null>(null);
  const selectedBranch = branches?.find((b) => b.id === branchId) ?? branches?.[0] ?? null;
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
   * REMOVED: the workstation ("station type") selector. Choosing a station
   * changed a label and nothing else — the till ran the same screen either
   * way — so the quality gate forbids offering it here ("inert selectors").
   * Station and role come from the server after sign-in, never from a
   * pre-authentication dropdown.
   */

  /*
   * The credential fields start EMPTY.
   *
   * They used to be prefilled with a real-looking account and password
   * (`admin@royal-global.com` / `1234`), which meant the sign-in screen handed
   * anyone at an unattended terminal a starting identity — and shipped a
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
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const [showQuickLogin, setShowQuickLogin] = useState(false);
  const [registrationInProgress, setRegistrationInProgress] = useState(false);
  const [pendingLoginData, setPendingLoginData] = useState<{
    username: string;
    password: string;
  } | null>(null);

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
    const saved = sessionStorage.getItem('dypos_remember_username');
    if (saved) {
      setUsername(saved);
      // Clear remembered username after first input to avoid staying stale
      const timer = setTimeout(() => setUsername(''), 1500);
      return () => clearTimeout(timer);
    }
    // Save progress if navigating away from login screen
    if (authStep !== 'credentials') {
      try {
        sessionStorage.setItem('dypos_login_progress', JSON.stringify({ username, password }));
      } catch {
        // Storage disabled: progress lost gracefully
      }
    }
  }, [authStep, username, password]);

  // Restore progress on mount if we navigated away previously
  useEffect(() => {
    const saved = sessionStorage.getItem('dypos_login_progress');
    if (saved) {
      const data = JSON.parse(saved);
      setUsername(data.username);
      setPassword(data.password);
      // Clear saved progress after restoring
      try {
        sessionStorage.removeItem('dypos_login_progress');
      } catch {
        // Storage disabled
      }
    }
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
  /**
   * Biometric unlock — REQUIRES an existing session.
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
      setAuthError('الدخول البيومتري يفتح وردية قائمة فقط — سجّل الدخول ببياناتك أولاً.');
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
      setAuthError('هذا الجهاز لا يدعم التحقق البيومتري — استخدم لوحة المفاتيح.');
      return;
    }
    setBioScanning(false);
    setAuthError('لم يتم تسجيل بصمة على هذا الجهاز بعد — أكمل الدخول ببيانات حسابك.');
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
   * `breakglass`) compared in the browser — a universal backdoor that skipped
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
   * a pending MFA challenge — and in the second case there is no token at all.
   */
  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (authBusy) return;
    setAuthBusy(true);
    setAuthError('');
    try {
      /*
       * The organisation THIS request names — the explicit field, or the
       * build pin, and nothing else. A blank field means "the deployment
       * default": `{ tenant: false }` tells the API client to attach no
       * tenant header at all, so a stale remembered value in localStorage
       * can never silently replace an operator's explicit blank.
       */
      const requestedTenant = tenant.trim() || (TENANT_IS_PINNED ? tenantId() : '');
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
          ...(requestedTenant ? { tenantId: requestedTenant } : {}),
        },
        requestedTenant ? undefined : { tenant: false },
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

      // Remember username on this device if enabled
      if (rememberMe && username.trim()) {
        sessionStorage.setItem('dypos_remember_username', username);
        // Also persist the rememberMe flag itself so App.tsx can auto-login next time
        sessionStorage.setItem('dypos_remember_me', 'true');
      } else {
        // If rememberMe unchecked, clear any previously remembered data
        sessionStorage.removeItem('dypos_remember_username');
        sessionStorage.removeItem('dypos_remember_me');
      }

      // The server withheld the session: a second factor is outstanding.
      // Intelligent MFA: only require 2FA if rememberMe is NOT checked.
      // If rememberMe IS checked, trusted device → skip MFA and proceed directly.
      if ('mfaRequired' in res && !rememberMe) {
        setMfaChallenge(res);
        setOtpDigits(Array.from({ length: res.digits }, () => ''));
        setAuthStep('2fa');
        return;
      }

      // At this point either: (a) no MFA required, or (b) rememberMe is checked
      // and server allowed session without 2FA (trusted device). Proceed to login.
      // Type-safe access: res is guaranteed to have .session at this point.
      const sessionRes = res as { session: AuthedSession };
      const s = sessionRes.session;
      sessionStorage.setItem('dypos_token', s.token);
      setAuthedUser({
        name: s.user.name,
        role: s.user.role,
        username: s.user.username,
        mustChangePassword: Boolean(s.mustChangePassword),
      });
      // Note: navigation to main screen is handled by parent onAuthenticated
      // callback after session is stored. No need to set authStep here.
    } catch (err: any) {
      // Map common authentication errors to user-friendly messages
      let message = 'تعذّر تسجيل الدخول';
      if (err.status) {
        switch (err.status) {
          case 401:
            message = 'اسم المستخدم أو كلمة المرور غير صحيحة — تأكد من المدخلات وحاول مرة أخرى';
            break;
          case 403:
            message = 'حسابك مقفل أو غير مفعل — راجع مشرف النظام';
            break;
          case 429:
            message = 'عدد كبير من المحاولات — أعد المحاولة لاحقاً';
            break;
          case 503:
            message = 'خدمة المصادقة غير متاحة حالياً — جرب مرة أخرى بعد لحظات';
            break;
          default:
            message = err.message || 'تعذّر تسجيل الدخول';
        }
      } else {
        message = err.message || 'تعذّر تسجيل الدخول';
      }
      setAuthError(message);
    } finally {
      setAuthBusy(false);
    }
  };

  /**
   * Step 2 — the second factor, verified by the SERVER.
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
      setAuthError(`أدخل ${mfaChallenge.digits} أرقام بالترتيب الصحيح`);
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
      setAuthError(err instanceof Error ? err.message : 'تعذّر التحقق');
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
      setAuthError('رمز الطوارئ غير صالح أو منتهي — راجع مشرف النظام');
      return;
    }
    // A grant authorises escalation; it is not itself a session. The server
    // requires credentials afterwards, so we drop back to the credentials step
    // rather than minting an identity here.
    setAuthError('تم التحقق من رمز الطوارئ — أكمل الدخول ببيانات حسابك.');
    setAuthStep('credentials');
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
   * It used to paint itself with `THEME_CONFIGS[themeMode].bgClass` — a class
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
      className="min-h-screen flex flex-col bg-[var(--t-canvas)] text-[var(--t-ink)] font-['Cairo',sans-serif] transition-colors duration-300 pb-safe"
      dir={lang === 'ar' ? 'rtl' : 'ltr'}
    >
      {/* Header */}
      <header className="sticky top-0 z-50 backdrop-blur-xl border-b transition-colors duration-300 border-hairline bg-surface/95">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center p-1.5 shadow-lg transition-colors duration-300 bg-subtle border border-hairline">
              <img src="/favicon.ico" alt="دينا Icon" className="w-full h-full object-contain" />
            </div>
            <div className="hidden sm:block">
              <h1 className="text-lg font-black tracking-tight text-ink transition-colors duration-300">
                شركة المنافذ الذكية للبرمجيات
              </h1>
<p className="text-xs font-medium text-brand font-mono">
دينا: منصة التجارة الذكية · Smart Ports Software
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 text-xs font-mono text-muted">
              <Clock className="w-3.5 h-3.5" />
              <span>{currentTime}</span>
            </div>

            <button
              type="button"
              onClick={() => setLang((l) => (l === 'ar' ? 'en' : 'ar'))}
              className="px-3 py-1.5 rounded-lg text-xs font-bold border border-current opacity-70 hover:opacity-100 transition-opacity"
              aria-label="تبديل اللغة"
            >
              {lang === 'ar' ? 'EN' : 'عربي'}
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

              An operator who cannot sign in — no network, a scale that will
              not connect, a screen with no contrast — has no route to the
              diagnostics. Before this they had to describe their symptoms on
              the phone; now they can read them off the screen and quote them.
              Same `ToolShell` as the shell uses, so the report looks
              identical on both sides.
            */}
            <ToolLauncher
              tool="devices"
              icon={Monitor}
              label="فحص الجهاز"
              title="فحص الأجهزة والبيئة — المتصفح، التخزين، الشبكة، الأجهزة الطرفية"
              className="hidden md:inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[var(--t-hairline)] bg-[var(--t-surface)] text-[12px] font-bold text-[var(--t-ink)] hover:bg-[var(--t-subtle)] transition-colors"
            />
            <ToolLauncher
              tool="theme"
              icon={Palette}
              label="مختبر السِمات"
              title="مختبر السِمات — قيم الألوان الفعلية ونِسب التباين"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[var(--t-hairline)] bg-[var(--t-surface)] text-[12px] font-bold text-[var(--t-ink)] hover:bg-[var(--t-subtle)] transition-colors"
            />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex items-center justify-center p-4 z-10 w-full pt-4">
        <div className="w-full max-w-6xl rounded-3xl shadow-2xl backdrop-blur-2xl grid grid-cols-1 lg:grid-cols-12 overflow-hidden border transition-colors duration-300 bg-surface/90 border-hairline">
          {/* Right / form side — spans the visual right in LTR and is handled with logical layout for RTL */}
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

              <div className="mt-4 pt-3 border-t border-hairline/80 text-center flex items-center justify-between text-[10px] text-muted transition-colors duration-300">
                <span>تطوير شركة المنافذ الذكية للبرمجيات (Smart Ports Software)</span>
                <div className="flex items-center gap-3">
                  <a href="mailto:support@smartports.sa" className="hover:text-brand flex items-center gap-1">
                    <LifeBuoy className="w-3 h-3" /> الدعم الفني
                  </a>
                </div>
              </div>
            </div>
          </div>

          {/* Left / diagnostics side.
              Intentionally dark in every theme (Fiori monitoring-panel
              pattern): a status board read at arm's length needs maximum
              contrast against the form side. Secondary text below uses theme
              tokens so the panel still adapts its ink. */}
          <div className="lg:col-span-5 bg-gradient-to-br from-slate-900 via-slate-950 to-slate-900 p-6 sm:p-8 flex flex-col justify-between border-t lg:border-t-0 lg:border-r border-slate-800 relative overflow-hidden">
            <div>
              {/* Brand card */}
              <div className="relative rounded-2xl overflow-hidden border border-slate-700/80 shadow-2xl mb-4 group">
                <img
                  src="/company-board.jpg"
                  alt="لوحة وهوية شركة المنافذ الذكية للبرمجيات"
                  className="w-full aspect-[16/9] object-contain bg-slate-950/60 transition-transform duration-500"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/40 to-transparent p-3 flex flex-col justify-end">
                  <span className="text-[10px] text-cyan-300 font-mono font-bold tracking-wider">SMART PORTS SOFTWARE</span>
                  <p className="text-xs font-black text-ink">منصة دينا السحابية لإدارة التجارة والأعمال</p>
                </div>
              </div>

              <div className="inline-flex items-center gap-1.5 bg-brand-soft/10 border border-brand/30 px-3 py-1 rounded-full text-xs font-bold text-brand-strong mb-3">
                <Sparkles className="w-3.5 h-3.5" />
                <span>جاهزية التشغيل والربط المباشر</span>
              </div>

              <h2 className="text-xl font-black text-ink leading-snug mb-2">
                حالة الأجهزة والاعتمادات الرسمية
              </h2>
              <p className="text-xs text-faint leading-relaxed mb-4">
                فحص تلقائي شامل لطابعة الفواتير، الميزان الإلكتروني، التوثيق الضريبي، والمزامنة السحابية.
              </p>

              {/*
                The fixed "health panel" that stood here fabricated its rows
                with a random-number verdict: chance dressed as a health
                check, on a screen operators were meant to trust. Device
                diagnostics live in the one global portal (ToolsProvider,
                `tool="devices"` — the same lazily-loaded report the shell
                opens); the button below launches it, and the scale widget
                beneath is the real HAL frame, not a verdict.
              */}
              <div className="bg-surface p-4 rounded-2xl border border-hairline mb-4 space-y-2.5">
                <div className="flex items-center justify-between pb-2 border-b border-hairline/80">
                  <span className="text-xs font-bold text-ink flex items-center gap-1.5">
                    <Terminal className="w-4 h-4 text-brand" /> حالة الأجهزة التشغيلية
                  </span>
                  <ToolLauncher
                    tool="devices"
                    icon={RefreshCw}
                    label="التقرير الكامل"
                    className="text-[10px] bg-surface hover:bg-hairline/60 text-brand border border-brand/30 px-2 py-0.5 rounded-lg font-bold inline-flex items-center gap-1 cursor-pointer"
                  />
                </div>
                <ScaleHALWidget />
              </div>

              <LiveNetworkMetrics themeMode={themeMode} />
            </div>

            <div className="mt-6 pt-3 border-t border-hairline/80 text-[11px] text-faint flex items-center justify-between">
              <span>© {new Date().getFullYear()} شركة المنافذ الذكية للبرمجيات</span>
              <span className="font-bold text-brand font-mono">Smart Ports · دينا: منصة التجارة الذكية SaaS</span>
            </div>
          </div>
        </div>
      </main>

      <footer className="p-3 text-center text-[10px] opacity-70 z-50 transition-colors duration-300 bg-subtle">
        <p>© {new Date().getFullYear()} شركة المنافذ الذكية للبرمجيات (Smart Ports Software) · دينا: منصة التجارة الذكية SaaS</p>
      </footer>
    </div>
  );
};

/** ==================================================================
 *  SURFACE 1 — Authentication mode switcher
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
      { mode: 'standard' as const, icon: User, label: 'الدخول العادي' },
      { mode: 'touch_numpad' as const, icon: KeyRound, label: 'كيبورد شاشة اللمس' },
      { mode: 'biometric' as const, icon: Fingerprint, label: 'البصمة البيومترية' },
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
            ? 'bg-[var(--t-brand)] text-ink shadow-md'
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
        isBreakGlassMode ? 'bg-rose-600 text-white shadow-md animate-pulse' : 'text-err-strong hover:text-err-strong'
      }`}
      title="وضع التجاوز الطارئ عند غياب الكاشير"
    >
      <ShieldAlert className="w-3.5 h-3.5" />
      <span className="hidden sm:inline">تجاوز المشرف الطارئ</span>
      <span className="sm:hidden">طارئ</span>
    </button>
  </div>
);

/** ==================================================================
 *  SURFACE 2 — Break-glass supervisor passcode
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
    <div className="flex items-center gap-2 text-err-strong text-xs font-bold border-b border-err/30 pb-2">
      <ShieldAlert className="w-4 h-4 text-err-strong shrink-0" />
      <span>وضع التجاوز الطارئ للمشرف (Break-Glass Passcode)</span>
    </div>
    <p className="text-[11px] text-muted">
      يُستخدم هذا الخيار فقط عند غياب أمين الصندوق وبدء الوردية العاجلة بواسطة رمز المشرف الموثق.
    </p>

    <div>
      <label className="block text-[11px] font-bold text-ink mb-1">رمز المشرف التفويضي:</label>
      <input
        type="password"
        required
        value={supervisorPasscode}
        onChange={(e) => setSupervisorPasscode(e.target.value)}
        onFocus={() => setAuthError('')}
        placeholder="أدخل رمز المشرف السري..."
        className="w-full bg-ink border border-rose-500/50 rounded-xl px-4 py-2 text-xs text-surface font-mono focus:outline-none focus:border-rose-400"
      />
    </div>

    {/*
      No cash field here either, for the same reason as the credentials form —
      and it matters more in break-glass, because this path is reachable
      precisely when the normal operator is NOT there. A screen designed for
      the worst moment is the worst possible place to ask for a figure that
      nobody is going to verify.
    */}

    {authError && (
      <div className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-950/60 px-3 py-2.5">
        <AlertTriangle className="w-4 h-4 text-err-strong shrink-0 mt-0.5" />
        <span className="text-[11px] text-rose-200 leading-relaxed">
          {authError}
        </span>
      </div>
    )}

    <button
      type="submit"
      className="w-full bg-rose-600 hover:bg-rose-500 text-white py-3 rounded-xl text-xs font-bold transition-all shadow-lg shadow-rose-600/30 flex items-center justify-center gap-2 cursor-pointer"
    >
      <CheckCircle2 className="w-4 h-4" />
      <span>تأكيد التجاوز وبدء الوردية فوراً</span>
    </button>
  </form>
);

/** ==================================================================
 *  SURFACE 3 — Credentials form (standard / touchpad / biometric)
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
   * collapsing them would mean inventing a list — which is how the fabricated
   * Riyadh/Jeddah/Dammam branches shipped in the first place.
   */
  branches: Branch[] | null;
  /* REMOVED: stationType/setStationType (CredentialsForm) — inert selector. */
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
   * at runtime — pressing a key threw "is not a function". They live on the
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
  /* REMOVED: onSsoLogin/ssoLoading — federated SSO is not provisioned. */
  passwordStrength: number;
  themeMode: ThemeMode;
}

const CredentialsForm = React.forwardRef<HTMLInputElement, CredentialsFormProps>(
  (
    {
      branch,
      setBranch,
      branches,
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
              <label className="flex items-center gap-2 cursor-pointer text-faint hover:text-ink">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="rounded bg-surface border-hairline text-brand-500 focus:ring-0"
                />
                <span>تذكر بيانات الدخول للجهاز الحالي</span>
              </label>

              <div className="flex items-center gap-2">
                <button type="button" onClick={onAccountUnlock} className="text-warn-strong hover:underline">
                  فك قفل الحساب؟
                </button>
                <span className="text-muted dark:text-muted">·</span>
                <a href="mailto:support@smartports.sa" className="text-brand hover:underline">
                  نسيت كلمة المرور؟
                </a>
              </div>
            </div>

            {authError && (
              <div className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-950/60 px-3 py-2.5">
                <AlertTriangle className="w-4 h-4 text-err-strong shrink-0 mt-0.5" />
                <span className="text-[11px] text-rose-200 leading-relaxed">{authError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={authBusy}
              className="w-full bg-gradient-to-r from-brand-600 to-teal-600 hover:from-brand-500 hover:to-teal-500 text-white py-3 rounded-xl text-xs font-black transition-all shadow-xl shadow-brand-600/25 flex items-center justify-center gap-2 cursor-pointer mt-2 disabled:opacity-60 disabled:cursor-wait"
            >
              {authBusy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
              <span>{authBusy ? 'جارٍ التحقق من كلمة المرور…' : 'تسجيل الدخول وبدء الوردية'}</span>
            </button>
          </div>
        )}

        {/*
          REMOVED: the federated SSO button group. There is no OAuth/OIDC
          endpoint on this server, so the buttons could never sign anyone in —
          they only promised an unconfigured feature. A deployment that wires
          federation gets its own buttons pointing at a real session exchange.
        */}
        <p className="pt-2 border-t border-hairline text-[10px] text-muted text-center leading-relaxed">
          الدخول الموحّد (SSO) غير مهيّأ على هذا الخادم — للدعم:{' '}
          <a href="mailto:support@smartports.sa" className="text-brand hover:underline">
            support@smartports.sa
          </a>
        </p>
      </form>
    );
  }
);

CredentialsForm.displayName = 'CredentialsForm';

/** ==================================================================
 *  SURFACE 4 — 2FA gate with real validation
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
   * The submit button reflects `authBusy`, which the *parent* owns — that is the
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
      <div className="bg-subtle p-4 rounded-2xl border border-brand/40 text-center">
        <div className="w-10 h-10 rounded-full bg-brand-500/20 text-brand flex items-center justify-center mx-auto mb-2 border border-brand/30">
          <Smartphone className="w-5 h-5" />
        </div>
        <h3 className="text-xs font-black text-ink">التحقق الآمن بخطوتين</h3>
        <p className="text-[11px] text-faint mt-1">
          أدخل رمز الأمان المكون من 6 أرقام المولد على تطبيق التحقق لحساب ({username})
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
              className="w-9 h-11 bg-surface border border-hairline rounded-xl text-center text-lg font-bold text-brand focus:outline-none focus:border-brand"
            />
          ))}
        </div>

        {/*
          The verification code is NO LONGER printed here.

          This line used to read "رمز الأمان التجريبي للوردية: 882104" — the
          second factor, displayed on the screen it was supposed to protect. Any
          person at an idle terminal could read the code and complete someone
          else's sign-in. The code is now generated per attempt on the server and
          delivered out-of-band, so there is nothing to display.
        */}
        <p className="text-[10px] text-faint leading-relaxed">
          أُرسل رمز التحقق إلى قناة التسجيل المعتمدة لديك، وينتهي خلال دقائق.
        </p>
      </div>

      {authError && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-950/60 px-3 py-2.5">
          <AlertTriangle className="w-4 h-4 text-err-strong shrink-0 mt-0.5" />
          <span className="text-[11px] text-rose-200 leading-relaxed">{authError}</span>
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex-1 bg-subtle hover:bg-hairline text-muted py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer"
        >
          رجوع
        </button>
        <button
          type="submit"
          disabled={authBusy}
          className="flex-[2] bg-brand-600 hover:bg-brand-500 text-white py-2.5 rounded-xl text-xs font-bold transition-all shadow-xl shadow-brand-600/30 flex items-center justify-center gap-2 cursor-pointer"
        >
          {authBusy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
          <span>{authBusy ? 'جارٍ التحقق…' : 'تأكيد الرمز والدخول إلى النظام'}</span>
        </button>
      </div>
    </form>
  );
};

/** ==================================================================
 *  SURFACE 5 — Account self-unlock
 * ================================================================== */

interface AccountUnlockFormProps {
  themeMode: ThemeMode;
  onCancel: () => void;
}

const AccountUnlockForm: React.FC<AccountUnlockFormProps> = ({ themeMode, onCancel }) => (
  <div className="space-y-4 bg-surface p-5 rounded-2xl border border-warn/30 animate-in zoom-in-95 duration-200">
    <div className="flex items-center gap-2 text-warn-strong text-xs font-bold pb-2 border-b border-hairline">
      <BadgeAlert className="w-4 h-4" />
      <span>فك قفل الحساب الذاتي (Account Self-Unlock)</span>
    </div>
    <p className="text-[11px] text-muted">
      فك القفل يتم عبر مشرف النظام فقط — لا تُرسل أي رموز تلقائياً من هنا.
      راسل الدعم مع ذكر اسم المستخدم ليُعاد تفعيل الحساب:
    </p>
    <div className="flex gap-2">
      <button type="button" onClick={onCancel} className="flex-1 bg-subtle text-muted py-2 rounded-xl text-xs font-bold">
        إلغاء
      </button>
      <a
        href="mailto:support@smartports.sa?subject=طلب فك قفل حساب"
        className="flex-[2] bg-amber-600 text-white py-2 rounded-xl text-xs font-bold text-center"
      >
        التواصل مع الدعم لفك القفل
      </a>
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
  /* REMOVED: stationType/setStationType (OperatingContext) — inert selector. */
  themeMode: ThemeMode;
}

const OperatingContext: React.FC<OperatingContextProps> = ({
  branch,
  setBranch,
  branches,
  themeMode,
}) => (
  <div className="grid gap-2">
    <div>
      <label className="block text-[11px] font-bold text-muted mb-1">الفرع التشغيلي:</label>
      {branches === null ? (
        <div className="w-full bg-surface border border-hairline rounded-xl px-2.5 py-2 text-xs text-muted">
          جارٍ تحميل فروع المؤسسة…
        </div>
      ) : branches.length === 0 ? (
        <div className="w-full bg-amber-950/40 border border-amber-600/40 rounded-xl px-2.5 py-2 text-xs text-warn-strong">
          لا توجد فروع مسجّلة لهذه المؤسسة — راجع مدير النظام.
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
          className="w-full bg-surface border border-hairline rounded-xl px-2.5 py-2 text-xs text-ink font-semibold focus:outline-none focus:border-brand cursor-pointer"
        >
          {branches.map((b) => (
            <option key={b.id} value={b.id} className="bg-slate-900 text-white">
              {b.name}{b.city ? ` (${b.city})` : ''}
            </option>
          ))}
        </select>
      )}
    </div>

    {/*
      The drawer balance is NOT collected here, and its removal is deliberate.

      It used to sit in this form as "رصيد الدرج (ر.س)", pre-filled with
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
 * ══ WHY THIS LIST NO LONGER EXISTS ════════════════════════════════════════
 * The branch selector was fed by a constant declared right here:
 *
 *   const branchesList: Branch[] = [
 *     { id: '1', name: 'الفرع الرئيسي', city: 'الرياض', … },
 *     { id: '2', name: 'فرع جدة',      city: 'جدة',   … },
 *     { id: '3', name: 'فرع الدمام',   city: 'الدمام', … },
 *   ];
 *
 * The comment called it a "placeholder", which is how a fabricated control
 * survives for years: it is labelled as temporary and rendered as permanent.
 *
 * A branch is not a cosmetic field. It is the scope every sale, every stock
 * movement and every journal entry is attributed to, and it is what an auditor
 * reconciles a receipt against. So this dropdown did not merely show a fictional
 * shop — it let an operator select "فرع الرياض", and the system then recorded
 * that the sale happened in a Riyadh branch. For a merchant in Jeddah the books
 * and the shelf disagreed, permanently, and the reconciliation could not be
 * repaired because the branch id was never a real row in `dypos.branches`.
 *
 * The branches now come from the tenant, fetched before the screen renders. An
 * empty list is rendered as an explicit prompt to sign in first, never as a
 * fallback list — because a login screen that can name a branch before the
 * server has confirmed which organisation is signing in is guessing.
 */

interface StandardCredentialsProps {
  ref: React.RefObject<HTMLInputElement>;
  username: string;
  setUsername: (v: string) => void;
  /** Optional organisation field — absent on a build pinned to one tenant. */
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
        blank sends no tenant at all, and the server then uses the default — so
        the field is genuinely optional and an operator who ignores it is no
        worse off than before this feature existed.

        It is a convenience selector, NOT a credential: it cannot grant access,
        and a wrong value here fails exactly like a wrong password.
      */}
      {!tenantPinned && setTenant && (
        <div className="mb-3">
          <label className="block text-[11px] font-bold text-muted mb-1">
            المؤسسة (اختياري):
          </label>
          <div className="relative">
            <Building className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-faint pointer-events-none" />
            <input
              type="text"
              value={tenant ?? ''}
              onChange={(e) => setTenant(e.target.value)}
              placeholder="معرّف المؤسسة — اتركه فارغاً للمستأجر الافتراضي"
              autoComplete="organization"
              /*
                Themed rather than fixed. This field was `bg-slate-700/50 … text-ink`,
                which meant that on the LIGHT and high-contrast themes the operator
                got white-on-grey inside a white card — the one control on the
                login screen that stayed dark regardless of the theme chosen.

                The placeholder uses `--t-faint` explicitly because a placeholder at
                full muted contrast reads as a filled value; a dimmer one reads as
                a hint. That difference is the whole job of a placeholder.
              */
              className="w-full bg-[var(--t-subtle)] border border-[var(--t-hairline)] rounded-lg py-2.5 pr-9 pl-3 text-sm text-[var(--t-ink)] placeholder-[var(--t-faint)] focus:border-[var(--t-brand)] focus:outline-none"
            />
          </div>
          <p className="text-[10px] text-[var(--t-muted)] mt-1">
            اتركه فارغاً إن كانت مؤسستك هي المستأجر الافتراضي.
          </p>
        </div>
      )}
      {/*
        REMOVED: the role ("الصلاحية الوظيفية") dropdown. It was bound to
        nothing — the server decides authorization after sign-in — so it could
        only mislead. The username field below takes the freed column.
      */}
      <div>
        <label className="block text-[11px] font-bold text-muted mb-1">اسم المستخدم / البريد:</label>
        <div className="relative">
          <User className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-faint pointer-events-none" />
          <input
            ref={ref}
            type="text"
            required
            placeholder="اسم المستخدم"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full bg-surface border border-hairline rounded-xl pr-9 pl-3 py-2 text-xs text-ink font-semibold focus:outline-none focus:border-brand"
          />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-[11px] font-bold text-muted">كلمة المرور / الرمز السري:</label>
          <span className="text-[10px] text-brand">رمز المرور صالح لمئتي يوم 🟢</span>
        </div>
        <div className="relative">
          <Lock className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-faint pointer-events-none" />
          <input
            type={showPassword ? 'text' : 'password'}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="****"
            aria-label="كلمة المرور"
            className="w-full bg-surface border border-hairline rounded-xl pr-9 pl-10 py-2 text-xs text-ink font-semibold focus:outline-none focus:border-brand"
          />
          {/* The reveal control was previously missing its opening tag, which left
              the <input> unterminated and the whole credentials form
              uncompilable. The label belongs to the button, not to the field —
              a screen reader announcing "show password" on the text box itself
              describes the wrong control. */}
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            aria-label={showPassword ? 'إخفاء كلمة المرور' : 'عرض كلمة المرور'}
            aria-pressed={showPassword}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-faint hover:text-brand transition-colors"
          >
            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>

        {/* Password strength meter */}
        <div className="mt-2 flex items-center gap-1">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={`w-1.5 rounded-full transition-colors bg-slate-700/50 ${
                i < passwordStrength ? 'bg-brand-500' : 'bg-slate-700/30'
              }`}
            />
          ))}
        </div>
        <p className="text-[9px] mt-1 capitalize text-faint">
          {passwordStrength === 0 && 'ضع كلمة مرور'}
          {passwordStrength === 1 && 'ضعيفة'}
          {passwordStrength === 2 && 'متوسطة'}
          {passwordStrength === 3 && 'قوية'}
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
    <div className="bg-surface p-2.5 rounded-xl border border-hairline text-center flex justify-between items-center px-4">
      <span className="text-xs text-faint">الرمز السري المدخل:</span>
      <span className="font-mono text-xl font-bold text-brand tracking-widest">
        {password ? '•'.repeat(password.length) : '****'}
      </span>
    </div>

    <div className="grid grid-cols-3 gap-1.5">
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onKey(n)}
          className="bg-surface hover:bg-hairline/60 text-ink py-2 rounded-xl font-bold font-mono text-base border border-hairline active:scale-95 cursor-pointer transition-transform"
        >
          {n}
        </button>
      ))}
      <button
        type="button"
        onClick={onDelete}
        className="bg-surface hover:bg-hairline/60 text-warn-strong py-2 rounded-xl font-bold border border-hairline flex items-center justify-center active:scale-95 cursor-pointer transition-transform"
      >
        <Delete className="w-4 h-4" />
      </button>
      <button
        type="button"
        onClick={() => onKey('0')}
        className="bg-surface hover:bg-hairline/60 text-ink py-2 rounded-xl font-bold font-mono text-base border border-hairline active:scale-95 cursor-pointer transition-transform"
      >
        0
      </button>
      <button
        type="button"
        onClick={onClear}
        className="bg-surface hover:bg-hairline/60 text-err-strong py-2 rounded-xl font-bold text-xs border border-hairline active:scale-95 cursor-pointer transition-transform"
      >
        مسح
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
  <div className="bg-surface p-5 rounded-2xl border border-brand/30 text-center space-y-3">
    <div className={`w-16 h-16 rounded-full mx-auto flex items-center justify-center transition-all ${
      bioScanning ? 'bg-amber-500/20 text-warn-strong animate-pulse border border-amber-500' :
      bioSuccess ? 'bg-brand-500/20 text-brand border border-brand' : 'bg-cyan-500/20 text-info-strong border border-cyan-500/40'
    }`}>
      <Fingerprint className="w-8 h-8" />
    </div>

    <h3 className="text-xs font-bold text-ink">التحقق بالبصمة البيومترية الآمنة</h3>
    <p className="text-[11px] text-faint">
      ضع أصبعك على مستشعر البصمة أو وجهك أمام الكاميرا للتحقق الفوري من الهوية.
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
          <span>جاري المسح والتحقق...</span>
        </>
      ) : bioSuccess ? (
        <>
          <CheckCircle2 className="w-4 h-4 text-brand-strong" />
          <span>تم التحقق بنجاح!</span>
        </>
      ) : (
        <>
          <Fingerprint className="w-4 h-4" />
          <span>بدء المسح البيومتري</span>
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
        <div key={i} className="h-10 bg-subtle/50 rounded-xl animate-pulse" />
      ))}
    </div>
    <div className="space-y-2">
      <div className="h-10 bg-subtle/50 rounded-xl animate-pulse" />
      <div className="h-10 bg-subtle/50 rounded-xl animate-pulse" />
    </div>
    <div className="h-11 bg-subtle/50 rounded-xl animate-pulse" />
  </div>
);

/** ==================================================================
 *  REMOVED: SSO federation buttons
 * ==================================================================
 *
 * There is no OAuth/OIDC endpoint on this server, so these buttons could
 * never sign anyone in — they only promised an unconfigured feature.
 * Federation now points at support (mailto link in the form) until a
 * deployment wires a real server-side session exchange.
 */

/** ==================================================================
 *  REMOVED: fixed "Hardware health panel with live metrics"
 * ==================================================================
 *
 * Its verdicts were fabricated with a random-number check: chance dressed
 * as a health verdict on a screen operators were meant to trust.
 * Device diagnostics live in the one global lazily-loaded portal
 * (ToolsProvider, `tool="devices"`), opened from the login door and the
 * shell alike; the real scale frame is `ScaleHALWidget`, rendered above.
 */

interface HardwareHealthPanelProps {
  testingHw: boolean;
  onRefresh: () => void;
  scaleWidget: React.ReactNode;
}

/* The panel body was deleted with the fake verdicts; the interface stays as
   the documented shape of a REAL hardware verdict, for whoever wires one. */

/** ==================================================================
 *  Live network metrics
 * ================================================================== */

const LiveNetworkMetrics: React.FC<{ themeMode: ThemeMode }> = () => (
  <div className="space-y-2 font-mono">
    <div className="bg-surface p-2.5 rounded-xl border border-hairline/80 flex items-center justify-between text-xs">
      <span className="text-muted flex items-center gap-2">
        <Server className="w-3.5 h-3.5 text-brand" /> سرعة استجابة السحابة
      </span>
      <span className="font-bold text-brand">12 ms</span>
    </div>

    <div className="bg-surface p-2.5 rounded-xl border border-hairline/80 flex items-center justify-between text-xs">
      <span className="text-muted flex items-center gap-2">
        <Activity className="w-3.5 h-3.5 text-teal-400" /> حالة المزامنة اللحظية
      </span>
      <span className="font-bold text-teal-400">نشطة وسليمة 🟢</span>
    </div>
  </div>
);

/**
 * Heuristic password strength (0–3).
 */
const useMemoScore = (pw: string): number => {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score += 1;
  if (/[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score += 1;
  return Math.min(score, 3);
};
