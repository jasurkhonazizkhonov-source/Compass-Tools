import { describe, it, expect, vi, beforeEach } from "vitest";

// Part 14 — the true final "actually cancelled" Ticketing-area action.
// No dedicated regression coverage existed for this function before this
// pass (caught while auditing Item 31's checklist) despite it being a
// security-sensitive, ticketing-only-gated action already live-verified
// end to end in the browser. These tests cover the authorization gate, the
// precondition chain (must be CANCELLATION_SUBMITTED, must have a
// confirmed cancellation request, must have a contact email), and confirm
// the Quote only ever transitions to CANCELLATION_CONFIRMED once the email
// actually sends — never on a failed send.

type FakeBooking = {
  id: string;
  leadId: string;
  contactId: string;
  contactEmail: string | null;
  quoteStatus: string;
  hasConfirmedRequest: boolean;
};

let bookings: Map<string, FakeBooking>;
let currentActor: { id: string; role: string; status: string; companyId: string } | null;
let emailLogs: Array<Record<string, unknown>>;
let sendEmailCalls: Array<Record<string, unknown>>;
let quoteUpdateCalls: Array<Record<string, unknown>>;
let quoteUpdateManyCalls: Array<Record<string, unknown>>;

const AGENT = { id: "agent-1", fullName: "Andrew Kent", email: "andrew@example.com", phone: null };

function fakeQuote(b: FakeBooking) {
  return {
    id: "quote-1",
    status: b.quoteStatus,
    agent: AGENT,
    itinerary: {
      segments: [
        {
          id: "seg-1",
          isExtraLeg: false,
          arrivalAirport: { city: "New York", country: "United States", iata: "JFK" },
          departureAirport: { city: "Los Angeles", country: "United States", iata: "LAX" },
          airline: null,
          airlineCodeRaw: "AA",
          aircraftType: null,
          aircraftRaw: null,
          flightNumber: "AA100",
          cabin: "FIRST",
          bookingClass: null,
          departureAt: new Date(),
          arrivalAt: new Date(),
          durationMinutes: 300,
          connectionType: null,
          operatingCarrierName: null,
        },
      ],
    },
    cancellationRequests: b.hasConfirmedRequest ? [{ id: "req-1", segmentIds: ["seg-1"], reviewedAt: new Date() }] : [],
  };
}

// Pass 22 — sendCancellationConfirmationEmail now atomically claims the
// CANCELLATION_SUBMITTED -> CANCELLATION_CONFIRMED transition BEFORE
// sending (closing a duplicate-send race), reverting via a plain
// `quote.update` back to CANCELLATION_SUBMITTED if the send fails. This
// tracks whichever single booking's fake quote status the currently-
// running test is exercising, so `quote.updateMany`'s conditional match
// (and the revert-on-failure update) reflect it correctly — every test in
// this file only ever exercises one booking at a time.
let activeBooking: FakeBooking | null = null;

const fakePrisma: Record<string, unknown> = {
  booking: {
    findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
      const b = bookings.get(where.id);
      return b ? { id: b.id } : null;
    }),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
      const b = bookings.get(where.id);
      if (!b) throw new Error("not found");
      activeBooking = b;
      return {
        id: b.id,
        leadId: b.leadId,
        contactId: b.contactId,
        contactEmail: b.contactEmail,
        contact: { firstName: "Jasur" },
        quote: fakeQuote(b),
      };
    }),
  },
  quote: {
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      quoteUpdateCalls.push(args);
      if (activeBooking && typeof args.data.status === "string") activeBooking.quoteStatus = args.data.status;
      return {};
    }),
    updateMany: vi.fn(async (args: { where: { id: string; status?: string }; data: Record<string, unknown> }) => {
      quoteUpdateManyCalls.push(args);
      if (!activeBooking) return { count: 0 };
      if (args.where.status !== undefined && activeBooking.quoteStatus !== args.where.status) return { count: 0 };
      if (typeof args.data.status === "string") activeBooking.quoteStatus = args.data.status;
      return { count: 1 };
    }),
  },
  quoteStatusHistory: {
    create: vi.fn(async () => ({})),
  },
  $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
};

vi.mock("@/lib/prisma", () => ({ prisma: fakePrisma }));
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/queries/company", () => ({
  getCompanyForAccountId: vi.fn(async () => ({ name: "Compass Tools", brandColor: "#1c3a5e", logoEmailUrl: null, website: null, phone: null, signatureTemplate: "{{first_name}} {{last_name}}\n{{phone_number}}" })),
  getCompanyForContactId: vi.fn(async () => ({ name: "Compass Tools", brandColor: "#1c3a5e", logoEmailUrl: null, website: null, phone: null, signatureTemplate: "{{first_name}} {{last_name}}\n{{phone_number}}" })),
}));
vi.mock("@/server/email/service", () => ({
  sendEmail: vi.fn(async (args: Record<string, unknown>) => {
    sendEmailCalls.push(args);
    return { ok: true, messageId: "msg-1" };
  }),
}));

beforeEach(() => {
  bookings = new Map([
    ["booking-1", { id: "booking-1", leadId: "lead-1", contactId: "contact-1", contactEmail: "jasur@example.com", quoteStatus: "CANCELLATION_SUBMITTED", hasConfirmedRequest: true }],
    ["booking-not-submitted", { id: "booking-not-submitted", leadId: "lead-1", contactId: "contact-1", contactEmail: "jasur@example.com", quoteStatus: "CANCELLATION_FORM_SENT", hasConfirmedRequest: true }],
    ["booking-no-request", { id: "booking-no-request", leadId: "lead-1", contactId: "contact-1", contactEmail: "jasur@example.com", quoteStatus: "CANCELLATION_SUBMITTED", hasConfirmedRequest: false }],
    ["booking-no-email", { id: "booking-no-email", leadId: "lead-1", contactId: "contact-1", contactEmail: null, quoteStatus: "CANCELLATION_SUBMITTED", hasConfirmedRequest: true }],
  ]);
  currentActor = { id: "ticketing-1", role: "TICKETING_AGENT", status: "ACTIVE", companyId: "company-1" };
  emailLogs = [];
  sendEmailCalls = [];
  quoteUpdateCalls = [];
  quoteUpdateManyCalls = [];
  activeBooking = null;
  fakePrisma.emailLog = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      emailLogs.push(data);
      return {};
    }),
  };
  vi.clearAllMocks();
});

describe("sendCancellationConfirmationEmail — authorization + preconditions", () => {
  it("rejects an unauthenticated actor", async () => {
    currentActor = null;
    const { sendCancellationConfirmationEmail } = await import("../bookings");
    await expect(sendCancellationConfirmationEmail("booking-1")).rejects.toThrow(/not authorized/i);
  });

  it("rejects a role that cannot enter ticketing info (e.g. Travel Agent)", async () => {
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1" };
    const { sendCancellationConfirmationEmail } = await import("../bookings");
    await expect(sendCancellationConfirmationEmail("booking-1")).rejects.toThrow(/not authorized/i);
  });

  it("rejects a booking not visible to the actor (IDOR) as not-found, never leaking existence", async () => {
    const { sendCancellationConfirmationEmail } = await import("../bookings");
    await expect(sendCancellationConfirmationEmail("no-such-booking")).rejects.toThrow(/not authorized/i);
  });

  it("rejects when the customer hasn't confirmed the cancellation yet (quote not CANCELLATION_SUBMITTED)", async () => {
    const { sendCancellationConfirmationEmail } = await import("../bookings");
    await expect(sendCancellationConfirmationEmail("booking-not-submitted")).rejects.toThrow(/must confirm the cancellation/i);
  });

  it("rejects when no confirmed cancellation request can be found for the quote", async () => {
    const { sendCancellationConfirmationEmail } = await import("../bookings");
    await expect(sendCancellationConfirmationEmail("booking-no-request")).rejects.toThrow(/No approved cancellation request/i);
  });

  it("rejects when the booking has no customer email on file", async () => {
    const { sendCancellationConfirmationEmail } = await import("../bookings");
    await expect(sendCancellationConfirmationEmail("booking-no-email")).rejects.toThrow(/no customer email/i);
  });

  it("on success: sends the TRUE final email, transitions Quote.status to CANCELLATION_CONFIRMED, and logs the email as SENT", async () => {
    const { sendCancellationConfirmationEmail } = await import("../bookings");
    await sendCancellationConfirmationEmail("booking-1");

    expect(sendEmailCalls).toHaveLength(1);
    expect(sendEmailCalls[0].accountId).toBe("agent-1");
    expect(emailLogs).toHaveLength(1);
    expect(emailLogs[0].status).toBe("SENT");
    // Pass 22 fix — the transition is now an atomic updateMany CLAIM made
    // BEFORE the send (not a plain update afterward), so the send never
    // races a concurrent second call. No revert (plain `update`) happens
    // on success.
    expect(quoteUpdateManyCalls).toHaveLength(1);
    expect((quoteUpdateManyCalls[0].data as Record<string, unknown>).status).toBe("CANCELLATION_CONFIRMED");
    expect(quoteUpdateCalls).toHaveLength(0);
  });

  it("on a failed send: reverts the claim back to CANCELLATION_SUBMITTED, logs the failure, and still throws", async () => {
    const emailService = await import("@/server/email/service");
    vi.mocked(emailService.sendEmail).mockImplementationOnce(async (args) => {
      sendEmailCalls.push(args as Record<string, unknown>);
      return { ok: false, error: "Your Gmail authorization has expired or been revoked. Please reconnect Gmail." };
    });
    const { sendCancellationConfirmationEmail } = await import("../bookings");
    await expect(sendCancellationConfirmationEmail("booking-1")).rejects.toThrow(/expired or been revoked/i);

    expect(emailLogs).toHaveLength(1);
    expect(emailLogs[0].status).toBe("FAILED");
    // Pass 22 fix — the claim (updateMany) DID fire before the send (that's
    // what makes the race-safety work), but since the send failed, a
    // separate plain `update` reverts it back to CANCELLATION_SUBMITTED —
    // preserving the pre-existing "just click Send again" retry behavior.
    expect(quoteUpdateManyCalls).toHaveLength(1);
    expect(quoteUpdateCalls).toHaveLength(1);
    expect((quoteUpdateCalls[0].data as Record<string, unknown>).status).toBe("CANCELLATION_SUBMITTED");
  });

  it("Pass 22 — a second call after the first already succeeded is rejected before ever sending a duplicate email", async () => {
    // Same scope note as booking-retry.test.ts/cancellation.test.ts's
    // equivalent tests: this synchronous fake can't reproduce the exact
    // "both calls' read already saw CANCELLATION_SUBMITTED before either
    // write landed" interleaving a real concurrent Postgres race would
    // hit — what's provable here is that a second call can never re-send
    // once the first has gone through, which is what the new atomic
    // `quote.updateMany` claim (made BEFORE the send, not after) actually
    // guarantees against a real database's WHERE-clause semantics.
    const { sendCancellationConfirmationEmail } = await import("../bookings");
    await sendCancellationConfirmationEmail("booking-1");
    sendEmailCalls = [];
    emailLogs = [];

    await expect(sendCancellationConfirmationEmail("booking-1")).rejects.toThrow(/must confirm the cancellation/i);
    expect(sendEmailCalls).toHaveLength(0); // no second email sent
  });
});
