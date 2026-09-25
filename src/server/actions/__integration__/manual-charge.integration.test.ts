// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// REAL-DATABASE proof of the vaulted-card manual charge and refund workflow,
// against a fake payment provider (no network, no real card, no card data of
// any kind exists anywhere in this file). Proves: Admin-only authorization,
// row-level (IDOR) protection, exactly-once charging under double click /
// replay / concurrency, forward-only status handling, the "outcome unknown"
// retry, limits, currency, and that nothing sensitive reaches the audit trail.
// Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL
// with this repo's migrations applied.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) process.env.DATABASE_URL = URL_UNDER_TEST;

type Actor = { id: string; role: string; companyId: string; fullName: string; email: string; phone: string | null; status: string; paymentPermissions: string[] } | null;
let currentActor: Actor = null;
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));

const TAG = `mc-${Date.now()}`;
const COMPANY = "default-company";
const OTHER_COMPANY = `${TAG}-other`;
const key = () => crypto.randomUUID();

describe.skipIf(!enabled)("manual charge & refund — real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let fake: import("@/test/fake-payment-provider").FakePaymentProvider;
  let setProvider: typeof import("@/server/payments/provider").setPaymentProviderForTests;
  let charges: typeof import("@/server/payments/manual-charge");
  let actions: typeof import("../manual-charge");
  let health: typeof import("@/server/system/health-events");
  const accounts: Record<string, NonNullable<Actor>> = {};
  const contactIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ setPaymentProviderForTests: setProvider } = await import("@/server/payments/provider"));
    const { FakePaymentProvider } = await import("@/test/fake-payment-provider");
    fake = new FakePaymentProvider();
    setProvider(fake);
    charges = await import("@/server/payments/manual-charge");
    actions = await import("../manual-charge");
    health = await import("@/server/system/health-events");
    await prisma.company.upsert({ where: { id: COMPANY }, update: {}, create: { id: COMPANY, name: "Test Co", signatureTemplate: "Regards" } });
    await prisma.company.create({ data: { id: OTHER_COMPANY, name: "Other Co", signatureTemplate: "x" } });
    for (const [name, role, companyId] of [
      ["admin", "ADMIN", COMPANY],
      ["manager", "MANAGER", COMPANY],
      ["ticketing", "TICKETING_AGENT", COMPANY],
      ["travel", "TRAVEL_AGENT", COMPANY],
      ["expert", "FLIGHT_EXPERT", COMPANY],
      ["marketing", "MARKETING_AGENT", COMPANY],
      ["otherAdmin", "ADMIN", OTHER_COMPANY],
    ] as const) {
      const a = await prisma.account.create({ data: { fullName: `MC ${name}`, email: `${name}-${TAG}@example.test`, role, companyId } });
      accounts[name] = { id: a.id, role, companyId, fullName: a.fullName, email: a.email, phone: null, status: "ACTIVE", paymentPermissions: ["payments.charge", "payments.confirm_manual_payment", "payments.reveal"] };
    }
  }, 60_000);

  afterAll(async () => {
    if (!enabled) return;
    setProvider(null);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: Object.values(accounts).map((a) => a.id) } } });
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    await prisma.account.deleteMany({ where: { email: { contains: TAG } } });
    await prisma.company.delete({ where: { id: OTHER_COMPANY } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  beforeEach(() => {
    currentActor = accounts.admin;
    fake.calls.length = 0;
    fake.charged.length = 0;
    fake.chargeResults.length = 0;
    fake.refundResults.length = 0;
    health.resetHealthEventThrottleForTests();
  });

  /** A booking with one vaulted card, in AUD (so currency handling is exercised), allocated 1000. */
  async function makeBooking(opts: { allocated?: number; vaultStatus?: "VAULTED" | "NOT_VAULTED" | "DETACHED"; status?: "ACTIVE" | "ARCHIVED"; expiryYear?: number; expiryMonth?: number; companyId?: string } = {}) {
    const n = ++seq;
    const contact = await prisma.contact.create({ data: { firstName: "Charge", lastName: `Customer${n}`, primaryEmail: `c${n}-${TAG}@example.test`, companyId: opts.companyId ?? COMPANY } });
    contactIds.push(contact.id);
    const lead = await prisma.lead.create({ data: { contactId: contact.id, status: "BOOKED", source: "OTHER" } });
    const quote = await prisma.quote.create({
      data: { quoteNumber: `Q-${TAG}-${n}`, secureToken: `tok-${TAG}-${n}`, leadId: lead.id, contactId: contact.id, status: "BOOKED", currency: "AUD", exchangeRate: 1.5, adults: 1, adultPrice: 500, total: 500 },
    });
    const booking = await prisma.booking.create({
      data: {
        quoteId: quote.id,
        leadId: lead.id,
        contactId: contact.id,
        bookingReference: `MC${Date.now().toString(36).slice(-4).toUpperCase()}${n}`,
        contactPhone: "+1",
        contactEmail: "c@example.test",
        billingAddress: "x",
        billingCity: "x",
        billingState: "x",
        billingZip: "x",
        billingCountry: "AU",
        status: "TICKETED",
      },
    });
    const pm = await prisma.paymentMethod.create({
      data: {
        bookingId: booking.id,
        contactId: contact.id,
        cardholderName: "Charge Customer",
        last4: "4242",
        cardBrand: "Visa",
        expiryMonth: opts.expiryMonth ?? 12,
        expiryYear: opts.expiryYear ?? new Date().getUTCFullYear() + 3,
        amountAllocated: opts.allocated ?? 1000,
        provider: "stripe",
        providerCustomerId: `cus_${n}`,
        providerPaymentMethodId: `pm_${n}`,
        providerSetupIntentId: `seti_${TAG}_${n}`,
        vaultStatus: opts.vaultStatus ?? "VAULTED",
        status: opts.status ?? "ACTIVE",
      },
    });
    return { contact, lead, quote, booking, pm };
  }

  const charge = (b: { booking: { id: string }; pm: { id: string } }, over: Record<string, unknown> = {}) => actions.initiateManualCharge({ paymentMethodId: b.pm.id, bookingId: b.booking.id, amount: 250, reason: "Ticket purchase", idempotencyKey: key(), ...over } as never);

  describe("a successful charge", () => {
    it("charges the vaulted method through the provider in the BOOKING's currency, and records exactly what happened", async () => {
      const b = await makeBooking();
      const k = key();
      const r = await charge(b, { amount: 250.5, reason: "Fare + taxes", idempotencyKey: k });
      expect(r).toMatchObject({ ok: true, status: "SUCCEEDED" });
      const row = await prisma.paymentCharge.findUniqueOrThrow({ where: { idempotencyKey: k } });
      expect(row).toMatchObject({ status: "SUCCEEDED", currency: "aud", provider: "stripe", referenceNote: "Fare + taxes", initiatedById: accounts.admin.id, paymentMethodId: b.pm.id });
      expect(Number(row.amount)).toBe(250.5);
      expect(row.providerPaymentIntentId).toMatch(/^pi_/);
      // What the provider was asked: the vault references from OUR row (never the browser), minor units, the booking's currency.
      expect(fake.charged).toHaveLength(1);
      expect(fake.charged[0]).toMatchObject({ customerId: `cus_${seq}`, paymentMethodId: `pm_${seq}`, amountMinor: 25050, currency: "AUD" });
      expect(fake.charged[0].metadata).toEqual({ chargeId: row.id, bookingId: b.booking.id });
    });

    it("a partial charge leaves the method AUTHORIZED; collecting the rest makes it CONFIRMED", async () => {
      const b = await makeBooking({ allocated: 1000 });
      await charge(b, { amount: 400 });
      expect((await prisma.paymentMethod.findUniqueOrThrow({ where: { id: b.pm.id } })).workflowStatus).toBe("AUTHORIZED");
      await charge(b, { amount: 600 });
      expect((await prisma.paymentMethod.findUniqueOrThrow({ where: { id: b.pm.id } })).workflowStatus).toBe("CONFIRMED");
    });

    it("logs the activity with the customer's own currency symbol (never a bare $), and audits only last4", async () => {
      const b = await makeBooking();
      const r = await charge(b, { amount: 100 });
      expect(r.ok).toBe(true);
      const act = await prisma.activity.findFirstOrThrow({ where: { bookingId: b.booking.id, type: "PAYMENT_CONFIRMED" } });
      expect(act.description).toContain("A$");
      expect(act.description).not.toMatch(/(?<![A-Z])\$\d/);
      const audits = await prisma.auditLog.findMany({ where: { entityType: "PaymentCharge", actorId: accounts.admin.id }, orderBy: { createdAt: "desc" }, take: 3 });
      expect(audits.map((a) => a.action)).toContain("MANUAL_CHARGE_SUCCEEDED");
      expect(JSON.stringify(audits)).not.toMatch(/\d{13,}/);
      expect((audits[0].metadata as { last4: string }).last4).toBe("4242");
    });

    it("does not touch booking or quote status (Ticketed→Booked, Confirmed→Charged rules stay owned by ticketing)", async () => {
      const b = await makeBooking();
      await charge(b);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.booking.id } })).status).toBe("TICKETED");
      expect((await prisma.quote.findUniqueOrThrow({ where: { id: b.quote.id } })).status).toBe("BOOKED");
    });
  });

  describe("authorization (server-side)", () => {
    it.each(["manager", "ticketing", "travel", "expert", "marketing"] as const)("%s cannot charge, even with every payment grant — Admin only", async (who) => {
      const b = await makeBooking();
      currentActor = accounts[who];
      const r = await charge(b);
      expect(r).toMatchObject({ ok: false, code: "DENIED" });
      expect(await prisma.paymentCharge.count({ where: { paymentMethodId: b.pm.id } })).toBe(0);
      expect(fake.calls.some((c) => c.op === "charge")).toBe(false);
    });

    it("signed out and inactive accounts cannot charge", async () => {
      const b = await makeBooking();
      currentActor = null;
      expect((await charge(b)).ok).toBe(false);
      currentActor = { ...accounts.admin, status: "INACTIVE" };
      expect(await charge(b)).toMatchObject({ ok: false, code: "DENIED" });
      expect(fake.calls).toHaveLength(0);
    });

    it("IDOR: an Admin of ANOTHER company cannot charge this company's booking", async () => {
      const b = await makeBooking();
      currentActor = accounts.otherAdmin;
      expect(await charge(b)).toMatchObject({ ok: false, code: "NOT_FOUND" });
      expect(fake.calls.some((c) => c.op === "charge")).toBe(false);
    });

    it("IDOR: a payment method that belongs to a DIFFERENT booking cannot be charged under this booking id", async () => {
      const a = await makeBooking();
      const other = await makeBooking();
      const r = await actions.initiateManualCharge({ paymentMethodId: other.pm.id, bookingId: a.booking.id, amount: 100, reason: "wrong card", idempotencyKey: key() });
      expect(r).toMatchObject({ ok: false, code: "NOT_FOUND" });
      expect(await prisma.paymentCharge.count({ where: { paymentMethodId: other.pm.id } })).toBe(0);
    });

    it("a booking or payment method id that does not exist is 'not found', never a crash", async () => {
      const b = await makeBooking();
      expect(await actions.initiateManualCharge({ paymentMethodId: "nope", bookingId: b.booking.id, amount: 10, reason: "x y z", idempotencyKey: key() })).toMatchObject({ ok: false, code: "NOT_FOUND" });
      expect(await actions.initiateManualCharge({ paymentMethodId: b.pm.id, bookingId: "nope", amount: 10, reason: "x y z", idempotencyKey: key() })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });

    it("the browser cannot choose the outcome: a client-supplied status/currency/provider ids are ignored — only the provider decides", async () => {
      const b = await makeBooking();
      fake.chargeResults.push({ ok: false, failureCategory: "declined", failureCode: "card_declined" });
      const r = await actions.initiateManualCharge({ paymentMethodId: b.pm.id, bookingId: b.booking.id, amount: 100, reason: "try", idempotencyKey: key(), status: "SUCCEEDED", currency: "USD", providerPaymentMethodId: "pm_attacker", customerId: "cus_attacker" } as never);
      expect(r).toMatchObject({ ok: false, code: "DECLINED" });
      expect((await prisma.paymentCharge.findFirstOrThrow({ where: { paymentMethodId: b.pm.id } })).status).toBe("FAILED");
      expect(fake.charged[0]).toMatchObject({ customerId: `cus_${seq}`, currency: "AUD" });
    });
  });

  describe("exactly-once", () => {
    it("the same request twice (double click / replay) charges ONCE and reports the original result", async () => {
      const b = await makeBooking();
      const k = key();
      const first = await charge(b, { idempotencyKey: k });
      const second = await charge(b, { idempotencyKey: k });
      expect(first).toMatchObject({ ok: true, status: "SUCCEEDED" });
      expect(second).toMatchObject({ ok: true, status: "SUCCEEDED", duplicate: true });
      expect(await prisma.paymentCharge.count({ where: { paymentMethodId: b.pm.id } })).toBe(1);
      expect(fake.charged).toHaveLength(1);
    });

    it("eight concurrent identical requests: one charge row, one provider charge, every caller told the same thing", async () => {
      const b = await makeBooking();
      const k = key();
      const results = await Promise.all(Array.from({ length: 8 }, () => charge(b, { idempotencyKey: k })));
      expect(results.every((r) => r.ok)).toBe(true);
      expect(await prisma.paymentCharge.count({ where: { paymentMethodId: b.pm.id } })).toBe(1);
      expect(fake.charged).toHaveLength(1);
    });

    it("reusing a key for a DIFFERENT amount is refused (a stale dialog can never change what was charged)", async () => {
      const b = await makeBooking();
      const k = key();
      await charge(b, { idempotencyKey: k, amount: 100 });
      expect(await charge(b, { idempotencyKey: k, amount: 999 })).toMatchObject({ ok: false, code: "KEY_REUSED" });
      expect(fake.charged).toHaveLength(1);
    });

    it("a second, different charge while one is still in flight on the same card is refused", async () => {
      const b = await makeBooking();
      await prisma.paymentCharge.create({ data: { paymentMethodId: b.pm.id, amount: 50, currency: "aud", status: "PENDING", provider: "stripe", idempotencyKey: key() } });
      expect(await charge(b)).toMatchObject({ ok: false, code: "IN_PROGRESS" });
      expect(fake.charged).toHaveLength(0);
    });

    it("DATABASE backstop: even a direct insert cannot create a second in-flight provider charge for the same card", async () => {
      const b = await makeBooking();
      await prisma.paymentCharge.create({ data: { paymentMethodId: b.pm.id, amount: 1, currency: "aud", status: "PENDING", provider: "stripe", idempotencyKey: key() } });
      await expect(prisma.paymentCharge.create({ data: { paymentMethodId: b.pm.id, amount: 2, currency: "aud", status: "PENDING", provider: "stripe", idempotencyKey: key() } })).rejects.toThrow();
      // Record-only entries (no provider) and finished charges are not limited.
      await prisma.paymentCharge.create({ data: { paymentMethodId: b.pm.id, amount: 3, currency: "aud", status: "PENDING" } });
      await prisma.paymentCharge.create({ data: { paymentMethodId: b.pm.id, amount: 4, currency: "aud", status: "SUCCEEDED", provider: "stripe", idempotencyKey: key() } });
    });

    it("twenty concurrent DIFFERENT requests on one card: at most one is ever in flight, and the cumulative limit holds", async () => {
      const b = await makeBooking({ allocated: 100 }); // ceiling 5,500
      const results = await Promise.all(Array.from({ length: 20 }, () => charge(b, { amount: 1000 })));
      const rows = await prisma.paymentCharge.findMany({ where: { paymentMethodId: b.pm.id } });
      expect(rows.filter((r) => r.status === "PENDING")).toHaveLength(0); // all finished (fake provider answers instantly)
      expect(rows.reduce((s, r) => s + Number(r.amount), 0)).toBeLessThanOrEqual(5500);
      expect(fake.charged.length).toBe(rows.length);
      expect(results.filter((r) => r.ok).length).toBe(rows.length);
      expect(results.filter((r) => !r.ok && !["IN_PROGRESS", "OVER_LIMIT"].includes(r.code))).toHaveLength(0);
    });

    it("two concurrent DIFFERENT requests on one card cannot both go out at once beyond the limit rule", async () => {
      const b = await makeBooking({ allocated: 100 }); // limit = 100*5 + 5000 = 5500
      const results = await Promise.all([charge(b, { amount: 4000 }), charge(b, { amount: 4000 })]);
      // Whichever way the race falls, the cumulative limit holds.
      const rows = await prisma.paymentCharge.findMany({ where: { paymentMethodId: b.pm.id, status: { in: ["SUCCEEDED", "PENDING"] } } });
      expect(rows.reduce((s, r) => s + Number(r.amount), 0)).toBeLessThanOrEqual(5500);
      expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("failures", () => {
    it("a decline is recorded as FAILED with only a safe category/code, and the method is marked FAILED", async () => {
      const b = await makeBooking();
      fake.chargeResults.push({ ok: false, failureCategory: "declined", failureCode: "insufficient_funds" });
      const r = await charge(b);
      expect(r).toMatchObject({ ok: false, code: "DECLINED" });
      const row = await prisma.paymentCharge.findFirstOrThrow({ where: { paymentMethodId: b.pm.id } });
      expect(row).toMatchObject({ status: "FAILED", failureCategory: "declined", failureCode: "insufficient_funds" });
      expect(row.errorMessage).toBe("The card was declined.");
      expect((await prisma.paymentMethod.findUniqueOrThrow({ where: { id: b.pm.id } })).workflowStatus).toBe("FAILED");
    });

    it("after a decline a NEW attempt is allowed (a failed charge does not block the card)", async () => {
      const b = await makeBooking();
      fake.chargeResults.push({ ok: false, failureCategory: "declined" });
      await charge(b);
      expect(await charge(b)).toMatchObject({ ok: true, status: "SUCCEEDED" });
    });

    it("authentication-required (SCA) is reported plainly: an off-session charge cannot complete it", async () => {
      const b = await makeBooking();
      fake.chargeResults.push({ ok: false, failureCategory: "authentication_required" });
      const r = await charge(b);
      expect(r).toMatchObject({ ok: false, code: "AUTHENTICATION_REQUIRED" });
      expect((await prisma.paymentCharge.findFirstOrThrow({ where: { paymentMethodId: b.pm.id } })).status).toBe("FAILED");
    });

    it("a provider rejection as invalid_request raises a CRITICAL System Health incident", async () => {
      const b = await makeBooking();
      fake.chargeResults.push({ ok: false, failureCategory: "invalid_request", failureCode: "invalid_credentials" });
      await charge(b);
      expect(await prisma.healthEvent.count({ where: { type: "PAYMENT_PROVIDER_ERROR", severity: "CRITICAL", resolvedAt: null } })).toBeGreaterThan(0);
    });

    it("OUTCOME UNKNOWN (provider timeout): the charge stays PENDING, is not reported as failed, and retrying the SAME request resolves it without a double charge", async () => {
      const b = await makeBooking();
      const k = key();
      fake.chargeResults.push({ ok: false, failureCategory: "provider_unavailable", outcomeUnknown: true });
      const first = await charge(b, { idempotencyKey: k });
      expect(first).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
      expect((await prisma.paymentCharge.findUniqueOrThrow({ where: { idempotencyKey: k } })).status).toBe("PENDING");
      expect(fake.charged).toHaveLength(0); // it never reached the provider

      const retry = await charge(b, { idempotencyKey: k });
      expect(retry).toMatchObject({ ok: true, status: "SUCCEEDED" });
      expect(await prisma.paymentCharge.count({ where: { paymentMethodId: b.pm.id } })).toBe(1);
      expect(fake.charged).toHaveLength(1);
    });

    it("while an unknown-outcome charge is pending, a DIFFERENT request is blocked (no risk of charging the customer twice)", async () => {
      const b = await makeBooking();
      fake.chargeResults.push({ ok: false, failureCategory: "provider_unavailable", outcomeUnknown: true });
      await charge(b);
      expect(await charge(b)).toMatchObject({ ok: false, code: "IN_PROGRESS" });
    });

    it("an exception thrown by the provider client is treated as outcome-unknown, never as a decline", async () => {
      const b = await makeBooking();
      const k = key();
      const original = fake.charge.bind(fake);
      fake.charge = async () => {
        throw new Error("boom");
      };
      try {
        expect(await charge(b, { idempotencyKey: k })).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
      } finally {
        fake.charge = original;
      }
      expect((await prisma.paymentCharge.findUniqueOrThrow({ where: { idempotencyKey: k } })).status).toBe("PENDING");
    });

    it("the provider still processing (async) leaves the charge PENDING for a webhook to finish", async () => {
      const b = await makeBooking();
      fake.chargeResults.push({ ok: true, paymentIntentId: "pi_processing1", status: "processing" });
      const r = await charge(b);
      expect(r).toMatchObject({ ok: true, status: "PENDING" });
      const row = await prisma.paymentCharge.findFirstOrThrow({ where: { paymentMethodId: b.pm.id } });
      expect(row).toMatchObject({ status: "PENDING", providerPaymentIntentId: "pi_processing1" });
    });

    it("no provider configured: refused, nothing recorded", async () => {
      const b = await makeBooking();
      const result = await charges.executeManualCharge(accounts.admin as never, { paymentMethodId: b.pm.id, bookingId: b.booking.id, amount: 10, reason: "no provider", idempotencyKey: key() }, null);
      expect(result).toMatchObject({ ok: false, code: "PROVIDER_UNAVAILABLE" });
      expect(await prisma.paymentCharge.count({ where: { paymentMethodId: b.pm.id } })).toBe(0);
    });
  });

  describe("what may be charged", () => {
    it.each([
      ["a legacy record that was never vaulted", { vaultStatus: "NOT_VAULTED" as const }],
      ["a card removed at the provider", { vaultStatus: "DETACHED" as const }],
      ["an archived (removed) payment method", { status: "ARCHIVED" as const }],
    ])("refuses %s", async (_label, opts) => {
      const b = await makeBooking(opts);
      expect(await charge(b)).toMatchObject({ ok: false, code: "NOT_CHARGEABLE" });
      expect(fake.charged).toHaveLength(0);
    });

    it("refuses an expired card", async () => {
      const b = await makeBooking({ expiryYear: new Date().getUTCFullYear() - 1, expiryMonth: 1 });
      expect(await charge(b)).toMatchObject({ ok: false, code: "EXPIRED" });
    });

    it("enforces the existing charge ceiling cumulatively (allocation x5 + 5000) — a fat-finger amount is refused", async () => {
      const b = await makeBooking({ allocated: 1000 }); // 10,000 ceiling
      expect(await charge(b, { amount: 10001 })).toMatchObject({ ok: false, code: "OVER_LIMIT" });
      expect(await charge(b, { amount: 6000 })).toMatchObject({ ok: true });
      expect(await charge(b, { amount: 4001 })).toMatchObject({ ok: false, code: "OVER_LIMIT" });
      expect(await charge(b, { amount: 4000 })).toMatchObject({ ok: true });
    });

    it.each([
      ["zero", { amount: 0 }],
      ["negative", { amount: -5 }],
      ["three decimals", { amount: 10.005 }],
      ["NaN", { amount: Number.NaN }],
      ["Infinity", { amount: Number.POSITIVE_INFINITY }],
      ["a too-short reason", { reason: "x" }],
      ["a reason that contains a card number", { reason: "card 4111 1111 1111 1111 works" }],
      ["a hyphenated card number in the reason", { reason: "use 5555-5555-5555-4444" }],
      ["a malformed idempotency key", { idempotencyKey: "short" }],
    ])("rejects %s before touching the provider", async (_label, over) => {
      const b = await makeBooking();
      expect(await charge(b, over)).toMatchObject({ ok: false, code: "INVALID" });
      expect(fake.calls.some((c) => c.op === "charge")).toBe(false);
      expect(await prisma.paymentCharge.count({ where: { paymentMethodId: b.pm.id } })).toBe(0);
    });
  });

  describe("refunds", () => {
    async function charged(amount = 200) {
      const b = await makeBooking();
      await charge(b, { amount });
      const row = await prisma.paymentCharge.findFirstOrThrow({ where: { paymentMethodId: b.pm.id } });
      return { b, row };
    }
    const refund = (b: { booking: { id: string } }, chargeId: string, over: Record<string, unknown> = {}) => actions.refundManualCharge({ chargeId, bookingId: b.booking.id, idempotencyKey: key(), ...over } as never);

    it("a partial refund, then the remainder, moves the charge PARTIALLY_REFUNDED → REFUNDED and tracks the amount", async () => {
      const { b, row } = await charged(200);
      expect(await refund(b, row.id, { amount: 50 })).toMatchObject({ ok: true, status: "PARTIALLY_REFUNDED" });
      let r = await prisma.paymentCharge.findUniqueOrThrow({ where: { id: row.id } });
      expect(r.status).toBe("PARTIALLY_REFUNDED");
      expect(Number(r.refundedAmount)).toBe(50);
      expect(await refund(b, row.id)).toMatchObject({ ok: true, status: "REFUNDED" });
      r = await prisma.paymentCharge.findUniqueOrThrow({ where: { id: row.id } });
      expect(r.status).toBe("REFUNDED");
      expect(Number(r.refundedAmount)).toBe(200);
    });

    it("a duplicate refund request (same key) is applied ONCE", async () => {
      const { b, row } = await charged(200);
      const k = key();
      await refund(b, row.id, { amount: 50, idempotencyKey: k });
      const again = await refund(b, row.id, { amount: 50, idempotencyKey: k });
      expect(again).toMatchObject({ ok: true, duplicate: true });
      expect(Number((await prisma.paymentCharge.findUniqueOrThrow({ where: { id: row.id } })).refundedAmount)).toBe(50);
      expect(fake.calls.filter((c) => c.op === "refund")).toHaveLength(1);
    });

    it("cannot refund more than what remains, cannot refund a failed charge, and is Admin-only", async () => {
      const { b, row } = await charged(200);
      expect(await refund(b, row.id, { amount: 200.01 })).toMatchObject({ ok: false, code: "OVER_LIMIT" });
      currentActor = accounts.manager;
      expect(await refund(b, row.id, { amount: 10 })).toMatchObject({ ok: false, code: "DENIED" });
      currentActor = accounts.admin;
      fake.chargeResults.push({ ok: false, failureCategory: "declined" });
      await charge(b, { amount: 10 });
      const failed = await prisma.paymentCharge.findFirstOrThrow({ where: { paymentMethodId: b.pm.id, status: "FAILED" } });
      expect(await refund(b, failed.id)).toMatchObject({ ok: false });
    });

    it("a record-only entry (no provider) can never be refunded through the provider", async () => {
      const b = await makeBooking();
      const rec = await prisma.paymentCharge.create({ data: { paymentMethodId: b.pm.id, amount: 100, currency: "aud", status: "SUCCEEDED" } });
      expect(await refund(b, rec.id)).toMatchObject({ ok: false, code: "NOT_FOUND" });
      expect(fake.calls.some((c) => c.op === "refund")).toBe(false);
    });

    it("IDOR: another company's Admin cannot refund", async () => {
      const { b, row } = await charged(100);
      currentActor = accounts.otherAdmin;
      expect(await refund(b, row.id)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });

    it("a refund the provider rejects changes nothing locally", async () => {
      const { b, row } = await charged(100);
      fake.refundResults.push({ ok: false, failureCategory: "invalid_request", failureCode: "charge_already_refunded" });
      expect(await refund(b, row.id)).toMatchObject({ ok: false, code: "FAILED" });
      expect(Number((await prisma.paymentCharge.findUniqueOrThrow({ where: { id: row.id } })).refundedAmount)).toBe(0);
    });
  });

  describe("nothing sensitive is ever recorded", () => {
    it("across a full charge / decline / refund run, no audit row, activity or health incident contains a card-number-shaped value or a secret", async () => {
      const b = await makeBooking();
      await charge(b, { amount: 120 });
      fake.chargeResults.push({ ok: false, failureCategory: "declined", failureCode: "card_declined" });
      await charge(b, { amount: 30 });
      const row = await prisma.paymentCharge.findFirstOrThrow({ where: { paymentMethodId: b.pm.id, status: "SUCCEEDED" } });
      await actions.refundManualCharge({ chargeId: row.id, bookingId: b.booking.id, amount: 20, idempotencyKey: key() });
      const dump = JSON.stringify({
        audits: await prisma.auditLog.findMany({ where: { actorId: accounts.admin.id, entityType: "PaymentCharge" } }),
        activities: await prisma.activity.findMany({ where: { bookingId: b.booking.id } }),
        charges: await prisma.paymentCharge.findMany({ where: { paymentMethodId: b.pm.id } }),
        health: await prisma.healthEvent.findMany({ where: { category: "payment" } }),
      });
      // Isolated digit runs only: cuid/uuid ids legitimately contain digits, a card number would stand alone.
      expect(dump.match(/(?<![A-Za-z0-9-])\d{13,19}(?![A-Za-z0-9-])/)).toBeNull();
      expect(dump).not.toMatch(/cvv|cvc|security code|sk_(test|live)_/i);
    });
  });
});
