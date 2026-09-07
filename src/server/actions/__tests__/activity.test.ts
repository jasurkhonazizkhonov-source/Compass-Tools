import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass 6 (§32.C) — loadMoreActivities is the "Load more" companion to
// getLeadDetail/getContactDetail's own bounded (take: 30) activities
// include. The two things under test: (1) it re-verifies visibility itself
// (every "use server" export is a callable RPC any client can invoke
// directly — the same IDOR standard as every other action in this app), and
// (2) its cursor pagination actually walks forward through older history
// without skipping or repeating rows.

type FakeAccount = { id: string; role: string; companyId: string };
type FakeLead = { id: string; assignedAgentId: string | null; companyId: string };
type FakeContact = { id: string; ownerId: string | null; companyId: string };
type FakeActivity = { id: string; leadId?: string; contactId?: string; createdAt: Date; description: string };

let currentActor: FakeAccount | null;
let leads: Map<string, FakeLead>;
let contacts: Map<string, FakeContact>;
let activities: FakeActivity[];

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => currentActor),
}));

function canViewAllRecords(role: string) {
  return role === "ADMIN" || role === "MANAGER" || role === "TICKETING_AGENT";
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lead: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const lead = leads.get(where.id);
        if (!lead || !currentActor) return null;
        const visible = canViewAllRecords(currentActor.role) ? lead.companyId === currentActor.companyId : lead.assignedAgentId === currentActor.id;
        return visible ? { id: lead.id } : null;
      }),
    },
    contact: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const contact = contacts.get(where.id);
        if (!contact || !currentActor) return null;
        const visible = canViewAllRecords(currentActor.role) ? contact.companyId === currentActor.companyId : contact.ownerId === currentActor.id;
        return visible ? { id: contact.id } : null;
      }),
    },
    activity: {
      findMany: vi.fn(async ({ where, cursor, skip, take }: { where: { leadId?: string; contactId?: string }; cursor: { id: string }; skip: number; take: number }) => {
        const scoped = activities
          .filter((a) => (where.leadId ? a.leadId === where.leadId : a.contactId === where.contactId))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const cursorIndex = scoped.findIndex((a) => a.id === cursor.id);
        const start = cursorIndex === -1 ? 0 : cursorIndex + skip;
        return scoped.slice(start, start + take).map((a) => ({ ...a, actor: null }));
      }),
    },
  },
}));

beforeEach(() => {
  currentActor = { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-1" };
  leads = new Map([["lead-1", { id: "lead-1", assignedAgentId: "agent-1", companyId: "company-1" }]]);
  contacts = new Map([["contact-1", { id: "contact-1", ownerId: "agent-1", companyId: "company-1" }]]);
  // 45 activities newest-first: id-45 is newest, id-1 is oldest.
  activities = Array.from({ length: 45 }, (_, i) => ({
    id: `activity-${i + 1}`,
    leadId: "lead-1",
    createdAt: new Date(2026, 0, 1, 0, 0, i),
    description: `Event ${i + 1}`,
  }));
  vi.clearAllMocks();
});

describe("loadMoreActivities — visibility (security)", () => {
  it("rejects a lead the actor cannot see (IDOR)", async () => {
    currentActor = { id: "someone-else", role: "TRAVEL_AGENT", companyId: "company-1" };
    const { loadMoreActivities } = await import("../activity");
    await expect(loadMoreActivities({ leadId: "lead-1", cursor: "activity-45" })).rejects.toThrow("Lead not found");
  });

  it("rejects a contact the actor cannot see (IDOR)", async () => {
    currentActor = { id: "someone-else", role: "TRAVEL_AGENT", companyId: "company-1" };
    const { loadMoreActivities } = await import("../activity");
    await expect(loadMoreActivities({ contactId: "contact-1", cursor: "activity-45" })).rejects.toThrow("Contact not found");
  });

  it("rejects when neither leadId nor contactId is supplied", async () => {
    const { loadMoreActivities } = await import("../activity");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(loadMoreActivities({ cursor: "activity-45" } as any)).rejects.toThrow(/leadId or contactId/);
  });

  it("an ADMIN can load activity for any lead within the company", async () => {
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1" };
    const { loadMoreActivities } = await import("../activity");
    const result = await loadMoreActivities({ leadId: "lead-1", cursor: "activity-45" });
    expect(result.activities.length).toBeGreaterThan(0);
  });
});

describe("loadMoreActivities — cursor pagination", () => {
  it("returns the next 30 rows strictly older than the cursor, never re-including the cursor row itself", async () => {
    const { loadMoreActivities } = await import("../activity");
    const result = await loadMoreActivities({ leadId: "lead-1", cursor: "activity-45" });
    expect(result.activities).toHaveLength(30);
    expect(result.activities[0].id).toBe("activity-44");
    expect(result.activities.some((a) => a.id === "activity-45")).toBe(false);
    expect(result.hasMore).toBe(true);
  });

  it("a second page picks up exactly where the first left off, with no gap or duplicate", async () => {
    const { loadMoreActivities } = await import("../activity");
    const page1 = await loadMoreActivities({ leadId: "lead-1", cursor: "activity-45" });
    const lastOfPage1 = page1.activities[page1.activities.length - 1].id;
    const page2 = await loadMoreActivities({ leadId: "lead-1", cursor: lastOfPage1 });
    expect(page2.activities).toHaveLength(14); // 44 remaining after page 1's 30
    expect(page2.hasMore).toBe(false);
    const allIds = [...page1.activities, ...page2.activities].map((a) => a.id);
    expect(new Set(allIds).size).toBe(allIds.length); // no duplicates
  });

  it("hasMore is false when the returned page is smaller than the page size", async () => {
    activities = activities.slice(0, 20); // only 19 remaining after the cursor row itself
    const { loadMoreActivities } = await import("../activity");
    const result = await loadMoreActivities({ leadId: "lead-1", cursor: "activity-20" });
    expect(result.activities).toHaveLength(19);
    expect(result.hasMore).toBe(false);
  });

  it("scopes strictly to the requested lead — never leaks another lead's/contact's activity", async () => {
    activities.push({ id: "other-lead-activity", leadId: "lead-2", createdAt: new Date(2026, 0, 2), description: "Not this lead" });
    const { loadMoreActivities } = await import("../activity");
    const result = await loadMoreActivities({ leadId: "lead-1", cursor: "activity-45" });
    expect(result.activities.some((a) => a.id === "other-lead-activity")).toBe(false);
  });
});
