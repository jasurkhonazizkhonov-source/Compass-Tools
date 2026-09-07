import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass 26 §2 — submitBooking previously only rejected quote.status ===
// "CANCELED" and an already-existing quote.booking; nothing stopped a
// secureToken for a quote that was DRAFT, still pending exchange review, or
// (the concrete new risk this pass introduces) already EXCHANGE_SUPERSEDED
// or EXCHANGE_DISAPPROVED from being used to sign and create a real
// Booking/charge — a customer who happened to retain an old link could
// otherwise complete a booking against a proposal staff had already
// replaced or rejected. isQuoteBookable (src/lib/exchange-proposal.ts) is
// now the one shared allow-list enforced here.

type FakeQuote = { status: string; booking: unknown };

let fakeQuote: FakeQuote;

vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("@/server/quote-status", () => ({
  transitionQuoteStatus: vi.fn(async () => {}),
  notifyQuoteActivity: vi.fn(async () => {}),
}));
vi.mock("@/server/booking-notification", () => ({ sendBookingSignedNotification: vi.fn(async () => {}) }));
vi.mock("@/server/security/payment-vault", () => ({
  getPaymentVault: vi.fn(() => ({
    store: vi.fn(async (pan: string) => `ENC:${pan}`),
    reveal: vi.fn(async (ref: string) => ref.replace(/^ENC:/, "")),
  })),
}));
vi.mock("@/server/security/cvv-cache", () => ({ cacheCvv: vi.fn() }));
vi.mock("@/server/security/ip-capture", () => ({ recordIpCapture: vi.fn(async () => {}) }));

let bookingCreateCalled: boolean;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    quote: {
      findUnique: vi.fn(async () => ({
        id: "quote-1",
        secureToken: "tok-1",
        status: fakeQuote.status,
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
        booking: fakeQuote.booking,
      })),
      update: vi.fn(async () => ({})),
    },
    quoteStatusHistory: { create: vi.fn(async () => ({})) },
    lead: { update: vi.fn(async () => ({})) },
    leadStatusHistory: { create: vi.fn(async () => ({})) },
    booking: {
      create: vi.fn(async () => {
        bookingCreateCalled = true;
        return { id: "booking-1", quoteId: "quote-1", createdAt: new Date(), signature: { id: "signature-1", bookingId: "booking-1", signedAt: new Date(), ipAddress: undefined, userAgent: undefined } };
      }),
    },
    paymentMethod: { create: vi.fn(async () => ({ id: "pm-1" })) },
    itinerary: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

const input = {
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
};

beforeEach(() => {
  bookingCreateCalled = false;
  fakeQuote = { status: "SENT", booking: null };
  vi.clearAllMocks();
});

describe("submitBooking — stale/superseded/pre-review quote-status protection (Pass 26 §2)", () => {
  it.each(["SENT", "READ", "VIEWED"])("accepts a signature while the quote is %s", async (status) => {
    fakeQuote = { status, booking: null };
    const { submitBooking } = await import("../booking");
    const result = await submitBooking(input);
    expect(result.ok).toBe(true);
    expect(bookingCreateCalled).toBe(true);
  });

  it.each(["DRAFT", "PENDING_EXCHANGE_APPROVAL", "EXCHANGE_APPROVED", "EXCHANGE_DISAPPROVED", "EXCHANGE_SUPERSEDED", "EXCHANGED"])(
    "rejects a signature attempt while the quote is %s — never creates a Booking",
    async (status) => {
      fakeQuote = { status, booking: null };
      const { submitBooking } = await import("../booking");
      const result = await submitBooking(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/no longer active/i);
      expect(bookingCreateCalled).toBe(false);
    }
  );

  it("a superseded proposal's stale token is rejected even though it was genuinely sent and received by the customer at one point", async () => {
    fakeQuote = { status: "EXCHANGE_SUPERSEDED", booking: null };
    const { submitBooking } = await import("../booking");
    const result = await submitBooking(input);
    expect(result.ok).toBe(false);
    expect(bookingCreateCalled).toBe(false);
  });

  it("CANCELED keeps its own specific, pre-existing error message (unchanged behavior)", async () => {
    fakeQuote = { status: "CANCELED", booking: null };
    const { submitBooking } = await import("../booking");
    const result = await submitBooking(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/canceled/i);
  });
});
