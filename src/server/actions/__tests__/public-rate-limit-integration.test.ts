import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass 25 §28 — proves submitBooking()/confirmCancellationByCustomer()
// actually reject with a clean, customer-safe message when the shared
// rate limiter says no — the WIRING, not the limiter's own internal logic
// (covered in isolation by rate-limit.test.ts). Mocks the rate-limit
// module directly so this stays independent of IP/AuditLog fixtures the
// existing booking-retry.test.ts/cancellation.test.ts files don't
// otherwise need.

let rateLimitAllowed: boolean;

vi.mock("@/server/security/rate-limit", () => ({
  checkPublicRateLimitFromRequest: vi.fn(async () => ({ allowed: rateLimitAllowed })),
  RATE_LIMITS: { BOOKING_SUBMIT: { windowMs: 1, maxAttempts: 1 }, CANCELLATION_SUBMIT: { windowMs: 1, maxAttempts: 1 } },
}));

vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("@/server/quote-status", () => ({ transitionQuoteStatus: vi.fn(async () => {}), notifyQuoteActivity: vi.fn(async () => {}) }));
vi.mock("@/server/booking-notification", () => ({ sendBookingSignedNotification: vi.fn(async () => {}) }));
// Payment capture is the provider's job: the booking action only receives an
// opaque capture reference and re-verifies it with the provider. These tests
// stub that verification (the real one is covered in vaulted-methods tests and
// the real-database integration suite) — no card data exists in any fixture.
vi.mock("@/server/payments/provider", () => ({ getPaymentProvider: vi.fn(() => ({ id: "stripe" })) }));
vi.mock("@/server/payments/vaulted-methods", () => ({
  verifyVaultedSetup: vi.fn(async (setupIntentId: string) => ({
    ok: true,
    method: {
      provider: "stripe",
      providerCustomerId: "cus_test",
      providerPaymentMethodId: `pm_${setupIntentId}`,
      providerSetupIntentId: setupIntentId,
      cardBrand: "Visa",
      last4: "4242",
      expiryMonth: 12,
      expiryYear: new Date().getUTCFullYear() + 3,
      cardFunding: "credit",
      providerCardholderName: "Jane Traveler",
    },
  })),
}));
vi.mock("@/server/security/ip-capture", () => ({ recordIpCapture: vi.fn(async () => {}) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    quote: { findUnique: vi.fn(async () => null) },
  },
}));

beforeEach(() => {
  rateLimitAllowed = true;
  vi.clearAllMocks();
});

function baseBookingInput() {
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
    paymentMethods: [{ setupIntentId: "seti_test_1", cardholderName: "Jane Traveler", amount: 500 }],
    paymentConsent: true as const,
    gratuityAmount: 0,
    termsAccepted: true as const,
    signedName: "Jane Traveler",
  };
}

describe("submitBooking — public rate-limit rejection", () => {
  it("returns a clean, customer-safe rejection when rate-limited — never reaches quote lookup", async () => {
    rateLimitAllowed = false;
    const { submitBooking } = await import("../booking");
    const { prisma } = await import("@/lib/prisma");
    const result = await submitBooking(baseBookingInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/too many booking attempts/i);
    expect(prisma.quote.findUnique).not.toHaveBeenCalled();
  });

  it("proceeds normally (past the rate-limit gate) when allowed", async () => {
    rateLimitAllowed = true;
    const { submitBooking } = await import("../booking");
    const { prisma } = await import("@/lib/prisma");
    await submitBooking(baseBookingInput());
    expect(prisma.quote.findUnique).toHaveBeenCalled();
  });
});

describe("confirmCancellationByCustomer — public rate-limit rejection", () => {
  it("throws a clean, customer-safe error when rate-limited — never reaches quote lookup", async () => {
    rateLimitAllowed = false;
    const { confirmCancellationByCustomer } = await import("../cancellation");
    const { prisma } = await import("@/lib/prisma");
    await expect(confirmCancellationByCustomer("some-token")).rejects.toThrow(/too many attempts/i);
    expect(prisma.quote.findUnique).not.toHaveBeenCalled();
  });
});
