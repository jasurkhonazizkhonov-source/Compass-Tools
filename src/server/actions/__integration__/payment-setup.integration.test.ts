// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// REAL-DATABASE proof of the customer-facing step that starts a card capture
// (createBookingPaymentSetup) and of the server-side verification of a
// completed capture (verifyVaultedSetup). No card data exists anywhere here:
// the browser would talk to the provider's own fields, we only see references.
// Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) process.env.DATABASE_URL = URL_UNDER_TEST;

let rateAllowed = true;
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/security/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/server/security/rate-limit")>()),
  checkPublicRateLimitFromRequest: vi.fn(async () => (rateAllowed ? { allowed: true } : { allowed: false, retryAfterSeconds: 60 })),
}));

const TAG = `ps-${Date.now()}`;

describe.skipIf(!enabled)("payment setup & capture verification — real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let fake: import("@/test/fake-payment-provider").FakePaymentProvider;
  let setProvider: typeof import("@/server/payments/provider").setPaymentProviderForTests;
  let actions: typeof import("../payment-setup");
  let vaulted: typeof import("@/server/payments/vaulted-methods");
  let PaymentProviderError: typeof import("@/server/payments/types").PaymentProviderError;
  let health: typeof import("@/server/system/health-events");
  const contactIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ setPaymentProviderForTests: setProvider } = await import("@/server/payments/provider"));
    ({ PaymentProviderError } = await import("@/server/payments/types"));
    const { FakePaymentProvider } = await import("@/test/fake-payment-provider");
    fake = new FakePaymentProvider();
    setProvider(fake);
    actions = await import("../payment-setup");
    vaulted = await import("@/server/payments/vaulted-methods");
    health = await import("@/server/system/health-events");
    await prisma.company.upsert({ where: { id: "default-company" }, update: {}, create: { id: "default-company", name: "Test Co", signatureTemplate: "Regards" } });
  }, 60_000);

  afterAll(async () => {
    if (!enabled) return;
    setProvider(null);
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    await prisma.$disconnect();
  });

  beforeEach(() => {
    rateAllowed = true;
    fake.calls.length = 0;
    setProvider(fake);
    health.resetHealthEventThrottleForTests();
  });

  async function makeQuote(status: "SENT" | "DRAFT" | "CANCELED" | "SIGNED" = "SENT") {
    const n = ++seq;
    const contact = await prisma.contact.create({ data: { firstName: "Setup", lastName: `Customer${n}`, primaryEmail: `s${n}-${TAG}@example.test`, companyId: "default-company" } });
    contactIds.push(contact.id);
    const lead = await prisma.lead.create({ data: { contactId: contact.id, status: "QUOTED", source: "OTHER" } });
    const quote = await prisma.quote.create({ data: { quoteNumber: `Q-${TAG}-${n}`, secureToken: `tok-${TAG}-${n}`, leadId: lead.id, contactId: contact.id, status, adults: 1, adultPrice: 500, total: 500 } });
    return { contact, quote };
  }
  const slot = () => crypto.randomUUID();

  describe("createBookingPaymentSetup", () => {
    it("starts a capture bound to THIS quote, and returns only the one-purpose client secret + capture id", async () => {
      const { quote } = await makeQuote();
      const r = await actions.createBookingPaymentSetup({ token: quote.secureToken, slotKey: slot() });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.clientSecret).toMatch(/_secret_/);
      expect(Object.keys(r).sort()).toEqual(["clientSecret", "ok", "setupIntentId"]);
      expect(fake.setups.get(r.setupIntentId)?.metadata).toEqual({ quoteId: quote.id, purpose: "booking" });
    });

    it("the same slot twice (double click, retry) is the SAME capture; a new slot is a new one", async () => {
      const { quote } = await makeQuote();
      const s = slot();
      const a = await actions.createBookingPaymentSetup({ token: quote.secureToken, slotKey: s });
      const b = await actions.createBookingPaymentSetup({ token: quote.secureToken, slotKey: s });
      const c = await actions.createBookingPaymentSetup({ token: quote.secureToken, slotKey: slot() });
      expect(a).toEqual(b);
      expect(c.ok && a.ok && c.setupIntentId !== a.setupIntentId).toBe(true);
    });

    it("reuses ONE provider customer per contact — even under 10 concurrent first-time requests", async () => {
      const { quote, contact } = await makeQuote();
      const results = await Promise.all(Array.from({ length: 10 }, () => actions.createBookingPaymentSetup({ token: quote.secureToken, slotKey: slot() })));
      expect(results.every((r) => r.ok)).toBe(true);
      const stored = (await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).providerCustomerId;
      expect(stored).toMatch(/^cus_/);
      const customers = new Set(results.map((r) => (r.ok ? fake.setups.get(r.setupIntentId)!.customerId : "")));
      expect(customers.size).toBe(1);
      expect([...customers][0]).toBe(stored);
    });

    it.each(["DRAFT", "CANCELED", "SIGNED"] as const)("a %s quote cannot start a capture — same generic answer as an unknown link (nothing to enumerate)", async (status) => {
      const { quote } = await makeQuote(status);
      const r = await actions.createBookingPaymentSetup({ token: quote.secureToken, slotKey: slot() });
      expect(r).toEqual({ ok: false, error: expect.stringMatching(/no longer active/i) });
      expect(fake.calls.some((c) => c.op === "createSetupSession")).toBe(false);
    });

    it("an unknown token and an already-booked quote get the same answer", async () => {
      expect(await actions.createBookingPaymentSetup({ token: "no-such-token", slotKey: slot() })).toEqual({ ok: false, error: expect.stringMatching(/no longer active/i) });
      const { quote, contact } = await makeQuote();
      const lead = await prisma.lead.findFirstOrThrow({ where: { contactId: contact.id } });
      await prisma.booking.create({
        data: { quoteId: quote.id, leadId: lead.id, contactId: contact.id, bookingReference: `PS${Date.now().toString(36).slice(-5).toUpperCase()}`, contactPhone: "+1", contactEmail: "a@b.co", billingAddress: "x", billingCity: "x", billingState: "x", billingZip: "x", billingCountry: "US" },
      });
      expect(await actions.createBookingPaymentSetup({ token: quote.secureToken, slotKey: slot() })).toEqual({ ok: false, error: expect.stringMatching(/no longer active/i) });
    });

    it("malformed input never reaches the provider", async () => {
      const { quote } = await makeQuote();
      for (const bad of [{ token: quote.secureToken, slotKey: "short" }, { token: "", slotKey: slot() }, { token: quote.secureToken, slotKey: "has spaces and ../ chars!!" }]) {
        expect((await actions.createBookingPaymentSetup(bad)).ok).toBe(false);
      }
      expect(fake.calls).toHaveLength(0);
    });

    it("is rate limited per connection, and says so plainly", async () => {
      const { quote } = await makeQuote();
      rateAllowed = false;
      expect(await actions.createBookingPaymentSetup({ token: quote.secureToken, slotKey: slot() })).toEqual({ ok: false, error: expect.stringMatching(/too many attempts/i) });
      expect(fake.calls).toHaveLength(0);
    });

    it("no provider configured: a clear 'unavailable' message, nothing created", async () => {
      const { quote } = await makeQuote();
      setProvider(null);
      expect(await actions.createBookingPaymentSetup({ token: quote.secureToken, slotKey: slot() })).toEqual({ ok: false, error: expect.stringMatching(/temporarily unavailable/i) });
    });

    it("a provider failure returns a friendly message with NO provider text, and raises an incident", async () => {
      const { quote } = await makeQuote();
      fake.failNextSetup = new PaymentProviderError("provider_unavailable", "network_error", 503);
      const r = await actions.createBookingPaymentSetup({ token: quote.secureToken, slotKey: slot() });
      expect(r).toEqual({ ok: false, error: expect.stringMatching(/couldn't start secure card entry/i) });
      expect(JSON.stringify(r)).not.toMatch(/503|network_error|provider error/i);
      expect(await prisma.healthEvent.count({ where: { type: "PAYMENT_PROVIDER_ERROR", resolvedAt: null } })).toBeGreaterThan(0);
    });

    it("a stored customer id from the wrong mode/deleted at the provider is replaced, not reused blindly", async () => {
      const { quote, contact } = await makeQuote();
      await prisma.contact.update({ where: { id: contact.id }, data: { providerCustomerId: "cus_from_another_account" } });
      const r = await actions.createBookingPaymentSetup({ token: quote.secureToken, slotKey: slot() });
      expect(r.ok).toBe(true);
      const stored = (await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).providerCustomerId;
      expect(stored).not.toBe("cus_from_another_account");
      expect(fake.customers.has(stored!)).toBe(true);
    });
  });

  describe("verifyVaultedSetup — the server never trusts the browser", () => {
    async function completed(quoteId: string, card: Parameters<typeof fake.completeSetup>[1] = {}, customerId = "cus_v") {
      const { setupIntentId } = await fake.createSetupSession({ customerId, metadata: { quoteId, purpose: "booking" }, idempotencyKey: `v-${crypto.randomUUID()}` });
      fake.completeSetup(setupIntentId, card);
      return setupIntentId;
    }

    it("a completed, matching capture yields only display metadata + references", async () => {
      const { quote } = await makeQuote();
      const id = await completed(quote.id, { brand: "mastercard", last4: "5100", expMonth: 3, expYear: new Date().getUTCFullYear() + 2, funding: "debit" });
      const r = await vaulted.verifyVaultedSetup(id, { quoteId: quote.id });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.method).toMatchObject({ cardBrand: "Mastercard", last4: "5100", expiryMonth: 3, cardFunding: "debit", provider: "stripe" });
      expect(Object.keys(r.method).join(",")).not.toMatch(/cvv|cvc|pan|number|security/i);
    });

    it.each([
      ["never completed", async (q: string) => (await fake.createSetupSession({ customerId: "cus_v", metadata: { quoteId: q, purpose: "booking" }, idempotencyKey: `n-${crypto.randomUUID()}` })).setupIntentId, "not_completed"],
      ["forged id", async () => "seti_forged_by_browser", "not_completed"],
      ["malformed id", async () => "not a valid id!", "not_completed"],
      ["made for a different quote", async () => completed((await makeQuote()).quote.id), "mismatch"],
      ["an expired card", async (q: string) => completed(q, { expYear: new Date().getUTCFullYear() - 1, expMonth: 1 }), "invalid_card"],
      ["a malformed last4", async (q: string) => completed(q, { last4: "12" }), "invalid_card"],
    ])("refuses %s", async (_label, make, reason) => {
      const { quote } = await makeQuote();
      const id = await make(quote.id);
      expect(await vaulted.verifyVaultedSetup(id, { quoteId: quote.id })).toMatchObject({ ok: false, reason });
    });

    it("a capture under a DIFFERENT provider customer than the contact's stored one is refused", async () => {
      const { quote } = await makeQuote();
      const id = await completed(quote.id, {}, "cus_someone_else");
      expect(await vaulted.verifyVaultedSetup(id, { quoteId: quote.id, providerCustomerId: "cus_the_contacts_own" })).toMatchObject({ ok: false, reason: "mismatch" });
    });

    it("a capture already attached to a stored payment method cannot be reused", async () => {
      const { quote, contact } = await makeQuote();
      const id = await completed(quote.id);
      await prisma.paymentMethod.create({ data: { contactId: contact.id, cardholderName: "x", last4: "4242", expiryMonth: 1, expiryYear: new Date().getUTCFullYear() + 3, providerSetupIntentId: id, vaultStatus: "VAULTED" } });
      expect(await vaulted.verifyVaultedSetup(id, { quoteId: quote.id })).toMatchObject({ ok: false, reason: "already_used" });
    });

    it("provider outages are reported as such (so callers can say 'try again', not 'your card is bad')", async () => {
      const { quote } = await makeQuote();
      const id = await completed(quote.id);
      fake.failNextRetrieve = new PaymentProviderError("provider_unavailable", "network_error");
      expect(await vaulted.verifyVaultedSetup(id, { quoteId: quote.id })).toMatchObject({ ok: false, reason: "provider_unavailable" });
    });

    it("no provider => not_configured", async () => {
      const { quote } = await makeQuote();
      expect(await vaulted.verifyVaultedSetup("seti_abcdef", { quoteId: quote.id }, null)).toMatchObject({ ok: false, reason: "not_configured" });
    });
  });
});
