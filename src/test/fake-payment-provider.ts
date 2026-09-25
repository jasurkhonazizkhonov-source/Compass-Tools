// In-memory stand-in for a payment provider, for tests only. It implements the
// same PaymentProviderAdapter contract as the real Stripe adapter, so booking,
// manual-charge, webhook and health code is exercised end to end without any
// network and without any real (or even fake-looking) card number: a "card" is
// just display metadata (brand/last4/expiry) — exactly what the real provider
// hands back after the customer types the number into its hosted fields.
import { createHmac, randomUUID } from "crypto";
import {
  PaymentProviderError,
  type CardSummary,
  type ChargeInput,
  type ChargeResult,
  type PaymentProviderAdapter,
  type ProviderAccessCheck,
  type RefundResult,
  type RetrievedSetup,
  type SetupSession,
} from "@/server/payments/types";
import { verifyStripeWebhook } from "@/server/payments/stripe-adapter";

export const FAKE_WEBHOOK_SECRET = "whsec_" + "fake".repeat(6);

type SetupRecord = { id: string; customerId: string; metadata: Record<string, string>; status: RetrievedSetup["status"]; paymentMethodId: string | null; card: CardSummary | null };

export class FakePaymentProvider implements PaymentProviderAdapter {
  readonly id = "stripe";
  customers = new Map<string, { contactId: string }>();
  setups = new Map<string, SetupRecord>();
  detached = new Set<string>();
  /** Every call, in order, for assertions. Never contains card data (there is none). */
  calls: Array<{ op: string; args?: unknown }> = [];
  /** Idempotent replay store, like the real provider's Idempotency-Key. */
  private idempotent = new Map<string, unknown>();
  chargeResults: ChargeResult[] = [];
  refundResults: RefundResult[] = [];
  charged: ChargeInput[] = [];
  failNextRetrieve: PaymentProviderError | null = null;
  failNextSetup: PaymentProviderError | null = null;
  access: ProviderAccessCheck = { ok: true, chargesEnabled: true };
  private testMode: "test" | "live" = "test";

  mode() {
    return this.testMode;
  }
  setMode(m: "test" | "live") {
    this.testMode = m;
  }
  publishableKey() {
    return "pk_test_" + "fake".repeat(4);
  }

  private once<T>(key: string, produce: () => T): T {
    if (this.idempotent.has(key)) return this.idempotent.get(key) as T;
    const v = produce();
    this.idempotent.set(key, v);
    return v;
  }

  async ensureCustomer(input: { existingCustomerId?: string | null; contactId: string; name: string; email?: string | null; idempotencyKey: string }) {
    this.calls.push({ op: "ensureCustomer", args: { contactId: input.contactId } });
    if (input.existingCustomerId && this.customers.has(input.existingCustomerId)) return { customerId: input.existingCustomerId };
    return this.once(`cust:${input.idempotencyKey}`, () => {
      const customerId = `cus_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
      this.customers.set(customerId, { contactId: input.contactId });
      return { customerId };
    });
  }

  async createSetupSession(input: { customerId: string; metadata: Record<string, string>; idempotencyKey: string }): Promise<SetupSession> {
    this.calls.push({ op: "createSetupSession", args: { metadata: input.metadata } });
    if (this.failNextSetup) {
      const e = this.failNextSetup;
      this.failNextSetup = null;
      throw e;
    }
    return this.once(`si:${input.idempotencyKey}`, () => {
      const id = `seti_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
      this.setups.set(id, { id, customerId: input.customerId, metadata: input.metadata, status: "requires_payment_method", paymentMethodId: null, card: null });
      return { setupIntentId: id, clientSecret: `${id}_secret_fake`, customerId: input.customerId };
    });
  }

  /** Simulates the customer completing the provider's hosted card fields. */
  completeSetup(setupIntentId: string, card: Partial<CardSummary> = {}) {
    const s = this.setups.get(setupIntentId);
    if (!s) throw new Error("unknown setup intent");
    s.status = "succeeded";
    s.paymentMethodId = `pm_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    s.card = { brand: "visa", last4: "4242", expMonth: 12, expYear: new Date().getUTCFullYear() + 3, funding: "credit", cardholderName: "Jane Traveler", ...card };
    return s.paymentMethodId;
  }

  async retrieveSetup(setupIntentId: string): Promise<RetrievedSetup> {
    this.calls.push({ op: "retrieveSetup", args: { setupIntentId } });
    if (this.failNextRetrieve) {
      const e = this.failNextRetrieve;
      this.failNextRetrieve = null;
      throw e;
    }
    const s = this.setups.get(setupIntentId);
    if (!s) throw new PaymentProviderError("invalid_request", "resource_missing", 404);
    return { setupIntentId: s.id, status: s.status, customerId: s.customerId, paymentMethodId: s.paymentMethodId, metadata: s.metadata, card: s.card };
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    this.calls.push({ op: "charge", args: { amountMinor: input.amountMinor, currency: input.currency, idempotencyKey: input.idempotencyKey } });
    const key = `ch:${input.idempotencyKey}`;
    // Replay: the provider returns the ORIGINAL definitive result for a key.
    if (this.idempotent.has(key)) return this.idempotent.get(key) as ChargeResult;
    const result: ChargeResult = this.chargeResults.shift() ?? { ok: true as const, paymentIntentId: `pi_${randomUUID().replace(/-/g, "").slice(0, 14)}`, status: "succeeded" as const };
    // An "outcome unknown" answer models a request that timed out on our side:
    // nothing is recorded, so replaying the same key later reaches the provider
    // for real (and yields its true result).
    if (!(result.ok === false && result.outcomeUnknown)) {
      this.charged.push(input);
      this.idempotent.set(key, result);
    }
    return result;
  }

  async refund(input: { paymentIntentId: string; amountMinor?: number; idempotencyKey: string }): Promise<RefundResult> {
    this.calls.push({ op: "refund", args: { paymentIntentId: input.paymentIntentId, amountMinor: input.amountMinor } });
    return this.once(`rf:${input.idempotencyKey}`, () => this.refundResults.shift() ?? { ok: true as const, refundId: `re_${randomUUID().replace(/-/g, "").slice(0, 14)}`, status: "succeeded" });
  }

  async detachPaymentMethod(paymentMethodId: string) {
    this.calls.push({ op: "detach", args: { paymentMethodId } });
    this.detached.add(paymentMethodId);
  }

  verifyWebhook(rawBody: string, signatureHeader: string | null, nowMs?: number) {
    return verifyStripeWebhook(rawBody, signatureHeader, FAKE_WEBHOOK_SECRET, nowMs);
  }

  async checkAccess(): Promise<ProviderAccessCheck> {
    this.calls.push({ op: "checkAccess" });
    return this.access;
  }
}

/** Builds a correctly signed webhook request for the fake provider's secret. */
export function signFakeWebhook(event: unknown, opts: { secret?: string; timestamp?: number } = {}): { body: string; signature: string } {
  const body = JSON.stringify(event);
  const t = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", opts.secret ?? FAKE_WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex");
  return { body, signature: `t=${t},v1=${sig}` };
}
