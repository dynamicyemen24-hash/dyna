/**
 * Payment Gateway Integration Service (Moyasar, Stripe, mada, Apple Pay, SARIE Bank Transfer)
 * Provides direct terminal checkout and API transaction processing for DyPOS Enterprise.
 *
 * ── Why this service no longer fabricates approvals ──────────────────────────
 * `processPayment` used to `setTimeout(1200)` and then return, unconditionally:
 *
 *     success: true, status: 'paid',
 *     transactionId: `TXN-${Date.now().toString().slice(-6)}`,
 *     approvalCode: `APPRV-${random}`
 *
 * No provider was ever contacted. A card payment therefore "succeeded" in about
 * a second, the operator saw a green approval and printed a receipt, and the
 * money was never taken. That is the most expensive kind of lie in a POS: the
 * customer leaves with goods, the ledger records a sale, and the shortfall is
 * discovered at reconciliation days later.
 *
 * So the service now **fails closed**. It reports what it can honestly know
 * (`unavailable`) rather than what it cannot, and the caller decides. Wiring a
 * real provider is a deployment task — see `DEPLOYMENT.md`.
 */

export type PaymentGatewayProvider = 'moyasar' | 'stripe' | 'sarie_bank_transfer' | 'stc_pay';

export interface PaymentProcessRequest {
  amountSAR: number;
  currency: string;
  paymentMethod: 'mada' | 'apple_pay' | 'card' | 'bank_transfer' | 'stc_pay';
  customerName?: string;
  customerPhone?: string;
  orderId: string;
}

export interface PaymentProcessResponse {
  success: boolean;
  transactionId: string;
  provider: PaymentGatewayProvider;
  amountSAR: number;
  /**
   * The outcome of an authorisation attempt.
   *
   * `unavailable` was added deliberately. Without it the only non-success value
   * was `failed`, which reads as "the card was declined" — sending the operator
   * to retry a terminal that has no provider at all. `unavailable` distinguishes
   * "the customer cannot pay this way right now" from "the card was refused".
   */
  status: 'paid' | 'pending' | 'failed' | 'unavailable';
  approvalCode?: string;
  receiptUrl?: string;
  gatewayFeeSAR?: number;
  qrCodeUrl?: string;
  errorMessage?: string;
}

/**
 * A configured provider. Returning a falsy value means "no credentials were
 * supplied", which is the honest answer for an unconfigured deployment.
 */
function configuredProvider(): PaymentGatewayProvider | null {
  const raw = import.meta.env.VITE_PAYMENT_GATEWAY;
  if (!raw) return null;
  const provider = String(raw).trim().toLowerCase();
  // Narrowed by `includes` on a literal union — an unknown string is a
  // configuration error, so it reports "unconfigured" rather than pretending.
  return PROVIDERS.find((p) => p === provider) ?? null;
}

const PROVIDERS: readonly PaymentGatewayProvider[] = [
  'moyasar', 'stripe', 'sarie_bank_transfer', 'stc_pay',
];

class PaymentGatewayService {
  private activeProvider: PaymentGatewayProvider = 'moyasar';

  public getActiveProvider(): PaymentGatewayProvider {
    return this.activeProvider;
  }

  public setActiveProvider(provider: PaymentGatewayProvider) {
    this.activeProvider = provider;
  }

  /**
   * Whether a real provider is configured.
   *
   * The UI uses this to disable card checkout instead of offering a button that
   * cannot work. Cash, bank transfer and store credit are unaffected — they
   * need no gateway.
   */
  public isConfigured(): boolean {
    return configuredProvider() !== null;
  }

  /**
   * Process a card/mada/Apple Pay transaction.
   *
   * FAILS CLOSED. With no provider configured this resolves to
   * `status: 'unavailable'`, and the caller must not record the sale as paid.
   * It never invents a transaction id or an approval code: a fabricated
   * `APPRV-…` is indistinguishable from a real one at the point of sale, which
   * is precisely why it must not exist.
   */
  public async processPayment(req: PaymentProcessRequest): Promise<PaymentProcessResponse> {
    const provider = configuredProvider();

    if (!provider) {
      return {
        success: false,
        // No id, no approval code: there was no transaction to identify.
        transactionId: '',
        provider: this.activeProvider,
        amountSAR: req.amountSAR,
        status: 'unavailable',
        errorMessage:
          'لم تُهيَّأ بوابة دفع على هذا الخادم. استخدم النقد أو التحويل البنكي، أو '
          + 'اضبط VITE_PAYMENT_GATEWAY مع بيانات المزوّد.',
      };
    }

    /*
     * A real provider call belongs here — server-side, so the secret key never
     * reaches the browser bundle, and so the response is signed evidence rather
     * than something the client asserts about itself.
     *
     * It is NOT stubbed with a plausible-looking response, because a stub in
     * this position is indistinguishable from a real charge at the till.
     */
    throw new Error(
      `بوابة الدفع (${provider}) لم تُدمج بعد — التزم بمزوّد معتمد قبل تفعيلها.`,
    );
  }

  /**
   * SARIE bank-transfer QR for a settlement account the SERVER supplied.
   *
   * ══ WHY THE IBAN IS A REQUIRED ARGUMENT ═══════════════════════════════════
   * This used to be:
   *
   *   generateSarieIbanQr(amountSAR, iban = 'SA0380000000608010167519')
   *
   * A default argument carrying a real bank account is the worst shape this could
   * take. The signature read as if the IBAN were supplied by the caller, so every
   * call site looked correct, and any call site that omitted it silently produced
   * a QR instructing the customer to pay a specific organisation's account. The
   * defect was invisible to review *because* the parameter existed.
   *
   * It is now required and typed `string | null`. There is no default to fall
   * back to, so "which account" can only ever be answered by the caller — which
   * reads it from `/api/db/settlement/accounts`, scoped to the signed-in tenant.
   *
   * Returns `null` when no account is configured. The till then does not offer
   * bank transfer at all, which is the correct behaviour for a merchant who has
   * not configured one: showing a QR to an unknown destination is worse than
   * showing nothing.
   */
  public generateSarieIbanQr(amountSAR: number, iban: string | null): string | null {
    if (!iban) return null;
    const normalised = iban.replace(/\s+/g, '').toUpperCase();
    if (!normalised) return null;
    return `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=SA-PAY-IBAN:${normalised};AMT:${amountSAR}`;
  }
}

export const paymentGatewayService = new PaymentGatewayService();
