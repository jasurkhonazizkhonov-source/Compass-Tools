// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

// REAL-DATABASE proof of the sequence email builder's server side: what is stored for a visual (HTML) step and for an older plain-text step, who may edit, duplicate and reorder
// (reordering is refused while anyone is part-way through), and that what is SENT is the cleaned, styled, personalised email with the unsubscribe footer - for both formats.
// Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE database (src/test/integration-database-guard.ts).
const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
  process.env.CARD_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_HASH_KEY ??= randomBytes(32).toString("base64");
  process.env.SEQUENCE_SENDS_PER_MINUTE = "100";
}

let actor: { id: string; role: string; companyId: string; fullName: string; email: string; sessionCreatedAt: Date } | null = null;
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => actor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const sent: Array<{ to: string; subject: string; html: string }> = [];
vi.mock("@/server/email/service", () => ({
  sendEmail: vi.fn(async (a: { to: string; subject: string; html: string }) => {
    sent.push({ to: a.to, subject: a.subject, html: a.html });
    return { ok: true as const, messageId: `m-${sent.length}`, threadId: `t-${sent.length}` };
  }),
}));
vi.mock("@/server/queries/company", () => ({
  getCompanyForAccountId: vi.fn(async () => ({ id: "default-company", name: "Test Co", website: null, phone: null, brandColor: "#1c3a5e", logoEmailUrl: "", logoWebUrl: "", logoIconUrl: "", signatureTemplate: "" })),
}));

const TAG = `ss-${Date.now()}`;
const COMPANY = "default-company";

describe.skipIf(!enabled)("sequence step content - real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let actions: typeof import("../sequences");
  let content: typeof import("../sequence-step-content");
  let run: typeof import("@/server/due-sequence-steps").runDueSequenceSteps;
  let ownerId: string;
  let otherId: string;
  let viewerId: string;
  const sequenceIds: string[] = [];
  const contactIds: string[] = [];
  const as = (id: string, role: string) => (actor = { id, role, companyId: COMPANY, fullName: "Editor Name", email: `${id}@example.test`, sessionCreatedAt: new Date() });

  async function newSequence() {
    const s = await prisma.sequence.create({ data: { name: `Seq-${TAG}-${sequenceIds.length}`, isActive: true, createdById: ownerId } });
    sequenceIds.push(s.id);
    return s;
  }
  const stepsOf = (sequenceId: string) => prisma.sequenceStep.findMany({ where: { sequenceId }, orderBy: { order: "asc" } });

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    actions = await import("../sequences");
    content = await import("../sequence-step-content");
    ({ runDueSequenceSteps: run } = await import("@/server/due-sequence-steps"));
    await prisma.company.upsert({ where: { id: COMPANY }, update: {}, create: { id: COMPANY, name: "Test Co", signatureTemplate: "Regards" } });
    ownerId = (await prisma.account.create({ data: { fullName: "Owner", email: `owner-${TAG}@example.test`, role: "TRAVEL_AGENT", status: "ACTIVE", companyId: COMPANY } })).id;
    otherId = (await prisma.account.create({ data: { fullName: "Other", email: `other-${TAG}@example.test`, role: "TRAVEL_AGENT", status: "ACTIVE", companyId: COMPANY } })).id;
    viewerId = (await prisma.account.create({ data: { fullName: "Viewer", email: `viewer-${TAG}@example.test`, role: "TICKETING_AGENT", status: "ACTIVE", companyId: COMPANY } })).id;
  });
  beforeEach(() => {
    sent.length = 0;
    as(ownerId, "TRAVEL_AGENT");
  });
  afterAll(async () => {
    if (!enabled) return;
    await prisma.sequenceEnrollment.deleteMany({ where: { sequenceId: { in: sequenceIds } } });
    await prisma.sequence.deleteMany({ where: { id: { in: sequenceIds } } });
    await prisma.lead.deleteMany({ where: { contactId: { in: contactIds } } });
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    await prisma.gmailConnection.deleteMany({ where: { accountId: { in: [ownerId, otherId, viewerId] } } });
    await prisma.account.deleteMany({ where: { id: { in: [ownerId, otherId, viewerId] } } });
    await prisma.$disconnect();
  });

  describe("what is stored", () => {
    it("a plain-text step is stored exactly as before (format TEXT, text untouched)", async () => {
      const s = await newSequence();
      const step = await actions.addStep({ sequenceId: s.id, subject: "Hi", body: "Hello <b>there</b>\n\nBye", delayMinutes: 0 });
      expect(step).toMatchObject({ bodyFormat: "TEXT", body: "Hello <b>there</b>\n\nBye", order: 0 });
    });

    it("a visual step is CLEANED on the server before it is stored: scripts, handlers and unsafe links never reach the database", async () => {
      const s = await newSequence();
      const step = await actions.addStep({
        sequenceId: s.id, subject: "Offer", bodyFormat: "HTML", delayMinutes: 1440,
        body: '<p style="color:#b91c1c" onclick="x()">Hi {{contact_first_name}}</p><script>alert(1)</script><p><a href="https://example.com/a">go</a></p><img src="https://cdn.example/a.png" alt="A" onerror="y()">',
      });
      expect(step.bodyFormat).toBe("HTML");
      expect(step.body).not.toMatch(/script|onclick|onerror/i);
      expect(step.body).toContain("{{contact_first_name}}"); // tokens are kept for send time
      expect(step.body).toContain("color:#b91c1c");
    });

    it("a visual step that could not be sent safely is refused with the reason, and nothing is stored", async () => {
      const s = await newSequence();
      const refuse = (body: string) => actions.addStep({ sequenceId: s.id, subject: "S", bodyFormat: "HTML", delayMinutes: 0, body });
      await expect(refuse('<p><a href="javascript:alert(1)">x</a></p>')).rejects.toThrow(/cannot be saved.*not a web, email or phone link/);
      await expect(refuse('<p>x</p><img src="C:\\Users\\me\\a.png" alt="a">')).rejects.toThrow(/public https/);
      await expect(refuse("<p></p>")).rejects.toThrow(/no (visible )?content/);
      await expect(refuse(`<p>${"x".repeat(100_001)}</p>`)).rejects.toThrow(/too large/);
      expect(await stepsOf(s.id)).toHaveLength(0);
    });

    it("updating only the subject or delay never touches the body or its format; changing the body keeps the step's format and is cleaned", async () => {
      const s = await newSequence();
      const step = await actions.addStep({ sequenceId: s.id, subject: "S", bodyFormat: "HTML", delayMinutes: 0, body: "<p>Original</p>" });
      await actions.updateStep(step.id, { delayMinutes: 2880 });
      expect(await prisma.sequenceStep.findUniqueOrThrow({ where: { id: step.id } })).toMatchObject({ body: "<p>Original</p>", bodyFormat: "HTML", delayMinutes: 2880 });
      await actions.updateStep(step.id, { body: '<p>Changed</p><script>x</script>' });
      expect(await prisma.sequenceStep.findUniqueOrThrow({ where: { id: step.id } })).toMatchObject({ body: "<p>Changed</p>", bodyFormat: "HTML" });
      // A plain-text step edited the old way stays plain text.
      const text = await actions.addStep({ sequenceId: s.id, subject: "T", body: "plain", delayMinutes: 0 });
      await actions.updateStep(text.id, { body: "still plain <i>text</i>" });
      expect(await prisma.sequenceStep.findUniqueOrThrow({ where: { id: text.id } })).toMatchObject({ body: "still plain <i>text</i>", bodyFormat: "TEXT" });
    });

    it("only someone who may manage THIS sequence can add, edit, duplicate or reorder (another agent and a role without sequences are refused)", async () => {
      const s = await newSequence();
      const step = await actions.addStep({ sequenceId: s.id, subject: "S", body: "b", delayMinutes: 0 });
      as(otherId, "TRAVEL_AGENT");
      await expect(actions.updateStep(step.id, { subject: "x" })).rejects.toThrow(/not found/i);
      await expect(actions.duplicateStep(step.id)).rejects.toThrow(/not found/i);
      await expect(actions.moveStep(step.id, "down")).rejects.toThrow(/not found/i);
      as(viewerId, "TICKETING_AGENT");
      await expect(actions.addStep({ sequenceId: s.id, subject: "x", body: "y", delayMinutes: 0 })).rejects.toThrow();
      actor = null;
      await expect(actions.duplicateStep(step.id)).rejects.toThrow();
      expect(await stepsOf(s.id)).toHaveLength(1);
    });
  });

  describe("duplicate and reorder", () => {
    it("Duplicate adds a copy (subject, body, format, delay) at the END, so nobody's position changes", async () => {
      const s = await newSequence();
      const a = await actions.addStep({ sequenceId: s.id, subject: "A", bodyFormat: "HTML", body: "<p>A</p>", delayMinutes: 1440 });
      await actions.addStep({ sequenceId: s.id, subject: "B", body: "b", delayMinutes: 0 });
      const copy = await actions.duplicateStep(a.id);
      expect(copy).toMatchObject({ subject: "A", body: "<p>A</p>", bodyFormat: "HTML", delayMinutes: 1440, order: 2 });
      expect((await stepsOf(s.id)).map((x) => x.subject)).toEqual(["A", "B", "A"]);
    });

    it("Move swaps neighbours, refuses at the ends, and keeps positions 0..n-1 with no gaps or duplicates", async () => {
      const s = await newSequence();
      const [a, b, c] = [await actions.addStep({ sequenceId: s.id, subject: "A", body: "a", delayMinutes: 0 }), await actions.addStep({ sequenceId: s.id, subject: "B", body: "b", delayMinutes: 0 }), await actions.addStep({ sequenceId: s.id, subject: "C", body: "c", delayMinutes: 0 })];
      expect(await actions.moveStep(c.id, "up")).toEqual({ ok: true });
      expect((await stepsOf(s.id)).map((x) => [x.subject, x.order])).toEqual([["A", 0], ["C", 1], ["B", 2]]);
      expect(await actions.moveStep(a.id, "up")).toMatchObject({ ok: false, error: "This is already the first step." });
      expect(await actions.moveStep(b.id, "down")).toMatchObject({ ok: false, error: "This is already the last step." });
      expect(await actions.moveStep(a.id, "sideways" as never)).toMatchObject({ ok: false });
    });

    it("Move is REFUSED while anyone is part-way through (their position is a step number, so reordering would change what they get next) - and allowed again once they are not", async () => {
      const s = await newSequence();
      const a = await actions.addStep({ sequenceId: s.id, subject: "A", body: "a", delayMinutes: 0 });
      await actions.addStep({ sequenceId: s.id, subject: "B", body: "b", delayMinutes: 0 });
      const contact = await prisma.contact.create({ data: { firstName: "C", lastName: "T", primaryEmail: `c-${TAG}@example.test`, companyId: COMPANY } });
      contactIds.push(contact.id);
      const lead = await prisma.lead.create({ data: { contactId: contact.id, assignedAgentId: ownerId, source: "WEBSITE", status: "ATTEMPTING_TO_CONTACT" } });
      const enrollment = await prisma.sequenceEnrollment.create({ data: { sequenceId: s.id, leadId: lead.id, contactId: contact.id, status: "ACTIVE", currentStepIdx: 1, nextSendAt: new Date(Date.now() + 3_600_000) } });
      const refused = await actions.moveStep(a.id, "down");
      expect(refused).toMatchObject({ ok: false });
      expect((refused as { error: string }).error).toMatch(/1 person is part-way through/);
      expect((await stepsOf(s.id)).map((x) => x.subject)).toEqual(["A", "B"]);
      await prisma.sequenceEnrollment.update({ where: { id: enrollment.id }, data: { status: "FAILED" } });
      expect(await actions.moveStep(a.id, "down")).toMatchObject({ ok: false }); // a failed one can be retried, so it counts
      await prisma.sequenceEnrollment.update({ where: { id: enrollment.id }, data: { status: "REPLIED" } });
      expect(await actions.moveStep(a.id, "down")).toEqual({ ok: true });
    });
  });

  describe("preview and checks", () => {
    it("the preview is the whole email with SAMPLE data, the signature and the unsubscribe footer - and nothing hostile in it", async () => {
      const p = await content.previewSequenceStepEmail({ subject: "Hi {{contact_first_name}}", bodyFormat: "HTML", body: '<h2>Trip to {{arrival_city}}</h2><p>x</p><script>alert(1)</script><a href="javascript:alert(2)">bad</a>' });
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      expect(p.subject).toBe("Hi Sarah");
      expect(p.html).toContain("Trip to London");
      expect(p.html).toMatch(/Unsubscribe/);
      expect(p.html).not.toMatch(/<script|javascript:/i);
    });

    it("a plain-text step previews the way it is sent (paragraphs from blank lines, variables filled)", async () => {
      const p = await content.previewSequenceStepEmail({ subject: "S", bodyFormat: "TEXT", body: "Hello {{contact_first_name}}\n\nSecond <b>paragraph</b>" });
      expect(p.ok && p.html).toContain("Hello Sarah");
      expect(p.ok && p.html).toContain("Second &lt;b&gt;paragraph&lt;/b&gt;");
    });

    it("an oversized draft is refused (not rendered), and roles that cannot manage sequences cannot use either helper", async () => {
      expect(await content.previewSequenceStepEmail({ subject: "S", bodyFormat: "HTML", body: "x".repeat(150_001) })).toEqual({ ok: false, error: "The email is too large to preview." });
      expect((await content.analyzeSequenceStepDraft({ subject: "S", bodyFormat: "HTML", body: "x".repeat(150_001) })).ok).toBe(false);
      as(viewerId, "TICKETING_AGENT");
      await expect(content.previewSequenceStepEmail({ subject: "S", bodyFormat: "TEXT", body: "b" })).rejects.toThrow("Not available.");
      await expect(content.analyzeSequenceStepDraft({ subject: "S", bodyFormat: "TEXT", body: "b" })).rejects.toThrow("Not available.");
      actor = null;
      await expect(content.previewSequenceStepEmail({ subject: "S", bodyFormat: "TEXT", body: "b" })).rejects.toThrow("Not available.");
    });
  });

  describe("what is actually SENT", () => {
    async function enrollAndSend(step: { subject: string; body: string; bodyFormat: "TEXT" | "HTML" }, firstName = "Sarah") {
      const s = await newSequence();
      await prisma.sequenceStep.create({ data: { sequenceId: s.id, order: 0, delayMinutes: 0, ...step } });
      await prisma.gmailConnection.upsert({
        where: { accountId: ownerId },
        update: {},
        create: { accountId: ownerId, googleEmail: `owner-${TAG}@example.test`, scopes: ["https://www.googleapis.com/auth/gmail.send"], encryptedRefreshToken: "x", status: "CONNECTED" },
      });
      const contact = await prisma.contact.create({ data: { firstName, lastName: "Smith", primaryEmail: `sent-${TAG}-${contactIds.length}@example.test`, companyId: COMPANY } });
      contactIds.push(contact.id);
      const lead = await prisma.lead.create({ data: { contactId: contact.id, assignedAgentId: ownerId, source: "WEBSITE", status: "ATTEMPTING_TO_CONTACT" } });
      const enrollment = await prisma.sequenceEnrollment.create({ data: { sequenceId: s.id, leadId: lead.id, contactId: contact.id, status: "ACTIVE", nextSendAt: new Date(Date.now() - 1000) } });
      await run({ enrollmentIds: [enrollment.id] });
      return { email: sent[sent.length - 1], enrollmentId: enrollment.id };
    }

    it("a visual step goes out personalised, styled for email clients, cleaned and with the unsubscribe footer - and a customer's name cannot inject markup", async () => {
      const { email } = await enrollAndSend(
        { subject: "Offer for {{contact_first_name}}", bodyFormat: "HTML", body: '<h2>Hello {{contact_first_name}}</h2><p style="text-align:center">Your <strong>trip</strong></p><table data-compass-block="button" role="presentation" align="center"><tbody><tr><td bgcolor="#1d4ed8"><a href="https://example.com/book" style="display:inline-block;padding:12px 28px;color:#ffffff">Book</a></td></tr></tbody></table>' },
        '<img src=x onerror=alert(1)>Eve',
      );
      expect(email.subject).toContain("Offer for");
      expect(email.html).not.toMatch(/<img[^>]*onerror/i); // no tag was made from the customer's data
      expect(email.html).toContain("&lt;img src=x onerror=alert(1)&gt;Eve");
      expect(email.html).toMatch(/<h2 style="[^"]*font-size:21px/); // inline styles for email clients
      expect(email.html).toContain("text-align:center");
      expect(email.html).toContain('data-compass-block="button"');
      expect(email.html).toContain("padding:12px 28px");
      expect(email.html).toMatch(/Unsubscribe/); // the mandatory footer is added around every step
      expect(email.html).toContain("/api/public/sequence-unsubscribe?enrollment=");
    });

    it("an older plain-text step goes out exactly as it always did: paragraphs from blank lines, variables filled, HTML in the text escaped", async () => {
      const { email } = await enrollAndSend({ subject: "Plain", bodyFormat: "TEXT", body: "Hi {{contact_first_name}},\n\nSee https://example.com/x <b>now</b>" });
      expect(email.html).toContain("Hi Sarah,");
      expect(email.html).toMatch(/<a href="https:\/\/example\.com\/x/);
      expect(email.html).toContain("&lt;b&gt;now&lt;/b&gt;");
      expect(email.html).toMatch(/Unsubscribe/);
    });

    it("a step whose HTML was stored before the sanitiser existed, or edited in the database, is cleaned AGAIN at send time", async () => {
      const { email } = await enrollAndSend({ subject: "Old", bodyFormat: "HTML", body: '<p>Hi</p><script>steal()</script><a href="javascript:steal()">x</a><img src="https://x.example/a.png" onerror="steal()">' });
      expect(email.html).not.toMatch(/steal|<script|javascript:|onerror/i);
      expect(email.html).toContain("Hi");
    });
  });
});
