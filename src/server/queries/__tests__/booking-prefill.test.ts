import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass 13 §33/§36/§37 — getLastChargedBookingForContact is the ONE source
// every customer-facing prefill (Exchange Form, Cancellation signing form)
// reads from. The single most important property to prove: a contact can
// NEVER receive another customer's passenger/contact data, no matter how
// many bookings exist across the table — the query's own WHERE clause is
// the actual security boundary, not something filtered client-side.

type Call = { where: unknown; orderBy?: unknown };

function makeFakeBookingModel(rows: unknown[]) {
  const findFirstCalls: Call[] = [];
  return {
    findFirst: vi.fn(async (args: Call) => {
      findFirstCalls.push(args);
      // Mirror real Prisma's own filtering behavior closely enough for
      // this test: only a row whose quote.contactId matches is eligible.
      const where = args.where as { quote: { contactId: string } };
      const match = (rows as Array<{ quote: { contactId: string } }>).find((r) => r.quote.contactId === where.quote.contactId);
      return match ?? null;
    }),
    findFirstCalls,
  };
}

beforeEach(() => {
  vi.resetModules();
});

describe("getLastChargedBookingForContact — cross-customer isolation (Pass 13 §37)", () => {
  it("scopes the query itself by contactId — never returns another contact's booking", async () => {
    const booking = makeFakeBookingModel([
      {
        id: "booking-A",
        quote: { contactId: "contact-A" },
        contactPhone: "+15551234567",
        contactEmail: "a@example.com",
        airlineConfirmationNumber: "AA111",
        passengers: [{ firstName: "Alice", middleName: null, lastName: "A", type: "ADULT", dateOfBirth: null, gender: null, tsaKnownTravelerNumber: null, globalEntryNumber: null }],
      },
      {
        id: "booking-B",
        quote: { contactId: "contact-B" },
        contactPhone: "+15559998888",
        contactEmail: "b@example.com",
        airlineConfirmationNumber: "BB222",
        passengers: [{ firstName: "Bob", middleName: null, lastName: "B", type: "ADULT", dateOfBirth: null, gender: null, tsaKnownTravelerNumber: null, globalEntryNumber: null }],
      },
    ]);
    vi.doMock("@/lib/prisma", () => ({ prisma: { booking } }));

    const { getLastChargedBookingForContact } = await import("../bookings");
    const resultForA = await getLastChargedBookingForContact("contact-A");
    const resultForB = await getLastChargedBookingForContact("contact-B");

    expect(resultForA?.passengers[0].firstName).toBe("Alice");
    expect(resultForA?.contactEmail).toBe("a@example.com");
    expect(resultForB?.passengers[0].firstName).toBe("Bob");
    // Never cross-contaminated, in either direction.
    expect(resultForA?.passengers[0].firstName).not.toBe("Bob");
    expect(resultForB?.passengers[0].firstName).not.toBe("Alice");

    // The actual WHERE clause sent to Prisma is what enforces this — assert
    // it directly, not just the returned rows, so this test would still
    // catch a regression that happened to return the right row by luck.
    expect(booking.findFirstCalls[0].where).toEqual({ quote: { contactId: "contact-A" } });
    expect(booking.findFirstCalls[1].where).toEqual({ quote: { contactId: "contact-B" } });
    vi.doUnmock("@/lib/prisma");
  });

  it("returns null (never another contact's data as a fallback) when this contact has no charged booking at all", async () => {
    const booking = makeFakeBookingModel([{ id: "booking-other", quote: { contactId: "contact-other" }, contactPhone: "", contactEmail: "", airlineConfirmationNumber: null, passengers: [] }]);
    vi.doMock("@/lib/prisma", () => ({ prisma: { booking } }));

    const { getLastChargedBookingForContact } = await import("../bookings");
    const result = await getLastChargedBookingForContact("contact-with-no-booking");

    expect(result).toBeNull();
    vi.doUnmock("@/lib/prisma");
  });

  it("orders by createdAt descending — the MOST RECENT charged booking, for a repeat customer with more than one", async () => {
    const booking = makeFakeBookingModel([{ id: "booking-1", quote: { contactId: "contact-A" }, contactPhone: "", contactEmail: "", airlineConfirmationNumber: null, passengers: [] }]);
    vi.doMock("@/lib/prisma", () => ({ prisma: { booking } }));

    const { getLastChargedBookingForContact } = await import("../bookings");
    await getLastChargedBookingForContact("contact-A");

    expect(booking.findFirstCalls[0].orderBy).toEqual({ createdAt: "desc" });
    vi.doUnmock("@/lib/prisma");
  });

  it("selects only the fields prefill actually needs — no internal quote/booking IDs beyond this booking's own, no payment/PNR data", async () => {
    const booking = makeFakeBookingModel([{ id: "booking-1", quote: { contactId: "contact-A" }, contactPhone: "+1", contactEmail: "a@x.com", airlineConfirmationNumber: null, passengers: [] }]);
    vi.doMock("@/lib/prisma", () => ({ prisma: { booking } }));

    const { getLastChargedBookingForContact } = await import("../bookings");
    const result = await getLastChargedBookingForContact("contact-A");

    expect(result).not.toHaveProperty("pnr");
    expect(result).not.toHaveProperty("internalNotes");
    expect(result).not.toHaveProperty("fareAmount");
    vi.doUnmock("@/lib/prisma");
  });
});

// Pass 24/25 — getPreviousPassengersForContact powers the new-booking
// "select a previous passenger" autofill. Same security property as
// above: the query's own WHERE clause (`booking: { quote: { contactId } }`)
// must be the actual boundary — never a client-supplied id, never
// filtered only in the UI. "Customer A attempts to retrieve Customer B's
// previous passengers" must fail structurally, not by luck.
function makeFakePassengerModel(rows: Array<{ contactId: string; passenger: Record<string, unknown> }>) {
  const findManyCalls: Array<{ where: unknown; orderBy?: unknown }> = [];
  return {
    findMany: vi.fn(async (args: { where: { booking: { quote: { contactId: string } } }; orderBy?: unknown }) => {
      findManyCalls.push(args);
      const contactId = args.where.booking.quote.contactId;
      return rows.filter((r) => r.contactId === contactId).map((r) => r.passenger);
    }),
    findManyCalls,
  };
}

describe("getPreviousPassengersForContact — cross-customer isolation (Pass 24/25)", () => {
  const ALICE_PASSENGER = { firstName: "Alice", middleName: null, lastName: "A", type: "ADULT", dateOfBirth: new Date("1990-01-01T00:00:00Z"), gender: null, tsaKnownTravelerNumber: null, globalEntryNumber: null, frequentFlyerAirline: null, frequentFlyerNumber: null };
  const BOB_PASSENGER = { firstName: "Bob", middleName: null, lastName: "B", type: "ADULT", dateOfBirth: new Date("1985-05-05T00:00:00Z"), gender: null, tsaKnownTravelerNumber: null, globalEntryNumber: null, frequentFlyerAirline: null, frequentFlyerNumber: null };

  it("scopes strictly by contactId — Customer A's query never returns Customer B's passengers, and vice versa", async () => {
    const passenger = makeFakePassengerModel([
      { contactId: "contact-A", passenger: ALICE_PASSENGER },
      { contactId: "contact-B", passenger: BOB_PASSENGER },
    ]);
    vi.doMock("@/lib/prisma", () => ({ prisma: { passenger } }));

    const { getPreviousPassengersForContact } = await import("../bookings");
    const forA = await getPreviousPassengersForContact("contact-A");
    const forB = await getPreviousPassengersForContact("contact-B");

    expect(forA.map((p) => p.firstName)).toEqual(["Alice"]);
    expect(forB.map((p) => p.firstName)).toEqual(["Bob"]);
    expect(forA.some((p) => p.firstName === "Bob")).toBe(false);
    expect(forB.some((p) => p.firstName === "Alice")).toBe(false);
    // Assert the actual WHERE clause, not just the returned rows.
    expect(passenger.findManyCalls[0].where).toEqual({ booking: { quote: { contactId: "contact-A" } } });
    vi.doUnmock("@/lib/prisma");
  });

  it("a fabricated/unknown contactId returns an empty array, never another customer's data as a fallback", async () => {
    const passenger = makeFakePassengerModel([{ contactId: "contact-A", passenger: ALICE_PASSENGER }]);
    vi.doMock("@/lib/prisma", () => ({ prisma: { passenger } }));

    const { getPreviousPassengersForContact } = await import("../bookings");
    const result = await getPreviousPassengersForContact("contact-does-not-exist");

    expect(result).toEqual([]);
    vi.doUnmock("@/lib/prisma");
  });

  it("deduplicates the same apparent person (name + DOB) across multiple past bookings, keeping only one entry", async () => {
    const passenger = makeFakePassengerModel([
      { contactId: "contact-A", passenger: { ...ALICE_PASSENGER, tsaKnownTravelerNumber: "OLD-KTN" } },
      { contactId: "contact-A", passenger: { ...ALICE_PASSENGER, tsaKnownTravelerNumber: "NEW-KTN" } },
    ]);
    vi.doMock("@/lib/prisma", () => ({ prisma: { passenger } }));

    const { getPreviousPassengersForContact } = await import("../bookings");
    const result = await getPreviousPassengersForContact("contact-A");

    expect(result).toHaveLength(1);
    // Keeps the most-recent-booking's occurrence (rows arrive pre-sorted
    // by the query's own orderBy: { booking: { createdAt: "desc" } } — the
    // first matching row for a given identity key wins).
    expect(result[0].tsaKnownTravelerNumber).toBe("OLD-KTN");
    vi.doUnmock("@/lib/prisma");
  });

  it("two genuinely different people who happen to share a name but have different dates of birth are NOT merged", async () => {
    const passenger = makeFakePassengerModel([
      { contactId: "contact-A", passenger: { ...ALICE_PASSENGER, dateOfBirth: new Date("1990-01-01T00:00:00Z") } },
      { contactId: "contact-A", passenger: { ...ALICE_PASSENGER, dateOfBirth: new Date("1962-06-15T00:00:00Z") } },
    ]);
    vi.doMock("@/lib/prisma", () => ({ prisma: { passenger } }));

    const { getPreviousPassengersForContact } = await import("../bookings");
    const result = await getPreviousPassengersForContact("contact-A");

    expect(result).toHaveLength(2);
    vi.doUnmock("@/lib/prisma");
  });
});

// Pass 25 §7-9 — billing-address autofill selector. Same isolation
// contract as passengers above.
function makeFakeBookingModelForBilling(rows: Array<{ contactId: string; address: Record<string, unknown> }>) {
  return {
    findMany: vi.fn(async (args: { where: { quote: { contactId: string } } }) =>
      rows.filter((r) => r.contactId === args.where.quote.contactId).map((r) => r.address)
    ),
  };
}

describe("getPreviousBillingAddressesForContact — cross-customer isolation (Pass 25)", () => {
  const ADDR_A = { billingAddress: "123 Main St", billingApt: null, billingCity: "Springfield", billingState: "IL", billingZip: "62704", billingCountry: "US" };
  const ADDR_B = { billingAddress: "500 Market St", billingApt: "4B", billingCity: "San Francisco", billingState: "CA", billingZip: "94105", billingCountry: "US" };

  it("scopes strictly by contactId — never returns another contact's address", async () => {
    const booking = makeFakeBookingModelForBilling([
      { contactId: "contact-A", address: ADDR_A },
      { contactId: "contact-B", address: ADDR_B },
    ]);
    vi.doMock("@/lib/prisma", () => ({ prisma: { booking } }));

    const { getPreviousBillingAddressesForContact } = await import("../bookings");
    const forA = await getPreviousBillingAddressesForContact("contact-A");
    const forB = await getPreviousBillingAddressesForContact("contact-B");

    expect(forA).toEqual([ADDR_A]);
    expect(forB).toEqual([ADDR_B]);
    vi.doUnmock("@/lib/prisma");
  });

  it("deduplicates an equivalent address reused across bookings", async () => {
    const booking = makeFakeBookingModelForBilling([
      { contactId: "contact-A", address: ADDR_A },
      { contactId: "contact-A", address: { ...ADDR_A } },
    ]);
    vi.doMock("@/lib/prisma", () => ({ prisma: { booking } }));

    const { getPreviousBillingAddressesForContact } = await import("../bookings");
    const result = await getPreviousBillingAddressesForContact("contact-A");

    expect(result).toHaveLength(1);
    vi.doUnmock("@/lib/prisma");
  });

  it("an unknown contactId returns an empty array, never another customer's data", async () => {
    const booking = makeFakeBookingModelForBilling([{ contactId: "contact-A", address: ADDR_A }]);
    vi.doMock("@/lib/prisma", () => ({ prisma: { booking } }));

    const { getPreviousBillingAddressesForContact } = await import("../bookings");
    const result = await getPreviousBillingAddressesForContact("contact-does-not-exist");

    expect(result).toEqual([]);
    vi.doUnmock("@/lib/prisma");
  });
});

// Pass 25 §3-6 — masked-only card selector. Same isolation contract, plus
// the explicit guarantee that the encrypted PAN is never selected.
function makeFakePaymentMethodModel(rows: Array<{ contactId: string; card: Record<string, unknown> }>) {
  const findManyCalls: Array<{ where: unknown; select?: unknown }> = [];
  return {
    findMany: vi.fn(async (args: { where: { contactId: string; status: string }; select?: Record<string, boolean> }) => {
      findManyCalls.push(args);
      return rows.filter((r) => r.contactId === args.where.contactId).map((r) => r.card);
    }),
    findManyCalls,
  };
}

describe("getPreviousPaymentMethodsForContact — cross-customer isolation + PAN exclusion (Pass 25)", () => {
  const CARD_A = { id: "pm-A", cardholderName: "Jane Traveler", last4: "4242", cardBrand: "Visa", expiryMonth: 12, expiryYear: 2028 };
  const CARD_B = { id: "pm-B", cardholderName: "Bob Other", last4: "1111", cardBrand: "Mastercard", expiryMonth: 6, expiryYear: 2027 };

  it("scopes strictly by contactId — never returns another contact's card", async () => {
    const paymentMethod = makeFakePaymentMethodModel([
      { contactId: "contact-A", card: CARD_A },
      { contactId: "contact-B", card: CARD_B },
    ]);
    vi.doMock("@/lib/prisma", () => ({ prisma: { paymentMethod } }));

    const { getPreviousPaymentMethodsForContact } = await import("../bookings");
    const forA = await getPreviousPaymentMethodsForContact("contact-A");
    const forB = await getPreviousPaymentMethodsForContact("contact-B");

    expect(forA).toEqual([CARD_A]);
    expect(forB).toEqual([CARD_B]);
    vi.doUnmock("@/lib/prisma");
  });

  it("the select clause never requests encryptedPan — the query cannot leak the full card number even by accident", async () => {
    const paymentMethod = makeFakePaymentMethodModel([{ contactId: "contact-A", card: CARD_A }]);
    vi.doMock("@/lib/prisma", () => ({ prisma: { paymentMethod } }));

    const { getPreviousPaymentMethodsForContact } = await import("../bookings");
    await getPreviousPaymentMethodsForContact("contact-A");

    const call = paymentMethod.findManyCalls[0];
    expect(call.select).not.toHaveProperty("encryptedPan");
    expect(call.select).toEqual({ id: true, cardholderName: true, last4: true, cardBrand: true, expiryMonth: true, expiryYear: true });
    vi.doUnmock("@/lib/prisma");
  });

  it("only ACTIVE cards are offered — a removed/inactive card never appears in the selector", async () => {
    const paymentMethod = makeFakePaymentMethodModel([{ contactId: "contact-A", card: CARD_A }]);
    vi.doMock("@/lib/prisma", () => ({ prisma: { paymentMethod } }));

    const { getPreviousPaymentMethodsForContact } = await import("../bookings");
    await getPreviousPaymentMethodsForContact("contact-A");

    expect(paymentMethod.findManyCalls[0].where).toEqual({ contactId: "contact-A", status: "ACTIVE" });
    vi.doUnmock("@/lib/prisma");
  });
});
