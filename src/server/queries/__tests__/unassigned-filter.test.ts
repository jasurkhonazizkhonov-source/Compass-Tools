import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass 10 §2/§3/§15/§16/§29 — the "Unassigned" filter for Leads/Contacts.
// Uses the REAL leadVisibilityWhere/contactVisibilityWhere (not mocked) so
// these tests prove the actual security property the task asks for: a
// restricted viewer cannot use `agentId=unassigned` to see anything beyond
// their own scope, because the filter is ANDed into that scope, never
// substituted for it.

type Call = { where: unknown; skip?: number; take?: number };

function makeFakeModel(rows: unknown[], total: number) {
  const findManyCalls: Call[] = [];
  const countCalls: Array<{ where: unknown }> = [];
  return {
    findMany: vi.fn(async (args: Call) => {
      findManyCalls.push(args);
      return rows;
    }),
    count: vi.fn(async (args: { where: unknown }) => {
      countCalls.push(args);
      return total;
    }),
    findManyCalls,
    countCalls,
  };
}

beforeEach(() => {
  vi.resetModules();
});

describe("getLeads — Unassigned filter (agentId='unassigned')", () => {
  it("translates to assignedAgentId: null in the actual WHERE clause sent to Prisma", async () => {
    const lead = makeFakeModel([{ id: "l1" }], 3);
    vi.doMock("@/lib/prisma", () => ({ prisma: { lead } }));

    const { getLeads } = await import("../leads");
    const admin = { id: "admin-1", role: "ADMIN" as const, companyId: "company-1" };
    await getLeads({ agentId: "unassigned", viewer: admin });

    // The AND array's second entry is the agent-filter fragment (see
    // getLeads' own where-building order) — assert it's present somewhere
    // in the AND list rather than hardcoding array position, so this stays
    // robust to unrelated filter reordering.
    const where = lead.findManyCalls[0].where as { AND: unknown[] };
    expect(where.AND).toContainEqual({ assignedAgentId: null });
    vi.doUnmock("@/lib/prisma");
  });

  it("count() uses the exact same where as findMany() (no count/filter mismatch)", async () => {
    const lead = makeFakeModel([], 0);
    vi.doMock("@/lib/prisma", () => ({ prisma: { lead } }));

    const { getLeads } = await import("../leads");
    await getLeads({ agentId: "unassigned", viewer: { id: "admin-1", role: "ADMIN" as const, companyId: "company-1" } });

    expect(lead.countCalls[0].where).toEqual(lead.findManyCalls[0].where);
    vi.doUnmock("@/lib/prisma");
  });

  it("is database-paginated (skip/take present, never fetch-all) and capped at 25", async () => {
    const lead = makeFakeModel([], 60);
    vi.doMock("@/lib/prisma", () => ({ prisma: { lead } }));

    const { getLeads } = await import("../leads");
    const result = await getLeads({ agentId: "unassigned", page: 2, viewer: { id: "admin-1", role: "ADMIN" as const, companyId: "company-1" } });

    expect(lead.findManyCalls[0].skip).toBe(25);
    expect(lead.findManyCalls[0].take).toBe(25);
    expect(result.pageCount).toBe(3); // ceil(60/25)
    vi.doUnmock("@/lib/prisma");
  });

  it("company-wide viewer (ADMIN/MANAGER) can see unassigned leads company-wide — visibility already permits it, no change needed", async () => {
    const lead = makeFakeModel([], 0);
    vi.doMock("@/lib/prisma", () => ({ prisma: { lead } }));

    const { getLeads } = await import("../leads");
    await getLeads({ agentId: "unassigned", viewer: { id: "manager-1", role: "MANAGER" as const, companyId: "company-1" } });

    const where = lead.findManyCalls[0].where as { contact: { companyId: string } };
    expect(where.contact).toEqual({ companyId: "company-1" }); // full company scope, unaffected by the agent filter
    vi.doUnmock("@/lib/prisma");
  });

  it("SECURITY (§29): a restricted viewer's own scope combined with agentId=unassigned is unsatisfiable — never widens past their own leads", async () => {
    const lead = makeFakeModel([], 0);
    vi.doMock("@/lib/prisma", () => ({ prisma: { lead } }));

    const { getLeads } = await import("../leads");
    await getLeads({ agentId: "unassigned", viewer: { id: "agent-x", role: "TRAVEL_AGENT" as const, companyId: "company-1" } });

    const where = lead.findManyCalls[0].where as { assignedAgentId: string; AND: unknown[] };
    // leadVisibilityWhere's own restricted branch: {assignedAgentId: viewer.id}
    expect(where.assignedAgentId).toBe("agent-x");
    // ANDed with the agent filter's {assignedAgentId: null} — the two can
    // never both be true at once (a lead's assignedAgentId can't be both
    // "agent-x" and null), so this structurally returns nothing, not
    // someone else's/unassigned leads.
    expect(where.AND).toContainEqual({ assignedAgentId: null });
    vi.doUnmock("@/lib/prisma");
  });

  it("combines with other filters (status) correctly — Owner=Unassigned + Status=NEW", async () => {
    const lead = makeFakeModel([], 0);
    vi.doMock("@/lib/prisma", () => ({ prisma: { lead } }));

    const { getLeads } = await import("../leads");
    await getLeads({ agentId: "unassigned", status: ["NEW"] as never, viewer: { id: "admin-1", role: "ADMIN" as const, companyId: "company-1" } });

    const where = lead.findManyCalls[0].where as { AND: unknown[] };
    expect(where.AND).toContainEqual({ assignedAgentId: null });
    expect(where.AND).toContainEqual({ status: { in: ["NEW"] } });
    vi.doUnmock("@/lib/prisma");
  });

  it("a specific agentId (not the 'unassigned' sentinel) still filters by that exact agent, unaffected by this change", async () => {
    const lead = makeFakeModel([], 0);
    vi.doMock("@/lib/prisma", () => ({ prisma: { lead } }));

    const { getLeads } = await import("../leads");
    await getLeads({ agentId: "agent-real-id", viewer: { id: "admin-1", role: "ADMIN" as const, companyId: "company-1" } });

    const where = lead.findManyCalls[0].where as { AND: unknown[] };
    expect(where.AND).toContainEqual({ assignedAgentId: "agent-real-id" });
    vi.doUnmock("@/lib/prisma");
  });

  it("'All Agents' (no agentId at all) is unaffected — no ownership filter applied", async () => {
    const lead = makeFakeModel([], 0);
    vi.doMock("@/lib/prisma", () => ({ prisma: { lead } }));

    const { getLeads } = await import("../leads");
    await getLeads({ viewer: { id: "admin-1", role: "ADMIN" as const, companyId: "company-1" } });

    const where = lead.findManyCalls[0].where as { AND: unknown[] };
    expect(where.AND).toContainEqual({});
    vi.doUnmock("@/lib/prisma");
  });
});

describe("getContacts — Unassigned filter (agentId='unassigned')", () => {
  it("translates to ownerId: null in the actual WHERE clause sent to Prisma", async () => {
    const contact = makeFakeModel([{ id: "c1" }], 1);
    vi.doMock("@/lib/prisma", () => ({ prisma: { contact } }));

    const { getContacts } = await import("../contacts");
    await getContacts({ agentId: "unassigned", viewer: { id: "admin-1", role: "ADMIN" as const, companyId: "company-1" } });

    const where = contact.findManyCalls[0].where as { AND: unknown[] };
    expect(where.AND).toContainEqual({ ownerId: null });
    vi.doUnmock("@/lib/prisma");
  });

  it("count() uses the exact same where as findMany()", async () => {
    const contact = makeFakeModel([], 0);
    vi.doMock("@/lib/prisma", () => ({ prisma: { contact } }));

    const { getContacts } = await import("../contacts");
    await getContacts({ agentId: "unassigned", viewer: { id: "admin-1", role: "ADMIN" as const, companyId: "company-1" } });

    expect(contact.countCalls[0].where).toEqual(contact.findManyCalls[0].where);
    vi.doUnmock("@/lib/prisma");
  });

  it("is database-paginated and capped at 25", async () => {
    const contact = makeFakeModel([], 51);
    vi.doMock("@/lib/prisma", () => ({ prisma: { contact } }));

    const { getContacts } = await import("../contacts");
    const result = await getContacts({ agentId: "unassigned", page: 3, viewer: { id: "admin-1", role: "ADMIN" as const, companyId: "company-1" } });

    expect(contact.findManyCalls[0].skip).toBe(50);
    expect(contact.findManyCalls[0].take).toBe(25);
    expect(result.pageCount).toBe(3); // ceil(51/25)
    vi.doUnmock("@/lib/prisma");
  });

  it("SECURITY (§29): a restricted viewer's own scope combined with agentId=unassigned is unsatisfiable — company isolation and per-agent scope both hold", async () => {
    const contact = makeFakeModel([], 0);
    vi.doMock("@/lib/prisma", () => ({ prisma: { contact } }));

    const { getContacts } = await import("../contacts");
    await getContacts({ agentId: "unassigned", viewer: { id: "agent-x", role: "TRAVEL_AGENT" as const, companyId: "company-1" } });

    const where = contact.findManyCalls[0].where as { ownerId: string; AND: unknown[] };
    expect(where.ownerId).toBe("agent-x");
    expect(where.AND).toContainEqual({ ownerId: null });
    vi.doUnmock("@/lib/prisma");
  });

  it("combines with search — Search='John' + Owner=Unassigned", async () => {
    const contact = makeFakeModel([], 0);
    vi.doMock("@/lib/prisma", () => ({ prisma: { contact } }));

    const { getContacts } = await import("../contacts");
    await getContacts({ agentId: "unassigned", q: "John", viewer: { id: "admin-1", role: "ADMIN" as const, companyId: "company-1" } });

    const where = contact.findManyCalls[0].where as { AND: unknown[] };
    expect(where.AND).toContainEqual({ ownerId: null });
    const searchClause = where.AND.find((c) => typeof c === "object" && c !== null && "OR" in (c as object));
    expect(searchClause).toBeDefined();
    vi.doUnmock("@/lib/prisma");
  });

  it("§23 — an unassigned Contact WITH assigned Leads still returns the row (the query's WHERE never touches lead ownership at all)", async () => {
    // A row where ownerId is genuinely null, even though it carries leads
    // owned by other agents — exactly what a real Prisma row for this
    // scenario looks like (leads included but irrelevant to this WHERE).
    const contact = makeFakeModel(
      [{ id: "contact-1", ownerId: null, leads: [{ id: "lead-1", assignedAgentId: "agent-b" }, { id: "lead-2", assignedAgentId: "agent-c" }] }],
      1
    );
    vi.doMock("@/lib/prisma", () => ({ prisma: { contact } }));

    const { getContacts } = await import("../contacts");
    const result = await getContacts({ agentId: "unassigned", viewer: { id: "admin-1", role: "ADMIN" as const, companyId: "company-1" } });

    expect(result.contacts).toHaveLength(1);
    expect(result.total).toBe(1);
    // Confirms the WHERE clause itself has no lead-related condition —
    // the Contact appearing here is governed purely by its own ownerId.
    const where = contact.findManyCalls[0].where as { AND: unknown[] };
    expect(JSON.stringify(where)).not.toMatch(/leads|assignedAgentId/);
    vi.doUnmock("@/lib/prisma");
  });
});
