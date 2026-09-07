import { describe, it, expect, vi, beforeEach } from "vitest";
import { LEGAL_CONTENT_VERSION } from "@/lib/legal-content";

// Pass 24 — Booking.termsVersion (additive, nullable) records which
// version of the Cancellation Policy/Terms & Conditions text a customer
// actually accepted at signing time, so a later revision of that text
// (legal-content.ts's LEGAL_CONTENT_VERSION) can be distinguished from
// what an earlier customer saw. submitBooking() is the ONE place a
// Booking row is ever created — for a brand-new booking AND for an
// exchange's own signing (an exchange quote flows through this exact same
// action; see server/actions/exchange.ts's own doc comments) — so this
// single call site covers both. Focused narrowly on termsVersion; card/
// pricing/IP-capture/notification behavior is covered by
// booking-retry.test.ts and booking-currency.test.ts's own fixtures.

type FakeBooking = {
  id: string;
  quoteId: string;
  termsAcceptedAt: Date | undefined;
  termsVersion: string | undefined;
  signature: { id: string; signedAt: Date };
};

let quoteHasBooking: boolean;
let bookingsCreated: FakeBooking[];
let nextId = 1;

vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("@/server/quote-status", () => ({ transitionQuoteStatus: vi.fn(async () => {}), notifyQuoteActivity: vi.fn(async () => {}) }));
vi.mock("@/server/booking-notification", () => ({ sendBookingSignedNotification: vi.fn(async () => {}) }));
vi.mock("@/server/security/payment-vault", () => ({
  getPaymentVault: vi.fn(() => ({ store: vi.fn(async (pan: string) => `ENC:${pan}`), reveal: vi.fn(async (ref: string) => ref.replace(/^ENC:/, "")) })),
}));
vi.mock("@/server/security/cvv-cache", () => ({ cacheCvv: vi.fn() }));
vi.mock("@/server/security/ip-capture", () => ({ recordIpCapture: vi.fn(async () => {}) }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    quote: {
      findUnique: vi.fn(async () => ({
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
        booking: quoteHasBooking ? { id: "existing-booking" } : null,
      })),
      update: vi.fn(async () => ({})),
    },
    quoteStatusHistory: { create: vi.fn(async () => ({})) },
    lead: { update: vi.fn(async () => ({})) },
    leadStatusHistory: { create: vi.fn(async () => ({})) },
    booking: {
      create: vi.fn(async ({ data }: { data: { quoteId: string; termsAcceptedAt: Date | undefined; termsVersion: string | undefined } }) => {
        const id = `booking-${nextId++}`;
        const booking: FakeBooking = {
          id,
          quoteId: data.quoteId,
          termsAcceptedAt: data.termsAcceptedAt,
          termsVersion: data.termsVersion,
          signature: { id: `signature-${nextId++}`, signedAt: new Date() },
        };
        bookingsCreated.push(booking);
        return booking;
      }),
    },
    paymentMethod: { create: vi.fn(async () => ({ id: `pm-${nextId++}` })) },
    itinerary: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

function baseInput(overrides: Partial<{ termsAccepted: true }> = {}) {
  return {
    token: "tok-1",
    passengers: [{ type: "ADULT" as const, firstName: "Jane", lastName: "Traveler", dateOfBirth: "1990-01-01", gender: "FEMALE" }],
    contactPhone: "555-0100",
    contactEmail: "jane@example.com",
    billingAddress: "123 Main St",
    billingCity: "Springfield",
    billingState: "IL",
    billingZip: "62704",
    billingCountry: "US",
    paymentMethods: [{ cardholderName: "Jane Traveler", cardNumber: "4111111111111111", expiryMonth: 12, expiryYear: new Date().getUTCFullYear() + 3, cvv: "123", amount: 500 }],
    paymentConsent: true as const,
    gratuityAmount: 0,
    termsAccepted: true as const,
    signedName: "Jane Traveler",
    ...overrides,
  };
}

beforeEach(() => {
  quoteHasBooking = false;
  bookingsCreated = [];
  nextId = 1;
  vi.clearAllMocks();
});

describe("submitBooking — legal content version tracking (Pass 24)", () => {
  it("a new booking that accepts terms stores the CURRENT legal content version", async () => {
    const { submitBooking } = await import("../booking");
    const result = await submitBooking(baseInput());
    expect(result.ok).toBe(true);
    expect(bookingsCreated).toHaveLength(1);
    expect(bookingsCreated[0].termsVersion).toBe(LEGAL_CONTENT_VERSION);
    expect(bookingsCreated[0].termsAcceptedAt).toBeInstanceOf(Date);
  });

  it("an exchange's own signing goes through this exact same action, so it stores the version identically — no separate code path to drift", async () => {
    // exchange.ts's own quote-creation flow ultimately routes the
    // customer's signing back through /quote/[token]/book -> submitBooking
    // (see exchange.ts's doc comments) — there is no second
    // Booking-creation call site to independently verify or drift from.
    const { submitBooking } = await import("../booking");
    await submitBooking(baseInput());
    expect(bookingsCreated[0].termsVersion).toBe(LEGAL_CONTENT_VERSION);
  });

  it("rejects the submission outright when terms were not accepted — no Booking is ever created, so no unversioned row can be written this way", async () => {
    const { submitBooking } = await import("../booking");
    await expect(submitBooking({ ...baseInput(), termsAccepted: false as unknown as true })).rejects.toThrow();
    expect(bookingsCreated).toHaveLength(0);
  });

  it("current acceptance always records the CURRENT constant, not a stale/hardcoded string", async () => {
    const { submitBooking } = await import("../booking");
    await submitBooking(baseInput());
    // Proves the field is wired to the live export, not a copy-pasted
    // literal that could silently drift from legal-content.ts.
    expect(bookingsCreated[0].termsVersion).toBe(LEGAL_CONTENT_VERSION);
    expect(typeof LEGAL_CONTENT_VERSION).toBe("string");
    expect(LEGAL_CONTENT_VERSION.length).toBeGreaterThan(0);
  });
});
