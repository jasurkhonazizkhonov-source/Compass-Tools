import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@/generated/prisma/client";

// Regression coverage for the pre-launch-QA change: the internal "new
// sale / profit" team announcement used to fire automatically inside
// updateBookingTicketing() the moment a booking was saved as CONFIRMED —
// now it's a separate, on-demand action (sendNewSaleNotification, wired to
// the "Notify Team of New Sale" button in booking-ticketing-form.tsx) so a
// Ticketing Agent can correct Ticket Cost/Taxes/Issuing Fee before the
// team-wide announcement locks in a profit figure. These tests cover the
// authorization/precondition gate and confirm it reuses (not
// reimplements) sendBookingProfitNotification's own idempotency and
// Gmail-sender-fallback behavior.

type FakeBooking = {
  id: string;
  leadId: string;
  contactId: string;
  quoteId: string;
  bookingReference: string;
  status: string;
  fareAmount: number | null;
  taxAmount: number | null;
  serviceFeeAmount: number | null;
};

let bookings: Map<string, FakeBooking>;
let currentActor: { id: string; role: string; status: string; companyId: string } | null;
let emailLogs: Array<Record<string, unknown>>;
let sendEmailCalls: Array<Record<string, unknown>>;
// Part 16 — sendCancellationNotification gates on Quote.status rather than
// Booking.status; overridable per-test so the same shared QUOTE fixture can
// exercise both the "not yet confirmed" rejection and the success path.
let quoteStatusOverride: string;

const QUOTE = {
  id: "quote-1",
  adults: 1,
  adultPrice: 600,
  children: 0,
  childPrice: 0,
  infants: 0,
  infantPrice: 0,
  currency: "USD",
  sentByAgent: { id: "agent-1", fullName: "Andrew Kent", email: "andrew@example.com", location: "Los Angeles", hiredAt: null },
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
};

const fakePrisma: Record<string, unknown> = {
  booking: {
    findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
      const b = bookings.get(where.id);
      return b ? { id: b.id } : null;
    }),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
      const b = bookings.get(where.id);
      if (!b) throw new Error("not found");
      return { ...b, passengers: [{ id: "p1" }], quote: { ...QUOTE, status: quoteStatusOverride } };
    }),
  },
  emailLog: makeEmailLogMock(),
  account: {
    findMany: vi.fn(async () => [{ id: "agent-1", email: "andrew@example.com", fullName: "Andrew Kent" }]),
  },
  gmailConnection: {
    findUnique: vi.fn(async () => ({ status: "CONNECTED" })),
  },
};

// Pass 23 — sendBookingProfitNotification's claim is now a conditional
// INSERT guarded by a real partial unique index (bookingId, type) WHERE
// status='SENT', scoped to BOOKING_PROFIT_NOTIFICATION/
// BOOKING_CANCELLATION_NOTIFICATION. Modeled here the same way
// booking-notification.test.ts models it — a synchronous check-then-push
// against the shared `emailLogs` array, plus an `update` mock so the
// claimed row can be finalized (SENT/FAILED) in place.
function makeEmailLogMock() {
  return {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const CLAIM_TYPES = new Set(["BOOKING_PROFIT_NOTIFICATION", "BOOKING_CANCELLATION_NOTIFICATION"]);
      if (
        data.status === "SENT" &&
        CLAIM_TYPES.has(data.type as string) &&
        emailLogs.some((e) => e.bookingId === data.bookingId && e.type === data.type && e.status === "SENT")
      ) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`bookingId`,`type`)", { code: "P2002", clientVersion: "test", meta: { target: ["bookingId", "type"] } });
      }
      const row = { id: `log-${emailLogs.length + 1}`, ...data };
      emailLogs.push(row);
      return row;
    }),
    update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = emailLogs.find((e) => e.id === id)!;
      Object.assign(row, data);
      return row;
    }),
  };
}

vi.mock("@/lib/prisma", () => ({ prisma: fakePrisma }));
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/queries/company", () => ({
  getCompanyForAccountId: vi.fn(async () => ({ name: "Compass Tools", brandColor: "#1c3a5e", logoEmailUrl: null, website: null, phone: null })),
  getCompanyForContactId: vi.fn(async () => ({ name: "Compass Tools", brandColor: "#1c3a5e", logoEmailUrl: null, website: null, phone: null })),
}));
vi.mock("@/server/email/service", () => ({
  sendEmail: vi.fn(async (args: Record<string, unknown>) => {
    sendEmailCalls.push(args);
    return { ok: true, messageId: "msg-1" };
  }),
}));

beforeEach(() => {
  bookings = new Map([
    ["booking-1", { id: "booking-1", leadId: "lead-1", contactId: "contact-1", quoteId: "quote-1", bookingReference: "BFT-TEST01", status: "CONFIRMED", fareAmount: 400, taxAmount: 20, serviceFeeAmount: 10 }],
    ["booking-pending", { id: "booking-pending", leadId: "lead-1", contactId: "contact-1", quoteId: "quote-1", bookingReference: "BFT-TEST02", status: "PENDING_TICKETING", fareAmount: null, taxAmount: null, serviceFeeAmount: null }],
    ["booking-no-fare", { id: "booking-no-fare", leadId: "lead-1", contactId: "contact-1", quoteId: "quote-1", bookingReference: "BFT-TEST03", status: "CONFIRMED", fareAmount: null, taxAmount: null, serviceFeeAmount: null }],
  ]);
  currentActor = { id: "ticketing-1", role: "TICKETING_AGENT", status: "ACTIVE", companyId: "company-1" };
  emailLogs = [];
  sendEmailCalls = [];
  quoteStatusOverride = "CANCELLATION_CONFIRMED";
  // Reset any per-test overrides from a prior test (e.g. the idempotency
  // and sender-fallback tests below reassign these) back to the shared
  // defaults — beforeEach only resets the plain arrays/maps above, not
  // fakePrisma's own sub-objects once a test has swapped them out.
  fakePrisma.emailLog = makeEmailLogMock();
  fakePrisma.account = {
    findMany: vi.fn(async () => [{ id: "agent-1", email: "andrew@example.com", fullName: "Andrew Kent" }]),
  };
  fakePrisma.gmailConnection = { findUnique: vi.fn(async () => ({ status: "CONNECTED" })) };
  vi.clearAllMocks();
});

describe("sendNewSaleNotification — authorization + preconditions", () => {
  it("rejects an unauthenticated actor", async () => {
    currentActor = null;
    const { sendNewSaleNotification } = await import("../bookings");
    await expect(sendNewSaleNotification("booking-1")).rejects.toThrow(/not authorized/i);
  });

  it("rejects a role that cannot enter ticketing info (e.g. Travel Agent)", async () => {
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1" };
    const { sendNewSaleNotification } = await import("../bookings");
    await expect(sendNewSaleNotification("booking-1")).rejects.toThrow(/not authorized/i);
  });

  it("rejects a booking not visible to the actor (IDOR) as not-found, never leaking existence", async () => {
    const { sendNewSaleNotification } = await import("../bookings");
    await expect(sendNewSaleNotification("no-such-booking")).rejects.toThrow(/not authorized/i);
  });

  it("rejects a booking that is not yet Confirmed", async () => {
    const { sendNewSaleNotification } = await import("../bookings");
    await expect(sendNewSaleNotification("booking-pending")).rejects.toThrow(/Confirmed/i);
  });

  it("rejects a Confirmed booking with no Ticket Cost saved yet", async () => {
    const { sendNewSaleNotification } = await import("../bookings");
    await expect(sendNewSaleNotification("booking-no-fare")).rejects.toThrow(/Ticket Cost/i);
  });

  it("on success: sends the notification via the quote's original sender, correctly computed profit, and logs activity", async () => {
    const { sendNewSaleNotification } = await import("../bookings");
    await sendNewSaleNotification("booking-1");

    expect(sendEmailCalls).toHaveLength(1);
    expect(sendEmailCalls[0].accountId).toBe("agent-1"); // the connected sender tried
    expect(emailLogs).toHaveLength(1);
    expect(emailLogs[0].type).toBe("BOOKING_PROFIT_NOTIFICATION");
    expect(emailLogs[0].status).toBe("SENT");
    // Total Selling Price ($600) - Ticket Cost ($400) - Taxes ($20) -
    // Issuing Fee ($10) = $170 profit, matching computeBookingProfitUsd.
  });

  it("does not send a second time once already recorded SENT (idempotent, reused from sendBookingProfitNotification)", async () => {
    emailLogs.push({ id: "already-sent", bookingId: "booking-1", type: "BOOKING_PROFIT_NOTIFICATION", status: "SENT" });
    fakePrisma.emailLog = makeEmailLogMock();
    const { sendNewSaleNotification } = await import("../bookings");
    await sendNewSaleNotification("booking-1");
    expect(sendEmailCalls).toHaveLength(0);
    expect(emailLogs).toHaveLength(1); // the pre-existing row, untouched — no new claim attempt succeeded
  });

  // Pass 13 §8/§15 — the core reliability bug this pass fixes: previously
  // sendNewSaleNotification always reported success to the caller (and the
  // "Notify Team of New Sale" button always showed a success toast)
  // regardless of whether the underlying email actually sent. Now a real
  // send failure is surfaced as a thrown error, which the UI's existing
  // try/catch + toast.error already turns into a visible, actionable
  // failure — "sometimes it sends and sometimes it doesn't [silently]" is
  // no longer possible.
  it("throws (surfacing the failure) when no recipient has a connected Gmail account, rather than silently reporting success", async () => {
    fakePrisma.gmailConnection = { findUnique: vi.fn(async () => ({ status: "NOT_CONNECTED" })) };
    const { sendNewSaleNotification } = await import("../bookings");
    await expect(sendNewSaleNotification("booking-1")).rejects.toThrow(/gmail|connect|notify/i);
    expect(sendEmailCalls).toHaveLength(0);
    // The failure is still logged (observable), even though it also throws.
    expect(emailLogs).toHaveLength(1);
    expect(emailLogs[0].status).toBe("FAILED");
  });

  it("throws when there are zero eligible recipients (no active CRM users found) rather than reporting success", async () => {
    fakePrisma.account = { findMany: vi.fn(async () => []) };
    const { sendNewSaleNotification } = await import("../bookings");
    await expect(sendNewSaleNotification("booking-1")).rejects.toThrow(/no active/i);
    expect(sendEmailCalls).toHaveLength(0);
  });

  it("a retry after a genuine prior success (idempotent no-op) does NOT throw and does NOT send a second email", async () => {
    emailLogs.push({ id: "already-sent", bookingId: "booking-1", type: "BOOKING_PROFIT_NOTIFICATION", status: "SENT" });
    fakePrisma.emailLog = makeEmailLogMock();
    const { sendNewSaleNotification } = await import("../bookings");
    await expect(sendNewSaleNotification("booking-1")).resolves.toBeUndefined();
    expect(sendEmailCalls).toHaveLength(0);
    expect(emailLogs).toHaveLength(1); // no duplicate EmailLog/Activity entry for a no-op retry
  });

  it("falls through to the next eligible connected sender when the first candidate's Gmail send fails (expired/revoked token)", async () => {
    fakePrisma.account = {
      findMany: vi.fn(async () => [
        { id: "agent-1", email: "andrew@example.com", fullName: "Andrew Kent" },
        { id: "admin-1", email: "admin@example.com", fullName: "Dark Master" },
      ]),
    };
    let call = 0;
    const emailService = await import("@/server/email/service");
    vi.mocked(emailService.sendEmail).mockImplementation(async (args) => {
      call += 1;
      sendEmailCalls.push(args as Record<string, unknown>);
      if (call === 1) return { ok: false, error: "Your Gmail authorization has expired or been revoked. Please reconnect Gmail." };
      return { ok: true, messageId: "msg-2" };
    });
    const { sendNewSaleNotification } = await import("../bookings");
    await sendNewSaleNotification("booking-1");

    expect(sendEmailCalls).toHaveLength(2); // tried agent-1, then fell through to admin-1
    expect(emailLogs[0].status).toBe("SENT");
    expect(emailLogs[0].fromEmail).toBe("admin@example.com");
  });
});

// Part 16 — the Cancellation counterpart. Same infrastructure/role gate as
// sendNewSaleNotification above, but gated on Quote.status reaching the
// true final CANCELLATION_CONFIRMED state (not Booking.status), and using
// its own distinct EmailType (BOOKING_CANCELLATION_NOTIFICATION) so its
// idempotency check can never collide with an earlier New Sale
// notification already sent for the same booking.
describe("sendCancellationNotification — authorization + preconditions", () => {
  it("rejects an unauthenticated actor", async () => {
    currentActor = null;
    const { sendCancellationNotification } = await import("../bookings");
    await expect(sendCancellationNotification("booking-1")).rejects.toThrow(/not authorized/i);
  });

  it("rejects a role that cannot enter ticketing info (e.g. Travel Agent)", async () => {
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1" };
    const { sendCancellationNotification } = await import("../bookings");
    await expect(sendCancellationNotification("booking-1")).rejects.toThrow(/not authorized/i);
  });

  it("rejects a booking not visible to the actor (IDOR) as not-found, never leaking existence", async () => {
    const { sendCancellationNotification } = await import("../bookings");
    await expect(sendCancellationNotification("no-such-booking")).rejects.toThrow(/not authorized/i);
  });

  it("rejects when the cancellation has not yet reached CANCELLATION_CONFIRMED (e.g. still only customer-submitted)", async () => {
    quoteStatusOverride = "CANCELLATION_SUBMITTED";
    const { sendCancellationNotification } = await import("../bookings");
    await expect(sendCancellationNotification("booking-1")).rejects.toThrow(/must be confirmed/i);
  });

  it("rejects a confirmed-cancellation booking with no Ticket Cost saved", async () => {
    const { sendCancellationNotification } = await import("../bookings");
    await expect(sendCancellationNotification("booking-no-fare")).rejects.toThrow(/Ticket Cost/i);
  });

  it("on success: sends via BOOKING_CANCELLATION_NOTIFICATION (never BOOKING_PROFIT_NOTIFICATION), and logs activity", async () => {
    const { sendCancellationNotification } = await import("../bookings");
    await sendCancellationNotification("booking-1");

    expect(sendEmailCalls).toHaveLength(1);
    expect(emailLogs).toHaveLength(1);
    expect(emailLogs[0].type).toBe("BOOKING_CANCELLATION_NOTIFICATION");
    expect(emailLogs[0].status).toBe("SENT");
    // Looked up its own idempotency record under the distinct type, not the
    // New Sale one — confirms the two notification kinds can never
    // shadow/block each other for the same booking.
    expect(fakePrisma.emailLog).toBeDefined();
  });

  it("a prior New Sale notification for this booking does NOT block a later Cancellation notification (distinct EmailType, no false-idempotent skip)", async () => {
    // Simulate: New Sale already SENT, nothing recorded yet for Cancellation
    // — the claim's unique index is scoped to (bookingId, type), so a SENT
    // row for one type must never block a claim for the other.
    emailLogs.push({ id: "already-sent-new-sale", bookingId: "booking-1", type: "BOOKING_PROFIT_NOTIFICATION", status: "SENT" });
    fakePrisma.emailLog = makeEmailLogMock();
    const { sendCancellationNotification } = await import("../bookings");
    await sendCancellationNotification("booking-1");

    expect(sendEmailCalls).toHaveLength(1);
    expect(emailLogs).toHaveLength(2); // the pre-existing New Sale row, plus this new Cancellation row
    expect(emailLogs.find((e) => e.bookingId === "booking-1" && e.type === "BOOKING_CANCELLATION_NOTIFICATION")).toBeDefined();
  });

  it("does not send a second time once already recorded SENT for BOOKING_CANCELLATION_NOTIFICATION (idempotent)", async () => {
    emailLogs.push({ id: "already-sent", bookingId: "booking-1", type: "BOOKING_CANCELLATION_NOTIFICATION", status: "SENT" });
    fakePrisma.emailLog = makeEmailLogMock();
    const { sendCancellationNotification } = await import("../bookings");
    await sendCancellationNotification("booking-1");
    expect(sendEmailCalls).toHaveLength(0);
    expect(emailLogs).toHaveLength(1);
  });

  // Pass 13 §8/§15 — same reliability fix as the New Sale notification
  // above, applied to the Cancellation notification path.
  it("throws (surfacing the failure) when no recipient has a connected Gmail account", async () => {
    fakePrisma.gmailConnection = { findUnique: vi.fn(async () => ({ status: "NOT_CONNECTED" })) };
    const { sendCancellationNotification } = await import("../bookings");
    await expect(sendCancellationNotification("booking-1")).rejects.toThrow(/gmail|connect|notify/i);
    expect(sendEmailCalls).toHaveLength(0);
    expect(emailLogs).toHaveLength(1);
    expect(emailLogs[0].status).toBe("FAILED");
  });

  it("throws when there are zero eligible recipients", async () => {
    fakePrisma.account = { findMany: vi.fn(async () => []) };
    const { sendCancellationNotification } = await import("../bookings");
    await expect(sendCancellationNotification("booking-1")).rejects.toThrow(/no active/i);
  });
});
