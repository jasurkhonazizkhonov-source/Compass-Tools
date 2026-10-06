// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

// REAL-DATABASE proof of the temporary, encrypted, Admin-only security-code (CVV/CVC) retention:
//   Booking Form signed → encrypted record (PaymentMethodCvv) → Admin reveal during the 24-hour window → destroyed on a recorded
//   successful payment / cancellation / explicit Admin destroy / expiry → never recoverable afterwards.
// Only SYNTHETIC values are used (documented test card numbers; marker codes that are not real). Runs only when
// INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL with this repo's migrations applied.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
  process.env.TRUSTED_PROXY = "vercel";
  // The suite runs as a production-class environment (so the recent-sign-in step-up is enforced); the card vault opens there only with this explicit owner setting.
  process.env.CARD_VAULT_MODE = "application-encryption-risk-accepted";
  process.env.CARD_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_HASH_KEY ??= randomBytes(32).toString("base64");
}

type Role = "ADMIN" | "MANAGER" | "TRAVEL_AGENT" | "TICKETING_AGENT" | "FLIGHT_EXPERT" | "MARKETING_AGENT";
type Actor = { id: string; role: Role; status: string; companyId: string; fullName: string; email: string; phone: string | null; paymentPermissions: string[]; bookingPermissions: string[]; sessionCreatedAt: Date | null };

let requestHeaders: Map<string, string>;
let currentActor: Actor | null = null;
vi.mock("next/headers", () => ({ headers: vi.fn(async () => requestHeaders) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), isProductionEnvironment: () => true }));
const deferred: Promise<unknown>[] = [];
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (task: () => Promise<void>) => void deferred.push(task()) }));
const flushDeferred = async () => {
  while (deferred.length) await Promise.allSettled(deferred.splice(0));
};
vi.mock("@/server/booking-notification", () => ({ sendBookingSignedNotification: vi.fn(async () => {}) }));
vi.mock("nanoid", () => ({ customAlphabet: () => () => Math.random().toString(36).slice(2, 9).toUpperCase().padEnd(7, "X") }));

const TAG = `cvv-${Date.now()}`;
const VISA = "4111111111111111";
const AMEX = "378282246310005";
const CODE = "482"; // synthetic 3-digit code
const AMEX_CODE = "7391"; // synthetic 4-digit code (only valid for Amex)
const HOUR = 3_600_000;

describe.skipIf(!enabled)("temporary encrypted CVV/CVC retention — real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let submitBooking: typeof import("../booking").submitBooking;
  let actions: typeof import("../booking-cvv");
  let payments: typeof import("../payment-methods");
  let cleanup: typeof import("@/server/security/booking-cvv");
  let enc: typeof import("@/server/security/card-encryption");
  const contactIds: string[] = [];
  const accountIds: string[] = [];
  const companyB = `co-b-${TAG}`;
  let seq = 0;
  const actors: Record<string, Actor> = {};

  async function makeActor(name: string, role: Role, opts: { grant?: boolean; company?: string; status?: string; ageMs?: number } = {}) {
    const company = opts.company ?? "default-company";
    const a = await prisma.account.create({ data: { fullName: name, email: `${name.toLowerCase()}-${TAG}@example.test`, role, status: (opts.status as "ACTIVE") ?? "ACTIVE", companyId: company } });
    accountIds.push(a.id);
    actors[name] = {
      id: a.id,
      role,
      status: opts.status ?? "ACTIVE",
      companyId: company,
      fullName: name,
      email: a.email,
      phone: null,
      paymentPermissions: opts.grant === false ? [] : ["payments.reveal", "payments.charge"],
      bookingPermissions: [],
      sessionCreatedAt: new Date(Date.now() - (opts.ageMs ?? 60_000)),
    };
    return actors[name];
  }
  const as = (name: string | null) => {
    currentActor = name ? actors[name] : null;
  };

  let ipSeq = 0;
  const ipBlock = 1 + Math.floor(Math.random() * 250);
  beforeEach(async () => {
    await flushDeferred();
    requestHeaders = new Map([
      ["x-forwarded-for", `198.51.${ipBlock}.${(++ipSeq % 250) + 1}`],
      ["user-agent", "IntegrationTest/1.0"],
    ]);
    as(null);
  });

  async function makeQuote(company = "default-company") {
    const n = ++seq;
    const contact = await prisma.contact.create({ data: { firstName: "Jane", lastName: `Cvv${n}`, primaryEmail: `jane${n}-${TAG}@example.test`, companyId: company } });
    contactIds.push(contact.id);
    const lead = await prisma.lead.create({ data: { contactId: contact.id, status: "QUOTED", source: "OTHER" } });
    const quote = await prisma.quote.create({
      data: { quoteNumber: `Q-${TAG}-${n}`, secureToken: `tok-${TAG}-${n}`, leadId: lead.id, contactId: contact.id, status: "SENT", adults: 1, adultPrice: 500, taxes: 50, serviceFee: 20, total: 570 },
    });
    return { contact, lead, quote };
  }
  const input = (token: string, card: Record<string, unknown> = {}) => ({
    token,
    passengers: [{ type: "ADULT" as const, firstName: "Jane", lastName: "Traveler", dateOfBirth: "1990-01-01", gender: "FEMALE" }],
    contactPhone: "+12125550100",
    contactEmail: "jane@example.test",
    billingAddress: "123 Main St",
    billingCity: "Springfield",
    billingState: "IL",
    billingZip: "62704",
    billingCountry: "US",
    paymentMethods: [{ cardholderName: "Jane Traveler", cardNumber: VISA, expiryMonth: 12, expiryYear: new Date().getUTCFullYear() + 3, amount: 570, ...card }],
    paymentConsent: true as const,
    gratuityAmount: 0,
    termsAccepted: true as const,
    signedName: "Jane Traveler",
  });

  /** A signed booking with one card and a retained CVV; returns the ids the Admin needs. */
  async function signedBooking(opts: { company?: string; card?: Record<string, unknown> } = {}) {
    const { quote, lead, contact } = await makeQuote(opts.company);
    const result = await submitBooking(input(quote.secureToken, { cvv: CODE, ...opts.card }) as never);
    await flushDeferred();
    if (!result.ok) throw new Error("booking setup failed");
    const booking = await prisma.booking.findUniqueOrThrow({ where: { quoteId: quote.id }, include: { paymentMethods: true } });
    return { bookingId: booking.id, pmId: booking.paymentMethods[0].id, quote, lead, contact };
  }
  const cvvRow = (pmId: string) => prisma.$queryRaw<{ encryptedCvv: string | null; signedAt: Date; expiresAt: Date; destroyedAt: Date | null; destroyedReason: string | null }[]>`SELECT "encryptedCvv","signedAt","expiresAt","destroyedAt","destroyedReason" FROM "PaymentMethodCvv" WHERE "paymentMethodId" = ${pmId}`;
  const audits = (pmId: string, action: string) => prisma.auditLog.findMany({ where: { entityId: pmId, action } });

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ submitBooking } = await import("../booking"));
    actions = await import("../booking-cvv");
    payments = await import("../payment-methods");
    cleanup = await import("@/server/security/booking-cvv");
    enc = await import("@/server/security/card-encryption");
    await prisma.company.upsert({ where: { id: "default-company" }, update: {}, create: { id: "default-company", name: "Test Co", signatureTemplate: "Regards" } });
    await prisma.company.create({ data: { id: companyB, name: "Other Co", signatureTemplate: "Regards" } });
    // one Admin per group below so the (strict) per-account rate limit is never shared
    for (const n of ["AdminMain", "AdminIso", "AdminCompany", "AdminLifecycle", "AdminExpiry", "AdminRate", "AdminStale", "AdminAudit", "AdminDestroy"]) await makeActor(n, "ADMIN");
    await makeActor("AdminNoGrant", "ADMIN", { grant: false });
    await makeActor("AdminInactive", "ADMIN", { status: "INACTIVE" });
    await makeActor("AdminOtherCompany", "ADMIN", { company: companyB });
    await makeActor("Manager", "MANAGER");
    await makeActor("Ticketing", "TICKETING_AGENT");
    await makeActor("Agent", "TRAVEL_AGENT");
    await makeActor("Expert", "FLIGHT_EXPERT");
    await makeActor("Marketing", "MARKETING_AGENT");
  });

  afterAll(async () => {
    if (!enabled) return;
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } }).catch(() => undefined); // audit rows keep their (nulled) actor
    await prisma.company.deleteMany({ where: { id: companyB } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("capture at signing", () => {
    it("the code submitted with a SIGNED Booking Form is kept ONLY as an encrypted record, bound to that card, expiring exactly 24 hours after the signing instant", async () => {
      const { quote, bookingId, pmId } = await signedBooking();
      const [row] = await cvvRow(pmId);
      expect(row.encryptedCvv).toMatch(/^cv2\.[A-Za-z0-9]{1,12}\.[A-Za-z0-9_-]{20,}$/);
      expect(row.encryptedCvv).not.toContain(CODE);
      // the 24-hour clock starts at THE signing instant (the one stored as the quote's signedAt and the booking's termsAcceptedAt)
      const q = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } });
      const b = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
      expect(row.signedAt.getTime()).toBe(q.signedAt!.getTime());
      expect(row.signedAt.getTime()).toBe(b.termsAcceptedAt!.getTime());
      expect(row.expiresAt.getTime() - row.signedAt.getTime()).toBe(24 * HOUR);
      expect(row.destroyedAt).toBeNull();
      // decrypts only through the CVV path, only for THIS card
      expect(enc.decryptCvv(row.encryptedCvv!, pmId)).toBe(CODE);
      expect(() => enc.decryptCvv(row.encryptedCvv!, "some-other-card")).toThrow();
      // the CVV envelope is not a card number and a card-number envelope is not a CVV
      expect(() => enc.decryptPan(row.encryptedCvv!, pmId)).toThrow();
      const pan = (await prisma.paymentMethod.findUniqueOrThrow({ where: { id: pmId }, select: { encryptedPan: true } })).encryptedPan;
      expect(() => enc.decryptCvv(pan, pmId)).toThrow();
    });

    it("a 4-digit American Express code is retained the same way, and the plaintext appears in NO table of the database", async () => {
      const MARK = AMEX_CODE;
      const { pmId } = await signedBooking({ card: { cardNumber: AMEX, cvv: MARK } });
      const [row] = await cvvRow(pmId);
      expect(enc.decryptCvv(row.encryptedCvv!, pmId)).toBe(MARK);
      const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
      const REFERENCE_TABLES = new Set(["Airport", "Airline", "AircraftType"]);
      const hits: string[] = [];
      for (const { table_name } of tables) {
        if (REFERENCE_TABLES.has(table_name)) continue;
        const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${table_name}" t WHERE t::text ~ '(^|[^0-9A-Za-z.])${MARK}([^0-9A-Za-z.]|$)'`);
        if (rows[0].n > 0) hits.push(table_name);
      }
      expect(hits).toEqual([]);
    });

    it("no code submitted → nothing retained; a malformed code → refused and NO booking, NO record", async () => {
      const { quote } = await makeQuote();
      const ok = await submitBooking(input(quote.secureToken) as never);
      await flushDeferred();
      expect(ok.ok).toBe(true);
      const booking = await prisma.booking.findUniqueOrThrow({ where: { quoteId: quote.id }, include: { paymentMethods: true } });
      expect(await cvvRow(booking.paymentMethods[0].id)).toHaveLength(0);

      const { quote: q2 } = await makeQuote();
      const bad = await submitBooking(input(q2.secureToken, { cvv: "12" }) as never);
      expect(bad).toEqual({ ok: false, error: "Payment information could not be processed" });
      expect(await prisma.booking.count({ where: { quoteId: q2.id } })).toBe(0);
      expect(await prisma.paymentMethodCvv.count({ where: { paymentMethod: { booking: { quoteId: q2.id } } } })).toBe(0);
    });

    it("the PaymentMethod table has no security-code column, ordinary reads never return the ciphertext, and Booking/Quote/Contact/Lead reads carry no code", async () => {
      const { bookingId, pmId, quote, contact, lead } = await signedBooking();
      const cols = await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'PaymentMethod'`;
      expect(cols.map((c) => c.column_name).join(",")).not.toMatch(/cvv|cvc|security|cid/i);
      const [row] = await cvvRow(pmId);
      const ciphertext = row.encryptedCvv!;

      const reads = [
        await prisma.paymentMethod.findUniqueOrThrow({ where: { id: pmId }, include: { retainedSecurityCode: true } }),
        await prisma.paymentMethodCvv.findMany(),
        await prisma.paymentMethodCvv.findUnique({ where: { paymentMethodId: pmId } }),
        await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { paymentMethods: { include: { retainedSecurityCode: true } }, passengers: true, signature: true, statusHistory: true } }),
        await prisma.quote.findUniqueOrThrow({ where: { id: quote.id }, include: { booking: true } }),
        await prisma.contact.findUniqueOrThrow({ where: { id: contact.id }, include: { paymentMethods: true } }),
        await prisma.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { quotes: true } }),
      ];
      for (const r of reads) {
        const text = JSON.stringify(r);
        expect(text).not.toContain(ciphertext);
        expect(text).not.toContain("encryptedCvv");
        expect(text).not.toContain(`"${CODE}"`);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("Admin-only reveal", () => {
    it("an Admin with the payments.reveal grant reveals exactly that card's code; it is audited without the value; the expiry does not move", async () => {
      const { bookingId, pmId } = await signedBooking();
      const [before] = await cvvRow(pmId);
      as("AdminMain");
      expect(await actions.revealBookingCvv(bookingId, pmId)).toEqual({ cvv: CODE });
      expect(await actions.revealBookingCvv(bookingId, pmId)).toEqual({ cvv: CODE }); // repeatable inside the window
      const [after] = await cvvRow(pmId);
      expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
      expect(after.signedAt.getTime()).toBe(before.signedAt.getTime());
      expect(after.encryptedCvv).toBe(before.encryptedCvv); // revealing destroys nothing
      const rows = await audits(pmId, "CVV_REVEALED");
      expect(rows).toHaveLength(2);
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(CODE);
      expect(dump).not.toContain(before.encryptedCvv!);
      expect(rows[0].metadata).toMatchObject({ bookingId, result: "SUCCESS" });
    });

    it("EVERY other role is refused — even holding the card-reveal grant — plus no session, an inactive Admin, an Admin without the grant, and another company's Admin", async () => {
      const { bookingId, pmId } = await signedBooking();
      for (const who of ["Manager", "Ticketing", "Agent", "Expert", "Marketing", "AdminNoGrant", "AdminInactive", "AdminOtherCompany", null]) {
        as(who);
        await expect(actions.revealBookingCvv(bookingId, pmId), String(who)).rejects.toThrow("not authorized");
      }
      const denied = await audits(pmId, "CVV_REVEAL_DENIED");
      expect(denied.length).toBeGreaterThanOrEqual(8);
      expect(JSON.stringify(denied)).not.toContain(CODE);
      expect(denied.map((d) => (d.metadata as { reason: string }).reason)).toEqual(expect.arrayContaining(["NOT_ADMIN", "MISSING_PERMISSION", "BOOKING_NOT_ACCESSIBLE", "NO_ACTIVE_SESSION"]));
    });

    it("isolation: another booking's card, a contact id, a lead id or a forged id never reveals this code", async () => {
      const a = await signedBooking();
      const b = await signedBooking({ card: { cvv: "913" } });
      as("AdminIso"); // every attempt that reaches the rate limiter counts, so this group has its own Admin
      expect(await actions.revealBookingCvv(b.bookingId, b.pmId)).toEqual({ cvv: "913" });
      await expect(actions.revealBookingCvv(a.bookingId, b.pmId)).rejects.toThrow("not authorized"); // booking A with card B
      await expect(actions.revealBookingCvv(b.bookingId, a.pmId)).rejects.toThrow("not authorized"); // booking B with card A
      await expect(actions.revealBookingCvv(a.contact.id, a.pmId)).rejects.toThrow("not authorized"); // contact id as a booking id
      await expect(actions.revealBookingCvv(a.lead.id, a.pmId)).rejects.toThrow("not authorized"); // lead id as a booking id
      await expect(actions.revealBookingCvv(a.bookingId, a.contact.id)).rejects.toThrow("not authorized"); // contact id as a card id
      await expect(actions.revealBookingCvv("nope", "nope")).rejects.toThrow("not authorized");
      await expect(actions.revealBookingCvv(a.bookingId, "")).rejects.toThrow("not authorized");
      expect(await actions.revealBookingCvv(a.bookingId, a.pmId)).toEqual({ cvv: CODE });
    });

    it("an Admin of ANOTHER company cannot reveal this company's code, and this company's Admin cannot reveal theirs", async () => {
      const mine = await signedBooking();
      const theirs = await signedBooking({ company: companyB, card: { cvv: "644" } });
      as("AdminOtherCompany");
      expect(await actions.revealBookingCvv(theirs.bookingId, theirs.pmId)).toEqual({ cvv: "644" });
      await expect(actions.revealBookingCvv(mine.bookingId, mine.pmId)).rejects.toThrow("not authorized");
      as("AdminCompany");
      await expect(actions.revealBookingCvv(theirs.bookingId, theirs.pmId)).rejects.toThrow("not authorized");
    });

    it("recent sign-in is required: an Admin whose sign-in is older than 15 minutes gets a returned message and nothing is revealed", async () => {
      const { bookingId, pmId } = await signedBooking();
      const stale = await makeActor("AdminStaleNow", "ADMIN", { ageMs: 16 * 60_000 });
      as("AdminStaleNow");
      const r = await actions.revealBookingCvv(bookingId, pmId);
      expect(r).toEqual({ error: expect.stringMatching(/sign-in within the last 15 minutes/) });
      expect(JSON.stringify(r)).not.toContain(CODE);
      expect((await audits(pmId, "CVV_REVEAL_DENIED")).some((d) => (d.metadata as { reason: string }).reason === "RECENT_LOGIN_REQUIRED")).toBe(true);
      void stale;
    });

    it("the rate limit is server-side and dedicated: the 11th attempt in the window is refused BEFORE any decryption, and is audited", async () => {
      const { bookingId, pmId } = await signedBooking();
      as("AdminRate");
      for (let i = 0; i < 10; i++) expect(await actions.revealBookingCvv(bookingId, pmId)).toEqual({ cvv: CODE });
      const limited = await actions.revealBookingCvv(bookingId, pmId);
      expect(limited).toEqual({ error: expect.stringMatching(/Too many attempts/) });
      expect(JSON.stringify(limited)).not.toContain(CODE);
      expect(await audits(pmId, "CVV_REVEAL_RATE_LIMITED")).toHaveLength(1);
      // a different booking does not get a fresh budget (the key is the account, not the booking id)
      const other = await signedBooking();
      expect(await actions.revealBookingCvv(other.bookingId, other.pmId)).toEqual({ error: expect.stringMatching(/Too many attempts/) });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("the 24-hour limit", () => {
    const setWindow = (pmId: string, signedAgoMs: number) => {
      const signedAt = new Date(Date.now() - signedAgoMs);
      return prisma.$executeRaw`UPDATE "PaymentMethodCvv" SET "signedAt" = ${signedAt}, "expiresAt" = ${new Date(signedAt.getTime() + 24 * HOUR)} WHERE "paymentMethodId" = ${pmId}`;
    };

    it("works just before expiry; at and after expiry the reveal is refused with the retention message and the stale record is destroyed on the spot", async () => {
      as("AdminExpiry");
      const early = await signedBooking();
      await setWindow(early.pmId, 24 * HOUR - 60_000); // one minute left
      expect(await actions.revealBookingCvv(early.bookingId, early.pmId)).toEqual({ cvv: CODE });

      const atEdge = await signedBooking();
      await setWindow(atEdge.pmId, 24 * HOUR); // expiresAt == now (already due)
      const r1 = await actions.revealBookingCvv(atEdge.bookingId, atEdge.pmId);
      expect(r1).toEqual({ error: "CVV/CVC is no longer available because the 24-hour retention period has expired." });
      expect(await cvvRow(atEdge.pmId)).toHaveLength(0); // destroyed at reveal time — the cron is not needed

      const late = await signedBooking();
      await setWindow(late.pmId, 30 * HOUR);
      expect(await actions.revealBookingCvv(late.bookingId, late.pmId)).toEqual({ error: expect.stringMatching(/24-hour retention period has expired/) });
      expect(JSON.stringify([r1])).not.toContain(CODE);
    });

    it("nothing can extend it: the database refuses any expiry other than signedAt + 24 h, and a Booking edit, a failed payment and repeated reveals leave it untouched", async () => {
      const { bookingId, pmId } = await signedBooking();
      const [before] = await cvvRow(pmId);
      await expect(prisma.$executeRaw`UPDATE "PaymentMethodCvv" SET "expiresAt" = "expiresAt" + INTERVAL '1 hour' WHERE "paymentMethodId" = ${pmId}`).rejects.toThrow();
      await expect(prisma.$executeRaw`UPDATE "PaymentMethodCvv" SET "encryptedCvv" = 'plain-482' WHERE "paymentMethodId" = ${pmId}`).rejects.toThrow(); // plaintext refused by the database
      await expect(prisma.$executeRaw`UPDATE "PaymentMethodCvv" SET "encryptedCvv" = '482' WHERE "paymentMethodId" = ${pmId}`).rejects.toThrow();

      // edit the booking (what ticketing does), record a FAILED charge, reveal repeatedly
      await prisma.booking.update({ where: { id: bookingId }, data: { internalNotes: "edited later" } });
      as("AdminMain");
      await payments.confirmPaymentReceived({ bookingId, paymentMethodId: pmId, amount: 570, status: "FAILED" });
      await actions.revealBookingCvv(bookingId, pmId);
      const [after] = await cvvRow(pmId);
      expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
      expect(after.encryptedCvv).toBe(before.encryptedCvv); // a retryable failure keeps it
      expect(after.destroyedAt).toBeNull();
    });

    it("the daily cleanup destroys expired records only, is idempotent, and leaves active records and the card data alone", async () => {
      const expired = await signedBooking();
      const active = await signedBooking();
      await setWindow(expired.pmId, 25 * HOUR);
      const first = await cleanup.destroyExpiredCvvs();
      expect(first.deleted).toBeGreaterThanOrEqual(1);
      expect(await cvvRow(expired.pmId)).toHaveLength(0);
      expect(await cvvRow(active.pmId)).toHaveLength(1);
      expect((await cvvRow(active.pmId))[0].encryptedCvv).not.toBeNull();
      // the card itself is untouched
      const pm = await prisma.paymentMethod.findUnique({ where: { id: expired.pmId }, select: { id: true, last4: true, status: true } });
      expect(pm).toMatchObject({ last4: "1111", status: "ACTIVE" });
      expect((await cleanup.destroyExpiredCvvs()).deleted).toBe(0); // idempotent
      expect((await cleanup.destroyExpiredCvvs()).deleted).toBe(0);
      expect(await cvvRow(active.pmId)).toHaveLength(1);
    });

    it("the daily cron endpoint runs the cleanup", async () => {
      const { pmId } = await signedBooking();
      await setWindow(pmId, 26 * HOUR);
      const { GET } = await import("@/app/api/cron/tasks/route");
      const { NextRequest } = await import("next/server");
      // production-class run: the cron is authenticated, exactly as in the real deployment
      process.env.CRON_SECRET = "integration-test-cron-secret-not-a-real-one";
      const res = await GET(new NextRequest("http://localhost/api/cron/tasks", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
      delete process.env.CRON_SECRET;
      const body = await res.json();
      expect(body.cvvRecordsDestroyed).toBeGreaterThanOrEqual(1);
      expect(await cvvRow(pmId)).toHaveLength(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("lifecycle: when the payment is recorded", () => {
    it("a SUCCESSFUL payment destroys the code at once; it can never be revealed again", async () => {
      const { bookingId, pmId } = await signedBooking();
      as("AdminLifecycle");
      expect(await actions.revealBookingCvv(bookingId, pmId)).toEqual({ cvv: CODE });
      await payments.confirmPaymentReceived({ bookingId, paymentMethodId: pmId, amount: 570, status: "SUCCEEDED" });
      const [row] = await cvvRow(pmId);
      expect(row.encryptedCvv).toBeNull();
      expect(row.destroyedAt).not.toBeNull();
      expect(row.destroyedReason).toBe("PAYMENT_CONFIRMED");
      expect(await actions.revealBookingCvv(bookingId, pmId)).toEqual({ error: "CVV/CVC is no longer available." });
      expect(await audits(pmId, "CVV_DESTROYED")).toHaveLength(1);
    });

    it("workflow CONFIRMED and CANCELLED are terminal and destroy it; AUTHORIZED (an attempt) and FAILED (retryable) do not", async () => {
      const mk = async () => signedBooking();
      const confirmed = await mk();
      const cancelled = await mk();
      const authorized = await mk();
      const failed = await mk();
      as("AdminLifecycle");
      const set = (b: { bookingId: string; pmId: string }, workflowStatus: "CONFIRMED" | "CANCELLED" | "AUTHORIZED" | "FAILED") => payments.updatePaymentMethodWorkflowStatus({ bookingId: b.bookingId, paymentMethodId: b.pmId, workflowStatus });
      await set(confirmed, "CONFIRMED");
      await set(cancelled, "CANCELLED");
      await set(authorized, "AUTHORIZED");
      await set(failed, "FAILED");
      expect((await cvvRow(confirmed.pmId))[0]).toMatchObject({ encryptedCvv: null, destroyedReason: "PAYMENT_CONFIRMED" });
      expect((await cvvRow(cancelled.pmId))[0]).toMatchObject({ encryptedCvv: null, destroyedReason: "PAYMENT_CANCELLED" });
      expect((await cvvRow(authorized.pmId))[0].encryptedCvv).not.toBeNull();
      expect((await cvvRow(failed.pmId))[0].encryptedCvv).not.toBeNull();
      // …and the 24-hour deadline of the survivors is exactly what it was
      expect((await cvvRow(failed.pmId))[0].expiresAt.getTime() - (await cvvRow(failed.pmId))[0].signedAt.getTime()).toBe(24 * HOUR);
    });

    it("explicit Admin destruction removes it for good, is audited, is idempotent, and is refused to everyone else", async () => {
      const { bookingId, pmId } = await signedBooking();
      for (const who of ["Manager", "Ticketing", "Agent", "AdminNoGrant", "AdminOtherCompany", null]) {
        as(who);
        await expect(actions.destroyBookingCvv(bookingId, pmId), String(who)).rejects.toThrow("not authorized");
      }
      expect((await cvvRow(pmId))[0].encryptedCvv).not.toBeNull(); // nothing happened
      as("AdminDestroy");
      expect(await actions.destroyBookingCvv(bookingId, pmId)).toEqual({ destroyed: true });
      expect(await actions.destroyBookingCvv(bookingId, pmId)).toEqual({ destroyed: true }); // idempotent
      const [row] = await cvvRow(pmId);
      expect(row).toMatchObject({ encryptedCvv: null, destroyedReason: "ADMIN_DESTROYED" });
      expect(await actions.revealBookingCvv(bookingId, pmId)).toEqual({ error: "CVV/CVC is no longer available." });
      const rows = await audits(pmId, "CVV_DESTROYED");
      expect(rows).toHaveLength(1); // the second call had nothing left to destroy
      expect(JSON.stringify(rows)).not.toContain(CODE);
    });

    it("removing the card destroys its code too", async () => {
      const { bookingId, pmId } = await signedBooking();
      const { removePaymentMethod } = await import("../contact-payment-methods");
      as("AdminLifecycle");
      await removePaymentMethod(pmId);
      expect((await cvvRow(pmId))[0]).toMatchObject({ encryptedCvv: null, destroyedReason: "CARD_REMOVED" });
      expect(await actions.revealBookingCvv(bookingId, pmId)).toEqual({ error: "CVV/CVC is no longer available." });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("nothing else changed and nothing leaks", () => {
    it("the existing Reveal Card Information still works exactly as before, and returns no security code", async () => {
      const { pmId } = await signedBooking();
      as("AdminMain");
      const revealed = await payments.revealPaymentMethod(pmId);
      expect(revealed).toMatchObject({ pan: VISA, cardholderName: "Jane Traveler" });
      expect(Object.keys(revealed).sort()).toEqual(["cardBrand", "cardholderName", "expiryMonth", "expiryYear", "pan"]);
      as("Agent");
      await expect(payments.revealPaymentMethod(pmId)).rejects.toThrow(); // still not allowed for a Travel Agent
    });

    it("no log line, audit row, activity row or email-bound record contains a code or its ciphertext", async () => {
      const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")];
      const { bookingId, pmId } = await signedBooking();
      const [row] = await cvvRow(pmId);
      as("AdminAudit");
      await actions.revealBookingCvv(bookingId, pmId);
      as("Manager");
      await actions.revealBookingCvv(bookingId, pmId).catch(() => undefined);
      as("AdminAudit");
      await actions.destroyBookingCvv(bookingId, pmId);
      const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
      spies.forEach((s) => s.mockRestore());
      expect(logged).not.toContain(`"${CODE}"`);
      expect(logged).not.toContain(row.encryptedCvv!);
      const audit = JSON.stringify(await prisma.auditLog.findMany({ where: { entityId: pmId } }));
      expect(audit).not.toContain(row.encryptedCvv!);
      expect(audit).not.toMatch(/"cvv"|"cvc"/i);
      expect(audit).not.toContain(VISA);
      const activity = JSON.stringify(await prisma.activity.findMany({ where: { bookingId } }));
      expect(activity).not.toContain(row.encryptedCvv!);
      expect(activity).not.toContain(CODE + '"');
    });
  });
});
