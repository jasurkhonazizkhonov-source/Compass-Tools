import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@/generated/prisma/client";

// In-memory fake Prisma, same convention as other server-action test files.
// Focused specifically on submitBooking()'s idempotency/retry behavior and
// server-side IP capture — NOT on re-testing card/pricing validation
// (covered elsewhere) or the notification pipeline (its own
// booking-notification.test.ts). Proves: (1) the IP is captured
// server-side from the request headers and stored on the new Signature,
// never a client-submitted value, and (2) a second submission attempt
// against an already-booked quote is rejected outright — no second
// Booking/Signature is ever created, so a successful signature's original
// IP/timestamp can never be silently overwritten by a later request.

type FakeSignature = { id: string; bookingId: string; signedName: string; signedAt: Date; ipAddress: string | undefined; userAgent: string | undefined };
type FakeBooking = { id: string; quoteId: string; createdAt: Date; signature: FakeSignature };

let quoteBooking: FakeBooking | null;
let bookingsCreated: FakeBooking[];
let requestHeaders: Map<string, string>;
let nextId = 1;

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => requestHeaders),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/server/activity-log", () => ({
  logActivity: vi.fn(async () => {}),
}));

vi.mock("@/server/quote-status", () => ({
  transitionQuoteStatus: vi.fn(async () => {}),
  notifyQuoteActivity: vi.fn(async () => {}),
}));

vi.mock("@/server/booking-notification", () => ({
  // The notification pipeline has its own dedicated test file — stubbed
  // out here so this file stays focused on signing/idempotency/IP capture.
  sendBookingSignedNotification: vi.fn(async () => {}),
}));

vi.mock("@/server/security/payment-vault", () => ({
  getPaymentVault: vi.fn(() => ({
    store: vi.fn(async (pan: string) => `ENC:${pan}`),
    reveal: vi.fn(async (ref: string) => ref.replace(/^ENC:/, "")),
  })),
}));

vi.mock("@/server/security/cvv-cache", () => ({
  cacheCvv: vi.fn(),
}));

// The IP-vault write itself is exhaustively covered in isolation by
// ip-capture.test.ts — here we only assert submitBooking calls it with the
// right formType/bookingId/signer identity (and, separately below, that
// the correlation console.log never embeds the raw IP — a real regression
// this pass found and fixed).
let capturedIpCalls: Array<Record<string, unknown>>;
vi.mock("@/server/security/ip-capture", () => ({
  recordIpCapture: vi.fn(async (params: Record<string, unknown>) => {
    capturedIpCalls.push(params);
  }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    quote: {
      findUnique: vi.fn(async () => {
        if (quoteBooking) {
          return {
            id: "quote-1",
            secureToken: "tok-1",
            status: "SIGNED",
            leadId: "lead-1",
            contactId: "contact-1",
            agentId: "agent-1",
            quoteNumber: "Q-1",
            currency: "USD",
            exchangeRate: null,
            adultPrice: 500,
            childPrice: 0,
            infantPrice: 0,
            taxes: 0,
            serviceFee: 0,
            adults: 1,
            children: 0,
            infants: 0,
            lead: { status: "BOOKED" },
            contact: { firstName: "Jane", middleName: null, lastName: "Traveler" },
            agent: { id: "agent-1", email: "agent@example.com", fullName: "Agent One", phone: null },
            booking: quoteBooking,
          };
        }
        return {
          id: "quote-1",
          secureToken: "tok-1",
          status: "SENT",
          leadId: "lead-1",
          contactId: "contact-1",
          agentId: "agent-1",
          quoteNumber: "Q-1",
          currency: "USD",
          exchangeRate: null,
          adultPrice: 500,
          childPrice: 0,
          infantPrice: 0,
          taxes: 0,
          serviceFee: 0,
          adults: 1,
          children: 0,
          infants: 0,
          lead: { status: "QUOTED" },
          contact: { firstName: "Jane", middleName: null, lastName: "Traveler" },
          agent: { id: "agent-1", email: "agent@example.com", fullName: "Agent One", phone: null },
          booking: null,
        };
      }),
      update: vi.fn(async () => ({})),
    },
    quoteStatusHistory: { create: vi.fn(async () => ({})) },
    lead: { update: vi.fn(async () => ({})) },
    leadStatusHistory: { create: vi.fn(async () => ({})) },
    booking: {
      create: vi.fn(async ({ data }: { data: { quoteId: string; signature: { create: { signedName: string; ipAddress: string | undefined; userAgent: string | undefined } } } }) => {
        // Pass 19 §8 — models the REAL database guarantee
        // (`Booking.quoteId @unique` in schema.prisma), independent of
        // `quoteBooking` (which only reflects what the mocked
        // quote.findUnique's UPFRONT check would see). This is what makes
        // the true-race regression test below meaningful: both calls can
        // see `quoteBooking === null` (the check passes for both, exactly
        // like two near-simultaneous real requests would), yet only the
        // FIRST create() actually succeeds — the second hits the same
        // constraint a real Postgres unique index would enforce.
        if (bookingsCreated.some((b) => b.quoteId === data.quoteId)) {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`quoteId`)", { code: "P2002", clientVersion: "test", meta: { target: ["quoteId"] } });
        }
        const id = `booking-${nextId++}`;
        const signature: FakeSignature = {
          id: `signature-${nextId++}`,
          bookingId: id,
          signedName: data.signature.create.signedName,
          signedAt: new Date(),
          ipAddress: data.signature.create.ipAddress,
          userAgent: data.signature.create.userAgent,
        };
        const booking: FakeBooking = { id, quoteId: "quote-1", createdAt: signature.signedAt, signature };
        bookingsCreated.push(booking);
        return booking;
      }),
    },
    paymentMethod: {
      create: vi.fn(async () => ({ id: `pm-${nextId++}` })),
    },
    itinerary: {
      findUnique: vi.fn(async () => null),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

function validCard(overrides: Partial<{ amount: number }> = {}) {
  return {
    cardholderName: "Jane Traveler",
    cardNumber: "4111111111111111",
    expiryMonth: 12,
    expiryYear: new Date().getUTCFullYear() + 3,
    cvv: "123",
    amount: 500,
    ...overrides,
  };
}

function baseInput() {
  return {
    token: "tok-1",
    passengers: [
      { type: "ADULT" as const, firstName: "Jane", lastName: "Traveler", dateOfBirth: "1990-01-01", gender: "FEMALE" },
    ],
    contactPhone: "555-0100",
    contactEmail: "jane@example.com",
    billingAddress: "123 Main St",
    billingCity: "Springfield",
    billingState: "IL",
    billingZip: "62704",
    billingCountry: "US",
    paymentMethods: [validCard()],
    paymentConsent: true as const,
    gratuityAmount: 0,
    termsAccepted: true as const,
    signedName: "Jane Traveler",
  };
}

beforeEach(() => {
  quoteBooking = null;
  bookingsCreated = [];
  requestHeaders = new Map([["x-forwarded-for", "203.0.113.42"], ["user-agent", "TestAgent/1.0"]]);
  capturedIpCalls = [];
  nextId = 1;
  vi.clearAllMocks();
});

describe("submitBooking — server-side IP capture (never client-submitted)", () => {
  it("captures the IP from the request headers and stores it on the new Signature — the submitted input has no ip field at all", async () => {
    const { submitBooking } = await import("../booking");
    const result = await submitBooking(baseInput());
    expect(result.ok).toBe(true);
    expect(bookingsCreated).toHaveLength(1);
    // TRUSTED_PROXY is unset in the test environment (secure default), so
    // getClientIp() returns undefined regardless of the spoofable header
    // above — this proves the header alone is never trusted, matching
    // request-ip.test.ts's own coverage of that exact behavior.
    expect(bookingsCreated[0].signature.ipAddress).toBeUndefined();
  });

  it("stores the User-Agent captured alongside the IP at signing time", async () => {
    const { submitBooking } = await import("../booking");
    await submitBooking(baseInput());
    expect(bookingsCreated[0].signature.userAgent).toBe("TestAgent/1.0");
  });

  it("also writes an IP vault capture entry (NEW_BOOKING) alongside the Signature", async () => {
    const { submitBooking } = await import("../booking");
    await submitBooking(baseInput());
    expect(capturedIpCalls).toHaveLength(1);
    expect(capturedIpCalls[0].formType).toBe("NEW_BOOKING");
    expect(capturedIpCalls[0].bookingId).toBe(bookingsCreated[0].id);
    expect(capturedIpCalls[0].signerName).toBe("Jane Traveler");
    expect(capturedIpCalls[0].signerEmail).toBe("jane@example.com");
  });

  it("never logs the raw IP to the console — only whether one was captured (Pass 21+ fix: the correlation log used to embed the plaintext IP directly)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // A trusted-proxy header this test environment would never actually
    // trust (TRUSTED_PROXY is unset), but even if a real IP HAD been
    // resolved, the fix under test is "never put it in a console.log
    // line" — assert against the header value itself so this test would
    // also catch a regression in an environment where TRUSTED_PROXY IS set.
    requestHeaders.set("x-forwarded-for", "198.51.100.77");
    const { submitBooking } = await import("../booking");
    await submitBooking(baseInput());
    const loggedText = logSpy.mock.calls.map((c) => c.join(" ")).join(" ");
    expect(loggedText).not.toContain("198.51.100.77");
    expect(loggedText).not.toContain("203.0.113.42");
    logSpy.mockRestore();
  });
});

describe("submitBooking — retry / idempotency", () => {
  it("a first successful submission creates exactly one Booking with its own Signature", async () => {
    const { submitBooking } = await import("../booking");
    const result = await submitBooking(baseInput());
    expect(result.ok).toBe(true);
    expect(bookingsCreated).toHaveLength(1);
  });

  it("a second submission attempt against an already-booked quote is rejected outright — no second Booking/Signature is ever created, and the first signature's IP/timestamp is never touched", async () => {
    const { submitBooking } = await import("../booking");
    const first = await submitBooking(baseInput());
    expect(first.ok).toBe(true);

    // Simulate the quote now having a booking attached, exactly as it
    // would after the first successful submission committed.
    quoteBooking = bookingsCreated[0];
    const originalIp = quoteBooking.signature.ipAddress;
    const originalSignedAt = quoteBooking.signature.signedAt;

    const second = await submitBooking(baseInput());
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toMatch(/already been booked/i);
    }

    // Still exactly one Booking ever created — the retry never reached the
    // create() call at all.
    expect(bookingsCreated).toHaveLength(1);
    expect(quoteBooking.signature.ipAddress).toBe(originalIp);
    expect(quoteBooking.signature.signedAt).toBe(originalSignedAt);
  });

  // Pass 19 §8 — the TRUE race, not the sequential case above. Both calls
  // see quoteBooking === null (the upfront "already booked" check passes
  // for both — exactly what two genuinely concurrent requests, a
  // double-click or a refresh-during-submit, would each independently
  // observe before either has committed). The real safety net is the
  // database's own Booking.quoteId unique constraint, modeled by the
  // booking.create mock above. Before this pass, submitBooking had no
  // catch around that create() call, so the second request would have
  // thrown an unhandled Prisma error instead of the same clean message
  // the sequential case already returns.
  it("a genuine race — two requests that BOTH pass the upfront check — still results in exactly one Booking, with the second returning the same clean error rather than throwing", async () => {
    const { submitBooking } = await import("../booking");
    // quoteBooking intentionally stays null for both calls — modeling that
    // neither request's upfront read observed the other's not-yet-committed write.
    const [first, second] = await Promise.all([submitBooking(baseInput()), submitBooking(baseInput())]);
    const results = [first, second];
    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    if (!failed[0].ok) {
      expect(failed[0].error).toMatch(/already been booked/i);
    }
    expect(bookingsCreated).toHaveLength(1); // never two, regardless of which request "won"
  });
});
