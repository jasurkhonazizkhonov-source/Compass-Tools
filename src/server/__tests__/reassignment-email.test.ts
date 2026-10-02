import { describe, it, expect, vi, beforeEach } from "vitest";

// sendLeadReassignmentEmails / sendContactReassignmentEmails: who is emailed,
// from which mailbox, with what content. Prisma, the Gmail send and the
// company lookup are faked at their boundaries; the real templates, the real
// own-Gmail sender and every decision in the module run for real.

type Role = "ADMIN" | "MANAGER" | "TRAVEL_AGENT" | "TICKETING_AGENT" | "FLIGHT_EXPERT" | "MARKETING_AGENT";
type FakeAccount = { id: string; email: string; fullName: string; role: Role; companyId: string; status: string };

let accounts: Map<string, FakeAccount>;
let gmailConnected: Set<string>;
let emailLogs: Array<Record<string, unknown>>;
let lead: Record<string, unknown> | null;
let contact: Record<string, unknown> | null;
let sendResultFor: (accountId: string) => { ok: true; messageId: string } | { ok: false; error: string };

vi.mock("@/server/email/service", () => ({
  sendEmail: vi.fn(async (input: { accountId: string }) => sendResultFor(input.accountId)),
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
    lead: { findUnique: vi.fn(async () => lead) },
    contact: { findUnique: vi.fn(async () => contact) },
    account: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => [...accounts.values()].filter((a) => where.id.in.includes(a.id))),
    },
    emailLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        emailLogs.push(data);
        return data;
      }),
    },
  },
}));

const acct = (id: string, name: string, role: Role, over: Partial<FakeAccount> = {}): FakeAccount => ({ id, email: `${id}@example.com`, fullName: name, role, companyId: "company-1", status: "ACTIVE", ...over });

function baseLead(over: Record<string, unknown> = {}) {
  return {
    contactId: "contact-1",
    status: "QUOTED",
    source: "WEBSITE",
    tripType: "ROUND_TRIP",
    cabinClass: "BUSINESS",
    adults: 2,
    children: 1,
    infants: 0,
    departureDate: new Date("2026-11-03T00:00:00Z"),
    returnDate: new Date("2026-11-17T00:00:00Z"),
    flexibleDates: false,
    preferredAirline: "Air France",
    budget: null,
    notes: "Prefers a window seat.",
    contact: { firstName: "Dark", middleName: null, lastName: "Master", primaryEmail: "dark@client.example", primaryPhone: "+14155550123" },
    departureAirport: { iata: "JFK", name: "John F. Kennedy International Airport", city: "New York", country: "United States" },
    arrivalAirport: { iata: "LGW", name: "London Gatwick Airport", city: "London", country: "United Kingdom" },
    ...over,
  };
}

const LEAD_PARAMS = { leadId: "lead-1", previousOwnerId: "nigora", newOwnerId: "andrew", actorId: "andrew", reassignedAt: new Date("2026-10-02T12:51:00Z"), reason: null };

beforeEach(() => {
  accounts = new Map(
    [acct("nigora", "Nigora Dadabaeva", "TRAVEL_AGENT"), acct("andrew", "Andrew Kent", "MANAGER"), acct("admin", "Sarah Admin", "ADMIN"), acct("ticketer", "Tina Ticketing", "TICKETING_AGENT")].map((a) => [a.id, a])
  );
  gmailConnected = new Set(["nigora", "andrew", "admin", "ticketer"]);
  emailLogs = [];
  lead = baseLead();
  contact = {
    firstName: "Dark",
    middleName: null,
    lastName: "Master",
    primaryEmail: "dark@client.example",
    primaryPhone: "+14155550123",
    _count: { leads: 2 },
  };
  sendResultFor = () => ({ ok: true, messageId: "gmail-1" });
  vi.clearAllMocks();
});

async function sentCalls() {
  const { sendEmail } = await import("@/server/email/service");
  return vi.mocked(sendEmail).mock.calls.map(([c]) => c);
}

describe("sendLeadReassignmentEmails", () => {
  it("emails BOTH people, each FROM their own Gmail TO their own address — never from the actor, and never from anyone else's mailbox", async () => {
    const { sendLeadReassignmentEmails } = await import("../reassignment-email");
    const outcome = await sendLeadReassignmentEmails({ ...LEAD_PARAMS, actorId: "admin" });
    expect(outcome).toEqual({ previousOwner: "SENT", newOwner: "SENT" });
    const calls = await sentCalls();
    expect(calls).toHaveLength(2);
    const prev = calls.find((c) => c.accountId === "nigora")!;
    const next = calls.find((c) => c.accountId === "andrew")!;
    expect(prev.to).toBe("nigora@example.com");
    expect(next.to).toBe("andrew@example.com");
    // the admin who performed the reassignment sends nothing
    expect(calls.some((c) => c.accountId === "admin")).toBe(false);
  });

  it("uses distinct subjects: 'Lead Reassigned — …' for the previous owner and 'Lead Reassigned to You — …' for the new owner — never the New Flight Request subject", async () => {
    const { sendLeadReassignmentEmails } = await import("../reassignment-email");
    await sendLeadReassignmentEmails(LEAD_PARAMS);
    const calls = await sentCalls();
    expect(calls.find((c) => c.accountId === "nigora")!.subject).toBe("Lead Reassigned — Dark Master");
    expect(calls.find((c) => c.accountId === "andrew")!.subject).toBe("Lead Reassigned to You — Dark Master");
    expect(calls.every((c) => !/New Flight Request/i.test(c.subject))).toBe(true);
  });

  it("previous-owner email: explains the lead left THEIR account, names the new owner and who did it, and never tells them 'Previous owner: <themselves>'", async () => {
    const { sendLeadReassignmentEmails } = await import("../reassignment-email");
    await sendLeadReassignmentEmails({ ...LEAD_PARAMS, actorId: "admin", reason: "Territory change" });
    const html = (await sentCalls()).find((c) => c.accountId === "nigora")!.html;
    expect(html).toContain("Hi Nigora,");
    expect(html).toContain("has been reassigned from your account");
    expect(html).toContain("Dark Master");
    expect(html).toContain("New owner");
    expect(html).toContain("Andrew Kent");
    expect(html).toContain("Reassigned by");
    expect(html).toContain("Sarah Admin");
    expect(html).toContain("Territory change");
    expect(html).not.toContain("Previous owner");
    // customer contact details are not re-sent to someone who no longer owns the lead
    expect(html).not.toContain("dark@client.example");
    expect(html).not.toContain("+1 415");
  });

  it("previous-owner email for a restricted role has NO link (they can no longer open the lead) — only a plain reference", async () => {
    const { sendLeadReassignmentEmails } = await import("../reassignment-email");
    await sendLeadReassignmentEmails(LEAD_PARAMS); // nigora is a TRAVEL_AGENT: sees only her own leads
    const html = (await sentCalls()).find((c) => c.accountId === "nigora")!.html;
    expect(html).not.toMatch(/href="[^"]*\/leads\//);
    expect(html).not.toContain(">View Lead<");
    expect(html).not.toContain(">Open Lead<");
    expect(html).toContain("Lead Reference");
    expect(html).toContain("JFK → LGW");
  });

  it("previous-owner email for a role that sees every lead (Admin/Manager) carries a neutral 'Lead Link', never 'View Lead'", async () => {
    accounts.set("nigora", acct("nigora", "Nigora Dadabaeva", "MANAGER"));
    const { sendLeadReassignmentEmails } = await import("../reassignment-email");
    await sendLeadReassignmentEmails(LEAD_PARAMS);
    const html = (await sentCalls()).find((c) => c.accountId === "nigora")!.html;
    expect(html).toMatch(/href="[^"]*\/leads\/lead-1"/);
    expect(html).toContain(">Lead Link<");
    expect(html).not.toContain(">View Lead<");
  });

  it("new-owner email: full detail — client, trip, itinerary (both legs), notes, source, status, previous owner, reassigned by/at — with an authenticated Open Lead link", async () => {
    const { sendLeadReassignmentEmails } = await import("../reassignment-email");
    await sendLeadReassignmentEmails({ ...LEAD_PARAMS, actorId: "admin" });
    const html = (await sentCalls()).find((c) => c.accountId === "andrew")!.html;
    for (const text of [
      "Hi Andrew,",
      "reassigned to your account",
      "Dark Master",
      "dark@client.example",
      "+1 415 555 0123",
      "Business",
      "2 adults, 1 child",
      "John F. Kennedy International Airport",
      "London Gatwick Airport",
      "Outbound",
      "Return",
      "Nov 3, 2026",
      "Nov 17, 2026",
      "Air France",
      "Prefers a window seat.",
      "Website",
      "Quoted",
      "Previous owner",
      "Nigora Dadabaeva",
      "Reassigned by",
      "Sarah Admin",
      "October 2, 2026",
    ]) {
      expect(html, text).toContain(text);
    }
    expect(html).toMatch(/href="[^"]*\/leads\/lead-1"/);
    expect(html).toContain(">Open Lead<");
    expect(html).toContain('href="mailto:dark@client.example');
    expect(html).toContain('href="tel:+14155550123"');
  });

  it("omits fields that are not on the lead instead of inventing them", async () => {
    lead = baseLead({ notes: null, preferredAirline: null, returnDate: null, tripType: "ONE_WAY", contact: { firstName: "Dark", middleName: null, lastName: "Master", primaryEmail: null, primaryPhone: null } });
    const { sendLeadReassignmentEmails } = await import("../reassignment-email");
    await sendLeadReassignmentEmails(LEAD_PARAMS);
    const html = (await sentCalls()).find((c) => c.accountId === "andrew")!.html;
    for (const text of ["Notes From The Client", "Preferred airline", "Return date", ">Return<", "mailto:", "tel:", "undefined", "null"]) {
      expect(html, text).not.toContain(text);
    }
  });

  it("a new owner whose role has no Leads page (Ticketing Agent) gets the detail but no link", async () => {
    const { sendLeadReassignmentEmails } = await import("../reassignment-email");
    await sendLeadReassignmentEmails({ ...LEAD_PARAMS, newOwnerId: "ticketer", actorId: "admin" });
    const html = (await sentCalls()).find((c) => c.accountId === "ticketer")!.html;
    expect(html).not.toMatch(/href="[^"]*\/leads\//);
  });

  it("logs each send as LEAD_REASSIGNMENT (never NEW_LEAD_ASSIGNMENT) with from = to = the recipient", async () => {
    const { sendLeadReassignmentEmails } = await import("../reassignment-email");
    await sendLeadReassignmentEmails(LEAD_PARAMS);
    expect(emailLogs).toHaveLength(2);
    expect(emailLogs.every((l) => l.type === "LEAD_REASSIGNMENT")).toBe(true);
    for (const l of emailLogs) {
      expect(l.fromEmail).toBe(l.toEmail);
      expect(l.status).toBe("SENT");
      expect(l.leadId).toBe("lead-1");
    }
  });

  it("a recipient with no connected Gmail is NOT rerouted through anyone else's mailbox: it is recorded FAILED and the other person is still emailed", async () => {
    gmailConnected.delete("nigora");
    const { sendLeadReassignmentEmails } = await import("../reassignment-email");
    const outcome = await sendLeadReassignmentEmails({ ...LEAD_PARAMS, actorId: "admin" });
    expect(outcome).toEqual({ previousOwner: "FAILED", newOwner: "SENT" });
    const calls = await sentCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].accountId).toBe("andrew");
    const failed = emailLogs.find((l) => l.toEmail === "nigora@example.com")!;
    expect(failed).toMatchObject({ status: "FAILED", fromEmail: "unsent" });
  });

  it("a failing send for one recipient does not stop the other", async () => {
    sendResultFor = (id) => (id === "andrew" ? { ok: false, error: "Gmail could not send this email. Please try again." } : { ok: true, messageId: "ok" });
    const { sendLeadReassignmentEmails } = await import("../reassignment-email");
    const outcome = await sendLeadReassignmentEmails(LEAD_PARAMS);
    expect(outcome).toEqual({ previousOwner: "SENT", newOwner: "FAILED" });
  });

  it("sends nothing when the owner did not change (A → A) or there was no previous owner", async () => {
    const { sendLeadReassignmentEmails } = await import("../reassignment-email");
    expect(await sendLeadReassignmentEmails({ ...LEAD_PARAMS, newOwnerId: "nigora" })).toEqual({ previousOwner: "SKIPPED", newOwner: "SKIPPED" });
    expect(await sendLeadReassignmentEmails({ ...LEAD_PARAMS, previousOwnerId: null })).toEqual({ previousOwner: "SKIPPED", newOwner: "SKIPPED" });
    expect(await sentCalls()).toHaveLength(0);
  });

  it("does not email a deactivated previous owner (the usual reason a lead is moved off someone)", async () => {
    accounts.set("nigora", acct("nigora", "Nigora Dadabaeva", "TRAVEL_AGENT", { status: "INACTIVE" }));
    const { sendLeadReassignmentEmails } = await import("../reassignment-email");
    const outcome = await sendLeadReassignmentEmails(LEAD_PARAMS);
    expect(outcome.previousOwner).toBe("SKIPPED");
    expect(outcome.newOwner).toBe("SENT");
  });

  it("never throws, and never leaks the underlying error message", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.lead.findUnique).mockRejectedValueOnce(new Error("connection to nigora@example.com refused"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sendLeadReassignmentEmails } = await import("../reassignment-email");
    await expect(sendLeadReassignmentEmails(LEAD_PARAMS)).resolves.toEqual({ previousOwner: "SKIPPED", newOwner: "SKIPPED" });
    expect(spy.mock.calls.flat().join(" ")).not.toContain("nigora@example.com");
    spy.mockRestore();
  });

  it("has no connection to the New Flight Request flow", async () => {
    const mod = await import("../reassignment-email");
    expect(Object.keys(mod).some((k) => /NewFlightRequest/i.test(k))).toBe(false);
  });
});

describe("sendContactReassignmentEmails", () => {
  const CONTACT_PARAMS = { contactId: "contact-1", previousOwnerId: "nigora", newOwnerId: "andrew", actorId: "admin", reassignedAt: new Date("2026-10-02T12:51:00Z"), reason: null };

  it("emails both people from their own Gmail, with contact (not lead) wording and the CONTACT_REASSIGNMENT log type", async () => {
    const { sendContactReassignmentEmails } = await import("../reassignment-email");
    const outcome = await sendContactReassignmentEmails(CONTACT_PARAMS);
    expect(outcome).toEqual({ previousOwner: "SENT", newOwner: "SENT" });
    const calls = await sentCalls();
    expect(calls.find((c) => c.accountId === "nigora")!.subject).toBe("Contact Reassigned — Dark Master");
    expect(calls.find((c) => c.accountId === "andrew")!.subject).toBe("Contact Reassigned to You — Dark Master");
    expect(calls.every((c) => !/lead/i.test(c.subject))).toBe(true);
    expect(emailLogs.every((l) => l.type === "CONTACT_REASSIGNMENT" && l.fromEmail === l.toEmail)).toBe(true);
  });

  it("previous owner: no redundant 'Previous owner', no customer contact details, and a note that their leads are unaffected", async () => {
    const { sendContactReassignmentEmails } = await import("../reassignment-email");
    await sendContactReassignmentEmails(CONTACT_PARAMS);
    const html = (await sentCalls()).find((c) => c.accountId === "nigora")!.html;
    expect(html).not.toContain("Previous owner");
    expect(html).not.toContain("dark@client.example");
    expect(html).toContain("any leads you own for this contact are unaffected");
    expect(html).toContain("Contact Reference");
  });

  it("new owner: contact details with mailto:/tel:, the real lead count, and a link only because they can open it", async () => {
    const { sendContactReassignmentEmails } = await import("../reassignment-email");
    await sendContactReassignmentEmails(CONTACT_PARAMS);
    const html = (await sentCalls()).find((c) => c.accountId === "andrew")!.html;
    expect(html).toContain("dark@client.example");
    expect(html).toContain("+1 415 555 0123");
    expect(html).toContain("Leads on this contact");
    expect(html).toContain("Previous owner");
    expect(html).toMatch(/href="[^"]*\/contacts\/contact-1"/);
    expect(html).toContain(">Open Contact<");
  });

  it("a system-triggered reassignment (no actor) is labelled honestly rather than inventing a person", async () => {
    const { sendContactReassignmentEmails } = await import("../reassignment-email");
    await sendContactReassignmentEmails({ ...CONTACT_PARAMS, actorId: null, reason: "Updated contact information matched an existing contact owned by another agent" });
    const html = (await sentCalls()).find((c) => c.accountId === "andrew")!.html;
    expect(html).toContain("Automatic ownership match");
  });

  it("sends nothing for an unchanged owner or a first assignment", async () => {
    const { sendContactReassignmentEmails } = await import("../reassignment-email");
    expect(await sendContactReassignmentEmails({ ...CONTACT_PARAMS, newOwnerId: "nigora" })).toEqual({ previousOwner: "SKIPPED", newOwner: "SKIPPED" });
    expect(await sendContactReassignmentEmails({ ...CONTACT_PARAMS, previousOwnerId: null })).toEqual({ previousOwner: "SKIPPED", newOwner: "SKIPPED" });
    expect(await sentCalls()).toHaveLength(0);
  });
});
