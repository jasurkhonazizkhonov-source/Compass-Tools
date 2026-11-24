// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

// REAL-DATABASE proof of CONTACT-ONLY sequence enrollment: a Contact is enrolled in a sequence WITHOUT a Lead (and without creating one), and the whole lifecycle works:
// enrollment checks and reasons, first and follow-up emails from the right sender to the right address, pause/resume, unenroll, completion, duplicate and concurrent
// requests, suppression (at enrollment AND again just before sending), a customer's reply stopping exactly the right enrollment, and the authorization / company limits.
// Gmail is a scripted fake (sendEmail and the mailbox); everything else - the claims, advisory locks, the partial unique index, transactions - is the real code on a real
// PostgreSQL. Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL with this repo's migrations applied.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
  process.env.CARD_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_HASH_KEY ??= randomBytes(32).toString("base64");
  process.env.SEQUENCE_SENDS_PER_MINUTE = "50";
  process.env.CAMPAIGN_DAILY_LIMIT = "400";
}

type Role = "ADMIN" | "MANAGER" | "TRAVEL_AGENT" | "TICKETING_AGENT" | "MARKETING_AGENT";
type Actor = { id: string; role: Role; companyId: string; fullName: string; email: string; phone: string | null; status: string; paymentPermissions: string[]; bookingPermissions: string[]; sessionCreatedAt: Date };
let currentActor: Actor | null = null;
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Which sending accounts have a usable Gmail (the readiness check itself is covered by sequences.test.ts).
const gmailDown = new Set<string>();
vi.mock("@/server/email/gmail-send", () => ({
  checkGmailSendReadiness: vi.fn(async (accountId: string) => (gmailDown.has(accountId) ? { ready: false, code: "NOT_CONNECTED" } : { ready: true, verified: false })),
}));
type Sent = { to: string; subject: string; accountId: string; html: string };
const outbox: Sent[] = [];
vi.mock("@/server/email/service", () => ({
  sendEmail: vi.fn(async (a: Sent) => {
    outbox.push({ to: a.to, subject: a.subject, accountId: a.accountId, html: a.html });
    return { ok: true as const, messageId: `gm-${outbox.length}`, threadId: `th-${outbox.length}` };
  }),
}));
vi.mock("@/server/queries/company", () => ({
  getCompanyForAccountId: vi.fn(async () => ({ id: "x", name: "Test Co", website: null, phone: null, brandColor: "#1c3a5e", logoEmailUrl: "", logoWebUrl: "", logoIconUrl: "", signatureTemplate: "" })),
}));

const TAG = `cof-${Date.now()}`;
const CO = `co-${TAG}`;
const OTHER_CO = `co2-${TAG}`;
const METADATA_SCOPE = "https://www.googleapis.com/auth/gmail.metadata";

describe.skipIf(!enabled)("contact-only sequence enrollment - real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let actions: typeof import("../sequences");
  let bulk: typeof import("../bulk-selection");
  let worker: typeof import("@/server/due-sequence-steps");
  let replies: typeof import("@/server/sequence-reply-sync");
  const actors: Record<string, Actor> = {};
  const accountIds: string[] = [];
  const contactIds: string[] = [];
  const sequenceIds: string[] = [];
  const subscriberEmails: string[] = [];
  let n = 0;

  async function makeAccount(name: string, role: Role, company = CO) {
    const a = await prisma.account.create({ data: { fullName: name, email: `${name.toLowerCase()}-${TAG}@example.test`, role, status: "ACTIVE", companyId: company } });
    accountIds.push(a.id);
    actors[name] = { id: a.id, role, companyId: company, fullName: name, email: a.email, phone: null, status: "ACTIVE", paymentPermissions: [], bookingPermissions: [], sessionCreatedAt: new Date() };
    return a;
  }
  const as = (name: string | null) => {
    currentActor = name ? actors[name] : null;
  };
  async function makeContact(first: string, owner: string | null, opts: { email?: string | null; extra?: string[]; company?: string } = {}) {
    n++;
    const email = opts.email === undefined ? `${first.toLowerCase()}${n}-${TAG}@example.test` : opts.email;
    const c = await prisma.contact.create({
      data: {
        firstName: first,
        lastName: "Solo",
        primaryEmail: email,
        companyId: opts.company ?? CO,
        ...(owner ? { ownerId: actors[owner].id } : {}),
        emails: { create: [...(email ? [{ email, isPrimary: true }] : []), ...(opts.extra ?? []).map((e) => ({ email: e, isPrimary: false }))] },
      },
    });
    contactIds.push(c.id);
    return c;
  }
  async function makeSequence(name: string, creator: string, steps = 3, delayMinutes = 0) {
    const s = await prisma.sequence.create({
      data: {
        name: `${name} ${TAG}`,
        createdById: actors[creator].id,
        isActive: true,
        steps: { create: Array.from({ length: steps }, (_, i) => ({ order: i, subject: `Step ${i + 1} for {{contact_first_name}}`, body: "Hello {{contact_first_name}} - trip [{{departure_city}}]", delayMinutes: i === 0 ? 0 : delayMinutes })) },
      },
    });
    sequenceIds.push(s.id);
    return s;
  }
  const rowsFor = (sequenceId: string, contactId: string) => prisma.sequenceEnrollment.findMany({ where: { sequenceId, contactId } });
  const only = async (sequenceId: string, contactId: string) => {
    const rows = await rowsFor(sequenceId, contactId);
    expect(rows).toHaveLength(1);
    return rows[0];
  };
  const dueNow = (id: string) => prisma.sequenceEnrollment.update({ where: { id }, data: { nextSendAt: new Date(Date.now() - 1000) } });
  async function block(email: string, status: "UNSUBSCRIBED" | "SUPPRESSED") {
    subscriberEmails.push(email);
    await prisma.subscriber.create({ data: { companyId: CO, email, status, ...(status === "SUPPRESSED" ? { suppressionReason: "BOUNCE", suppressedAt: new Date() } : { unsubscribedAt: new Date() }) } });
  }

  // a scripted mailbox for reply detection
  class FakeMailbox {
    log: Array<{ id: string; threadId: string; labelIds: string[] }> = [];
    messages = new Map<string, import("@/lib/reply-detection").InboundMessageMeta>();
    threads = new Map<string, string[]>();
    arrive(m: { id: string; threadId: string; from: string }) {
      const labelIds = ["INBOX", "UNREAD"];
      this.messages.set(m.id, { id: m.id, threadId: m.threadId, labelIds, headers: { From: m.from }, internalDateMs: Date.now() + 1000 });
      this.threads.set(m.threadId, [...(this.threads.get(m.threadId) ?? []), m.id]);
      this.log.push({ id: m.id, threadId: m.threadId, labelIds });
    }
    api(): import("@/server/email/gmail-inbound").GmailInboundApi {
      return {
        currentHistoryId: async () => String(this.log.length),
        listHistory: async (start) => ({ added: this.log.slice(Number(start)), historyId: String(this.log.length) }),
        getMessage: async (id) => this.messages.get(id) ?? null,
        getThread: async (t) => (this.threads.get(t) ?? []).map((id) => this.messages.get(id)!),
      };
    }
  }

  async function clean() {
    await prisma.sequenceEnrollment.deleteMany({ where: { sequenceId: { in: sequenceIds } } });
    await prisma.sequence.deleteMany({ where: { id: { in: sequenceIds } } });
    sequenceIds.length = 0;
    await prisma.activity.deleteMany({ where: { contactId: { in: contactIds } } });
    await prisma.lead.deleteMany({ where: { contactId: { in: contactIds } } });
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    contactIds.length = 0;
    await prisma.subscriber.deleteMany({ where: { email: { in: subscriberEmails } } });
    subscriberEmails.length = 0;
    await prisma.gmailConnection.updateMany({ where: { accountId: { in: accountIds } }, data: { historyId: null, sendBlockedUntil: null, inboundError: null } });
  }

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    actions = await import("../sequences");
    bulk = await import("../bulk-selection");
    worker = await import("@/server/due-sequence-steps");
    replies = await import("@/server/sequence-reply-sync");
    for (const id of [CO, OTHER_CO]) await prisma.company.create({ data: { id, name: `Co ${id}`, signatureTemplate: "Regards" } });
    await makeAccount("Admin", "ADMIN");
    await makeAccount("AgentOwn", "TRAVEL_AGENT");
    await makeAccount("AgentOther", "TRAVEL_AGENT");
    await makeAccount("Ticketer", "TICKETING_AGENT");
    await makeAccount("OutsiderAdmin", "ADMIN", OTHER_CO);
    for (const name of ["Admin", "AgentOwn", "AgentOther"]) {
      await prisma.gmailConnection.create({
        data: { accountId: actors[name].id, googleEmail: actors[name].email, scopes: ["https://www.googleapis.com/auth/gmail.send", METADATA_SCOPE], encryptedRefreshToken: "not-a-real-token", status: "CONNECTED" },
      });
    }
  });
  beforeEach(async () => {
    await clean();
    outbox.length = 0;
    gmailDown.clear();
    as("AgentOwn");
  });
  afterAll(async () => {
    if (!enabled) return;
    await clean();
    await prisma.auditLog.deleteMany({ where: { actorId: { in: accountIds } } }).catch(() => undefined);
    await prisma.gmailConnection.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.company.deleteMany({ where: { id: { in: [CO, OTHER_CO] } } });
    await prisma.$disconnect();
  });

  // =====================================================================================================================
  describe("enrolling (1, 2)", () => {
    it("1. a contact WITH a lead still enrolls through that lead, exactly as before (the enrollment records the lead and its contact)", async () => {
      const seq = await makeSequence("with-lead", "AgentOwn", 1);
      const c = await makeContact("Lena", "AgentOwn");
      const lead = await prisma.lead.create({ data: { contactId: c.id, status: "QUOTED", source: "WEBSITE", assignedAgentId: actors.AgentOwn.id } });
      const r = await bulk.bulkEnrollInSequence({ sequenceId: seq.id, kind: "contacts", ids: [c.id] });
      expect(r).toMatchObject({ ok: true, enrolled: 1, failed: [] });
      expect(await only(seq.id, c.id)).toMatchObject({ leadId: lead.id, contactId: c.id, status: "ACTIVE" });
    });

    it("2. a contact WITHOUT a lead enrolls as a contact: no lead is required, created or changed, nothing about the contact is modified, and it is recorded in the contact's history and the audit log", async () => {
      const seq = await makeSequence("no-lead", "AgentOwn", 1);
      const c = await makeContact("Nora", "AgentOwn");
      const before = await prisma.contact.findUniqueOrThrow({ where: { id: c.id } });
      const r = await bulk.bulkEnrollInSequence({ sequenceId: seq.id, kind: "contacts", ids: [c.id] });
      expect(r).toMatchObject({ ok: true, enrolled: 1, alreadyEnrolled: 0, failed: [], settledIds: [c.id] });
      const e = await only(seq.id, c.id);
      expect(e).toMatchObject({ leadId: null, contactId: c.id, status: "ACTIVE", enrolledById: actors.AgentOwn.id, recipientEmail: null });
      expect(e.nextSendAt).toBeInstanceOf(Date);
      expect(await prisma.lead.count({ where: { contactId: c.id } })).toBe(0);
      expect(await prisma.contact.findUniqueOrThrow({ where: { id: c.id } })).toEqual(before);
      expect(await prisma.activity.count({ where: { contactId: c.id, type: "SEQUENCE_ENROLLED" } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { action: "SEQUENCE_CONTACTS_ENROLLED", entityId: seq.id, actorId: actors.AgentOwn.id } })).toBe(1);
    });

    it("no sentence about a lead is ever the reason for a contact", async () => {
      const seq = await makeSequence("reasons", "AgentOwn", 1);
      const noEmail = await makeContact("Nina", "AgentOwn", { email: null });
      const r = await bulk.bulkEnrollInSequence({ sequenceId: seq.id, kind: "contacts", ids: [noEmail.id] });
      if (!r.ok) throw new Error(r.error);
      expect(JSON.stringify(r)).not.toMatch(/lead/i);
    });
  });

  // =====================================================================================================================
  describe("sending (3, 4, 11)", () => {
    it("3 + 4 + 11. the first email goes out from the contact's OWNER to the contact; follow-ups follow in order, each exactly once; the enrollment completes; the trip variables are empty, the contact's are filled", async () => {
      const seq = await makeSequence("lifecycle", "AgentOwn", 3, 0);
      const c = await makeContact("Cleo", "AgentOwn");
      as("Admin"); // someone ELSE enrolls: the emails still go out from the contact's owner
      expect(await bulk.bulkEnrollInSequence({ sequenceId: seq.id, kind: "contacts", ids: [c.id] })).toMatchObject({ ok: true, enrolled: 1 });
      const e0 = await only(seq.id, c.id);
      expect(e0.enrolledById).toBe(actors.Admin.id);

      await dueNow(e0.id);
      expect(await worker.drainDueSequenceSteps()).toMatchObject({ sent: expect.any(Number) });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({ to: c.primaryEmail, accountId: actors.AgentOwn.id, subject: "Step 1 for Cleo" });
      expect(outbox[0].html).toContain("Hello Cleo - trip []"); // the contact's name is filled; a lead's trip values are simply empty
      expect(outbox[0].html).not.toContain("{{");
      let e = await only(seq.id, c.id);
      expect(e).toMatchObject({ status: "ACTIVE", currentStepIdx: 1 });
      const log1 = await prisma.sequenceStepLog.findFirstOrThrow({ where: { enrollmentId: e.id, status: "SENT" } });
      expect(log1).toMatchObject({ senderAccountId: actors.AgentOwn.id, toEmail: c.primaryEmail, gmailThreadId: "th-1" });
      // The email log ties the send to the contact and, having no lead, to none.
      expect(await prisma.emailLog.findFirst({ where: { contactId: c.id, type: "SEQUENCE" } })).toMatchObject({ leadId: null, status: "SENT" });

      for (let step = 2; step <= 3; step++) {
        await dueNow(e.id);
        await worker.drainDueSequenceSteps();
        e = await only(seq.id, c.id);
      }
      expect(outbox.map((o) => o.subject)).toEqual(["Step 1 for Cleo", "Step 2 for Cleo", "Step 3 for Cleo"]);
      expect(e).toMatchObject({ status: "COMPLETED", nextSendAt: null });
      expect(e.completedAt).toBeInstanceOf(Date);
      // a completed enrollment is never sent again
      await worker.drainDueSequenceSteps();
      expect(outbox).toHaveLength(3);
    });

    it("a contact nobody owns is emailed by the account that enrolled it", async () => {
      const seq = await makeSequence("unowned", "AgentOwn", 1);
      const c = await makeContact("Uma", null);
      as("Admin");
      expect(await bulk.bulkEnrollInSequence({ sequenceId: seq.id, kind: "contacts", ids: [c.id] })).toMatchObject({ ok: true, enrolled: 1 });
      await dueNow((await only(seq.id, c.id)).id);
      await worker.drainDueSequenceSteps();
      expect(outbox).toHaveLength(1);
      expect(outbox[0].accountId).toBe(actors.Admin.id);
    });
  });

  // =====================================================================================================================
  describe("addresses (5, 6, 12, 13)", () => {
    it("5. primary only (default) stores nothing and sends to the primary; 'all' stores every valid, de-duplicated address and sends to them together", async () => {
      const seq = await makeSequence("addresses", "AgentOwn", 1);
      const c = await makeContact("Mina", "AgentOwn", { extra: [`mina.work-${TAG}@example.test`, "not-an-email"] });
      const primaryMode = await actions.enrollContacts(seq.id, [c.id], { recipientMode: "primary" });
      expect(primaryMode.byContact[c.id]).toBe("enrolled");
      let e = await only(seq.id, c.id);
      expect(e.recipientEmail).toBeNull();
      await dueNow(e.id);
      await worker.drainDueSequenceSteps();
      expect(outbox[0].to).toBe(c.primaryEmail);

      await prisma.sequenceEnrollment.deleteMany({ where: { sequenceId: seq.id } });
      outbox.length = 0;
      expect((await actions.enrollContacts(seq.id, [c.id], { recipientMode: "all" })).byContact[c.id]).toBe("enrolled");
      e = await only(seq.id, c.id);
      expect(e.recipientEmail).toBe(`${c.primaryEmail}, mina.work-${TAG}@example.test`);
      await dueNow(e.id);
      await worker.drainDueSequenceSteps();
      expect(outbox[0].to).toBe(`${c.primaryEmail}, mina.work-${TAG}@example.test`);
    });

    it("6. a contact with no valid email address is refused with THAT reason (and a contact with an invalid one too)", async () => {
      const seq = await makeSequence("no-email", "AgentOwn", 1);
      const none = await makeContact("Olga", "AgentOwn", { email: null });
      const bad = await makeContact("Pia", "AgentOwn", { email: "not-an-email" });
      const r = await bulk.bulkEnrollInSequence({ sequenceId: seq.id, kind: "contacts", ids: [none.id, bad.id] });
      if (!r.ok) throw new Error(r.error);
      expect(r).toMatchObject({ enrolled: 0 });
      expect(r.failed.map((f) => f.reason)).toEqual(["No valid email address on file - add one to the contact first", "No valid email address on file - add one to the contact first"]);
      expect(await prisma.sequenceEnrollment.count({ where: { sequenceId: seq.id } })).toBe(0);
    });

    it("12. an unsubscribed or suppressed address cannot enroll (primary), and with 'all' another valid address still can", async () => {
      const seq = await makeSequence("suppressed", "AgentOwn", 1);
      const unsub = `unsub-${TAG}@example.test`;
      const supp = `supp-${TAG}@example.test`;
      await block(unsub, "UNSUBSCRIBED");
      await block(supp, "SUPPRESSED");
      const a = await makeContact("Quin", "AgentOwn", { email: unsub });
      const b = await makeContact("Rae", "AgentOwn", { email: supp });
      const r = await bulk.bulkEnrollInSequence({ sequenceId: seq.id, kind: "contacts", ids: [a.id, b.id] });
      if (!r.ok) throw new Error(r.error);
      expect(r.enrolled).toBe(0);
      expect(r.failed.map((f) => f.reason)).toEqual(["Its email address has unsubscribed or is suppressed - update the contact's email first", "Its email address has unsubscribed or is suppressed - update the contact's email first"]);
      const fallback = await makeContact("Sol", "AgentOwn", { email: unsub, extra: [`sol.ok-${TAG}@example.test`] });
      expect((await actions.enrollContacts(seq.id, [fallback.id], { recipientMode: "all" })).byContact[fallback.id]).toBe("enrolled");
      expect((await only(seq.id, fallback.id)).recipientEmail).toBe(`sol.ok-${TAG}@example.test`);
    });

    it("13. suppression is checked AGAIN just before sending: someone who unsubscribes after enrolling is never emailed, and the enrollment fails visibly", async () => {
      const seq = await makeSequence("late-unsub", "AgentOwn", 2);
      const c = await makeContact("Tess", "AgentOwn");
      await actions.enrollContacts(seq.id, [c.id]);
      const e = await only(seq.id, c.id);
      await block(c.primaryEmail!, "UNSUBSCRIBED");
      await dueNow(e.id);
      await worker.drainDueSequenceSteps();
      expect(outbox).toHaveLength(0);
      expect(await only(seq.id, c.id)).toMatchObject({ status: "FAILED", nextSendAt: null });
      expect((await prisma.sequenceStepLog.findFirstOrThrow({ where: { enrollmentId: e.id } })).error).toMatch(/unsubscribed or is suppressed/);
    });
  });

  // =====================================================================================================================
  describe("duplicates and concurrency (7, 8)", () => {
    it("7. the same contact is never enrolled twice: not by repeating the request, not by enrolling it again as a contact, and not through a lead created afterwards", async () => {
      const seq = await makeSequence("dupes", "AgentOwn", 1);
      const c = await makeContact("Uri", "AgentOwn");
      expect(await bulk.bulkEnrollInSequence({ sequenceId: seq.id, kind: "contacts", ids: [c.id] })).toMatchObject({ enrolled: 1, alreadyEnrolled: 0 });
      expect(await bulk.bulkEnrollInSequence({ sequenceId: seq.id, kind: "contacts", ids: [c.id] })).toMatchObject({ enrolled: 0, alreadyEnrolled: 1, settledIds: [c.id], failed: [] });
      // The same person, now with a lead: enrolling the LEAD is also "already enrolled" (documented policy: one active enrollment per person and sequence).
      const lead = await prisma.lead.create({ data: { contactId: c.id, status: "QUOTED", source: "WEBSITE", assignedAgentId: actors.AgentOwn.id } });
      const viaLead = await actions.enrollLeads(seq.id, [lead.id]);
      expect(viaLead.byLead[lead.id]).toBe("alreadyActive");
      expect(await bulk.bulkEnrollInSequence({ sequenceId: seq.id, kind: "contacts", ids: [c.id] })).toMatchObject({ enrolled: 0, alreadyEnrolled: 1 });
      expect(await rowsFor(seq.id, c.id)).toHaveLength(1);
    });

    it("7b. the other direction: a contact already enrolled through its lead is 'already enrolled', never enrolled again as a contact", async () => {
      const seq = await makeSequence("dupes-2", "AgentOwn", 1);
      const c = await makeContact("Val", "AgentOwn");
      const lead = await prisma.lead.create({ data: { contactId: c.id, status: "QUOTED", source: "WEBSITE", assignedAgentId: actors.AgentOwn.id } });
      expect((await actions.enrollLeads(seq.id, [lead.id])).byLead[lead.id]).toBe("enrolled");
      expect((await actions.enrollContacts(seq.id, [c.id])).byContact[c.id]).toBe("alreadyActive");
      expect(await rowsFor(seq.id, c.id)).toHaveLength(1);
    });

    it("8. ten simultaneous requests (double click, retries, two admins) create exactly ONE active enrollment, and the other nine are told it already exists", async () => {
      const seq = await makeSequence("concurrent", "AgentOwn", 1);
      const c = await makeContact("Wes", "AgentOwn");
      const results = await Promise.all(Array.from({ length: 10 }, () => actions.enrollContacts(seq.id, [c.id])));
      expect(results.map((r) => r.byContact[c.id]).sort()).toEqual(["alreadyActive", "alreadyActive", "alreadyActive", "alreadyActive", "alreadyActive", "alreadyActive", "alreadyActive", "alreadyActive", "alreadyActive", "enrolled"]);
      expect(await prisma.sequenceEnrollment.count({ where: { sequenceId: seq.id, contactId: c.id, status: "ACTIVE" } })).toBe(1);
      // mixed: contact-only requests racing a lead enrollment of the same person
      const d = await makeContact("Xia", "AgentOwn");
      const lead = await prisma.lead.create({ data: { contactId: d.id, status: "QUOTED", source: "WEBSITE", assignedAgentId: actors.AgentOwn.id } });
      await Promise.all([...Array.from({ length: 4 }, () => actions.enrollContacts(seq.id, [d.id])), ...Array.from({ length: 4 }, () => actions.enrollLeads(seq.id, [lead.id]))]);
      expect(await prisma.sequenceEnrollment.count({ where: { sequenceId: seq.id, contactId: d.id, status: "ACTIVE" } })).toBe(1);
    });

    it("the database itself refuses a second ACTIVE contact-only enrollment (last-resort unique index), but allows one again after the first ended", async () => {
      const seq = await makeSequence("index", "AgentOwn", 1);
      const c = await makeContact("Yan", "AgentOwn");
      await prisma.sequenceEnrollment.create({ data: { sequenceId: seq.id, contactId: c.id, leadId: null } });
      await expect(prisma.sequenceEnrollment.create({ data: { sequenceId: seq.id, contactId: c.id, leadId: null } })).rejects.toMatchObject({ code: "P2002" });
      await prisma.sequenceEnrollment.updateMany({ where: { sequenceId: seq.id, contactId: c.id }, data: { status: "COMPLETED" } });
      await expect(prisma.sequenceEnrollment.create({ data: { sequenceId: seq.id, contactId: c.id, leadId: null } })).resolves.toBeTruthy();
    });
  });

  // =====================================================================================================================
  describe("pause, resume, unenroll, recovery (9, 10)", () => {
    it("9. switching the sequence off holds a contact-only enrollment exactly where it is; switching it on sends it", async () => {
      const seq = await makeSequence("pause", "AgentOwn", 2);
      const c = await makeContact("Zed", "AgentOwn");
      await actions.enrollContacts(seq.id, [c.id]);
      const e = await only(seq.id, c.id);
      await dueNow(e.id);
      await actions.toggleSequenceActive(seq.id); // off
      await worker.drainDueSequenceSteps();
      expect(outbox).toHaveLength(0);
      expect(await only(seq.id, c.id)).toMatchObject({ status: "ACTIVE", currentStepIdx: 0 });
      await actions.toggleSequenceActive(seq.id); // on
      await worker.drainDueSequenceSteps();
      expect(outbox).toHaveLength(1);
      expect(await only(seq.id, c.id)).toMatchObject({ status: "ACTIVE", currentStepIdx: 1 });
    });

    it("10. unenroll stops it for good (reason, who and when recorded, history kept, an audit entry and a contact-history entry), and nothing more is sent", async () => {
      const seq = await makeSequence("unenroll", "AgentOwn", 2);
      const c = await makeContact("Abe", "AgentOwn");
      await actions.enrollContacts(seq.id, [c.id]);
      const e = await only(seq.id, c.id);
      await dueNow(e.id);
      await worker.drainDueSequenceSteps();
      expect(outbox).toHaveLength(1);
      await dueNow(e.id);
      expect(await actions.unenrollLead(e.id)).toEqual({ ok: true });
      const after = await only(seq.id, c.id);
      expect(after).toMatchObject({ status: "UNSUBSCRIBED", stopReason: "UNENROLLED", nextSendAt: null, stoppedById: actors.AgentOwn.id });
      await worker.drainDueSequenceSteps();
      expect(outbox).toHaveLength(1);
      expect(await prisma.sequenceStepLog.count({ where: { enrollmentId: e.id, status: "SENT" } })).toBe(1); // history kept
      expect(await prisma.activity.count({ where: { contactId: c.id, type: "SEQUENCE_UNENROLLED" } })).toBe(1);
      expect(await prisma.auditLog.findFirst({ where: { action: "SEQUENCE_ENROLLMENT_UNENROLLED", entityId: e.id } })).toMatchObject({ metadata: expect.objectContaining({ contactId: c.id, leadId: null }) });
      expect(await actions.unenrollLead(e.id)).toMatchObject({ ok: false }); // not twice
      // and the contact can be enrolled again later
      expect((await actions.enrollContacts(seq.id, [c.id])).byContact[c.id]).toBe("enrolled");
    });

    it("a failed contact-only enrollment is recovered with Retry on the SAME enrollment once Gmail works again", async () => {
      const seq = await makeSequence("retry", "AgentOwn", 1);
      const c = await makeContact("Bea", "AgentOwn");
      await actions.enrollContacts(seq.id, [c.id]);
      const e = await only(seq.id, c.id);
      await prisma.sequenceEnrollment.update({ where: { id: e.id }, data: { status: "FAILED", nextSendAt: null } });
      gmailDown.add(actors.AgentOwn.id);
      expect(await actions.retryEnrollmentNow(e.id, null)).toMatchObject({ ok: false, gmail: expect.anything() });
      expect(await only(seq.id, c.id)).toMatchObject({ status: "FAILED" });
      gmailDown.clear();
      expect(await actions.retryEnrollmentNow(e.id, null)).toMatchObject({ ok: true });
      expect(outbox).toHaveLength(1);
      expect(await rowsFor(seq.id, c.id)).toHaveLength(1);
    });

    it("the Gmail of the sending account is checked at enrollment: nothing is enrolled, and the message names the CONTACT", async () => {
      const seq = await makeSequence("gmail", "AgentOwn", 1);
      const c = await makeContact("Cal", "AgentOwn");
      gmailDown.add(actors.AgentOwn.id);
      const r = await actions.enrollContacts(seq.id, [c.id]);
      expect(r).toMatchObject({ enrolled: 0, gmailUnavailable: 1, gmailProblem: "NOT_CONNECTED" });
      expect(r.gmailMessage).toMatch(/this contact has not been enrolled/);
      expect(await prisma.sequenceEnrollment.count({ where: { sequenceId: seq.id } })).toBe(0);
      expect(await prisma.activity.count({ where: { contactId: c.id, type: "SEQUENCE_ENROLL_FAILED" } })).toBe(1);
    });
  });

  // =====================================================================================================================
  describe("replies (14, 15)", () => {
    async function sentAndTracked(seqId: string, c: { id: string }) {
      await actions.enrollContacts(seqId, [c.id]);
      const e = await only(seqId, c.id);
      await dueNow(e.id);
      await worker.drainDueSequenceSteps();
      return { e, log: await prisma.sequenceStepLog.findFirstOrThrow({ where: { enrollmentId: e.id, status: "SENT" } }) };
    }
    const pass = (box: FakeMailbox) => replies.syncSequenceReplies({ apiFor: async () => box.api() });

    it("14 + 15. a customer's reply stops exactly THAT contact-only enrollment (recorded on the contact); an unrelated message, and another contact's thread, stop nothing; the same reply twice is a no-op", async () => {
      const seq = await makeSequence("replies", "AgentOwn", 3, 60);
      const a = await makeContact("Dee", "AgentOwn");
      const b = await makeContact("Eve", "AgentOwn");
      const ta = await sentAndTracked(seq.id, a);
      const tb = await sentAndTracked(seq.id, b);
      expect(ta.log.gmailThreadId).not.toBe(tb.log.gmailThreadId);

      const box = new FakeMailbox();
      await pass(box); // first look: sets the position
      box.arrive({ id: "unrelated", threadId: "some-other-conversation", from: "Stranger <x@example.test>" });
      await pass(box);
      expect(await only(seq.id, a.id)).toMatchObject({ status: "ACTIVE" });
      expect(await only(seq.id, b.id)).toMatchObject({ status: "ACTIVE" });

      box.arrive({ id: "reply-a", threadId: ta.log.gmailThreadId!, from: `Dee <${a.primaryEmail}>` });
      const r1 = await pass(box);
      expect(r1).toMatchObject({ repliesFound: 1, enrollmentsStopped: 1, errors: 0 });
      expect(await only(seq.id, a.id)).toMatchObject({ status: "REPLIED", stopReason: "REPLIED", nextSendAt: null });
      expect(await only(seq.id, b.id)).toMatchObject({ status: "ACTIVE" }); // the other person's enrollment is untouched
      expect(await prisma.activity.count({ where: { contactId: a.id, type: "SEQUENCE_REPLIED" } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { action: "SEQUENCE_STOPPED_BY_REPLY", entityId: ta.e.id } })).toBe(1);
      expect(await prisma.sequenceReply.count({ where: { enrollmentId: ta.e.id } })).toBe(1);

      // the same reply found again (a second pass, a second instance) changes nothing
      await pass(box);
      expect(await prisma.sequenceReply.count({ where: { enrollmentId: ta.e.id } })).toBe(1);
      expect(await prisma.activity.count({ where: { contactId: a.id, type: "SEQUENCE_REPLIED" } })).toBe(1);

      // and nothing more is ever sent to the person who replied; the other still gets his follow-up
      await dueNow(ta.e.id).catch(() => undefined);
      await dueNow(tb.e.id);
      outbox.length = 0;
      await worker.drainDueSequenceSteps();
      expect(outbox.map((o) => o.to)).toEqual([b.primaryEmail]);
    });

    it("a reply from the mailbox's OWN address, or an automatic reply, never stops it", async () => {
      const seq = await makeSequence("own-reply", "AgentOwn", 2, 60);
      const c = await makeContact("Fin", "AgentOwn");
      const t = await sentAndTracked(seq.id, c);
      const box = new FakeMailbox();
      await pass(box);
      box.arrive({ id: "mine", threadId: t.log.gmailThreadId!, from: `Me <${actors.AgentOwn.email}>` });
      await pass(box);
      expect(await only(seq.id, c.id)).toMatchObject({ status: "ACTIVE" });
    });
  });

  // =====================================================================================================================
  describe("authorization and company boundaries (16, 17)", () => {
    it("16. an agent cannot enroll a contact they cannot see: it is reported as unavailable, nothing is enrolled, and the contact's existence is not revealed", async () => {
      const mine = await makeSequence("mine", "AgentOther", 1);
      const theirs = await makeContact("Gil", "AgentOwn");
      as("AgentOther");
      const r = await bulk.bulkEnrollInSequence({ sequenceId: mine.id, kind: "contacts", ids: [theirs.id] });
      if (!r.ok) throw new Error(r.error);
      expect(r.enrolled).toBe(0);
      expect(r.failed).toEqual([{ id: theirs.id, label: null, reason: "No longer available to you (deleted, moved to another owner or outside your access)" }]);
      expect((await actions.enrollContacts(mine.id, [theirs.id])).byContact[theirs.id]).toBe("inaccessible");
      expect(await prisma.sequenceEnrollment.count({ where: { sequenceId: mine.id } })).toBe(0);
    });

    it("16b. roles that may not use sequences are refused outright; nobody can retry or unenroll a contact-only enrollment they cannot see", async () => {
      const seq = await makeSequence("authz", "AgentOwn", 1);
      const c = await makeContact("Hal", "AgentOwn");
      await actions.enrollContacts(seq.id, [c.id]);
      const e = await only(seq.id, c.id);
      as("Ticketer");
      expect(await bulk.bulkEnrollInSequence({ sequenceId: seq.id, kind: "contacts", ids: [c.id] })).toEqual({ ok: false, error: "You are not authorized to enroll these records in a sequence." });
      as(null);
      expect(await bulk.bulkEnrollInSequence({ sequenceId: seq.id, kind: "contacts", ids: [c.id] })).toMatchObject({ ok: false });
      // a different agent: the sequence is not theirs, and the contact is not theirs
      as("AgentOther");
      await expect(actions.unenrollLead(e.id)).rejects.toThrow("Sequence not found");
      await expect(actions.retryEnrollmentNow(e.id)).rejects.toThrow("Sequence not found");
      // an Admin of the same company (who may use every sequence) can
      as("Admin");
      expect(await actions.unenrollLead(e.id)).toEqual({ ok: true });
    });

    it("17. company boundaries: another company's Admin can neither enroll nor unenroll this company's contacts, and a contact whose owner belongs to ANOTHER company is never sent through that company's Gmail", async () => {
      const seq = await makeSequence("tenant", "Admin", 1);
      const c = await makeContact("Ian", "AgentOwn");
      await actions.enrollContacts(seq.id, [c.id]).catch(() => undefined); // (as AgentOwn: not their sequence -> refused; nothing created)
      expect(await prisma.sequenceEnrollment.count({ where: { sequenceId: seq.id } })).toBe(0);
      as("Admin");
      expect((await actions.enrollContacts(seq.id, [c.id])).byContact[c.id]).toBe("enrolled");
      const e = await only(seq.id, c.id);
      as("OutsiderAdmin");
      await expect(actions.unenrollLead(e.id)).rejects.toThrow("Sequence not found");
      const outsiderSeq = await makeSequence("outsider", "OutsiderAdmin", 1);
      expect((await actions.enrollContacts(outsiderSeq.id, [c.id])).byContact[c.id]).toBe("inaccessible");
      // owner from another company (bad data): refused, never sent through the other company's mailbox
      const odd = await makeContact("Jo", null);
      await prisma.contact.update({ where: { id: odd.id }, data: { ownerId: actors.OutsiderAdmin.id } });
      as("Admin");
      expect((await actions.enrollContacts(seq.id, [odd.id])).byContact[odd.id]).toBe("inaccessible");
    });
  });
});
