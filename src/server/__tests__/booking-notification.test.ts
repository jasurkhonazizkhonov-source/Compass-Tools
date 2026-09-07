import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import type { BookingNotificationParams } from "../booking-notification";

// In-memory fake Prisma, same convention as other server-side test files
// in this project. Exercises sendBookingSignedNotification() in isolation
// — the function extracted out of submitBooking() so its reliability
// properties (never throws, never double-sends) are testable without
// simulating the entire card-validation/pricing pipeline.

type FakeAccount = { id: string; email: string; fullName: string; role: string; status: string; companyId: string };
type FakeEmailLog = { id: string; bookingId: string; type: string; status: string; toEmail?: string };

let accounts: Map<string, FakeAccount>;
let emailLogs: FakeEmailLog[];
let gmailConnected: Set<string>;
let sendEmailResult: { ok: true; messageId: string } | { ok: false; error: string };

vi.mock("@/server/email/service", () => ({
  sendEmail: vi.fn(async () => sendEmailResult),
}));

vi.mock("@/server/email/templates", () => ({
  buildBookingSignedNotificationEmail: vi.fn((params: { customerFullName: string }) => ({
    subject: `Booking signed — ${params.customerFullName}`,
    html: "<p>notification</p>",
  })),
  buildBookingProfitNotificationEmail: vi.fn((params: { agentFullName: string; agentRole?: string | null }) => ({
    subject: `${params.agentFullName}${params.agentRole ? ` (${params.agentRole})` : ""} made $0.00`,
    html: "<p>profit notification</p>",
  })),
}));

vi.mock("@/server/email/segment-mapper", () => ({
  toEmailSegments: vi.fn(() => []),
}));

vi.mock("@/server/queries/company", () => ({
  getCompanyForAccountId: vi.fn(async () => ({ id: "company-1", name: "Test Co" })),
  getCompanyForContactId: vi.fn(async () => ({ id: "company-1", name: "Test Co" })),
}));

vi.mock("@/server/queries/gmail-connection", () => ({
  getGmailConnectionState: vi.fn(async (accountId: string) => (gmailConnected.has(accountId) ? "CONNECTED" : "NOT_CONNECTED")),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailLog: {
      findFirst: vi.fn(async ({ where }: { where: { bookingId: string; type: string; status: string } }) =>
        emailLogs.find((e) => e.bookingId === where.bookingId && e.type === where.type && e.status === where.status) ?? null
      ),
      // Pass 23 — sendBookingProfitNotification's claim is now a
      // conditional INSERT guarded by a real partial unique index
      // (bookingId, type) WHERE status='SENT', scoped to exactly the two
      // notification types. Modeled here as a synchronous (no internal
      // await) check-then-push against the shared array, so genuinely
      // concurrent Promise.all callers get a faithful "only one can
      // claim" result — the same convention already used by
      // booking-retry.test.ts's real-race test for Booking.quoteId.
      create: vi.fn(async ({ data }: { data: Partial<FakeEmailLog> & { bookingId: string; type: string; status: string } }) => {
        const CLAIM_TYPES = new Set(["BOOKING_PROFIT_NOTIFICATION", "BOOKING_CANCELLATION_NOTIFICATION"]);
        if (data.status === "SENT" && CLAIM_TYPES.has(data.type) && emailLogs.some((e) => e.bookingId === data.bookingId && e.type === data.type && e.status === "SENT")) {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`bookingId`,`type`)", { code: "P2002", clientVersion: "test", meta: { target: ["bookingId", "type"] } });
        }
        const log: FakeEmailLog = { id: `log-${emailLogs.length + 1}`, bookingId: data.bookingId, type: data.type, status: data.status, toEmail: data.toEmail };
        emailLogs.push(log);
        return log;
      }),
      update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Partial<FakeEmailLog> }) => {
        const log = emailLogs.find((e) => e.id === id)!;
        Object.assign(log, data);
        return log;
      }),
    },
    itinerary: {
      findUnique: vi.fn(async () => ({ segments: [] })),
    },
    account: {
      // Shared by sendBookingSignedNotification (queries admins/managers via
      // role.in) and sendBookingProfitNotification (queries every ACTIVE
      // account company-wide, no role filter at all) — handle both shapes.
      findMany: vi.fn(async ({ where }: { where: { companyId: string; status: string; role?: { in: string[] } } }) =>
        [...accounts.values()].filter(
          (a) => a.companyId === where.companyId && a.status === where.status && (!where.role || where.role.in.includes(a.role))
        )
      ),
    },
  },
}));

const BASE_PARAMS: BookingNotificationParams = {
  bookingId: "booking-1",
  bookingReference: "BFT-ABC1234",
  bookingCreatedAt: new Date("2026-08-19T12:00:00Z"),
  bookingUrl: "https://example.com/bookings/booking-1",
  quoteId: "quote-1",
  leadId: "lead-1",
  contactId: "contact-1",
  agent: null,
  customerFirstName: "Jane",
  customerMiddleName: null,
  customerLastName: "Traveler",
  ip: "203.0.113.42",
  signedName: "Jane Traveler",
  contactEmail: "jane@example.com",
  contactPhone: "555-0100",
  passengers: [],
  paymentMethods: [],
  pricing: { adults: 1, children: 0, infants: 0, adultPrice: 500, childPrice: 0, infantPrice: 0, taxes: 0, serviceFee: 0, gratuity: 0, total: 500, currency: "USD" },
};

beforeEach(() => {
  accounts = new Map([
    ["admin-1", { id: "admin-1", email: "admin@example.com", fullName: "Admin One", role: "ADMIN", status: "ACTIVE", companyId: "company-1" }],
  ]);
  emailLogs = [];
  gmailConnected = new Set(["admin-1"]);
  sendEmailResult = { ok: true, messageId: "msg-1" };
  vi.clearAllMocks();
});

describe("sendBookingSignedNotification — idempotency", () => {
  it("sends and logs a SENT EmailLog row when nothing has been sent yet", async () => {
    const { sendBookingSignedNotification } = await import("../booking-notification");
    await sendBookingSignedNotification(BASE_PARAMS);
    expect(emailLogs).toHaveLength(1);
    expect(emailLogs[0].status).toBe("SENT");
  });

  it("skips sending entirely if a SENT notification already exists for this booking — no duplicate", async () => {
    emailLogs.push({ id: "existing-log", bookingId: "booking-1", type: "BOOKING_NOTIFICATION", status: "SENT" });
    const { sendBookingSignedNotification } = await import("../booking-notification");
    const { sendEmail } = await import("@/server/email/service");
    await sendBookingSignedNotification(BASE_PARAMS);
    expect(sendEmail).not.toHaveBeenCalled();
    // No new EmailLog row was written by this call.
    expect(emailLogs).toHaveLength(1);
  });

  it("does NOT skip if the only existing EmailLog for this booking is FAILED (not SENT) — a retry after failure must still attempt to send", async () => {
    emailLogs.push({ id: "existing-log", bookingId: "booking-1", type: "BOOKING_NOTIFICATION", status: "FAILED" });
    const { sendBookingSignedNotification } = await import("../booking-notification");
    const { sendEmail } = await import("@/server/email/service");
    await sendBookingSignedNotification(BASE_PARAMS);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe("sendBookingSignedNotification — failure handling never throws", () => {
  it("never throws when sendEmail returns a failure result — records FAILED and returns normally", async () => {
    sendEmailResult = { ok: false, error: "Gmail API unavailable" };
    const { sendBookingSignedNotification } = await import("../booking-notification");
    await expect(sendBookingSignedNotification(BASE_PARAMS)).resolves.toBeUndefined();
    expect(emailLogs).toHaveLength(1);
    expect(emailLogs[0].status).toBe("FAILED");
  });

  it("never throws even when an unexpected exception occurs mid-send (e.g. a thrown network error) — booking success must never be affected by a notification bug", async () => {
    const { sendEmail } = await import("@/server/email/service");
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error("unexpected network failure"));
    const { sendBookingSignedNotification } = await import("../booking-notification");
    await expect(sendBookingSignedNotification(BASE_PARAMS)).resolves.toBeUndefined();
  });

  it("never throws when nobody has Gmail connected — skips the send, records a FAILED log, does not throw", async () => {
    gmailConnected = new Set();
    const { sendBookingSignedNotification } = await import("../booking-notification");
    const { sendEmail } = await import("@/server/email/service");
    await expect(sendBookingSignedNotification(BASE_PARAMS)).resolves.toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(emailLogs).toHaveLength(1);
    expect(emailLogs[0].status).toBe("FAILED");
  });

  it("is a silent no-op (not even a FAILED log) when there are no recipients at all", async () => {
    accounts = new Map();
    const { sendBookingSignedNotification } = await import("../booking-notification");
    await expect(sendBookingSignedNotification(BASE_PARAMS)).resolves.toBeUndefined();
    expect(emailLogs).toHaveLength(0);
  });
});

describe("sendBookingSignedNotification — recipient/sender selection", () => {
  it("sends via the quote's own agent when the agent has Gmail connected, even if admins exist", async () => {
    accounts.set("agent-1", { id: "agent-1", email: "agent@example.com", fullName: "Agent One", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1" });
    gmailConnected = new Set(["agent-1", "admin-1"]);
    const { sendBookingSignedNotification } = await import("../booking-notification");
    const { sendEmail } = await import("@/server/email/service");
    await sendBookingSignedNotification({ ...BASE_PARAMS, agent: { id: "agent-1", email: "agent@example.com", fullName: "Agent One" } });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ accountId: "agent-1" }));
  });

  it("falls back to an Admin's connected Gmail to TRANSMIT the email when the agent has none connected — sending infrastructure, not the audience", async () => {
    const { sendBookingSignedNotification } = await import("../booking-notification");
    const { sendEmail } = await import("@/server/email/service");
    await sendBookingSignedNotification({ ...BASE_PARAMS, agent: { id: "agent-1", email: "agent@example.com", fullName: "Agent One" } });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ accountId: "admin-1" }));
    // The admin is only borrowed to SEND it — the notification is still
    // addressed only to the original sender, not the admin.
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "agent@example.com" }));
  });
});

// Part 3 of the bug-fix spec: the "Booking Form Signed" notification must
// reach ONLY the CRM user who originally sent the flight option — never a
// broadcast/CC to every admin/manager, even though admins are still a
// legitimate fallback SENDER (see the test above) and a legitimate
// fallback RECIPIENT only when no sender was ever recorded at all.
describe("sendBookingSignedNotification — recipient narrowing (Part 3)", () => {
  it("addresses the email ONLY to the original sender, never CC'ing admins/managers even though they exist and could receive it", async () => {
    accounts.set("agent-1", { id: "agent-1", email: "agent@example.com", fullName: "Agent One", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1" });
    accounts.set("manager-1", { id: "manager-1", email: "manager@example.com", fullName: "Manager One", role: "MANAGER", status: "ACTIVE", companyId: "company-1" });
    gmailConnected = new Set(["agent-1", "admin-1", "manager-1"]);
    const { sendBookingSignedNotification } = await import("../booking-notification");
    const { sendEmail } = await import("@/server/email/service");
    await sendBookingSignedNotification({ ...BASE_PARAMS, agent: { id: "agent-1", email: "agent@example.com", fullName: "Agent One" } });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "agent@example.com" }));
  });

  it("falls back to notifying admins only when there's truly no recorded sender (agent is null)", async () => {
    const { sendBookingSignedNotification } = await import("../booking-notification");
    const { sendEmail } = await import("@/server/email/service");
    await sendBookingSignedNotification({ ...BASE_PARAMS, agent: null });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "admin@example.com" }));
  });
});

// Part 19 — sendBookingProfitNotification is a company-wide broadcast (every
// ACTIVE account, not just admins), so the real distribution list must
// never appear in a header any recipient can see. These tests cover the
// fix: `to` is always the sending account's own single address, the actual
// recipient list only ever appears in `bcc`.
describe("sendBookingProfitNotification — recipient privacy (Part 19) and role passthrough (Parts 1-3)", () => {
  const BASE_PROFIT_PARAMS = {
    bookingId: "booking-1",
    bookingReference: "BFT-ABC1234",
    quoteId: "quote-1",
    leadId: "lead-1",
    contactId: "contact-1",
    companyId: "company-1",
    agent: { id: "agent-1", email: "agent@example.com", fullName: "Nigora Dadabaeva", location: "Frankfurt", hiredAt: null, role: "TRAVEL_AGENT" as const },
    profit: 287,
    destination: "Minneapolis, United States",
    currency: "USD",
    passengerCount: 1,
    ticketBookingCost: 4700,
    sellingCost: 4987,
    segments: [],
  };

  it("sends 'to' the transmitting account's OWN address only, never a joined multi-address list", async () => {
    accounts.set("agent-1", { id: "agent-1", email: "agent@example.com", fullName: "Nigora Dadabaeva", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1" });
    accounts.set("manager-1", { id: "manager-1", email: "manager@example.com", fullName: "Manager One", role: "MANAGER", status: "ACTIVE", companyId: "company-1" });
    gmailConnected = new Set(["agent-1", "admin-1", "manager-1"]);
    const { sendBookingProfitNotification } = await import("../booking-notification");
    const { sendEmail } = await import("@/server/email/service");
    await sendBookingProfitNotification(BASE_PROFIT_PARAMS);
    const call = vi.mocked(sendEmail).mock.calls[0][0];
    expect(call.to).not.toContain(",");
    expect(["agent@example.com", "admin@example.com", "manager@example.com"]).toContain(call.to);
  });

  it("puts the FULL recipient distribution list in 'bcc', never exposed in 'to'", async () => {
    accounts.set("agent-1", { id: "agent-1", email: "agent@example.com", fullName: "Nigora Dadabaeva", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1" });
    accounts.set("manager-1", { id: "manager-1", email: "manager@example.com", fullName: "Manager One", role: "MANAGER", status: "ACTIVE", companyId: "company-1" });
    gmailConnected = new Set(["admin-1"]); // only admin-1 can actually transmit
    const { sendBookingProfitNotification } = await import("../booking-notification");
    const { sendEmail } = await import("@/server/email/service");
    await sendBookingProfitNotification(BASE_PROFIT_PARAMS);
    const call = vi.mocked(sendEmail).mock.calls[0][0];
    expect(call.to).toBe("admin@example.com");
    expect(call.bcc).toContain("agent@example.com");
    expect(call.bcc).toContain("manager@example.com");
    expect(call.bcc).toContain("admin@example.com");
  });

  it("resolves the agent's role via ROLE_LABELS and threads it through as agentRole", async () => {
    const { sendBookingProfitNotification } = await import("../booking-notification");
    const templates = await import("@/server/email/templates");
    await sendBookingProfitNotification(BASE_PROFIT_PARAMS);
    expect(templates.buildBookingProfitNotificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ agentRole: "Travel Agent" })
    );
  });

  it("passes agentRole: null when there is no agent on file at all", async () => {
    const { sendBookingProfitNotification } = await import("../booking-notification");
    const templates = await import("@/server/email/templates");
    await sendBookingProfitNotification({ ...BASE_PROFIT_PARAMS, agent: null });
    expect(templates.buildBookingProfitNotificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ agentRole: null })
    );
  });

  it("still records the FULL distribution list in EmailLog.toEmail for internal audit, even though the actual Gmail 'to' header only ever carries the sender's own address", async () => {
    accounts.set("agent-1", { id: "agent-1", email: "agent@example.com", fullName: "Nigora Dadabaeva", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1" });
    const { sendBookingProfitNotification } = await import("../booking-notification");
    await sendBookingProfitNotification(BASE_PROFIT_PARAMS);
    expect(emailLogs).toHaveLength(1);
    expect(emailLogs[0].toEmail).toContain("agent@example.com");
    expect(emailLogs[0].toEmail).toContain("admin@example.com");
  });
});

// Pass 23 §32/§33 — sendBookingProfitNotification's new atomic claim
// (an optimistic SENT-status EmailLog insert guarded by a partial unique
// index — see booking-notification.ts's own doc comment). Verifies the
// idempotency contract it replaces (repeat call after success is a silent
// alreadySent:true no-op, never a duplicate email), a genuine retry after
// failure, and a REAL Promise.all race producing exactly one send.
describe("sendBookingProfitNotification — Pass 23 atomic claim", () => {
  const BASE_PROFIT_PARAMS = {
    bookingId: "booking-1",
    bookingReference: "BFT-ABC1234",
    quoteId: "quote-1",
    leadId: "lead-1",
    contactId: "contact-1",
    companyId: "company-1",
    agent: { id: "agent-1", email: "agent@example.com", fullName: "Nigora Dadabaeva", location: "Frankfurt", hiredAt: null, role: "TRAVEL_AGENT" as const },
    profit: 287,
    destination: "Minneapolis, United States",
    currency: "USD",
    passengerCount: 1,
    ticketBookingCost: 4700,
    sellingCost: 4987,
    segments: [],
  };

  it("a repeat call after a prior success is a silent alreadySent no-op — never a second email", async () => {
    const { sendBookingProfitNotification } = await import("../booking-notification");
    const { sendEmail } = await import("@/server/email/service");
    const first = await sendBookingProfitNotification(BASE_PROFIT_PARAMS);
    expect(first).toEqual({ ok: true });
    const second = await sendBookingProfitNotification(BASE_PROFIT_PARAMS);
    expect(second).toEqual({ ok: true, alreadySent: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(emailLogs).toHaveLength(1);
  });

  it("a genuine race — two truly concurrent calls (real Promise.all) result in exactly ONE claimed EmailLog row and ONE email sent", async () => {
    const { sendBookingProfitNotification } = await import("../booking-notification");
    const { sendEmail } = await import("@/server/email/service");
    const [first, second] = await Promise.all([sendBookingProfitNotification(BASE_PROFIT_PARAMS), sendBookingProfitNotification(BASE_PROFIT_PARAMS)]);
    const results = [first, second];
    const wonClaim = results.filter((r) => !r.alreadySent);
    const lostClaim = results.filter((r) => r.alreadySent);
    expect(wonClaim).toHaveLength(1);
    expect(lostClaim).toHaveLength(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(emailLogs).toHaveLength(1);
    expect(emailLogs[0].status).toBe("SENT");
  });

  it("a failed send downgrades the claim to FAILED, which correctly re-opens the slot for a legitimate retry", async () => {
    const { sendEmail } = await import("@/server/email/service");
    vi.mocked(sendEmail).mockResolvedValueOnce({ ok: false, error: "Gmail API unavailable" });
    const { sendBookingProfitNotification } = await import("../booking-notification");
    const first = await sendBookingProfitNotification(BASE_PROFIT_PARAMS);
    expect(first.ok).toBe(false);
    expect(emailLogs).toHaveLength(1);
    expect(emailLogs[0].status).toBe("FAILED");

    const second = await sendBookingProfitNotification(BASE_PROFIT_PARAMS);
    expect(second).toEqual({ ok: true });
    // The retry's own claim is a fresh row (the FAILED row from the first
    // attempt doesn't hold the unique slot) — two rows total: one FAILED
    // audit record, one SENT.
    expect(emailLogs).toHaveLength(2);
    expect(emailLogs.filter((e) => e.status === "SENT")).toHaveLength(1);
    expect(emailLogs.filter((e) => e.status === "FAILED")).toHaveLength(1);
  });

  it("CANCELLATION and PROFIT notifications for the same booking claim independently — one never blocks the other", async () => {
    const { sendBookingProfitNotification } = await import("../booking-notification");
    const first = await sendBookingProfitNotification(BASE_PROFIT_PARAMS);
    const second = await sendBookingProfitNotification({ ...BASE_PROFIT_PARAMS, transactionLabel: "CANCELLATION" as const });
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(emailLogs).toHaveLength(2);
  });
});
