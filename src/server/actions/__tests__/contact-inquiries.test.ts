import { describe, it, expect, vi, beforeEach } from "vitest";

// Item 9 — sendInquiryEmail, the Get in Touch detail page's internal email
// composer (replacing the old plain mailto: link). Covers: admin-only
// authorization, cross-company IDOR, the recipient being re-derived
// server-side from the inquiry row itself (never trusted from client
// input — the whole point of this action being stricter than the
// pre-existing sendLeadEmail), Gmail connection gating, and EmailLog
// traceability via the new contactInquiryId column.

type FakeInquiry = { id: string; companyId: string; firstName: string; lastName: string; email: string };

let inquiries: Map<string, FakeInquiry>;
let currentActor: { id: string; role: string; companyId: string; fullName: string; email: string; phone: string | null } | null;
let emailLogs: Array<Record<string, unknown>>;
let sendEmailCalls: Array<Record<string, unknown>>;
let gmailConnected: Set<string>;

const fakePrisma = {
  contactInquiry: {
    findFirst: vi.fn(async ({ where }: { where: { id: string; companyId: string } }) => {
      const inquiry = inquiries.get(where.id);
      if (!inquiry || inquiry.companyId !== where.companyId) return null;
      return inquiry;
    }),
  },
  emailLog: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      emailLogs.push(data);
      return {};
    }),
  },
};

vi.mock("@/lib/prisma", () => ({ prisma: fakePrisma }));
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/queries/gmail-connection", () => ({
  getGmailConnectionState: vi.fn(async (accountId: string) => (gmailConnected.has(accountId) ? "CONNECTED" : "NOT_CONNECTED")),
}));
vi.mock("@/server/queries/company", () => ({
  getCompanyForAccountId: vi.fn(async () => ({ name: "Compass Tools", brandColor: "#1c3a5e", logoEmailUrl: null, website: null, phone: null, signatureTemplate: "{{first_name}} {{last_name}}" })),
}));
vi.mock("@/server/email/templates", () => ({
  buildSequenceEmail: vi.fn((params: { subject: string }) => ({ subject: params.subject, html: "<p>body</p>" })),
}));
vi.mock("@/server/email/service", () => ({
  sendEmail: vi.fn(async (args: Record<string, unknown>) => {
    sendEmailCalls.push(args);
    return { ok: true, messageId: "msg-1" };
  }),
}));

beforeEach(() => {
  inquiries = new Map([
    ["inquiry-1", { id: "inquiry-1", companyId: "company-1", firstName: "Jasur", lastName: "Azizxonov", email: "jasur@example.com" }],
    ["inquiry-other-company", { id: "inquiry-other-company", companyId: "company-2", firstName: "Someone", lastName: "Else", email: "someone-else@example.com" }],
  ]);
  currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1", fullName: "Dark Master", email: "admin@example.com", phone: null };
  emailLogs = [];
  sendEmailCalls = [];
  gmailConnected = new Set(["admin-1"]);
  vi.clearAllMocks();
});

describe("sendInquiryEmail — authorization + recipient safety (Item 9)", () => {
  it("rejects a non-Admin role (e.g. Travel Agent) — Get in Touch is admin-only", async () => {
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-1", fullName: "Andrew Kent", email: "andrew@example.com", phone: null };
    const { sendInquiryEmail } = await import("../contact-inquiries");
    await expect(sendInquiryEmail("inquiry-1", { subject: "Hi", body: "Hello" })).rejects.toThrow(/Admins/i);
  });

  it("rejects an unauthenticated caller", async () => {
    currentActor = null;
    const { sendInquiryEmail } = await import("../contact-inquiries");
    await expect(sendInquiryEmail("inquiry-1", { subject: "Hi", body: "Hello" })).rejects.toThrow(/Admins/i);
  });

  it("rejects a cross-company inquiry id as not-found (IDOR) — never leaks existence", async () => {
    const { sendInquiryEmail } = await import("../contact-inquiries");
    await expect(sendInquiryEmail("inquiry-other-company", { subject: "Hi", body: "Hello" })).rejects.toThrow(/not found/i);
    expect(sendEmailCalls).toHaveLength(0);
  });

  it("rejects an unknown inquiry id", async () => {
    const { sendInquiryEmail } = await import("../contact-inquiries");
    await expect(sendInquiryEmail("no-such-inquiry", { subject: "Hi", body: "Hello" })).rejects.toThrow(/not found/i);
  });

  it("the recipient is ALWAYS the inquiry's own email, re-derived server-side — there is no way to pass an arbitrary 'to' through this action's own input schema at all", async () => {
    const { sendInquiryEmail } = await import("../contact-inquiries");
    // The input type only ever accepts { subject, body } — no `to` field
    // exists on the schema, so there is structurally no client-supplied
    // recipient path, unlike sendLeadEmail's own (pre-existing, untouched)
    // `to` param.
    await sendInquiryEmail("inquiry-1", { subject: "Hi", body: "Hello" });
    expect(sendEmailCalls).toHaveLength(1);
    expect(sendEmailCalls[0].to).toBe("jasur@example.com");
  });

  it("rejects with a clear, actionable message when the admin's Gmail is not connected", async () => {
    gmailConnected = new Set();
    const { sendInquiryEmail } = await import("../contact-inquiries");
    await expect(sendInquiryEmail("inquiry-1", { subject: "Hi", body: "Hello" })).rejects.toThrow(/connect your gmail/i);
    expect(sendEmailCalls).toHaveLength(0);
  });

  it("on success: sends via the admin's own connected Gmail, logs an EmailLog row of type INQUIRY_EMAIL with contactInquiryId set", async () => {
    const { sendInquiryEmail } = await import("../contact-inquiries");
    const result = await sendInquiryEmail("inquiry-1", { subject: "Following up", body: "Thanks for reaching out!" });
    expect(result).toEqual({ ok: true });
    expect(sendEmailCalls[0].accountId).toBe("admin-1");
    expect(emailLogs).toHaveLength(1);
    expect(emailLogs[0].type).toBe("INQUIRY_EMAIL");
    expect(emailLogs[0].status).toBe("SENT");
    expect(emailLogs[0].contactInquiryId).toBe("inquiry-1");
    expect(emailLogs[0].toEmail).toBe("jasur@example.com");
  });

  it("on a failed send: still logs a FAILED EmailLog row and throws with the underlying error", async () => {
    const emailService = await import("@/server/email/service");
    vi.mocked(emailService.sendEmail).mockImplementationOnce(async (args) => {
      sendEmailCalls.push(args as Record<string, unknown>);
      return { ok: false, error: "Your Gmail authorization has expired or been revoked. Please reconnect Gmail." };
    });
    const { sendInquiryEmail } = await import("../contact-inquiries");
    await expect(sendInquiryEmail("inquiry-1", { subject: "Hi", body: "Hello" })).rejects.toThrow(/expired or been revoked/i);
    expect(emailLogs).toHaveLength(1);
    expect(emailLogs[0].status).toBe("FAILED");
  });

  it("rejects an empty subject or body via schema validation, before ever attempting to send", async () => {
    const { sendInquiryEmail } = await import("../contact-inquiries");
    await expect(sendInquiryEmail("inquiry-1", { subject: "", body: "Hello" })).rejects.toThrow();
    await expect(sendInquiryEmail("inquiry-1", { subject: "Hi", body: "" })).rejects.toThrow();
    expect(sendEmailCalls).toHaveLength(0);
  });
});
