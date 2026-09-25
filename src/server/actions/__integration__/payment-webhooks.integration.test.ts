// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// REAL-DATABASE proof of the payment webhook endpoint: only a correctly SIGNED
// request is accepted, every event is applied at most once (duplicates and
// replays are no-ops), late/out-of-order events cannot regress a final state,
// and rejections raise sanitized System Health incidents. The endpoint's only
// authentication is the provider's signature — never a session or a header a
// browser could set. Runs only when INTEGRATION_DATABASE_URL points at a
// DISPOSABLE PostgreSQL with this repo's migrations applied.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) process.env.DATABASE_URL = URL_UNDER_TEST;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const TAG = `wh-${Date.now()}`;
const eid = (n: string) => `evt_${TAG}_${n}_${crypto.randomUUID().slice(0, 8)}`;

describe.skipIf(!enabled)("payment webhooks — real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let fakeMod: typeof import("@/test/fake-payment-provider");
  let setProvider: typeof import("@/server/payments/provider").setPaymentProviderForTests;
  let route: typeof import("@/app/api/webhooks/payments/route");
  let health: typeof import("@/server/system/health-events");
  const contactIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ setPaymentProviderForTests: setProvider } = await import("@/server/payments/provider"));
    fakeMod = await import("@/test/fake-payment-provider");
    setProvider(new fakeMod.FakePaymentProvider());
    route = await import("@/app/api/webhooks/payments/route");
    health = await import("@/server/system/health-events");
    await prisma.company.upsert({ where: { id: "default-company" }, update: {}, create: { id: "default-company", name: "Test Co", signatureTemplate: "Regards" } });
  }, 60_000);

  afterAll(async () => {
    if (!enabled) return;
    setProvider(null);
    await prisma.paymentWebhookEvent.deleteMany({ where: { id: { contains: TAG } } });
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    await prisma.$disconnect();
  });

  beforeEach(() => health.resetHealthEventThrottleForTests());

  async function makeCharge(status: "PENDING" | "SUCCEEDED" | "FAILED" = "PENDING", amount = 200) {
    const n = ++seq;
    const contact = await prisma.contact.create({ data: { firstName: "Hook", lastName: `Customer${n}`, companyId: "default-company" } });
    contactIds.push(contact.id);
    const pm = await prisma.paymentMethod.create({
      data: { contactId: contact.id, cardholderName: "Hook Customer", last4: "4242", expiryMonth: 12, expiryYear: new Date().getUTCFullYear() + 3, amountAllocated: amount, provider: "stripe", providerCustomerId: `cus_${TAG}_${n}`, providerPaymentMethodId: `pm_${TAG}_${n}`, vaultStatus: "VAULTED" },
    });
    const piId = `pi_${TAG}_${n}`;
    const charge = await prisma.paymentCharge.create({ data: { paymentMethodId: pm.id, amount, currency: "usd", status, provider: "stripe", providerPaymentIntentId: piId, idempotencyKey: crypto.randomUUID() } });
    return { pm, charge, piId };
  }

  const send = (event: unknown, opts: Parameters<typeof fakeMod.signFakeWebhook>[1] & { header?: string | null } = {}) => {
    const { body, signature } = fakeMod.signFakeWebhook(event, opts);
    const headers = new Headers({ "content-type": "application/json" });
    const sig = opts.header === undefined ? signature : opts.header;
    if (sig !== null) headers.set("stripe-signature", sig);
    return route.POST(new Request("https://crm.example.test/api/webhooks/payments", { method: "POST", headers, body }));
  };
  const ev = (type: string, object: Record<string, unknown>, id = eid(type.replace(/\W/g, ""))) => ({ id, type, created: Math.floor(Date.now() / 1000), data: { object } });
  const chargeRow = (id: string) => prisma.paymentCharge.findUniqueOrThrow({ where: { id } });

  describe("authentication — the signature is the ONLY credential", () => {
    it("a correctly signed event is accepted (200)", async () => {
      const { piId } = await makeCharge();
      const res = await send(ev("payment_intent.succeeded", { id: piId }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, outcome: "processed" });
    });

    it("a request with NO signature header is rejected (400) and changes nothing", async () => {
      const { charge, piId } = await makeCharge();
      const res = await send(ev("payment_intent.succeeded", { id: piId }), { header: null });
      expect(res.status).toBe(400);
      expect((await chargeRow(charge.id)).status).toBe("PENDING");
    });

    it("a signature made with the WRONG secret is rejected", async () => {
      const { charge, piId } = await makeCharge();
      const res = await send(ev("payment_intent.succeeded", { id: piId }), { secret: "whsec_" + "attacker".repeat(3) });
      expect(res.status).toBe(400);
      expect((await chargeRow(charge.id)).status).toBe("PENDING");
    });

    it("a tampered body (valid signature for a different payload) is rejected", async () => {
      const { charge, piId } = await makeCharge();
      const good = fakeMod.signFakeWebhook(ev("payment_intent.payment_failed", { id: piId }));
      const tampered = JSON.stringify(ev("payment_intent.succeeded", { id: piId }));
      const res = await route.POST(new Request("https://x.test/api/webhooks/payments", { method: "POST", headers: { "stripe-signature": good.signature }, body: tampered }));
      expect(res.status).toBe(400);
      expect((await chargeRow(charge.id)).status).toBe("PENDING");
    });

    it("a replayed event outside the tolerance window is rejected", async () => {
      const { charge, piId } = await makeCharge();
      const res = await send(ev("payment_intent.succeeded", { id: piId }), { timestamp: Math.floor(Date.now() / 1000) - 3600 });
      expect(res.status).toBe(400);
      expect((await chargeRow(charge.id)).status).toBe("PENDING");
    });

    it("a browser-style request (cookies, an Authorization header, a claimed status in the URL) gets no special treatment", async () => {
      const { charge, piId } = await makeCharge();
      const res = await route.POST(
        new Request("https://x.test/api/webhooks/payments?status=succeeded", {
          method: "POST",
          headers: { cookie: "compass_dev_account=anything", authorization: "Bearer admin" },
          body: JSON.stringify(ev("payment_intent.succeeded", { id: piId })),
        })
      );
      expect(res.status).toBe(400);
      expect((await chargeRow(charge.id)).status).toBe("PENDING");
    });

    it("rejections raise a sanitized incident carrying only the reason — never the payload or signature", async () => {
      const { piId } = await makeCharge();
      await send(ev("payment_intent.succeeded", { id: piId }), { header: "t=1,v1=deadbeef" });
      const incident = await prisma.healthEvent.findFirst({ where: { type: "PAYMENT_WEBHOOK_REJECTED", resolvedAt: null }, orderBy: { lastSeenAt: "desc" } });
      expect(incident).not.toBeNull();
      const dump = JSON.stringify(incident);
      expect(dump).not.toContain(piId);
      expect(dump).not.toContain("deadbeef");
    });

    it("no provider configured => 503 (the provider retries later), nothing processed", async () => {
      const { charge, piId } = await makeCharge();
      setProvider(null);
      try {
        expect((await send(ev("payment_intent.succeeded", { id: piId }))).status).toBe(503);
      } finally {
        setProvider(new fakeMod.FakePaymentProvider());
      }
      expect((await chargeRow(charge.id)).status).toBe("PENDING");
    });
  });

  describe("idempotency", () => {
    it("the same event delivered twice is applied ONCE (ledger row, second delivery is 'duplicate')", async () => {
      const { charge, piId } = await makeCharge();
      const event = ev("payment_intent.succeeded", { id: piId });
      expect(await (await send(event)).json()).toMatchObject({ outcome: "processed" });
      expect(await (await send(event)).json()).toMatchObject({ outcome: "duplicate" });
      expect(await prisma.paymentWebhookEvent.count({ where: { id: event.id } })).toBe(1);
      expect((await chargeRow(charge.id)).status).toBe("SUCCEEDED");
    });

    it("ten concurrent deliveries of one event: one is processed, the rest are no-ops, state is right", async () => {
      const { charge, piId } = await makeCharge();
      const event = ev("payment_intent.succeeded", { id: piId });
      const results = await Promise.all(Array.from({ length: 10 }, () => send(event)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(await prisma.paymentWebhookEvent.count({ where: { id: event.id } })).toBe(1);
      expect((await chargeRow(charge.id)).status).toBe("SUCCEEDED");
    });

    it("an event whose first delivery crashed before completing (ledger row without processedAt) is safely re-applied", async () => {
      const { charge, piId } = await makeCharge();
      const event = ev("payment_intent.succeeded", { id: piId });
      await prisma.paymentWebhookEvent.create({ data: { id: event.id, provider: "stripe", type: event.type } });
      expect(await (await send(event)).json()).toMatchObject({ outcome: "processed" });
      expect((await chargeRow(charge.id)).status).toBe("SUCCEEDED");
    });

    it("the ledger stores only id/type/outcome — never the payload", async () => {
      const { piId } = await makeCharge();
      const event = ev("payment_intent.succeeded", { id: piId, secret_note: "SHOULD-NOT-BE-STORED" });
      await send(event);
      const row = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(JSON.stringify(row)).not.toContain("SHOULD-NOT-BE-STORED");
      expect(Object.keys(row).sort()).toEqual(["id", "outcome", "processedAt", "provider", "receivedAt", "type"]);
    });
  });

  describe("state changes are forward-only and order-tolerant", () => {
    it("payment_intent.succeeded completes a PENDING charge and confirms the payment method", async () => {
      const { charge, piId, pm } = await makeCharge("PENDING", 200);
      await send(ev("payment_intent.succeeded", { id: piId }));
      expect((await chargeRow(charge.id)).status).toBe("SUCCEEDED");
      expect((await prisma.paymentMethod.findUniqueOrThrow({ where: { id: pm.id } })).workflowStatus).toBe("CONFIRMED");
    });

    it("payment_intent.payment_failed marks PENDING as FAILED with only a safe code", async () => {
      const { charge, piId } = await makeCharge();
      await send(ev("payment_intent.payment_failed", { id: piId, last_payment_error: { type: "card_error", decline_code: "do_not_honor", message: "Card 4242424242424242 was declined for jane@example.com" } }));
      const row = await chargeRow(charge.id);
      expect(row).toMatchObject({ status: "FAILED", failureCategory: "declined", failureCode: "do_not_honor", errorMessage: "The card was declined." });
      expect(JSON.stringify(row)).not.toContain("4242424242424242");
      expect(JSON.stringify(row)).not.toContain("jane@example.com");
    });

    it("a LATE failure event cannot undo a success (out of order)", async () => {
      const { charge, piId } = await makeCharge();
      await send(ev("payment_intent.succeeded", { id: piId }));
      await send(ev("payment_intent.payment_failed", { id: piId }));
      await send(ev("payment_intent.canceled", { id: piId }));
      expect((await chargeRow(charge.id)).status).toBe("SUCCEEDED");
    });

    it("a success that arrives AFTER a failure event (retry ordering) still wins", async () => {
      const { charge, piId } = await makeCharge();
      await send(ev("payment_intent.payment_failed", { id: piId }));
      await send(ev("payment_intent.succeeded", { id: piId }));
      expect((await chargeRow(charge.id)).status).toBe("SUCCEEDED");
    });

    it("processing does not change a PENDING charge, and cannot regress a final one", async () => {
      const a = await makeCharge();
      await send(ev("payment_intent.processing", { id: a.piId }));
      expect((await chargeRow(a.charge.id)).status).toBe("PENDING");
      const b = await makeCharge("SUCCEEDED");
      await send(ev("payment_intent.processing", { id: b.piId }));
      expect((await chargeRow(b.charge.id)).status).toBe("SUCCEEDED");
    });

    it("canceled moves PENDING to CANCELED", async () => {
      const { charge, piId } = await makeCharge();
      await send(ev("payment_intent.canceled", { id: piId }));
      expect((await chargeRow(charge.id)).status).toBe("CANCELED");
    });

    it("charge.refunded: partial then full, cumulative and idempotent; a refund event cannot resurrect a failed charge", async () => {
      const { charge, piId } = await makeCharge("SUCCEEDED", 200);
      await send(ev("charge.refunded", { payment_intent: piId, amount: 20000, amount_refunded: 5000 }));
      let row = await chargeRow(charge.id);
      expect(row.status).toBe("PARTIALLY_REFUNDED");
      expect(Number(row.refundedAmount)).toBe(50);
      await send(ev("charge.refunded", { payment_intent: piId, amount: 20000, amount_refunded: 5000 })); // same numbers, new event id
      expect(Number((await chargeRow(charge.id)).refundedAmount)).toBe(50);
      await send(ev("charge.refunded", { payment_intent: piId, amount: 20000, amount_refunded: 20000 }));
      row = await chargeRow(charge.id);
      expect(row.status).toBe("REFUNDED");
      expect(Number(row.refundedAmount)).toBe(200);

      const failed = await makeCharge("FAILED");
      await send(ev("charge.refunded", { payment_intent: failed.piId, amount: 20000, amount_refunded: 20000 }));
      expect((await chargeRow(failed.charge.id)).status).toBe("FAILED");
    });

    it("payment_method.detached marks the stored method DETACHED so it can no longer be charged", async () => {
      const { pm } = await makeCharge();
      await send(ev("payment_method.detached", { id: pm.providerPaymentMethodId }));
      expect((await prisma.paymentMethod.findUniqueOrThrow({ where: { id: pm.id } })).vaultStatus).toBe("DETACHED");
    });

    it("an event for a charge we do not know is acknowledged (200) and recorded as unknown, never an error loop", async () => {
      const res = await send(ev("payment_intent.succeeded", { id: `pi_${TAG}_nobody` }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ outcome: "unknown_charge" });
    });

    it("event types we do not handle are acknowledged and ignored", async () => {
      const res = await send(ev("customer.created", { id: "cus_x" }));
      expect(await res.json()).toMatchObject({ ok: true, outcome: "ignored" });
    });

    it("finds the charge by our own charge id in the PaymentIntent metadata when the intent id was not yet stored", async () => {
      const { charge } = await makeCharge();
      await prisma.paymentCharge.update({ where: { id: charge.id }, data: { providerPaymentIntentId: null } });
      await send(ev("payment_intent.succeeded", { id: `pi_${TAG}_late`, metadata: { chargeId: charge.id } }));
      const row = await chargeRow(charge.id);
      expect(row.status).toBe("SUCCEEDED");
      expect(row.providerPaymentIntentId).toBe(`pi_${TAG}_late`);
    });
  });
});
