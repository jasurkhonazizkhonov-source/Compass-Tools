// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

// REAL-DATABASE authorization matrix for a lead's submitting IP. For every role/relationship it proves:
//  (1) getLeadSubmissionInfo — the only read path — never returns the full IP, for anyone;
//  (2) revealLeadSubmissionIp returns the full IP ONLY to an ADMINISTRATOR who is recently signed in and whose company owns THAT lead (the owner's decision,
//      commit 5977ef8 and canRevealLeadSubmissionIp: a per-user bookings.reveal_ip grant no longer opens the lead reveal - for a Manager or a Ticketing user);
//  (3) a Manager (with or without the grant), a Travel Agent, Marketing, Ticketing, another company's Administrator, another team's lead id, a made-up id and
//      no session get the SAME generic refusal (nothing says whether the lead or its IP exists);
//  (4) every Reveal attempt (allowed or refused) writes an audit record that never contains the IP.
// Production-class behaviour (the 15-minute sign-in rule) is switched on through the environment seam.
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

type Role = "ADMIN" | "MANAGER" | "TRAVEL_AGENT" | "TICKETING_AGENT" | "MARKETING_AGENT";
type Actor = { id: string; role: Role; companyId: string; fullName: string; email: string; phone: string | null; status: string; paymentPermissions: string[]; bookingPermissions: string[]; sessionCreatedAt: Date };
let currentActor: Actor | null = null;
let production = true;
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), isProductionEnvironment: () => production }));

const TAG = `lip-${Date.now()}`;
const IP_ONE = "203.0.113.42";
const IP_TWO = "198.51.100.77";

describe.skipIf(!enabled)("lead IP — per-role authorization — real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let reveal: typeof import("../lead-submission");
  let info: typeof import("@/server/queries/lead-submission-info");
  const actors: Record<string, Actor> = {};
  const accountIds: string[] = [];
  const leads: Record<string, string> = {};
  const contactIds: string[] = [];
  const extraCompanyIds: string[] = [];

  async function makeAccount(name: string, role: Role, extra: { managerId?: string; bookingPermissions?: string[] } = {}) {
    const a = await prisma.account.create({ data: { fullName: name, email: `${name.toLowerCase()}-${TAG}@example.test`, role, status: "ACTIVE", companyId: "default-company", ...(extra.managerId ? { managerId: extra.managerId } : {}) } });
    accountIds.push(a.id);
    actors[name] = { id: a.id, role, companyId: "default-company", fullName: name, email: a.email, phone: null, status: "ACTIVE", paymentPermissions: [], bookingPermissions: extra.bookingPermissions ?? [], sessionCreatedAt: new Date() };
    return a;
  }
  const as = (name: string | null, over: Partial<Actor> = {}) => {
    currentActor = name ? { ...actors[name], ...over } : null;
  };
  const viewer = (name: string) => ({ id: actors[name].id, role: actors[name].role, companyId: actors[name].companyId });
  async function makeLead(label: string, owner: string, ip: string) {
    const contact = await prisma.contact.create({ data: { firstName: label, lastName: `C${TAG}`, primaryEmail: `${label}-${TAG}@example.test`, primaryPhone: `+1415555${String(1000 + contactIds.length)}`, companyId: "default-company", ownerId: actors[owner].id } });
    contactIds.push(contact.id);
    const lead = await prisma.lead.create({ data: { contactId: contact.id, status: "QUOTED", source: "WEBSITE", assignedAgentId: actors[owner].id, submissionInfo: { create: { ipAddress: ip, ipVersion: "v4", city: "Frankfurt", country: "Germany", countryCode: "DE", timeZone: "Europe/Berlin" } } } });
    leads[label] = lead.id;
  }
  const auditRows = (leadId: string) => prisma.auditLog.findMany({ where: { entityId: leadId, action: { in: ["LEAD_IP_REVEALED", "LEAD_IP_REVEAL_DENIED"] } }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    reveal = await import("../lead-submission");
    info = await import("@/server/queries/lead-submission-info");
    await prisma.company.upsert({ where: { id: "default-company" }, update: {}, create: { id: "default-company", name: "Test Co", signatureTemplate: "Regards" } });
    await makeAccount("Admin", "ADMIN");
    const m1 = await makeAccount("MgrGranted", "MANAGER", { bookingPermissions: ["bookings.reveal_ip"] });
    const m2 = await makeAccount("MgrOther", "MANAGER", { bookingPermissions: ["bookings.reveal_ip"] });
    const m3 = await makeAccount("MgrNoGrant", "MANAGER");
    await makeAccount("AgentOne", "TRAVEL_AGENT", { managerId: m1.id });
    await makeAccount("AgentTeamNoGrant", "TRAVEL_AGENT", { managerId: m3.id });
    await makeAccount("AgentTwo", "TRAVEL_AGENT", { managerId: m2.id });
    await makeAccount("Marketer", "MARKETING_AGENT");
    await makeAccount("Ticketer", "TICKETING_AGENT", { bookingPermissions: ["bookings.reveal_ip"] });
    await makeLead("one", "AgentOne", IP_ONE);
    await makeLead("two", "AgentTwo", IP_TWO);
    await makeLead("nogrant", "AgentTeamNoGrant", IP_ONE);
  });

  beforeEach(() => {
    production = true;
  });

  afterAll(async () => {
    if (!enabled) return;
    await prisma.leadSubmissionInfo.deleteMany({ where: { leadId: { in: Object.values(leads) } } });
    await prisma.lead.deleteMany({ where: { id: { in: Object.values(leads) } } });
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    await prisma.account.updateMany({ where: { id: { in: accountIds } }, data: { managerId: null } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.company.deleteMany({ where: { id: { in: extraCompanyIds } } }); // only the companies this suite created
    await prisma.$disconnect();
  });

  describe("getLeadSubmissionInfo — no role ever receives the full IP", () => {
    it.each([
      ["Admin", true],
      ["MgrGranted", true], // the owning Manager
      ["AgentOne", true], // the owning Travel Agent: sees the masked value only
    ])("%s sees lead 'one' — masked only, never the full address", async (name, sees) => {
      const r = await info.getLeadSubmissionInfo(leads.one, viewer(name));
      expect(!!r).toBe(sees);
      expect(r).toMatchObject({ hasIp: true, ipMasked: "203.x.x.x", ipVersion: "v4", city: "Frankfurt" });
      expect(JSON.stringify(r)).not.toContain(IP_ONE);
      expect(JSON.stringify(r)).not.toContain("113.42");
    });

    it.each(["MgrOther", "AgentTwo", "Marketer", "Ticketer"])("%s (other team / no Leads area) gets nothing for lead 'one'", async (name) => {
      expect(await info.getLeadSubmissionInfo(leads.one, viewer(name))).toBeNull();
    });

    it("no viewer, and a made-up lead id, yield nothing", async () => {
      expect(await info.getLeadSubmissionInfo(leads.one, null)).toBeNull();
      expect(await info.getLeadSubmissionInfo("no-such-lead", viewer("Admin"))).toBeNull();
    });
  });

  describe("revealLeadSubmissionIp", () => {
    it("Admin: allowed with a recent sign-in, returns the full IP, writes a success audit record without the IP", async () => {
      as("Admin");
      const r = await reveal.revealLeadSubmissionIp(leads.one);
      expect(r).toEqual({ ipAddress: IP_ONE, ipVersion: "v4" });
      const rows = await auditRows(leads.one);
      const row = rows[rows.length - 1];
      expect(row).toMatchObject({ action: "LEAD_IP_REVEALED", actorId: actors.Admin.id });
      expect(JSON.stringify(row.metadata)).not.toContain(IP_ONE);
    });

    it("the owning Manager WITH the bookings.reveal_ip grant is REFUSED (a grant no longer opens the lead reveal), and the refusal is audited without the address", async () => {
      as("MgrGranted");
      await expect(reveal.revealLeadSubmissionIp(leads.one)).rejects.toThrow(/not authorized/i);
      const rows = await prisma.auditLog.findMany({ where: { actorId: actors.MgrGranted.id, entityId: leads.one, action: "LEAD_IP_REVEAL_DENIED" } });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[rows.length - 1].metadata).toMatchObject({ result: "DENIED", reason: "MISSING_PERMISSION" });
      expect(JSON.stringify(rows)).not.toContain(IP_ONE);
      // and nothing was recorded as a successful reveal for that account
      expect(await prisma.auditLog.count({ where: { actorId: actors.MgrGranted.id, action: "LEAD_IP_REVEALED" } })).toBe(0);
    });

    it("a stale sign-in (older than 15 minutes) is refused with a message and audited — even for Admin", async () => {
      as("Admin", { sessionCreatedAt: new Date(Date.now() - 16 * 60 * 1000) });
      const r = await reveal.revealLeadSubmissionIp(leads.one);
      expect(r).toEqual({ error: expect.stringMatching(/sign-in within the last 15 minutes/) });
      expect(JSON.stringify(r)).not.toContain(IP_ONE);
      const rows = await auditRows(leads.one);
      expect(rows.some((x) => x.action === "LEAD_IP_REVEAL_DENIED" && (x.metadata as { reason?: string })?.reason === "RECENT_LOGIN_REQUIRED")).toBe(true);
    });

    it("a missing sign-in time is treated as stale", async () => {
      as("Admin", { sessionCreatedAt: null as unknown as Date });
      expect(await reveal.revealLeadSubmissionIp(leads.one)).toEqual({ error: expect.any(String) });
    });

    it.each([
      ["AgentOne", "the owning Travel Agent (no role eligibility)"],
      ["MgrNoGrant", "a Manager without the IP grant (own lead id of another team, no grant)"],
      ["Marketer", "Marketing Agent"],
      ["Ticketer", "Ticketing Agent (eligible role, but no Leads area)"],
    ])("%s — %s — is refused, and the refusal is audited", async (name) => {
      as(name);
      await expect(reveal.revealLeadSubmissionIp(leads.one)).rejects.toThrow(/not authorized/i);
      const rows = await prisma.auditLog.findMany({ where: { actorId: actors[name].id, action: "LEAD_IP_REVEAL_DENIED" } });
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain(IP_ONE);
    });

    it("a granted Manager of ANOTHER team cannot reveal this lead (lead-id tampering): the same refusal as a missing lead, and not even their OWN team's lead opens", async () => {
      as("MgrOther");
      const message = async (id: string) => {
        try {
          await reveal.revealLeadSubmissionIp(id);
        } catch (error) {
          return (error as Error).message;
        }
        throw new Error("expected a refusal");
      };
      const [foreignLead, missingLead, ownTeamLead] = [await message(leads.one), await message("no-such-lead"), await message(leads.two)];
      expect(foreignLead).toMatch(/not authorized/i);
      // identical text for another team's lead, a lead that does not exist and their own team's lead: nothing tells which of them exists or has an IP
      expect(missingLead).toBe(foreignLead);
      expect(ownTeamLead).toBe(foreignLead);
      const rows = await prisma.auditLog.findMany({ where: { actorId: actors.MgrOther.id, action: "LEAD_IP_REVEAL_DENIED" } });
      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(rows)).not.toContain(IP_ONE);
      expect(JSON.stringify(rows)).not.toContain(IP_TWO);
    });

    it("lead-id tampering by the one role that CAN reveal: an Administrator of ANOTHER company gets the same refusal as for a missing lead, audited as 'not accessible'", async () => {
      const otherCompanyId = `other-co-${TAG}`;
      await prisma.company.create({ data: { id: otherCompanyId, name: `Other company ${TAG}`, signatureTemplate: "Regards" } });
      extraCompanyIds.push(otherCompanyId);
      const outsider = await prisma.account.create({ data: { fullName: "AdminOtherCo", email: `adminotherco-${TAG}@example.test`, role: "ADMIN", status: "ACTIVE", companyId: otherCompanyId } });
      accountIds.push(outsider.id);
      actors.AdminOtherCo = { ...actors.Admin, id: outsider.id, companyId: otherCompanyId, fullName: "AdminOtherCo", email: outsider.email };
      as("AdminOtherCo");
      const [foreign, missing] = [
        await reveal.revealLeadSubmissionIp(leads.one).catch((e: Error) => e.message),
        await reveal.revealLeadSubmissionIp("no-such-lead").catch((e: Error) => e.message),
      ];
      expect(foreign).toMatch(/not authorized/i);
      expect(missing).toBe(foreign);
      const rows = await prisma.auditLog.findMany({ where: { actorId: outsider.id, action: "LEAD_IP_REVEAL_DENIED" } });
      expect(rows.map((r) => (r.metadata as { reason?: string }).reason)).toEqual(["NOT_ACCESSIBLE_OR_NOT_CAPTURED", "NOT_ACCESSIBLE_OR_NOT_CAPTURED"]);
      expect(JSON.stringify(rows)).not.toContain(IP_ONE);
      expect(await prisma.auditLog.count({ where: { actorId: outsider.id, action: "LEAD_IP_REVEALED" } })).toBe(0);
    });

    it("another team's Travel Agent cannot reveal or even see it", async () => {
      as("AgentTwo");
      await expect(reveal.revealLeadSubmissionIp(leads.one)).rejects.toThrow(/not authorized/i);
    });

    it("no session at all (unauthenticated) is refused", async () => {
      as(null);
      await expect(reveal.revealLeadSubmissionIp(leads.one)).rejects.toThrow(/not authorized/i);
    });

    it("an inactive account is refused", async () => {
      as("Admin", { status: "INACTIVE" });
      await expect(reveal.revealLeadSubmissionIp(leads.one)).rejects.toThrow(/not authorized/i);
    });

    it("a client cannot grant itself access: the permission comes from the stored account, not from a flag the caller supplies", async () => {
      // the action takes only a lead id — there is no parameter through which a role / permission can be passed
      expect(reveal.revealLeadSubmissionIp.length).toBe(1);
      as("AgentOne", { bookingPermissions: ["bookings.reveal_ip"] }); // even a forged grant on a non-eligible role is refused
      await expect(reveal.revealLeadSubmissionIp(leads.one)).rejects.toThrow(/not authorized/i);
    });

    it("rate limit: repeated attempts are limited per account, with a returned message and a RATE_LIMITED audit", async () => {
      as("Admin");
      let limited: unknown = null;
      for (let i = 0; i < 30 && !limited; i++) {
        const r = await reveal.revealLeadSubmissionIp(leads.one);
        if ("error" in r && /Too many Reveal attempts/.test(r.error)) limited = r;
      }
      expect(limited).toEqual({ error: expect.stringMatching(/Too many Reveal attempts/) });
      const rows = await prisma.auditLog.findMany({ where: { actorId: actors.Admin.id, action: "LEAD_IP_REVEAL_DENIED" } });
      expect(rows.some((x) => (x.metadata as { reason?: string })?.reason === "RATE_LIMITED")).toBe(true);
    });
  });
});
