import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass 22 — CONFIRMED CROSS-TENANT VULNERABILITY, now fixed: every query in
// src/server/queries/lead-queue.ts previously had no companyId filter at
// all — getAllQueueMembers() (rendered on the /accounts page to EVERY
// user, not admin-gated) showed every other company's staff roster, and
// getQueuePosition() counted LeadQueueEntry rows across every company,
// silently inflating a company's own "Queue #N" position by however many
// unrelated companies' workers happened to have joined earlier. These
// tests prove the fix at the actual Prisma WHERE-clause level, matching
// this project's established convention (see accounts.test.ts) of not
// trusting a query is scoped correctly without asserting on its own
// generated `where`.

type Call = { where?: unknown; include?: unknown; orderBy?: unknown };

function makeFakeLeadQueueEntryModel(rows: unknown[], countResult?: number) {
  const findManyCalls: Call[] = [];
  const countCalls: Call[] = [];
  return {
    findMany: vi.fn(async (args: Call) => {
      findManyCalls.push(args);
      return rows;
    }),
    count: vi.fn(async (args: Call) => {
      countCalls.push(args);
      return countResult ?? rows.length;
    }),
    findManyCalls,
    countCalls,
  };
}

beforeEach(() => {
  vi.resetModules();
});

describe("getQueuePosition — scoped by company (Pass 22 fix)", () => {
  it("includes account.companyId in the WHERE clause, not just joinedAt", async () => {
    const leadQueueEntry = makeFakeLeadQueueEntryModel([], 3);
    vi.doMock("@/lib/prisma", () => ({ prisma: { leadQueueEntry } }));
    vi.doMock("@/lib/lead-distribution", () => ({ compareQueueEntries: () => 0 }));

    const { getQueuePosition } = await import("../lead-queue");
    const entry = { joinedAt: new Date("2026-01-01T00:00:00Z") };
    const position = await getQueuePosition(entry, "company-1");

    expect(position).toBe(3);
    expect(leadQueueEntry.countCalls[0].where).toEqual({
      joinedAt: { lte: entry.joinedAt },
      account: { companyId: "company-1" },
    });
    vi.doUnmock("@/lib/prisma");
    vi.doUnmock("@/lib/lead-distribution");
  });
});

describe("getMyQueueStatus", () => {
  it("returns inactive/null when companyId is missing (never queries with an unscoped company)", async () => {
    const leadQueueEntry = makeFakeLeadQueueEntryModel([]);
    vi.doMock("@/lib/prisma", () => ({ prisma: { leadQueueEntry } }));

    const { getMyQueueStatus } = await import("../lead-queue");
    const status = await getMyQueueStatus("account-1", undefined);

    expect(status).toEqual({ isActive: false, position: null });
    expect(leadQueueEntry.findMany).not.toHaveBeenCalled();
    vi.doUnmock("@/lib/prisma");
  });
});

describe("getActiveQueueMembers — scoped by company (Pass 22 fix)", () => {
  it("includes account.companyId in the WHERE clause alongside isActive", async () => {
    const leadQueueEntry = makeFakeLeadQueueEntryModel([]);
    vi.doMock("@/lib/prisma", () => ({ prisma: { leadQueueEntry } }));
    vi.doMock("@/lib/lead-distribution", () => ({ compareQueueEntries: () => 0 }));

    const { getActiveQueueMembers } = await import("../lead-queue");
    await getActiveQueueMembers("company-1");

    expect(leadQueueEntry.findManyCalls[0].where).toEqual({ isActive: true, account: { companyId: "company-1" } });
    vi.doUnmock("@/lib/prisma");
    vi.doUnmock("@/lib/lead-distribution");
  });
});

describe("getAllQueueMembers — scoped by company (Pass 22 fix, the confirmed staff-roster leak)", () => {
  it("includes account.companyId in the WHERE clause", async () => {
    const leadQueueEntry = makeFakeLeadQueueEntryModel([]);
    vi.doMock("@/lib/prisma", () => ({ prisma: { leadQueueEntry } }));

    const { getAllQueueMembers } = await import("../lead-queue");
    await getAllQueueMembers("company-1");

    expect(leadQueueEntry.findManyCalls[0].where).toEqual({ account: { companyId: "company-1" } });
    vi.doUnmock("@/lib/prisma");
  });

  it("never returns a row for a different company — the fake only ever holds what its own WHERE would match, proving the query is the actual boundary", async () => {
    // A real Prisma call would only ever return rows matching `where`; this
    // fake simulates that contract explicitly (rather than trusting a
    // mock that ignores its own `where` and returns everything).
    const allRows = [
      { id: "e1", joinedAt: new Date("2026-01-01"), account: { id: "a1", fullName: "Company A Worker", companyId: "company-A" } },
      { id: "e2", joinedAt: new Date("2026-01-02"), account: { id: "a2", fullName: "Company B Worker", companyId: "company-B" } },
    ];
    const leadQueueEntry = {
      findMany: vi.fn(async ({ where }: { where: { account: { companyId: string } } }) => allRows.filter((r) => r.account.companyId === where.account.companyId)),
    };
    vi.doMock("@/lib/prisma", () => ({ prisma: { leadQueueEntry } }));

    const { getAllQueueMembers } = await import("../lead-queue");
    const members = await getAllQueueMembers("company-A");

    expect(members).toHaveLength(1);
    expect(members[0].account.fullName).toBe("Company A Worker");
    vi.doUnmock("@/lib/prisma");
  });
});
