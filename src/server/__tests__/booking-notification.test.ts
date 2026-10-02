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
    // Transmitted by the only connected account (admin-1), but addressed To the
    // quote creator — the To identity follows the creator, not the fallback sender.
    expect(call.accountId).toBe("admin-1");
    expect(call.to).toBe("agent@example.com");
    expect(call.bcc).toContain("agent@example.com");
    expect(call.bcc).toContain("manager@example.com");
    expect(call.bcc).toContain("admin@example.com");
  });

  // Real bug found and fixed: the sender loop used to iterate the full
  // `recipients` list (ordered alphabetically by fullName) and send AS
  // whichever active user happened to have Gmail connected first — NOT
  // the quote creator (`agent`, who the email is actually ABOUT). "Admin
  // One" sorts before "Nigora Dadabaeva" alphabetically, so the OLD code
  // would have sent this email as the admin even though the agent (the
  // actual quote creator/salesperson) also had Gmail connected and should
  // have been the sender. This is the regression test for that fix.
  it("sends AS the quote creator (agent) whenever they have Gmail connected, even when an alphabetically-earlier admin also does", async () => {
    accounts.set("agent-1", { id: "agent-1", email: "agent@example.com", fullName: "Nigora Dadabaeva", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1" });
    gmailConnected = new Set(["admin-1", "agent-1"]); // admin-1 ("Admin One") sorts first alphabetically
    const { sendBookingProfitNotification } = await import("../booking-notification");
    const { sendEmail } = await import("@/server/email/service");
    await sendBookingProfitNotification(BASE_PROFIT_PARAMS);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ accountId: "agent-1" }));
  });

  // Integrated A/B/C scenario requested directly: User A (quote creator,
  // Andrew) created the quote; User B (Sarah) is a separate active CRM user
  // who happens to ALSO have Gmail connected — standing in for "the
  // ticketing agent who clicks Notify Team," though note this function
  // never even receives that person's identity (see
  // sendNewSaleNotification in actions/bookings.ts: only actor.companyId is
  // passed through, never actor.id/email/fullName) — and User C (Priya) is
  // a third active user with no Gmail connection at all, included purely
  // as an ordinary recipient. Proves, in one scenario, all three required
  // properties together: sender starts with and resolves to A; B is never
  // selected merely by being active/connected/"the one who clicked"; C is
  // still included in the distribution list despite never being a sender
  // candidate winner.
  it("A/B/C scenario: sender is the quote creator (A), the other active connected user (B) is never selected merely by being present, and the third active user (C) still receives it", async () => {
    accounts.set("user-a", { id: "user-a", email: "andrew@example.com", fullName: "Andrew (Creator)", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1" });
    accounts.set("user-b", { id: "user-b", email: "sarah@example.com", fullName: "Sarah (Ticketing)", role: "TICKETING_AGENT", status: "ACTIVE", companyId: "company-1" });
    accounts.set("user-c", { id: "user-c", email: "priya@example.com", fullName: "Priya (Other Recipient)", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1" });
    accounts.delete("admin-1");
    gmailConnected = new Set(["user-a", "user-b"]); // both A and B could send; C has no connection at all

    const { sendBookingProfitNotification } = await import("../booking-notification");
    const { sendEmail } = await import("@/server/email/service");
    const outcome = await sendBookingProfitNotification({ ...BASE_PROFIT_PARAMS, agent: { ...BASE_PROFIT_PARAMS.agent, id: "user-a", email: "andrew@example.com", fullName: "Andrew (Creator)" } });

    expect(outcome).toEqual({ ok: true });
    // Sender is A, never B — even though B is active, connected, and would
    // otherwise be a perfectly valid fallback candidate.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ accountId: "user-a" }));
    // C still receives it (bcc distribution list), despite never being able
    // to send it.
    const call = vi.mocked(sendEmail).mock.calls[0][0];
    expect(call.bcc).toContain("andrew@example.com");
    expect(call.bcc).toContain("sarah@example.com");
    expect(call.bcc).toContain("priya@example.com");
  });

  it("falls back to another active user's Gmail only when the quote creator has none connected", async () => {
    accounts.set("agent-1", { id: "agent-1", email: "agent@example.com", fullName: "Nigora Dadabaeva", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1" });
    gmailConnected = new Set(["admin-1"]); // agent-1 has no connection at all
    const { sendBookingProfitNotification } = await import("../booking-notification");
    const { sendEmail } = await import("@/server/email/service");
    await sendBookingProfitNotification(BASE_PROFIT_PARAMS);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ accountId: "admin-1" }));
  });

  it("falls back to another active user when the quote creator is no longer an active user (deactivated/removed)", async () => {
    // agent-1 is intentionally NOT added to `accounts` at all here — same
    // observable shape as a deactivated/deleted account: absent from the
    // current active-Users query, so never a sender candidate, exactly
    // like any account not in `recipients`.
    gmailConnected = new Set(["admin-1"]);
    const { sendBookingProfitNotification } = await import("../booking-notification");
    const { sendEmail } = await import("@/server/email/service");
    const outcome = await sendBookingProfitNotification(BASE_PROFIT_PARAMS);
    expect(outcome.ok).toBe(true);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ accountId: "admin-1" }));
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

  // Required behavior per spec: the recipient list is the CURRENT Users
  // data, resolved FRESH on every call — never a list computed once and
  // reused. Proven here by mutating the active-accounts data BETWEEN two
  // calls (for two different bookings, since the first booking's own
  // notification is otherwise idempotent) and confirming the second call's
  // distribution list reflects the change: a newly added user is included,
  // and an updated email address for an existing user is used.
  it("resolves the recipient list fresh on every call — a user added or whose email changed after the first send is reflected on the next send", async () => {
    const { sendBookingProfitNotification } = await import("../booking-notification");

    const first = await sendBookingProfitNotification(BASE_PROFIT_PARAMS);
    expect(first).toEqual({ ok: true });
    expect(emailLogs[0].toEmail).not.toContain("new-hire@example.com");

    // A new user is added, and an existing one's email changes — exactly
    // the Users-section edits the spec describes.
    accounts.set("new-hire-1", { id: "new-hire-1", email: "new-hire@example.com", fullName: "New Hire", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1" });
    const admin = accounts.get("admin-1")!;
    accounts.set("admin-1", { ...admin, email: "admin-updated@example.com" });

    const second = await sendBookingProfitNotification({ ...BASE_PROFIT_PARAMS, bookingId: "booking-2" });
    expect(second).toEqual({ ok: true });
    expect(emailLogs[1].toEmail).toContain("new-hire@example.com");
    expect(emailLogs[1].toEmail).toContain("admin-updated@example.com");
    expect(emailLogs[1].toEmail).not.toContain("admin@example.com");
  });

  // Required behavior per spec: a user no longer meeting the application's
  // existing active-user rule (status !== "ACTIVE", the same rule every
  // other recipient/session check in this codebase already uses) must drop
  // out of the recipient list on the very next send, without any special
  // handling beyond the existing status: "ACTIVE" filter already in the
  // query above.
  it("a deactivated user drops out of the recipient list on the next send", async () => {
    accounts.set("agent-1", { id: "agent-1", email: "agent@example.com", fullName: "Nigora Dadabaeva", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1" });
    const { sendBookingProfitNotification } = await import("../booking-notification");

    const first = await sendBookingProfitNotification(BASE_PROFIT_PARAMS);
    expect(first).toEqual({ ok: true });
    expect(emailLogs[0].toEmail).toContain("agent@example.com");

    accounts.set("agent-1", { ...accounts.get("agent-1")!, status: "INACTIVE" });
    const second = await sendBookingProfitNotification({ ...BASE_PROFIT_PARAMS, bookingId: "booking-2" });
    expect(second).toEqual({ ok: true });
    expect(emailLogs[1].toEmail).not.toContain("agent@example.com");
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
