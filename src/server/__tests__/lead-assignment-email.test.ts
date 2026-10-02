import { describe, it, expect, vi, beforeEach } from "vitest";

// sendNewFlightRequestEmail: recipient derivation, sender selection,
// idempotency and failure handling. Prisma, the Gmail send and the company
// lookup are faked at their boundaries; the template, phone helpers and all
// decision logic run for real.

type FakeAccount = { id: string; email: string; fullName: string; companyId: string; status: string; role: string };
type FakeLog = Record<string, unknown>;

let accounts: Map<string, FakeAccount>;
let emailLogs: FakeLog[];
let gmailConnected: Set<string>;
let lead: Record<string, unknown> | null;
let sendResults: Array<{ ok: true; messageId: string } | { ok: false; error: string }>;

vi.mock("@/server/email/service", () => ({
  sendEmail: vi.fn(async () => sendResults.shift() ?? { ok: true as const, messageId: "msg-1" }),
}));
vi.mock("@/server/queries/gmail-connection", () => ({
  getGmailConnectionState: vi.fn(async (id: string) => (gmailConnected.has(id) ? "CONNECTED" : "NOT_CONNECTED")),
}));
vi.mock("@/server/queries/company", () => ({
  getCompanyById: vi.fn(async () => ({
    id: "company-1",
    name: "Test Travel Co",
    website: "https://test.example.com",
    phone: null,
    brandColor: "#1c3a5e",
    logoEmailUrl: "https://test.example.com/logo.png",
    logoWebUrl: "",
    logoIconUrl: "",
    signatureTemplate: "",
  })),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailLog: {
      findFirst: vi.fn(async ({ where }: { where: { leadId: string; type: string; status: string } }) =>
        emailLogs.find((l) => l.leadId === where.leadId && l.type === where.type && l.status === where.status) ?? null
      ),
      create: vi.fn(async ({ data }: { data: FakeLog }) => {
        emailLogs.push(data);
        return data;
      }),
    },
    lead: { findUnique: vi.fn(async () => lead) },
    account: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; status: string } }) => {
        const a = accounts.get(where.id);
        return a && a.status === where.status ? a : null;
      }),
      findMany: vi.fn(async ({ where }: { where: { companyId: string; status: string; role: { in: string[] }; id: { not: string } } }) =>
        [...accounts.values()]
          .filter((a) => a.companyId === where.companyId && a.status === where.status && where.role.in.includes(a.role) && a.id !== where.id.not)
          .sort((x, y) => x.fullName.localeCompare(y.fullName))
      ),
    },
  },
}));

function baseLead(overrides: Record<string, unknown> = {}) {
  return {
    assignedAgentId: "agent-a",
    source: "WEBSITE",
    createdAt: new Date("2026-10-01T15:00:00Z"),
    contactId: "contact-1",
    tripType: "ROUND_TRIP",
    cabinClass: "ECONOMY",
    adults: 1,
    children: 0,
    infants: 0,
    departureDate: new Date("2026-11-03T00:00:00Z"),
    returnDate: new Date("2026-11-10T00:00:00Z"),
    flexibleDates: false,
    preferredAirline: null,
    budget: null,
    notes: null,
    contact: { firstName: "Jordan", middleName: null, lastName: "Rivera", primaryEmail: "jordan@example.com", primaryPhone: "+14155550123" },
    departureAirport: { iata: "LAX", name: "Los Angeles International", city: "Los Angeles", country: "United States" },
    arrivalAirport: { iata: "CDG", name: "Charles de Gaulle", city: "Paris", country: "France" },
    ...overrides,
  };
}

const params = { leadId: "lead-1", recipientId: "agent-a", acceptedAt: new Date("2026-10-01T15:05:00Z") };

beforeEach(() => {
  accounts = new Map([
    ["agent-a", { id: "agent-a", email: "a@example.com", fullName: "Agent A", companyId: "company-1", status: "ACTIVE", role: "TRAVEL_AGENT" }],
    ["admin-1", { id: "admin-1", email: "admin@example.com", fullName: "Admin One", companyId: "company-1", status: "ACTIVE", role: "ADMIN" }],
    ["other-co-admin", { id: "other-co-admin", email: "x@other.com", fullName: "Other Co", companyId: "company-2", status: "ACTIVE", role: "ADMIN" }],
  ]);
  emailLogs = [];
  gmailConnected = new Set(["agent-a", "admin-1"]);
  lead = baseLead();
  sendResults = [];
  vi.clearAllMocks();
});

describe("sendNewFlightRequestEmail", () => {
  it("emails the accepting agent — from their own connected account — with the full request and logs SENT", async () => {
    const { sendNewFlightRequestEmail } = await import("../lead-assignment-email");
    const { sendEmail } = await import("@/server/email/service");
    expect(await sendNewFlightRequestEmail(params)).toEqual({ ok: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendEmail).mock.calls[0][0];
    expect(call.accountId).toBe("agent-a");
    expect(call.to).toBe("a@example.com");
    expect(call.subject).toBe("New Flight Request — Jordan Rivera");
    expect(call.html).toContain("mailto:jordan@example.com");
    expect(call.html).toContain("Charles de Gaulle");
    expect(emailLogs).toEqual([expect.objectContaining({ type: "NEW_LEAD_ASSIGNMENT", status: "SENT", toEmail: "a@example.com", fromEmail: "a@example.com", leadId: "lead-1", messageId: "msg-1" })]);
  });

  it("derives the client's country from the phone number rather than inventing one", async () => {
    const { sendNewFlightRequestEmail } = await import("../lead-assignment-email");
    const { sendEmail } = await import("@/server/email/service");
    lead = baseLead({ contact: { firstName: "Mia", middleName: null, lastName: "Tanaka", primaryEmail: null, primaryPhone: "+81312345678" } });
    await sendNewFlightRequestEmail(params);
    expect(vi.mocked(sendEmail).mock.calls[0][0].html).toContain("Japan");
  });

  it("is idempotent: a second call after a SENT record is a no-op (no second email)", async () => {
    const { sendNewFlightRequestEmail } = await import("../lead-assignment-email");
    const { sendEmail } = await import("@/server/email/service");
    await sendNewFlightRequestEmail(params);
    expect(await sendNewFlightRequestEmail(params)).toEqual({ ok: true, alreadySent: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(emailLogs).toHaveLength(1);
  });

  it("refuses to email an account the lead is NOT actually assigned to", async () => {
    const { sendNewFlightRequestEmail } = await import("../lead-assignment-email");
    const { sendEmail } = await import("@/server/email/service");
    lead = baseLead({ assignedAgentId: "someone-else" });
    const outcome = await sendNewFlightRequestEmail(params);
    expect(outcome.ok).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("only handles website leads", async () => {
    const { sendNewFlightRequestEmail } = await import("../lead-assignment-email");
    const { sendEmail } = await import("@/server/email/service");
    lead = baseLead({ source: "PHONE" });
    expect((await sendNewFlightRequestEmail(params)).ok).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("falls back to a same-company Admin's connection to transmit it — still addressed to the accepting agent — when the agent has none", async () => {
    gmailConnected = new Set(["admin-1", "other-co-admin"]);
    const { sendNewFlightRequestEmail } = await import("../lead-assignment-email");
    const { sendEmail } = await import("@/server/email/service");
    expect(await sendNewFlightRequestEmail(params)).toEqual({ ok: true });
    const call = vi.mocked(sendEmail).mock.calls[0][0];
    expect(call.accountId).toBe("admin-1"); // never the other company's admin
    expect(call.to).toBe("a@example.com");
    expect(emailLogs[0]).toMatchObject({ status: "SENT", fromEmail: "admin@example.com", toEmail: "a@example.com" });
  });

  it("records FAILED (and returns the failure) when nobody can send — never a false success, never thrown", async () => {
    gmailConnected = new Set();
    const { sendNewFlightRequestEmail } = await import("../lead-assignment-email");
    const { sendEmail } = await import("@/server/email/service");
    const outcome = await sendNewFlightRequestEmail(params);
    expect(outcome.ok).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(emailLogs).toEqual([expect.objectContaining({ status: "FAILED", fromEmail: "unsent", toEmail: "a@example.com" })]);
  });

  it("a failed attempt does not block a safe retry (only SENT records count as 'already sent')", async () => {
    const { sendNewFlightRequestEmail } = await import("../lead-assignment-email");
    sendResults = [{ ok: false, error: "Your Gmail authorization has expired or been revoked. Please reconnect Gmail." }, { ok: false, error: "still failing" }];
    expect((await sendNewFlightRequestEmail(params)).ok).toBe(false);
    expect(emailLogs[0]).toMatchObject({ status: "FAILED" });
    expect(await sendNewFlightRequestEmail(params)).toEqual({ ok: true });
    expect(emailLogs.filter((l) => l.status === "SENT")).toHaveLength(1);
  });

  it("never throws on an unexpected error and never leaks its message", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.lead.findUnique).mockRejectedValueOnce(new Error("connection to a@example.com refused"));
    const { sendNewFlightRequestEmail } = await import("../lead-assignment-email");
    const outcome = await sendNewFlightRequestEmail(params);
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain("a@example.com");
  });

  it("does not email an inactive recipient", async () => {
    accounts.set("agent-a", { ...accounts.get("agent-a")!, status: "INACTIVE" });
    const { sendNewFlightRequestEmail } = await import("../lead-assignment-email");
    const { sendEmail } = await import("@/server/email/service");
    expect((await sendNewFlightRequestEmail(params)).ok).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
