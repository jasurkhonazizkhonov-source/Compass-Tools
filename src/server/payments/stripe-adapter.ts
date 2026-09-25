// Stripe implementation of the payment-provider boundary (see provider.ts).
//
// Talks to Stripe's REST API over fetch (no SDK dependency). What flows where:
//   - Browser -> Stripe (Elements iframes): card number, expiry, CVC. Never us.
//   - Us -> Stripe: customer / SetupIntent creation, SetupIntent retrieval,
//     off-session PaymentIntent (charge), refund, detach — ids and amounts only.
//   - Stripe -> us: ids, brand/last4/expiry, statuses; signed webhooks.
// Nothing in this file can carry a card number or security code: no function
// takes one and no response field that holds one is read.
//
// Secrets (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET) are read from the
// environment and are never logged, returned, or included in an error.
import { createHmac, timingSafeEqual } from "crypto";
import {
  PaymentProviderError,
  type PaymentProviderAdapter,
  type ChargeInput,
  type ChargeResult,
  type PaymentFailureCategory,
  type ProviderAccessCheck,
  type ProviderEvent,
  type RefundResult,
  type RetrievedSetup,
  type SetupSession,
} from "@/server/payments/types";

const API_BASE = "https://api.stripe.com/v1";
// Pinned so a Stripe-side default change can never silently alter response shapes.
const API_VERSION = "2024-06-20";
const REQUEST_TIMEOUT_MS = 12_000;
/** Stripe's documented default tolerance for webhook timestamps. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

type Env = Record<string, string | undefined>;
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

const SECRET_KEY_RE = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/;
const PUBLISHABLE_KEY_RE = /^pk_(test|live)_[A-Za-z0-9]{10,}$/;
const WEBHOOK_SECRET_RE = /^whsec_[A-Za-z0-9+/=_-]{10,}$/;

export type StripeConfigEvaluation = { missing: string[]; invalid: string[]; mode: "test" | "live" | null; webhookConfigured: boolean };

/** Presence/format of the three credentials — names only in the result, never a value. */
export function evaluateStripeConfig(env: Env): StripeConfigEvaluation {
  const missing: string[] = [];
  const invalid: string[] = [];
  const secret = env.STRIPE_SECRET_KEY?.trim();
  const publishable = env.STRIPE_PUBLISHABLE_KEY?.trim();
  const webhook = env.STRIPE_WEBHOOK_SECRET?.trim();

  if (!secret) missing.push("STRIPE_SECRET_KEY");
  else if (!SECRET_KEY_RE.test(secret)) invalid.push("STRIPE_SECRET_KEY");
  if (!publishable) missing.push("STRIPE_PUBLISHABLE_KEY");
  else if (!PUBLISHABLE_KEY_RE.test(publishable)) invalid.push("STRIPE_PUBLISHABLE_KEY");
  if (webhook && !WEBHOOK_SECRET_RE.test(webhook)) invalid.push("STRIPE_WEBHOOK_SECRET");

  let mode: "test" | "live" | null = null;
  if (secret && publishable && SECRET_KEY_RE.test(secret) && PUBLISHABLE_KEY_RE.test(publishable)) {
    const secretMode = secret.includes("_live_") ? "live" : "test";
    const publishableMode = publishable.includes("_live_") ? "live" : "test";
    // A test secret paired with a live publishable key (or the reverse) would
    // fail at the first card entry; flag it as a configuration error up front.
    if (secretMode !== publishableMode) invalid.push("STRIPE_PUBLISHABLE_KEY (mode differs from STRIPE_SECRET_KEY)");
    else mode = secretMode;
  }
  return { missing, invalid, mode, webhookConfigured: !!webhook && WEBHOOK_SECRET_RE.test(webhook) };
}

/** Flattens a nested object into Stripe's form encoding (`a[b]=c`, `a[]=x`). */
export function encodeForm(params: Record<string, unknown>): string {
  const pairs: string[] = [];
  const add = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v) => add(`${key}[]`, v));
    else if (typeof value === "object") for (const [k, v] of Object.entries(value as Record<string, unknown>)) add(`${key}[${k}]`, v);
    else pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return pairs.join("&");
}

const SAFE_CODE_RE = /^[a-z0-9_]{1,60}$/;
function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_CODE_RE.test(value) ? value : undefined;
}

type StripeErrorBody = { error?: { type?: string; code?: string; decline_code?: string; payment_intent?: { id?: string; status?: string } } };

function categorize(httpStatus: number, body: StripeErrorBody | null): { category: PaymentFailureCategory; code?: string; paymentIntentId?: string } {
  const err = body?.error;
  const code = safeCode(err?.decline_code) ?? safeCode(err?.code);
  const paymentIntentId = typeof err?.payment_intent?.id === "string" ? err.payment_intent.id : undefined;
  if (err?.code === "authentication_required" || err?.payment_intent?.status === "requires_action") return { category: "authentication_required", code, paymentIntentId };
  if (err?.type === "card_error") return { category: "declined", code, paymentIntentId };
  if (httpStatus === 429 || httpStatus >= 500) return { category: "provider_unavailable", code, paymentIntentId };
  if (httpStatus === 401 || httpStatus === 403) return { category: "invalid_request", code: code ?? "invalid_credentials", paymentIntentId };
  if (httpStatus >= 400) return { category: "invalid_request", code, paymentIntentId };
  return { category: "unknown", code, paymentIntentId };
}

class StripeHttp {
  constructor(
    private readonly secretKey: string,
    private readonly doFetch: FetchLike
  ) {}

  /**
   * One Stripe call. Returns the parsed body on 2xx. On a 4xx/5xx throws a
   * PaymentProviderError carrying only a safe category/code (plus, for
   * charge-shaped failures, the PaymentIntent id). A network failure/timeout
   * throws with `outcomeUnknown` semantics via category provider_unavailable
   * and httpStatus undefined.
   */
  async request<T>(method: "GET" | "POST", path: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.secretKey}`, "Stripe-Version": API_VERSION };
    let url = `${API_BASE}${path}`;
    let body: string | undefined;
    if (method === "GET") {
      const qs = params ? encodeForm(params) : "";
      if (qs) url += `?${qs}`;
    } else {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = params ? encodeForm(params) : "";
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    }

    let res: { status: number; text(): Promise<string> };
    try {
      res = await this.doFetch(url, { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new PaymentProviderError("provider_unavailable", "network_error");
    }
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.status >= 200 && res.status < 300) return json as T;
    const { category, code, paymentIntentId } = categorize(res.status, json as StripeErrorBody | null);
    const error = new PaymentProviderError(category, code, res.status);
    (error as PaymentProviderError & { paymentIntentId?: string }).paymentIntentId = paymentIntentId;
    throw error;
  }
}

type StripeSetupIntent = {
  id: string;
  status: RetrievedSetup["status"];
  customer?: string | { id: string } | null;
  client_secret?: string;
  metadata?: Record<string, string>;
  payment_method?: string | { id: string; card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number; funding?: string }; billing_details?: { name?: string | null } } | null;
};

type StripePaymentIntent = { id: string; status: string };

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

export function createStripeAdapter(env: Env, doFetch: FetchLike = fetch as unknown as FetchLike): PaymentProviderAdapter {
  const cfg = evaluateStripeConfig(env);
  const secretKey = env.STRIPE_SECRET_KEY?.trim() ?? "";
  const publishable = env.STRIPE_PUBLISHABLE_KEY?.trim() ?? "";
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
  const http = new StripeHttp(secretKey, doFetch);

  return {
    id: "stripe",
    mode: () => cfg.mode ?? "test",
    publishableKey: () => publishable,

    async ensureCustomer({ existingCustomerId, contactId, name, email, idempotencyKey }) {
      if (existingCustomerId) {
        try {
          const existing = await http.request<{ id: string; deleted?: boolean }>("GET", `/customers/${encodeURIComponent(existingCustomerId)}`);
          if (!existing.deleted) return { customerId: existing.id };
        } catch (err) {
          // A customer id from the other mode (test vs live) or a deleted one:
          // fall through and create a fresh customer. Anything else is real.
          if (!(err instanceof PaymentProviderError) || err.httpStatus !== 404) throw err;
        }
      }
      const created = await http.request<{ id: string }>(
        "POST",
        "/customers",
        { name: name.slice(0, 200), email: email ?? undefined, metadata: { contactId } },
        idempotencyKey
      );
      return { customerId: created.id };
    },

    async createSetupSession({ customerId, metadata, idempotencyKey }): Promise<SetupSession> {
      const si = await http.request<StripeSetupIntent>(
        "POST",
        "/setup_intents",
        { customer: customerId, usage: "off_session", payment_method_types: ["card"], metadata },
        idempotencyKey
      );
      if (!si.client_secret) throw new PaymentProviderError("unknown", "missing_client_secret");
      return { setupIntentId: si.id, clientSecret: si.client_secret, customerId };
    },

    async retrieveSetup(setupIntentId): Promise<RetrievedSetup> {
      const si = await http.request<StripeSetupIntent>("GET", `/setup_intents/${encodeURIComponent(setupIntentId)}`, { expand: ["payment_method"] });
      const pm = typeof si.payment_method === "object" && si.payment_method ? si.payment_method : null;
      const card = pm?.card;
      return {
        setupIntentId: si.id,
        status: si.status,
        customerId: idOf(si.customer),
        paymentMethodId: idOf(si.payment_method),
        metadata: si.metadata ?? {},
        card:
          card && card.last4 && card.exp_month && card.exp_year
            ? { brand: card.brand ?? null, last4: card.last4, expMonth: card.exp_month, expYear: card.exp_year, funding: card.funding ?? null, cardholderName: pm?.billing_details?.name ?? null }
            : null,
      };
    },

    async charge(input: ChargeInput): Promise<ChargeResult> {
      try {
        const pi = await http.request<StripePaymentIntent>(
          "POST",
          "/payment_intents",
          {
            amount: input.amountMinor,
            currency: input.currency.toLowerCase(),
            customer: input.customerId,
            payment_method: input.paymentMethodId,
            payment_method_types: ["card"],
            off_session: true,
            confirm: true,
            description: input.description.slice(0, 500),
            metadata: input.metadata,
          },
          input.idempotencyKey
        );
        if (pi.status === "succeeded") return { ok: true, paymentIntentId: pi.id, status: "succeeded" };
        if (pi.status === "processing") return { ok: true, paymentIntentId: pi.id, status: "processing" };
        // requires_action / requires_payment_method / canceled: an off-session
        // charge cannot complete customer authentication, so it did not happen.
        return { ok: false, failureCategory: pi.status === "requires_action" ? "authentication_required" : "declined", failureCode: pi.status, paymentIntentId: pi.id };
      } catch (err) {
        if (!(err instanceof PaymentProviderError)) throw err;
        const paymentIntentId = (err as PaymentProviderError & { paymentIntentId?: string }).paymentIntentId;
        const unknown = err.category === "provider_unavailable";
        return { ok: false, failureCategory: err.category, failureCode: err.code, paymentIntentId, ...(unknown ? { outcomeUnknown: true as const } : {}) };
      }
    },

    async refund({ paymentIntentId, amountMinor, idempotencyKey }): Promise<RefundResult> {
      try {
        const r = await http.request<{ id: string; status: string }>("POST", "/refunds", { payment_intent: paymentIntentId, amount: amountMinor }, idempotencyKey);
        return { ok: true, refundId: r.id, status: r.status };
      } catch (err) {
        if (!(err instanceof PaymentProviderError)) throw err;
        return { ok: false, failureCategory: err.category, failureCode: err.code, ...(err.category === "provider_unavailable" ? { outcomeUnknown: true as const } : {}) };
      }
    },

    async detachPaymentMethod(paymentMethodId) {
      try {
        await http.request("POST", `/payment_methods/${encodeURIComponent(paymentMethodId)}/detach`, {});
      } catch (err) {
        // Already detached / unknown at the provider: the goal state is reached.
        if (err instanceof PaymentProviderError && (err.httpStatus === 404 || err.code === "resource_missing")) return;
        throw err;
      }
    },

    verifyWebhook(rawBody, signatureHeader, nowMs = Date.now()) {
      return verifyStripeWebhook(rawBody, signatureHeader, webhookSecret, nowMs);
    },

    async checkAccess(): Promise<ProviderAccessCheck> {
      try {
        const account = await http.request<{ charges_enabled?: boolean }>("GET", "/account");
        return { ok: true, chargesEnabled: account.charges_enabled === true };
      } catch (err) {
        if (err instanceof PaymentProviderError) {
          if (err.httpStatus === 401 || err.httpStatus === 403) return { ok: false, reason: "invalid_credentials" };
          if (err.category === "provider_unavailable") return { ok: false, reason: "unreachable" };
        }
        return { ok: false, reason: "error" };
      }
    },
  };
}

/** Raised for every webhook rejection. The message never includes the payload or signature. */
export class WebhookVerificationError extends Error {
  constructor(public readonly reason: "missing_secret" | "missing_signature" | "malformed_signature" | "stale_timestamp" | "signature_mismatch" | "invalid_payload") {
    super(`Webhook rejected (${reason})`);
    this.name = "WebhookVerificationError";
  }
}

/**
 * Verifies Stripe's `Stripe-Signature` header (`t=<unix>,v1=<hex>[,v1=<hex>]`)
 * over the RAW request body: HMAC-SHA256 of `${t}.${body}` with the endpoint
 * secret, compared in constant time, with a replay window on `t`.
 */
export function verifyStripeWebhook(rawBody: string, signatureHeader: string | null, secret: string, nowMs: number = Date.now()): ProviderEvent {
  if (!secret) throw new WebhookVerificationError("missing_secret");
  if (!signatureHeader) throw new WebhookVerificationError("missing_signature");

  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const [k, v] = part.trim().split("=");
    if (k === "t" && v) timestamp = v;
    else if (k === "v1" && v) signatures.push(v);
  }
  const t = Number(timestamp);
  if (!timestamp || !Number.isFinite(t) || signatures.length === 0) throw new WebhookVerificationError("malformed_signature");
  if (Math.abs(nowMs / 1000 - t) > WEBHOOK_TOLERANCE_SECONDS) throw new WebhookVerificationError("stale_timestamp");

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  const matches = signatures.some((sig) => {
    if (!/^[0-9a-f]+$/i.test(sig) || sig.length !== expected.length * 2) return false;
    return timingSafeEqual(Buffer.from(sig, "hex"), expected);
  });
  if (!matches) throw new WebhookVerificationError("signature_mismatch");

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    throw new WebhookVerificationError("invalid_payload");
  }
  const e = event as Partial<ProviderEvent>;
  if (typeof e.id !== "string" || typeof e.type !== "string" || typeof e.data?.object !== "object" || e.data.object === null) throw new WebhookVerificationError("invalid_payload");
  return { id: e.id, type: e.type, created: typeof e.created === "number" ? e.created : undefined, data: { object: e.data.object as Record<string, unknown> } };
}
