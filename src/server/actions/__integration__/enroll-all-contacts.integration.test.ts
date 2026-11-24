// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

// REAL-DATABASE proof of "Enroll All Contacts" and of which email addresses a sequence uses:
//   * every eligible contact is enrolled exactly once - through its most recent lead - in safe batches, and re-running changes nothing;
//   * contacts that cannot be enrolled are counted by reason (no lead, no / invalid email, unsubscribed or suppressed, no agent) and never half-enrolled;
//   * a batch that fails does not lose what earlier batches enrolled;
//   * "Primary only" stores nothing (the primary is used at send time); "All addresses" stores each valid, de-duplicated, not-blocked address once;
//   * at SEND time an address that has become blocked since is dropped, and when none is left the enrollment fails visibly.
// Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE database (src/test/integration-database-guard.ts).

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
  process.env.CARD_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_HASH_KEY ??= randomBytes(32).toString("base64");
}

let actor: { id: string; role: string; companyId: string; sessionCreatedAt: Date } | null = null;
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => actor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/email/gmail-send", () => ({ checkGmailSendReadiness: vi.fn(async () => ({ ready: true, verified: true })) }));

const TAG = `eac-${Date.now()}`;
const COMPANY = "default-company";

describe.skipIf(!enabled)("Enroll All Contacts and recipient addresses - real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let preview: typeof import("../sequence-enroll-contacts").previewEnrollAllContacts;
  let batch: typeof import("../sequence-enroll-contacts").enrollContactsBatch;
  let enrollLeads: typeof import("../sequences").enrollLeads;
  let resolveSend: typeof import("@/server/sequence-recipients").resolveSendRecipients;
  let adminId: string;
  let agentId: string;
  let seq = 0;
  const sequenceIds: string[] = [];
  const contactIds: string[] = [];
  const accountIds: string[] = [];
  const emails: string[] = [];

  const addr = (n: string) => `${n}-${TAG}@example.test`;
  async function newSequence(steps = 2) {
    const s = await prisma.sequence.create({ data: { name: `Seq-${++seq}-${TAG}`, isActive: true, createdById: adminId } });
    sequenceIds.push(s.id);
    for (let i = 0; i < steps; i++) await prisma.sequenceStep.create({ data: { sequenceId: s.id, order: i, subject: "Hi", body: "Hello", delayMinutes: 0 } });
    return s;
  }
  async function newContact(over: { email?: string | null; agent?: boolean; leads?: number; extra?: string[]; owner?: string } = {}) {
    const n = ++seq;
    const email = over.email === undefined ? addr(`c${n}`) : over.email;
    const c = await prisma.contact.create({
      data: { firstName: "Con", lastName: `T${n}`, primaryEmail: email, companyId: COMPANY, ownerId: over.owner ?? adminId, emails: over.extra ? { create: over.extra.map((e) => ({ email: e })) } : undefined },
    });
    contactIds.push(c.id);
    const leads = [];
    for (let i = 0; i < (over.leads ?? 1); i++) {
      leads.push(await prisma.lead.create({ data: { contactId: c.id, assignedAgentId: over.agent === false ? null : agentId, source: "WEBSITE", status: "ATTEMPTING_TO_CONTACT", createdAt: new Date(Date.now() - (over.leads ?? 1) * 1000 + i * 1000) } }));
    }
    return { contact: c, leads };
  }
  async function block(email: string, status: "UNSUBSCRIBED" | "SUPPRESSED") {
    emails.push(email);
    await prisma.subscriber.create({ data: { companyId: COMPANY, email, status, ...(status === "SUPPRESSED" ? { suppressionReason: "BOUNCE", suppressedAt: new Date() } : { unsubscribedAt: new Date() }) } });
  }
  type Tally = Record<string, number>;
  async function runAll(sequenceId: string, recipientMode: "primary" | "all" = "primary", limit = 100): Promise<Tally> {
    const total: Tally = { processed: 0, enrolled: 0, alreadyEnrolled: 0, noLead: 0, missingEmail: 0, addressSuppressed: 0, noAssignedAgent: 0, gmailUnavailable: 0, inaccessible: 0, failedOther: 0, batches: 0 };
    let cursor: string | null = null;
    for (let i = 0; i < limit; i++) {
      const r = await batch({ sequenceId, recipientMode, cursor });
      if (!r.ok) throw new Error(r.error);
      for (const k of Object.keys(total)) if (k !== "batches") total[k] += (r as unknown as Tally)[k] ?? 0;
      total.batches++;
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    return total;
  }

  async function clean() {
    await prisma.sequenceEnrollment.deleteMany({ where: { sequenceId: { in: sequenceIds } } });
    await prisma.sequence.deleteMany({ where: { id: { in: sequenceIds } } });
    sequenceIds.length = 0;
    await prisma.activity.deleteMany({ where: { lead: { contactId: { in: contactIds } } } });
    await prisma.lead.deleteMany({ where: { contactId: { in: contactIds } } });
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    contactIds.length = 0;
    await prisma.subscriber.deleteMany({ where: { email: { in: emails } } });
    emails.length = 0;
  }

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ previewEnrollAllContacts: preview, enrollContactsBatch: batch } = await import("../sequence-enroll-contacts"));
    ({ enrollLeads } = await import("../sequences"));
    ({ resolveSendRecipients: resolveSend } = await import("@/server/sequence-recipients"));
    await prisma.company.upsert({ where: { id: COMPANY }, update: {}, create: { id: COMPANY, name: "Test Co", signatureTemplate: "Regards" } });
    adminId = (await prisma.account.create({ data: { fullName: "Admin EAC", email: addr("admin"), role: "ADMIN", status: "ACTIVE", companyId: COMPANY } })).id;
    agentId = (await prisma.account.create({ data: { fullName: "Agent EAC", email: addr("agent"), role: "TRAVEL_AGENT", status: "ACTIVE", companyId: COMPANY } })).id;
    accountIds.push(adminId, agentId);
  });
  beforeEach(async () => {
    await clean();
    actor = { id: adminId, role: "ADMIN", companyId: COMPANY, sessionCreatedAt: new Date() };
  });
  afterAll(async () => {
    if (!enabled) return;
    await clean();
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.$disconnect();
  });

  it("enrolls every eligible contact exactly once, through its latest lead, in batches - and says why each of the others was not", async () => {
    const sequence = await newSequence();
    // The Admin sees every contact of the company, including other tests' leftovers, so count only the ones created here.
    const eligible: string[] = [];
    for (let i = 0; i < 230; i++) eligible.push((await newContact()).contact.id);
    for (let i = 0; i < 4; i++) await newContact({ leads: 0 });
    for (let i = 0; i < 3; i++) await newContact({ email: null });
    for (let i = 0; i < 3; i++) await newContact({ email: "not-an-email" });
    const unsub = addr("unsub");
    await newContact({ email: unsub });
    await block(unsub, "UNSUBSCRIBED");
    const supp = addr("supp");
    await newContact({ email: supp });
    await block(supp, "SUPPRESSED");
    for (let i = 0; i < 2; i++) await newContact({ agent: false });
    const preEnrolled = await newContact();
    await enrollLeads(sequence.id, [preEnrolled.leads[0].id]);
    const twoLeads = await newContact({ leads: 2 });

    const before = await prisma.sequenceEnrollment.count({ where: { sequenceId: sequence.id } });
    const p = await preview({ sequenceId: sequence.id });
    expect(p).toMatchObject({ ok: true });
    if (p.ok) expect(p.alreadyEnrolled).toBeGreaterThanOrEqual(1);

    const t = await runAll(sequence.id);
    expect(t.batches).toBeGreaterThanOrEqual(3); // 100 contacts at a time
    expect(t.noLead).toBeGreaterThanOrEqual(4);
    expect(t.missingEmail).toBeGreaterThanOrEqual(6); // no address, and an address that is not one
    expect(t.addressSuppressed).toBeGreaterThanOrEqual(2);
    expect(t.noAssignedAgent).toBeGreaterThanOrEqual(2);
    expect(t.failedOther).toBe(0);

    // Every eligible contact has exactly ONE active enrollment in this sequence.
    const rows = await prisma.sequenceEnrollment.findMany({ where: { sequenceId: sequence.id, status: "ACTIVE" }, select: { leadId: true, recipientEmail: true, lead: { select: { contactId: true } } } });
    const perContact = new Map<string, number>();
    for (const r of rows) perContact.set(r.lead.contactId, (perContact.get(r.lead.contactId) ?? 0) + 1);
    for (const id of eligible) expect(perContact.get(id), id).toBe(1);
    expect([...perContact.values()].every((n) => n === 1)).toBe(true);
    // "Primary only" stores nothing: the primary address is read at send time.
    expect(rows.every((r) => r.recipientEmail === null)).toBe(true);
    // A contact with two leads is enrolled through its MOST RECENT lead only.
    const latest = twoLeads.leads[1].id;
    expect(rows.filter((r) => r.lead.contactId === twoLeads.contact.id).map((r) => r.leadId)).toEqual([latest]);
    expect((await prisma.sequenceEnrollment.count({ where: { sequenceId: sequence.id } })) - before).toBeGreaterThanOrEqual(eligible.length + 1);
    // Nobody was enrolled who must not be.
    expect(await prisma.sequenceEnrollment.count({ where: { sequenceId: sequence.id, lead: { contact: { primaryEmail: { in: [unsub, supp, "not-an-email"] } } } } })).toBe(0);
  });

  it("running it again changes nothing: everyone already enrolled is skipped, nobody gets a second enrollment", async () => {
    const sequence = await newSequence();
    for (let i = 0; i < 25; i++) await newContact();
    await runAll(sequence.id);
    const count = await prisma.sequenceEnrollment.count({ where: { sequenceId: sequence.id } });
    const again = await runAll(sequence.id);
    expect(again.enrolled).toBe(0);
    expect(again.alreadyEnrolled).toBeGreaterThanOrEqual(25);
    expect(await prisma.sequenceEnrollment.count({ where: { sequenceId: sequence.id } })).toBe(count);
  });

  it("a batch that fails is counted as failed and the run carries on; what earlier batches enrolled stays enrolled", async () => {
    const sequence = await newSequence();
    for (let i = 0; i < 230; i++) await newContact(); // three batches of 100
    // Break exactly the SECOND batch: the call that picks each batch's leads is the only lead query with an orderBy.
    const original = prisma.lead.findMany.bind(prisma.lead);
    let picks = 0;
    const spy = vi.spyOn(prisma.lead, "findMany").mockImplementation(((args: { orderBy?: unknown }) => {
      if (args?.orderBy && ++picks === 2) return Promise.reject(new Error("database hiccup")) as never;
      return original(args as never) as never;
    }) as never);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = await runAll(sequence.id);
    spy.mockRestore();
    consoleSpy.mockRestore();
    expect(t.batches).toBeGreaterThanOrEqual(3);
    expect(t.failedOther).toBe(100); // exactly the failed batch, never counted as enrolled
    expect(t.enrolled).toBeGreaterThanOrEqual(130);
    expect(await prisma.sequenceEnrollment.count({ where: { sequenceId: sequence.id, status: "ACTIVE" } })).toBe(t.enrolled);
    // Running it again enrolls exactly the ones the failed batch missed and touches nobody else.
    const retry = await runAll(sequence.id);
    expect(retry.failedOther).toBe(0);
    expect(retry.enrolled).toBe(100);
    expect(await prisma.sequenceEnrollment.count({ where: { sequenceId: sequence.id, status: "ACTIVE" } })).toBe(t.enrolled + 100);
  });

  it("only people who may enroll contacts can run it, and a restricted agent only reaches their own contacts", async () => {
    const sequence = await newSequence();
    const mine = await newContact({ owner: agentId });
    const others = await newContact({ owner: adminId });
    actor = { id: agentId, role: "TRAVEL_AGENT", companyId: COMPANY, sessionCreatedAt: new Date() };
    const own = await prisma.sequence.create({ data: { name: `Agent seq-${TAG}`, isActive: true, createdById: agentId } });
    sequenceIds.push(own.id);
    await prisma.sequenceStep.create({ data: { sequenceId: own.id, order: 0, subject: "Hi", body: "Hello", delayMinutes: 0 } });
    const t = await runAll(own.id);
    expect(t.failedOther).toBe(0);
    const enrolled = await prisma.sequenceEnrollment.findMany({ where: { sequenceId: own.id }, select: { lead: { select: { contactId: true } } } });
    expect(enrolled.map((e) => e.lead.contactId)).toContain(mine.contact.id);
    expect(enrolled.map((e) => e.lead.contactId)).not.toContain(others.contact.id);
    // Someone else's sequence is not even visible to them, and a signed-out caller gets nothing.
    expect(await batch({ sequenceId: sequence.id })).toMatchObject({ ok: false });
    actor = null;
    expect(await batch({ sequenceId: own.id })).toMatchObject({ ok: false });
    expect(await preview({ sequenceId: own.id })).toMatchObject({ ok: false });
  });

  describe("which addresses a sequence uses", () => {
    it("'Primary only' (the default) stores nothing; 'All addresses' stores each valid, de-duplicated, not-blocked address once, primary first", async () => {
      const sequence = await newSequence();
      const primary = addr("main");
      const second = addr("second");
      const blocked = addr("blocked");
      await block(blocked, "UNSUBSCRIBED");
      const a = await newContact({ email: primary, extra: [second.toUpperCase(), primary.toUpperCase(), blocked, "garbage", second] });
      const b = await newContact({ email: addr("solo") });
      const modePrimary = await newSequence();
      await enrollLeads(modePrimary.id, [a.leads[0].id]); // default mode
      expect((await prisma.sequenceEnrollment.findFirstOrThrow({ where: { sequenceId: modePrimary.id } })).recipientEmail).toBeNull();

      await enrollLeads(sequence.id, [a.leads[0].id, b.leads[0].id], undefined, { recipientMode: "all" });
      const rowA = await prisma.sequenceEnrollment.findFirstOrThrow({ where: { sequenceId: sequence.id, leadId: a.leads[0].id } });
      const rowB = await prisma.sequenceEnrollment.findFirstOrThrow({ where: { sequenceId: sequence.id, leadId: b.leads[0].id } });
      expect(rowA.recipientEmail).toBe(`${primary}, ${second}`); // primary first; the duplicate (any case), the invalid one and the unsubscribed one are gone
      expect(rowB.recipientEmail).toBeNull(); // a single address needs no list
    });

    it("an unrecognised mode from the browser is the safe default (primary only)", async () => {
      const sequence = await newSequence();
      const a = await newContact({ extra: [addr("other")] });
      await enrollLeads(sequence.id, [a.leads[0].id], undefined, { recipientMode: "everything" as never });
      expect((await prisma.sequenceEnrollment.findFirstOrThrow({ where: { sequenceId: sequence.id } })).recipientEmail).toBeNull();
    });

    it("a contact whose ONLY address is blocked is refused with that reason; with 'all', another valid address still works", async () => {
      const sequence = await newSequence();
      const only = addr("only");
      await block(only, "SUPPRESSED");
      const a = await newContact({ email: only });
      const r1 = await enrollLeads(sequence.id, [a.leads[0].id]);
      expect(r1).toMatchObject({ enrolled: 0, addressSuppressed: 1 });
      const blockedPrimary = addr("pblocked");
      await block(blockedPrimary, "UNSUBSCRIBED");
      const good = addr("good");
      const b = await newContact({ email: blockedPrimary, extra: [good] });
      expect(await enrollLeads(sequence.id, [b.leads[0].id])).toMatchObject({ enrolled: 0, addressSuppressed: 1 }); // primary only: refused
      const r2 = await enrollLeads(sequence.id, [b.leads[0].id], undefined, { recipientMode: "all" });
      expect(r2).toMatchObject({ enrolled: 1 });
      expect((await prisma.sequenceEnrollment.findFirstOrThrow({ where: { sequenceId: sequence.id, leadId: b.leads[0].id } })).recipientEmail).toBeNull(); // one usable address: the primary is blocked, so the stored list is just the good one
    });

    it("at SEND time an address that has become blocked since enrollment is dropped; when none is left there is nothing to send to", async () => {
      const first = addr("a1");
      const second = addr("a2");
      const contact = { primaryEmail: first, companyId: COMPANY };
      expect(await resolveSend({ recipientEmail: `${first}, ${second}` }, contact)).toEqual({ ok: true, to: `${first}, ${second}` });
      await block(second, "UNSUBSCRIBED");
      expect(await resolveSend({ recipientEmail: `${first}, ${second}` }, contact)).toEqual({ ok: true, to: first });
      await block(first, "SUPPRESSED");
      expect(await resolveSend({ recipientEmail: `${first}, ${second}` }, contact)).toEqual({ ok: false, reason: "addressSuppressed" });
      expect(await resolveSend({ recipientEmail: null }, { primaryEmail: null, companyId: COMPANY })).toEqual({ ok: false, reason: "missingEmail" });
      expect(await resolveSend({ recipientEmail: null }, { primaryEmail: "nonsense", companyId: COMPANY })).toEqual({ ok: false, reason: "missingEmail" });
    });
  });
});
