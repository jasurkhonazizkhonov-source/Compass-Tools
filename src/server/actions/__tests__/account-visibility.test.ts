import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass 11 Part 1 — Admin-only "Visible in Accounts" toggle
// (setAccountsVisibility). These tests prove the actual security and
// side-effect properties the task requires: only an Admin may change it,
// company isolation holds, and the mutation touches ONLY the
// accountsVisible column — never status, role, lead/contact ownership,
// sessions, or lead-queue membership.

type FakeAccount = { id: string; role: string; companyId: string; accountsVisible: boolean };

let accounts: Map<string, FakeAccount>;
let currentActor: FakeAccount | null;
let updateCalls: Array<{ where: { id: string }; data: Record<string, unknown> }>;
let revalidated: string[];

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => currentActor),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn((path: string) => {
    revalidated.push(path);
  }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    account: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = accounts.get(where.id);
        return row ? { companyId: row.companyId } : null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updateCalls.push({ where, data });
        const row = accounts.get(where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
  },
}));

beforeEach(() => {
  accounts = new Map([
    ["agent-1", { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-1", accountsVisible: true }],
    ["other-company-user", { id: "other-company-user", role: "TRAVEL_AGENT", companyId: "company-2", accountsVisible: true }],
  ]);
  currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1", accountsVisible: true };
  updateCalls = [];
  revalidated = [];
  vi.resetModules();
});

describe("setAccountsVisibility", () => {
  it("Admin can hide an account (accountsVisible: false)", async () => {
    const { setAccountsVisibility } = await import("../accounts");
    await setAccountsVisibility("agent-1", false);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].where).toEqual({ id: "agent-1" });
    expect(updateCalls[0].data).toEqual({ accountsVisible: false });
    expect(accounts.get("agent-1")!.accountsVisible).toBe(false);
  });

  it("Admin can unhide an account (accountsVisible: true)", async () => {
    accounts.get("agent-1")!.accountsVisible = false;
    const { setAccountsVisibility } = await import("../accounts");
    await setAccountsVisibility("agent-1", true);

    expect(updateCalls[0].data).toEqual({ accountsVisible: true });
    expect(accounts.get("agent-1")!.accountsVisible).toBe(true);
  });

  it("the mutation touches ONLY accountsVisible — never status, role, or any other field", async () => {
    const { setAccountsVisibility } = await import("../accounts");
    await setAccountsVisibility("agent-1", false);

    expect(Object.keys(updateCalls[0].data)).toEqual(["accountsVisible"]);
  });

  it("revalidates both /accounts and /users (both pages read this field)", async () => {
    const { setAccountsVisibility } = await import("../accounts");
    await setAccountsVisibility("agent-1", false);

    expect(revalidated).toContain("/accounts");
    expect(revalidated).toContain("/users");
  });

  it.each(["MANAGER", "TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"])(
    "a non-Admin (%s) cannot change the setting — rejected before any update",
    async (role) => {
      currentActor = { id: "non-admin-1", role, companyId: "company-1", accountsVisible: true };
      const { setAccountsVisibility } = await import("../accounts");

      await expect(setAccountsVisibility("agent-1", false)).rejects.toThrow(/Only Admins/);
      expect(updateCalls).toHaveLength(0);
    }
  );

  it("an unauthenticated caller (no session) cannot change the setting", async () => {
    currentActor = null;
    const { setAccountsVisibility } = await import("../accounts");

    await expect(setAccountsVisibility("agent-1", false)).rejects.toThrow(/Only Admins/);
    expect(updateCalls).toHaveLength(0);
  });

  it("SECURITY — company isolation: an Admin cannot hide/unhide another company's account, and the error does not leak whether the id exists", async () => {
    const { setAccountsVisibility } = await import("../accounts");

    await expect(setAccountsVisibility("other-company-user", false)).rejects.toThrow("Account not found");
    await expect(setAccountsVisibility("no-such-account-id", false)).rejects.toThrow("Account not found");
    expect(updateCalls).toHaveLength(0);
    // Same message for "exists in another company" and "doesn't exist at all" — non-distinguishing, matching assertSameCompany's existing pattern.
  });
});
