import { describe, it, expect, vi, beforeEach } from "vitest";

// Hidden accounts (Account.accountsVisible = false) must vanish from every
// "current team" list — the Lead Acceptance roster, queue positions, and the
// agent pickers — while the admin Users roster and the account rows
// themselves are untouched. The fakes below honor the real `where` clauses
// the queries build, so these prove the queries are the actual boundary.

type Row = { id: string; fullName: string; email: string; role: string; status: string; companyId: string; accountsVisible: boolean };

let accountRows: Row[];
// The signed-in account the agent pickers see (they are "use server" exports: each call re-checks who is asking, see reference-data.ts staffListScope).
let actor: { id: string; role: string; companyId: string } | null;
let queueRows: Array<{ id: string; joinedAt: Date; isActive: boolean; account: Row }>;

function matchesAccount(a: Row, where: Record<string, unknown>): boolean {
  if (where.companyId !== undefined && a.companyId !== where.companyId) return false;
  if (where.status !== undefined && a.status !== where.status) return false;
  if (where.accountsVisible !== undefined && a.accountsVisible !== where.accountsVisible) return false;
  const role = where.role as { notIn?: string[]; not?: string } | undefined;
  if (role?.notIn && role.notIn.includes(a.role)) return false;
  if (role?.not && a.role === role.not) return false;
  const or = where.OR as Array<Record<string, unknown>> | undefined;
  if (or) {
    const ok = or.some((c) => (c.accountsVisible !== undefined ? a.accountsVisible === c.accountsVisible : (c.id as { in: string[] }).in.includes(a.id)));
    if (!ok) return false;
  }
  return true;
}

vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => actor) }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    account: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => accountRows.filter((a) => matchesAccount(a, where))),
    },
    leadQueueEntry: {
      findMany: vi.fn(async ({ where }: { where: { isActive?: boolean; account: Record<string, unknown> } }) =>
        queueRows.filter((q) => (where.isActive === undefined || q.isActive === where.isActive) && matchesAccount(q.account, where.account))
      ),
      count: vi.fn(async ({ where }: { where: { joinedAt: { lte: Date }; account: Record<string, unknown> } }) =>
        queueRows.filter((q) => q.joinedAt <= where.joinedAt.lte && matchesAccount(q.account, where.account)).length
      ),
    },
  },
}));

const acct = (id: string, over: Partial<Row> = {}): Row => ({ id, fullName: id.toUpperCase(), email: `${id}@x.com`, role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "co-1", accountsVisible: true, ...over });

beforeEach(() => {
  const a = acct("a");
  const hidden = acct("hidden", { accountsVisible: false });
  const b = acct("b");
  const inactive = acct("gone", { status: "INACTIVE" });
  accountRows = [a, hidden, b, inactive];
  actor = { id: "admin-1", role: "ADMIN", companyId: "co-1" };
  queueRows = [
    { id: "q1", joinedAt: new Date("2026-01-01"), isActive: true, account: a },
    { id: "q2", joinedAt: new Date("2026-01-02"), isActive: true, account: hidden },
    { id: "q3", joinedAt: new Date("2026-01-03"), isActive: false, account: b }, // paused — still visible
  ];
  vi.clearAllMocks();
});

describe("Lead Acceptance roster", () => {
  it("excludes a hidden account but still lists visible paused members", async () => {
    const { getAllQueueMembers } = await import("../lead-queue");
    const members = await getAllQueueMembers("co-1");
    expect(members.map((m) => m.account.id)).toEqual(["a", "b"]);
    expect(members.find((m) => m.account.id === "b")?.isActive).toBe(false); // paused ≠ hidden
  });

  it("numbers visible members 1..n so the roster and each member's own position agree", async () => {
    const { getAllQueueMembers, getQueuePosition } = await import("../lead-queue");
    const members = await getAllQueueMembers("co-1");
    for (const m of members) {
      expect(await getQueuePosition(m, "co-1")).toBe(m.position);
    }
    expect(members.map((m) => m.position)).toEqual([1, 2]);
  });

  it("the up-next list excludes hidden accounts too", async () => {
    vi.doMock("@/lib/lead-distribution", () => ({ compareQueueEntries: () => 0 }));
    const { getActiveQueueMembers } = await import("../lead-queue");
    expect((await getActiveQueueMembers("co-1")).map((m) => m.account.id)).toEqual(["a"]);
    vi.doUnmock("@/lib/lead-distribution");
  });
});

describe("agent pickers (assignment dropdowns)", () => {
  it("lead-eligible list omits hidden and inactive accounts", async () => {
    const { listLeadEligibleAgents } = await import("../reference-data");
    expect((await listLeadEligibleAgents("co-1")).map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("task-eligible list omits hidden and inactive accounts", async () => {
    const { listTaskEligibleAgents } = await import("../reference-data");
    expect((await listTaskEligibleAgents("co-1")).map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("includeIds keeps the CURRENT assignee (even if hidden) so their value still displays", async () => {
    const { listLeadEligibleAgents } = await import("../reference-data");
    expect((await listLeadEligibleAgents("co-1", { includeIds: ["hidden"] })).map((x) => x.id)).toEqual(["a", "hidden", "b"]);
  });

  it("includeHidden (audit views such as Commissions) lists hidden accounts without ever resurrecting inactive ones", async () => {
    const { listLeadEligibleAgents } = await import("../reference-data");
    expect((await listLeadEligibleAgents("co-1", { includeHidden: true })).map((x) => x.id)).toEqual(["a", "hidden", "b"]);
  });
});

describe("the agent pickers are callable endpoints: they answer only a signed-in caller about their OWN company", () => {
  it("no signed-in account: an empty list, and the database is not read at all", async () => {
    actor = null;
    const { prisma } = await import("@/lib/prisma");
    const { listLeadEligibleAgents, listTaskEligibleAgents } = await import("../reference-data");
    expect(await listLeadEligibleAgents("co-1")).toEqual([]);
    expect(await listTaskEligibleAgents("co-1")).toEqual([]);
    expect(prisma.account.findMany).not.toHaveBeenCalled();
  });

  it("another company's id (the classic cross-tenant read) is refused with an empty list and no query - names and emails of company B never reach a user of company A", async () => {
    accountRows.push(acct("other-staff", { companyId: "co-2" }));
    actor = { id: "a", role: "TRAVEL_AGENT", companyId: "co-1" };
    const { prisma } = await import("@/lib/prisma");
    const { listLeadEligibleAgents, listTaskEligibleAgents } = await import("../reference-data");
    expect(await listLeadEligibleAgents("co-2")).toEqual([]);
    expect(await listTaskEligibleAgents("co-2", { includeHidden: true })).toEqual([]);
    expect(prisma.account.findMany).not.toHaveBeenCalled();
    expect((await listLeadEligibleAgents("co-1")).map((x) => x.id)).not.toContain("other-staff");
  });

  it("a malformed company id (not a string) is refused rather than reaching the query", async () => {
    const { listLeadEligibleAgents } = await import("../reference-data");
    expect(await listLeadEligibleAgents(undefined as never)).toEqual([]);
    expect(await listLeadEligibleAgents({ not: "x" } as never)).toEqual([]);
  });

  it("hidden accounts are returned only to an Administrator: includeHidden is ignored for everyone else", async () => {
    const { listLeadEligibleAgents } = await import("../reference-data");
    for (const role of ["MANAGER", "TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"]) {
      actor = { id: "x", role, companyId: "co-1" };
      expect((await listLeadEligibleAgents("co-1", { includeHidden: true })).map((x) => x.id), role).toEqual(["a", "b"]);
    }
    actor = { id: "admin-1", role: "ADMIN", companyId: "co-1" };
    expect((await listLeadEligibleAgents("co-1", { includeHidden: true })).map((x) => x.id)).toEqual(["a", "hidden", "b"]);
  });

  it("what is returned never carries more than the pickers need (no password-like or session fields exist to leak): id, name, role (and email for the lead picker)", async () => {
    const { listLeadEligibleAgents, listTaskEligibleAgents } = await import("../reference-data");
    const { prisma } = await import("@/lib/prisma");
    await listLeadEligibleAgents("co-1");
    await listTaskEligibleAgents("co-1");
    const selects = (prisma.account.findMany as unknown as { mock: { calls: Array<[{ select: Record<string, boolean> }]> } }).mock.calls.map((c) => Object.keys(c[0].select).sort());
    expect(selects).toEqual([["email", "fullName", "id", "role"], ["fullName", "id", "role"]]);
  });
});

describe("admin Users roster", () => {
  it("still lists EVERY account in the company, hidden ones included, so Admin can unhide them", async () => {
    const { getAllAccounts } = await import("../accounts");
    // getAllAccounts filters by companyId only (asserted in accounts.test.ts)
    expect((await getAllAccounts("co-1")).map((x) => x.id)).toEqual(["a", "hidden", "b", "gone"]);
  });

  it("the Accounts directory excludes hidden accounts", async () => {
    const { getAccountsDirectory } = await import("../accounts");
    expect((await getAccountsDirectory("co-1")).map((x) => x.id)).toEqual(["a", "b", "gone"]);
  });
});
