// The integration BOUNDARY for a PCI-compliant payment provider.
//
// Compass Tools is deliberately NOT a payment-card database. In production a
// customer's card must be captured by a PCI-compliant provider (hosted fields
// / redirect / tokenization), so the raw card number and security code never
// touch this application's servers, logs, database or e-mail. The CRM then
// keeps only NON-SENSITIVE metadata:
//   processor, customer / payment-method token ids, transaction / authorization
//   ids, brand, last4, expiry, cardholder name, result, amount, currency,
//   status, timestamps, failure category.
// The card security code (CVV/CVC/CID) and PIN are never collected or stored
// by Compass Tools under any circumstance.
//
// STATUS: no provider adapter is installed. This module defines the contract
// an adapter must satisfy and reports honestly whether one is ready; it does
// not pretend one is configured and it does not add a provider on the
// owner's behalf (choosing one is a business/contract decision — see
// docs/PAYMENT_ARCHITECTURE.md for the selection criteria and the exact
// integration steps).
//
// Plain server module (not a "use server" file): nothing here is callable
// from a browser.

/** Non-sensitive description of a tokenized card. Safe to store and display. */
export type TokenizedPaymentMethod = {
  /** Which adapter produced the token (e.g. the provider's id). */
  provider: string;
  /** The provider's opaque token for this payment method — NOT a card number. */
  paymentMethodToken: string;
  /** The provider's customer id, when the provider groups methods per customer. */
  customerToken?: string;
  brand: string | null;
  last4: string;
  expiryMonth: number;
  expiryYear: number;
  cardholderName?: string;
};

export type PaymentFailureCategory = "declined" | "authentication_required" | "invalid_request" | "provider_unavailable" | "unknown";

export type PaymentAttemptResult =
  | { ok: true; transactionId: string; authorizationId?: string; amount: number; currency: string }
  | { ok: false; failureCategory: PaymentFailureCategory; transactionId?: string };

/**
 * What a provider adapter must implement. Every method takes and returns only
 * tokens and non-sensitive metadata — an adapter that needs a raw card number
 * or security code in one of these signatures is the wrong shape (the
 * provider's hosted fields must collect those directly from the customer).
 */
export interface PaymentProviderAdapter {
  /** Stable id, matched against PAYMENT_PROVIDER. */
  readonly id: string;
  /** Names (never values) of the environment variables the adapter needs, e.g. its secret key. */
  readonly requiredEnv: readonly string[];
  /** Sandbox/test mode vs live, from configuration. Live charges must never happen in tests. */
  mode(): "sandbox" | "live";
  /** Starts a provider-hosted card capture for one booking; returns only what the browser needs to render the provider's own fields. */
  createClientSession(input: { bookingReference: string; currency: string }): Promise<{ sessionId: string; clientToken: string }>;
  /** Server-side confirmation that the customer completed capture; returns the token + display metadata. */
  confirmTokenizedMethod(input: { sessionId: string }): Promise<TokenizedPaymentMethod>;
  /** Authorizes/charges a stored token. `idempotencyKey` makes a retried call safe. */
  charge(input: { paymentMethodToken: string; amount: number; currency: string; idempotencyKey: string }): Promise<PaymentAttemptResult>;
}

/** Registered adapters. Empty on purpose: see the header. A real integration adds its adapter here. */
const ADAPTERS: Readonly<Record<string, PaymentProviderAdapter>> = {};

export type PaymentProviderStatus =
  | { state: "ready"; provider: string; adapterAvailable: true; mode: "sandbox" | "live"; missing: [] }
  | { state: "not_configured"; provider: string | null; adapterAvailable: boolean; mode: null; missing: string[] };

/**
 * Whether a payment provider is genuinely usable: a provider is named in
 * PAYMENT_PROVIDER, its adapter exists in this codebase, and every env var it
 * requires is set. Reports Configured/Missing style facts only — never a value.
 */
export function getPaymentProviderStatus(env: Record<string, string | undefined> = process.env): PaymentProviderStatus {
  const requested = env.PAYMENT_PROVIDER?.trim().toLowerCase();
  if (!requested || requested === "none") {
    return { state: "not_configured", provider: null, adapterAvailable: false, mode: null, missing: ["PAYMENT_PROVIDER"] };
  }
  const adapter = ADAPTERS[requested];
  if (!adapter) {
    return { state: "not_configured", provider: requested, adapterAvailable: false, mode: null, missing: [`an adapter for "${requested}" in src/server/payments/provider.ts`] };
  }
  const missing = adapter.requiredEnv.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    return { state: "not_configured", provider: adapter.id, adapterAvailable: true, mode: null, missing: [...missing] };
  }
  return { state: "ready", provider: adapter.id, adapterAvailable: true, mode: adapter.mode(), missing: [] };
}

/** The active adapter, or null when none is ready. */
export function getPaymentProvider(env: Record<string, string | undefined> = process.env): PaymentProviderAdapter | null {
  const status = getPaymentProviderStatus(env);
  return status.state === "ready" ? ADAPTERS[status.provider] : null;
}
