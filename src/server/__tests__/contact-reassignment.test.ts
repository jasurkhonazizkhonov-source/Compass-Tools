import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory fake Prisma — covers recheckContactOwnershipMatch (Part 15/16):
// after a Contact's primary phone/email is edited to match a DIFFERENT
// existing Contact's own phone/email, the edited Contact must be
// automatically reassigned to that OTHER contact's owner — company-scoped,
// and a no-op when there's nothing to do.
//
// Pass 7 — Contact ownership and Lead ownership are independent: this used
// to also cascade the edited contact's Leads/Quotes to the new owner; that
// cascade is now gone (performContactReassignment's own doc comment), so
// the tests below assert Leads/Quotes are explicitly LEFT UNTOUCHED.

type FakeContact = { id: string; firstName: string; lastName: string; companyId: string; ownerId: string | null; primaryPhone: string | null; primaryEmail: string | null };
type FakeLead = { id: string; contactId: string; assignedAgentId: string | null };
type FakeQuote = { id: string; contactId: string; agentId: string | null };
type FakeAccount = { id: string; fullName: string; email: string; companyId: string };

let contacts: Map<string, FakeContact>;
let leadsMap: Map<string, FakeLead>;
let quotes: Map<string, FakeQuote>;
let accounts: Map<string, FakeAccount>;

vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("@/server/email/service", () => ({ sendEmail: vi.fn(async () => ({ ok: true as const, messageId: "m1" })) }));
vi.mock("@/server/email/templates", () => ({ buildReassignmentEmail: vi.fn(() => ({ subject: "s", html: "<p>h</p>" })) }));
vi.mock("@/server/queries/company", () => ({ getCompanyForAccountId: vi.fn(async () => ({ id: "company-1", name: "Test Co" })) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakePrisma: any = {
  contact: {
    findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => contacts.get(id) ?? null),
    findFirst: vi.fn(async ({ where }: { where: { id?: { not: string }; companyId: string; OR: Array<Record<string, unknown>> } }) => {
      for (const c of contacts.values()) {
        if (where.id?.not === c.id) continue;
        if (c.companyId !== where.companyId) continue;
        const matches = where.OR.some((cond) => {
          if ("primaryPhone" in cond) return c.primaryPhone === cond.primaryPhone;
          if ("primaryEmail" in cond) {
            const filter = cond.primaryEmail as { equals?: string; mode?: string };
            return c.primaryEmail != null && c.primaryEmail.toLowerCase() === (filter.equals ?? "").toLowerCase();
          }
          return false;
        });
        if (matches) return c;
      }
      return null;
    }),
    findUniqueOrThrow: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
      const c = contacts.get(id);
      if (!c) throw new Error(`contact ${id} not found`);
      const owner = c.ownerId ? accounts.get(c.ownerId) : null;
      return {
        firstName: c.firstName,
        lastName: c.lastName,
        companyId: c.companyId,
        owner: owner ? { id: owner.id, fullName: owner.fullName, email: owner.email } : null,
      };
    }),
    update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Partial<FakeContact> }) => {
      Object.assign(contacts.get(id)!, data);
    }),
  },
  lead: {
    updateMany: vi.fn(async ({ where, data }: { where: { id: { in: string[] } }; data: Partial<FakeLead> }) => {
      for (const l of leadsMap.values()) if (where.id.in.includes(l.id)) Object.assign(l, data);
    }),
  },
  quote: {
    updateMany: vi.fn(async ({ where, data }: { where: { contactId: string }; data: Partial<FakeQuote> }) => {
      for (const q of quotes.values()) if (q.contactId === where.contactId) Object.assign(q, data);
    }),
  },
  account: {
    findUniqueOrThrow: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
      const a = accounts.get(id);
      if (!a) throw new Error(`account ${id} not found`);
      return { id: a.id, fullName: a.fullName, email: a.email, companyId: a.companyId };
    }),
  },
  activity: { create: vi.fn(async () => ({})) },
  auditLog: { create: vi.fn(async () => ({})) },
  notification: { create: vi.fn(async () => ({})) },
  emailLog: { create: vi.fn(async () => ({})) },
};
fakePrisma.$transaction = vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops));

vi.mock("@/lib/prisma", () => ({ prisma: fakePrisma }));

beforeEach(() => {
  contacts = new Map();
  leadsMap = new Map();
  quotes = new Map();
  accounts = new Map([
    ["agent-a", { id: "agent-a", fullName: "Agent A", email: "a@example.com", companyId: "company-1" }],
    ["agent-b", { id: "agent-b", fullName: "Agent B", email: "b@example.com", companyId: "company-1" }],
  ]);
  vi.clearAllMocks();
});

describe("recheckContactOwnershipMatch", () => {
  it("reassigns the edited contact's OWNERSHIP ONLY to the matched contact's owner — its leads/quotes keep their own current owner (Pass 7: independent ownership)", async () => {
    contacts.set("contact-a", { id: "contact-a", firstName: "Jane", lastName: "Doe", companyId: "company-1", ownerId: "agent-a", primaryPhone: "+14155551234", primaryEmail: "jane@new.com" });
    contacts.set("contact-b", { id: "contact-b", firstName: "Jane", lastName: "Doe", companyId: "company-1", ownerId: "agent-b", primaryPhone: null, primaryEmail: "jane@new.com" });
    leadsMap.set("lead-1", { id: "lead-1", contactId: "contact-a", assignedAgentId: "agent-a" });
    quotes.set("quote-1", { id: "quote-1", contactId: "contact-a", agentId: "agent-a" });

    const { recheckContactOwnershipMatch } = await import("../contact-reassignment");
    await recheckContactOwnershipMatch("contact-a");

    expect(contacts.get("contact-a")!.ownerId).toBe("agent-b");
    // Leads and Quotes are NOT touched by a contact-level reassignment —
    // only the Contact record's own owner moves.
    expect(leadsMap.get("lead-1")!.assignedAgentId).toBe("agent-a");
    expect(quotes.get("quote-1")!.agentId).toBe("agent-a");
  });

  it("email matching is case-insensitive", async () => {
    contacts.set("contact-a", { id: "contact-a", firstName: "Jane", lastName: "Doe", companyId: "company-1", ownerId: "agent-a", primaryPhone: null, primaryEmail: "Jane@New.com" });
    contacts.set("contact-b", { id: "contact-b", firstName: "Jane", lastName: "Doe", companyId: "company-1", ownerId: "agent-b", primaryPhone: null, primaryEmail: "jane@new.com" });

    const { recheckContactOwnershipMatch } = await import("../contact-reassignment");
    await recheckContactOwnershipMatch("contact-a");

    expect(contacts.get("contact-a")!.ownerId).toBe("agent-b");
  });

  it("is a no-op when no other contact matches", async () => {
    contacts.set("contact-a", { id: "contact-a", firstName: "Jane", lastName: "Doe", companyId: "company-1", ownerId: "agent-a", primaryPhone: "+14155551234", primaryEmail: "jane@nobody-else.com" });

    const { recheckContactOwnershipMatch } = await import("../contact-reassignment");
    await recheckContactOwnershipMatch("contact-a");

    expect(contacts.get("contact-a")!.ownerId).toBe("agent-a");
  });

  it("is a no-op when the matched contact has no owner of its own", async () => {
    contacts.set("contact-a", { id: "contact-a", firstName: "Jane", lastName: "Doe", companyId: "company-1", ownerId: "agent-a", primaryPhone: null, primaryEmail: "jane@new.com" });
    contacts.set("contact-b", { id: "contact-b", firstName: "Jane", lastName: "Doe", companyId: "company-1", ownerId: null, primaryPhone: null, primaryEmail: "jane@new.com" });

    const { recheckContactOwnershipMatch } = await import("../contact-reassignment");
    await recheckContactOwnershipMatch("contact-a");

    expect(contacts.get("contact-a")!.ownerId).toBe("agent-a");
  });

  it("is a no-op when the matched contact is already owned by the same agent", async () => {
    contacts.set("contact-a", { id: "contact-a", firstName: "Jane", lastName: "Doe", companyId: "company-1", ownerId: "agent-a", primaryPhone: null, primaryEmail: "jane@new.com" });
    contacts.set("contact-b", { id: "contact-b", firstName: "Jane", lastName: "Doe", companyId: "company-1", ownerId: "agent-a", primaryPhone: null, primaryEmail: "jane@new.com" });

    const { recheckContactOwnershipMatch } = await import("../contact-reassignment");
    await recheckContactOwnershipMatch("contact-a");

    // No transaction/reassignment work should even be attempted.
    expect(fakePrisma.$transaction).not.toHaveBeenCalled();
  });

  it("never matches a contact belonging to a different company", async () => {
    contacts.set("contact-a", { id: "contact-a", firstName: "Jane", lastName: "Doe", companyId: "company-1", ownerId: "agent-a", primaryPhone: null, primaryEmail: "jane@new.com" });
    contacts.set("contact-other-co", { id: "contact-other-co", firstName: "Jane", lastName: "Doe", companyId: "company-2", ownerId: "agent-b", primaryPhone: null, primaryEmail: "jane@new.com" });

    const { recheckContactOwnershipMatch } = await import("../contact-reassignment");
    await recheckContactOwnershipMatch("contact-a");

    expect(contacts.get("contact-a")!.ownerId).toBe("agent-a");
  });

  it("never throws — a failure must not turn a successful phone/email edit into an error", async () => {
    const { recheckContactOwnershipMatch } = await import("../contact-reassignment");
    await expect(recheckContactOwnershipMatch("does-not-exist")).resolves.toBeUndefined();
  });
});
