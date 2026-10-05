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
let findFirstWheres: Array<Record<string, unknown>>;
let hiddenBookingIds: Set<string>;
let contactPrimaryEmail: string | null;
let contactEmails: Array<{ email: string; isPrimary: boolean }>;
let sendEmailResult: { ok: true; messageId: string } | { ok: false; error: string };

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
      findFirstWheres.push(where);
      const b = bookings.get(where.id);
      return b && !hiddenBookingIds.has(b.id) ? { id: b.id } : null;
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
        contact: { firstName: "Jane", lastName: "Traveler", primaryEmail: contactPrimaryEmail, emails: contactEmails },
        airlineConfirmationFirstSentAt: b.airlineConfirmationFirstSentAt,
        contactPhone: "555",
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
    updateMany: vi.fn(async (args: { where: { id: string; airlineConfirmationFirstSentAt?: null }; data: { airlineConfirmationFirstSentAt: Date | null } }) => {
      bookingUpdateManyCalls.push(args);
      const b = bookings.get(args.where.id);
      if (!b) return { count: 0 };
      // An unconditional write (the claim being given back after a failed first send).
      if (!("airlineConfirmationFirstSentAt" in args.where)) {
        b.airlineConfirmationFirstSentAt = args.data.airlineConfirmationFirstSentAt;
        return { count: 1 };
      }
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
    return sendEmailResult;
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
  findFirstWheres = [];
  hiddenBookingIds = new Set();
  contactPrimaryEmail = "jane@example.com";
  contactEmails = [{ email: "jane@example.com", isPrimary: true }];
  sendEmailResult = { ok: true, messageId: "msg-1" };
  vi.clearAllMocks();
});

describe("sendAirlineConfirmationEmail — authorization + preconditions", () => {
  it("rejects an unauthenticated actor", async () => {
    currentActor = null;
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    await expect(sendAirlineConfirmationEmail("booking-1")).rejects.toThrow(/not authorized/i);
  });

  it("rejects a role without the Quotes area (Marketing Agent) and an inactive account", async () => {
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    currentActor = { id: "m-1", role: "MARKETING_AGENT", status: "ACTIVE", companyId: "company-1" };
    await expect(sendAirlineConfirmationEmail("booking-1")).rejects.toThrow(/not authorized/i);
    currentActor = { id: "t-1", role: "TICKETING_AGENT", status: "INACTIVE", companyId: "company-1" };
    await expect(sendAirlineConfirmationEmail("booking-1")).rejects.toThrow(/not authorized/i);
    expect(sendEmailCalls).toHaveLength(0);
  });

  it("rejects a booking not visible to the actor (IDOR) as not-found, never leaking existence", async () => {
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    await expect(sendAirlineConfirmationEmail("no-such-booking")).rejects.toThrow(/not authorized/i);
  });

  it("rejects when there is no confirmation number at all (legacy field null, new array null)", async () => {
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    expect(await sendAirlineConfirmationEmail("booking-no-confirmation")).toEqual({ ok: false, error: expect.stringMatching(/Ticketed or Confirmed/i) });
  });

  it("returns (not throws) when the booking has no customer email on file at all", async () => {
    contactPrimaryEmail = null;
    contactEmails = [];
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    expect(await sendAirlineConfirmationEmail("booking-no-email")).toEqual({ ok: false, error: expect.stringMatching(/no customer email/i) });
    expect(sendEmailCalls).toHaveLength(0);
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
      contact: { firstName: "Jane", lastName: "Traveler", primaryEmail: "jane@example.com", emails: [] },
      airlineConfirmationFirstSentAt: null,
      passengers: [],
      paymentMethods: [],
      quote: fakeQuote({ sentByAgent: null }),
    }));
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    expect(await sendAirlineConfirmationEmail("booking-1")).toEqual({ ok: false, error: expect.stringMatching(/no original sender/i) });
    expect(sendEmailCalls).toHaveLength(0);
    expect(emailLogs).toHaveLength(1);
    expect(emailLogs[0].status).toBe("FAILED");
    expect(emailLogs[0].fromEmail).toBe("unassigned");
    // the first-send claim is given back: nothing went out, so Send must work again
    expect(bookings.get("booking-1")!.airlineConfirmationFirstSentAt).toBeNull();
  });

  it("Pass 23 §22 — a genuine race: two truly concurrent first-send calls (real Promise.all) result in exactly ONE customer email, never two", async () => {
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    const [first, second] = await Promise.allSettled([sendAirlineConfirmationEmail("booking-1"), sendAirlineConfirmationEmail("booking-1")]);
    const results = [first, second];
    const values = results.map((r) => (r as PromiseFulfilledResult<{ ok: boolean; error?: string }>).value);
    const succeeded = values.filter((v) => v.ok);
    const failed = values.filter((v) => !v.ok);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toMatch(/already been sent/i);
    // The real assertion: only one call ever reached sendEmail, regardless
    // of which one won the claim.
    expect(sendEmailCalls).toHaveLength(1);
  });

  it("a second call after the first already succeeded is rejected before ever sending a duplicate email", async () => {
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    await sendAirlineConfirmationEmail("booking-1");
    sendEmailCalls = [];
    emailLogs = [];

    expect(await sendAirlineConfirmationEmail("booking-1")).toEqual({ ok: false, error: expect.stringMatching(/already been sent/i) });
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
    expect(await sendAirlineConfirmationEmail("booking-1", { resend: true })).toEqual({ ok: false, error: expect.stringMatching(/just sent/i) });
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Customer airline-confirmation email — roles, recipients, sender, and strict separation from the
// internal "Notify Team of a New Sale" email.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const ROLES_WITH_QUOTES = ["TRAVEL_AGENT", "TICKETING_AGENT", "MANAGER", "ADMIN", "FLIGHT_EXPERT"] as const;

describe("sendAirlineConfirmationEmail — every role that has the Quotes area can use it", () => {
  it.each(ROLES_WITH_QUOTES)("%s: gets the recipient list and can send — a RETURNED ok result, never a thrown (masked #441) error", async (role) => {
    currentActor = { id: `${role}-1`, role, status: "ACTIVE", companyId: "company-1" };
    const { sendAirlineConfirmationEmail, getAirlineConfirmationRecipients } = await import("../bookings");
    const list = await getAirlineConfirmationRecipients("booking-1");
    expect(list.ok).toBe(true);
    expect(list.recipients.map((r) => r.email)).toEqual(["jane@example.com"]);
    const res = await sendAirlineConfirmationEmail("booking-1", { recipients: ["jane@example.com"] });
    expect(res).toEqual({ ok: true, sentTo: ["jane@example.com"] });
    expect(sendEmailCalls).toHaveLength(1);
  });

  it("a booking outside the viewer's row-level scope is refused for every role (IDOR), using the shared visibility filter", async () => {
    hiddenBookingIds = new Set(["booking-1"]);
    const { sendAirlineConfirmationEmail, getAirlineConfirmationRecipients } = await import("../bookings");
    for (const role of ROLES_WITH_QUOTES) {
      currentActor = { id: `${role}-1`, role, status: "ACTIVE", companyId: "company-1" };
      await expect(sendAirlineConfirmationEmail("booking-1", { recipients: ["jane@example.com"] })).rejects.toThrow(/not authorized/i);
      await expect(getAirlineConfirmationRecipients("booking-1")).rejects.toThrow(/not authorized/i);
    }
    expect(sendEmailCalls).toHaveLength(0);
    expect(emailLogs).toHaveLength(0);
    // the filter handed to the database is the viewer-scoped bookingVisibilityWhere, not just the id
    expect(findFirstWheres.some((w) => Array.isArray((w as { OR?: unknown }).OR))).toBe(true);
  });
});

describe("sendAirlineConfirmationEmail — the email goes ONLY to the selected customer addresses (no Cc, no Bcc)", () => {
  it("To = exactly the selected addresses; no bcc/cc key at all; Manager/Admin/all staff are never copied", async () => {
    // Staff exist and would have been the old Bcc audience — prove none of them is queried or used.
    (fakePrisma.account as { findMany: ReturnType<typeof vi.fn> }).findMany.mockImplementation(async () => [{ email: "admin@company.test" }, { email: "manager@company.test" }]);
    contactPrimaryEmail = "jane@example.com";
    contactEmails = [
      { email: "jane@example.com", isPrimary: true },
      { email: "alt@example.com", isPrimary: false },
    ];
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1" };
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    const res = await sendAirlineConfirmationEmail("booking-1", { recipients: ["alt@example.com", "jane@example.com"] });
    expect(res).toEqual({ ok: true, sentTo: ["jane@example.com", "alt@example.com"] });

    expect(sendEmailCalls).toHaveLength(1);
    const call = sendEmailCalls[0];
    expect(call.to).toBe("jane@example.com, alt@example.com");
    expect("bcc" in call).toBe(false);
    expect("cc" in call).toBe(false);
    expect(JSON.stringify(call)).not.toContain("admin@company.test");
    expect(JSON.stringify(call)).not.toContain("manager@company.test");
    expect((fakePrisma.account as { findMany: ReturnType<typeof vi.fn> }).findMany).not.toHaveBeenCalled();
    expect(emailLogs[0].toEmail).toBe("jane@example.com, alt@example.com");
  });

  it("sends to a single selected address when only one is ticked", async () => {
    contactEmails = [
      { email: "jane@example.com", isPrimary: true },
      { email: "alt@example.com", isPrimary: false },
    ];
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    await sendAirlineConfirmationEmail("booking-1", { recipients: ["alt@example.com"] });
    expect(sendEmailCalls[0].to).toBe("alt@example.com");
  });

  it("an omitted recipient list uses the documented default: the signed Booking Form address only", async () => {
    contactEmails = [
      { email: "jane@example.com", isPrimary: true },
      { email: "alt@example.com", isPrimary: false },
    ];
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    const res = await sendAirlineConfirmationEmail("booking-1");
    expect(res).toEqual({ ok: true, sentTo: ["jane@example.com"] });
    expect(sendEmailCalls[0].to).toBe("jane@example.com");
  });

  it("an EMPTY selection is refused with a clear message and nothing is claimed, sent or logged", async () => {
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    expect(await sendAirlineConfirmationEmail("booking-1", { recipients: [] })).toEqual({ ok: false, error: "Select at least one email address." });
    expect(sendEmailCalls).toHaveLength(0);
    expect(emailLogs).toHaveLength(0);
    expect(bookingUpdateManyCalls).toHaveLength(0);
    expect(bookings.get("booking-1")!.airlineConfirmationFirstSentAt).toBeNull();
  });

  it("a hand-typed / foreign address, a CRM user's address, or a manipulated list is rejected — never passed to the mail transport", async () => {
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    const attempts: unknown[] = [
      ["attacker@evil.test"],
      ["jane@example.com", "attacker@evil.test"],
      ["admin@company.test"],
      ["jane@example.com\r\nBcc: x@evil.test"],
      [123],
      "jane@example.com",
    ];
    for (const bad of attempts) {
      const res = await sendAirlineConfirmationEmail("booking-1", { recipients: bad as string[] });
      expect(res.ok).toBe(false);
    }
    expect(sendEmailCalls).toHaveLength(0);
    expect(bookings.get("booking-1")!.airlineConfirmationFirstSentAt).toBeNull();
  });

  it("case and whitespace differences resolve to the same stored address (and duplicates collapse)", async () => {
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    const res = await sendAirlineConfirmationEmail("booking-1", { recipients: ["  JANE@Example.COM ", "jane@example.com"] });
    expect(res).toEqual({ ok: true, sentTo: ["jane@example.com"] });
    expect(sendEmailCalls[0].to).toBe("jane@example.com");
  });

  it("Resend uses the CURRENT selection, not the earlier send's recipients", async () => {
    contactEmails = [
      { email: "jane@example.com", isPrimary: true },
      { email: "alt@example.com", isPrimary: false },
    ];
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    await sendAirlineConfirmationEmail("booking-1", { recipients: ["jane@example.com"] });
    sendEmailCalls = [];
    const res = await sendAirlineConfirmationEmail("booking-1", { resend: true, recipients: ["alt@example.com"] });
    expect(res).toEqual({ ok: true, sentTo: ["alt@example.com"] });
    expect(sendEmailCalls[0].to).toBe("alt@example.com");
  });
});

describe("sendAirlineConfirmationEmail — sender", () => {
  it("is always the quote's own creator (sentByAgent), whoever clicked — and the client cannot choose it", async () => {
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    for (const role of ROLES_WITH_QUOTES) {
      currentActor = { id: `clicker-${role}`, role, status: "ACTIVE", companyId: "company-1" };
      sendEmailCalls = [];
      bookings.get("booking-1")!.airlineConfirmationFirstSentAt = null;
      // forged extra options are simply ignored: the action reads only `resend` and `recipients`
      await sendAirlineConfirmationEmail("booking-1", { recipients: ["jane@example.com"], accountId: "someone-else", from: "x@evil.test", bcc: "y@evil.test" } as never);
      expect(sendEmailCalls[0].accountId).toBe("sender-1");
      expect(sendEmailCalls[0].replyTo).toBe("andrew@example.com");
      expect(sendEmailCalls[0].senderName).toBe("Andrew Kent");
      expect("bcc" in sendEmailCalls[0]).toBe(false);
    }
  });

  it("the recipient lookup shows who it will be sent from (the creator), never the clicking user", async () => {
    currentActor = { id: "ticketing-9", role: "TICKETING_AGENT", status: "ACTIVE", companyId: "company-1" };
    const { getAirlineConfirmationRecipients } = await import("../bookings");
    const res = await getAirlineConfirmationRecipients("booking-1");
    expect(res.sender).toEqual({ fullName: "Andrew Kent", email: "andrew@example.com" });
  });
});

describe("sendAirlineConfirmationEmail — Gmail failures are reported honestly and don't burn the first send", () => {
  it("a Gmail rejection returns the error, logs FAILED, never claims success, and the next Send works", async () => {
    sendEmailResult = { ok: false, error: "Gmail is not connected. Connect Gmail to send emails from your account." };
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    const res = await sendAirlineConfirmationEmail("booking-1", { recipients: ["jane@example.com"] });
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/Gmail is not connected/) });
    expect(emailLogs).toHaveLength(1);
    expect(emailLogs[0].status).toBe("FAILED");
    expect(emailLogs[0].errorMessage).toMatch(/Gmail is not connected/);
    expect(bookings.get("booking-1")!.airlineConfirmationFirstSentAt).toBeNull();

    sendEmailResult = { ok: true, messageId: "msg-2" };
    const retry = await sendAirlineConfirmationEmail("booking-1", { recipients: ["jane@example.com"] });
    expect(retry.ok).toBe(true);
  });

  it("an unexpected exception inside the mail transport is also a returned failure, not a crash", async () => {
    const service = await import("@/server/email/service");
    vi.mocked(service.sendEmail).mockRejectedValueOnce(new Error("socket hang up"));
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    const res = await sendAirlineConfirmationEmail("booking-1", { recipients: ["jane@example.com"] });
    expect(res.ok).toBe(false);
    expect(emailLogs[0].status).toBe("FAILED");
    expect(bookings.get("booking-1")!.airlineConfirmationFirstSentAt).toBeNull();
  });

  it("the log and the customer-facing payload carry no card data", async () => {
    const { sendAirlineConfirmationEmail } = await import("../bookings");
    await sendAirlineConfirmationEmail("booking-1", { recipients: ["jane@example.com"] });
    const blob = JSON.stringify({ emailLogs, sendEmailCalls });
    expect(blob).not.toMatch(/cvv|cvc|encryptedPan/i);
  });
});

describe("getAirlineConfirmationRecipients — what the dialog shows", () => {
  it("lists the Booking Form address and every valid Contact address once, never a CRM user, and pre-selects the Booking Form address", async () => {
    (fakePrisma.account as { findMany: ReturnType<typeof vi.fn> }).findMany.mockImplementation(async () => [{ email: "admin@company.test" }]);
    contactPrimaryEmail = "JANE@example.com";
    contactEmails = [
      { email: "jane@example.com", isPrimary: true },
      { email: " alt@example.com ", isPrimary: false },
      { email: "not-an-email", isPrimary: false },
    ];
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1" };
    const { getAirlineConfirmationRecipients } = await import("../bookings");
    const res = await getAirlineConfirmationRecipients("booking-1");
    expect(res.recipients).toEqual([
      { email: "jane@example.com", sources: ["booking-form", "contact"] },
      { email: "alt@example.com", sources: ["contact"] },
    ]);
    expect(res.defaultSelected).toEqual(["jane@example.com"]);
    expect(res.hasSentBefore).toBe(false);
    expect(JSON.stringify(res)).not.toContain("admin@company.test");
  });

  it("without a Booking Form address the Contact's primary address is the default; with nothing valid, nothing is pre-selected", async () => {
    bookings.get("booking-1")!.contactEmail = null;
    contactPrimaryEmail = "primary@example.com";
    contactEmails = [
      { email: "primary@example.com", isPrimary: true },
      { email: "other@example.com", isPrimary: false },
    ];
    const { getAirlineConfirmationRecipients } = await import("../bookings");
    expect((await getAirlineConfirmationRecipients("booking-1")).defaultSelected).toEqual(["primary@example.com"]);
    contactPrimaryEmail = null;
    contactEmails = [{ email: "other@example.com", isPrimary: false }];
    const res = await getAirlineConfirmationRecipients("booking-1");
    expect(res.recipients.map((r) => r.email)).toEqual(["other@example.com"]);
    expect(res.defaultSelected).toEqual([]);
  });
});
