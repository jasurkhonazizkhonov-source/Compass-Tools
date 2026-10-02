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
  // Ticket Nett Cost — deliberately NOT seeded at booking time (see below).
  fareAmount?: number | null;
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


vi.mock("@/server/security/ip-capture", () => ({
  recordIpCapture: vi.fn(async () => {}),
}));

vi.mock("@/lib/prisma", () => {
  const prisma: Record<string, unknown> = {
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
      updateMany: vi.fn(async () => ({ count: 1 })),
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
    // submitBooking now signs inside ONE interactive transaction (callback
    // form); the array form is kept for any other caller. The callback
    // receives this same fake as its `tx`.
    $transaction: vi.fn(async (arg: unknown) =>
      typeof arg === "function" ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as Promise<unknown>[])
    ),
  };
  return { prisma };
});

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
    paymentMethods: [{ cardholderName: "Jane Traveler", cardNumber: "4111111111111111", expiryMonth: 12, expiryYear: new Date().getUTCFullYear() + 3, amount: totalAmount }],
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
  it("seeds taxAmount/serviceFeeAmount with the RAW USD figures, not the AUD-converted ones — and leaves Ticket Nett Cost (fareAmount) UNSET", async () => {
    quoteCurrency = "AUD";
    quoteExchangeRate = 1.5; // deliberately not 1, so a currency mix-up is visible

    const { submitBooking } = await import("../booking");
    // Total in AUD at rate 1.5: (500 + 50 + 20) * 1.5 = 855.
    const result = await submitBooking(baseInput(855));

    expect(result.ok).toBe(true);
    expect(capturedCreateData).not.toBeNull();
    // USD quote pricing: adultPrice 500, taxes 50, serviceFee 20 — taxes and
    // the issuing fee must land on the Booking exactly as entered, never
    // multiplied by the 1.5 AUD rate.
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

  it("a wrong (pre-fix) implementation would have stored taxAmount=75 (50*1.5) instead of the correct 50 — this pins the exact regression", async () => {
    quoteCurrency = "AUD";
    quoteExchangeRate = 1.5;

    const { submitBooking } = await import("../booking");
    await submitBooking(baseInput(855));

    expect(capturedCreateData!.taxAmount).not.toBe(75); // 50 * 1.5
    expect(capturedCreateData!.serviceFeeAmount).not.toBe(30); // 20 * 1.5
  });

  it("a USD quote (rate 1, unset exchangeRate) is unaffected either way — same value whether converted or not", async () => {
    quoteCurrency = "USD";
    quoteExchangeRate = null;

    const { submitBooking } = await import("../booking");
    const result = await submitBooking(baseInput(570));

    expect(result.ok).toBe(true);
    expect(capturedCreateData!.taxAmount).toBe(50);
    expect(capturedCreateData!.serviceFeeAmount).toBe(20);
    expect(capturedCreateData!.totalAmount).toBe(570);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Selling price vs Ticket Nett Cost. The customer signs a Price Summary
// (ticket cost + taxes + service fee + gratuity = total). The Ticketing Agent
// separately enters what the ticket ACTUALLY cost the agency (Ticket Nett
// Cost, Booking.fareAmount). Those are different numbers: the nett cost must
// start UNSET — never copied from the customer's price — while the signed
// amounts are stored exactly as signed.
// ───────────────────────────────────────────────────────────────────────
describe("submitBooking — Ticket Nett Cost is not seeded from the customer's selling price", () => {
  it("creates the booking with Ticket Nett Cost UNSET, whatever the customer's ticket price is", async () => {
    const { submitBooking } = await import("../booking");
    const result = await submitBooking(baseInput(570));
    expect(result.ok).toBe(true);
    expect(capturedCreateData!.fareAmount ?? null).toBeNull();
    expect(Object.keys(capturedCreateData!)).not.toContain("fareAmount");
  });

  it("while the customer's signed amounts are stored exactly as signed (ticket 500 + taxes 50 + service fee 20 + gratuity 200 = total)", async () => {
    const { submitBooking } = await import("../booking");
    const input = { ...baseInput(770), gratuityAmount: 200 };
    const result = await submitBooking(input);
    expect(result.ok).toBe(true);
    expect(capturedCreateData!.gratuityAmount).toBe(200);
    expect(capturedCreateData!.totalAmount).toBe(770);
  });
});

// ───────────────────────────────────────────────────────────────────────
// The card security code (CVV/CVC) is TRANSIENT input: format-checked, then
// dropped. It must never reach the database write, the card vault, the
// notification e-mails, the logs or the response.
// ───────────────────────────────────────────────────────────────────────
describe("submitBooking — the security code is validated and discarded, never persisted", () => {
  const CODE = "7391"; // a 4-digit marker that cannot collide with other fixture numbers

  function withCode(code: string | undefined, number = "4111111111111111") {
    const base = baseInput(570);
    return { ...base, paymentMethods: base.paymentMethods.map((c) => ({ ...c, cardNumber: number, ...(code === undefined ? {} : { cvv: code }) })) };
  }

  it("accepts a well-formed code (3 digits, or 4 for American Express) and the booking succeeds", async () => {
    const { submitBooking } = await import("../booking");
    expect((await submitBooking(withCode("123"))).ok).toBe(true);
    expect((await submitBooking(withCode("1234", "378282246310005"))).ok).toBe(true);
  });

  it("rejects a malformed code with the same generic message — and records no booking", async () => {
    const { submitBooking } = await import("../booking");
    for (const bad of ["12", "12a", "12345678", "1234"]) {
      capturedCreateData = null;
      const result = await submitBooking(withCode(bad)); // 4 digits is wrong for a Visa
      expect(result).toEqual({ ok: false, error: "Payment information could not be processed" });
      expect(capturedCreateData).toBeNull();
    }
  });

  it("a client that does not send one (a stale page) is not rejected mid-checkout", async () => {
    const { submitBooking } = await import("../booking");
    expect((await submitBooking(withCode(undefined))).ok).toBe(true);
  });

  it("the code appears in NOTHING that is written: not the booking row (incl. nested payment methods/passengers/signature), not the vault, not a log, not the result", async () => {
    const { prisma } = await import("@/lib/prisma");
    const vault = await import("@/server/security/payment-vault");
    const logs: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" "))));
    const { submitBooking } = await import("../booking");
    const result = await submitBooking(withCode(CODE, "378282246310005"));
    spies.forEach((s) => s.mockRestore());

    expect(result.ok).toBe(true);
    expect(JSON.stringify(capturedCreateData)).not.toContain(CODE);
    expect(JSON.stringify(result)).not.toContain(CODE);
    expect(logs.join("\n")).not.toContain(CODE);
    // every other write the action made, anywhere
    const writes = [prisma.quote, prisma.quoteStatusHistory, prisma.lead, prisma.leadStatusHistory, prisma.paymentMethod, prisma.booking]
      .flatMap((m) => Object.values(m as unknown as Record<string, { mock?: { calls: unknown[][] } }>))
      .flatMap((fn) => fn.mock?.calls ?? []);
    expect(JSON.stringify(writes)).not.toContain(CODE);
    // the vault only ever sees the card number (and its row id), never the code
    const stored = vi.mocked(vault.getPaymentVault).mock.results.flatMap((r) => (r.value as { store: { mock: { calls: unknown[][] } } }).store.mock.calls);
    expect(JSON.stringify(stored)).not.toContain(CODE);
    // and the booking row has no field that could hold one
    expect(JSON.stringify(Object.keys(capturedCreateData!))).not.toMatch(/cvv|cvc|security/i);
  });
});
