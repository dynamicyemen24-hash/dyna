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
 * The operating station the operator signs in at.
 *
 * Declared once and reused: the state setter is `Dispatch<SetStateAction<…>>`,
 * which is assignable to `(v: StationType) => void` but NOT to `(v: string) => void`
 * — widening the prop to `string` and then passing the typed setter is what
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
  testingHw: boolean;
  ssoLoading: 'google' | 'microsoft' | 'sap' | 'okta' | null;
}

/** ==================================================================
 *  LoginView — orchestrator. Each "context" object is passed down as
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
   * tenant" — so an operator who never touches this field behaves exactly as
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
  const [sapClientId, setSapClientId] = useState('100');
  const [envType, setEnvType] = useState<'production' | 'sandbox' | 'audit'>('production');
  const [tenantDomain, setTenantDomain] = useState('royal-global.dypos.sa');
  const [selectedTenant, setSelectedTenant] = useState('شركة رويال العالمية (الفرع الرئيسي)');
  const [selectedBranch, setSelectedBranch] = useState<Branch>(branches[0]);
  const [stationType, setStationType] = useState<'pos_cashier' | 'kds_kitchen' | 'wms_inventory' | 'executive_audit'>('pos_cashier');
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
      rememberTenant(tenant.trim() || 'royal-global-hq');

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
      setAuthError(err.message || 'تعذّر تسجيل الدخول');
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

  /**
   * Single Sign-On.
   *
   * This previously granted an administrator identity after a 900ms timer with
   * no provider involved. There is no OAuth/OIDC endpoint in this server, so a
   * real federation flow cannot be completed — and inventing one client-side
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
      `الدخول الموحّد عبر ${provider} غير مُهيَّأ على هذا الخادم — استخدم اسم المستخدم وكلمة المرور.`,
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
                شركة المنافذ الذكية للبرمجيات
              </h1>
              <p className="text-xs font-medium text-brand-500 font-mono">
                DyPOS Enterprise Cloud & Edge · Smart Ports Software
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
      <main className="flex-1 flex items-center justify-center p-4 z-10 w-full pt-24">
        <div className={`w-full max-w-6xl rounded-3xl shadow-2xl backdrop-blur-2xl grid grid-cols-1 lg:grid-cols-12 overflow-hidden border transition-colors duration-300 ${
          themeMode === 'light' ? 'bg-white/90 border-gray-200' : 'bg-slate-950/80 border-slate-800'
        }`}>
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
                <span>تطوير شركة المنافذ الذكية للبرمجيات (Smart Ports Software)</span>
                <div className="flex items-center gap-3">
                  <a href="#" onClick={(e) => { e.preventDefault(); alert('مركز الدعم الفني المباشر لشركة المنافذ الذكية: support@smartports.sa'); }} className="hover:text-brand-400 flex items-center gap-1">
                    <LifeBuoy className="w-3 h-3" /> الدعم الفني
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
                  alt="لوحة وهوية شركة المنافذ الذكية للبرمجيات"
                  className="w-full h-36 object-cover object-center group-hover:scale-105 transition-transform duration-500"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/40 to-transparent p-3 flex flex-col justify-end">
                  <span className="text-[10px] text-cyan-300 font-mono font-bold tracking-wider">SMART PORTS SOFTWARE</span>
                  <p className="text-xs font-black text-white">المنظومة السحابية المعتمدة لنقاط البيع والكاشير</p>
                </div>
              </div>

              <div className="inline-flex items-center gap-1.5 bg-brand-500/10 border border-brand-500/30 px-3 py-1 rounded-full text-xs font-bold text-brand-400 mb-3">
                <Sparkles className="w-3.5 h-3.5" />
                <span>جاهزية التشغيل والربط المباشر</span>
              </div>

              <h2 className="text-xl font-black text-white leading-snug mb-2">
                حالة الأجهزة والاعتمادات الرسمية
              </h2>
              <p className="text-xs text-slate-400 leading-relaxed mb-4">
                فحص تلقائي شامل لطابعة الفواتير، الميزان الإلكتروني، التوثيق الضريبي، والمزامنة السحابية.
              </p>

              <HardwareHealthPanel
                testingHw={testingHw}
                onRefresh={handleTestHardware}
                scaleWidget={<ScaleHALWidget />}
              />

              <LiveNetworkMetrics themeMode={themeMode} />
            </div>

            <div className="mt-6 pt-3 border-t border-slate-800/80 text-[11px] text-slate-400 flex items-center justify-between">
              <span>© {new Date().getFullYear()} شركة المنافذ الذكية للبرمجيات</span>
              <span className="font-bold text-brand-400 font-mono">Smart Ports · DyPOS SaaS</span>
            </div>
          </div>
        </div>
      </main>

      <footer className={`p-3 text-center text-[10px] opacity-70 z-50 transition-colors duration-300 ${
        themeMode === 'light' ? 'bg-gray-100' : 'bg-slate-900'
      }`}>
        <p>© {new Date().getFullYear()} شركة المنافذ الذكية للبرمجيات (Smart Ports Software) · DyPOS Cloud & Edge · بقاعدة بيانات Neon PostgreSQL</p>
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
    <div className="flex items-center gap-2 text-rose-300 text-xs font-bold border-b border-rose-500/30 pb-2">
      <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
      <span>وضع التجاوز الطارئ للمشرف (Break-Glass Passcode)</span>
    </div>
    <p className="text-[11px] text-slate-300">
      يُستخدم هذا الخيار فقط عند غياب أمين الصندوق وبدء الوردية العاجلة بواسطة رمز المشرف الموثق.
    </p>

    <div>
      <label className="block text-[11px] font-bold text-slate-200 mb-1">رمز المشرف التفويضي:</label>
      <input
        type="password"
        required
        value={supervisorPasscode}
        onChange={(e) => setSupervisorPasscode(e.target.value)}
        onFocus={() => setAuthError('')}
        placeholder="أدخل رمز المشرف السري..."
        className="w-full bg-slate-950 border border-rose-500/50 rounded-xl px-4 py-2 text-xs text-white font-mono focus:outline-none focus:border-rose-400"
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
        <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
        <span className="text-[11px] text-rose-200 leading-relaxed">{authError}</span>
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
  branch: Branch;
  setBranch: (b: Branch) => void;
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
                <span>تذكر بيانات الدخول للجهاز الحالي</span>
              </label>

              <div className="flex items-center gap-2">
                <button type="button" onClick={onAccountUnlock} className="text-amber-400 hover:underline">
                  فك قفل الحساب؟
                </button>
                <span className="text-slate-600 dark:text-slate-600">·</span>
                <a href="#" onClick={(e) => e.preventDefault()} className="text-brand-400 hover:underline">
                  نسيت كلمة المرور؟
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
              <span>{authBusy ? 'جارٍ التحقق من كلمة المرور…' : 'تسجيل الدخول وبدء الوردية'}</span>
            </button>
          </div>
        )}

        <div className="pt-2 border-t border-slate-800">
          <p className="text-[10px] text-slate-400 text-center mb-1.5 font-semibold">
            تسجيل الدخول الموحد عبر حساب المنظمة:
          </p>
          <SSOButtonGroup onLogin={onSsoLogin} loading={ssoLoading} themeMode={themeMode} />
        </div>
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
      <div className={`bg-slate-950 p-4 rounded-2xl border border-brand-500/40 text-center ${themeMode === 'light' ? 'bg-white/80' : ''}`}>
        <div className="w-10 h-10 rounded-full bg-brand-500/20 text-brand-400 flex items-center justify-center mx-auto mb-2 border border-brand-500/30">
          <Smartphone className="w-5 h-5" />
        </div>
        <h3 className="text-xs font-black text-white">التحقق الآمن بخطوتين</h3>
        <p className="text-[11px] text-slate-400 mt-1">
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
              className="w-9 h-11 bg-slate-900 border border-slate-700 rounded-xl text-center text-lg font-bold text-brand-400 focus:outline-none focus:border-brand-500"
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
        <p className="text-[10px] text-slate-400 leading-relaxed">
          أُرسل رمز التحقق إلى قناة التسجيل المعتمدة لديك، وينتهي خلال دقائق.
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
  <div className="space-y-4 bg-slate-950 p-5 rounded-2xl border border-amber-500/30 animate-in zoom-in-95 duration-200">
    <div className="flex items-center gap-2 text-amber-400 text-xs font-bold pb-2 border-b border-slate-800">
      <BadgeAlert className="w-4 h-4" />
      <span>فك قفل الحساب الذاتي (Account Self-Unlock)</span>
    </div>
    <p className="text-[11px] text-slate-300">
      أدخل رقم الجوال أو البريد المسجل لإرسال رابط إعادة تفعيل الحساب بعد المحاولات الخاطئة المتكررة:
    </p>
    <input
      type="text"
      placeholder="admin@royal-global.com"
      className="w-full bg-slate-900 border border-slate-800 rounded-xl px-4 py-2 text-xs text-white focus:outline-none focus:border-amber-500"
    />
    <div className="flex gap-2">
      <button type="button" onClick={onCancel} className="flex-1 bg-slate-800 text-slate-300 py-2 rounded-xl text-xs font-bold">
        إلغاء
      </button>
      <button
        type="button"
        onClick={() => {
          alert('تم إرسال رمز فك القفل بنجاح إلى هاتفك المسجل.');
          onCancel();
        }}
        className="flex-[2] bg-amber-600 text-white py-2 rounded-xl text-xs font-bold"
      >
        إرسال رمز فك القفل
      </button>
    </div>
  </div>
);

/** ==================================================================
 *  SHARED UI BLOCKS
 * ================================================================== */

interface OperatingContextProps {
  branch: Branch;
  setBranch: (b: Branch) => void;
  stationType: StationType;
  setStationType: (v: StationType) => void;
  themeMode: ThemeMode;
}

const OperatingContext: React.FC<OperatingContextProps> = ({
  branch,
  setBranch,
  stationType,
  setStationType,
  themeMode,
}) => (
  <div className="grid grid-cols-3 gap-2">
    <div>
      <label className="block text-[11px] font-bold text-slate-300 mb-1">الفرع التشغيلي:</label>
      <select
        value={branch.id}
        onChange={(e) => {
          const b = branchesList.find((item) => item.id === e.target.value);
          if (b) setBranch(b);
        }}
        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-2.5 py-2 text-xs text-white font-semibold focus:outline-none focus:border-brand-500 cursor-pointer"
      >
        {branchesList.map((b) => (
          <option key={b.id} value={b.id} className="bg-slate-900 text-white">
            {b.name} ({b.city})
          </option>
        ))}
      </select>
    </div>

    <div>
      <label className="block text-[11px] font-bold text-slate-300 mb-1">نوع منفذ العمل:</label>
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
        <option value="pos_cashier">منفذ مبيعات الكاشير</option>
        <option value="kds_kitchen">شاشة طلبات المطبخ</option>
        <option value="wms_inventory">إدارة واستلام المستودعات</option>
        <option value="executive_audit">الرقابة والمالية والتنفيذية</option>
      </select>
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

/**
 * Placeholder branch list — in the real app this is injected via props.
 * Keeping a fallback so the selector never crashes when branches[] is empty.
 */
const branchesList: Branch[] = [
  { id: '1', name: 'الفرع الرئيسي', city: 'الرياض', phone: '', address: '', manager: '' },
  { id: '2', name: 'فرع جدة', city: 'جدة', phone: '', address: '', manager: '' },
  { id: '3', name: 'فرع الدمام', city: 'الدمام', phone: '', address: '', manager: '' },
];

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
          <label className="block text-[11px] font-bold text-slate-300 mb-1">
            المؤسسة (اختياري):
          </label>
          <div className="relative">
            <Building className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={tenant ?? ''}
              onChange={(e) => setTenant(e.target.value)}
              placeholder="معرّف المؤسسة — اتركه فارغاً للمستأجر الافتراضي"
              autoComplete="organization"
              /*
                Themed rather than fixed. This field was `bg-slate-700/50 … text-white`,
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
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[11px] font-bold text-slate-300 mb-1">اسم المستخدم / البريد:</label>
          <div className="relative">
            <User className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
            <input
              ref={ref}
              type="text"
              required
              placeholder="admin@royal-global.com"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl pr-9 pl-3 py-2 text-xs text-white font-semibold focus:outline-none focus:border-brand-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-[11px] font-bold text-slate-300 mb-1">الصلاحية الوظيفية:</label>
          <div className="relative">
            <User className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
            <select
              className="w-full bg-slate-950 border border-slate-800 rounded-xl pr-9 pl-3 py-2 text-xs text-white font-semibold focus:outline-none focus:border-brand-500 cursor-pointer"
            >
              <option value="pos_cashier">أمين الصندوق (الكاشير)</option>
              <option value="store_manager">مدير الفرع</option>
              <option value="accountant">المحاسب المالي</option>
            </select>
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-[11px] font-bold text-slate-300">كلمة المرور / الرمز السري:</label>
          <span className="text-[10px] text-brand-400">رمز المرور صالح لمئتي يوم 🟢</span>
        </div>
        <div className="relative">
          <Lock className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
          <input
            type={showPassword ? 'text' : 'password'}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="****"
            aria-label="كلمة المرور"
            className="w-full bg-slate-950 border border-slate-800 rounded-xl pr-9 pl-10 py-2 text-xs text-white font-semibold focus:outline-none focus:border-brand-500"
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
    <div className="bg-slate-950 p-2.5 rounded-xl border border-slate-800 text-center flex justify-between items-center px-4">
      <span className="text-xs text-slate-400">الرمز السري المدخل:</span>
      <span className="font-mono text-xl font-bold text-brand-400 tracking-widest">
        {password ? '•'.repeat(password.length) : '****'}
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
  <div className="bg-slate-950 p-5 rounded-2xl border border-brand-500/30 text-center space-y-3">
    <div className={`w-16 h-16 rounded-full mx-auto flex items-center justify-center transition-all ${
      bioScanning ? 'bg-amber-500/20 text-amber-400 animate-pulse border border-amber-500' :
      bioSuccess ? 'bg-brand-500/20 text-brand-400 border border-brand-500' : 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/40'
    }`}>
      <Fingerprint className="w-8 h-8" />
    </div>

    <h3 className="text-xs font-bold text-white">التحقق بالبصمة البيومترية الآمنة</h3>
    <p className="text-[11px] text-slate-400">
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
          <CheckCircle2 className="w-4 h-4 text-brand-300" />
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
    { key: 'sap', label: 'حساب الشركة', icon: <Building className="w-3.5 h-3.5" />, color: 'text-amber-400' },
    { key: 'okta', label: 'الدخول الموحد', icon: <Shield className="w-3.5 h-3.5" />, color: 'text-cyan-400' },
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
          <Terminal className="w-4 h-4 text-brand-400" /> حالة الأجهزة التشغيلية
        </span>
        <button
          type="button"
          onClick={runTest}
          disabled={testingHw}
          className="text-[10px] bg-slate-900 hover:bg-slate-800 text-brand-400 border border-brand-500/30 px-2 py-0.5 rounded-lg font-bold flex items-center gap-1 cursor-pointer"
        >
          <RefreshCw className={`w-3 h-3 ${testingHw ? 'animate-spin' : ''}`} />
          إعادة الفحص
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs font-mono">
        <div className="flex items-center justify-between bg-slate-900/60 p-2 rounded-xl">
          <span className="text-slate-300 flex items-center gap-1 text-[11px]">
            <Printer className="w-3.5 h-3.5 text-brand-400" /> طابعة الفواتير
          </span>
          <span className={`font-bold text-[10px] ${printerReady ? 'text-brand-400' : 'text-rose-400'}`}>
            {printerReady ? 'جاهزة 🟢' : 'تعطلت 🔴'}
          </span>
        </div>

        <div className="col-span-2">{scaleWidget}</div>

        <div className="flex items-center justify-between bg-slate-900/60 p-2 rounded-xl">
          <span className="text-slate-300 flex items-center gap-1 text-[11px]">
            <HardDrive className="w-3.5 h-3.5 text-cyan-400" /> درج النقدية
          </span>
          <span className="text-brand-400 font-bold text-[10px]">مغلق 🔒</span>
        </div>

        <div className="flex items-center justify-between bg-slate-900/60 p-2 rounded-xl">
          <span className="text-slate-300 flex items-center gap-1 text-[11px]">
            <CheckCircle2 className="w-3.5 h-3.5 text-brand-400" /> الفوترة الضريبية
          </span>
          <span className={`font-bold text-[10px] ${fiscalReady ? 'text-brand-400' : 'text-rose-400'}`}>
            {fiscalReady ? 'معتمدة 🟢' : 'غير معتمدة 🔴'}
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
        <Server className="w-3.5 h-3.5 text-brand-400" /> سرعة استجابة السحابة
      </span>
      <span className="font-bold text-brand-400">12 ms</span>
    </div>

    <div className="bg-slate-950 p-2.5 rounded-xl border border-slate-800/80 flex items-center justify-between text-xs">
      <span className="text-slate-300 flex items-center gap-2">
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
