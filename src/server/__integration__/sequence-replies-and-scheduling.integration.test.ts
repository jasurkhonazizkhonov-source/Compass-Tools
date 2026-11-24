// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

// REAL-DATABASE proof of the two most important sequence rules:
//   1. A customer's reply stops THAT enrollment's remaining emails - reliably, once, whatever runs at the same time.
//   2. A limited sending allowance goes to everyone's FIRST email before anyone's follow-up, sequences take turns, nothing is sent twice, and it resumes by itself.
// Gmail is a fake (a scripted mailbox behind the same GmailInboundApi the real client implements); everything else - the claims, the advisory locks, the transactions,
// the unique reply key - is the real code against a real PostgreSQL. Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE database (src/test/integration-database-guard.ts).

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
  process.env.CARD_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_HASH_KEY ??= randomBytes(32).toString("base64");
  process.env.SEQUENCE_SENDS_PER_MINUTE = "20";
  process.env.CAMPAIGN_DAILY_LIMIT = "400";
}

type Sent = { to: string; subject: string };
const outbox: Sent[] = [];
let sendHook: ((to: string) => Promise<void>) | null = null;
let sendMode: "ok" | "ratelimited" = "ok";
vi.mock("@/server/email/service", () => ({
  sendEmail: vi.fn(async (a: { to: string; subject: string }) => {
    await new Promise((r) => setTimeout(r, 2)); // lets concurrent workers genuinely interleave
    if (sendMode === "ratelimited") return { ok: false as const, code: "SEND_FAILED" as const, error: "Gmail is temporarily unable to send (rate limit reached).", rateLimited: true, retryAfterMs: 30 * 60_000 };
    outbox.push({ to: a.to, subject: a.subject });
    if (sendHook) await sendHook(a.to);
    return { ok: true as const, messageId: `gm-${outbox.length}`, threadId: `th-${outbox.length}` };
  }),
}));
vi.mock("@/server/queries/company", () => ({
  getCompanyForAccountId: vi.fn(async () => ({ id: "default-company", name: "Test Co", website: null, phone: null, brandColor: "#1c3a5e", logoEmailUrl: "", logoWebUrl: "", logoIconUrl: "", signatureTemplate: "" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const TAG = `srs-${Date.now()}`;
const COMPANY = "default-company";
const METADATA_SCOPE = "https://www.googleapis.com/auth/gmail.metadata";

describe.skipIf(!enabled)("sequence replies and scheduling - real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let drain: typeof import("@/server/due-sequence-steps").drainDueSequenceSteps;
  let run: typeof import("@/server/due-sequence-steps").runDueSequenceSteps;
  let sync: typeof import("@/server/sequence-reply-sync").syncSequenceReplies;
  let record: typeof import("@/server/sequence-reply-sync").recordSequenceReply;
  let GmailInboundError: typeof import("@/server/email/gmail-inbound").GmailInboundError;
  let agentId: string;
  let connectionId: string;
  let seq = 0;
  const sequenceIds: string[] = [];
  const leadIds: string[] = [];
  const contactIds: string[] = [];

  // ---- fixtures ----------------------------------------------------------------------------------------------------
  async function newSequence(name: string, stepCount = 3, delayMinutes = 0) {
    const s = await prisma.sequence.create({ data: { name: `${name}-${TAG}`, isActive: true, createdById: agentId } });
    sequenceIds.push(s.id);
    const steps = [];
    for (let i = 0; i < stepCount; i++) steps.push(await prisma.sequenceStep.create({ data: { sequenceId: s.id, order: i, subject: `Step ${i + 1} {{contactFirstName}}`, body: "Hello", delayMinutes: i === 0 ? 0 : delayMinutes } }));
    return { sequence: s, steps };
  }
  async function newEnrollment(sequenceId: string, opts: { stepIdx?: number; due?: boolean; email?: string; status?: "ACTIVE" | "FAILED" | "COMPLETED" } = {}) {
    const n = ++seq;
    const contact = await prisma.contact.create({ data: { firstName: "Cust", lastName: `N${n}`, primaryEmail: opts.email ?? `cust${n}-${TAG}@example.test`, companyId: COMPANY } });
    contactIds.push(contact.id);
    const lead = await prisma.lead.create({ data: { contactId: contact.id, assignedAgentId: agentId, source: "WEBSITE", status: "ATTEMPTING_TO_CONTACT" } });
    leadIds.push(lead.id);
    const due = opts.due !== false;
    const enrollment = await prisma.sequenceEnrollment.create({
      data: { sequenceId, leadId: lead.id, status: opts.status ?? "ACTIVE", currentStepIdx: opts.stepIdx ?? 0, nextSendAt: due ? new Date(Date.now() - 60_000 - n) : new Date(Date.now() + 3_600_000) },
    });
    return { enrollment, lead, contact };
  }
  /** A step that was already sent: the log carries Gmail's ids, exactly as the sender writes them. */
  async function sentStep(enrollmentId: string, stepId: string, thread: string, minutesAgo = 120) {
    const at = new Date(Date.now() - minutesAgo * 60_000);
    return prisma.sequenceStepLog.create({
      data: { enrollmentId, stepId, status: "SENT", sentAt: at, createdAt: at, senderAccountId: agentId, toEmail: "x@example.test", gmailMessageId: `msg-${thread}`, gmailThreadId: thread },
    });
  }

  // ---- a scripted mailbox -------------------------------------------------------------------------------------------
  class FakeMailbox {
    log: Array<{ id: string; threadId: string; labelIds: string[] }> = [];
    messages = new Map<string, import("@/lib/reply-detection").InboundMessageMeta>();
    threads = new Map<string, string[]>();
    expireHistory = false;
    calls = { history: 0, message: 0, thread: 0 };
    arrive(m: { id: string; threadId: string; from: string; labels?: string[]; headers?: Record<string, string>; atMs?: number }) {
      const labelIds = m.labels ?? ["INBOX", "UNREAD"];
      this.messages.set(m.id, { id: m.id, threadId: m.threadId, labelIds, headers: { From: m.from, ...(m.headers ?? {}) }, internalDateMs: m.atMs ?? Date.now() });
      this.threads.set(m.threadId, [...(this.threads.get(m.threadId) ?? []), m.id]);
      this.log.push({ id: m.id, threadId: m.threadId, labelIds });
    }
    api(): import("@/server/email/gmail-inbound").GmailInboundApi {
      return {
        currentHistoryId: async () => String(this.log.length),
        listHistory: async (start) => {
          this.calls.history++;
          if (this.expireHistory) throw new GmailInboundError("HISTORY_EXPIRED");
          return { added: this.log.slice(Number(start)), historyId: String(this.log.length) };
        },
        getMessage: async (id) => (this.calls.message++, this.messages.get(id) ?? null),
        getThread: async (t) => (this.calls.thread++, (this.threads.get(t) ?? []).map((id) => this.messages.get(id)!)),
      };
    }
  }
  const pass = (box: FakeMailbox) => sync({ apiFor: async () => box.api() });

  const statusOf = async (id: string) => (await prisma.sequenceEnrollment.findUniqueOrThrow({ where: { id } })).status;
  const reload = (id: string) => prisma.sequenceEnrollment.findUniqueOrThrow({ where: { id } });

  async function clean() {
    await prisma.sequenceEnrollment.deleteMany({ where: { sequenceId: { in: sequenceIds } } }); // cascades step logs and replies
    await prisma.sequence.deleteMany({ where: { id: { in: sequenceIds } } });
    sequenceIds.length = 0;
    await prisma.activity.deleteMany({ where: { leadId: { in: leadIds } } });
    await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
    leadIds.length = 0;
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    contactIds.length = 0;
    await prisma.auditLog.deleteMany({ where: { action: "SEQUENCE_STOPPED_BY_REPLY", entityId: { startsWith: "c" }, createdAt: { gte: new Date(Date.now() - 3_600_000) } } }).catch(() => undefined);
    await prisma.gmailConnection.update({ where: { id: connectionId }, data: { historyId: null, sendBlockedUntil: null, inboundError: null, scopes: ["https://www.googleapis.com/auth/gmail.send", METADATA_SCOPE] } });
  }

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ drainDueSequenceSteps: drain, runDueSequenceSteps: run } = await import("@/server/due-sequence-steps"));
    ({ syncSequenceReplies: sync, recordSequenceReply: record } = await import("@/server/sequence-reply-sync"));
    ({ GmailInboundError } = await import("@/server/email/gmail-inbound"));
    await prisma.company.upsert({ where: { id: COMPANY }, update: {}, create: { id: COMPANY, name: "Test Co", signatureTemplate: "Regards" } });
    agentId = (await prisma.account.create({ data: { fullName: "Agent Reply", email: `agent-${TAG}@example.test`, role: "TRAVEL_AGENT", status: "ACTIVE", companyId: COMPANY } })).id;
    connectionId = (
      await prisma.gmailConnection.create({ data: { accountId: agentId, googleEmail: `agent-${TAG}@example.test`, scopes: ["https://www.googleapis.com/auth/gmail.send", METADATA_SCOPE], encryptedRefreshToken: "not-a-real-token", status: "CONNECTED" } })
    ).id;
  });
  beforeEach(async () => {
    await clean();
    outbox.length = 0;
    sendHook = null;
    sendMode = "ok";
    process.env.SEQUENCE_SENDS_PER_MINUTE = "20";
    process.env.CAMPAIGN_DAILY_LIMIT = "400";
  });
  afterAll(async () => {
    if (!enabled) return;
    await clean();
    await prisma.gmailConnection.deleteMany({ where: { accountId: agentId } });
    await prisma.account.deleteMany({ where: { id: agentId } });
    await prisma.$disconnect();
  });

  // =====================================================================================================================
  describe("a customer's reply stops the remaining emails", () => {
    it("a reply to STEP 1 stops the enrollment: REPLIED, remaining steps cancelled, the reply, the reason and the time are recorded, and the scheduler sends nothing more", async () => {
      const { sequence, steps } = await newSequence("reply-1");
      const { enrollment, lead } = await newEnrollment(sequence.id, { stepIdx: 1, due: false });
      await sentStep(enrollment.id, steps[0].id, "th-A");
      const box = new FakeMailbox();
      await pass(box); // first look: sets the position
      box.arrive({ id: "r1", threadId: "th-A", from: "Customer <cust@example.test>", atMs: Date.now() + 1000 });
      const result = await pass(box);

      expect(result).toMatchObject({ repliesFound: 1, enrollmentsStopped: 1, errors: 0 });
      const after = await reload(enrollment.id);
      expect(after).toMatchObject({ status: "REPLIED", nextSendAt: null, stopReason: "REPLIED", waitReason: null });
      expect(after.stoppedAt).toBeInstanceOf(Date);
      const reply = await prisma.sequenceReply.findFirstOrThrow({ where: { enrollmentId: enrollment.id } });
      expect(reply).toMatchObject({ gmailMessageId: "r1", gmailThreadId: "th-A", fromEmail: "cust@example.test", stoppedEnrollment: true });
      expect(await prisma.activity.count({ where: { leadId: lead.id, type: "SEQUENCE_REPLIED" } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { action: "SEQUENCE_STOPPED_BY_REPLY", entityId: enrollment.id } })).toBe(1);
      // Sending history is preserved.
      expect(await prisma.sequenceStepLog.count({ where: { enrollmentId: enrollment.id, status: "SENT" } })).toBe(1);

      // Even a due step is never sent: the scheduler does not see a REPLIED enrollment.
      await prisma.sequenceEnrollment.update({ where: { id: enrollment.id }, data: { nextSendAt: new Date(Date.now() - 1000) } });
      await drain();
      expect(outbox).toHaveLength(0);
    });

    it("a reply to STEP 2 stops it, even after step 3 has been scheduled; a reply to an EARLIER message after later ones went out also stops it", async () => {
      const { sequence, steps } = await newSequence("reply-2", 5);
      const { enrollment } = await newEnrollment(sequence.id, { stepIdx: 3, due: false });
      await sentStep(enrollment.id, steps[0].id, "th-1", 300);
      await sentStep(enrollment.id, steps[1].id, "th-2", 200);
      await sentStep(enrollment.id, steps[2].id, "th-3", 100);
      const box = new FakeMailbox();
      await pass(box);
      // The customer finally answers the FIRST email, long after steps 2 and 3 went out.
      box.arrive({ id: "late", threadId: "th-1", from: "cust@example.test" });
      await pass(box);
      expect(await statusOf(enrollment.id)).toBe("REPLIED");
      const progress = await prisma.sequenceStepLog.count({ where: { enrollmentId: enrollment.id, status: "SENT" } });
      expect(progress).toBe(3);
    });

    it("an UNRELATED email from the same customer (not in a conversation our emails started) stops nothing", async () => {
      const { sequence, steps } = await newSequence("unrelated");
      const { enrollment } = await newEnrollment(sequence.id, { stepIdx: 1, due: false });
      await sentStep(enrollment.id, steps[0].id, "th-A");
      const box = new FakeMailbox();
      await pass(box);
      box.arrive({ id: "u1", threadId: "th-someone-elses", from: "cust@example.test" });
      const result = await pass(box);
      expect(result.repliesFound).toBe(0);
      expect(await statusOf(enrollment.id)).toBe("ACTIVE");
      expect(box.calls.message).toBe(0); // not even fetched: only conversations we started are looked at
    });

    it("our own messages, auto-replies and bounces in the conversation do NOT stop it", async () => {
      const { sequence, steps } = await newSequence("noise");
      const { enrollment } = await newEnrollment(sequence.id, { stepIdx: 1, due: false });
      await sentStep(enrollment.id, steps[0].id, "th-A");
      const box = new FakeMailbox();
      await pass(box);
      box.arrive({ id: "own", threadId: "th-A", from: `agent-${TAG}@example.test`, labels: ["SENT"] });
      box.arrive({ id: "ooo", threadId: "th-A", from: "cust@example.test", headers: { "Auto-Submitted": "auto-replied" } });
      box.arrive({ id: "bounce", threadId: "th-A", from: "MAILER-DAEMON@example.test", headers: { "Content-Type": "multipart/report; report-type=delivery-status" } });
      box.arrive({ id: "seq-itself", threadId: "th-A", from: "cust@example.test", labels: ["INBOX"] });
      // the CRM's own sequence email (its Gmail id is recorded on the log) must be ignored even if it shows up as an inbox message
      await prisma.sequenceStepLog.updateMany({ where: { enrollmentId: enrollment.id }, data: { gmailMessageId: "seq-itself" } });
      const result = await pass(box);
      expect(result.repliesFound).toBe(0);
      expect(await statusOf(enrollment.id)).toBe("ACTIVE");
      expect(await prisma.sequenceReply.count({ where: { enrollmentId: enrollment.id } })).toBe(0);
    });

    it("only the MATCHING enrollment stops when a customer has several active enrollments (two sequences, same lead address)", async () => {
      const a = await newSequence("multi-a");
      const b = await newSequence("multi-b");
      const first = await newEnrollment(a.sequence.id, { stepIdx: 1, due: false, email: `same-${TAG}@example.test` });
      const second = await newEnrollment(b.sequence.id, { stepIdx: 1, due: false, email: `same-${TAG}@example.test` });
      await sentStep(first.enrollment.id, a.steps[0].id, "th-a");
      await sentStep(second.enrollment.id, b.steps[0].id, "th-b");
      const box = new FakeMailbox();
      await pass(box);
      box.arrive({ id: "ra", threadId: "th-a", from: `same-${TAG}@example.test` });
      await pass(box);
      expect(await statusOf(first.enrollment.id)).toBe("REPLIED");
      expect(await statusOf(second.enrollment.id)).toBe("ACTIVE");
    });

    it("a FAILED enrollment whose customer replied is ended too, so a later Retry cannot email someone who already answered; a COMPLETED one is left alone", async () => {
      const { sequence, steps } = await newSequence("failed-reply");
      const failed = await newEnrollment(sequence.id, { stepIdx: 1, due: false, status: "FAILED" });
      await sentStep(failed.enrollment.id, steps[0].id, "th-F");
      const done = await newEnrollment(sequence.id, { stepIdx: 3, due: false, status: "COMPLETED" });
      await sentStep(done.enrollment.id, steps[0].id, "th-C");
      const box = new FakeMailbox();
      await pass(box);
      box.arrive({ id: "rf", threadId: "th-F", from: "cust@example.test" });
      box.arrive({ id: "rc", threadId: "th-C", from: "cust@example.test" });
      await pass(box);
      expect(await statusOf(failed.enrollment.id)).toBe("REPLIED");
      expect(await statusOf(done.enrollment.id)).toBe("COMPLETED");
    });
  });

  // =====================================================================================================================
  describe("finding the same reply twice, or at the same moment, changes nothing the second time", () => {
    it("duplicate notifications (the same message listed twice, and two passes) record ONE reply, ONE activity, ONE audit row", async () => {
      const { sequence, steps } = await newSequence("dupes");
      const { enrollment, lead } = await newEnrollment(sequence.id, { stepIdx: 1, due: false });
      await sentStep(enrollment.id, steps[0].id, "th-A");
      const box = new FakeMailbox();
      await pass(box);
      box.arrive({ id: "r1", threadId: "th-A", from: "cust@example.test" });
      box.log.push(box.log[0]); // Gmail notifies about the same message twice
      await pass(box);
      // Re-deliver everything: reset the saved position and look again (the safety sweep reads the conversation as well).
      await prisma.gmailConnection.update({ where: { id: connectionId }, data: { historyId: "0" } });
      await prisma.sequenceStepLog.updateMany({ where: { enrollmentId: enrollment.id }, data: { repliesCheckedAt: null } });
      await pass(box);
      expect(await prisma.sequenceReply.count({ where: { enrollmentId: enrollment.id } })).toBe(1);
      expect(await prisma.activity.count({ where: { leadId: lead.id, type: "SEQUENCE_REPLIED" } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { action: "SEQUENCE_STOPPED_BY_REPLY", entityId: enrollment.id } })).toBe(1);
    });

    it("20 simultaneous recordings of the same reply (several workers / instances) stop the enrollment exactly once", async () => {
      const { sequence, steps } = await newSequence("race-record");
      const { enrollment, lead } = await newEnrollment(sequence.id, { stepIdx: 1, due: false });
      const log = await sentStep(enrollment.id, steps[0].id, "th-A");
      const input = { enrollmentId: enrollment.id, stepLogId: log.id, gmailConnectionId: connectionId, gmailMessageId: "same-message", gmailThreadId: "th-A", fromEmail: "cust@example.test", receivedAt: new Date() };
      const results = await Promise.all(Array.from({ length: 20 }, () => record(input)));
      expect(results.filter((r) => r.stopped)).toHaveLength(1);
      expect(results.filter((r) => r.duplicate)).toHaveLength(19);
      expect(await statusOf(enrollment.id)).toBe("REPLIED");
      expect(await prisma.activity.count({ where: { leadId: lead.id, type: "SEQUENCE_REPLIED" } })).toBe(1);
    });

    it("a REPLY and the SCHEDULER racing: if the reply commits first nothing is sent; an email already handed to Gmail is not resurrected into a later step", async () => {
      const { sequence, steps } = await newSequence("race-send", 3, 1440);
      // (a) the reply commits BEFORE the scheduler looks: nothing is sent.
      const early = await newEnrollment(sequence.id, { stepIdx: 1 });
      const earlyLog = await sentStep(early.enrollment.id, steps[0].id, "th-early");
      await record({ enrollmentId: early.enrollment.id, stepLogId: earlyLog.id, gmailConnectionId: connectionId, gmailMessageId: "e1", gmailThreadId: "th-early", fromEmail: "c@example.test", receivedAt: new Date() });
      await drain();
      expect(outbox).toHaveLength(0);

      // (b) the reply commits WHILE the email is on its way to Gmail: that one email cannot be recalled, but the enrollment stays REPLIED and nothing further is scheduled.
      const mid = await newEnrollment(sequence.id, { stepIdx: 1 });
      const midLog = await sentStep(mid.enrollment.id, steps[0].id, "th-mid");
      sendHook = async () => {
        await record({ enrollmentId: mid.enrollment.id, stepLogId: midLog.id, gmailConnectionId: connectionId, gmailMessageId: "m1", gmailThreadId: "th-mid", fromEmail: "c@example.test", receivedAt: new Date() });
      };
      await drain();
      expect(outbox).toHaveLength(1);
      const after = await reload(mid.enrollment.id);
      expect(after).toMatchObject({ status: "REPLIED", nextSendAt: null, currentStepIdx: 1 }); // not advanced to step 3, not rescheduled
      sendHook = null;
      outbox.length = 0;
      await drain();
      expect(outbox).toHaveLength(0);
    });
  });

  // =====================================================================================================================
  describe("the safety nets", () => {
    it("an expired Gmail history position starts again from now and the sweep still finds the reply that arrived while we were not looking", async () => {
      const { sequence, steps } = await newSequence("expired");
      const { enrollment } = await newEnrollment(sequence.id, { stepIdx: 1, due: false });
      await sentStep(enrollment.id, steps[0].id, "th-A");
      const box = new FakeMailbox();
      await pass(box);
      box.arrive({ id: "r1", threadId: "th-A", from: "cust@example.test" });
      box.expireHistory = true;
      await pass(box);
      expect(await statusOf(enrollment.id)).toBe("REPLIED");
    });

    it("a mailbox that has not granted the metadata permission is skipped (and reported), never read, and still sends", async () => {
      await prisma.gmailConnection.update({ where: { id: connectionId }, data: { scopes: ["https://www.googleapis.com/auth/gmail.send"] } });
      const { sequence, steps } = await newSequence("no-scope");
      const { enrollment } = await newEnrollment(sequence.id, { stepIdx: 1, due: false });
      await sentStep(enrollment.id, steps[0].id, "th-A");
      const box = new FakeMailbox();
      const result = await pass(box);
      expect(result).toMatchObject({ mailboxes: 0, skippedNoPermission: 1 });
      expect(box.calls).toEqual({ history: 0, message: 0, thread: 0 });
    });

    it("a failing mailbox records the CATEGORY of the problem only, and the pass carries on", async () => {
      const { sequence, steps } = await newSequence("auth-fail");
      const { enrollment } = await newEnrollment(sequence.id, { stepIdx: 1, due: false });
      await sentStep(enrollment.id, steps[0].id, "th-A");
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const result = await sync({
        apiFor: async () => {
          throw new GmailInboundError("SCOPE");
        },
      });
      spy.mockRestore();
      expect(result.errors).toBe(1);
      expect((await prisma.gmailConnection.findUniqueOrThrow({ where: { id: connectionId } })).inboundError).toBe("SCOPE");
    });

    it("the safety sweep rotates: the least recently checked conversations are read first, and every one gets its turn", async () => {
      const { sequence, steps } = await newSequence("rotate");
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const e = await newEnrollment(sequence.id, { stepIdx: 1, due: false });
        const log = await sentStep(e.enrollment.id, steps[0].id, `th-rot-${i}`);
        ids.push(log.id);
      }
      const box = new FakeMailbox();
      await pass(box);
      const checked = await prisma.sequenceStepLog.findMany({ where: { id: { in: ids } }, select: { repliesCheckedAt: true } });
      expect(checked.every((c) => c.repliesCheckedAt instanceof Date)).toBe(true);
    });
  });

  // =====================================================================================================================
  describe("everyone's FIRST email goes out before anyone's follow-up, within a limited allowance", () => {
    it("with 20 sends per minute, 30 people waiting for step 1 and 10 due for step 2: the first minute sends 20 first emails and NO follow-up; the next sends the last 10 first emails, then the follow-ups", async () => {
      const { sequence, steps } = await newSequence("priority", 3, 0);
      for (let i = 0; i < 30; i++) await newEnrollment(sequence.id, { stepIdx: 0 });
      const followUps: string[] = [];
      for (let i = 0; i < 10; i++) {
        const e = await newEnrollment(sequence.id, { stepIdx: 1 });
        await sentStep(e.enrollment.id, steps[0].id, `th-fu-${i}`, 600);
        followUps.push(e.contact.primaryEmail!);
      }

      await drain();
      expect(outbox).toHaveLength(20);
      expect(outbox.every((m) => m.subject.startsWith("Step 1"))).toBe(true);
      expect(outbox.some((m) => followUps.includes(m.to))).toBe(false);
      // The people still waiting say WHY: capacity, not failure; and their time has not been moved.
      const waiting = await prisma.sequenceEnrollment.findMany({ where: { sequenceId: sequence.id, status: "ACTIVE", waitReason: "CAPACITY" } });
      expect(waiting.length).toBeGreaterThanOrEqual(20); // 10 first emails + 10 follow-ups
      expect(waiting.every((w) => w.nextSendAt && w.nextSendAt.getTime() < Date.now())).toBe(true);
      expect(await prisma.sequenceStepLog.count({ where: { enrollment: { sequenceId: sequence.id }, status: "FAILED", NOT: { error: { startsWith: "IN_FLIGHT" } } } })).toBe(0);

      // A minute later (the counted sends age out of the minute window): the rest of the first emails, THEN the follow-ups.
      await prisma.sequenceStepLog.updateMany({ where: { enrollment: { sequenceId: sequence.id }, senderAccountId: agentId }, data: { createdAt: new Date(Date.now() - 5 * 60_000) } });
      outbox.length = 0;
      await drain();
      expect(outbox).toHaveLength(20);
      expect(outbox.slice(0, 10).every((m) => m.subject.startsWith("Step 1"))).toBe(true);
      expect(outbox.slice(10).every((m) => followUps.includes(m.to) && m.subject.startsWith("Step 2"))).toBe(true);
      // No recipient got the same step twice.
      const all = await prisma.sequenceStepLog.findMany({ where: { enrollment: { sequenceId: sequence.id }, status: "SENT" }, select: { enrollmentId: true, stepId: true } });
      expect(new Set(all.map((l) => `${l.enrollmentId}:${l.stepId}`)).size).toBe(all.length);
    });

    it("the daily allowance is a ROLLING window: sending stops at the limit, the rest wait with the reason, and it resumes by itself as sends age past 24 hours", async () => {
      process.env.CAMPAIGN_DAILY_LIMIT = "5";
      process.env.SEQUENCE_SENDS_PER_MINUTE = "100";
      const { sequence } = await newSequence("daily", 2, 1440); // follow-ups are a day away, so only first emails are due
      for (let i = 0; i < 8; i++) await newEnrollment(sequence.id);
      await drain();
      expect(outbox).toHaveLength(5);
      expect(await prisma.sequenceEnrollment.count({ where: { sequenceId: sequence.id, waitReason: "CAPACITY" } })).toBe(3);

      outbox.length = 0;
      await drain(); // still inside the window: nothing more, no churn
      expect(outbox).toHaveLength(0);

      // 24 hours + a minute later the first five no longer count: the waiting three go out without anyone clicking anything.
      await prisma.sequenceStepLog.updateMany({
        where: { enrollment: { sequenceId: sequence.id }, status: "SENT" },
        data: { sentAt: new Date(Date.now() - 24 * 3_600_000 - 60_000), createdAt: new Date(Date.now() - 24 * 3_600_000 - 60_000) },
      });
      await drain();
      expect(outbox.filter((m) => m.subject.startsWith("Step 1"))).toHaveLength(3);
      expect(await prisma.sequenceEnrollment.count({ where: { sequenceId: sequence.id, waitReason: "CAPACITY" } })).toBe(0);
    });

    it("a sequence with 100 people waiting does not starve a second sequence: both are served in the same pass", async () => {
      const big = await newSequence("big", 2, 0);
      const small = await newSequence("small", 2, 0);
      for (let i = 0; i < 100; i++) await newEnrollment(big.sequence.id);
      for (let i = 0; i < 3; i++) await newEnrollment(small.sequence.id);
      await run();
      expect(outbox.filter((m) => m.subject.startsWith("Step 1")).length).toBeGreaterThan(3);
      expect(await prisma.sequenceStepLog.count({ where: { enrollment: { sequenceId: small.sequence.id }, status: "SENT" } })).toBe(3);
    });

    it("several workers at once cannot overshoot the allowance or email anyone twice", async () => {
      const { sequence } = await newSequence("workers", 2, 0);
      for (let i = 0; i < 60; i++) await newEnrollment(sequence.id);
      await Promise.all([drain(), drain(), drain(), drain()]);
      expect(outbox.length).toBeLessThanOrEqual(20); // SEQUENCE_SENDS_PER_MINUTE, counted under the mailbox's lock
      expect(new Set(outbox.map((m) => m.to)).size).toBe(outbox.length);
      const sent = await prisma.sequenceStepLog.count({ where: { enrollment: { sequenceId: sequence.id }, status: "SENT" } });
      expect(sent).toBe(outbox.length);
    });

    it("a mailbox Gmail asked to slow down is left alone until the time Gmail named: nothing is attempted, rows wait with that reason, then it resumes", async () => {
      await prisma.gmailConnection.update({ where: { id: connectionId }, data: { sendBlockedUntil: new Date(Date.now() + 30 * 60_000) } });
      const { sequence } = await newSequence("backoff", 2, 0);
      for (let i = 0; i < 4; i++) await newEnrollment(sequence.id);
      await drain();
      expect(outbox).toHaveLength(0);
      expect(await prisma.sequenceEnrollment.count({ where: { sequenceId: sequence.id, waitReason: "PROVIDER_BACKOFF" } })).toBe(4);
      await prisma.gmailConnection.update({ where: { id: connectionId }, data: { sendBlockedUntil: new Date(Date.now() - 1000) } });
      await drain();
      expect(outbox).toHaveLength(4);
    });

    it("Gmail refusing a send with 'rate limit' is NOT a failure: the enrollment stays ACTIVE, is not counted toward the retry limit, and is retried when Gmail says", async () => {
      const { sequence } = await newSequence("ratelimited", 2, 0);
      const { enrollment } = await newEnrollment(sequence.id);
      sendMode = "ratelimited";
      const before = Date.now();
      await drain();
      const after = await reload(enrollment.id);
      expect(after.status).toBe("ACTIVE");
      expect(after.waitReason).toBe("PROVIDER_BACKOFF");
      expect(after.nextSendAt!.getTime()).toBeGreaterThanOrEqual(before + 29 * 60_000);
      const logs = await prisma.sequenceStepLog.findMany({ where: { enrollmentId: enrollment.id } });
      expect(logs).toHaveLength(1);
      expect(logs[0].error).toMatch(/^RESOLVED: Gmail asked this mailbox to slow down/); // history kept, but not a failed attempt and not an open question
    });
  });

  // =====================================================================================================================
  describe("stopped enrollments are never sent", () => {
    it("an UNENROLLED (or FAILED) enrollment is never picked up, even if its time is long past", async () => {
      const { sequence } = await newSequence("stopped", 2, 0);
      const a = await newEnrollment(sequence.id);
      await prisma.sequenceEnrollment.update({ where: { id: a.enrollment.id }, data: { status: "UNSUBSCRIBED", stopReason: "UNENROLLED", stoppedAt: new Date(), nextSendAt: null } });
      const b = await newEnrollment(sequence.id, { status: "FAILED" });
      await prisma.sequenceEnrollment.update({ where: { id: b.enrollment.id }, data: { nextSendAt: new Date(Date.now() - 86_400_000) } });
      await drain();
      expect(outbox).toHaveLength(0);
    });
  });
});
