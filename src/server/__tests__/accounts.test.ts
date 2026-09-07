import { describe, it, expect, vi, beforeEach } from "vitest";

// Follows the same in-memory-fake mocking convention as quote-status.test.ts
// — no real database, no real getCurrentAccount(). The current actor's role
// is swappable per test via currentActor, unlike quote-status.test.ts which
// only ever needed a single fixed ADMIN actor.

type FakeAccount = {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  role: string;
  status: string;
  hiredAt: Date | null;
};

let accounts: Map<string, FakeAccount>;
let currentActor: { id: string; role: string } | null;

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => currentActor),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const account = {
    create: vi.fn(async ({ data }: { data: Partial<FakeAccount> }) => {
      const account: FakeAccount = {
        id: `acct-${accounts.size + 1}`,
        fullName: data.fullName!,
        email: data.email!,
        phone: data.phone ?? null,
        role: data.role!,
        status: data.status ?? "ACTIVE",
        hiredAt: null,
      };
      accounts.set(account.id, account);
      return account;
    }),
    update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Partial<FakeAccount> }) => {
      const account = accounts.get(id)!;
      Object.assign(account, data);
      return account;
    }),
    findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
      const account = accounts.get(id);
      // Every fake account shares the same (undefined) companyId, so
      // assertSameCompany's equality check always passes here — company
      // isolation itself is covered by the dedicated company-isolation
      // tests, not this file's last-admin/permission suite.
      return account ? { ...account } : null;
    }),
    findUniqueOrThrow: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
      const account = accounts.get(id);
      if (!account) throw new Error(`account ${id} not found`);
      return { ...account };
    }),
    count: vi.fn(async ({ where }: { where: { role?: string; status?: string; id?: { not: string } } }) => {
      return [...accounts.values()].filter((a) => {
        if (where.role && a.role !== where.role) return false;
        if (where.status && a.status !== where.status) return false;
        if (where.id?.not && a.id === where.id.not) return false;
        return true;
      }).length;
    }),
  };
  // Not modeling queue membership itself in this file's fixtures — only
  // proving setAccountStatus's call reaches this mock without throwing.
  // The actual pause/resume/deactivation queue behavior has its own
  // dedicated fixtures in lead-queue.test.ts.
  const leadQueueEntry = {
    updateMany: vi.fn(async () => ({ count: 0 })),
  };
  const mockPrisma = {
    account,
    leadQueueEntry,
    // The real prisma.$transaction hands the callback a tx client with the
    // same query API — the fake mirrors that by handing back this same
    // mock object, since it already operates on the single shared in-memory
    // `accounts` Map. The isolation-level option is a no-op here.
    $transaction: vi.fn(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma)),
  };
  return { prisma: mockPrisma };
});

function seed(...rows: FakeAccount[]) {
  accounts = new Map(rows.map((r) => [r.id, r]));
}

beforeEach(() => {
  accounts = new Map();
  currentActor = { id: "admin-1", role: "ADMIN" };
  vi.clearAllMocks();
});

describe("createAccount — permission + validation", () => {
  it("rejects a non-admin caller", async () => {
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT" };
    const { createAccount } = await import("../actions/accounts");
    await expect(createAccount({ fullName: "New Guy", email: "new@x.com", role: "TRAVEL_AGENT" })).rejects.toThrow(/Only Admins/);
  });

  it("rejects an arbitrary/invalid role string even from an admin caller", async () => {
    const { createAccount } = await import("../actions/accounts");
    // @ts-expect-error deliberately passing an invalid role to prove the zod schema rejects it at runtime
    await expect(createAccount({ fullName: "New Guy", email: "new@x.com", role: "SUPER_ADMIN" })).rejects.toThrow();
  });

  it("allows an admin to create a user with a valid role", async () => {
    const { createAccount } = await import("../actions/accounts");
    // createAccount deliberately returns nothing — a raw Account row would
    // carry Decimal fields across the Server Action -> Client Component
    // boundary — so assert against the underlying fake DB state instead.
    await createAccount({ fullName: "New Guy", email: "new@x.com", role: "TRAVEL_AGENT" });
    const account = [...accounts.values()].find((a) => a.email === "new@x.com")!;
    expect(account.role).toBe("TRAVEL_AGENT");
    expect(account.status).toBe("ACTIVE");
  });

  it("respects an explicit disabled initial status", async () => {
    const { createAccount } = await import("../actions/accounts");
    await createAccount({ fullName: "New Guy", email: "new@x.com", role: "TRAVEL_AGENT", status: "INACTIVE" });
    const account = [...accounts.values()].find((a) => a.email === "new@x.com")!;
    expect(account.status).toBe("INACTIVE");
  });
});

describe("updateAccount — permission + validation + last-admin protection", () => {
  it("rejects a non-admin caller", async () => {
    seed({ id: "agent-1", fullName: "Agent", email: "a@x.com", phone: null, role: "TRAVEL_AGENT", status: "ACTIVE", hiredAt: null });
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT" };
    const { updateAccount } = await import("../actions/accounts");
    await expect(updateAccount("agent-1", { fullName: "Hacked Name" })).rejects.toThrow(/Only Admins/);
  });

  it("rejects an arbitrary/invalid role string at runtime, not just via TypeScript", async () => {
    seed({ id: "agent-1", fullName: "Agent", email: "a@x.com", phone: null, role: "TRAVEL_AGENT", status: "ACTIVE", hiredAt: null });
    const { updateAccount } = await import("../actions/accounts");
    // @ts-expect-error deliberately invalid role
    await expect(updateAccount("agent-1", { role: "SUPER_ADMIN" })).rejects.toThrow();
  });

  it("allows demoting an Admin's role when other active Admins remain", async () => {
    seed(
      { id: "admin-1", fullName: "Admin One", email: "a1@x.com", phone: null, role: "ADMIN", status: "ACTIVE", hiredAt: null },
      { id: "admin-2", fullName: "Admin Two", email: "a2@x.com", phone: null, role: "ADMIN", status: "ACTIVE", hiredAt: null }
    );
    const { updateAccount } = await import("../actions/accounts");
    await updateAccount("admin-2", { role: "TRAVEL_AGENT" });
    expect(accounts.get("admin-2")!.role).toBe("TRAVEL_AGENT");
  });

  it("blocks demoting the LAST active Admin's role away from ADMIN", async () => {
    seed({ id: "admin-1", fullName: "Only Admin", email: "a1@x.com", phone: null, role: "ADMIN", status: "ACTIVE", hiredAt: null });
    const { updateAccount } = await import("../actions/accounts");
    await expect(updateAccount("admin-1", { role: "TRAVEL_AGENT" })).rejects.toThrow(/last active Administrator/);
    // The role must remain unchanged.
    expect(accounts.get("admin-1")!.role).toBe("ADMIN");
  });

  it("blocking the last-admin demotion also protects against a SECOND admin doing it (not just self-demotion)", async () => {
    seed(
      { id: "admin-1", fullName: "Target Admin", email: "a1@x.com", phone: null, role: "ADMIN", status: "ACTIVE", hiredAt: null },
      { id: "admin-2", fullName: "Acting Admin", email: "a2@x.com", phone: null, role: "TRAVEL_AGENT", status: "ACTIVE", hiredAt: null }
    );
    // admin-2 is not actually an admin here on purpose — swap role to ADMIN to represent "the other admin acting"
    accounts.get("admin-2")!.role = "ADMIN";
    // Now demote admin-2, leaving admin-1 as the sole admin — should succeed.
    const { updateAccount } = await import("../actions/accounts");
    currentActor = { id: "admin-1", role: "ADMIN" };
    await updateAccount("admin-2", { role: "TRAVEL_AGENT" });
    expect(accounts.get("admin-2")!.role).toBe("TRAVEL_AGENT");
    // Now only admin-1 is ADMIN — demoting them too must be blocked.
    await expect(updateAccount("admin-1", { role: "MANAGER" })).rejects.toThrow(/last active Administrator/);
  });

  it("does not block a role change for a non-admin account (nothing to protect)", async () => {
    seed({ id: "agent-1", fullName: "Agent", email: "a@x.com", phone: null, role: "TRAVEL_AGENT", status: "ACTIVE", hiredAt: null });
    const { updateAccount } = await import("../actions/accounts");
    await updateAccount("agent-1", { role: "FLIGHT_EXPERT" });
    expect(accounts.get("agent-1")!.role).toBe("FLIGHT_EXPERT");
  });

  it("blocks the last active Admin from changing their OWN email", async () => {
    seed({ id: "admin-1", fullName: "Only Admin", email: "a1@x.com", phone: null, role: "ADMIN", status: "ACTIVE", hiredAt: null });
    const { updateAccount } = await import("../actions/accounts");
    await expect(updateAccount("admin-1", { email: "new@x.com" })).rejects.toThrow(/only active administrator/);
    expect(accounts.get("admin-1")!.email).toBe("a1@x.com");
  });

  it("allows the last active Admin's email to be changed when a DIFFERENT admin remains", async () => {
    seed(
      { id: "admin-1", fullName: "Admin One", email: "a1@x.com", phone: null, role: "ADMIN", status: "ACTIVE", hiredAt: null },
      { id: "admin-2", fullName: "Admin Two", email: "a2@x.com", phone: null, role: "ADMIN", status: "ACTIVE", hiredAt: null }
    );
    const { updateAccount } = await import("../actions/accounts");
    await updateAccount("admin-1", { email: "new@x.com" });
    expect(accounts.get("admin-1")!.email).toBe("new@x.com");
  });

  it("allows an Admin to change a DIFFERENT user's email even when that Admin is the last active one", async () => {
    seed(
      { id: "admin-1", fullName: "Only Admin", email: "a1@x.com", phone: null, role: "ADMIN", status: "ACTIVE", hiredAt: null },
      { id: "agent-1", fullName: "Agent", email: "old@x.com", phone: null, role: "TRAVEL_AGENT", status: "ACTIVE", hiredAt: null }
    );
    const { updateAccount } = await import("../actions/accounts");
    await updateAccount("agent-1", { email: "new@x.com" });
    expect(accounts.get("agent-1")!.email).toBe("new@x.com");
  });

  it("does not block a non-admin's own email from being changed by an Admin (nothing to protect)", async () => {
    seed({ id: "agent-1", fullName: "Agent", email: "old@x.com", phone: null, role: "TRAVEL_AGENT", status: "ACTIVE", hiredAt: null });
    const { updateAccount } = await import("../actions/accounts");
    await updateAccount("agent-1", { email: "new@x.com" });
    expect(accounts.get("agent-1")!.email).toBe("new@x.com");
  });
});

describe("setAccountStatus — self-protection + last-admin protection", () => {
  it("rejects a non-admin caller", async () => {
    seed({ id: "agent-1", fullName: "Agent", email: "a@x.com", phone: null, role: "TRAVEL_AGENT", status: "ACTIVE", hiredAt: null });
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT" };
    const { setAccountStatus } = await import("../actions/accounts");
    await expect(setAccountStatus("agent-1", "INACTIVE")).rejects.toThrow(/Only Admins/);
  });

  it("blocks an admin from disabling their own account", async () => {
    seed(
      { id: "admin-1", fullName: "Admin One", email: "a1@x.com", phone: null, role: "ADMIN", status: "ACTIVE", hiredAt: null },
      { id: "admin-2", fullName: "Admin Two", email: "a2@x.com", phone: null, role: "ADMIN", status: "ACTIVE", hiredAt: null }
    );
    const { setAccountStatus } = await import("../actions/accounts");
    await expect(setAccountStatus("admin-1", "INACTIVE")).rejects.toThrow(/cannot disable your own account/);
  });

  it("blocks disabling the last active Admin even when a DIFFERENT admin performs it", async () => {
    seed({ id: "admin-1", fullName: "Only Admin", email: "a1@x.com", phone: null, role: "ADMIN", status: "ACTIVE", hiredAt: null });
    currentActor = { id: "some-other-admin", role: "ADMIN" };
    accounts.set("some-other-admin", { id: "some-other-admin", fullName: "Other Admin", email: "other@x.com", phone: null, role: "ADMIN", status: "ACTIVE", hiredAt: null });
    // Now there are 2 admins; disabling admin-1 should succeed (not the last one).
    const { setAccountStatus } = await import("../actions/accounts");
    await setAccountStatus("admin-1", "INACTIVE");
    expect(accounts.get("admin-1")!.status).toBe("INACTIVE");
    // Now only "some-other-admin" is active as ADMIN — disabling them (by a hypothetical third caller) must be blocked.
    currentActor = { id: "yet-another-caller", role: "ADMIN" };
    accounts.set("yet-another-caller", { id: "yet-another-caller", fullName: "Third Admin", email: "third@x.com", phone: null, role: "TRAVEL_AGENT", status: "ACTIVE", hiredAt: null });
    await expect(setAccountStatus("some-other-admin", "INACTIVE")).rejects.toThrow(/last active Administrator/);
  });

  it("allows disabling a non-admin account freely", async () => {
    seed({ id: "agent-1", fullName: "Agent", email: "a@x.com", phone: null, role: "TRAVEL_AGENT", status: "ACTIVE", hiredAt: null });
    const { setAccountStatus } = await import("../actions/accounts");
    await setAccountStatus("agent-1", "INACTIVE");
    expect(accounts.get("agent-1")!.status).toBe("INACTIVE");
  });

  it("allows re-enabling a disabled account (no restriction on the ACTIVE direction)", async () => {
    seed({ id: "agent-1", fullName: "Agent", email: "a@x.com", phone: null, role: "TRAVEL_AGENT", status: "INACTIVE", hiredAt: null });
    const { setAccountStatus } = await import("../actions/accounts");
    await setAccountStatus("agent-1", "ACTIVE");
    expect(accounts.get("agent-1")!.status).toBe("ACTIVE");
  });

  it("preserves historical data on disable — the account row still exists with all its fields intact", async () => {
    seed({ id: "agent-1", fullName: "Agent With History", email: "a@x.com", phone: "555-1234", role: "TRAVEL_AGENT", status: "ACTIVE", hiredAt: new Date("2026-01-01") });
    const { setAccountStatus } = await import("../actions/accounts");
    await setAccountStatus("agent-1", "INACTIVE");
    const account = accounts.get("agent-1")!;
    expect(account.fullName).toBe("Agent With History");
    expect(account.phone).toBe("555-1234");
    expect(account.hiredAt).toEqual(new Date("2026-01-01"));
  });
});
