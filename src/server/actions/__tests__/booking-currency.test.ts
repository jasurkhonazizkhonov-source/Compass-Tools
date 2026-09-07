import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass 22 — CONFIRMED FINANCIAL-CORRECTNESS BUG, now fixed: submitBooking
// previously seeded Booking.fareAmount/taxAmount/serviceFeeAmount from the
// CUSTOMER-CURRENCY-CONVERTED pricing breakdown instead of the raw USD one.
// Those three columns are documented (see convertToUsd's own comment in
// src/lib/currency.ts) as ALWAYS USD — the same "agent tracks internal
// cost in USD" convention Quote itself uses. computeBookingProfitUsd()
// treats them as already-USD when computing profit/commission, and the
// ticketing UI displays them with a bare "$" as if they were already
// correct. For a non-USD quote (AUD/EUR/GBP/CAD), this silently stored a
// foreign-currency figure in a USD-typed column, producing a wrong
// profit/commission for that sale unless a ticketing agent happened to
// overwrite every one of the three fields before confirming it.
// gratuityAmount/totalAmount are, by contrast, correctly the CONVERTED
// customer-currency values — this test proves both halves of that split.

type FakeBookingCreateData = {
  fareAmount: number;
  taxAmount: number;
  serviceFeeAmount: number;
  gratuityAmount: number;
  totalAmount: number;
  signature: { create: { signedName: string; ipAddress: string | undefined; userAgent: string | undefined } };
};

let capturedCreateData: FakeBookingCreateData | null;
let quoteCurrency: string;
let quoteExchangeRate: number | null;

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Map()),
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

vi.mock("@/server/security/ip-capture", () => ({
  recordIpCapture: vi.fn(async () => {}),
}));

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
        currency: quoteCurrency,
        exchangeRate: quoteExchangeRate,
        adultPrice: 500,
        childPrice: 0,
        infantPrice: 0,
        taxes: 50,
        serviceFee: 20,
        adults: 1,
        children: 0,
        infants: 0,
        lead: { status: "QUOTED" },
        contact: { firstName: "Jane", middleName: null, lastName: "Traveler" },
        agent: { id: "agent-1", email: "agent@example.com", fullName: "Agent One", phone: null },
        booking: null,
      })),
      update: vi.fn(async () => ({})),
    },
    quoteStatusHistory: { create: vi.fn(async () => ({})) },
    lead: { update: vi.fn(async () => ({})) },
    leadStatusHistory: { create: vi.fn(async () => ({})) },
    booking: {
      create: vi.fn(async ({ data }: { data: FakeBookingCreateData }) => {
        capturedCreateData = data;
        return {
          id: "booking-1",
          quoteId: "quote-1",
          createdAt: new Date(),
          signature: { id: "signature-1", bookingId: "booking-1", signedAt: new Date(), ipAddress: undefined, userAgent: undefined },
        };
      }),
    },
    paymentMethod: {
      create: vi.fn(async () => ({ id: "pm-1" })),
    },
    itinerary: {
      findUnique: vi.fn(async () => null),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

function baseInput(totalAmount: number) {
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
    paymentMethods: [{ cardholderName: "Jane Traveler", cardNumber: "4111111111111111", expiryMonth: 12, expiryYear: new Date().getUTCFullYear() + 3, cvv: "123", amount: totalAmount }],
    paymentConsent: true as const,
    gratuityAmount: 0,
    termsAccepted: true as const,
    signedName: "Jane Traveler",
  };
}

beforeEach(() => {
  capturedCreateData = null;
  quoteCurrency = "USD";
  quoteExchangeRate = null;
  vi.clearAllMocks();
});

describe("submitBooking — non-USD currency: fareAmount/taxAmount/serviceFeeAmount stay USD, gratuityAmount/totalAmount convert (Pass 22 fix)", () => {
  it("seeds fareAmount/taxAmount/serviceFeeAmount with the RAW USD figures, not the AUD-converted ones", async () => {
    quoteCurrency = "AUD";
    quoteExchangeRate = 1.5; // deliberately not 1, so a currency mix-up is visible

    const { submitBooking } = await import("../booking");
    // Total in AUD at rate 1.5: (500 + 50 + 20) * 1.5 = 855.
    const result = await submitBooking(baseInput(855));

    expect(result.ok).toBe(true);
    expect(capturedCreateData).not.toBeNull();
    // USD quote pricing: adultPrice 500, taxes 50, serviceFee 20 — these
    // must land on the Booking exactly as entered, never multiplied by
    // the 1.5 AUD rate.
    expect(capturedCreateData!.fareAmount).toBe(500);
    expect(capturedCreateData!.taxAmount).toBe(50);
    expect(capturedCreateData!.serviceFeeAmount).toBe(20);
  });

  it("still converts totalAmount/gratuityAmount to the quote's own currency (the correct half of the split, unchanged by this fix)", async () => {
    quoteCurrency = "AUD";
    quoteExchangeRate = 1.5;

    const { submitBooking } = await import("../booking");
    const result = await submitBooking(baseInput(855));

    expect(result.ok).toBe(true);
    expect(capturedCreateData!.totalAmount).toBe(855);
    expect(capturedCreateData!.gratuityAmount).toBe(0);
  });

  it("a wrong (pre-fix) implementation would have stored fareAmount=750 (500*1.5) instead of the correct 500 — this pins the exact regression", async () => {
    quoteCurrency = "AUD";
    quoteExchangeRate = 1.5;

    const { submitBooking } = await import("../booking");
    await submitBooking(baseInput(855));

    expect(capturedCreateData!.fareAmount).not.toBe(750);
    expect(capturedCreateData!.taxAmount).not.toBe(75); // 50 * 1.5
    expect(capturedCreateData!.serviceFeeAmount).not.toBe(30); // 20 * 1.5
  });

  it("a USD quote (rate 1, unset exchangeRate) is unaffected either way — same value whether converted or not", async () => {
    quoteCurrency = "USD";
    quoteExchangeRate = null;

    const { submitBooking } = await import("../booking");
    const result = await submitBooking(baseInput(570));

    expect(result.ok).toBe(true);
    expect(capturedCreateData!.fareAmount).toBe(500);
    expect(capturedCreateData!.taxAmount).toBe(50);
    expect(capturedCreateData!.serviceFeeAmount).toBe(20);
    expect(capturedCreateData!.totalAmount).toBe(570);
  });
});
