import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory fake Prisma, same convention as other server-action test files.
// Covers the user-removal-and-reassignment workflow end to end at the
// action level: reassigning a lead or contact away from a deactivated
// agent must never touch the underlying rows (no delete anywhere in this
// codebase's account-removal path — see accounts.ts's setAccountStatus),
// and — the one real gap found by direct code inspection — the quotes
// belonging to that lead/contact must follow the reassignment (Quote has
// its own independent agentId field, set once at creation, which
// previously never got updated when the lead/contact it belongs to moved
// to a new owner).

type FakeAccount = { id: string; fullName: string; email: string; status: string; companyId: string; role: string };
type FakeContact = { id: string; firstName: string; lastName: string; companyId: string; ownerId: string | null };
type FakeLead = {
  id: string;
  contactId: string;
  assignedAgentId: string | null;
  status: string;
  source: string;
  // Pass 31 — queue-offer fields, for the "manual reassignment must clear
  // a stale outstanding queue offer" regression test below.
  offeredToId?: string | null;
  offeredAt?: Date | null;
  offerExpiresAt?: Date | null;
};
type FakeQuote = { id: string; leadId: string; contactId: string; agentId: string | null };
type FakeStatusHistoryEntry = { leadId: string; fromStatus: string | null; toStatus: string; changedById: string | null };

type FakeActivity = { leadId?: string; contactId?: string; type: string; description: string; actorId?: string; metadata?: Record<string, unknown> };

let currentActor: FakeAccount | null;
let accounts: Map<string, FakeAccount>;
let contacts: Map<string, FakeContact>;
let leadsMap: Map<string, FakeLead>;
let quotes: Map<string, FakeQuote>;
let statusHistory: FakeStatusHistoryEntry[];
let activities: FakeActivity[];

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => currentActor),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/server/activity-log", () => ({
  logActivity: vi.fn(async () => {}),
}));

vi.mock("@/server/email/service", () => ({
  sendEmail: vi.fn(async () => ({ ok: true as const, messageId: "msg-1" })),
}));

vi.mock("@/server/email/templates", () => ({
  buildReassignmentEmail: vi.fn(() => ({ subject: "subject", html: "<p>html</p>" })),
}));

vi.mock("@/server/queries/company", () => ({
  getCompanyForAccountId: vi.fn(async () => ({ id: "company-1", name: "Test Co" })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lead: {
      findUniqueOrThrow: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
        const lead = leadsMap.get(id);
        if (!lead) throw new Error(`lead ${id} not found`);
        const contact = contacts.get(lead.contactId)!;
        const assignedAgent = lead.assignedAgentId ? accounts.get(lead.assignedAgentId) ?? null : null;
        return {
          ...lead,
          contact: { firstName: contact.firstName, lastName: contact.lastName, companyId: contact.companyId },
          assignedAgent: assignedAgent ? { id: assignedAgent.id, fullName: assignedAgent.fullName, email: assignedAgent.email } : null,
          departureAirport: null,
          arrivalAirport: null,
        };
      }),
      update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Partial<FakeLead> }) => {
        const lead = leadsMap.get(id)!;
        Object.assign(lead, data);
        return lead;
      }),
      // Minimal stand-in for leadVisibilityWhere's two real shapes (see
      // visibility.ts): an Admin/Manager's `{ contact: { companyId } }`, or
      // a restricted viewer's `{ assignedAgentId: viewer.id }` — used by
      // updateLeadField's IDOR guard (Pass 34 tests below).
      findFirst: vi.fn(async ({ where }: { where: { id: string; assignedAgentId?: string; contact?: { companyId: string } } }) => {
        const lead = leadsMap.get(where.id);
        if (!lead) return null;
        if (where.assignedAgentId !== undefined && lead.assignedAgentId !== where.assignedAgentId) return null;
        if (where.contact) {
          const contact = contacts.get(lead.contactId);
          if (!contact || contact.companyId !== where.contact.companyId) return null;
        }
        return { id: lead.id, assignedAgentId: lead.assignedAgentId };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: { in: string[] } }; data: Partial<FakeLead> }) => {
        let count = 0;
        for (const l of leadsMap.values()) {
          if (where.id.in.includes(l.id)) {
            Object.assign(l, data);
            count++;
          }
        }
        return { count };
      }),
    },
    contact: {
      // Serves BOTH reassignContact's own IDOR/company-check query (select:
      // {companyId, leads}) and performContactReassignment's query (select:
      // {firstName, lastName, companyId, owner}) — this fake ignores the
      // caller's select/include and returns a shape that satisfies both.
      findUniqueOrThrow: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
        const contact = contacts.get(id);
        if (!contact) throw new Error(`contact ${id} not found`);
        const contactLeads = [...leadsMap.values()].filter((l) => l.contactId === id);
        const owner = contact.ownerId ? accounts.get(contact.ownerId) : null;
        return {
          firstName: contact.firstName,
          lastName: contact.lastName,
          companyId: contact.companyId,
          owner: owner ? { id: owner.id, fullName: owner.fullName, email: owner.email } : null,
          leads: contactLeads.map((l) => ({ id: l.id })),
        };
      }),
      update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Partial<FakeContact> }) => {
        const contact = contacts.get(id)!;
        Object.assign(contact, data);
        return contact;
      }),
    },
    quote: {
      updateMany: vi.fn(async ({ where, data }: { where: { leadId?: string; contactId?: string }; data: Partial<FakeQuote> }) => {
        let count = 0;
        for (const q of quotes.values()) {
          const matches = (where.leadId && q.leadId === where.leadId) || (where.contactId && q.contactId === where.contactId);
          if (matches) {
            Object.assign(q, data);
            count++;
          }
        }
        return { count };
      }),
    },
    account: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
        const account = accounts.get(id);
        return account ? { id: account.id, fullName: account.fullName, status: account.status, companyId: account.companyId } : null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
        const account = accounts.get(id);
        if (!account) throw new Error(`account ${id} not found`);
        return { id: account.id, fullName: account.fullName, email: account.email, status: account.status, companyId: account.companyId };
      }),
    },
    leadStatusHistory: {
      create: vi.fn(async ({ data }: { data: FakeStatusHistoryEntry }) => {
        statusHistory.push(data);
        return data;
      }),
    },
    activity: { create: vi.fn(async ({ data }: { data: FakeActivity }) => { activities.push(data); return data; }) },
    auditLog: { create: vi.fn(async () => ({})) },
    notification: { create: vi.fn(async () => ({})) },
    emailLog: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

beforeEach(() => {
  currentActor = { id: "admin-1", fullName: "Admin One", email: "admin@example.com", status: "ACTIVE", companyId: "company-1", role: "ADMIN" };
  accounts = new Map([
    ["admin-1", { id: "admin-1", fullName: "Admin One", email: "admin@example.com", status: "ACTIVE", companyId: "company-1", role: "ADMIN" }],
    ["agent-a", { id: "agent-a", fullName: "Agent A", email: "a@example.com", status: "INACTIVE", companyId: "company-1", role: "TRAVEL_AGENT" }], // removed
    ["agent-b", { id: "agent-b", fullName: "Agent B", email: "b@example.com", status: "ACTIVE", companyId: "company-1", role: "TRAVEL_AGENT" }],
  ]);
  contacts = new Map([
    ["contact-1", { id: "contact-1", firstName: "Jane", lastName: "Traveler", companyId: "company-1", ownerId: "agent-a" }],
  ]);
  leadsMap = new Map([
    ["lead-1", { id: "lead-1", contactId: "contact-1", assignedAgentId: "agent-a", status: "ATTEMPTING_TO_CONTACT", source: "WEBSITE" }],
  ]);
  quotes = new Map([
    ["quote-1", { id: "quote-1", leadId: "lead-1", contactId: "contact-1", agentId: "agent-a" }],
    ["quote-2", { id: "quote-2", leadId: "lead-1", contactId: "contact-1", agentId: "agent-a" }],
  ]);
  statusHistory = [];
  activities = [];
  vi.clearAllMocks();
});

describe("reassignLead — quotes follow the lead (Part 6/7/8)", () => {
  it("reassigning a removed agent's lead to an active agent also reassigns that lead's own quotes", async () => {
    const { reassignLead } = await import("../leads");
    await reassignLead("lead-1", "agent-b", "Agent A removed");

    expect(leadsMap.get("lead-1")!.assignedAgentId).toBe("agent-b");
    expect(quotes.get("quote-1")!.agentId).toBe("agent-b");
    expect(quotes.get("quote-2")!.agentId).toBe("agent-b");
  });

  it("does not delete the lead or its quotes — they remain fully intact, just reassigned", async () => {
    const { reassignLead } = await import("../leads");
    await reassignLead("lead-1", "agent-b");

    expect(leadsMap.has("lead-1")).toBe(true);
    expect(quotes.has("quote-1")).toBe(true);
    expect(quotes.has("quote-2")).toBe(true);
  });

  it("a sibling lead under the same contact is untouched by reassigning this one lead", async () => {
    leadsMap.set("lead-2", { id: "lead-2", contactId: "contact-1", assignedAgentId: "agent-a", status: "ATTEMPTING_TO_CONTACT", source: "WEBSITE" });
    quotes.set("quote-3", { id: "quote-3", leadId: "lead-2", contactId: "contact-1", agentId: "agent-a" });

    const { reassignLead } = await import("../leads");
    await reassignLead("lead-1", "agent-b");

    expect(leadsMap.get("lead-2")!.assignedAgentId).toBe("agent-a");
    expect(quotes.get("quote-3")!.agentId).toBe("agent-a");
  });
});

// Pass 31 — real bug found and fixed: manually reassigning a Lead that
// currently has an ACTIVE, unexpired queue offer outstanding to some OTHER
// worker previously left that stale offeredToId/offeredAt/offerExpiresAt
// in place — a genuinely inconsistent row (assignedAgentId set AND a
// pending offer to someone else still recorded). No double-assignment was
// ever possible (both getMyLeadOffer and acceptLeadOffer already require
// assignedAgentId: null), but offerLeadToNextWorker's own "is this worker
// already mid-countdown on a different lead" busy-check would still see
// the stale row and could wrongly skip that worker for a genuinely new,
// unrelated lead offer for up to the remaining offer window.
describe("reassignLead — clears a stale outstanding queue offer (Pass 31)", () => {
  it("manually reassigning a lead that still has an active queue offer to someone else clears offeredToId/offeredAt/offerExpiresAt", async () => {
    const future = new Date(Date.now() + 45_000);
    leadsMap.set("lead-1", {
      id: "lead-1",
      contactId: "contact-1",
      assignedAgentId: null,
      status: "ATTEMPTING_TO_CONTACT",
      source: "WEBSITE",
      offeredToId: "some-other-worker",
      offeredAt: new Date(),
      offerExpiresAt: future,
    });

    const { reassignLead } = await import("../leads");
    await reassignLead("lead-1", "agent-b");

    const lead = leadsMap.get("lead-1")!;
    expect(lead.assignedAgentId).toBe("agent-b");
    expect(lead.offeredToId).toBeNull();
    expect(lead.offeredAt).toBeNull();
    expect(lead.offerExpiresAt).toBeNull();
  });

  it("a lead with no outstanding offer is unaffected — offer fields stay null", async () => {
    const { reassignLead } = await import("../leads");
    await reassignLead("lead-1", "agent-b");

    const lead = leadsMap.get("lead-1")!;
    expect(lead.offeredToId ?? null).toBeNull();
    expect(lead.offerExpiresAt ?? null).toBeNull();
  });
});

// Parts 13-16 of the offer-modal/status-flow task: a manual reassignment
// (Agent A -> Agent B) is a completely different flow from a fresh website
// lead going through the 60-second queue — it sets status to ACCEPTED
// (never NEW), never touches source, and never re-enters the queue.
describe("reassignLead — manual reassignment sets status to Accepted (Parts 13-16)", () => {
  it("sets status to ACCEPTED and records the transition in LeadStatusHistory", async () => {
    const { reassignLead } = await import("../leads");
    await reassignLead("lead-1", "agent-b", "Agent A removed");

    expect(leadsMap.get("lead-1")!.status).toBe("ACCEPTED");
    expect(statusHistory).toContainEqual({ leadId: "lead-1", fromStatus: "ATTEMPTING_TO_CONTACT", toStatus: "ACCEPTED", changedById: "admin-1" });
  });

  it("does not touch source, and never resembles a fresh queue-distributed website lead — no NEW status", async () => {
    const { reassignLead } = await import("../leads");
    await reassignLead("lead-1", "agent-b");

    expect(leadsMap.get("lead-1")!.source).toBe("WEBSITE"); // untouched — still whatever it originally was
    expect(leadsMap.get("lead-1")!.status).not.toBe("NEW"); // manual reassignment is never mistaken for a queue acceptance
  });

  it("applies even when the lead already had a further-along status — reassignment always means Accepted (Part 13, unconditional)", async () => {
    leadsMap.set("lead-1", { id: "lead-1", contactId: "contact-1", assignedAgentId: "agent-a", status: "QUOTED", source: "WEBSITE" });

    const { reassignLead } = await import("../leads");
    await reassignLead("lead-1", "agent-b");

    expect(leadsMap.get("lead-1")!.status).toBe("ACCEPTED");
    expect(statusHistory).toContainEqual({ leadId: "lead-1", fromStatus: "QUOTED", toStatus: "ACCEPTED", changedById: "admin-1" });
  });
});

describe("reassignLead — structured metadata on its LEAD_REASSIGNED Activity event (Pass 6, §32.D)", () => {
  it("passes structured previous/new owner data to logActivity, alongside the human-readable description", async () => {
    const { logActivity } = await import("@/server/activity-log");
    const { reassignLead } = await import("../leads");
    await reassignLead("lead-1", "agent-b", "Agent A removed");

    const call = vi.mocked(logActivity).mock.calls.find(([arg]) => arg.type === "LEAD_REASSIGNED");
    expect(call).toBeDefined();
    expect(call![0].metadata).toMatchObject({
      previousOwnerId: "agent-a",
      previousOwnerName: "Agent A",
      newOwnerId: "agent-b",
      newOwnerName: "Agent B",
      reason: "Agent A removed",
    });
  });
});

// Pass 5 audit — reassignLead/reassignContact's canReassignLeads denial
// branch had zero test coverage: every existing test in this file runs as
// an ADMIN. This closes that gap.
describe("reassignLead / reassignContact — authorization denial (Pass 5 gap)", () => {
  it("reassignLead throws for a restricted role (Travel Agent), and does not touch the lead", async () => {
    currentActor = { id: "agent-b", fullName: "Agent B", email: "b@example.com", status: "ACTIVE", companyId: "company-1", role: "TRAVEL_AGENT" };
    const { reassignLead } = await import("../leads");
    await expect(reassignLead("lead-1", "agent-b", "trying to grab it")).rejects.toThrow("not authorized to reassign this lead");
    expect(leadsMap.get("lead-1")!.assignedAgentId).toBe("agent-a"); // unchanged
  });

  it("reassignContact throws for a restricted role (Travel Agent), and does not touch the contact", async () => {
    currentActor = { id: "agent-b", fullName: "Agent B", email: "b@example.com", status: "ACTIVE", companyId: "company-1", role: "TRAVEL_AGENT" };
    const { reassignContact } = await import("../contacts");
    await expect(reassignContact("contact-1", "agent-b", "trying to grab it")).rejects.toThrow("not authorized to reassign this contact");
    expect(contacts.get("contact-1")!.ownerId).toBe("agent-a"); // unchanged
  });

  it("a Manager (not just Admin) is authorized to reassign", async () => {
    currentActor = { id: "manager-1", fullName: "Manager One", email: "m@example.com", status: "ACTIVE", companyId: "company-1", role: "MANAGER" };
    accounts.set("manager-1", currentActor);
    const { reassignLead } = await import("../leads");
    await expect(reassignLead("lead-1", "agent-b")).resolves.toBeDefined();
  });
});

describe("reassignContact — records a CONTACT_REASSIGNED activity event with the previous and new owner (Pass 5 fix — this was previously missing entirely for a contact with no leads)", () => {
  it("records CONTACT_REASSIGNED with the correct previous/new owner names, in addition to the per-lead LEAD_REASSIGNED entries", async () => {
    const { reassignContact } = await import("../contacts");
    await reassignContact("contact-1", "agent-b", "Agent A removed");

    const contactEvent = activities.find((a) => a.type === "CONTACT_REASSIGNED");
    expect(contactEvent).toBeDefined();
    expect(contactEvent!.contactId).toBe("contact-1");
    expect(contactEvent!.description).toContain("Agent A");
    expect(contactEvent!.description).toContain("Agent B");
  });

  it("still records CONTACT_REASSIGNED even when the contact has zero leads (the exact gap this fix closes)", async () => {
    contacts.set("contact-empty", { id: "contact-empty", firstName: "No", lastName: "Leads", companyId: "company-1", ownerId: "agent-a" });
    const { reassignContact } = await import("../contacts");
    await reassignContact("contact-empty", "agent-b", "");

    const contactEvent = activities.find((a) => a.type === "CONTACT_REASSIGNED" && a.contactId === "contact-empty");
    expect(contactEvent).toBeDefined();
  });
});

// Pass 6 (§32.D) — the CONTACT_REASSIGNED/LEAD_REASSIGNED description was
// already human-readable prose; this adds the same previous/new owner data
// as structured Activity.metadata (additive JSON, no schema change, no UI
// change — ActivityTimeline still only renders `description`).
describe("reassignContact — structured metadata on reassignment Activity events (Pass 6, §32.D)", () => {
  it("CONTACT_REASSIGNED carries structured previous/new owner ids and names", async () => {
    const { reassignContact } = await import("../contacts");
    await reassignContact("contact-1", "agent-b", "Agent A removed");

    const contactEvent = activities.find((a) => a.type === "CONTACT_REASSIGNED");
    expect(contactEvent!.metadata).toMatchObject({
      previousOwnerId: "agent-a",
      previousOwnerName: "Agent A",
      newOwnerId: "agent-b",
      newOwnerName: "Agent B",
      reason: "Agent A removed",
    });
  });

  it("does NOT create a per-lead LEAD_REASSIGNED entry — a contact-level reassignment no longer touches any lead's ownership (Pass 7)", async () => {
    const { reassignContact } = await import("../contacts");
    await reassignContact("contact-1", "agent-b", "Agent A removed");

    const leadEvent = activities.find((a) => a.type === "LEAD_REASSIGNED" && a.leadId === "lead-1");
    expect(leadEvent).toBeUndefined();
  });
});

// Pass 7 — Contact ownership and Lead ownership are independent, explicit
// business rules: a Contact reassignment must NOT cascade to its Leads or
// their Quotes. Renamed from the old "quotes follow the contact" describe
// (which asserted the opposite, now-incorrect behavior).
describe("reassignContact — does NOT cascade to leads/quotes (Pass 7: independent ownership)", () => {
  it("reassigning a contact changes ONLY the contact's own owner — its leads and their quotes keep their current owner", async () => {
    const { reassignContact } = await import("../contacts");
    await reassignContact("contact-1", "agent-b", "Agent A removed");

    expect(contacts.get("contact-1")!.ownerId).toBe("agent-b");
    expect(leadsMap.get("lead-1")!.assignedAgentId).toBe("agent-a");
    expect(quotes.get("quote-1")!.agentId).toBe("agent-a");
    expect(quotes.get("quote-2")!.agentId).toBe("agent-a");
  });

  it("does not delete the contact, its leads, or its quotes", async () => {
    const { reassignContact } = await import("../contacts");
    await reassignContact("contact-1", "agent-b", "");

    expect(contacts.has("contact-1")).toBe(true);
    expect(leadsMap.has("lead-1")).toBe(true);
    expect(quotes.has("quote-1")).toBe(true);
    expect(quotes.has("quote-2")).toBe(true);
  });

  it("a quote attached to this contact through contactId alone is also left untouched", async () => {
    quotes.set("quote-orphan", { id: "quote-orphan", leadId: "nonexistent-lead", contactId: "contact-1", agentId: "agent-a" });

    const { reassignContact } = await import("../contacts");
    await reassignContact("contact-1", "agent-b", "");

    expect(quotes.get("quote-orphan")!.agentId).toBe("agent-a");
  });
});

// Pass 7 §37 — the mandatory multi-owner test case: one Contact with
// several Leads, each independently owned by a different agent. Reassigning
// the Contact must not disturb any of them; reassigning one Lead
// afterwards must not disturb the Contact or the other Leads.
describe("Pass 7 §37 — mandatory test case: Contact with multiple independently-owned Leads", () => {
  it("Contact reassignment leaves every lead's own owner exactly as it was, then a single Lead reassignment leaves the Contact and sibling leads exactly as they were", async () => {
    accounts.set("agent-c", { id: "agent-c", fullName: "Agent C", email: "c@example.com", status: "ACTIVE", companyId: "company-1", role: "TRAVEL_AGENT" });
    accounts.set("agent-d", { id: "agent-d", fullName: "Agent D", email: "d@example.com", status: "ACTIVE", companyId: "company-1", role: "TRAVEL_AGENT" });
    accounts.set("agent-e", { id: "agent-e", fullName: "Agent E", email: "e@example.com", status: "ACTIVE", companyId: "company-1", role: "TRAVEL_AGENT" });
    // agent-a is the Contact's owner AND Lead 1's owner to start.
    leadsMap.set("lead-2", { id: "lead-2", contactId: "contact-1", assignedAgentId: "agent-b", status: "ATTEMPTING_TO_CONTACT", source: "WEBSITE" });
    leadsMap.set("lead-3", { id: "lead-3", contactId: "contact-1", assignedAgentId: "agent-c", status: "ATTEMPTING_TO_CONTACT", source: "WEBSITE" });

    const { reassignContact } = await import("../contacts");
    const { reassignLead } = await import("../leads");

    // Reassign the CONTACT to agent-d.
    await reassignContact("contact-1", "agent-d", "consolidating accounts");
    expect(contacts.get("contact-1")!.ownerId).toBe("agent-d");
    expect(leadsMap.get("lead-1")!.assignedAgentId).toBe("agent-a"); // unchanged
    expect(leadsMap.get("lead-2")!.assignedAgentId).toBe("agent-b"); // unchanged
    expect(leadsMap.get("lead-3")!.assignedAgentId).toBe("agent-c"); // unchanged

    // Now reassign only Lead 2 to agent-e.
    await reassignLead("lead-2", "agent-e", "load balancing");
    expect(contacts.get("contact-1")!.ownerId).toBe("agent-d"); // unchanged
    expect(leadsMap.get("lead-1")!.assignedAgentId).toBe("agent-a"); // unchanged
    expect(leadsMap.get("lead-2")!.assignedAgentId).toBe("agent-e"); // the one that moved
    expect(leadsMap.get("lead-3")!.assignedAgentId).toBe("agent-c"); // unchanged
  });
});

// Pass 10 §9/§32 — the exact same mandatory scenario, but starting from
// UNASSIGNED (NULL) ownership on both the Contact and one of its Leads —
// the precise business scenario a website request with no available queue
// recipient produces. Assigning the Contact away from "Unassigned" must
// leave the already-unassigned Lead 1 exactly as unassigned as it was
// (never auto-assigned to the Contact's new owner); only an explicit Lead
// assignment may ever change Lead 1's own owner.
describe("Pass 10 §9/§32 — mandatory test case: Contact and one Lead both start Unassigned", () => {
  it("assigning the Contact away from Unassigned leaves Lead 1 Unassigned; assigning Lead 1 afterwards leaves the Contact and sibling Leads untouched", async () => {
    accounts.set("agent-c", { id: "agent-c", fullName: "Agent C", email: "c@example.com", status: "ACTIVE", companyId: "company-1", role: "TRAVEL_AGENT" });
    accounts.set("agent-d", { id: "agent-d", fullName: "Agent D", email: "d@example.com", status: "ACTIVE", companyId: "company-1", role: "TRAVEL_AGENT" });
    accounts.set("agent-e", { id: "agent-e", fullName: "Agent E", email: "e@example.com", status: "ACTIVE", companyId: "company-1", role: "TRAVEL_AGENT" });

    // Contact and Lead 1 both start Unassigned (e.g. a website request that
    // arrived with nobody accepting leads in the queue). Lead 2/Lead 3 are
    // already independently owned by other agents.
    contacts.set("contact-1", { id: "contact-1", firstName: "Jane", lastName: "Traveler", companyId: "company-1", ownerId: null });
    leadsMap.set("lead-1", { id: "lead-1", contactId: "contact-1", assignedAgentId: null, status: "ATTEMPTING_TO_CONTACT", source: "WEBSITE" });
    leadsMap.set("lead-2", { id: "lead-2", contactId: "contact-1", assignedAgentId: "agent-b", status: "ATTEMPTING_TO_CONTACT", source: "WEBSITE" });
    leadsMap.set("lead-3", { id: "lead-3", contactId: "contact-1", assignedAgentId: "agent-c", status: "ATTEMPTING_TO_CONTACT", source: "WEBSITE" });

    const { reassignContact } = await import("../contacts");
    const { reassignLead } = await import("../leads");

    // Assign the CONTACT (Unassigned → agent-d).
    await reassignContact("contact-1", "agent-d", "manually assigning after queue had nobody accepting");
    expect(contacts.get("contact-1")!.ownerId).toBe("agent-d");
    expect(leadsMap.get("lead-1")!.assignedAgentId).toBeNull(); // still Unassigned — NOT auto-assigned to the Contact's new owner
    expect(leadsMap.get("lead-2")!.assignedAgentId).toBe("agent-b"); // unchanged
    expect(leadsMap.get("lead-3")!.assignedAgentId).toBe("agent-c"); // unchanged

    // Now assign Lead 1 (Unassigned → agent-e) — an independent action.
    await reassignLead("lead-1", "agent-e", "assigning the previously-unclaimed request");
    expect(contacts.get("contact-1")!.ownerId).toBe("agent-d"); // unchanged
    expect(leadsMap.get("lead-1")!.assignedAgentId).toBe("agent-e"); // the one that moved
    expect(leadsMap.get("lead-2")!.assignedAgentId).toBe("agent-b"); // unchanged
    expect(leadsMap.get("lead-3")!.assignedAgentId).toBe("agent-c"); // unchanged
  });

  it("Activity History records the Contact assignment as FROM Unassigned, and the Lead assignment as FROM Unassigned, each exactly once", async () => {
    contacts.set("contact-1", { id: "contact-1", firstName: "Jane", lastName: "Traveler", companyId: "company-1", ownerId: null });
    leadsMap.set("lead-1", { id: "lead-1", contactId: "contact-1", assignedAgentId: null, status: "ATTEMPTING_TO_CONTACT", source: "WEBSITE" });

    const { reassignContact } = await import("../contacts");
    const { logActivity } = await import("@/server/activity-log");
    const { reassignLead } = await import("../leads");

    await reassignContact("contact-1", "agent-b", "");
    const contactEvent = activities.find((a) => a.type === "CONTACT_REASSIGNED");
    expect(contactEvent).toBeDefined();
    expect(contactEvent!.description).toMatch(/assigned to/i); // "Contact assigned to X" — not "reassigned from" a null owner
    expect(contactEvent!.metadata).toMatchObject({ previousOwnerId: null, newOwnerId: "agent-b" });

    await reassignLead("lead-1", "agent-b");
    const leadCall = vi.mocked(logActivity).mock.calls.find(([arg]) => arg.type === "LEAD_REASSIGNED");
    expect(leadCall).toBeDefined();
    expect(leadCall![0].metadata).toMatchObject({ previousOwnerId: null, newOwnerId: "agent-b" });
  });
});

// Pass 34 — real bug found and fixed: updateLeadField (the generic
// lead-detail field-patch action) accepted `assignedAgentId` with none of
// reassignLead's guards — no canReassignLeads check, no same-company
// validation. A Travel Agent who merely owns a lead (passes
// leadVisibilityWhere's `{ assignedAgentId: viewer.id }` check) could call
// it directly with an arbitrary assignedAgentId, including a different
// company's account id, and that lead (with its customer's PII) would then
// appear in that other account's own Leads list. The live UI only ever
// sends `{ assignedAgentId: null }` through this path (unassigning) and
// routes every real reassignment through reassignLead() — so a non-null
// value is now rejected outright, and unassigning still requires the same
// canReassignLeads gate reassignLead() enforces for "move away from an
// existing owner."
describe("updateLeadField — assignedAgentId guard (Pass 34)", () => {
  it("rejects a non-null assignedAgentId outright, even for the lead's own owner", async () => {
    currentActor = { id: "agent-a", fullName: "Agent A", email: "a@example.com", status: "ACTIVE", companyId: "company-1", role: "TRAVEL_AGENT" };
    leadsMap.set("lead-1", { id: "lead-1", contactId: "contact-1", assignedAgentId: "agent-a", status: "ATTEMPTING_TO_CONTACT", source: "WEBSITE" });

    const { updateLeadField } = await import("../leads");
    await expect(updateLeadField("lead-1", { assignedAgentId: "agent-b" })).rejects.toThrow(
      "Use reassignLead to change the assigned agent"
    );
    expect(leadsMap.get("lead-1")!.assignedAgentId).toBe("agent-a"); // unchanged
  });

  it("rejects a non-null assignedAgentId that points at a DIFFERENT company's account", async () => {
    currentActor = { id: "agent-a", fullName: "Agent A", email: "a@example.com", status: "ACTIVE", companyId: "company-1", role: "TRAVEL_AGENT" };
    accounts.set("agent-other-co", { id: "agent-other-co", fullName: "Other Co Agent", email: "o@example.com", status: "ACTIVE", companyId: "company-2", role: "TRAVEL_AGENT" });
    leadsMap.set("lead-1", { id: "lead-1", contactId: "contact-1", assignedAgentId: "agent-a", status: "ATTEMPTING_TO_CONTACT", source: "WEBSITE" });

    const { updateLeadField } = await import("../leads");
    await expect(updateLeadField("lead-1", { assignedAgentId: "agent-other-co" })).rejects.toThrow(
      "Use reassignLead to change the assigned agent"
    );
    expect(leadsMap.get("lead-1")!.assignedAgentId).toBe("agent-a"); // never leaked cross-company
  });

  it("a plain Travel Agent CANNOT unassign a lead currently owned by someone else", async () => {
    currentActor = { id: "agent-b", fullName: "Agent B", email: "b@example.com", status: "ACTIVE", companyId: "company-1", role: "TRAVEL_AGENT" };
    contacts.set("contact-1", { id: "contact-1", firstName: "Jane", lastName: "Traveler", companyId: "company-1", ownerId: null });
    leadsMap.set("lead-1", { id: "lead-1", contactId: "contact-1", assignedAgentId: "agent-a", status: "ATTEMPTING_TO_CONTACT", source: "WEBSITE" });
    accounts.set("agent-a", { id: "agent-a", fullName: "Agent A", email: "a@example.com", status: "ACTIVE", companyId: "company-1", role: "TRAVEL_AGENT" });

    const { updateLeadField } = await import("../leads");
    // leadVisibilityWhere's restricted branch only matches assignedAgentId
    // === viewer.id, so agent-b (who does not own lead-1) can't even reach
    // this lead — findFirst returns null, surfacing as "Lead not found"
    // rather than an authorization-specific message, exactly like every
    // other IDOR guard in this file.
    await expect(updateLeadField("lead-1", { assignedAgentId: null })).rejects.toThrow("Lead not found");
    expect(leadsMap.get("lead-1")!.assignedAgentId).toBe("agent-a");
  });

  it("Admin/Manager CAN unassign a lead away from its current owner", async () => {
    currentActor = { id: "admin-1", fullName: "Admin One", email: "admin@example.com", status: "ACTIVE", companyId: "company-1", role: "ADMIN" };
    leadsMap.set("lead-1", { id: "lead-1", contactId: "contact-1", assignedAgentId: "agent-a", status: "ATTEMPTING_TO_CONTACT", source: "WEBSITE" });

    const { updateLeadField } = await import("../leads");
    await updateLeadField("lead-1", { assignedAgentId: null });
    expect(leadsMap.get("lead-1")!.assignedAgentId).toBeNull();
  });

  it("a plain Travel Agent CANNOT unassign even their OWN lead (matches the UI's own gating — the Assigned Agent editor is hidden for a non-reassigner once a lead is assigned to anyone, including themselves)", async () => {
    currentActor = { id: "agent-a", fullName: "Agent A", email: "a@example.com", status: "ACTIVE", companyId: "company-1", role: "TRAVEL_AGENT" };
    leadsMap.set("lead-1", { id: "lead-1", contactId: "contact-1", assignedAgentId: "agent-a", status: "ATTEMPTING_TO_CONTACT", source: "WEBSITE" });

    const { updateLeadField } = await import("../leads");
    await expect(updateLeadField("lead-1", { assignedAgentId: null })).rejects.toThrow(
      "You are not authorized to reassign this lead"
    );
    expect(leadsMap.get("lead-1")!.assignedAgentId).toBe("agent-a"); // unchanged
  });
});
