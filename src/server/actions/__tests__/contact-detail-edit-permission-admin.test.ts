import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// updateContactDetailEditPermission: who may flip the per-user "Can edit Lead/Contact phone & email" switch, and what it refuses.

type Acct = { id: string; role: string; companyId: string; canEditContactDetails: boolean; sessionCreatedAt?: Date };
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
    ["agent-1", { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-1", canEditContactDetails: true }],
    ["other", { id: "other", role: "TRAVEL_AGENT", companyId: "company-2", canEditContactDetails: true }],
    ["admin-1", { id: "admin-1", role: "ADMIN", companyId: "company-1", canEditContactDetails: true }],
    ["admin-2", { id: "admin-2", role: "ADMIN", companyId: "company-1", canEditContactDetails: true }],
  ]);
  currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1", canEditContactDetails: true, sessionCreatedAt: recent() };
  updates = [];
  audits = [];
  vi.resetModules();
  vi.stubEnv("APP_ENV", "production"); // the recent-sign-in step-up is only enforced in production, as in the other account-privilege tests
});
afterEach(() => vi.unstubAllEnvs());

describe("updateContactDetailEditPermission", () => {
  it("an Administrator can switch it off, and it persists as exactly that one column (nothing else is touched), with an audit row that holds no contact data", async () => {
    const { updateContactDetailEditPermission } = await import("../accounts");
    expect(await updateContactDetailEditPermission("agent-1", false)).toBeUndefined();
    expect(updates).toEqual([{ id: "agent-1", data: { canEditContactDetails: false } }]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: "admin-1", action: "CONTACT_DETAIL_EDIT_PERMISSION_CHANGED", entityId: "agent-1", metadata: { from: true, to: false } });
  });

  it("switching it back ON needs a recent sign-in (a granting change); a stale session gets a returned message, an audit row, and no change", async () => {
    accounts.get("agent-1")!.canEditContactDetails = false;
    currentActor = { ...currentActor!, sessionCreatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) };
    const { updateContactDetailEditPermission } = await import("../accounts");
    const r = await updateContactDetailEditPermission("agent-1", true);
    expect(r).toEqual({ error: expect.stringMatching(/sign-in within the last/i) });
    expect(updates).toEqual([]);
    expect(audits.at(-1)).toMatchObject({ action: "ACCOUNT_PRIVILEGE_CHANGE_DENIED" });
  });

  it("a recent sign-in can switch it back on", async () => {
    accounts.get("agent-1")!.canEditContactDetails = false;
    const { updateContactDetailEditPermission } = await import("../accounts");
    expect(await updateContactDetailEditPermission("agent-1", true)).toBeUndefined();
    expect(accounts.get("agent-1")!.canEditContactDetails).toBe(true);
  });

  it("switching OFF never needs the step-up, even from an old session", async () => {
    currentActor = { ...currentActor!, sessionCreatedAt: new Date(Date.now() - 5 * 60 * 60 * 1000) };
    const { updateContactDetailEditPermission } = await import("../accounts");
    expect(await updateContactDetailEditPermission("agent-1", false)).toBeUndefined();
  });

  it.each(["TRAVEL_AGENT", "MANAGER", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"])("only an Administrator may change it: a %s is refused", async (role) => {
    currentActor = { id: "u", role, companyId: "company-1", canEditContactDetails: true };
    const { updateContactDetailEditPermission } = await import("../accounts");
    await expect(updateContactDetailEditPermission("agent-1", false)).rejects.toThrow(/only admins/i);
    expect(updates).toEqual([]);
  });

  it("no signed-in user is refused", async () => {
    currentActor = null;
    const { updateContactDetailEditPermission } = await import("../accounts");
    await expect(updateContactDetailEditPermission("agent-1", false)).rejects.toThrow();
  });

  it("another company's account is 'not found' - an Admin cannot restrict users outside their own company", async () => {
    const { updateContactDetailEditPermission } = await import("../accounts");
    await expect(updateContactDetailEditPermission("other", false)).rejects.toThrow(/not found/i);
    await expect(updateContactDetailEditPermission("missing", false)).rejects.toThrow(/not found/i);
    expect(updates).toEqual([]);
  });

  it("an Administrator account cannot be restricted (no self-lockout, no locking out another Admin)", async () => {
    const { updateContactDetailEditPermission } = await import("../accounts");
    expect(await updateContactDetailEditPermission("admin-1", false)).toEqual({ error: expect.stringMatching(/always/i) });
    expect(await updateContactDetailEditPermission("admin-2", false)).toEqual({ error: expect.stringMatching(/always/i) });
    expect(updates).toEqual([]);
  });

  it("a request that changes nothing writes nothing, and malformed input is rejected", async () => {
    const { updateContactDetailEditPermission } = await import("../accounts");
    expect(await updateContactDetailEditPermission("agent-1", true)).toBeUndefined();
    expect(updates).toEqual([]);
    await expect(updateContactDetailEditPermission("agent-1", "yes" as never)).rejects.toThrow(/invalid/i);
  });
});
