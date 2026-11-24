// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

// REAL-DATABASE proof of the two bulk actions behind the checkbox selection on Leads / Contacts:
//   * bulkEnrollInSequence - NOT Admin-only: any role that may manage sequences and has the list (Travel Agent, Manager, Admin) can use
//     it, strictly inside its own record visibility and its own sequences; Ticketing / Marketing / signed-out callers cannot. Duplicates
//     are never enrolled twice; contacts are enrolled through their most recent lead; the result accounts for every selected record.
//   * bulkDeleteRecords - Admin-only on the server (a Manager, who may still delete one record, is refused here), company-isolated,
//     reusing the existing per-record deletion (cascade + audit) and adding a summary audit entry.
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
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// This suite is about bulk selection, not Gmail: every sending agent counts as having a usable Gmail (the readiness check itself is covered by sequences.test.ts).
vi.mock("@/server/email/gmail-send", () => ({ checkGmailSendReadiness: vi.fn(async () => ({ ready: true, verified: false })) }));

const TAG = `blk-${Date.now()}`;
const CO = `co-${TAG}`;
const OTHER_CO = `co2-${TAG}`;

describe.skipIf(!enabled)("bulk enroll / bulk delete - real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let enroll: typeof import("../bulk-selection").bulkEnrollInSequence;
  let del: typeof import("../bulk-selection").bulkDeleteRecords;
  const actors: Record<string, Actor> = {};
  const accountIds: string[] = [];
  const contactIds: string[] = [];
  const sequenceIds: string[] = [];
  let n = 0;

  async function makeAccount(name: string, role: Role, company = CO, managerId?: string) {
    const a = await prisma.account.create({ data: { fullName: name, email: `${name.toLowerCase()}-${TAG}@example.test`, role, status: "ACTIVE", companyId: company, ...(managerId ? { managerId } : {}) } });
    accountIds.push(a.id);
    actors[name] = { id: a.id, role, companyId: company, fullName: name, email: a.email, phone: null, status: "ACTIVE", paymentPermissions: [], bookingPermissions: [], sessionCreatedAt: new Date() };
    return a;
  }
  const as = (name: string | null) => {
    currentActor = name ? actors[name] : null;
  };
  async function makeContact(first: string, owner: string, opts: { email?: boolean; company?: string } = {}) {
    n++;
    const c = await prisma.contact.create({
      data: { firstName: first, lastName: `T${TAG}`, primaryEmail: opts.email === false ? null : `${first.toLowerCase()}${n}-${TAG}@example.test`, primaryPhone: `+1415556${String(1000 + n)}`, companyId: opts.company ?? CO, ownerId: actors[owner].id },
    });
    contactIds.push(c.id);
    return c;
  }
  async function makeLead(contactId: string, agent: string) {
    return prisma.lead.create({ data: { contactId, status: "QUOTED", source: "WEBSITE", assignedAgentId: actors[agent].id } });
  }
  async function makeSequence(name: string, creator: string, opts: { active?: boolean; steps?: number } = {}) {
    const s = await prisma.sequence.create({
      data: {
        name: `${name} ${TAG}`,
        createdById: actors[creator].id,
        isActive: opts.active ?? true,
        steps: { create: Array.from({ length: opts.steps ?? 1 }, (_, i) => ({ order: i, subject: `Hello ${i}`, body: "Body", delayMinutes: 0 })) },
      },
    });
    sequenceIds.push(s.id);
    return s;
  }
  const enrollmentCount = (sequenceId: string, leadIds?: string[]) => prisma.sequenceEnrollment.count({ where: { sequenceId, ...(leadIds ? { leadId: { in: leadIds } } : {}) } });
  const audit = (action: string) => prisma.auditLog.findMany({ where: { action }, orderBy: { createdAt: "desc" }, take: 5 });

  let L1: string, L2: string, L3: string, L4: string, LT: string;
  let C1: string, C3: string, C5: string, C6: string, LxOld: string, LyNew: string;
  let seqAgent: string, seqAdmin: string, seqEmpty: string, seqInactive: string, seqOther: string;

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ bulkEnrollInSequence: enroll, bulkDeleteRecords: del } = await import("../bulk-selection"));
    for (const id of [CO, OTHER_CO]) await prisma.company.create({ data: { id, name: `Co ${id}`, signatureTemplate: "Regards" } });
    await makeAccount("Admin", "ADMIN");
    const mgr = await makeAccount("Mgr", "MANAGER");
    await makeAccount("TeamAgent", "TRAVEL_AGENT", CO, mgr.id);
    await makeAccount("AgentOwn", "TRAVEL_AGENT");
    await makeAccount("AgentOther", "TRAVEL_AGENT");
    await makeAccount("Ticketer", "TICKETING_AGENT");
    await makeAccount("Marketer", "MARKETING_AGENT");
    await makeAccount("OutsiderAdmin", "ADMIN", OTHER_CO);

    seqAgent = (await makeSequence("Agent sequence", "AgentOwn")).id;
    seqAdmin = (await makeSequence("Admin sequence", "Admin")).id;
    seqEmpty = (await makeSequence("Empty", "AgentOwn", { steps: 0 })).id;
    seqInactive = (await makeSequence("Inactive", "AgentOwn", { active: false })).id;
    seqOther = (await makeSequence("Other agent's", "AgentOther")).id;
  });
  afterAll(async () => {
    if (!enabled) return;
    await prisma.auditLog.deleteMany({ where: { actorId: { in: accountIds } } }).catch(() => undefined);
    await prisma.sequence.deleteMany({ where: { id: { in: sequenceIds } } });
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.company.deleteMany({ where: { id: { in: [CO, OTHER_CO] } } });
    await prisma.$disconnect();
  });
  // Fresh records for every test: deletion tests remove them, enrollment tests add enrollments.
  beforeEach(async () => {
    as(null);
    await prisma.sequenceEnrollment.deleteMany({ where: { sequenceId: { in: sequenceIds } } }); // each test starts with no enrollments
    const c1 = await makeContact("Ada", "AgentOwn");
    const c2 = await makeContact("Bo", "AgentOwn");
    const c3 = await makeContact("Cy", "AgentOther");
    const c5 = await makeContact("Eli", "AgentOwn"); // no lead at all
    const c6 = await makeContact("Fay", "AgentOwn"); // two leads, both AgentOwn's
    const c4 = await makeContact("Gus", "OutsiderAdmin", { company: OTHER_CO });
    const ct = await makeContact("Tim", "TeamAgent");
    [C1, C3, C5, C6] = [c1.id, c3.id, c5.id, c6.id];
    L1 = (await makeLead(c1.id, "AgentOwn")).id;
    L2 = (await makeLead(c2.id, "AgentOwn")).id;
    L3 = (await makeLead(c3.id, "AgentOther")).id;
    L4 = (await makeLead(c4.id, "OutsiderAdmin")).id;
    LT = (await makeLead(ct.id, "TeamAgent")).id;
    LxOld = (await makeLead(c6.id, "AgentOwn")).id;
    await new Promise((r) => setTimeout(r, 15));
    LyNew = (await makeLead(c6.id, "AgentOwn")).id;
  });

  // ---------------------------------------------------------------------------------------------------------------------------
  describe("bulkEnrollInSequence - leads", () => {
    it("a Travel Agent (not an Admin) can enroll their own leads; each gets an enrollment, an activity entry and the enroller recorded", async () => {
      as("AgentOwn");
      const r = await enroll({ sequenceId: seqAgent, kind: "leads", ids: [L1, L2] });
      expect(r).toMatchObject({ ok: true, requested: 2, enrolled: 2, alreadyEnrolled: 0, failed: [] });
      if (!r.ok) return;
      expect(r.settledIds.sort()).toEqual([L1, L2].sort());
      expect(r.withoutEmail).toBe(0); // a lead without an email address is no longer enrolled at all (see the next test), so none can be "enrolled without email"
      const rows = await prisma.sequenceEnrollment.findMany({ where: { sequenceId: seqAgent, leadId: { in: [L1, L2] } } });
      expect(rows).toHaveLength(2);
      expect(rows.every((e) => e.enrolledById === actors.AgentOwn.id && e.status === "ACTIVE")).toBe(true);
      expect(await prisma.activity.count({ where: { leadId: { in: [L1, L2] }, type: "SEQUENCE_ENROLLED" } })).toBe(2);
    });

    it("a lead whose contact has no email address is NOT enrolled (it would only fail on its first run) and is reported with that reason", async () => {
      as("AgentOwn");
      const noMail = await makeContact("Mo", "AgentOwn", { email: false });
      const LM = (await makeLead(noMail.id, "AgentOwn")).id;
      const r = await enroll({ sequenceId: seqAgent, kind: "leads", ids: [L1, LM] });
      expect(r).toMatchObject({ ok: true, requested: 2, enrolled: 1, alreadyEnrolled: 0 });
      if (!r.ok) return;
      expect(r.failed).toHaveLength(1);
      expect(r.failed[0]).toMatchObject({ id: LM, reason: expect.stringMatching(/No email address/) });
      expect(await prisma.sequenceEnrollment.count({ where: { leadId: LM } })).toBe(0);
    });

    it("a duplicate is never enrolled twice: re-running enrolls nothing and reports them as already enrolled", async () => {
      as("AgentOwn");
      await enroll({ sequenceId: seqAgent, kind: "leads", ids: [L1] });
      const again = await enroll({ sequenceId: seqAgent, kind: "leads", ids: [L1, L2] });
      expect(again).toMatchObject({ ok: true, enrolled: 1, alreadyEnrolled: 1, failed: [] });
      expect(await enrollmentCount(seqAgent, [L1])).toBe(1);
      expect(await enrollmentCount(seqAgent, [L2])).toBe(1);
      const third = await enroll({ sequenceId: seqAgent, kind: "leads", ids: [L1, L2] });
      expect(third).toMatchObject({ ok: true, enrolled: 0, alreadyEnrolled: 2 });
      expect(await enrollmentCount(seqAgent)).toBe(2);
    });

    it("the same id sent twice counts once", async () => {
      as("AgentOwn");
      const r = await enroll({ sequenceId: seqAgent, kind: "leads", ids: [L1, L1, L1] });
      expect(r).toMatchObject({ ok: true, requested: 1, enrolled: 1 });
    });

    it("partial success: another agent's lead, another company's lead and an unknown id are reported as not available and are NOT enrolled; the rest are", async () => {
      as("AgentOwn");
      const r = await enroll({ sequenceId: seqAgent, kind: "leads", ids: [L1, L3, L4, "does-not-exist"] });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r).toMatchObject({ requested: 4, enrolled: 1, alreadyEnrolled: 0 });
      expect(r.failed.map((f) => f.id).sort()).toEqual([L3, L4, "does-not-exist"].sort());
      expect(r.failed.every((f) => f.label === null && /No longer available/.test(f.reason))).toBe(true); // no name of a record the user cannot see
      expect(r.settledIds).toEqual([L1]);
      expect(await enrollmentCount(seqAgent, [L3, L4])).toBe(0);
    });

    it("a restricted role can only use sequences it created: an Admin's sequence and another agent's sequence are refused outright", async () => {
      as("AgentOwn");
      for (const seq of [seqAdmin, seqOther]) {
        const r = await enroll({ sequenceId: seq, kind: "leads", ids: [L1] });
        expect(r.ok).toBe(false);
        expect(await enrollmentCount(seq)).toBe(0);
      }
    });

    it("an empty, inactive or non-existent sequence is refused and nothing is enrolled", async () => {
      as("AgentOwn");
      for (const seq of [seqEmpty, seqInactive, "no-such-sequence"]) {
        const r = await enroll({ sequenceId: seq, kind: "leads", ids: [L1] });
        expect(r).toMatchObject({ ok: false });
      }
      expect(await prisma.sequenceEnrollment.count({ where: { leadId: L1 } })).toBe(0);
    });

    it("an Admin can enroll any lead in their company into any sequence in their company, but not another company's lead", async () => {
      as("Admin");
      const r = await enroll({ sequenceId: seqAdmin, kind: "leads", ids: [L1, L3, L4] });
      expect(r).toMatchObject({ ok: true, enrolled: 2 });
      if (!r.ok) return;
      expect(r.failed.map((f) => f.id)).toEqual([L4]);
      expect(await enrollmentCount(seqAdmin, [L4])).toBe(0);
      const viaAgentSeq = await enroll({ sequenceId: seqAgent, kind: "leads", ids: [L3] }); // Admin may use another user's sequence
      expect(viaAgentSeq).toMatchObject({ ok: true, enrolled: 1 });
    });

    it("a Manager can enroll their team's leads but not another team's", async () => {
      as("Mgr");
      const r = await enroll({ sequenceId: seqAdmin, kind: "leads", ids: [LT, L3] });
      expect(r).toMatchObject({ ok: true, enrolled: 1 });
      if (!r.ok) return;
      expect(r.failed.map((f) => f.id)).toEqual([L3]);
    });

    it.each(["Ticketer", "Marketer", null])("%s is refused on the server, whatever the UI shows, and nothing is enrolled", async (who) => {
      as(who);
      for (const kind of ["leads", "contacts"] as const) {
        const r = await enroll({ sequenceId: seqAgent, kind, ids: [kind === "leads" ? L1 : C1] });
        expect(r).toEqual({ ok: false, error: "You are not authorized to enroll these records in a sequence." });
      }
      expect(await enrollmentCount(seqAgent)).toBe(0);
    });

    it("the selection itself is validated: none, too many, wrong types, an unknown kind", async () => {
      as("AgentOwn");
      const tooMany = Array.from({ length: 101 }, (_, i) => `x${i}`);
      for (const bad of [[], tooMany, "L1", null, [1, 2], [""]] as unknown[]) {
        expect(await enroll({ sequenceId: seqAgent, kind: "leads", ids: bad as string[] })).toMatchObject({ ok: false });
      }
      expect(await enroll({ sequenceId: seqAgent, kind: "quotes" as never, ids: [L1] })).toMatchObject({ ok: false });
      expect(await enroll({ sequenceId: "", kind: "leads", ids: [L1] })).toMatchObject({ ok: false });
      expect(await enrollmentCount(seqAgent)).toBe(0);
    });

    it("exactly 100 ids is accepted", async () => {
      as("AgentOwn");
      const r = await enroll({ sequenceId: seqAgent, kind: "leads", ids: [L1, ...Array.from({ length: 99 }, (_, i) => `missing-${i}`)] });
      expect(r).toMatchObject({ ok: true, requested: 100, enrolled: 1 });
    });
  });

  describe("bulkEnrollInSequence - contacts", () => {
    it("enrolls each contact through its most recent lead, enrolls a contact with no lead AS A CONTACT (no lead needed or created), and hides one it cannot see", async () => {
      as("AgentOwn");
      const r = await enroll({ sequenceId: seqAgent, kind: "contacts", ids: [C1, C5, C6, C3] });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r).toMatchObject({ requested: 4, enrolled: 3, alreadyEnrolled: 0 });
      expect(r.settledIds.sort()).toEqual([C1, C5, C6].sort());
      expect(await enrollmentCount(seqAgent, [L1])).toBe(1);
      expect(await enrollmentCount(seqAgent, [LyNew])).toBe(1); // the newer of Fay's two leads
      expect(await enrollmentCount(seqAgent, [LxOld])).toBe(0);
      // Eli has no lead: a contact-only enrollment was made (and still no lead exists), and nothing says "lead" as a reason.
      const contactOnly = await prisma.sequenceEnrollment.findMany({ where: { sequenceId: seqAgent, contactId: C5 }, select: { leadId: true, status: true } });
      expect(contactOnly).toEqual([{ leadId: null, status: "ACTIVE" }]);
      expect(await prisma.lead.count({ where: { contactId: C5 } })).toBe(0);
      expect(r.failed.find((f) => f.id === C5)).toBeUndefined();
      const hidden = r.failed.find((f) => f.id === C3)!;
      expect(hidden.label).toBeNull();
    });

    it("a contact whose lead is already actively enrolled is reported as already enrolled", async () => {
      as("AgentOwn");
      await enroll({ sequenceId: seqAgent, kind: "leads", ids: [L1] });
      const r = await enroll({ sequenceId: seqAgent, kind: "contacts", ids: [C1] });
      expect(r).toMatchObject({ ok: true, enrolled: 0, alreadyEnrolled: 1, failed: [] });
      expect(await enrollmentCount(seqAgent, [L1])).toBe(1);
    });

    it("an agent never enrolls through a lead assigned to someone else: the contact they own is enrolled as a contact instead, and the other agent's lead is untouched", async () => {
      as("AgentOwn");
      // AgentOwn owns this contact but its only lead belongs to AgentOther
      const c = await makeContact("Hal", "AgentOwn");
      const lead = await makeLead(c.id, "AgentOther");
      const r = await enroll({ sequenceId: seqAgent, kind: "contacts", ids: [c.id] });
      expect(r).toMatchObject({ ok: true, enrolled: 1 });
      expect(await enrollmentCount(seqAgent, [lead.id])).toBe(0); // never through someone else's lead
      expect(await prisma.sequenceEnrollment.count({ where: { sequenceId: seqAgent, contactId: c.id, leadId: null } })).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------
  describe("bulkDeleteRecords", () => {
    it.each(["Mgr", "AgentOwn", "TeamAgent", "Ticketer", "Marketer", null])("%s is refused on the server (not only hidden in the UI): nothing is deleted and an audit entry records the attempt", async (who) => {
      as(who);
      const before = await prisma.auditLog.count({ where: { action: "BULK_DELETE_DENIED" } });
      for (const kind of ["leads", "contacts"] as const) {
        const r = await del({ kind, ids: [kind === "leads" ? L1 : C1] });
        expect(r).toEqual({ ok: false, error: "Only an Administrator can delete several records at once." });
      }
      expect(await prisma.lead.count({ where: { id: L1 } })).toBe(1);
      expect(await prisma.contact.count({ where: { id: C1 } })).toBe(1);
      if (who) expect(await prisma.auditLog.count({ where: { action: "BULK_DELETE_DENIED" } })).toBe(before + 2); // one per refused request
    });

    it("an Admin deletes the selected leads through the existing deletion: the contacts and other leads stay, enrollments go with their lead, and both per-record and summary audit entries exist", async () => {
      as("AgentOwn");
      await enroll({ sequenceId: seqAgent, kind: "leads", ids: [L1] });
      as("Admin");
      const r = await del({ kind: "leads", ids: [L1, LxOld] });
      expect(r).toMatchObject({ ok: true, requested: 2, deleted: 2, failed: [] });
      expect(await prisma.lead.count({ where: { id: { in: [L1, LxOld] } } })).toBe(0);
      expect(await prisma.lead.count({ where: { id: LyNew } })).toBe(1); // the contact's other lead is untouched
      expect(await prisma.contact.count({ where: { id: { in: [C1, C6] } } })).toBe(2); // contacts are untouched
      expect(await prisma.sequenceEnrollment.count({ where: { leadId: L1 } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { action: "LEAD_DELETED", entityId: { in: [L1, LxOld] } } })).toBe(2);
      const summary = (await audit("LEADS_BULK_DELETED"))[0];
      expect(summary.actorId).toBe(actors.Admin.id);
      expect(summary.metadata).toMatchObject({ requested: 2, deleted: 2, failed: 0 });
    });

    it("an Admin deletes the selected contacts: their leads go with them (the existing cascade) and each is audited", async () => {
      as("Admin");
      const r = await del({ kind: "contacts", ids: [C5, C6] });
      expect(r).toMatchObject({ ok: true, requested: 2, deleted: 2, failed: [] });
      expect(await prisma.contact.count({ where: { id: { in: [C5, C6] } } })).toBe(0);
      expect(await prisma.lead.count({ where: { id: { in: [LxOld, LyNew] } } })).toBe(0);
      expect(await prisma.lead.count({ where: { id: L1 } })).toBe(1);
      const entry = await prisma.auditLog.findFirst({ where: { action: "CONTACT_DELETED", entityId: C6 } });
      expect(entry?.metadata).toMatchObject({ cascadedLeadCount: 2 });
    });

    it("partial success: another company's record, an unknown id and an already-deleted record are reported and untouched; the valid ones are deleted", async () => {
      as("Admin");
      await prisma.lead.delete({ where: { id: L2 } }); // deleted by someone else after the selection was made
      const r = await del({ kind: "leads", ids: [L1, L2, L4, "ghost"] });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r).toMatchObject({ requested: 4, deleted: 1 });
      expect(r.deletedIds).toEqual([L1]);
      expect(r.failed.map((f) => f.id).sort()).toEqual([L2, L4, "ghost"].sort());
      expect(r.failed.every((f) => f.label === null)).toBe(true);
      expect(await prisma.lead.count({ where: { id: L4 } })).toBe(1); // company isolation
    });

    it("an Admin of another company cannot delete this company's records", async () => {
      as("OutsiderAdmin");
      const r = await del({ kind: "leads", ids: [L1, L3] });
      expect(r).toMatchObject({ ok: true, deleted: 0 });
      expect(await prisma.lead.count({ where: { id: { in: [L1, L3] } } })).toBe(2);
    });

    it("the selection is validated and capped at 100 server-side; nothing is deleted on a bad request", async () => {
      as("Admin");
      const tooMany = Array.from({ length: 101 }, (_, i) => `x${i}`);
      for (const bad of [[], tooMany, "L1", null, [""]] as unknown[]) expect(await del({ kind: "leads", ids: bad as string[] })).toMatchObject({ ok: false });
      expect(await del({ kind: "quotes" as never, ids: [L1] })).toMatchObject({ ok: false });
      expect(await prisma.lead.count({ where: { id: L1 } })).toBe(1);
    });
  });
});
