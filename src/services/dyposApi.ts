/**
 * Thin fetch wrapper around the DyPOS API.
 * Every screen goes through here so tenant scoping, error shapes and
 * offline handling stay consistent.
 */

/**
 * Base URL of the DyPOS API.
 * Empty (the default) keeps every call on the same origin, which is what the
 * Cloudflare Worker deployment wants: one host serves both the SPA and /api/*.
 */
export const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');

/*
 * The tenant this browser signs in to.
 *
 * It used to be a compile-time constant, which is what made the product
 * single-tenant: a second customer could not be given a deployment without a
 * rebuild, and the SPA always claimed `royal-global-hq` whatever the server
 * said.
 *
 * The precedence is deliberate:
 *
 *   1. `VITE_TENANT_ID` — a per-deployment build, so a customer with their own
 *      hostname never sees a tenant field at all.
 *   2. the tenant stored at login — chosen by the operator, remembered so a
 *      refresh does not silently switch organisations.
 *   3. the default — only so an unauthenticated app still boots.
 *
 * Once a session exists, the token is authoritative and this value is only
 * what the client *believes*; the server re-derives the truth from the signed
 * token, so a tampered localStorage entry cannot widen the scope.
 */
const DEFAULT_TENANT_ID = 'royal-global-hq';
const TENANT_STORAGE_KEY = 'dypos_tenant';

/** True when the build pins one tenant, which hides the field on the login screen. */
export const TENANT_IS_PINNED = Boolean(import.meta.env.VITE_TENANT_ID);

/**
 * Read at CALL time, not at module load.
 *
 * This was a `const`, evaluated once when the module first loaded — before the
 * operator had chosen a tenant. That made it structurally impossible for the
 * value to follow a login, and it is why the login form has to write the tenant
 * and then reload rather than simply continuing.
 */
export function tenantId(): string {
  return (import.meta.env.VITE_TENANT_ID as string | undefined)
    || localStorage.getItem(TENANT_STORAGE_KEY)
    || DEFAULT_TENANT_ID;
}

/**
 * The tenant as a plain value, for the rare caller that needs a constant.
 * Prefer `tenantId()`; this reads the value once at import time.
 */
export const TENANT_ID: string = tenantId();

/** Records the tenant an operator signed in to, for subsequent requests. */
export function rememberTenant(id: string): void {
  try {
    localStorage.setItem(TENANT_STORAGE_KEY, id);
  } catch {
    // A browser with storage disabled still works: the token carries the tenant,
    // so this is a convenience rather than a dependency.
  }
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(
  path: string,
  init?: RequestInit,
  opts?: { actor?: string },
): Promise<T> {
  let res: Response;

  // Identity travels as the signed session token issued by /api/auth/login.
  // The old `x-dypos-user` header was a name the client chose, so it could be
  // edited to impersonate another operator; the server now rejects it outright.
  const token = opts?.actor ?? sessionStorage.getItem('dypos_token') ?? '';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    /*
     * Read through `tenantId()` on every call. It used to read a module-level
     * constant, captured before login, so after an operator chose a different
     * tenant every subsequent call would still have claimed the old one.
     *
     * Note the server no longer trusts this header — it resolves the tenant from
     * the signed token and treats the header only as a claim to check. Sending
     * it keeps the request honest and lets the server answer 403 instead of
     * quietly serving a different scope than the operator selected.
     */
    'x-tenant-id': tenantId(),
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError('تعذّر الاتصال بالخادم — تحقق من الشبكة', 0);
  }

  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }

  if (!res.ok) {
    /*
     * ══ THE CLIENT ALSO REFUSES TO ECHO THE SERVER ══════════════════════
     * This threw `json.error` verbatim.
     *
     * The server is now the place that decides what is safe to show, but a
     * client-side echo is still the wrong default for two reasons: a reverse
     * proxy or gateway can put its own error text in that field without any of
     * our rules applying, and any future route that forgets the rule would
     * silently re-open the leak.
     *
     * So the rule holds on both sides of the wire:
     *
     *   · 4xx — a business refusal. Those messages are authored for the operator
     *     ("الكمية غير متوفرة", "بيانات الدخول غير صحيحة") and they tell them
     *     what to do next, so they are shown.
     *   · 5xx — something broke. Any text there is a liability, whatever it says,
     *     so a generic line is shown and the server's reference is carried for
     *     support. An HTTP status number is not sensitive; it tells the operator
     *     whether to retry.
     */
    if (res.status >= 500) {
      const ref = typeof json?.reference === 'string' ? json.reference : '';
      throw new ApiError(
        ref
          ? `تعذّر إتمام العملية. الرجاء المحاولة مرة أخرى. (رقم مرجعي: ${ref})`
          : 'تعذّر إتمام العملية. الرجاء المحاولة مرة أخرى.',
        res.status,
      );
    }
    const businessMessage = typeof json?.error === 'string' && json.error.trim()
      ? json.error
      : `تعذّر تنفيذ الطلب (${res.status})`;
    throw new ApiError(businessMessage, res.status);
  }
  return json as T;
}

export const apiGet = <T>(path: string, opts?: { actor?: string }) =>
  request<T>(path, undefined, opts);
export const apiPost = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const apiPut = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
export const apiPatch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const apiDelete = <T>(path: string) =>
  request<T>(path, { method: 'DELETE' });

// ---------------------------------------------------------------------
// Response shapes shared by the seven screens
// ---------------------------------------------------------------------
export interface ListResponse<T> {
  items: T[];
  count: number;
}

export const q = (params: Record<string, string | number | undefined>) => {
  const usp = new URLSearchParams({ tenantId: tenantId() });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') usp.set(k, String(v));
  }
  return usp.toString();
};

/** Formats a number as SAR currency for display. */
export const sar = (n: number | string | null | undefined) =>
  `${Number(n ?? 0).toFixed(2)} ر.س`;

/** Formats an ISO timestamp using the Arabic locale. */
export const fmtDateTime = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ar-SA', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
};

export const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ar-SA', { dateStyle: 'medium' });
};