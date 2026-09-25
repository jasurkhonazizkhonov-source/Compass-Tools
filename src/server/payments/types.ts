// Provider-neutral types for the payment boundary (see provider.ts). Every
// value here is a token, an id, or non-sensitive display metadata — there is no
// field anywhere in this contract that can carry a card number, a card security
// code (CVV/CVC) or a PIN, and a test enforces that.

export type PaymentFailureCategory = "declined" | "authentication_required" | "invalid_request" | "provider_unavailable" | "unknown";

/** Display metadata about a vaulted card. Safe to store and show. */
export type CardSummary = {
  brand: string | null;
  last4: string;
  expMonth: number;
  expYear: number;
  funding: string | null;
  cardholderName: string | null;
};

export type SetupSession = { setupIntentId: string; clientSecret: string; customerId: string };

export type RetrievedSetup = {
  setupIntentId: string;
  status: "succeeded" | "requires_action" | "requires_payment_method" | "requires_confirmation" | "processing" | "canceled";
  customerId: string | null;
  paymentMethodId: string | null;
  metadata: Record<string, string>;
  card: CardSummary | null;
};

export type ChargeInput = {
  customerId: string;
  paymentMethodId: string;
  /** Integer minor units (cents). */
  amountMinor: number;
  /** ISO currency code, any case. */
  currency: string;
  /** Provider-side idempotency key: replaying it returns the SAME result, never a second charge. */
  idempotencyKey: string;
  description: string;
  metadata: Record<string, string>;
};

export type ChargeResult =
  | { ok: true; paymentIntentId: string; status: "succeeded" | "processing" }
  | {
      ok: false;
      failureCategory: PaymentFailureCategory;
      /** Short fixed-vocabulary provider code (e.g. card_declined) — never free text. */
      failureCode?: string;
      paymentIntentId?: string;
      /** True when the request may or may not have reached the provider (timeout, dropped connection, 5xx). The caller must NOT assume the charge did not happen; replay with the same idempotency key to learn the outcome. */
      outcomeUnknown?: true;
    };

export type RefundResult = { ok: true; refundId: string; status: string } | { ok: false; failureCategory: PaymentFailureCategory; failureCode?: string; outcomeUnknown?: true };

export type ProviderEvent = { id: string; type: string; created?: number; data: { object: Record<string, unknown> } };

export type ProviderAccessCheck =
  | { ok: true; chargesEnabled: boolean }
  | { ok: false; reason: "invalid_credentials" | "unreachable" | "error" };

/** A provider failure that is not a card decline: bad request, auth, network, 5xx. Carries only a safe category. */
export class PaymentProviderError extends Error {
  constructor(
    public readonly category: PaymentFailureCategory,
    public readonly code?: string,
    public readonly httpStatus?: number
  ) {
    // Deliberately generic: provider error text can echo request fields.
    super(`Payment provider error (${category}${code ? `/${code}` : ""})`);
    this.name = "PaymentProviderError";
  }
}

/**
 * What a provider adapter must implement. Every method takes and returns only
 * tokens and non-sensitive metadata. An adapter that needs a raw card number or
 * security code in one of these signatures is the wrong shape: the provider's
 * hosted fields collect those directly from the customer.
 */
export interface PaymentProviderAdapter {
  readonly id: string;
  mode(): "test" | "live";
  /** The public (publishable) key a browser needs to render the provider's hosted fields. */
  publishableKey(): string;
  /** Finds or creates the provider's customer for a contact. */
  ensureCustomer(input: { existingCustomerId?: string | null; contactId: string; name: string; email?: string | null; idempotencyKey: string }): Promise<{ customerId: string }>;
  /** Starts a hosted card capture that vaults a reusable payment method for later off-session charges. */
  createSetupSession(input: { customerId: string; metadata: Record<string, string>; idempotencyKey: string }): Promise<SetupSession>;
  /** Server-side, authoritative read of a completed capture. Never trust a browser's claim of success. */
  retrieveSetup(setupIntentId: string): Promise<RetrievedSetup>;
  /** Charges a vaulted payment method (off-session). */
  charge(input: ChargeInput): Promise<ChargeResult>;
  refund(input: { paymentIntentId: string; amountMinor?: number; idempotencyKey: string }): Promise<RefundResult>;
  detachPaymentMethod(paymentMethodId: string): Promise<void>;
  /** Verifies the provider's signature over the RAW request body; throws on any mismatch/replay. */
  verifyWebhook(rawBody: string, signatureHeader: string | null, nowMs?: number): ProviderEvent;
  /** Reads the provider account to confirm the credentials work and charging is enabled. No card data involved. */
  checkAccess(): Promise<ProviderAccessCheck>;
}
