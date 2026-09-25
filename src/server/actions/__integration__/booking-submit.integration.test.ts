// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

// REAL-DATABASE integration test for the customer "Finish Booking" action
// (submitBooking). Runs only when INTEGRATION_DATABASE_URL points at a
// DISPOSABLE PostgreSQL database that already has this repo's migrations
// applied (`prisma migrate deploy`) — it is skipped otherwise, so the
// normal unit suite never depends on a live database. It creates its own
// uniquely-tagged rows and deletes them afterward; never point it at a
// database holding data you care about.
//
//   INTEGRATION_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/scratch \
//     npx vitest run src/server/actions/__integration__
//
// What the fake-Prisma unit tests cannot prove, and this does: that the
// signing writes are genuinely ATOMIC (a fault mid-way leaves nothing
// behind), that duplicate/concurrent submissions collapse to exactly one
// booking, and that optional follow-up work can never fail a committed
// booking.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;

if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
  process.env.TRUSTED_PROXY = "vercel";
  process.env.IP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_HASH_KEY ??= randomBytes(32).toString("base64");
}

let requestHeaders: Map<string, string>;
let currentIp = "";
vi.mock("next/headers", () => ({ headers: vi.fn(async () => requestHeaders) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// No request scope exists in a test process; run deferred work inline so
// assertions can observe its effects deterministically.
// Deferred tasks are collected so each test can await them (production runs
// them after the response; nothing in the request path depends on them).
const deferred: Promise<unknown>[] = [];
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (task: () => Promise<void>) => {
    deferred.push(task());
  },
}));
async function flushDeferred() {
  while (deferred.length) await Promise.allSettled(deferred.splice(0));
}

const sendStaffEmail = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
vi.mock("@/server/booking-notification", () => ({ sendBookingSignedNotification: (...args: unknown[]) => sendStaffEmail(...args) }));

// A fixed reference lets one test force a unique-constraint failure INSIDE
// the signing transaction (after the quote has already been claimed) to
// prove the whole thing rolls back.
let forcedReference: string | null = null;
vi.mock("nanoid", () => ({ customAlphabet: () => () => forcedReference ?? Math.random().toString(36).slice(2, 9).toUpperCase().padEnd(7, "X") }));

const TAG = `it-${Date.now()}`;

// A DB trigger (below) rejects any PaymentMethod insert whose last four digits
// are 0000, to inject a failure at the PAYMENT-METHOD step — i.e. AFTER the
// booking row itself has been written. The fake provider lets a test complete a
// capture with exactly that last4.

describe.skipIf(!enabled)("submitBooking against a real PostgreSQL database", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let submitBooking: typeof import("../booking").submitBooking;
  let fake: import("@/test/fake-payment-provider").FakePaymentProvider;
  let setProvider: typeof import("@/server/payments/provider").setPaymentProviderForTests;
  let healthEvents: typeof import("@/server/system/health-events");
  const contactIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ setPaymentProviderForTests: setProvider } = await import("@/server/payments/provider"));
    const { FakePaymentProvider } = await import("@/test/fake-payment-provider");
    fake = new FakePaymentProvider();
    setProvider(fake);
    healthEvents = await import("@/server/system/health-events");
    ({ submitBooking } = await import("../booking"));
    await prisma.company.upsert({
      where: { id: "default-company" },
      update: {},
      create: { id: "default-company", name: "Test Co", signatureTemplate: "Regards" },
    });
    // Fault injector: reject any PaymentMethod insert whose last4 is 0000.
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION it_reject_pm_0000() RETURNS trigger AS $fn$ BEGIN RAISE EXCEPTION 'injected payment-method failure'; END; $fn$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS it_reject_pm_0000 ON "PaymentMethod"`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER it_reject_pm_0000 BEFORE INSERT ON "PaymentMethod" FOR EACH ROW WHEN (NEW."last4" = '0000') EXECUTE FUNCTION it_reject_pm_0000()`);
  });

  afterAll(async () => {
    if (!enabled) return;
    setProvider(null);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS it_reject_pm_0000 ON "PaymentMethod"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS it_reject_pm_0000()`);
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    await prisma.$disconnect();
  });

  // Rate-limit counters persist in the database across runs, so each run uses
  // its own random block of documentation-range (RFC 5737) addresses.
  const ipBlock = 1 + Math.floor(Math.random() * 250);
  let ipSeq = 0;
  beforeEach(async () => {
    await flushDeferred();
    // A fresh client IP per test: the public booking endpoint is rate limited
    // per IP (10 attempts / 15 min), which this suite would otherwise trip.
    const testIp = `198.51.${ipBlock}.${(++ipSeq % 250) + 1}`;
    currentIp = testIp;
    requestHeaders = new Map([
      ["x-forwarded-for", testIp],
      ["user-agent", "IntegrationTest/1.0"],
    ]);
    forcedReference = null;
    sendStaffEmail.mockClear();
    sendStaffEmail.mockImplementation(async () => {});
  });

  async function makeQuote(currency = "USD", exchangeRate: number | null = null) {
    const n = ++seq;
    const contact = await prisma.contact.create({
      data: { firstName: "Jane", lastName: `Traveler${n}`, primaryEmail: `jane${n}-${TAG}@example.test`, companyId: "default-company" },
    });
    contactIds.push(contact.id);
    const lead = await prisma.lead.create({ data: { contactId: contact.id, status: "QUOTED", source: "OTHER" } });
    const quote = await prisma.quote.create({
      data: {
        quoteNumber: `Q-${TAG}-${n}`,
        secureToken: `tok-${TAG}-${n}`,
        leadId: lead.id,
        contactId: contact.id,
        status: "SENT",
        currency,
        exchangeRate,
        adults: 1,
        adultPrice: 500,
        taxes: 50,
        serviceFee: 20,
        total: 570,
      },
    });
    tokenToQuoteId.set(quote.secureToken, quote.id);
    return { contact, lead, quote };
  }

  // Like a customer's browser: one completed provider capture per quote, reused
  // by every retry of that quote's form (so concurrent/repeated submits carry the
  // SAME capture reference, as real retries do).
  const tokenToQuoteId = new Map<string, string>();
  const captureByToken = new Map<string, string>();
  async function capture(quoteId: string, last4 = "4242") {
    const { setupIntentId } = await fake.createSetupSession({ customerId: "cus_it", metadata: { quoteId, purpose: "booking" }, idempotencyKey: `it-${crypto.randomUUID()}` });
    fake.completeSetup(setupIntentId, { last4 });
    return setupIntentId;
  }
  function captureFor(token: string): string {
    let id = captureByToken.get(token);
    if (!id) {
      // Synchronous fake bookkeeping (no network): create + complete inline.
      const quoteId = tokenToQuoteId.get(token) ?? "unknown";
      const seti = `seti_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
      fake.setups.set(seti, { id: seti, customerId: "cus_it", metadata: { quoteId, purpose: "booking" }, status: "succeeded", paymentMethodId: `pm_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`, card: { brand: "visa", last4: "4242", expMonth: 12, expYear: new Date().getUTCFullYear() + 3, funding: "credit", cardholderName: "Jane Traveler" } });
      captureByToken.set(token, seti);
      id = seti;
    }
    return id;
  }

  function input(token: string, overrides: Record<string, unknown> = {}, total = 570) {
    return {
      token,
      passengers: [{ type: "ADULT" as const, firstName: "Jane", lastName: "Traveler", dateOfBirth: "1990-01-01", gender: "FEMALE" }],
      contactPhone: "+12125550100",
      contactEmail: "jane@example.test",
      billingAddress: "123 Main St",
      billingCity: "Springfield",
      billingState: "IL",
      billingZip: "62704",
      billingCountry: "US",
      paymentMethods: [
        {
          setupIntentId: captureFor(token),
          cardholderName: "Jane Traveler",
          amount: total,
        },
      ],
      paymentConsent: true as const,
      gratuityAmount: 0,
      termsAccepted: true as const,
      signedName: "Jane Traveler",
      ...overrides,
    };
  }

  it("completes a booking end to end: booking, passengers, signature with the full IP, payment method, quote SIGNED, lead BOOKED, histories, IP vault, activity", async () => {
    const { quote, lead, contact } = await makeQuote();
    const result = await submitBooking(input(quote.secureToken));
    await flushDeferred();
    expect(result.ok).toBe(true);

    const booking = await prisma.booking.findUniqueOrThrow({
      where: { quoteId: quote.id },
      include: { passengers: true, signature: true, paymentMethods: true, statusHistory: true },
    });
    expect(booking.status).toBe("PENDING_TICKETING");
    expect(Number(booking.totalAmount)).toBe(570);
    expect(booking.passengers).toHaveLength(1);
    // The COMPLETE signer IP, resolved server-side from the trusted proxy header.
    expect(booking.signature?.ipAddress).toBe(currentIp);
    expect(booking.signature?.userAgent).toBe("IntegrationTest/1.0");
    expect(booking.paymentMethods).toHaveLength(1);
    // Provider vault references + display metadata — no card number, no security code.
    expect(booking.paymentMethods[0]).toMatchObject({
      last4: "4242",
      cardBrand: "Visa",
      contactId: contact.id,
      provider: "stripe",
      vaultStatus: "VAULTED",
      workflowStatus: "PENDING", // a saved payment method is NOT a payment
      encryptedPan: null,
    });
    expect(booking.paymentMethods[0].providerPaymentMethodId).toMatch(/^pm_/);
    expect(booking.paymentMethods[0].providerSetupIntentId).toMatch(/^seti_/);
    expect(await prisma.paymentCharge.count({ where: { paymentMethod: { bookingId: booking.id } } })).toBe(0);
    expect(booking.statusHistory).toHaveLength(1);

    const q = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id }, include: { statusHistory: true } });
    expect(q.status).toBe("SIGNED");
    expect(q.signedAt).not.toBeNull();
    expect(q.statusHistory.map((h) => h.toStatus)).toContain("SIGNED");
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe("BOOKED");
    expect(await prisma.leadStatusHistory.count({ where: { leadId: lead.id, toStatus: "BOOKED" } })).toBe(1);

    // Deferred, non-critical follow-up all ran.
    expect(await prisma.activity.count({ where: { bookingId: booking.id, type: "BOOKING_SUBMITTED" } })).toBe(1);
    expect(await prisma.ipCapture.count({ where: { bookingId: booking.id } })).toBe(1);
    expect(sendStaffEmail).toHaveBeenCalledTimes(1);
  });

  it("NO CVV ANYWHERE: even if a stale client still sends a security code, it is never stored, cached, logged or echoed — not in any table of the database", async () => {
    const { quote } = await makeQuote();
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")];
    const MARK = "CVVMARK-8f3a1c";
    const base = input(quote.secureToken);
    const withCode = { ...base, paymentMethods: base.paymentMethods.map((c) => ({ ...c, cvv: MARK, cvc: MARK, securityCode: MARK })) };
    const result = await submitBooking(withCode as never);
    await flushDeferred();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    spies.forEach((spy) => spy.mockRestore());
    expect(logged).not.toContain(MARK);

    // Every column of every table: the marker is nowhere.
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
    const hits: string[] = [];
    for (const { table_name } of tables) {
      const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${table_name}" t WHERE t::text LIKE '%${MARK}%'`);
      if (rows[0].n > 0) hits.push(table_name);
    }
    expect(hits).toEqual([]);

    // The stored card has no security-code field at all, and no plain PAN.
    const [pm] = await prisma.paymentMethod.findMany({ where: { bookingId: result.bookingId } });
    expect(Object.keys(pm).join(",")).not.toMatch(/cvv|cvc|security|cid/i);
  });

  it("FULL signer IP: an IPv6 address is stored complete (untruncated) and the encrypted vault gets it too", async () => {
    const { quote } = await makeQuote();
    const ipv6 = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";
    requestHeaders = new Map([
      ["x-vercel-forwarded-for", ipv6],
      ["user-agent", "IntegrationTest/1.0"],
    ]);
    const result = await submitBooking(input(quote.secureToken));
    await flushDeferred();
    expect(result.ok).toBe(true);
    const sig = await prisma.signature.findFirstOrThrow({ where: { booking: { quoteId: quote.id } } });
    expect(sig.ipAddress).toBe(ipv6);
    expect(sig.ipAddress).toHaveLength(ipv6.length);
    const vault = await prisma.ipCapture.findMany({ where: { booking: { quoteId: quote.id } } });
    expect(vault.length).toBeGreaterThan(0);
    // The vault row never holds the plain address.
    expect(JSON.stringify(vault)).not.toContain(ipv6);
  });

  it("SPOOF-PROOF signer IP: a client-supplied Forwarded / CF-Connecting-IP header cannot set the recorded address on Vercel", async () => {
    const { quote } = await makeQuote();
    const real = "203.0.113.77";
    requestHeaders = new Map([
      ["x-vercel-forwarded-for", real],
      ["forwarded", "for=8.8.8.8"],
      ["cf-connecting-ip", "8.8.4.4"],
      ["user-agent", "IntegrationTest/1.0"],
    ]);
    const result = await submitBooking(input(quote.secureToken));
    await flushDeferred();
    expect(result.ok).toBe(true);
    const sig = await prisma.signature.findFirstOrThrow({ where: { booking: { quoteId: quote.id } } });
    expect(sig.ipAddress).toBe(real);
  });

  it("a malformed / private forwarded address records NO IP rather than junk (the booking still succeeds)", async () => {
    const { quote } = await makeQuote();
    requestHeaders = new Map([
      ["x-vercel-forwarded-for", "'; DROP TABLE \"Signature\"; --"],
      ["x-forwarded-for", "10.0.0.5"],
      ["user-agent", "IntegrationTest/1.0"],
    ]);
    const result = await submitBooking(input(quote.secureToken));
    await flushDeferred();
    expect(result.ok).toBe(true);
    const sig = await prisma.signature.findFirstOrThrow({ where: { booking: { quoteId: quote.id } } });
    expect(sig.ipAddress).toBeNull();
  });

  describe("payment provider paths", () => {
    const openEvents = (type: string) => prisma.healthEvent.count({ where: { type, resolvedAt: null } });

    it("the provider being unreachable when verifying the capture returns a clear error, writes NOTHING, and raises a System Health incident", async () => {
      const { PaymentProviderError } = await import("@/server/payments/provider");
      const { quote, contact } = await makeQuote();
      const body = input(quote.secureToken);
      healthEvents.resetHealthEventThrottleForTests();
      fake.failNextRetrieve = new PaymentProviderError("provider_unavailable", "network_error");
      const r = await submitBooking(body);
      await flushDeferred();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/couldn't verify your payment method/i);
      expect(await prisma.booking.count({ where: { quoteId: quote.id } })).toBe(0);
      expect(await prisma.paymentMethod.count({ where: { contactId: contact.id } })).toBe(0);
      expect((await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } })).status).toBe("SENT");
      expect(await openEvents("PAYMENT_PROVIDER_ERROR")).toBeGreaterThan(0);
      // The very same form then succeeds on retry (same capture reference).
      const retry = await submitBooking(body);
      await flushDeferred();
      expect(retry.ok).toBe(true);
    });

    it("a capture the customer never completed is refused (the browser's word is never enough)", async () => {
      const { quote } = await makeQuote();
      const { setupIntentId } = await fake.createSetupSession({ customerId: "cus_it", metadata: { quoteId: quote.id, purpose: "booking" }, idempotencyKey: `it-${crypto.randomUUID()}` });
      const body = input(quote.secureToken);
      body.paymentMethods[0].setupIntentId = setupIntentId; // created, never completed
      const r = await submitBooking(body);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/not completed/i);
      expect(await prisma.booking.count({ where: { quoteId: quote.id } })).toBe(0);
    });

    it("a completed capture made for a DIFFERENT quote cannot be used for this booking", async () => {
      const a = await makeQuote();
      const b = await makeQuote();
      const body = input(a.quote.secureToken);
      body.paymentMethods[0].setupIntentId = await capture(b.quote.id);
      const r = await submitBooking(body);
      expect(r.ok).toBe(false);
      expect(await prisma.booking.count({ where: { quoteId: a.quote.id } })).toBe(0);
    });

    it("an unknown / forged capture id is refused without touching the database", async () => {
      const { quote } = await makeQuote();
      const body = input(quote.secureToken);
      body.paymentMethods[0].setupIntentId = "seti_forged_by_a_browser";
      const r = await submitBooking(body);
      expect(r.ok).toBe(false);
      expect(await prisma.booking.count({ where: { quoteId: quote.id } })).toBe(0);
    });

    it("the same capture cannot back two bookings (unique reference)", async () => {
      const a = await makeQuote();
      const first = await submitBooking(input(a.quote.secureToken));
      await flushDeferred();
      expect(first.ok).toBe(true);
      const usedId = (await prisma.paymentMethod.findFirstOrThrow({ where: { booking: { quoteId: a.quote.id } } })).providerSetupIntentId!;
      const b = await makeQuote();
      // Even if its metadata were forged to point at the new quote, the id is already used.
      fake.setups.get(usedId)!.metadata.quoteId = b.quote.id;
      const body = input(b.quote.secureToken);
      body.paymentMethods[0].setupIntentId = usedId;
      const r = await submitBooking(body);
      expect(r.ok).toBe(false);
      expect(await prisma.booking.count({ where: { quoteId: b.quote.id } })).toBe(0);
    });

    it("a concurrent identical submission that loses the race (its read predates the commit) is answered with the ORIGINAL booking, not a 'payment' error", async () => {
      const { quote } = await makeQuote();
      const body = input(quote.secureToken);
      const first = await submitBooking(body);
      await flushDeferred();
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      // The second request read the quote BEFORE the first one committed: it sees no booking...
      const original = prisma.quote.findUnique.bind(prisma.quote);
      const spy = vi.spyOn(prisma.quote, "findUnique").mockImplementationOnce((async (args: never) => {
        const row = await original(args);
        return row ? { ...row, booking: null, status: "SENT" } : row;
      }) as never);
      try {
        // ...and by the time it verifies the capture, that capture is already attached to the winner's booking.
        const second = await submitBooking(body);
        expect(second).toMatchObject({ ok: true, bookingId: first.bookingId, alreadyCompleted: true });
      } finally {
        spy.mockRestore();
      }
      expect(await prisma.booking.count({ where: { quoteId: quote.id } })).toBe(1);
    });

    it("but a DIFFERENT signer presenting the same capture is refused (it is not theirs)", async () => {
      const { quote } = await makeQuote();
      const body = input(quote.secureToken);
      await submitBooking(body);
      await flushDeferred();
      const original = prisma.quote.findUnique.bind(prisma.quote);
      const spy = vi.spyOn(prisma.quote, "findUnique").mockImplementationOnce((async (args: never) => {
        const row = await original(args);
        return row ? { ...row, booking: null, status: "SENT" } : row;
      }) as never);
      try {
        const other = await submitBooking({ ...body, signedName: "Someone Else", contactEmail: "other@example.test" });
        expect(other.ok).toBe(false);
      } finally {
        spy.mockRestore();
      }
      expect(await prisma.booking.count({ where: { quoteId: quote.id } })).toBe(1);
    });

    it("the same capture listed twice in one request is refused", async () => {
      const { quote } = await makeQuote();
      const body = input(quote.secureToken, {}, 570);
      const id = body.paymentMethods[0].setupIntentId;
      const r = await submitBooking({ ...body, paymentMethods: [{ ...body.paymentMethods[0], amount: 285, setupIntentId: id }, { ...body.paymentMethods[0], amount: 285, setupIntentId: id }] });
      expect(r.ok).toBe(false);
      expect(await prisma.booking.count({ where: { quoteId: quote.id } })).toBe(0);
    });

    it("no payment provider configured: refuses cleanly, records nothing, raises a critical incident", async () => {
      const { quote } = await makeQuote();
      const body = input(quote.secureToken);
      healthEvents.resetHealthEventThrottleForTests();
      setProvider(null);
      try {
        const r = await submitBooking(body);
        await flushDeferred();
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/temporarily unavailable/i);
        expect(await prisma.booking.count({ where: { quoteId: quote.id } })).toBe(0);
        expect(await openEvents("BOOKING_PAYMENT_UNAVAILABLE")).toBeGreaterThan(0);
      } finally {
        setProvider(fake);
      }
    });

    it("split payment across two vaulted cards stores both, each with its own allocation", async () => {
      const { quote } = await makeQuote();
      const body = input(quote.secureToken);
      const second = await capture(quote.id, "1881");
      const r = await submitBooking({ ...body, paymentMethods: [{ ...body.paymentMethods[0], amount: 400 }, { setupIntentId: second, cardholderName: "Jane Traveler", amount: 170 }] });
      await flushDeferred();
      expect(r.ok).toBe(true);
      const pms = await prisma.paymentMethod.findMany({ where: { booking: { quoteId: quote.id } }, orderBy: { amountAllocated: "desc" } });
      expect(pms.map((p) => [p.last4, Number(p.amountAllocated)])).toEqual([["4242", 400], ["1881", 170]]);
      expect(pms.every((p) => p.vaultStatus === "VAULTED" && p.encryptedPan === null)).toBe(true);
    });

    it("a booking is never a payment: no charge is created and the provider is never asked to charge", async () => {
      const { quote } = await makeQuote();
      fake.calls.length = 0;
      const r = await submitBooking(input(quote.secureToken));
      await flushDeferred();
      expect(r.ok).toBe(true);
      expect(fake.calls.some((c) => c.op === "charge")).toBe(false);
      expect(await prisma.paymentCharge.count({ where: { paymentMethod: { booking: { quoteId: quote.id } } } })).toBe(0);
    });
  });

  it("keeps a non-USD quote's customer-facing total in its own currency and the internal ledger in USD", async () => {
    const { quote } = await makeQuote("AUD", 1.5);
    // 570 USD * 1.5 = 855 AUD is what the customer is charged.
    const result = await submitBooking(input(quote.secureToken, {}, 855));
    expect(result.ok).toBe(true);
    const booking = await prisma.booking.findUniqueOrThrow({ where: { quoteId: quote.id } });
    expect(Number(booking.totalAmount)).toBe(855);
    expect(Number(booking.fareAmount)).toBe(500); // internal cost stays USD
    expect(Number((await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } })).total)).toBe(570);
  });

  it("IDEMPOTENT REPLAY: the same signer submitting again gets the ORIGINAL booking — never a second one", async () => {
    const { quote } = await makeQuote();
    const first = await submitBooking(input(quote.secureToken));
    const second = await submitBooking(input(quote.secureToken));
    await flushDeferred();
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.bookingId).toBe(first.bookingId);
      expect(second.bookingReference).toBe(first.bookingReference);
      expect(second.alreadyCompleted).toBe(true);
    }
    expect(await prisma.booking.count({ where: { quoteId: quote.id } })).toBe(1);
    expect(await prisma.paymentMethod.count({ where: { booking: { quoteId: quote.id } } })).toBe(1);
    expect(sendStaffEmail).toHaveBeenCalledTimes(1);
  });

  it("someone ELSE holding the link cannot replay or overwrite a completed booking", async () => {
    const { quote } = await makeQuote();
    await submitBooking(input(quote.secureToken));
    const other = await submitBooking(input(quote.secureToken, { signedName: "Someone Else", contactEmail: "other@example.test" }));
    expect(other.ok).toBe(false);
    expect(await prisma.booking.count({ where: { quoteId: quote.id } })).toBe(1);
    expect((await prisma.signature.findFirstOrThrow({ where: { booking: { quoteId: quote.id } } })).signedName).toBe("Jane Traveler");
  });

  it("CONCURRENT DOUBLE-SUBMIT: 8 identical simultaneous requests yield exactly ONE booking, ONE signature, ONE payment method — and every caller sees success", async () => {
    const { quote } = await makeQuote();
    const results = await Promise.all(Array.from({ length: 8 }, () => submitBooking(input(quote.secureToken))));
    await flushDeferred();

    expect(results.every((r) => r.ok)).toBe(true);
    const ids = new Set(results.map((r) => (r.ok ? r.bookingId : "")));
    expect(ids.size).toBe(1);
    expect(await prisma.booking.count({ where: { quoteId: quote.id } })).toBe(1);
    expect(await prisma.signature.count({ where: { booking: { quoteId: quote.id } } })).toBe(1);
    expect(await prisma.paymentMethod.count({ where: { booking: { quoteId: quote.id } } })).toBe(1);
    expect(await prisma.quoteStatusHistory.count({ where: { quoteId: quote.id, toStatus: "SIGNED" } })).toBe(1);
    expect(await prisma.leadStatusHistory.count({ where: { leadId: quote.leadId, toStatus: "BOOKED" } })).toBe(1);
    // Exactly one logical completion => exactly one staff notification.
    expect(sendStaffEmail).toHaveBeenCalledTimes(1);
  });

  it("CONCURRENT RACE between different signers: exactly one wins, no duplicate booking", async () => {
    const { quote } = await makeQuote();
    const results = await Promise.all([
      submitBooking(input(quote.secureToken)),
      submitBooking(input(quote.secureToken, { signedName: "Other Person", contactEmail: "other@example.test" })),
      submitBooking(input(quote.secureToken, { signedName: "Third Person", contactEmail: "third@example.test" })),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.booking.count({ where: { quoteId: quote.id } })).toBe(1);
  });

  it("ATOMICITY: a fault after the quote was claimed rolls EVERYTHING back — no booking, no payment method, quote still SENT, lead unchanged", async () => {
    const first = await makeQuote();
    forcedReference = "COLLIDE1";
    // Occupy the reference on a DIFFERENT quote so this quote's booking insert
    // fails on a unique constraint mid-transaction (after quote.updateMany).
    const other = await makeQuote();
    await prisma.booking.create({
      data: {
        quoteId: other.quote.id, leadId: other.lead.id, contactId: other.contact.id, bookingReference: "BFT-COLLIDE1",
        contactPhone: "1", contactEmail: "x@example.test", billingAddress: "a", billingCity: "b", billingState: "c", billingZip: "d", billingCountry: "US",
      },
    });

    const result = await submitBooking(input(first.quote.secureToken));

    expect(result.ok).toBe(false);
    expect(await prisma.booking.count({ where: { quoteId: first.quote.id } })).toBe(0);
    expect(await prisma.paymentMethod.count({ where: { contactId: first.contact.id } })).toBe(0);
    expect(await prisma.passenger.count({ where: { booking: { quoteId: first.quote.id } } })).toBe(0);
    const q = await prisma.quote.findUniqueOrThrow({ where: { id: first.quote.id } });
    expect(q.status).toBe("SENT"); // the claim was rolled back too
    expect(q.signedAt).toBeNull();
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: first.lead.id } })).status).toBe("QUOTED");
    expect(await prisma.quoteStatusHistory.count({ where: { quoteId: first.quote.id } })).toBe(0);
    expect(sendStaffEmail).not.toHaveBeenCalled();
  });

  it("ATOMICITY (the original production hazard): the payment-method write fails AFTER the booking row exists — nothing may be left behind, and a clean retry with a good card then succeeds", async () => {
    const { quote, lead, contact } = await makeQuote();
    const bad = input(quote.secureToken);
    bad.paymentMethods[0].setupIntentId = await capture(quote.id, "0000");

    const failed = await submitBooking(bad);
    await flushDeferred();

    expect(failed.ok).toBe(false);
    // Before the fix, submitBooking created the Booking FIRST and each card
    // separately afterward, so this left an orphan Booking with no payment
    // method and a quote still not SIGNED — the customer's retry then hit
    // "already been booked" and the booking page redirected to a
    // "confirmation" for a booking that was never completed.
    expect(await prisma.booking.count({ where: { quoteId: quote.id } })).toBe(0);
    expect(await prisma.passenger.count({ where: { booking: { quoteId: quote.id } } })).toBe(0);
    expect(await prisma.signature.count({ where: { booking: { quoteId: quote.id } } })).toBe(0);
    expect(await prisma.paymentMethod.count({ where: { contactId: contact.id } })).toBe(0);
    expect((await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } })).status).toBe("SENT");
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe("QUOTED");
    expect(sendStaffEmail).not.toHaveBeenCalled();

    // The customer simply tries again (same link, corrected card).
    const retry = await submitBooking(input(quote.secureToken));
    await flushDeferred();
    expect(retry.ok).toBe(true);
    expect(await prisma.booking.count({ where: { quoteId: quote.id } })).toBe(1);
    expect((await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } })).status).toBe("SIGNED");
  });

  it("A FAILED OPTIONAL EMAIL never fails or rolls back a committed booking", async () => {
    sendStaffEmail.mockImplementation(async () => {
      throw new Error("gmail api down");
    });
    const { quote } = await makeQuote();
    const result = await submitBooking(input(quote.secureToken));
    expect(result.ok).toBe(true);
    expect(await prisma.booking.count({ where: { quoteId: quote.id } })).toBe(1);
    expect((await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } })).status).toBe("SIGNED");
  });

  it("returns a structured error (not a thrown exception) for malformed input, and writes nothing", async () => {
    const { quote } = await makeQuote();
    const result = await submitBooking(input(quote.secureToken, { contactEmail: "not-an-email" }));
    expect(result.ok).toBe(false);
    expect(await prisma.booking.count({ where: { quoteId: quote.id } })).toBe(0);
  });

  it("refuses a payment allocation that does not equal the server-computed total, and writes nothing", async () => {
    const { quote } = await makeQuote();
    const result = await submitBooking(input(quote.secureToken, {}, 1)); // total is 570
    expect(result.ok).toBe(false);
    expect(await prisma.booking.count({ where: { quoteId: quote.id } })).toBe(0);
    expect((await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } })).status).toBe("SENT");
  });

  it("refuses to book a quote that is no longer SENT/READ/VIEWED (e.g. cancelled)", async () => {
    const { quote } = await makeQuote();
    await prisma.quote.update({ where: { id: quote.id }, data: { status: "CANCELED" } });
    const result = await submitBooking(input(quote.secureToken));
    expect(result.ok).toBe(false);
    expect(await prisma.booking.count({ where: { quoteId: quote.id } })).toBe(0);
  });
});
