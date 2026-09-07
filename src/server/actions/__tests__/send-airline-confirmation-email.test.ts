import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass 23 §21-23 — sendAirlineConfirmationEmail previously had ZERO
// duplicate-send protection. This covers the new first-send-vs-resend
// design: the FIRST send is an atomic claim (conditional
// booking.updateMany on airlineConfirmationFirstSentAt, mirroring the
// exact idiom already covered by send-cancellation-confirmation-email.
// test.ts) so two genuinely concurrent first sends (real Promise.all, not
// two sequential calls) can never both succeed; an explicit resend
// ({ resend: true }) skips the claim (legitimate, intended workflow) and
// is only guarded by a short recency check.

type FakeBooking = {
  id: string;
  status: string;
  contactEmail: string | null;
  airlineConfirmationNumber: string | null;
  airlineConfirmations: unknown;
  ticketNumbers: unknown;
  airlineConfirmationFirstSentAt: Date | null;
};

let bookings: Map<string, FakeBooking>;
let currentActor: { id: string; role: string; status: string; companyId: string } | null;
let emailLogs: Array<Record<string, unknown>>;
let sendEmailCalls: Array<Record<string, unknown>>;
let bookingUpdateManyCalls: Array<Record<string, unknown>>;
let recentSentLogs: Array<{ bookingId: string; createdAt: Date }>;

const AGENT = { id: "sender-1", fullName: "Andrew Kent", email: "andrew@example.com", location: null, hiredAt: new Date(), commissionPercent: 10 };

function fakeQuote(overrides: Partial<{ sentByAgent: typeof AGENT | null; agent: unknown }> = {}) {
  return {
    id: "quote-1",
    currency: "USD",
    adults: 1,
    children: 0,
    infants: 0,
    adultPrice: 500,
    childPrice: 0,
    infantPrice: 0,
    taxes: 0,
    serviceFee: 0,
    exchangeRate: null,
    originalQuoteId: null,
    exchangeFee: null,
    fareDifference: null,
    agent: null,
    sentByAgent: AGENT,
    itinerary: { segments: [] },
    ...overrides,
  };
}

const fakePrisma: Record<string, unknown> = {
  booking: {
    findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
      const b = bookings.get(where.id);
      return b ? { id: b.id } : null;
    }),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
      const b = bookings.get(where.id);
      if (!b) throw new Error("not found");
      return {
        id: b.id,
        status: b.status,
        leadId: "lead-1",
        contactId: "contact-1",
        contactEmail: b.contactEmail,
        airlineConfirmationNumber: b.airlineConfirmationNumber,
        airlineConfirmations: b.airlineConfirmations,
        ticketNumbers: b.ticketNumbers,
        gratuityAmount: 0,
        totalAmount: 500,
        bookingReference: "BK-1",
        contact: { firstName: "Jane", lastName: "Traveler" },
        passengers: [],
        paymentMethods: [],
        quote: fakeQuote(),
      };
    }),
    // Models Postgres's real conditional-update semantics: a single,
    // synchronous (no internal await) read-check-write against the shared
    // Map, so two genuinely concurrent Promise.all callers each get a
    // faithful "only one can match" result — exactly what makes the real
    // race-safety test below meaningful rather than vacuous.
    updateMany: vi.fn(async (args: { where: { id: string; airlineConfirmationFirstSentAt: null }; data: { airlineConfirmationFirstSentAt: Date } }) => {
      bookingUpdateManyCalls.push(args);
      const b = bookings.get(args.where.id);
      if (!b) return { count: 0 };
      if (b.airlineConfirmationFirstSentAt !== null) return { count: 0 };
      b.airlineConfirmationFirstSentAt = args.data.airlineConfirmationFirstSentAt;
      return { count: 1 };
    }),
  },
  account: {
    findMany: vi.fn(async () => []),
  },
  paymentCharge: {
    findMany: vi.fn(async () => []),
  },
  emailLog: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      emailLogs.push(data);
      return {};
    }),
    findFirst: vi.fn(async ({ where }: { where: { bookingId: string } }) => {
      const match = recentSentLogs.find((l) => l.bookingId === where.bookingId);
      return match ? { id: "log-1" } : null;
    }),
  },
};

vi.mock("@/lib/prisma", () => ({ prisma: fakePrisma }));
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/quote-status", () => ({ reconcileQuoteStatus: vi.fn(async () => ({ fireSideEffects: async () => {} })) }));
vi.mock("@/server/booking-notification", () => ({ sendBookingProfitNotification: vi.fn(async () => {}) }));
vi.mock("@/server/queries/company", () => ({
  getCompanyForAccountId: vi.fn(async () => ({ name: "Compass Tools", brandColor: "#1c3a5e", logoEmailUrl: null, website: null, phone: null, signatureTemplate: "{{first_name}}" })),
  getCompanyForContactId: vi.fn(async () => ({ name: "Compass Tools", brandColor: "#1c3a5e", logoEmailUrl: null, website: null, phone: null, signatureTemplate: "{{first_name}}" })),
}));
vi.mock("@/server/queries/reference-data", () => ({
  resolveAirlineCodes: vi.fn(async () => ({})),
}));
vi.mock("@/server/email/segment-mapper", () => ({ toEmailSegments: vi.fn(() => []) }));
vi.mock("@/server/email/templates", () => ({
  buildBookingConfirmationEmail: vi.fn(() => ({ subject: "Your Booking is Confirmed", html: "<p>html</p>" })),
  buildCancellationConfirmedEmail: vi.fn(() => ({ subject: "s", html: "h" })),
}));
vi.mock("@/server/email/service", () => ({
  sendEmail: vi.fn(async (args: Record<string, unknown>) => {
    sendEmailCalls.push(args);
    return { ok: true as const, messageId: "msg-1" };
  }),
}));

beforeEach(() => {
  bookings = new Map([
    [
      "booking-1",
      {
        id: "booking-1",
        status: "TICKETED",
        contactEmail: "jane@example.com",
        airlineConfirmationNumber: "AA123",
        airlineConfirmations: null,
        ticketNumbers: null,
        airlineConfirmationFirstSentAt: null,
      },
    ],
    [
      "booking-no-confirmation",
      {
        id: "booking-no-confirmation",
        status: "TICKETED",
        contactEmail: "jane@example.com",
        airlineConfirmationNumber: null,
        airlineConfirmations: null,
        ticketNumbers: null,
        airlineConfirmationFirstSentAt: null,
      },
    ],
    [
      "booking-no-email",
      {
        id: "booking-no-email",
        status: "TICKETED",
        contactEmail: null,
        airlineConfirmationNumber: "AA123",
        airlineConfirmations: null,
        ticketNumbers: null,
        airlineConfirmationFirstSentAt: null,
      },
    ],
    [
      "booking-multi",
      {
        id: "booking-multi",
        status: "CONFIRMED",
        contactEmail: "jane@example.com",
        airlineConfirmationNumber: "AA123",
        airlineConfirmations: [
          { id: "1", airlineIata: "AA", confirmationNumber: "AA123", eTicketNumbers: ["0011"] },
          { id: "2", airlineIata: null, confirmationNumber: "BB456", eTicketNumbers: [] },
        ],
        ticketNumbers: ["0011"],
        airlineConfirmationFirstSentAt: null,
      },
    ],
  ]);
  currentActor = { id: "ticketing-1", role: "TICKETING_AGENT", status: "ACTIVE", companyId: "company-1" };
  emailLogs = [];
  sendEmailCalls = [];
  bookingUpdateManyCalls = [];
  recentSentLogs = [];
  vi.clearAllMocks();
});

describe("sendAirlineConfirmationEmail — authorization + preconditions", () => {
  it("rejects an unauthenticated actor", async () => {
    currentActor = null;
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    await expect(sendAirlineConfirmationEmail("booking-1")).rejects.toThrow(/not authorized/i);
  });

  it("rejects a role that cannot enter ticketing info", async () => {
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1" };
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    await expect(sendAirlineConfirmationEmail("booking-1")).rejects.toThrow(/not authorized/i);
  });

  it("rejects a booking not visible to the actor (IDOR) as not-found, never leaking existence", async () => {
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    await expect(sendAirlineConfirmationEmail("no-such-booking")).rejects.toThrow(/not authorized/i);
  });

  it("rejects when there is no confirmation number at all (legacy field null, new array null)", async () => {
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    await expect(sendAirlineConfirmationEmail("booking-no-confirmation")).rejects.toThrow(/Ticketed or Confirmed/i);
  });

  it("rejects when the booking has no customer email on file", async () => {
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    await expect(sendAirlineConfirmationEmail("booking-no-email")).rejects.toThrow(/no customer email/i);
  });
});

describe("sendAirlineConfirmationEmail — first-send atomic claim", () => {
  it("on success: sends, claims airlineConfirmationFirstSentAt, and logs SENT", async () => {
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    await sendAirlineConfirmationEmail("booking-1");

    expect(sendEmailCalls).toHaveLength(1);
    expect(sendEmailCalls[0].accountId).toBe("sender-1");
    expect(emailLogs).toHaveLength(1);
    expect(emailLogs[0].status).toBe("SENT");
    expect(bookingUpdateManyCalls).toHaveLength(1);
    expect(bookings.get("booking-1")!.airlineConfirmationFirstSentAt).not.toBeNull();
  });

  it("fails closed when the quote has no original sender — never falls back to another account", async () => {
    // Booking's own findUniqueOrThrow mock always returns sentByAgent set;
    // simulate the null-sender case for this one call only, via
    // mockImplementationOnce so every other test keeps the shared fixture.
    (fakePrisma.booking as { findUniqueOrThrow: ReturnType<typeof vi.fn> }).findUniqueOrThrow.mockImplementationOnce(async () => ({
      id: "booking-1",
      status: "TICKETED",
      leadId: "lead-1",
      contactId: "contact-1",
      contactEmail: "jane@example.com",
      airlineConfirmationNumber: "AA123",
      airlineConfirmations: null,
      ticketNumbers: null,
      gratuityAmount: 0,
      totalAmount: 500,
      bookingReference: "BK-1",
      contact: { firstName: "Jane", lastName: "Traveler" },
      passengers: [],
      paymentMethods: [],
      quote: fakeQuote({ sentByAgent: null }),
    }));
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    await expect(sendAirlineConfirmationEmail("booking-1")).rejects.toThrow(/no original sender/i);
    expect(sendEmailCalls).toHaveLength(0);
    expect(emailLogs).toHaveLength(1);
    expect(emailLogs[0].status).toBe("FAILED");
    expect(emailLogs[0].fromEmail).toBe("unassigned");
  });

  it("Pass 23 §22 — a genuine race: two truly concurrent first-send calls (real Promise.all) result in exactly ONE customer email, never two", async () => {
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    const [first, second] = await Promise.allSettled([sendAirlineConfirmationEmail("booking-1"), sendAirlineConfirmationEmail("booking-1")]);
    const results = [first, second];
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason.message).toMatch(/already been sent/i);
    // The real assertion: only one call ever reached sendEmail, regardless
    // of which one won the claim.
    expect(sendEmailCalls).toHaveLength(1);
  });

  it("a second call after the first already succeeded is rejected before ever sending a duplicate email", async () => {
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    await sendAirlineConfirmationEmail("booking-1");
    sendEmailCalls = [];
    emailLogs = [];

    await expect(sendAirlineConfirmationEmail("booking-1")).rejects.toThrow(/already been sent/i);
    expect(sendEmailCalls).toHaveLength(0);
  });
});

describe("sendAirlineConfirmationEmail — explicit resend", () => {
  it("a deliberate resend (resend: true) after a first send succeeds — the claim is not re-checked", async () => {
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    await sendAirlineConfirmationEmail("booking-1");
    sendEmailCalls = [];
    emailLogs = [];

    await sendAirlineConfirmationEmail("booking-1", { resend: true });
    expect(sendEmailCalls).toHaveLength(1);
    expect(emailLogs[0].status).toBe("SENT");
  });

  it("a rapid double-click on Resend itself is still blocked by the short recency check", async () => {
    recentSentLogs = [{ bookingId: "booking-1", createdAt: new Date() }];
    bookings.get("booking-1")!.airlineConfirmationFirstSentAt = new Date();
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    await expect(sendAirlineConfirmationEmail("booking-1", { resend: true })).rejects.toThrow(/just sent/i);
    expect(sendEmailCalls).toHaveLength(0);
  });
});

describe("sendAirlineConfirmationEmail — multiple confirmations", () => {
  it("builds the email with every saved confirmation entry, preserving order", async () => {
    const templates = await import("@/server/email/templates");
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    await sendAirlineConfirmationEmail("booking-multi");

    const call = vi.mocked(templates.buildBookingConfirmationEmail).mock.calls[0][0] as { confirmations: Array<{ confirmationNumber: string }> };
    expect(call.confirmations).toHaveLength(2);
    expect(call.confirmations[0].confirmationNumber).toBe("AA123");
    expect(call.confirmations[1].confirmationNumber).toBe("BB456");
  });
});
