import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass 6 — the Contact detail page's Email button (sendContactEmail) and
// the shared sendCrmEmail core it and sendLeadEmail both now use. The
// primary thing under test is the security fix folded into this
// extraction: the original sendLeadEmail only checked that `to` was
// SYNTACTICALLY a valid email — it never verified the address actually
// belonged to the lead's contact. A malicious/tampered request could have
// supplied an arbitrary external address. Every test below that expects
// rejection is exercising exactly that scenario.

type FakeAccount = { id: string; role: string; companyId: string; fullName: string; email: string; phone: string | null };
type FakeContact = { id: string; companyId: string; ownerId: string | null; primaryEmail: string | null; emails: string[] };
type FakeLead = { id: string; contactId: string; assignedAgentId: string | null };
type FakeEmailLog = { type: string; toEmail: string; leadId?: string; contactId?: string; status: string };
type FakeActivity = { type: string; leadId?: string; contactId?: string; actorId?: string };

let currentActor: FakeAccount | null;
let contacts: Map<string, FakeContact>;
let leads: Map<string, FakeLead>;
let emailLogs: FakeEmailLog[];
let activities: FakeActivity[];
let gmailStatus: "CONNECTED" | "REVOKED" | "NOT_CONNECTED";
let sendEmailCalls: Array<{ to: string; accountId: string }>;

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => currentActor),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/queries/gmail-connection", () => ({
  getGmailConnectionState: vi.fn(async () => gmailStatus),
}));
vi.mock("@/server/queries/company", () => ({
  getCompanyForAccountId: vi.fn(async () => ({ id: "company-1", name: "Test Co", brandColor: "#000", logoEmailUrl: null })),
}));
vi.mock("@/server/email/templates", () => ({
  buildSequenceEmail: vi.fn(({ subject }: { subject: string }) => ({ subject, html: "<p>rendered</p>" })),
  buildReassignmentEmail: vi.fn(() => ({ subject: "s", html: "<p>h</p>" })),
}));
vi.mock("@/server/email/service", () => ({
  sendEmail: vi.fn(async ({ to, accountId }: { to: string; accountId: string }) => {
    sendEmailCalls.push({ to, accountId });
    return { ok: true as const, messageId: "msg-1" };
  }),
}));

function canViewAllRecords(role: string) {
  return role === "ADMIN" || role === "MANAGER" || role === "TICKETING_AGENT";
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    contact: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const contact = contacts.get(where.id);
        if (!contact || !currentActor) return null;
        if (canViewAllRecords(currentActor.role)) {
          return contact.companyId === currentActor.companyId
            ? { id: contact.id, primaryEmail: contact.primaryEmail, emails: contact.emails.map((email) => ({ email })) }
            : null;
        }
        return contact.ownerId === currentActor.id
          ? { id: contact.id, primaryEmail: contact.primaryEmail, emails: contact.emails.map((email) => ({ email })) }
          : null;
      }),
    },
    lead: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const lead = leads.get(where.id);
        if (!lead || !currentActor) return null;
        const contact = contacts.get(lead.contactId)!;
        const visible = canViewAllRecords(currentActor.role)
          ? contact.companyId === currentActor.companyId
          : lead.assignedAgentId === currentActor.id;
        if (!visible) return null;
        return {
          id: lead.id,
          contactId: lead.contactId,
          contact: { primaryEmail: contact.primaryEmail, emails: contact.emails.map((email) => ({ email })) },
        };
      }),
    },
    emailLog: {
      create: vi.fn(async ({ data }: { data: FakeEmailLog }) => {
        emailLogs.push(data);
        return data;
      }),
    },
    activity: {
      create: vi.fn(async ({ data }: { data: FakeActivity }) => {
        activities.push(data);
        return data;
      }),
    },
  },
}));

beforeEach(() => {
  currentActor = { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-1", fullName: "Agent One", email: "agent1@example.com", phone: null };
  contacts = new Map([
    ["contact-1", { id: "contact-1", companyId: "company-1", ownerId: "agent-1", primaryEmail: "john@example.com", emails: ["john@example.com", "john.work@example.com"] }],
    ["contact-2", { id: "contact-2", companyId: "company-1", ownerId: "agent-2", primaryEmail: "jane@example.com", emails: ["jane@example.com"] }],
  ]);
  leads = new Map([
    ["lead-1", { id: "lead-1", contactId: "contact-1", assignedAgentId: "agent-1" }],
    ["lead-2", { id: "lead-2", contactId: "contact-2", assignedAgentId: "agent-2" }],
  ]);
  emailLogs = [];
  activities = [];
  sendEmailCalls = [];
  gmailStatus = "CONNECTED";
  vi.clearAllMocks();
});

describe("sendContactEmail — recipient must belong to the contact (security)", () => {
  it("sends successfully to the contact's own primary email", async () => {
    const { sendContactEmail } = await import("../contacts");
    const result = await sendContactEmail("contact-1", { to: "john@example.com", subject: "Hi", body: "Hello there" });
    expect(result.ok).toBe(true);
    expect(sendEmailCalls).toHaveLength(1);
    expect(sendEmailCalls[0].to).toBe("john@example.com");
  });

  it("sends successfully to a secondary email on file", async () => {
    const { sendContactEmail } = await import("../contacts");
    await sendContactEmail("contact-1", { to: "john.work@example.com", subject: "Hi", body: "Hello" });
    expect(sendEmailCalls[0].to).toBe("john.work@example.com");
  });

  it("REJECTS an arbitrary address not on file for the contact — the exact injection scenario", async () => {
    const { sendContactEmail } = await import("../contacts");
    await expect(sendContactEmail("contact-1", { to: "attacker@evil.com", subject: "Hi", body: "Hello" })).rejects.toThrow(/not one of this contact's known email addresses/);
    expect(sendEmailCalls).toHaveLength(0);
    expect(emailLogs).toHaveLength(0);
  });

  it("REJECTS a mix of one valid and one invalid recipient — the whole send is refused, not partially sent", async () => {
    const { sendContactEmail } = await import("../contacts");
    await expect(sendContactEmail("contact-1", { to: "john@example.com, attacker@evil.com", subject: "Hi", body: "Hello" })).rejects.toThrow(/attacker@evil\.com/);
    expect(sendEmailCalls).toHaveLength(0);
  });

  it("REJECTS sending to a DIFFERENT real contact's email through this contact's id (cross-contact injection)", async () => {
    const { sendContactEmail } = await import("../contacts");
    await expect(sendContactEmail("contact-1", { to: "jane@example.com", subject: "Hi", body: "Hello" })).rejects.toThrow(/not one of this contact's known email addresses/);
  });

  it("REJECTS access to a contact the actor cannot see (IDOR)", async () => {
    const { sendContactEmail } = await import("../contacts");
    await expect(sendContactEmail("contact-2", { to: "jane@example.com", subject: "Hi", body: "Hello" })).rejects.toThrow("Contact not found");
    expect(sendEmailCalls).toHaveLength(0);
  });

  it("an ADMIN can email any contact's on-file address within the company", async () => {
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1", fullName: "Admin", email: "admin@example.com", phone: null };
    const { sendContactEmail } = await import("../contacts");
    await expect(sendContactEmail("contact-2", { to: "jane@example.com", subject: "Hi", body: "Hello" })).resolves.toEqual({ ok: true });
  });

  it("logs exactly one Activity entry (EMAIL_SENT) scoped to the contact, not duplicated", async () => {
    const { sendContactEmail } = await import("../contacts");
    await sendContactEmail("contact-1", { to: "john@example.com", subject: "Hi", body: "Hello" });
    const emailActivities = activities.filter((a) => a.type === "EMAIL_SENT");
    expect(emailActivities).toHaveLength(1);
    expect(emailActivities[0].contactId).toBe("contact-1");
    expect(emailActivities[0].actorId).toBe("agent-1");
  });

  it("records the EmailLog under CONTACT_EMAIL, distinct from LEAD_EMAIL", async () => {
    const { sendContactEmail } = await import("../contacts");
    await sendContactEmail("contact-1", { to: "john@example.com", subject: "Hi", body: "Hello" });
    expect(emailLogs[0].type).toBe("CONTACT_EMAIL");
    expect(emailLogs[0].contactId).toBe("contact-1");
  });

  it("rejects when Gmail is not connected, before ever attempting to send", async () => {
    gmailStatus = "NOT_CONNECTED";
    const { sendContactEmail } = await import("../contacts");
    await expect(sendContactEmail("contact-1", { to: "john@example.com", subject: "Hi", body: "Hello" })).rejects.toThrow(/Connect your Gmail/);
    expect(sendEmailCalls).toHaveLength(0);
  });

  it("rejects a syntactically invalid recipient before any DB/Gmail work happens", async () => {
    const { sendContactEmail } = await import("../contacts");
    await expect(sendContactEmail("contact-1", { to: "not-an-email", subject: "Hi", body: "Hello" })).rejects.toThrow();
    expect(sendEmailCalls).toHaveLength(0);
  });
});

describe("sendLeadEmail — same recipient-ownership check, now via the shared core (regression: this was the original vulnerability)", () => {
  it("sends successfully to the lead's contact's own email", async () => {
    const { sendLeadEmail } = await import("../leads");
    const result = await sendLeadEmail("lead-1", { to: "john@example.com", subject: "Hi", body: "Hello" });
    expect(result.ok).toBe(true);
    expect(sendEmailCalls[0].to).toBe("john@example.com");
  });

  it("REJECTS an arbitrary address not belonging to the lead's contact", async () => {
    const { sendLeadEmail } = await import("../leads");
    await expect(sendLeadEmail("lead-1", { to: "attacker@evil.com", subject: "Hi", body: "Hello" })).rejects.toThrow(/not one of this contact's known email addresses/);
    expect(sendEmailCalls).toHaveLength(0);
  });

  it("REJECTS a lead the actor cannot see (IDOR)", async () => {
    const { sendLeadEmail } = await import("../leads");
    await expect(sendLeadEmail("lead-2", { to: "jane@example.com", subject: "Hi", body: "Hello" })).rejects.toThrow("Lead not found");
  });

  it("logs the Activity/EmailLog against both the lead and its contact", async () => {
    const { sendLeadEmail } = await import("../leads");
    await sendLeadEmail("lead-1", { to: "john@example.com", subject: "Hi", body: "Hello" });
    expect(emailLogs[0]).toMatchObject({ leadId: "lead-1", contactId: "contact-1", type: "LEAD_EMAIL" });
    const emailActivity = activities.find((a) => a.type === "EMAIL_SENT");
    expect(emailActivity).toMatchObject({ leadId: "lead-1", contactId: "contact-1" });
  });
});
