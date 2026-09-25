import { describe, it, expect, vi } from "vitest";
import { createHmac } from "crypto";
import { createStripeAdapter, encodeForm, verifyStripeWebhook, WebhookVerificationError, WEBHOOK_TOLERANCE_SECONDS, type FetchLike } from "../stripe-adapter";
import { PaymentProviderError } from "../types";

// The Stripe adapter is exercised against a stub of fetch: what it SENDS
// (form encoding, idempotency keys, auth, version pin) and how it MAPS every
// kind of answer (success, decline, auth-required, 5xx, network failure). No
// request here contains a card number or security code — there is no field in
// the adapter that could carry one.

const ENV = { PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_" + "s".repeat(24), STRIPE_PUBLISHABLE_KEY: "pk_test_" + "p".repeat(24), STRIPE_WEBHOOK_SECRET: "whsec_" + "w".repeat(24) };

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function stub(responses: Array<{ status: number; body?: unknown } | Error>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchLike: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const next = responses[Math.min(i++, responses.length - 1)];
    if (next instanceof Error) throw next;
    return { status: next.status, text: async () => (next.body === undefined ? "" : JSON.stringify(next.body)) };
  };
  return { fetchLike, calls };
}

const adapterWith = (responses: Parameters<typeof stub>[0]) => {
  const s = stub(responses);
  return { adapter: createStripeAdapter(ENV, s.fetchLike), ...s };
};

describe("encodeForm", () => {
  it("flattens nested objects and arrays the way Stripe expects, skipping undefined/null", () => {
    expect(encodeForm({ amount: 500, metadata: { chargeId: "c1", bookingId: "b1" }, payment_method_types: ["card"], skip: undefined, nope: null })).toBe(
      "amount=500&metadata%5BchargeId%5D=c1&metadata%5BbookingId%5D=b1&payment_method_types%5B%5D=card"
    );
  });
});

describe("requests", () => {
  it("authenticates with the secret key, pins the API version, and never puts the key in the URL or body", async () => {
    const { adapter, calls } = adapterWith([{ status: 200, body: { id: "cus_1" } }]);
    await adapter.ensureCustomer({ contactId: "ct1", name: "Jane Traveler", email: "jane@example.test", idempotencyKey: "cust-ct1" });
    const c = calls[0];
    expect(c.headers.Authorization).toBe(`Bearer ${ENV.STRIPE_SECRET_KEY}`);
    expect(c.headers["Stripe-Version"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(c.url).not.toContain(ENV.STRIPE_SECRET_KEY);
    expect(c.body ?? "").not.toContain(ENV.STRIPE_SECRET_KEY);
    expect(c.headers["Idempotency-Key"]).toBe("cust-ct1");
  });

  it("createSetupSession asks for an off-session-capable card setup bound to the customer, with an idempotency key", async () => {
    const { adapter, calls } = adapterWith([{ status: 200, body: { id: "seti_1", client_secret: "seti_1_secret_x", status: "requires_payment_method" } }]);
    const s = await adapter.createSetupSession({ customerId: "cus_1", metadata: { quoteId: "q1", purpose: "booking" }, idempotencyKey: "si-q1-slot" });
    expect(s).toEqual({ setupIntentId: "seti_1", clientSecret: "seti_1_secret_x", customerId: "cus_1" });
    const body = decodeURIComponent(calls[0].body!);
    expect(calls[0].url).toBe("https://api.stripe.com/v1/setup_intents");
    expect(body).toContain("usage=off_session");
    expect(body).toContain("customer=cus_1");
    expect(body).toContain("metadata[quoteId]=q1");
    expect(calls[0].headers["Idempotency-Key"]).toBe("si-q1-slot");
  });

  it("retrieveSetup maps only display metadata (brand/last4/expiry/name) and ids", async () => {
    const { adapter, calls } = adapterWith([
      {
        status: 200,
        body: {
          id: "seti_1",
          status: "succeeded",
          customer: "cus_1",
          metadata: { quoteId: "q1" },
          payment_method: { id: "pm_1", card: { brand: "visa", last4: "4242", exp_month: 8, exp_year: 2031, funding: "credit" }, billing_details: { name: "Jane Traveler" } },
        },
      },
    ]);
    const r = await adapter.retrieveSetup("seti_1");
    expect(calls[0].method).toBe("GET");
    expect(r).toEqual({
      setupIntentId: "seti_1",
      status: "succeeded",
      customerId: "cus_1",
      paymentMethodId: "pm_1",
      metadata: { quoteId: "q1" },
      card: { brand: "visa", last4: "4242", expMonth: 8, expYear: 2031, funding: "credit", cardholderName: "Jane Traveler" },
    });
  });

  it("charge sends an off-session, confirmed PaymentIntent in minor units, lower-case currency, with the idempotency key", async () => {
    const { adapter, calls } = adapterWith([{ status: 200, body: { id: "pi_1", status: "succeeded" } }]);
    const r = await adapter.charge({ customerId: "cus_1", paymentMethodId: "pm_1", amountMinor: 250000, currency: "AUD", idempotencyKey: "mc-charge1", description: "Booking BFT-1", metadata: { chargeId: "c1" } });
    expect(r).toEqual({ ok: true, paymentIntentId: "pi_1", status: "succeeded" });
    const body = decodeURIComponent(calls[0].body!);
    expect(body).toContain("amount=250000");
    expect(body).toContain("currency=aud");
    expect(body).toContain("off_session=true");
    expect(body).toContain("confirm=true");
    expect(body).toContain("payment_method=pm_1");
    expect(calls[0].headers["Idempotency-Key"]).toBe("mc-charge1");
  });
});

describe("charge result mapping", () => {
  const charge = (r: Parameters<typeof stub>[0]) =>
    adapterWith(r).adapter.charge({ customerId: "c", paymentMethodId: "p", amountMinor: 100, currency: "USD", idempotencyKey: "k-0123456789abcdef", description: "d", metadata: {} });

  it("a card decline => declined, with only the SAFE decline code, never provider free text", async () => {
    const r = await charge([{ status: 402, body: { error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds. 4242424242424242", payment_intent: { id: "pi_x", status: "requires_payment_method" } } } }]);
    expect(r).toEqual({ ok: false, failureCategory: "declined", failureCode: "insufficient_funds", paymentIntentId: "pi_x" });
    expect(JSON.stringify(r)).not.toContain("4242");
  });

  it("authentication required (SCA) => authentication_required — an off-session charge cannot complete it", async () => {
    const r = await charge([{ status: 402, body: { error: { type: "card_error", code: "authentication_required", payment_intent: { id: "pi_y", status: "requires_action" } } } }]);
    expect(r).toMatchObject({ ok: false, failureCategory: "authentication_required", paymentIntentId: "pi_y" });
  });

  it("a PaymentIntent that comes back requires_action without an HTTP error is also NOT a success", async () => {
    const r = await charge([{ status: 200, body: { id: "pi_z", status: "requires_action" } }]);
    expect(r).toMatchObject({ ok: false, failureCategory: "authentication_required" });
  });

  it("processing is accepted as pending (a webhook completes it), not as success", async () => {
    expect(await charge([{ status: 200, body: { id: "pi_p", status: "processing" } }])).toEqual({ ok: true, paymentIntentId: "pi_p", status: "processing" });
  });

  it("a 5xx or rate limit => outcomeUnknown (we cannot say the charge did not happen)", async () => {
    for (const status of [500, 502, 503, 429]) {
      const r = await charge([{ status, body: { error: { type: "api_error" } } }]);
      expect(r).toMatchObject({ ok: false, failureCategory: "provider_unavailable", outcomeUnknown: true });
    }
  });

  it("a network failure / timeout => outcomeUnknown", async () => {
    const r = await charge([new Error("connect ETIMEDOUT")]);
    expect(r).toMatchObject({ ok: false, failureCategory: "provider_unavailable", outcomeUnknown: true });
  });

  it("bad credentials => invalid_request (definitive, not unknown)", async () => {
    const r = await charge([{ status: 401, body: { error: { type: "invalid_request_error", message: "Invalid API Key provided: sk_test_****" } } }]);
    expect(r).toMatchObject({ ok: false, failureCategory: "invalid_request" });
    expect((r as { outcomeUnknown?: boolean }).outcomeUnknown).toBeUndefined();
  });
});

describe("other operations", () => {
  it("ensureCustomer reuses an existing customer, and recreates one that is gone (wrong mode / deleted)", async () => {
    const reuse = adapterWith([{ status: 200, body: { id: "cus_old" } }]);
    expect(await reuse.adapter.ensureCustomer({ existingCustomerId: "cus_old", contactId: "c", name: "J", idempotencyKey: "cust-c" })).toEqual({ customerId: "cus_old" });
    expect(reuse.calls).toHaveLength(1);

    const gone = adapterWith([{ status: 404, body: { error: { code: "resource_missing" } } }, { status: 200, body: { id: "cus_new" } }]);
    expect(await gone.adapter.ensureCustomer({ existingCustomerId: "cus_old", contactId: "c", name: "J", idempotencyKey: "cust-c" })).toEqual({ customerId: "cus_new" });
    expect(gone.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  it("ensureCustomer does NOT paper over a real failure (e.g. bad credentials) by creating customers", async () => {
    const { adapter } = adapterWith([{ status: 401, body: { error: {} } }]);
    await expect(adapter.ensureCustomer({ existingCustomerId: "cus_old", contactId: "c", name: "J", idempotencyKey: "cust-c" })).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it("refund maps success and failure; a network failure is outcomeUnknown", async () => {
    expect(await adapterWith([{ status: 200, body: { id: "re_1", status: "succeeded" } }]).adapter.refund({ paymentIntentId: "pi_1", amountMinor: 500, idempotencyKey: "rf-1" })).toEqual({ ok: true, refundId: "re_1", status: "succeeded" });
    expect(await adapterWith([{ status: 400, body: { error: { code: "charge_already_refunded" } } }]).adapter.refund({ paymentIntentId: "pi_1", idempotencyKey: "rf-2" })).toMatchObject({ ok: false, failureCategory: "invalid_request", failureCode: "charge_already_refunded" });
    expect(await adapterWith([new Error("socket hang up")]).adapter.refund({ paymentIntentId: "pi_1", idempotencyKey: "rf-3" })).toMatchObject({ ok: false, outcomeUnknown: true });
  });

  it("detach treats 'already gone' as success but surfaces real errors", async () => {
    await expect(adapterWith([{ status: 404, body: { error: { code: "resource_missing" } } }]).adapter.detachPaymentMethod("pm_1")).resolves.toBeUndefined();
    await expect(adapterWith([{ status: 500, body: {} }]).adapter.detachPaymentMethod("pm_1")).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it("checkAccess reports valid / invalid credentials / unreachable, and whether charging is enabled", async () => {
    expect(await adapterWith([{ status: 200, body: { charges_enabled: true } }]).adapter.checkAccess()).toEqual({ ok: true, chargesEnabled: true });
    expect(await adapterWith([{ status: 200, body: { charges_enabled: false } }]).adapter.checkAccess()).toEqual({ ok: true, chargesEnabled: false });
    expect(await adapterWith([{ status: 401, body: {} }]).adapter.checkAccess()).toEqual({ ok: false, reason: "invalid_credentials" });
    expect(await adapterWith([new Error("ENOTFOUND")]).adapter.checkAccess()).toEqual({ ok: false, reason: "unreachable" });
  });

  it("errors carry no provider text: the message is a fixed category string", async () => {
    const { adapter } = adapterWith([{ status: 400, body: { error: { message: "secret 4242424242424242 leaked", code: "parameter_invalid_empty" } } }]);
    try {
      await adapter.createSetupSession({ customerId: "c", metadata: {}, idempotencyKey: "k" });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("4242");
      expect((e as Error).message).not.toContain("secret");
    }
  });

  it("uses a request timeout signal on every call", async () => {
    const spy = vi.fn<FetchLike>(async () => ({ status: 200, text: async () => JSON.stringify({ id: "cus_1" }) }));
    await createStripeAdapter(ENV, spy).ensureCustomer({ contactId: "c", name: "J", idempotencyKey: "k" });
    expect(spy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("verifyStripeWebhook", () => {
  const SECRET = ENV.STRIPE_WEBHOOK_SECRET;
  const event = { id: "evt_1", type: "payment_intent.succeeded", data: { object: { id: "pi_1" } } };
  const sign = (body: string, t: number, secret = SECRET) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
  const now = 1_800_000_000_000;
  const t = now / 1000;

  it("accepts a correctly signed, fresh payload and returns the parsed event", () => {
    const body = JSON.stringify(event);
    expect(verifyStripeWebhook(body, sign(body, t), SECRET, now).id).toBe("evt_1");
  });

  it("rejects a wrong secret, a tampered body, a missing header, a malformed header and no configured secret", () => {
    const body = JSON.stringify(event);
    const reasonOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as WebhookVerificationError).reason;
      }
      return "no error";
    };
    expect(reasonOf(() => verifyStripeWebhook(body, sign(body, t, ("whsec_" + "wrong".repeat(5))), SECRET, now))).toBe("signature_mismatch");
    expect(reasonOf(() => verifyStripeWebhook(body + " ", sign(body, t), SECRET, now))).toBe("signature_mismatch");
    expect(reasonOf(() => verifyStripeWebhook(body, null, SECRET, now))).toBe("missing_signature");
    expect(reasonOf(() => verifyStripeWebhook(body, "garbage", SECRET, now))).toBe("malformed_signature");
    expect(reasonOf(() => verifyStripeWebhook(body, "t=abc,v1=00", SECRET, now))).toBe("malformed_signature");
    expect(reasonOf(() => verifyStripeWebhook(body, sign(body, t), "", now))).toBe("missing_secret");
  });

  it("rejects a replay outside the tolerance window, in either direction", () => {
    const body = JSON.stringify(event);
    const old = t - WEBHOOK_TOLERANCE_SECONDS - 5;
    const future = t + WEBHOOK_TOLERANCE_SECONDS + 5;
    expect(() => verifyStripeWebhook(body, sign(body, old), SECRET, now)).toThrow(/stale_timestamp/);
    expect(() => verifyStripeWebhook(body, sign(body, future), SECRET, now)).toThrow(/stale_timestamp/);
    expect(verifyStripeWebhook(body, sign(body, t - WEBHOOK_TOLERANCE_SECONDS + 5), SECRET, now).id).toBe("evt_1");
  });

  it("accepts when ANY of several v1 signatures matches (secret rotation)", () => {
    const body = JSON.stringify(event);
    const good = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
    expect(verifyStripeWebhook(body, `t=${t},v1=${"0".repeat(64)},v1=${good}`, SECRET, now).id).toBe("evt_1");
  });

  it("rejects a non-hex or wrong-length signature without throwing anything but a verification error", () => {
    const body = JSON.stringify(event);
    expect(() => verifyStripeWebhook(body, `t=${t},v1=zzzz`, SECRET, now)).toThrow(WebhookVerificationError);
    expect(() => verifyStripeWebhook(body, `t=${t},v1=abcd`, SECRET, now)).toThrow(WebhookVerificationError);
  });

  it("rejects a validly signed but structurally invalid payload", () => {
    const body = JSON.stringify({ nope: true });
    expect(() => verifyStripeWebhook(body, sign(body, t), SECRET, now)).toThrow(/invalid_payload/);
    const notJson = "not json";
    expect(() => verifyStripeWebhook(notJson, sign(notJson, t), SECRET, now)).toThrow(/invalid_payload/);
  });

  it("the rejection message never contains the payload, the signature or the secret", () => {
    const body = JSON.stringify(event);
    try {
      verifyStripeWebhook(body, sign(body, t, ("whsec_" + "wrong".repeat(5))), SECRET, now);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain(SECRET);
      expect(msg).not.toContain("pi_1");
      expect(msg).not.toMatch(/[0-9a-f]{40}/);
    }
  });
});
