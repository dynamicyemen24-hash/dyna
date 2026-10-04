/**
 * Tenant identity — the ONE place a screen may learn who the business is.
 *
 * ══ WHY THIS FILE EXISTS ══════════════════════════════════════════════════
 * The receipt printed this, hard-coded, in three places:
 *
 *   <h2>شركة رويال العالمية - DyPOS</h2>
 *   <p>فرع الرياض الرئيسي - المملكة العربية السعودية</p>
 *   <p>الرقم الضريبي: 300123456700003</p>
 *
 * plus the same company name in `POSView` (twice), `SettingsView`,
 * `InventoryView`, `AuditLogView`, `LoginView` and `pdfGenerator`. That is not
 * seven copies of a label — it is a fixed legal identity on a fiscal document.
 *
 * A tax number on a VAT invoice is a legal assertion to a tax authority. If it
 * is compiled into the bundle, then this deployment cannot be sold to a second
 * customer: it would issue that customer's receipts under *this* company's tax
 * number, and no amount of code review at the point of sale would reveal it,
 * because every value is internally consistent and looks deliberate.
 *
 * The same class of bug is quieter elsewhere: a branch name typed as a literal
 * in a till means the receipt claims a branch the sale did not happen in, and a
 * branch name on a receipt is what an auditor reconciles against.
 *
 * ══ THE RULE ═══════════════════════════════════════════════════════════════
 * Identity is DATA. It comes from `dypos.tenants` and `dypos.branches`, over the
 * server, and it is rendered from whatever comes back. If the server cannot be
 * asked, the identity is **unresolved** — never invented. An unresolved receipt
 * must be visibly incomplete rather than confidently wrong, because a blank tax
 * number is a fixable support ticket and a wrong one is a regulatory finding.
 */

// ── The shapes the server already returns ───────────────────────────────────
// `GET /api/erp/entitlements` returns this under `tenant`, and
// `GET /api/db/tenant/profile` under the same field names.

export interface TenantIdentity {
  /** Registered / trading name — the legal entity on the invoice. */
  readonly ownerCompany: string;
  /** Display name; falls back to `ownerCompany` when the tenant set none. */
  readonly brandName: string;
  /** Saudi VAT registration number (15 digits) or equivalent. */
  readonly taxNumber: string | null;
  readonly commercialReg: string | null;
  readonly countryCode: string | null;
  readonly baseCurrency: string | null;
}

export interface BranchIdentity {
  readonly id: string;
  readonly name: string;
  readonly city: string | null;
  readonly address: string | null;
}

/**
 * What the UI is allowed to print, and how sure it is.
 *
 * `source` is the honesty flag. `'server'` means every field below came from the
 * database. `'unresolved'` means at least one required field is missing, and the
 * caller MUST surface that rather than substituting a default.
 */
export interface ResolvedIdentity {
  readonly ownerCompany: string;
  readonly brandName: string;
  readonly taxNumber: string | null;
  readonly commercialReg: string | null;
  readonly countryCode: string | null;
  readonly baseCurrency: string | null;
  readonly branchName: string | null;
  readonly branchCity: string | null;
  /** 'server' only when company AND tax number were both actually provided. */
  readonly source: 'server' | 'unresolved';
  /** Human-readable list of what is missing. Empty exactly when source==='server'. */
  readonly missing: readonly string[];
}

/** Placeholder shown for a field the server did not supply. Deliberately obvious. */
export const UNRESOLVED_LABEL = '— غير محدد —';

const asText = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Builds the printable identity from whatever the server managed to return.
 *
 * `raw` is the `tenant` object from the API. `branch` is optional because the
 * receipt knows its branch separately; passing the wrong branch is worse than
 * passing none, so `undefined` is a valid, honest state.
 *
 * There is deliberately NO fallback company and NO fallback tax number. The
 * previous behaviour is the reason this function exists.
 */
export function resolveIdentity(
  raw: Partial<TenantIdentity> | null | undefined,
  branch?: Partial<BranchIdentity> | null,
): ResolvedIdentity {
  const ownerCompany = asText(raw?.ownerCompany);
  const brandName = asText(raw?.brandName) ?? ownerCompany;
  const taxNumber = asText(raw?.taxNumber);
  const commercialReg = asText(raw?.commercialReg);
  const countryCode = asText(raw?.countryCode);
  const baseCurrency = asText(raw?.baseCurrency);
  const branchName = asText(branch?.name);
  const branchCity = asText(branch?.city);

  // The two fields a fiscal document cannot be issued without.
  const missing: string[] = [];
  if (!ownerCompany) missing.push('اسم الشركة');
  if (!taxNumber) missing.push('الرقم الضريبي');
  if (!branchName) missing.push('اسم الفرع');

  return {
    ownerCompany: ownerCompany ?? UNRESOLVED_LABEL,
    brandName: brandName ?? UNRESOLVED_LABEL,
    taxNumber,
    commercialReg,
    countryCode,
    baseCurrency,
    branchName,
    branchCity,
    source: ownerCompany && taxNumber ? 'server' : 'unresolved',
    missing,
  };
}

/** "فرع الرياض الرئيسي — المملكة العربية السعودية", from real columns only. */
export function branchLine(identity: ResolvedIdentity): string {
  const parts = [identity.branchName, identity.branchCity, identity.countryCode]
    .filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(' — ') : UNRESOLVED_LABEL;
}

/** Currency for display. Never guesses a symbol from a country. */
export function currencyLabel(identity: ResolvedIdentity): string {
  return identity.baseCurrency ?? UNRESOLVED_LABEL;
}