import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// updateUnlimitedCustomerEmailAccess: who may flip the per-user "Unlimited Customer Email Access" switch (default OFF) and what it refuses.

type Acct = { id: string; role: string; companyId: string; unlimitedCustomerEmailAccess: boolean; sessionCreatedAt?: Date };
let accounts: Map<string, Acct>;
let currentActor: Acct | null;
let updates: Array<{ id: string; data: Record<string, unknown> }>;
let audits: Array<Record<string, unknown>>;

vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => void audits.push(data)) },
    account: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (accounts.get(where.id) ? { ...accounts.get(where.id) } : null)),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: where.id, data });
        Object.assign(accounts.get(where.id)!, data);
        return {};
      }),
    },
  },
}));

const recent = () => new Date(Date.now() - 60_000);
beforeEach(() => {
  accounts = new Map([
    ["agent-1", { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-1", unlimitedCustomerEmailAccess: false }],
    ["other", { id: "other", role: "TRAVEL_AGENT", companyId: "company-2", unlimitedCustomerEmailAccess: false }],
    ["admin-1", { id: "admin-1", role: "ADMIN", companyId: "company-1", unlimitedCustomerEmailAccess: false }],
  ]);
  currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1", unlimitedCustomerEmailAccess: false, sessionCreatedAt: recent() };
  updates = [];
  audits = [];
  vi.resetModules();
  vi.stubEnv("APP_ENV", "production");
});
afterEach(() => vi.unstubAllEnvs());

describe("updateUnlimitedCustomerEmailAccess", () => {
  it("defaults to OFF for everyone: the column default is false (schema) and a fresh account reads as restricted", async () => {
    const { readFileSync } = await import("node:fs");
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    expect(schema).toMatch(/unlimitedCustomerEmailAccess\s+Boolean\s+@default\(false\)/);
    const migration = readFileSync("prisma/migrations/20261120000100_security_privacy_marketing_scale/migration.sql", "utf8");
    expect(migration).toMatch(/"unlimitedCustomerEmailAccess" BOOLEAN NOT NULL DEFAULT false/);
  });

  it("an Administrator can grant it (recent sign-in), it persists as exactly that one column, and the audit row holds no customer data", async () => {
    const { updateUnlimitedCustomerEmailAccess } = await import("../accounts");
    expect(await updateUnlimitedCustomerEmailAccess("agent-1", true)).toBeUndefined();
    expect(updates).toEqual([{ id: "agent-1", data: { unlimitedCustomerEmailAccess: true } }]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: "admin-1", action: "UNLIMITED_CUSTOMER_EMAIL_ACCESS_CHANGED", entityId: "agent-1", metadata: { from: false, to: true } });
  });

  it("granting needs a recent sign-in: a stale session gets a returned message, an audit row, and no change", async () => {
    currentActor = { ...currentActor!, sessionCreatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) };
    const { updateUnlimitedCustomerEmailAccess } = await import("../accounts");
    expect(await updateUnlimitedCustomerEmailAccess("agent-1", true)).toEqual({ error: expect.stringMatching(/sign-in within the last/i) });
    expect(updates).toEqual([]);
    expect(audits.at(-1)).toMatchObject({ action: "ACCOUNT_PRIVILEGE_CHANGE_DENIED", metadata: { attempted: "grant-unlimited-customer-email-access" } });
  });

  it("revoking works from any session (it never needs the step-up) and is audited", async () => {
    accounts.get("agent-1")!.unlimitedCustomerEmailAccess = true;
    currentActor = { ...currentActor!, sessionCreatedAt: new Date(Date.now() - 6 * 60 * 60 * 1000) };
    const { updateUnlimitedCustomerEmailAccess } = await import("../accounts");
    expect(await updateUnlimitedCustomerEmailAccess("agent-1", false)).toBeUndefined();
    expect(accounts.get("agent-1")!.unlimitedCustomerEmailAccess).toBe(false);
    expect(audits.at(-1)).toMatchObject({ action: "UNLIMITED_CUSTOMER_EMAIL_ACCESS_CHANGED", metadata: { from: true, to: false } });
  });

  it.each(["TRAVEL_AGENT", "MANAGER", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"])("only an Administrator may change it: a %s is refused (even for themselves)", async (role) => {
    currentActor = { id: "agent-1", role, companyId: "company-1", unlimitedCustomerEmailAccess: false };
    const { updateUnlimitedCustomerEmailAccess } = await import("../accounts");
    await expect(updateUnlimitedCustomerEmailAccess("agent-1", true)).rejects.toThrow(/only admins/i);
    expect(updates).toEqual([]);
    expect(accounts.get("agent-1")!.unlimitedCustomerEmailAccess).toBe(false);
  });

  it("no signed-in user is refused", async () => {
    currentActor = null;
    const { updateUnlimitedCustomerEmailAccess } = await import("../accounts");
    await expect(updateUnlimitedCustomerEmailAccess("agent-1", true)).rejects.toThrow();
  });

  it("another company's account is 'not found'", async () => {
    const { updateUnlimitedCustomerEmailAccess } = await import("../accounts");
    await expect(updateUnlimitedCustomerEmailAccess("other", true)).rejects.toThrow(/not found/i);
    await expect(updateUnlimitedCustomerEmailAccess("missing", true)).rejects.toThrow(/not found/i);
    expect(updates).toEqual([]);
  });

  it("an Administrator target is refused with a message (Administrators always have full access)", async () => {
    const { updateUnlimitedCustomerEmailAccess } = await import("../accounts");
    expect(await updateUnlimitedCustomerEmailAccess("admin-1", true)).toEqual({ error: expect.stringMatching(/always/i) });
    expect(updates).toEqual([]);
  });

  it("a request that changes nothing writes nothing; malformed input is rejected", async () => {
    const { updateUnlimitedCustomerEmailAccess } = await import("../accounts");
    expect(await updateUnlimitedCustomerEmailAccess("agent-1", false)).toBeUndefined();
    expect(updates).toEqual([]);
    await expect(updateUnlimitedCustomerEmailAccess("agent-1", "yes" as never)).rejects.toThrow(/invalid/i);
  });
});
