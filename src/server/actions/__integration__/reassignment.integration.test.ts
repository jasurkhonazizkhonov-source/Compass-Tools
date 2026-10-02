// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

// REAL-DATABASE integration test for lead/contact reassignment. Runs only
// when INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL database
// with this repo's migrations applied; skipped otherwise. It creates its own
// uniquely-tagged rows and removes them afterwards.
//
// What the fake-Prisma unit tests cannot prove and this does: that the owner
// change is a genuine atomic compare-and-set under real concurrency — two
// simultaneous identical requests produce ONE hand-off (one history row, one
// activity, one audit row, one email request), and two conflicting requests
// produce exactly one winner.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;

if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
  process.env.CARD_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_HASH_KEY ??= randomBytes(32).toString("base64");
}

type Actor = { id: string; fullName: string; email: string; role: string; status: string; companyId: string };
let currentActor: Actor | null = null;
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/reassignment-email", () => ({
  sendLeadReassignmentEmails: vi.fn(async () => ({ previousOwner: "SENT", newOwner: "SENT" })),
  sendContactReassignmentEmails: vi.fn(async () => ({ previousOwner: "SENT", newOwner: "SENT" })),
}));

const TAG = `reassign-${Date.now()}`;

describe.skipIf(!enabled)("reassignment against a real PostgreSQL database", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let reassignLead: typeof import("../leads").reassignLead;
  let reassignContact: typeof import("../contacts").reassignContact;
  let emails: typeof import("@/server/reassignment-email");
  const accountIds: string[] = [];
  const contactIds: string[] = [];
  let admin: Actor;
  let agentA: Actor;
  let agentB: Actor;
  let agentC: Actor;

  async function makeAccount(name: string, role: "ADMIN" | "TRAVEL_AGENT"): Promise<Actor> {
    const a = await prisma.account.create({
      data: { fullName: name, email: `${name.toLowerCase().replace(/\W+/g, "")}-${TAG}@example.test`, role, status: "ACTIVE", companyId: "default-company" },
      select: { id: true, fullName: true, email: true, role: true, status: true, companyId: true },
    });
    accountIds.push(a.id);
    return a;
  }

  async function makeLead(ownerId: string | null) {
    const contact = await prisma.contact.create({
      data: { firstName: "Dark", lastName: `Master-${TAG}-${contactIds.length}`, primaryEmail: `c${contactIds.length}-${TAG}@example.test`, companyId: "default-company", ownerId },
    });
    contactIds.push(contact.id);
    const lead = await prisma.lead.create({ data: { contactId: contact.id, status: "QUOTED", source: "OTHER", assignedAgentId: ownerId } });
    const quote = await prisma.quote.create({
      data: { quoteNumber: `Q-${TAG}-${contactIds.length}`, secureToken: `tok-${TAG}-${contactIds.length}`, leadId: lead.id, contactId: contact.id, agentId: ownerId, status: "SENT", adults: 1, adultPrice: 500, taxes: 0, serviceFee: 0, total: 500 },
    });
    return { contact, lead, quote };
  }

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ reassignLead } = await import("../leads"));
    ({ reassignContact } = await import("../contacts"));
    emails = await import("@/server/reassignment-email");
    await prisma.company.upsert({ where: { id: "default-company" }, update: {}, create: { id: "default-company", name: "Test Co", signatureTemplate: "Regards" } });
    admin = await makeAccount("Admin Actor", "ADMIN");
    agentA = await makeAccount("Agent Alpha", "TRAVEL_AGENT");
    agentB = await makeAccount("Agent Bravo", "TRAVEL_AGENT");
    agentC = await makeAccount("Agent Charlie", "TRAVEL_AGENT");
  });

  afterAll(async () => {
    if (!enabled) return;
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    await prisma.notification.deleteMany({ where: { accountId: { in: accountIds } } });
    // Audit rows are append-only by design; they reference accounts only by id text.
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } }).catch(() => {});
    await prisma.$disconnect();
  });

  const reset = () => {
    vi.mocked(emails.sendLeadReassignmentEmails).mockClear();
    vi.mocked(emails.sendContactReassignmentEmails).mockClear();
    currentActor = admin;
  };

  it("A → B moves the lead and its quote, records ONE history/activity/audit row, notifies both people once, and requests one email pair", async () => {
    reset();
    const { lead, quote } = await makeLead(agentA.id);
    await reassignLead(lead.id, agentB.id, "Load balancing");

    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).assignedAgentId).toBe(agentB.id);
    expect((await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } })).agentId).toBe(agentB.id);
    expect(await prisma.leadStatusHistory.count({ where: { leadId: lead.id } })).toBe(1);
    expect(await prisma.activity.count({ where: { leadId: lead.id, type: "LEAD_REASSIGNED" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityType: "Lead", entityId: lead.id, action: "LEAD_REASSIGNED" } })).toBe(1);
    expect(await prisma.notification.count({ where: { leadId: lead.id, accountId: agentA.id, type: "LEAD_REASSIGNED" } })).toBe(1);
    expect(await prisma.notification.count({ where: { leadId: lead.id, accountId: agentB.id, type: "LEAD_ASSIGNED" } })).toBe(1);
    expect(emails.sendLeadReassignmentEmails).toHaveBeenCalledTimes(1);
    expect(emails.sendLeadReassignmentEmails).toHaveBeenCalledWith(expect.objectContaining({ previousOwnerId: agentA.id, newOwnerId: agentB.id, actorId: admin.id }));
  });

  it("two simultaneous identical requests (double-click / retry) produce exactly ONE hand-off", async () => {
    reset();
    const { lead } = await makeLead(agentA.id);
    await Promise.allSettled([reassignLead(lead.id, agentB.id), reassignLead(lead.id, agentB.id), reassignLead(lead.id, agentB.id)]);

    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).assignedAgentId).toBe(agentB.id);
    expect(await prisma.leadStatusHistory.count({ where: { leadId: lead.id } })).toBe(1);
    expect(await prisma.activity.count({ where: { leadId: lead.id, type: "LEAD_REASSIGNED" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityType: "Lead", entityId: lead.id, action: "LEAD_REASSIGNED" } })).toBe(1);
    expect(await prisma.notification.count({ where: { leadId: lead.id, accountId: agentB.id, type: "LEAD_ASSIGNED" } })).toBe(1);
    expect(emails.sendLeadReassignmentEmails).toHaveBeenCalledTimes(1);
  });

  it("two conflicting requests (→ B and → C at once) have exactly one winner; only the winner's hand-off is recorded and emailed", async () => {
    reset();
    const { lead } = await makeLead(agentA.id);
    const settled = await Promise.allSettled([reassignLead(lead.id, agentB.id), reassignLead(lead.id, agentC.id)]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const owner = (await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).assignedAgentId;
    expect([agentB.id, agentC.id]).toContain(owner);
    expect(await prisma.leadStatusHistory.count({ where: { leadId: lead.id } })).toBe(1);
    expect(emails.sendLeadReassignmentEmails).toHaveBeenCalledTimes(1);
  });

  it("A → A changes nothing and records/sends nothing", async () => {
    reset();
    const { lead } = await makeLead(agentA.id);
    await reassignLead(lead.id, agentA.id);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe("QUOTED");
    expect(await prisma.leadStatusHistory.count({ where: { leadId: lead.id } })).toBe(0);
    expect(await prisma.activity.count({ where: { leadId: lead.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { leadId: lead.id } })).toBe(0);
    expect(emails.sendLeadReassignmentEmails).not.toHaveBeenCalled();
  });

  it("a Travel Agent cannot reassign someone else's lead by calling the action directly", async () => {
    reset();
    const { lead } = await makeLead(agentA.id);
    currentActor = agentB;
    await expect(reassignLead(lead.id, agentB.id)).rejects.toThrow(/not authorized/i);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).assignedAgentId).toBe(agentA.id);
    expect(emails.sendLeadReassignmentEmails).not.toHaveBeenCalled();
  });

  it("contact: A → B moves ONLY the contact (its lead keeps its owner), once, with one email request — even under a double-click", async () => {
    reset();
    const { contact, lead } = await makeLead(agentA.id);
    await Promise.allSettled([reassignContact(contact.id, agentB.id, "Territory"), reassignContact(contact.id, agentB.id, "Territory")]);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).ownerId).toBe(agentB.id);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).assignedAgentId).toBe(agentA.id);
    expect(await prisma.activity.count({ where: { contactId: contact.id, type: "CONTACT_REASSIGNED" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityType: "Contact", entityId: contact.id, action: "CONTACT_REASSIGNED" } })).toBe(1);
    expect(emails.sendContactReassignmentEmails).toHaveBeenCalledTimes(1);
    expect(emails.sendLeadReassignmentEmails).not.toHaveBeenCalled();
  });
});
