// The payment-provider boundary.
//
// Compass Tools is NOT a payment-card database. The customer's card is entered
// into the PROVIDER'S hosted fields (Stripe Elements — iframes served from the
// provider's domain), so the card number and the card security code (CVV/CVC)
// go straight from the customer's browser to the provider and never touch this
// application's servers, logs, database, e-mail or backups. The provider
// vaults a reusable payment method and returns an opaque reference; Compass
// Tools keeps only that reference plus display metadata (brand, last4, expiry,
// cardholder name) and later instructs the provider to charge it. A later
// manual charge therefore needs neither the card number nor a stored CVV.
//
// This module is the ONLY place that knows which provider is in use. Everything
// else (booking, manual charge, webhooks, System Health) talks to the small
// interface below, so a different provider can be added without touching them.
//
// Plain server module (not a "use server" file): nothing here is callable from
// a browser. Secrets are read from the environment at call time and are never
// returned to a client — only the publishable key is exposed, by design.
import { createStripeAdapter, evaluateStripeConfig } from "@/server/payments/stripe-adapter";
import type { PaymentProviderAdapter } from "@/server/payments/types";

export type {
  PaymentProviderAdapter,
  CardSummary,
  SetupSession,
  RetrievedSetup,
  ChargeInput,
  ChargeResult,
  RefundResult,
  ProviderEvent,
  PaymentFailureCategory,
  ProviderAccessCheck,
} from "@/server/payments/types";
export { PaymentProviderError } from "@/server/payments/types";

export type PaymentProviderStatus =
  | { state: "ready"; provider: string; mode: "test" | "live"; webhookConfigured: boolean; missing: []; invalid: [] }
  | { state: "not_configured"; provider: string | null; mode: null; webhookConfigured: boolean; missing: string[]; invalid: string[] }
  | { state: "invalid"; provider: string; mode: null; webhookConfigured: boolean; missing: string[]; invalid: string[] };

type Env = Record<string, string | undefined>;

let testOverride: PaymentProviderAdapter | null = null;

/** Test hook: install a fake adapter. Refuses to run in production. */
export function setPaymentProviderForTests(adapter: PaymentProviderAdapter | null) {
  if (process.env.NODE_ENV === "production") throw new Error("setPaymentProviderForTests is not available in production");
  testOverride = adapter;
}

/**
 * Whether a provider is genuinely usable: one is SELECTED (PAYMENT_PROVIDER),
 * its adapter exists in this codebase, and every credential it needs is present
 * and well-formed (and the publishable/secret keys agree on test-vs-live).
 * Reports names of what is missing or invalid — never a value. This is a pure
 * configuration check (no network); System Health additionally probes the
 * provider's API.
 */
export function getPaymentProviderStatus(env: Env = process.env): PaymentProviderStatus {
  if (testOverride) {
    return { state: "ready", provider: testOverride.id, mode: testOverride.mode(), webhookConfigured: true, missing: [], invalid: [] };
  }
  const requested = env.PAYMENT_PROVIDER?.trim().toLowerCase();
  if (!requested || requested === "none") {
    return { state: "not_configured", provider: null, mode: null, webhookConfigured: false, missing: ["PAYMENT_PROVIDER"], invalid: [] };
  }
  if (requested !== "stripe") {
    return { state: "not_configured", provider: requested, mode: null, webhookConfigured: false, missing: [`an adapter for "${requested}"`], invalid: [] };
  }
  const cfg = evaluateStripeConfig(env);
  if (cfg.missing.length > 0) {
    return { state: "not_configured", provider: "stripe", mode: null, webhookConfigured: cfg.webhookConfigured, missing: cfg.missing, invalid: cfg.invalid };
  }
  if (cfg.invalid.length > 0 || !cfg.mode) {
    return { state: "invalid", provider: "stripe", mode: null, webhookConfigured: cfg.webhookConfigured, missing: [], invalid: cfg.invalid };
  }
  return { state: "ready", provider: "stripe", mode: cfg.mode, webhookConfigured: cfg.webhookConfigured, missing: [], invalid: [] };
}

/** The active adapter, or null when none is ready — callers cannot obtain a half-configured one. */
export function getPaymentProvider(env: Env = process.env): PaymentProviderAdapter | null {
  if (testOverride) return testOverride;
  const status = getPaymentProviderStatus(env);
  if (status.state !== "ready") return null;
  return createStripeAdapter(env);
}

/** Whether customers can be asked for a card right now (configuration only). */
export function isPaymentReady(env: Env = process.env): boolean {
  return getPaymentProviderStatus(env).state === "ready";
}

/**
 * The only provider configuration a browser may receive: which provider, its
 * mode, and its PUBLISHABLE key (designed by the provider to be public). Never
 * a secret key or webhook secret.
 */
export function getPaymentClientConfig(env: Env = process.env): { ready: true; provider: string; mode: "test" | "live"; publishableKey: string } | { ready: false } {
  const status = getPaymentProviderStatus(env);
  if (status.state !== "ready") return { ready: false };
  const adapter = getPaymentProvider(env);
  const publishableKey = adapter?.publishableKey();
  if (!adapter || !publishableKey) return { ready: false };
  return { ready: true, provider: status.provider, mode: status.mode, publishableKey };
}
