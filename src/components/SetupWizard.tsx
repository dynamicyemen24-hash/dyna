/**
 * SETUP WIZARD — NEW TENANT ONBOARDING (MULTI-TENANT)
 * ═════════════════════════════════════════════════════════════════
 *
 * This is NOT RegistrationView. RegistrationView creates an OWNER
 * INSIDE the tenant this deployment is pinned to — the tenant
 * `/api/auth/login` searches. This wizard creates a completely NEW
 * tenant — tenant row, owner user, default branch, subscription and
 * device trust — in one transaction through the real identity
 * endpoint:
 *
 *      POST /api/identity/enroll
 *      (server/identityRoutes.ts and worker/index.ts — one contract)
 *
 * SEVEN STEPS, each validated before the next is reachable:
 *
 *   1. TENANT       — tenant name, tenant code (slug), owner company
 *   2. OWNER USER   — owner name, username, email, phone, password
 *   3. BRANCH       — branch name, address, city, phone
 *   4. SUBSCRIPTION — plan + billing cycle
 *   5. CURRENCY/VAT — country-prefilled base currency + VAT rate
 *   6. PAYMENTS     — which payment methods the tenant enables
 *   7. REVIEW       — everything, then one submit
 *
 * ══ WHAT THE SERVER ACTUALLY CONSUMES ════════════════════════════
 * The enrollment contract accepts exactly: tenantName, tenantCode,
 * ownerName, username, email, phone, password, branchName,
 * deviceFingerprint, idempotencyKey. Everything else the wizard
 * collects (owner company, branch address/city/phone, plan, billing
 * cycle, currency, VAT, payment methods) is sent ALONGSIDE those
 * fields: a server that grows the contract can apply them, and the
 * shipped server ignores unknown body fields by design. Nothing is
 * fabricated onto the tenant client-side — the enrollment engine
 * provisions its own defaults today (an enterprise subscription and
 * a head-office branch), and currency/VAT/plan/payment settings are
 * applied by an administrator from الإعدادات afterwards, exactly as
 * RegistrationView's onboarding step applies its profile through the
 * real `POST /api/db/tenant/profile` write.
 *
 * ══ OWNER NAME vs OWNER COMPANY ══════════════════════════════════
 * The engine writes its single `ownerName` into BOTH
 * `tenants.owner_company` and `users.name` (the operator's display
 * name). The wizard collects both because they are different things;
 * it sends the PERSON's name as `ownerName` — the identity the owner
 * signs in under and the name audit logs show — and carries the
 * company name as `ownerCompany` under the forward-compat contract
 * above.
 *
 * ══ IDEMPOTENCY ══════════════════════════════════════════════════
 * A retried enrollment must never create a second tenant. The key is
 * sent in the `Idempotency-Key` HEADER (the Cloudflare Worker
 * replays cached results against it) AND in the body as
 * `idempotencyKey` (the Express engine's lookup key), so both
 * runtimes deduplicate. The key is minted once per distinct identity
 * payload: retrying unchanged data reuses it, editing any identity
 * field mints a fresh one.
 *
 * ══ DEVICE FINGERPRINT ═══════════════════════════════════════════
 * `device_trust` is written by the Worker with status `pending`
 * from the client-supplied fingerprint. It is built from a persistent
 * per-device random id plus stable hardware signals, SHA-256 hashed.
 * It is deliberately NOT a security boundary — it identifies a device
 * for trust workflows; the server decides what to trust.
 *
 * ══ AFTER ENROLLMENT ═════════════════════════════════════════════
 * Enrollment issues no session, exactly like registration. The wizard
 * signs the owner in for real (`/api/auth/login` against the NEW
 * tenant id), persists the token, and reports through `onComplete`.
 * If the automatic sign-in fails, the tenant still exists and is
 * healthy — the callback reports `session: null` so the shell sends
 * the operator to the login screen with a success message (the
 * credentials they just chose) instead of an error.
 */
import React, { useEffect, useRef, useState } from 'react';
import { apiPost, rememberTenant, TOKEN_KEY } from '../services/dyposApi';
import {
  Field,
  GhostButton,
  Input,
  MessageStrip,
  PrimaryButton,
  Select,
  StandardProgress,
} from './ui/Primitives';
import { Check, CheckCircle2, Loader2 } from 'lucide-react';
import { COUNTRIES } from './RegistrationView';
import type { AuthedSession } from './LoginView';

/**
 * The enrollment result, mirrored from `EnrollmentResult` in
 * server/enrollmentEngine.ts — the server is the source of this
 * shape; keep the two in sync when the engine grows fields.
 */
export interface EnrollmentResult {
  state:
    | 'NEW_TENANT'
    | 'VERIFIED_EXISTING_TENANT'
    | 'PENDING_VERIFICATION'
    | 'EXISTING_TENANT_NO_BRANCH'
    | 'EXISTING_USER_NO_ACCESS'
    | 'AMBIGUOUS_IDENTITY';
  tenantId?: string;
  userId?: string;
  branchId?: string;
  reason: string;
  proofRequired?: string[];
  confidence?: number;
  idempotencyKey?: string;
}

/** Response envelope of POST /api/identity/enroll. */
interface EnrollResponse {
  ok: boolean;
  result: EnrollmentResult;
  prereq?: { decision: string; reason?: string };
  /** Set when the Cloudflare Worker replayed a cached enrollment. */
  replayed?: boolean;
}

/**
 * What the wizard reports to its parent. `session` is null when the
 * tenant was created but the automatic sign-in failed — the shell
 * then routes the operator to the login screen rather than the
 * workspace, with the success message the component already shows.
 */
export interface SetupWizardResult {
  enrollment: EnrollmentResult;
  session: AuthedSession | null;
}

interface Props {
  /**
   * Fired exactly once, when the enrollment chain finishes. Receives
   * the server's enrollment result and, when the automatic sign-in
   * succeeded, the session (its token is already persisted under
   * TOKEN_KEY, so the shell only has to adopt it).
   */
  onComplete?: (result: SetupWizardResult) => void;
}

/* ------------------------------ Catalogues ------------------------------ */

const STEPS = [
  { id: 'tenant', label: 'بيانات المستأجر' },
  { id: 'owner', label: 'المالك' },
  { id: 'branch', label: 'الفرع' },
  { id: 'subscription', label: 'الاشتراك' },
  { id: 'currency', label: 'العملة والضريبة' },
  { id: 'payments', label: 'طرق الدفع' },
  { id: 'review', label: 'المراجعة والتأكيد' },
] as const;

/** The visible phases of the final submit, in order. */
const PHASES = ['إنشاء المستأجر', 'فتح جلسة المالك', 'إتمام الإعداد'];

/**
 * Subscription plans offered at onboarding. The enrollment engine
 * provisions its own default subscription today (plan-enterprise, see
 * enrollmentEngine.ts), so this selection is the operator's INTENDED
 * plan — sent with the request for the forward-compat contract in the
 * file header, never claimed by this client as applied.
 */
const PLANS = [
  { id: 'trial', nameAr: 'تجريبي' },
  { id: 'standard', nameAr: 'قياسي' },
  { id: 'professional', nameAr: 'احترافي' },
  { id: 'enterprise', nameAr: 'مؤسسي' },
] as const;

const BILLING_CYCLES = [
  { id: 'monthly', nameAr: 'شهري' },
  { id: 'yearly', nameAr: 'سنوي' },
] as const;

/**
 * Payment methods a tenant can enable. The ids are the product's real
 * payment enums — POSView's `cash | card | mada | apple_pay` and the
 * gateway's `stc_pay | bank_transfer` — not invented values. The
 * enrollment contract does not persist them yet; the POS applies its
 * own defaults until an administrator configures the tenant.
 */
const PAYMENT_METHODS = [
  { id: 'cash', nameAr: 'نقدي' },
  { id: 'card', nameAr: 'بطاقة' },
  { id: 'mada', nameAr: 'شبكة مدى' },
  { id: 'apple_pay', nameAr: 'Apple Pay' },
  { id: 'stc_pay', nameAr: 'STC Pay' },
  { id: 'bank_transfer', nameAr: 'تحويل بنكي' },
] as const;

/** ISO 4217 codes across the supported markets — real values only. */
const CURRENCIES = Array.from(new Set(COUNTRIES.map((c) => c.currency)));

/* ------------------------- Form state (one object) ------------------------- */

interface FormState {
  // 1 — tenant
  tenantName: string;
  tenantCode: string;
  ownerCompany: string;
  // 2 — owner user
  ownerName: string;
  username: string;
  email: string;
  phone: string;
  password: string;
  confirmPassword: string;
  // 3 — branch
  branchName: string;
  branchLocation: string;
  branchCity: string;
  branchPhone: string;
  // 4 — subscription
  plan: string;
  billingCycle: string;
  // 5 — currency & VAT (prefilled from the country catalogue)
  country: string;
  currency: string;
  vatRate: string;
  // 6 — payment methods
  paymentMethods: string[];
}

/**
 * A random idempotency key. `crypto.randomUUID` is unavailable in
 * non-secure contexts, so the fallback stays random enough for a
 * deduplication key (the server treats the key as opaque).
 */
function newIdempotencyKey(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the random fallback.
  }
  return `enroll-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

const DEVICE_ID_STORAGE = 'dypos_device_id';

/**
 * A stable, non-secret device fingerprint for the `device_trust` table.
 *
 * Built from a persistent per-device random id (so the fingerprint
 * survives browser restarts even if one signal changes) plus stable
 * hardware signals, SHA-256 hashed. Hashing keeps the raw signals off
 * the wire — the server stores only the digest. It is deliberately NOT
 * a security boundary: it identifies a device for trust workflows, and
 * the server decides what to trust (the Worker writes status `pending`).
 */
async function buildDeviceFingerprint(): Promise<string> {
  const signals: string[] = [];
  try {
    signals.push(navigator.userAgent);
    signals.push(navigator.language || '');
    signals.push(Intl.DateTimeFormat().resolvedOptions().timeZone || '');
    signals.push(`${screen.width}x${screen.height}`);
    signals.push(navigator.platform || '');
    signals.push(String(navigator.hardwareConcurrency || ''));
  } catch {
    // A restricted browser surfaces fewer signals — the persistent id
    // below still yields a stable fingerprint.
  }

  let deviceId = '';
  try {
    deviceId = localStorage.getItem(DEVICE_ID_STORAGE) || '';
    if (!deviceId) {
      deviceId = newIdempotencyKey();
      localStorage.setItem(DEVICE_ID_STORAGE, deviceId);
    }
  } catch {
    // Storage unavailable (private mode): the fingerprint is then
    // per-session — acceptable, the server marks it pending anyway.
    deviceId = newIdempotencyKey();
  }

  const material = `${deviceId}|${signals.join('|')}`;
  try {
    if (crypto.subtle) {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(material),
      );
      return Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
    }
  } catch {
    // Fall through to the non-crypto hash below.
  }

  /*
   * Non-secure-context fallback (an http:// LAN terminal, for example):
   * FNV-1a over the same material. NOT a security boundary — it only
   * needs to be stable, which it is.
   */
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}-${deviceId.slice(0, 12)}`;
}

/**
 * Client-side strength METER only, scored with the same rules as the
 * server's `checkPasswordStrength` (server/passwords.ts) so the meter
 * and the verdict never disagree. It is a hint: the server re-validates
 * on submit and its answer is the one that counts.
 */
function passwordScore(p: string): number {
  let score = 0;
  if (p.length >= 4) score++;
  if (p.length >= 6) score++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) score++;
  if (/\d/.test(p) && /[^A-Za-z0-9]/.test(p)) score++;
  return score;
}
/* ------------------------------ Sub-views ------------------------------ */

/** One summary block on the review step, with a jump-back edit action. */
const ReviewGroup: React.FC<{
  title: string;
  step: number;
  onEdit: (step: number) => void;
  rows: [string, string][];
}> = ({ title, step, onEdit, rows }) => (
  <div className="surface-card p-4">
    <div className="flex items-center justify-between gap-2 mb-2.5">
      <h3 className="text-sm font-bold text-ink">{title}</h3>
      <button
        type="button"
        onClick={() => onEdit(step)}
        className="text-brand hover:underline text-[11px] font-bold"
      >
        تعديل
      </button>
    </div>
    <dl className="grid sm:grid-cols-2 gap-x-4 gap-y-1.5">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-2">
          <dt className="text-[11px] text-faint shrink-0">{k}</dt>
          <dd
            className="text-xs text-ink font-semibold text-end truncate"
            title={v}
          >
            {v || '—'}
          </dd>
        </div>
      ))}
    </dl>
  </div>
);

/** One label/value line of the completion summary. */
const SummaryRow: React.FC<{ label: string; value: string; mono?: boolean }> = ({
  label,
  value,
  mono = false,
}) => (
  <div className="flex items-baseline justify-between gap-3">
    <span className="text-[11px] text-faint shrink-0">{label}</span>
    <span
      className={`text-xs text-ink font-semibold text-end truncate ${mono ? 'font-mono' : ''}`}
      dir={mono ? 'ltr' : undefined}
      title={value}
    >
      {value || '—'}
    </span>
  </div>
);

/* ------------------------------ Component ------------------------------ */

export const SetupWizard: React.FC<Props> = ({ onComplete }) => {
  const [stepIndex, setStepIndex] = useState(0);
  const [form, setForm] = useState<FormState>(() => ({
    // 1 — tenant
    tenantName: '',
    tenantCode: '',
    ownerCompany: '',
    // 2 — owner user
    ownerName: '',
    username: '',
    email: '',
    phone: '',
    password: '',
    confirmPassword: '',
    // 3 — branch
    branchName: '',
    branchLocation: '',
    branchCity: '',
    branchPhone: '',
    // 4 — subscription
    plan: 'trial',
    billingCycle: 'monthly',
    // 5 — currency & VAT: prefilled from the FIRST catalogue entry so
    // no default is hand-typed here (two sources would drift).
    country: COUNTRIES[0].code,
    currency: COUNTRIES[0].currency,
    vatRate: String(COUNTRIES[0].vat),
    // 6 — payment methods: the market defaults (cash, card, mada).
    paymentMethods: ['cash', 'card', 'mada'],
  }));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [phaseIndex, setPhaseIndex] = useState(-1);
  const [result, setResult] = useState<SetupWizardResult | null>(null);
  const [deviceFingerprint, setDeviceFingerprint] = useState('');

  /**
   * Idempotency keys are minted per distinct identity payload: a retry
   * of unchanged data reuses the key (the server replays the stored
   * result), while editing any identity field mints a fresh one.
   */
  const idempotencyRef = useRef<{ payload: string; key: string } | null>(null);

  // Generate the device fingerprint once on mount; crypto.subtle can be
  // slow, so it must not block first paint.
  useEffect(() => {
    let cancelled = false;
    buildDeviceFingerprint().then((fp) => {
      if (!cancelled) setDeviceFingerprint(fp);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Typed setter for the single form object. */
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => {
      const next = { ...f };
      next[key] = value;
      return next;
    });
  };

  const togglePayment = (id: string) =>
    setForm((f) => ({
      ...f,
      paymentMethods: f.paymentMethods.includes(id)
        ? f.paymentMethods.filter((m) => m !== id)
        : [...f.paymentMethods, id],
    }));

  /**
   * Country → currency + VAT. The catalogue carries each market's real
   * ISO currency and standard VAT rate, so the prefill is data, not a
   * guess; every value stays editable for markets with reduced rates.
   */
  const onCountryChange = (code: string) => {
    const match = COUNTRIES.find((c) => c.code === code);
    setForm((f) => ({
      ...f,
      country: code,
      currency: match?.currency ?? f.currency,
      vatRate: String(match?.vat ?? f.vatRate),
    }));
  };

  const idempotencyKeyFor = (payload: string): string => {
    if (idempotencyRef.current?.payload === payload) {
      return idempotencyRef.current.key;
    }
    const key = newIdempotencyKey();
    idempotencyRef.current = { payload, key };
    return key;
  };

  /**
   * Per-step validation. Deliberately MINIMAL — a gate, not a mirror of
   * the server policy (the same rationale as RegistrationView: a
   * stricter client mirror once drifted from the server and silently
   * blocked valid input). The server's `checkPasswordStrength` and its
   * identity resolution remain the judges; their refusals surface
   * verbatim from the catch below.
   */
  const validateStep = (index: number): string | null => {
    switch (index) {
      case 0:
        if (!form.tenantName.trim()) return 'اسم المستأجر مطلوب';
        {
          const code = form.tenantCode.trim().toLowerCase();
          if (code.length < 2 || code.length > 63)
            return 'رمز المستأجر من ٢ إلى ٦٣ حرفاً';
          if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(code))
            return 'رمز المستأجر: أحرف لاتينية صغيرة وأرقام وشرطات، يبدأ وينتهي بحرف أو رقم';
        }
        if (!form.ownerCompany.trim()) return 'اسم الشركة المالكة مطلوب';
        return null;
      case 1:
        if (!form.ownerName.trim()) return 'اسم المالك مطلوب';
        {
          const username = form.username.trim().toLowerCase();
          if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(username))
            return 'اسم المستخدم من ٢ إلى ٣٢ حرفاً: أحرف لاتينية صغيرة وأرقام ونقاط وشرطات';
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()))
          return 'البريد الإلكتروني غير صالح';
        if (form.phone.replace(/[\s-]/g, '').length < 7)
          return 'رقم هاتف المالك غير مكتمل';
        if (form.password.length < 4)
          return 'الرمز يجب ألا يقل عن 4 خانات (حروف أو أرقام)';
        if (form.password !== form.confirmPassword)
          return 'تأكيد كلمة المرور غير متطابق';
        return null;
      case 2:
        if (!form.branchName.trim()) return 'اسم الفرع مطلوب';
        if (!form.branchCity.trim()) return 'مدينة الفرع مطلوبة';
        if (
          form.branchPhone.trim() &&
          form.branchPhone.replace(/[\s-]/g, '').length < 7
        )
          return 'رقم هاتف الفرع غير مكتمل';
        return null;
      case 4:
        if (!/^[A-Z]{3}$/.test(form.currency.trim().toUpperCase()))
          return 'رمز العملة يجب أن يكون ٣ أحرف لاتينية كبرى (مثل SAR)';
        {
          const vat = Number(form.vatRate);
          if (!Number.isFinite(vat) || vat < 0 || vat > 100)
            return 'نسبة ضريبة القيمة المضافة يجب أن تكون بين ٠ و ١٠٠';
        }
        return null;
      case 5:
        if (form.paymentMethods.length === 0)
          return 'فعّل طريقة دفع واحدة على الأقل';
        return null;
      default:
        // Subscription (3) always has a selection; review (6) submits.
        return null;
    }
  };

  /** Forward navigation — validates the current step first. */
  const next = (e: React.FormEvent) => {
    e.preventDefault();
    const blocking = validateStep(stepIndex);
    if (blocking) {
      setError(blocking);
      return;
    }
    setError('');
    setStepIndex((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const goStep = (index: number) => {
    setError('');
    setStepIndex(index);
  };
  /**
   * Review → submit. The chain is: enroll the tenant → sign the owner
   * in for real → report. Each phase is visible (PHASES) so the
   * operator knows a multi-step server operation is in flight and
   * must not close the window.
   */
  const finish = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;

    /*
     * The review step is only reachable through validated steps, but
     * the submit re-checks every gate and jumps to the first failure —
     * a wizard that was edited after navigating must never submit
     * half-valid data.
     */
    for (let i = 0; i < STEPS.length - 1; i++) {
      const blocking = validateStep(i);
      if (blocking) {
        setError(blocking);
        setStepIndex(i);
        return;
      }
    }

    setError('');
    setSaving(true);
    setPhaseIndex(0);
    try {
      /*
       * The fingerprint is generated on mount; await it here too so a
       * slow `crypto.subtle` can never submit an empty one — the Worker
       * only writes the `device_trust` row when a fingerprint exists.
       */
      const fingerprint = deviceFingerprint || (await buildDeviceFingerprint());

      const identityPayload = JSON.stringify({
        tenantName: form.tenantName.trim(),
        tenantCode: form.tenantCode.trim().toLowerCase(),
        ownerName: form.ownerName.trim(),
        username: form.username.trim().toLowerCase(),
        email: form.email.trim(),
        phone: form.phone.trim(),
      });
      const idempotencyKey = idempotencyKeyFor(identityPayload);

      /*
       * The engine has ONE phone slot: it writes it onto the default
       * branch and uses it for identity matching. The branch phone is
       * what the branch row should show, so it takes the slot, falling
       * back to the owner's contact number. Both are also carried in
       * the body for the forward-compat contract in the file header.
       */
      const phone = form.branchPhone.trim() || form.phone.trim();

      // 1 — create the tenant.
      const res = await apiPost<EnrollResponse>(
        '/api/identity/enroll',
        {
          tenantName: form.tenantName.trim(),
          tenantCode: form.tenantCode.trim().toLowerCase(),
          ownerName: form.ownerName.trim(),
          username: form.username.trim().toLowerCase(),
          email: form.email.trim(),
          phone,
          password: form.password,
          branchName: form.branchName.trim(),
          deviceFingerprint: fingerprint,
          idempotencyKey,
          /*
           * ── Forward-compatibility fields ───────────────────────────
           * NOT consumed by the shipped enrollment contract (see the
           * file header). They ride along so a server that grows the
           * contract can apply them; today the engine provisions its
           * own defaults and an administrator applies these from
           * الإعدادات. Sending them is not a claim that they were
           * applied.
           */
          ownerCompany: form.ownerCompany.trim(),
          ownerPhone: form.phone.trim(),
          branchLocation: form.branchLocation.trim(),
          branchCity: form.branchCity.trim(),
          branchPhone: form.branchPhone.trim(),
          plan: form.plan,
          billingCycle: form.billingCycle,
          countryCode: form.country,
          baseCurrency: form.currency.trim().toUpperCase(),
          vatRate: Number(form.vatRate),
          paymentMethods: form.paymentMethods,
        },
        /*
         * tenant=false: enrollment happens BEFORE any session exists,
         * so no x-tenant-id header may be sent — the header would carry
         * a stale localStorage value (or the boot default) and the
         * server resolves scope from the payload alone.
         */
        { tenant: false, headers: { 'Idempotency-Key': idempotencyKey } },
      );

      const enrollment = res.result;
      if (!enrollment) {
        throw new Error('تعذّر إنشاء المستأجر — الخادم لم يرجع نتيجة');
      }

      /*
       * 2 — sign the owner in for real. Enrollment issues no session,
       * exactly like registration, so without this call the freshly
       * created owner could not reach a single protected route.
       */
      setPhaseIndex(1);
      let session: AuthedSession | null = null;
      if (enrollment.tenantId) {
        /*
         * Pin every subsequent request — and the login call's own
         * x-tenant-id header — to the NEW tenant, so the app works
         * against the organisation that was just created.
         */
        rememberTenant(enrollment.tenantId);
        try {
          const loginRes = await apiPost<{ session: AuthedSession }>(
            '/api/auth/login',
            {
              username: form.username.trim().toLowerCase(),
              password: form.password,
              tenantId: enrollment.tenantId,
            },
          );
          session = loginRes.session;
          sessionStorage.setItem(TOKEN_KEY, session.token);
        } catch (loginErr) {
          /*
           * The tenant EXISTS and is healthy; only the automatic
           * sign-in failed (rate limit, transient fault). Nothing is
           * rolled back — there is nothing to roll back — and the
           * failure is not reported as an error: the operator can sign
           * in with the credentials they just chose. The callback
           * reports `session: null` so the shell routes them to the
           * login screen WITH the success message.
           */
          console.warn(
            '[setup-wizard] automatic sign-in failed after enrollment',
            loginErr,
          );
        }
      }

      // 3 — done.
      setPhaseIndex(2);
      const outcome: SetupWizardResult = { enrollment, session };
      setResult(outcome);
      onComplete?.(outcome);
    } catch (err: unknown) {
      /*
       * The server is the authority on refusals. `/api/identity/enroll`
       * answers 409 with its own `error` line for every identity
       * conflict (tenant exists, username taken, weak password on the
       * edge, pending verification) — surface it verbatim; 5xx is
       * already generalised by the API layer, with a support reference.
       */
      setError(err instanceof Error ? err.message : 'تعذّر إنشاء المستأجر');
      setSaving(false);
      setPhaseIndex(-1);
    }
  };

  /* ------------------------------ Derived ------------------------------ */

  const activeCountry =
    COUNTRIES.find((c) => c.code === form.country) ?? COUNTRIES[0];
  const pwScore = passwordScore(form.password);
  const scoreTone =
    pwScore <= 1 ? 'bg-err' : pwScore === 2 ? 'bg-amber-500' : 'bg-ok';
  const scoreLabel =
    pwScore <= 1
      ? 'ضعيفة'
      : pwScore === 2
        ? 'متوسطة'
        : pwScore === 3
          ? 'جيدة'
          : 'قوية';
  const planName = PLANS.find((p) => p.id === form.plan)?.nameAr ?? form.plan;
  const cycleName =
    BILLING_CYCLES.find((c) => c.id === form.billingCycle)?.nameAr ??
    form.billingCycle;
  const progress = ((stepIndex + 1) / STEPS.length) * 100;
  const fingerprintPreview = deviceFingerprint
    ? `${deviceFingerprint.slice(0, 16)}…`
    : 'جارٍ التوليد…';
  const paymentNames = form.paymentMethods
    .map((id) => PAYMENT_METHODS.find((m) => m.id === id)?.nameAr ?? id)
    .join('، ');
  /* ------------------------------ Render ------------------------------ */

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-ink">إنشاء مستأجر جديد</h1>
        <p className="text-muted mt-1">
          onboarding عميل جديد: يُنشئ المستأجر بالكامل — مالكه ومستخدمه وفرعه —
          عبر نقطة التسجيل الموحّدة.
        </p>
      </div>

      {result ? (
        /* ------------------------- Completion panel ------------------------- */
        <div className="space-y-5" role="status" aria-live="polite">
          <div className="text-center">
            <span className="inline-grid place-items-center w-14 h-14 rounded-2xl bg-ok-soft text-ok-strong mb-3">
              <CheckCircle2 size={28} aria-hidden="true" />
            </span>
            <h2 className="text-2xl font-bold text-ink">تم إنشاء المستأجر بنجاح</h2>
            <p className="text-muted mt-1.5 max-w-md mx-auto leading-relaxed">
              {result.session
                ? `أهلاً بك في DyPOS — تم إنشاء مستأجر «${form.tenantName}» وفتح الجلسة تلقائياً.`
                : `تم إنشاء مستأجر «${form.tenantName}». تعذّر فتح الجلسة تلقائياً — سجّل الدخول باسم المستخدم «${form.username}» وكلمة المرور التي اخترتها.`}
            </p>
          </div>

          <div className="surface-card p-4 space-y-2.5">
            <SummaryRow label="المستأجر" value={form.tenantName} />
            <SummaryRow label="رمز التسجيل" value={form.tenantCode} mono />
            <SummaryRow
              label="معرّف المستأجر"
              value={result.enrollment.tenantId ?? ''}
              mono
            />
            <SummaryRow label="الفرع الرئيسي" value={form.branchName} />
            <SummaryRow
              label="المالك"
              value={`${form.ownerName} (${form.username})`}
            />
          </div>

          {!result.session && (
            <MessageStrip
              tone="info"
              title="تم إنشاء المستأجر — أكمل تسجيل الدخول"
            >
              الحساب جاهز وبياناته محفوظة على الخادم. انتقل إلى شاشة تسجيل الدخول
              واستخدم اسم المستخدم وكلمة المرور اللذين اخترتهما لدخول مستأجرك الجديد.
            </MessageStrip>
          )}
        </div>
      ) : (
        <>
          {/* ------------------- Progress bar + step indicators ------------------- */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between text-[11px] font-bold">
              <span className="text-muted">
                الخطوة {stepIndex + 1} من {STEPS.length} — {STEPS[stepIndex].label}
              </span>
              <span className="text-faint text-numeric">
                {Math.round(progress)}%
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-subtle" aria-hidden="true">
              <div
                className="h-full rounded-full bg-brand-600 transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
            <ol
              className="flex items-center justify-center gap-1.5"
              aria-label="مراحل الإعداد"
            >
              {STEPS.map((s, i) => {
                const done = i < stepIndex;
                const current = i === stepIndex;
                return (
                  <li key={s.id} className="flex items-center gap-1.5">
                    <button
                      type="button"
                      /* Completed steps jump back; the future stays gated. */
                      disabled={!done}
                      onClick={() => goStep(i)}
                      aria-current={current ? 'step' : undefined}
                      aria-label={`الخطوة ${i + 1}: ${s.label}`}
                      className={`w-7 h-7 rounded-full grid place-items-center text-[11px] font-bold border transition-colors ${
                        done
                          ? 'bg-brand-600 border-brand-600 text-white cursor-pointer hover:bg-brand-500'
                          : current
                            ? 'border-brand-600 text-brand'
                            : 'border-hairline text-faint cursor-default'
                      }`}
                    >
                      {done ? (
                        <Check className="w-3.5 h-3.5" aria-hidden="true" />
                      ) : (
                        i + 1
                      )}
                    </button>
                    <span
                      className={`text-[11px] font-bold hidden md:block ${current ? 'text-ink' : 'text-faint'}`}
                    >
                      {s.label}
                    </span>
                    {i < STEPS.length - 1 && (
                      <span className="w-4 h-px bg-hairline" aria-hidden="true" />
                    )}
                  </li>
                );
              })}
            </ol>
          </div>

          {saving && phaseIndex >= 0 ? (
            /* --------------- Submit phases (like RegistrationView) --------------- */
            <div className="space-y-4" role="status" aria-live="polite">
              <StandardProgress
                label={`الخطوة ${phaseIndex + 1} من ${PHASES.length} — ${PHASES[phaseIndex]}`}
                detail="لا تُغلق النافذة: يتم إنشاء المستأجر ثم فتح جلسة المالك"
                value={((phaseIndex + 1) / PHASES.length) * 100}
              />
              <ul className="rounded-xl border border-hairline divide-y divide-hairline/60">
                {PHASES.map((p, i) => (
                  <li key={p} className="flex items-center gap-2 px-3 py-2 text-xs">
                    {i < phaseIndex ? (
                      <Check className="w-4 h-4 text-ok" aria-hidden="true" />
                    ) : i === phaseIndex ? (
                      <Loader2
                        className="w-4 h-4 animate-spin text-brand"
                        aria-hidden="true"
                      />
                    ) : (
                      <span
                        className="w-4 h-4 text-center text-faint"
                        aria-hidden="true"
                      >
                        ·
                      </span>
                    )}
                    <span
                      className={i <= phaseIndex ? 'text-ink font-semibold' : 'text-muted'}
                    >
                      {p}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <form
              className="space-y-5"
              onSubmit={stepIndex === STEPS.length - 1 ? finish : next}
              noValidate
            >
              {/* ------------------------- Step 1: tenant ------------------------- */}
              {stepIndex === 0 && (
                <div className="space-y-5">
                  <Field
                    label="اسم المستأجر"
                    hint="الاسم الذي يظهر في قائمة المستأجرين وعلى المستندات"
                  >
                    <Input
                      value={form.tenantName}
                      onChange={(e) => set('tenantName', e.target.value)}
                      placeholder="مثال: شركة المنافذ الذكية"
                      autoComplete="organization"
                      autoFocus
                      required
                    />
                  </Field>
                  <Field
                    label="رمز المستأجر"
                    hint="معرّف فريد بحروف لاتينية صغيرة — يُخزَّن كرمز التسجيل للمستأجر"
                  >
                    <Input
                      value={form.tenantCode}
                      onChange={(e) =>
                        set(
                          'tenantCode',
                          e.target.value
                            .toLowerCase()
                            .replace(/\s+/g, '-')
                            .replace(/[^a-z0-9-]/g, ''),
                        )
                      }
                      placeholder="smart-ports"
                      dir="ltr"
                      autoComplete="off"
                      required
                    />
                  </Field>
                  <Field
                    label="الشركة المالكة"
                    hint="الاسم القانوني للشركة المالكة للمستأجر"
                  >
                    <Input
                      value={form.ownerCompany}
                      onChange={(e) => set('ownerCompany', e.target.value)}
                      placeholder="المنافذ الذكية للتجارة"
                      autoComplete="organization"
                      required
                    />
                  </Field>
                </div>
              )}

              {/* ------------------------- Step 2: owner user ------------------------- */}
              {stepIndex === 1 && (
                <div className="space-y-5">
                  <Field label="اسم المالك">
                    <Input
                      value={form.ownerName}
                      onChange={(e) => set('ownerName', e.target.value)}
                      placeholder="الاسم الثلاثي للمالك"
                      autoComplete="name"
                      required
                    />
                  </Field>
                  <div className="grid sm:grid-cols-2 gap-4">
                    <Field label="اسم المستخدم">
                      <Input
                        value={form.username}
                        onChange={(e) => set('username', e.target.value.toLowerCase())}
                        placeholder="admin"
                        dir="ltr"
                        autoComplete="username"
                        required
                      />
                    </Field>
                    <Field label="البريد الإلكتروني">
                      <Input
                        type="email"
                        value={form.email}
                        onChange={(e) => set('email', e.target.value)}
                        placeholder="admin@example.com"
                        dir="ltr"
                        autoComplete="email"
                        required
                      />
                    </Field>
                  </div>
                  <Field label="هاتف المالك">
                    <Input
                      value={form.phone}
                      onChange={(e) => set('phone', e.target.value)}
                      placeholder="+966 5x xxx xxxx"
                      dir="ltr"
                      autoComplete="tel"
                      required
                    />
                  </Field>
                  <Field label="كلمة المرور">
                    <Input
                      type="password"
                      value={form.password}
                      onChange={(e) => set('password', e.target.value)}
                      placeholder="4 خانات على الأقل"
                      autoComplete="new-password"
                      required
                    />
                    {form.password.length > 0 && (
                      <div className="mt-2 space-y-1">
                        <div className="flex gap-1" aria-hidden="true">
                          {Array.from({ length: 4 }, (_, i) => (
                            <span
                              key={i}
                              className={`h-1 flex-1 rounded-full transition-colors ${
                                i < pwScore ? scoreTone : 'bg-hairline'
                              }`}
                            />
                          ))}
                        </div>
                        <p className="text-[11px] text-faint">
                          قوة كلمة المرور: {scoreLabel} — مؤشر إرشادي فقط، الخادم هو المعتمد.
                        </p>
                      </div>
                    )}
                    <p className="mt-1 text-[11px] text-faint leading-relaxed">
                      الشرط: 4 خانات على الأقل (حروف أو أرقام)، ولا تكون كلمة شائعة
                      أو تحتوي اسم المستخدم. الخادم يعيد الشروط غير المستوفاة عند الرفض.
                    </p>
                  </Field>
                  <Field label="تأكيد كلمة المرور">
                    <Input
                      type="password"
                      value={form.confirmPassword}
                      onChange={(e) => set('confirmPassword', e.target.value)}
                      placeholder="أعد كتابة كلمة المرور"
                      autoComplete="new-password"
                      required
                    />
                  </Field>
                </div>
              )}

              {/* ------------------------- Step 3: branch ------------------------- */}
              {stepIndex === 2 && (
                <div className="space-y-5">
                  <Field label="اسم الفرع الرئيسي">
                    <Input
                      value={form.branchName}
                      onChange={(e) => set('branchName', e.target.value)}
                      placeholder="المركز الرئيسي"
                      autoComplete="organization"
                      required
                    />
                  </Field>
                  <Field label="العنوان">
                    <Input
                      value={form.branchLocation}
                      onChange={(e) => set('branchLocation', e.target.value)}
                      placeholder="الشارع، الحي، الرمز البريدي"
                      autoComplete="street-address"
                    />
                  </Field>
                  <div className="grid sm:grid-cols-2 gap-4">
                    <Field label="المدينة">
                      <Input
                        value={form.branchCity}
                        onChange={(e) => set('branchCity', e.target.value)}
                        placeholder="الرياض"
                        autoComplete="address-level2"
                        required
                      />
                    </Field>
                    <Field label="هاتف الفرع (اختياري)">
                      <Input
                        value={form.branchPhone}
                        onChange={(e) => set('branchPhone', e.target.value)}
                        placeholder="+966 1x xxx xxxx"
                        dir="ltr"
                        autoComplete="tel"
                      />
                    </Field>
                  </div>
                  <p className="text-[11px] text-faint leading-relaxed">
                    العنوان والمدينة وهاتف الفرع تُرسل مع طلب الإنشاء؛ الخادم يهيّئ الفرع الافتراضي
                    بقيمه الخاصة حتى ينص العقد على غير ذلك، وتُعدَّل من فروع التنظيم بعد الدخول.
                  </p>
                </div>
              )}

              {/* ------------------------- Step 4: subscription ------------------------- */}
              {stepIndex === 3 && (
                <div className="space-y-5">
                  <Field label="الخطة">
                    <Select
                      value={form.plan}
                      onChange={(e) => set('plan', e.target.value)}
                    >
                      {PLANS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.nameAr}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="دورة الفوترة">
                    <Select
                      value={form.billingCycle}
                      onChange={(e) => set('billingCycle', e.target.value)}
                    >
                      {BILLING_CYCLES.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.nameAr}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <p className="text-[11px] text-faint leading-relaxed">
                    الخطة ودورة الفوترة تُرسلان مع طلب الإنشاء ويطبقهما الخادم بحسب العقد المتاح؛
                    المستأجر الجديد يُهيَّأ اليوم بخطة المؤسسة الافتراضية، ويُدار الاشتراك من شاشة
                    الاشتراكات بعد الدخول.
                  </p>
                </div>
              )}
              {/* ------------------------- Step 5: currency & VAT ------------------------- */}
              {stepIndex === 4 && (
                <div className="space-y-5">
                  <Field label="دولة النشاط">
                    <Select
                      value={form.country}
                      onChange={(e) => onCountryChange(e.target.value)}
                    >
                      {COUNTRIES.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.nameAr}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <div className="grid sm:grid-cols-2 gap-4">
                    <Field label="العملة الأساسية">
                      <Select
                        value={form.currency}
                        onChange={(e) => set('currency', e.target.value.toUpperCase())}
                      >
                        {CURRENCIES.map((code) => (
                          <option key={code} value={code}>
                            {code}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="نسبة ضريبة القيمة المضافة (%)">
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        inputMode="decimal"
                        value={form.vatRate}
                        onChange={(e) => set('vatRate', e.target.value)}
                        dir="ltr"
                        required
                      />
                    </Field>
                  </div>
                  <p className="text-[11px] text-faint leading-relaxed">
                    تُملأ العملة ونسبة الضريبة تلقائياً من السوق المختارة — العملة ونسبة
                    الضريبة القياسية لكل دولة حقيقيتان، وكل قيمة تبقى قابلة للتعديل.
                    تُطبَّق من إعدادات المستأجر بعد الدخول؛ الخادم هو المعتمد.
                  </p>
                </div>
              )}

              {/* ------------------------- Step 6: payment methods ------------------------- */}
              {stepIndex === 5 && (
                <div className="space-y-3">
                  <p className="text-xs text-muted">
                    طرق الدفع المفعّلة لهذا المستأجر عند البيع:
                  </p>
                  {PAYMENT_METHODS.map((m) => {
                    const enabled = form.paymentMethods.includes(m.id);
                    return (
                      <label
                        key={m.id}
                        className={`flex items-center gap-2.5 rounded-xl border px-3 py-2.5 cursor-pointer transition-colors ${
                          enabled
                            ? 'border-brand/50 bg-brand-soft/40'
                            : 'border-hairline hover:bg-subtle/60'
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-hairline text-brand focus:ring-brand"
                          checked={enabled}
                          onChange={() => togglePayment(m.id)}
                        />
                        <span className="text-sm text-ink">{m.nameAr}</span>
                        {enabled && (
                          <Check
                            className="w-4 h-4 text-brand ms-auto"
                            aria-hidden="true"
                          />
                        )}
                      </label>
                    );
                  })}
                  <p className="text-[11px] text-faint leading-relaxed">
                    التحديد يُرسل مع طلب الإنشاء؛ نقطة البيع تطبّق افتراضياتها الخاصة حتى
                    يُهيّئ المسؤول طرق الدفع للمستأجر.
                  </p>
                </div>
              )}

              {/* ------------------------- Step 7: review ------------------------- */}
              {stepIndex === 6 && (
                <div className="space-y-4">
                  <ReviewGroup
                    title="بيانات المستأجر"
                    step={0}
                    onEdit={goStep}
                    rows={[
                      ['اسم المستأجر', form.tenantName],
                      ['رمز المستأجر', form.tenantCode],
                      ['الشركة المالكة', form.ownerCompany],
                    ]}
                  />
                  <ReviewGroup
                    title="المالك"
                    step={1}
                    onEdit={goStep}
                    rows={[
                      ['الاسم', form.ownerName],
                      ['اسم المستخدم', form.username],
                      ['البريد الإلكتروني', form.email],
                      ['الهاتف', form.phone],
                      ['كلمة المرور', '••••••••'],
                    ]}
                  />
                  <ReviewGroup
                    title="الفرع الرئيسي"
                    step={2}
                    onEdit={goStep}
                    rows={[
                      ['اسم الفرع', form.branchName],
                      ['العنوان', form.branchLocation],
                      ['المدينة', form.branchCity],
                      ['هاتف الفرع', form.branchPhone],
                    ]}
                  />
                  <ReviewGroup
                    title="الاشتراك"
                    step={3}
                    onEdit={goStep}
                    rows={[
                      ['الخطة', planName],
                      ['دورة الفوترة', cycleName],
                    ]}
                  />
                  <ReviewGroup
                    title="العملة والضريبة"
                    step={4}
                    onEdit={goStep}
                    rows={[
                      ['الدولة', activeCountry.nameAr],
                      ['العملة الأساسية', form.currency],
                      ['ضريبة القيمة المضافة', `${form.vatRate}%`],
                    ]}
                  />
                  <ReviewGroup
                    title="طرق الدفع"
                    step={5}
                    onEdit={goStep}
                    rows={[['المفعّلة', paymentNames]]}
                  />
                  <div className="rounded-xl border border-hairline p-3 text-[11px] text-faint space-y-1">
                    <p>
                      بصمة الجهاز:{' '}
                      <span dir="ltr" className="font-mono">
                        {fingerprintPreview}
                      </span>{' '}
                      — تُسجَّل كجهاز بانتظار التحقق في جدول ثقة الأجهزة.
                    </p>
                    <p>
                      الإنشاء محمي ضد التكرار: إعادة الإرسال بنفس البيانات تسترجع النتيجة
                      نفسها ولا تُنشئ مستأجراً ثانياً.
                    </p>
                  </div>
                </div>
              )}

              {error && (
                <p
                  role="alert"
                  className="text-sm text-err-strong whitespace-pre-line leading-relaxed"
                >
                  {error}
                </p>
              )}

              <div className="flex items-center gap-3">
                {stepIndex > 0 && (
                  <GhostButton
                    type="button"
                    disabled={saving}
                    onClick={() => goStep(stepIndex - 1)}
                  >
                    رجوع
                  </GhostButton>
                )}
                <PrimaryButton type="submit" disabled={saving} className="flex-1">
                  {stepIndex === STEPS.length - 1 ? 'تأكيد وإنشاء المستأجر' : 'التالي'}
                </PrimaryButton>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
};