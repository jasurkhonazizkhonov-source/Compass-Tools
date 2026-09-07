import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass 11 Part 1 — proves the Accounts-directory exclusion is enforced at
// the actual Prisma WHERE clause (server/query level), never via
// client-side/CSS filtering, and that the separate admin /users query
// (getAllAccounts) deliberately stays unfiltered so Admin user-management
// never loses sight of a hidden account.

type Call = { where: unknown };

function makeFakeAccountModel(rows: unknown[]) {
  const findManyCalls: Call[] = [];
  return {
    findMany: vi.fn(async (args: Call) => {
      findManyCalls.push(args);
      return rows;
    }),
    findManyCalls,
  };
}

beforeEach(() => {
  vi.resetModules();
});

describe("getAccountsDirectory — the general /accounts page query", () => {
  it("excludes hidden accounts via the WHERE clause itself (accountsVisible: true)", async () => {
    const account = makeFakeAccountModel([{ id: "a1", accountsVisible: true }]);
    vi.doMock("@/lib/prisma", () => ({ prisma: { account } }));

    const { getAccountsDirectory } = await import("../accounts");
    await getAccountsDirectory("company-1");

    expect(account.findManyCalls[0].where).toEqual({ companyId: "company-1", accountsVisible: true });
    vi.doUnmock("@/lib/prisma");
  });

  it("is scoped to the caller's own company (company isolation)", async () => {
    const account = makeFakeAccountModel([]);
    vi.doMock("@/lib/prisma", () => ({ prisma: { account } }));

    const { getAccountsDirectory } = await import("../accounts");
    await getAccountsDirectory("company-9");

    const where = account.findManyCalls[0].where as { companyId: string };
    expect(where.companyId).toBe("company-9");
    vi.doUnmock("@/lib/prisma");
  });

  it("a visible account is returned by the query's own filter (sanity check on the WHERE, not a live DB)", async () => {
    const account = makeFakeAccountModel([{ id: "visible-1", accountsVisible: true }]);
    vi.doMock("@/lib/prisma", () => ({ prisma: { account } }));

    const { getAccountsDirectory } = await import("../accounts");
    const result = await getAccountsDirectory("company-1");

    expect(result).toEqual([{ id: "visible-1", accountsVisible: true }]);
    vi.doUnmock("@/lib/prisma");
  });
});

describe("getAllAccounts — the admin-only /users management query", () => {
  it("does NOT filter by accountsVisible — a hidden account is still included in the WHERE-clause scope", async () => {
    const account = makeFakeAccountModel([
      { id: "visible-1", accountsVisible: true },
      { id: "hidden-1", accountsVisible: false },
    ]);
    vi.doMock("@/lib/prisma", () => ({ prisma: { account } }));

    const { getAllAccounts } = await import("../accounts");
    await getAllAccounts("company-1");

    expect(account.findManyCalls[0].where).toEqual({ companyId: "company-1" });
    vi.doUnmock("@/lib/prisma");
  });

  it("returns a hidden account's row with its data fully intact — hiding never strips or nulls out any other field", async () => {
    const hiddenRow = {
      id: "hidden-1",
      accountsVisible: false,
      status: "ACTIVE",
      role: "TRAVEL_AGENT",
      lastSeenAt: new Date("2026-09-02T12:00:00Z"),
    };
    const account = makeFakeAccountModel([hiddenRow]);
    vi.doMock("@/lib/prisma", () => ({ prisma: { account } }));

    const { getAllAccounts } = await import("../accounts");
    const result = await getAllAccounts("company-1");

    // Still ACTIVE, still has its real lastSeenAt — a hidden-from-Accounts
    // user remains a normal, fully-functioning account everywhere else,
    // including the Admin's own view of it.
    expect(result[0]).toEqual(hiddenRow);
    vi.doUnmock("@/lib/prisma");
  });
});
