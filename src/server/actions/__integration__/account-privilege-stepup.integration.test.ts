// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

// REAL-DATABASE proof that actions which GIVE an account more reach — a role change, a changed login email, a newly granted
// payment / booking permission, creating an Admin — require an Admin who signed in within the last 15 minutes, in production-
// class environments; that the refusal is a returned message (never a masked thrown error) and is audited without any values;
// and that revocations and ordinary profile edits are NOT blocked by a stale sign-in.
// Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL with this repo's migrations applied.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
  process.env.CARD_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_HASH_KEY ??= randomBytes(32).toString("base64");
}

type Role = "ADMIN" | "MANAGER" | "TRAVEL_AGENT" | "TICKETING_AGENT";
type Actor = { id: string; role: Role; companyId: string; fullName: string; email: string; phone: string | null; status: string; paymentPermissions: string[]; bookingPermissions: string[]; sessionCreatedAt: Date | null };
let currentActor: Actor | null = null;
let production = true;
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), isProductionEnvironment: () => production }));

const TAG = `stp-${Date.now()}`;
const mail = (n: string) => `${n.toLowerCase()}-${TAG}@example.test`;
const MESSAGE = /sign-in within the last 15 minutes/;

describe.skipIf(!enabled)("account privilege changes need a recent sign-in — real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let actions: typeof import("../accounts");
  const ids: string[] = [];
  let adminId = "";
  let mgrId = "";
  let agentId = "";

  const asAdmin = (ageMs: number | null) => {
    currentActor = { id: adminId, role: "ADMIN", companyId: "default-company", fullName: "Admin", email: mail("admin"), phone: null, status: "ACTIVE", paymentPermissions: [], bookingPermissions: [], sessionCreatedAt: ageMs === null ? null : new Date(Date.now() - ageMs) };
  };
  const STALE = 16 * 60 * 1000;
  const FRESH = 60 * 1000;
  const denials = (accountId: string) => prisma.auditLog.findMany({ where: { entityId: accountId, action: "ACCOUNT_PRIVILEGE_CHANGE_DENIED" } });
  const fresh = (id: string) => prisma.account.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    actions = await import("../accounts");
    await prisma.company.upsert({ where: { id: "default-company" }, update: {}, create: { id: "default-company", name: "Test Co", signatureTemplate: "Regards" } });
    const mk = async (n: string, role: Role) => {
      const a = await prisma.account.create({ data: { fullName: n, email: mail(n), role, status: "ACTIVE", companyId: "default-company" } });
      ids.push(a.id);
      return a.id;
    };
    adminId = await mk("Admin", "ADMIN");
    await mk("OtherAdmin", "ADMIN"); // so demotions never trip the last-admin guard
    mgrId = await mk("Mgr", "MANAGER");
    agentId = await mk("Agent", "TRAVEL_AGENT");
  });
  beforeEach(() => {
    production = true;
  });
  afterAll(async () => {
    if (!enabled) return;
    const created = await prisma.account.findMany({ where: { email: { contains: TAG } }, select: { id: true } });
    const all = [...new Set([...ids, ...created.map((c) => c.id)])];
    await prisma.account.updateMany({ where: { id: { in: all } }, data: { managerId: null } });
    await prisma.account.deleteMany({ where: { id: { in: all } } });
    await prisma.$disconnect();
  });

  describe("a STALE Admin session (older than 15 minutes)", () => {
    it("cannot change a role: a returned message, nothing changes, the attempt is audited without values", async () => {
      asAdmin(STALE);
      const r = await actions.updateAccount(agentId, { role: "MANAGER" });
      expect(r).toEqual({ error: expect.stringMatching(MESSAGE) });
      expect((await fresh(agentId)).role).toBe("TRAVEL_AGENT");
      const rows = await denials(agentId);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]).toMatchObject({ actorId: adminId, entityType: "Account" });
      expect(rows[0].metadata).toMatchObject({ attempted: "role", reason: "RECENT_LOGIN_REQUIRED" });
      expect(JSON.stringify(rows)).not.toContain("example.test");
    });

    it("cannot change a login email (the identity Google sign-in matches)", async () => {
      asAdmin(STALE);
      const before = (await fresh(agentId)).email;
      const r = await actions.updateAccount(agentId, { email: mail("hijacked") });
      expect(r).toEqual({ error: expect.stringMatching(MESSAGE) });
      expect((await fresh(agentId)).email).toBe(before);
      expect(JSON.stringify(await denials(agentId))).not.toContain("hijacked");
    });

    it("cannot grant a payment-reveal permission or the booking IP-reveal permission", async () => {
      asAdmin(STALE);
      expect(await actions.updatePaymentPermissions(mgrId, ["payments.reveal"])).toEqual({ error: expect.stringMatching(MESSAGE) });
      expect((await fresh(mgrId)).paymentPermissions).toEqual([]);
      expect(await actions.updateBookingPermissions(mgrId, ["bookings.reveal_ip"])).toEqual({ error: expect.stringMatching(MESSAGE) });
      expect((await fresh(mgrId)).bookingPermissions).toEqual([]);
    });

    it("cannot create an Admin; a missing sign-in time counts as stale", async () => {
      asAdmin(STALE);
      expect(await actions.createAccount({ fullName: "New Admin", email: mail("newadmin"), role: "ADMIN", status: "ACTIVE" })).toEqual({ error: expect.stringMatching(MESSAGE) });
      expect(await prisma.account.count({ where: { email: mail("newadmin") } })).toBe(0);
      asAdmin(null);
      expect(await actions.updateAccount(agentId, { role: "MANAGER" })).toEqual({ error: expect.stringMatching(MESSAGE) });
    });

    it("is NOT blocked from ordinary edits, from creating a non-privileged user, or from REVOKING a permission", async () => {
      asAdmin(FRESH);
      expect(await actions.updatePaymentPermissions(mgrId, ["payments.reveal"])).toBeUndefined();
      asAdmin(STALE);
      expect(await actions.updateAccount(agentId, { fullName: "Agent Renamed", phone: "+14155550101", location: "Frankfurt" })).toBeUndefined();
      expect((await fresh(agentId)).fullName).toBe("Agent Renamed");
      expect(await actions.createAccount({ fullName: "New Agent", email: mail("newagent"), role: "TRAVEL_AGENT", status: "ACTIVE" })).toBeUndefined();
      expect(await actions.updatePaymentPermissions(mgrId, [])).toBeUndefined(); // revoke
      expect((await fresh(mgrId)).paymentPermissions).toEqual([]);
    });
  });

  describe("a FRESH Admin session", () => {
    it("can do all of it", async () => {
      asAdmin(FRESH);
      expect(await actions.updateAccount(agentId, { role: "MANAGER" })).toBeUndefined();
      expect((await fresh(agentId)).role).toBe("MANAGER");
      expect(await actions.updateAccount(agentId, { role: "TRAVEL_AGENT" })).toBeUndefined();
      expect(await actions.updateAccount(agentId, { email: mail("agent2") })).toBeUndefined();
      expect(await actions.updateBookingPermissions(mgrId, ["bookings.reveal_ip"])).toBeUndefined();
      expect((await fresh(mgrId)).bookingPermissions).toEqual(["bookings.reveal_ip"]);
      expect(await actions.createAccount({ fullName: "Second Admin", email: mail("secondadmin"), role: "ADMIN", status: "ACTIVE" })).toBeUndefined();
      const role = await prisma.auditLog.findMany({ where: { entityId: agentId, action: "ACCOUNT_ROLE_CHANGED" } });
      expect(role.length).toBeGreaterThan(0);
    });

    it("re-granting a permission the account ALREADY has needs no step-up (nothing is added)", async () => {
      asAdmin(STALE);
      expect(await actions.updateBookingPermissions(mgrId, ["bookings.reveal_ip"])).toBeUndefined();
    });
  });

  it("outside production-class environments (local development) the step-up passes through, as for Reveal", async () => {
    production = false;
    asAdmin(STALE);
    expect(await actions.updateAccount(agentId, { role: "TRAVEL_AGENT" })).toBeUndefined();
  });

  it("a non-Admin is refused outright, whatever their sign-in age", async () => {
    currentActor = { id: agentId, role: "TRAVEL_AGENT", companyId: "default-company", fullName: "A", email: mail("agent2"), phone: null, status: "ACTIVE", paymentPermissions: [], bookingPermissions: [], sessionCreatedAt: new Date() };
    await expect(actions.updateAccount(agentId, { role: "ADMIN" })).rejects.toThrow(/Only Admins/);
    await expect(actions.updatePaymentPermissions(agentId, ["payments.reveal"])).rejects.toThrow(/Only Admins/);
    expect((await fresh(agentId)).role).toBe("TRAVEL_AGENT");
  });
});
