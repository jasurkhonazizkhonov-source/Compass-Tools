// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// REAL-DATABASE proof of Lead document storage: authorisation (lead / company / role), IDOR, cross-company isolation, the two-phase
// upload with server-side content verification, Admin/Manager-only edit + delete, Contact aggregation that respects Lead visibility,
// consistency between PostgreSQL and storage, and the audit trail. Storage (R2) is an in-memory fake — no network, no credentials.
// Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL with this repo's migrations applied.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
}

type Role = "ADMIN" | "MANAGER" | "TRAVEL_AGENT" | "TICKETING_AGENT" | "FLIGHT_EXPERT" | "MARKETING_AGENT";
type Actor = { id: string; role: Role; status: string; companyId: string; fullName: string; email: string; phone: string | null; paymentPermissions: string[]; bookingPermissions: string[]; sessionCreatedAt: Date };

let currentActor: Actor | null = null;
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));

// In-memory R2.
const fake = vi.hoisted(() => ({
  store: new Map<string, Uint8Array>(),
  configured: true,
  failPresign: false,
  failRemove: false,
  failHead: false,
  removed: [] as string[],
}));
vi.mock("@/server/storage/r2", () => ({
  isStorageConfigured: () => fake.configured,
  objectStorage: {
    presignUpload: async (key: string, contentType: string, contentLength: number) => {
      if (fake.failPresign) throw new Error("presign down");
      return { url: `https://r2.test/${key}?type=${encodeURIComponent(contentType)}&len=${contentLength}&sig=x`, expiresInSeconds: 300 };
    },
    presignDownload: async (key: string, opts: { contentType: string; contentDisposition: string }) => `https://r2.test/${key}?ct=${encodeURIComponent(opts.contentType)}&cd=${encodeURIComponent(opts.contentDisposition)}&sig=y`,
    head: async (key: string) => {
      if (fake.failHead) throw new Error("storage down");
      const b = fake.store.get(key);
      return b ? { size: b.length } : null;
    },
    readHead: async (key: string, n: number) => fake.store.get(key)?.slice(0, n) ?? null,
    remove: async (key: string) => {
      if (fake.failRemove) throw new Error("storage down");
      fake.removed.push(key);
      fake.store.delete(key);
    },
  },
}));

const TAG = `att-${Date.now()}`;
const PDF = new TextEncoder().encode("%PDF-1.7\n%test document\n");
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const DOCX = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const EXE = new TextEncoder().encode("MZ\x90\x00\x03\x00\x00\x00");

describe.skipIf(!enabled)("Lead documents — real PostgreSQL, in-memory storage", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let actions: typeof import("../lead-attachments");
  let queries: typeof import("@/server/queries/lead-attachments");
  let cleanup: typeof import("@/server/attachments/cleanup");
  let route: typeof import("@/app/api/attachments/[id]/file/route");
  let leadActions: typeof import("../leads");
  const accountIds: string[] = [];
  const contactIds: string[] = [];
  const companyB = `co-b-${TAG}`;
  const actors: Record<string, Actor> = {};
  const ids: Record<string, string> = {};

  async function makeActor(name: string, role: Role, company = "default-company") {
    const a = await prisma.account.create({ data: { fullName: name, email: `${name.toLowerCase()}-${TAG}@example.test`, role, status: "ACTIVE", companyId: company } });
    accountIds.push(a.id);
    actors[name] = { id: a.id, role, status: "ACTIVE", companyId: company, fullName: name, email: a.email, phone: null, paymentPermissions: [], bookingPermissions: [], sessionCreatedAt: new Date() };
    return a;
  }
  async function makeLead(label: string, contactId: string, agent: string | null) {
    const lead = await prisma.lead.create({ data: { contactId, status: "NEW", source: "OTHER", assignedAgentId: agent ? actors[agent].id : null } });
    ids[label] = lead.id;
    return lead;
  }
  const as = (name: string | null) => {
    currentActor = name ? actors[name] : null;
  };

  /** A full legitimate upload as `who`: request → (browser PUT to the fake store) → complete. */
  async function upload(who: string, leadId: string, file: { name: string; type?: string; bytes: Uint8Array; description?: string }) {
    as(who);
    const req = await actions.requestLeadAttachmentUpload({ leadId, fileName: file.name, contentType: file.type ?? "", size: file.bytes.length, description: file.description });
    if (!req.ok) return { req, done: null as null };
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: req.attachmentId } });
    fake.store.set(row.storageKey!, file.bytes);
    const done = await actions.completeLeadAttachmentUpload(req.attachmentId);
    return { req, done, id: req.attachmentId, key: row.storageKey! };
  }
  const auditActions = async (attachmentId?: string) =>
    (await prisma.auditLog.findMany({ where: { entityType: "Attachment", ...(attachmentId ? { entityId: attachmentId } : {}), createdAt: { gte: new Date(Date.now() - 600_000) } }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
  const getReq = (id: string, qs = "") => new NextRequest(`http://localhost/api/attachments/${id}/file${qs}`);
  const callRoute = (id: string, qs = "") => route.GET(getReq(id, qs), { params: Promise.resolve({ id }) });

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    actions = await import("../lead-attachments");
    queries = await import("@/server/queries/lead-attachments");
    cleanup = await import("@/server/attachments/cleanup");
    route = await import("@/app/api/attachments/[id]/file/route");
    leadActions = await import("../leads");
    await prisma.company.upsert({ where: { id: "default-company" }, update: {}, create: { id: "default-company", name: "Test Co", signatureTemplate: "Regards" } });
    await prisma.company.create({ data: { id: companyB, name: "Other Co", signatureTemplate: "Regards" } });

    await makeActor("Admin", "ADMIN");
    await makeActor("MgrTeam", "MANAGER");
    await makeActor("MgrOther", "MANAGER");
    await makeActor("Agent1", "TRAVEL_AGENT");
    await makeActor("Agent2", "TRAVEL_AGENT");
    await makeActor("Ticketing", "TICKETING_AGENT");
    await makeActor("AdminB", "ADMIN", companyB);
    await makeActor("AgentB", "TRAVEL_AGENT", companyB);
    // MgrTeam manages Agent1 only.
    await prisma.account.update({ where: { id: actors.Agent1.id }, data: { managerId: actors.MgrTeam.id } });

    const cA = await prisma.contact.create({ data: { firstName: "Cust", lastName: `A-${TAG}`, primaryEmail: `a-${TAG}@example.test`, companyId: "default-company", ownerId: actors.Agent1.id } });
    const cB = await prisma.contact.create({ data: { firstName: "Cust", lastName: `B-${TAG}`, primaryEmail: `b-${TAG}@example.test`, companyId: companyB, ownerId: actors.AgentB.id } });
    contactIds.push(cA.id, cB.id);
    ids.contactA = cA.id;
    ids.contactB = cB.id;
    await makeLead("LA1", cA.id, "Agent1"); // Agent1's lead, same contact …
    await makeLead("LA2", cA.id, "Agent2"); // … and a lead of the SAME contact assigned to Agent2
    await makeLead("LB1", cB.id, "AgentB"); // another company
  });

  afterAll(async () => {
    if (!enabled) return;
    await prisma.auditLog.deleteMany({ where: { actorId: { in: accountIds } } }).catch(() => {});
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.company.deleteMany({ where: { id: companyB } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // every test starts from a clean slate for the fixture leads
    await prisma.attachment.deleteMany({ where: { leadId: { in: [ids.LA1, ids.LA2, ids.LB1] } } });
    fake.store.clear();
    fake.removed.length = 0;
    fake.configured = true;
    fake.failPresign = false;
    fake.failRemove = false;
    fake.failHead = false;
    as(null);
    // each test gets a fresh rate-limit allowance
    await prisma.rateLimitCounter.deleteMany({ where: { key: { startsWith: "acct:" } } });
  });

  // ── upload ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("upload", () => {
    it("a Travel Agent can upload a PDF, an image and an Office document to their own lead", async () => {
      for (const f of [
        { name: "passport.pdf", type: "application/pdf", bytes: PDF },
        { name: "id.png", type: "image/png", bytes: PNG },
        { name: "form.docx", type: "", bytes: DOCX },
      ]) {
        const r = await upload("Agent1", ids.LA1, f);
        expect(r.req.ok, f.name).toBe(true);
        expect(r.done, f.name).toEqual({ ok: true, attachmentId: r.id });
      }
      const list = await queries.listLeadAttachments(ids.LA1, actors.Agent1);
      expect(list.items.map((i) => i.fileName).sort()).toEqual(["form.docx", "id.png", "passport.pdf"]);
    });

    it("the record is tied to the lead, contact, company and uploader, with an opaque key that never reaches the browser", async () => {
      const r = await upload("Agent1", ids.LA1, { name: "../../etc/Passport Copy.pdf", type: "application/pdf", bytes: PDF, description: "Passport copy" });
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: r.id! } });
      expect(row).toMatchObject({ leadId: ids.LA1, contactId: ids.contactA, companyId: "default-company", uploadedById: actors.Agent1.id, status: "READY", fileType: "application/pdf", description: "Passport copy", fileName: "Passport Copy.pdf" });
      expect(row.storageKey).toBe(`companies/default-company/leads/${ids.LA1}/attachments/${row.id}/${row.storageKey!.split("/").pop()}`);
      expect(row.storageKey).not.toContain("Passport");
      expect(row.storageKey!.split("/").pop()).toMatch(/^[0-9a-f]{32}$/);
      // the metadata queries never select the key
      const list = await queries.listLeadAttachments(ids.LA1, actors.Agent1);
      expect(JSON.stringify(list)).not.toContain(row.storageKey!);
      expect(Object.keys(list.items[0])).not.toContain("storageKey");
      // the signed upload is for exactly this type and size
      const req = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "x.pdf", contentType: "application/pdf", size: PDF.length });
      expect(req.ok && req.uploadUrl).toContain(`len=${PDF.length}`);
    });

    it.each([
      ["movie.mp4", "video/mp4"],
      ["song.mp3", "audio/mpeg"],
      ["run.exe", "application/x-msdownload"],
      ["page.html", "text/html"],
      ["logo.svg", "image/svg+xml"],
      ["pack.zip", "application/zip"],
      ["invoice.exe.pdf", "application/pdf"],
      ["a.pdf", "text/html"],
    ])("the SERVER rejects %s (%s)", async (name, type) => {
      as("Agent1");
      const r = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: name, contentType: type, size: 1000 });
      expect(r.ok).toBe(false);
      expect(await prisma.attachment.count({ where: { leadId: ids.LA1, fileName: { startsWith: name.split(".")[0] } } })).toBe(0);
    });

    it("rejects empty and oversized files before anything is stored", async () => {
      as("Agent1");
      const before = await prisma.attachment.count({ where: { leadId: ids.LA1 } });
      expect((await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "a.pdf", contentType: "application/pdf", size: 0 })).ok).toBe(false);
      const big = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "a.pdf", contentType: "application/pdf", size: 11 * 1024 * 1024 });
      expect(big.ok).toBe(false);
      if (!big.ok) expect(big.error).toContain("10 MB");
      expect(await prisma.attachment.count({ where: { leadId: ids.LA1 } })).toBe(before);
    });

    it("an executable renamed to .pdf is caught by the content check: object and record are removed", async () => {
      const r = await upload("Agent1", ids.LA1, { name: "statement.pdf", type: "application/pdf", bytes: EXE });
      expect(r.req.ok).toBe(true);
      expect(r.done).toMatchObject({ ok: false });
      expect(await prisma.attachment.count({ where: { id: r.id } })).toBe(0);
      expect(fake.store.has(r.key!)).toBe(false);
      expect(await auditActions(r.id)).toContain("ATTACHMENT_UPLOAD_REJECTED");
    });

    it("an upload whose stored size differs from what was authorised is rejected and cleaned up", async () => {
      as("Agent1");
      const req = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "a.pdf", contentType: "application/pdf", size: 50 });
      if (!req.ok) throw new Error("setup");
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: req.attachmentId } });
      fake.store.set(row.storageKey!, PDF); // not 50 bytes
      expect(await actions.completeLeadAttachmentUpload(req.attachmentId)).toMatchObject({ ok: false });
      expect(await prisma.attachment.count({ where: { id: req.attachmentId } })).toBe(0);
      expect(fake.store.has(row.storageKey!)).toBe(false);
    });

    it("completing without the object being uploaded fails and leaves no visible file", async () => {
      as("Agent1");
      const req = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "a.pdf", contentType: "application/pdf", size: PDF.length });
      if (!req.ok) throw new Error("setup");
      expect(await actions.completeLeadAttachmentUpload(req.attachmentId)).toMatchObject({ ok: false });
      expect((await queries.listLeadAttachments(ids.LA1, actors.Agent1)).items.find((i) => i.id === req.attachmentId)).toBeUndefined();
    });

    it("a PENDING upload is never listed or downloadable; only the uploader can complete it", async () => {
      as("Agent1");
      const req = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "pending.pdf", contentType: "application/pdf", size: PDF.length });
      if (!req.ok) throw new Error("setup");
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: req.attachmentId } });
      fake.store.set(row.storageKey!, PDF);
      expect((await queries.listLeadAttachments(ids.LA1, actors.Agent1)).items.find((i) => i.id === req.attachmentId)).toBeUndefined();
      expect((await callRoute(req.attachmentId)).status).toBe(404);
      as("Admin"); // sees the lead, but did not start this upload
      expect(await actions.completeLeadAttachmentUpload(req.attachmentId)).toMatchObject({ ok: false });
      expect((await prisma.attachment.findUniqueOrThrow({ where: { id: req.attachmentId } })).status).toBe("PENDING");
      as("Agent1");
      expect(await actions.completeLeadAttachmentUpload(req.attachmentId)).toMatchObject({ ok: true });
    });

    it("presign failure leaves no row; storage not configured is a clear, safe message", async () => {
      as("Agent1");
      fake.failPresign = true;
      const before = await prisma.attachment.count({ where: { leadId: ids.LA1 } });
      expect(await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "a.pdf", contentType: "application/pdf", size: 10 })).toMatchObject({ ok: false });
      expect(await prisma.attachment.count({ where: { leadId: ids.LA1 } })).toBe(before);
      fake.failPresign = false;
      fake.configured = false;
      const r = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "a.pdf", contentType: "application/pdf", size: 10 });
      expect(r).toMatchObject({ ok: false });
      expect(JSON.stringify(r)).not.toMatch(/R2|bucket|S3|secret|credential/i);
      expect(await prisma.attachment.count({ where: { leadId: ids.LA1 } })).toBe(before);
    });

    it("a storage outage while completing leaves the row PENDING for a retry; the sweep removes abandoned ones", async () => {
      as("Agent1");
      const req = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "a.pdf", contentType: "application/pdf", size: PDF.length });
      if (!req.ok) throw new Error("setup");
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: req.attachmentId } });
      fake.store.set(row.storageKey!, PDF);
      fake.failHead = true;
      expect(await actions.completeLeadAttachmentUpload(req.attachmentId)).toMatchObject({ ok: false });
      expect((await prisma.attachment.findUniqueOrThrow({ where: { id: req.attachmentId } })).status).toBe("PENDING");
      fake.failHead = false;
      // not yet stale
      expect((await cleanup.sweepStalePendingAttachments()).removed).toBe(0);
      // two hours later it is abandoned
      const swept = await cleanup.sweepStalePendingAttachments(Date.now() + 2 * 3600_000);
      expect(swept.removed).toBeGreaterThanOrEqual(1);
      expect(await prisma.attachment.count({ where: { id: req.attachmentId } })).toBe(0);
      expect(fake.store.has(row.storageKey!)).toBe(false);
    });

    it("a failed attempt is reported with stage / kind / status only, audited, and the retry then works", async () => {
      as("Agent1");
      const first = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "retry.pdf", contentType: "application/pdf", size: PDF.length });
      if (!first.ok) throw new Error("setup");
      await actions.abandonLeadAttachmentUpload(first.attachmentId, { stage: "put", kind: "blocked", status: 0 });
      expect(await prisma.attachment.count({ where: { id: first.attachmentId } })).toBe(0);
      const failed = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "Attachment", entityId: first.attachmentId, action: "ATTACHMENT_UPLOAD_FAILED" } });
      expect(failed.metadata).toMatchObject({ stage: "put", kind: "blocked", status: 0, leadId: ids.LA1, companyId: "default-company" });
      expect(JSON.stringify(failed.metadata)).not.toMatch(/https?:|r2\.test|sig=/);
      // anything outside the allowed shape is ignored (nothing the browser says can inject a URL or free text into the log)
      const second = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "retry.pdf", contentType: "application/pdf", size: PDF.length });
      if (!second.ok) throw new Error("setup");
      await actions.abandonLeadAttachmentUpload(second.attachmentId, { stage: "put", kind: "blocked", status: 0, url: "https://evil.example/?sig=1" });
      expect(await prisma.auditLog.count({ where: { entityType: "Attachment", entityId: second.attachmentId, action: "ATTACHMENT_UPLOAD_FAILED" } })).toBe(1);
      expect(JSON.stringify((await prisma.auditLog.findFirstOrThrow({ where: { entityId: second.attachmentId, action: "ATTACHMENT_UPLOAD_FAILED" } })).metadata)).not.toContain("evil");
      // and a fresh, complete upload of the same file now succeeds (a failed attempt blocks nothing)
      const ok = await upload("Agent1", ids.LA1, { name: "retry.pdf", type: "application/pdf", bytes: PDF });
      expect(ok.done).toEqual({ ok: true, attachmentId: ok.id });
    });

    it("diagnostics from someone else's pending upload are ignored", async () => {
      as("Agent2");
      const req = await actions.requestLeadAttachmentUpload({ leadId: ids.LA2, fileName: "x.pdf", contentType: "application/pdf", size: 10 });
      if (!req.ok) throw new Error("setup");
      as("Agent1");
      await actions.abandonLeadAttachmentUpload(req.attachmentId, { stage: "put", kind: "rejected", status: 403 });
      expect(await prisma.attachment.count({ where: { id: req.attachmentId } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { entityId: req.attachmentId, action: "ATTACHMENT_UPLOAD_FAILED" } })).toBe(0);
    });

    it("the browser failing mid-upload (abandon) removes the pending record", async () => {
      as("Agent1");
      const req = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "a.pdf", contentType: "application/pdf", size: 10 });
      if (!req.ok) throw new Error("setup");
      expect(await actions.abandonLeadAttachmentUpload(req.attachmentId)).toEqual({ ok: true });
      expect(await prisma.attachment.count({ where: { id: req.attachmentId } })).toBe(0);
    });

    it("every upload is audited with actor, lead and company — and never the file name or key", async () => {
      const r = await upload("Agent1", ids.LA1, { name: "Secret Name.pdf", type: "application/pdf", bytes: PDF });
      const log = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "Attachment", entityId: r.id, action: "ATTACHMENT_UPLOADED" } });
      expect(log.actorId).toBe(actors.Agent1.id);
      expect(log.metadata).toMatchObject({ leadId: ids.LA1, contactId: ids.contactA, companyId: "default-company" });
      expect(JSON.stringify(log)).not.toContain("Secret Name");
      expect(JSON.stringify(log)).not.toContain(r.key!);
    });
  });

  // ── isolation ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("lead and company isolation (IDOR)", () => {
    let docA2: { id: string; key: string };
    let docB: { id: string; key: string };
    let docA1: { id: string; key: string };
    beforeEach(async () => {
      docA1 = (await upload("Agent1", ids.LA1, { name: "a1.pdf", type: "application/pdf", bytes: PDF })) as never;
      docA2 = (await upload("Agent2", ids.LA2, { name: "a2.pdf", type: "application/pdf", bytes: PDF })) as never;
      docB = (await upload("AgentB", ids.LB1, { name: "b1.pdf", type: "application/pdf", bytes: PDF })) as never;
      as(null);
    });

    it("Agent1 cannot upload to another agent's lead, another company's lead, or a made-up lead", async () => {
      as("Agent1");
      for (const leadId of [ids.LA2, ids.LB1, "does-not-exist"]) {
        const r = await actions.requestLeadAttachmentUpload({ leadId, fileName: "x.pdf", contentType: "application/pdf", size: PDF.length });
        expect(r, leadId).toEqual({ ok: false, error: "You can't add files to this lead." });
      }
      expect(await prisma.attachment.count({ where: { leadId: { in: [ids.LA2, ids.LB1] }, fileName: "x.pdf" } })).toBe(0);
    });

    it("the lead id in the request is authoritative: an attachment id can't be completed against a different lead", async () => {
      as("Agent1");
      const req = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "x.pdf", contentType: "application/pdf", size: PDF.length });
      if (!req.ok) throw new Error("setup");
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: req.attachmentId } });
      expect(row.leadId).toBe(ids.LA1);
      // there is no request field that can move it: a second call for another lead creates a separate, denied request
      expect(await actions.requestLeadAttachmentUpload({ leadId: ids.LA2, fileName: "x.pdf", contentType: "application/pdf", size: 1 })).toMatchObject({ ok: false });
    });

    it("Lead A's viewer sees only Lead A's documents", async () => {
      expect((await queries.listLeadAttachments(ids.LA1, actors.Agent1)).items.map((i) => i.id)).toEqual([docA1.id]);
      expect((await queries.listLeadAttachments(ids.LA2, actors.Agent1)).items).toEqual([]); // another agent's lead
      expect((await queries.listLeadAttachments(ids.LB1, actors.Agent1)).items).toEqual([]); // another company
      expect((await queries.listLeadAttachments(ids.LB1, actors.Admin)).items).toEqual([]); // even an Admin of company A
    });

    it("opening / downloading another lead's or company's document is a plain 404 — identical to a document that doesn't exist", async () => {
      as("Agent1");
      const own = await callRoute(docA1.id);
      expect(own.status).toBe(302);
      const denied = await Promise.all([docA2.id, docB.id, "no-such-id"].map((id) => callRoute(id)));
      for (const r of denied) {
        expect(r.status).toBe(404);
        expect(r.headers.get("location")).toBeNull();
      }
      const bodies = await Promise.all(denied.map((r) => r.text()));
      expect(new Set(bodies).size).toBe(1);
      for (const body of bodies) {
        expect(body).not.toContain("r2.test");
        expect(body).not.toContain(docB.key);
      }
    });

    it("editing or deleting another lead's / company's document is refused and leaves it untouched (even for a Manager / Admin outside the scope)", async () => {
      as("AdminB");
      expect(await actions.updateLeadAttachmentDescription(docA1.id, "hijack")).toMatchObject({ ok: false });
      expect(await actions.deleteLeadAttachment(docA1.id)).toMatchObject({ ok: false });
      as("Admin");
      expect(await actions.updateLeadAttachmentDescription(docB.id, "hijack")).toMatchObject({ ok: false });
      expect(await actions.deleteLeadAttachment(docB.id)).toMatchObject({ ok: false });
      as("MgrOther"); // a Manager whose team does not include Agent1 / Agent2
      expect(await actions.updateLeadAttachmentDescription(docA1.id, "hijack")).toMatchObject({ ok: false });
      expect(await actions.deleteLeadAttachment(docA1.id)).toMatchObject({ ok: false });
      const rows = await prisma.attachment.findMany({ where: { id: { in: [docA1.id, docB.id] } } });
      expect(rows.map((r) => r.description)).toEqual([null, null]);
      expect(fake.store.has(docA1.key) && fake.store.has(docB.key)).toBe(true);
    });

    it("complete / abandon can't be pointed at someone else's pending upload", async () => {
      as("Agent2");
      const req = await actions.requestLeadAttachmentUpload({ leadId: ids.LA2, fileName: "p.pdf", contentType: "application/pdf", size: PDF.length });
      if (!req.ok) throw new Error("setup");
      as("Agent1");
      expect(await actions.completeLeadAttachmentUpload(req.attachmentId)).toMatchObject({ ok: false });
      await actions.abandonLeadAttachmentUpload(req.attachmentId);
      expect(await prisma.attachment.count({ where: { id: req.attachmentId } })).toBe(1);
    });

    it("a tampered row whose company differs from its lead's is invisible to everyone", async () => {
      await prisma.attachment.update({ where: { id: docA1.id }, data: { companyId: companyB } });
      expect((await queries.listLeadAttachments(ids.LA1, actors.Agent1)).items).toEqual([]);
      expect((await queries.listLeadAttachments(ids.LA1, actors.AdminB)).items).toEqual([]);
      as("Agent1");
      expect((await callRoute(docA1.id)).status).toBe(404);
    });

    it("denied attempts are audited as ATTACHMENT_ACCESS_DENIED without revealing why to the caller", async () => {
      as("Agent1");
      await callRoute(docB.id);
      await actions.requestLeadAttachmentUpload({ leadId: ids.LB1, fileName: "x.pdf", contentType: "application/pdf", size: 1 });
      const denied = await prisma.auditLog.findMany({ where: { actorId: actors.Agent1.id, action: "ATTACHMENT_ACCESS_DENIED" } });
      expect(denied.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(denied)).not.toContain(docB.key);
    });

    it("signed-out and unsupported-role callers get nothing", async () => {
      as(null);
      expect((await callRoute(docA1.id)).status).toBe(401);
      expect(await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "x.pdf", contentType: "application/pdf", size: 1 })).toMatchObject({ ok: false });
      as("Ticketing"); // no Leads area
      expect((await callRoute(docA1.id)).status).toBe(404);
      expect(await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "x.pdf", contentType: "application/pdf", size: 1 })).toMatchObject({ ok: false });
      expect(await actions.deleteLeadAttachment(docA1.id)).toMatchObject({ ok: false });
    });
  });

  // ── permissions ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("roles", () => {
    it("a Travel Agent can upload and view but can NOT edit the description or delete (enforced server-side)", async () => {
      const d = await upload("Agent1", ids.LA1, { name: "mine.pdf", type: "application/pdf", bytes: PDF, description: "orig" });
      as("Agent1");
      expect((await callRoute(d.id!)).status).toBe(302);
      expect(await actions.updateLeadAttachmentDescription(d.id, "changed")).toEqual({ ok: false, error: "You can't access this file." });
      expect(await actions.deleteLeadAttachment(d.id)).toEqual({ ok: false, error: "You can't access this file." });
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: d.id! } });
      expect(row.description).toBe("orig");
      expect(fake.store.has(d.key!)).toBe(true);
      expect(await auditActions(d.id)).toContain("ATTACHMENT_ACCESS_DENIED");
    });

    it("the Admin can edit the description WITHOUT touching the stored file, and can delete", async () => {
      const d = await upload("Agent1", ids.LA1, { name: "doc.pdf", type: "application/pdf", bytes: PDF, description: "Passport copy" });
      const before = fake.store.get(d.key!);
      as("Admin");
      expect(await actions.updateLeadAttachmentDescription(d.id, "Passport copy — verified")).toEqual({ ok: true, description: "Passport copy — verified" });
      expect(fake.store.get(d.key!)).toBe(before); // same object, not re-uploaded
      expect(fake.removed).not.toContain(d.key);
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: d.id! } });
      expect(row).toMatchObject({ description: "Passport copy — verified", storageKey: d.key, fileSize: PDF.length, status: "READY" });
      expect(await actions.updateLeadAttachmentDescription(d.id, "   ")).toEqual({ ok: true, description: null });
      expect(await actions.deleteLeadAttachment(d.id)).toEqual({ ok: true });
      expect(await prisma.attachment.count({ where: { id: d.id } })).toBe(0);
      expect(fake.store.has(d.key!)).toBe(false);
      expect(await auditActions(d.id)).toEqual(expect.arrayContaining(["ATTACHMENT_UPLOADED", "ATTACHMENT_DESCRIPTION_UPDATED", "ATTACHMENT_DELETED"]));
    });

    it("a Manager can edit and delete on their team's lead", async () => {
      const d = await upload("Agent1", ids.LA1, { name: "team.pdf", type: "application/pdf", bytes: PDF });
      as("MgrTeam");
      expect(await actions.updateLeadAttachmentDescription(d.id, "reviewed")).toMatchObject({ ok: true });
      expect(await actions.deleteLeadAttachment(d.id)).toEqual({ ok: true });
    });

    it("an over-long description is clamped, never stored beyond the limit", async () => {
      const d = await upload("Agent1", ids.LA1, { name: "long.pdf", type: "application/pdf", bytes: PDF });
      as("Admin");
      const r = await actions.updateLeadAttachmentDescription(d.id, "x".repeat(1500));
      expect(r.ok && r.description?.length).toBe(500);
    });

    it("if storage can't delete the object, the record is kept and the user can simply retry", async () => {
      const d = await upload("Agent1", ids.LA1, { name: "keep.pdf", type: "application/pdf", bytes: PDF });
      as("Admin");
      fake.failRemove = true;
      const r = await actions.deleteLeadAttachment(d.id);
      expect(r).toMatchObject({ ok: false });
      expect(JSON.stringify(r)).not.toMatch(/R2|bucket|S3/i);
      expect(await prisma.attachment.count({ where: { id: d.id } })).toBe(1);
      fake.failRemove = false;
      expect(await actions.deleteLeadAttachment(d.id)).toEqual({ ok: true });
      expect(await prisma.attachment.count({ where: { id: d.id } })).toBe(0);
    });

    it("deleting when the object is already gone succeeds (missing object)", async () => {
      const d = await upload("Agent1", ids.LA1, { name: "gone.pdf", type: "application/pdf", bytes: PDF });
      fake.store.delete(d.key!);
      as("Admin");
      expect(await actions.deleteLeadAttachment(d.id)).toEqual({ ok: true });
    });
  });

  // ── download ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("open / download", () => {
    it("redirects to a short-lived signed URL that forces the served type and disposition", async () => {
      const pdf = await upload("Agent1", ids.LA1, { name: "Ünïcode \"quote\".pdf", type: "application/pdf", bytes: PDF });
      as("Agent1");
      const open = await callRoute(pdf.id!);
      expect(open.status).toBe(302);
      const loc = new URL(open.headers.get("location")!);
      expect(loc.searchParams.get("ct")).toBe("application/pdf");
      expect(loc.searchParams.get("cd")).toMatch(/^inline; filename=/);
      expect(open.headers.get("cache-control")).toBe("no-store");
      const dl = new URL((await callRoute(pdf.id!, "?download=1")).headers.get("location")!);
      expect(dl.searchParams.get("cd")).toMatch(/^attachment; filename=/);
      expect(await auditActions(pdf.id)).toEqual(expect.arrayContaining(["ATTACHMENT_OPENED", "ATTACHMENT_DOWNLOADED"]));
    });

    it("non-PDF / non-image types are ALWAYS served as a download", async () => {
      const d = await upload("Agent1", ids.LA1, { name: "notes.txt", type: "text/plain", bytes: new TextEncoder().encode("hello") });
      as("Agent1");
      const loc = new URL((await callRoute(d.id!)).headers.get("location")!);
      expect(loc.searchParams.get("cd")).toMatch(/^attachment;/);
      expect(loc.searchParams.get("ct")).toBe("text/plain");
    });

    it("the signed URL and object key are never written to the audit log", async () => {
      const d = await upload("Agent1", ids.LA1, { name: "a.pdf", type: "application/pdf", bytes: PDF });
      as("Agent1");
      await callRoute(d.id!);
      const logs = await prisma.auditLog.findMany({ where: { entityType: "Attachment", entityId: d.id } });
      expect(JSON.stringify(logs)).not.toMatch(/r2\.test|sig=|companies\//);
    });

    it("storage unavailable → a generic 503, no provider details", async () => {
      const d = await upload("Agent1", ids.LA1, { name: "a.pdf", type: "application/pdf", bytes: PDF });
      as("Agent1");
      fake.configured = false;
      const r = await callRoute(d.id!);
      expect(r.status).toBe(503);
      expect(await r.text()).not.toMatch(/R2|bucket|S3/i);
    });

    it("downloads are rate limited per account", async () => {
      const d = await upload("Agent1", ids.LA1, { name: "a.pdf", type: "application/pdf", bytes: PDF });
      as("Agent1");
      await prisma.rateLimitCounter.deleteMany({ where: { key: { startsWith: `acct:${actors.Agent1.id}|attachment-download` } } });
      let last = 302;
      for (let i = 0; i < 125; i++) last = (await callRoute(d.id!)).status;
      expect(last).toBe(429);
    });
  });

  // ── contact aggregation ────────────────────────────────────────────────────────────────────────────────────────────────
  describe("contact documents respect LEAD visibility", () => {
    it("shows each document with the lead it belongs to; hides leads the viewer can't open", async () => {
      await upload("Agent1", ids.LA1, { name: "from-la1.pdf", type: "application/pdf", bytes: PDF });
      await upload("Agent2", ids.LA2, { name: "from-la2.pdf", type: "application/pdf", bytes: PDF });
      await upload("AgentB", ids.LB1, { name: "other-company.pdf", type: "application/pdf", bytes: PDF });

      // Admin sees both leads of the contact …
      const admin = await queries.listContactLeadAttachments(ids.contactA, actors.Admin);
      expect(admin.items.map((i) => i.fileName).sort()).toEqual(["from-la1.pdf", "from-la2.pdf"]);
      expect(new Set(admin.items.map((i) => i.leadId))).toEqual(new Set([ids.LA1, ids.LA2]));
      expect(admin.items.every((i) => typeof i.leadRoute === "string" && i.leadRoute.length > 0)).toBe(true);
      expect(admin.total).toBe(2);

      // … Agent1 owns the CONTACT but only LA1 is theirs: LA2's document must not leak through the contact
      const agent1 = await queries.listContactLeadAttachments(ids.contactA, actors.Agent1);
      expect(agent1.items.map((i) => i.fileName)).toEqual(["from-la1.pdf"]);
      expect(agent1.total).toBe(1);

      // Agent2 has no access to the contact's other lead either way
      expect((await queries.listContactLeadAttachments(ids.contactA, actors.Agent2)).items.map((i) => i.fileName)).toEqual(["from-la2.pdf"]);

      // a Manager sees their team's lead only
      expect((await queries.listContactLeadAttachments(ids.contactA, actors.MgrTeam)).items.map((i) => i.fileName)).toEqual(["from-la1.pdf"]);

      // cross-company: contact B is not reachable from company A, and contact A's list never contains B's files
      expect((await queries.listContactLeadAttachments(ids.contactB, actors.Admin)).items).toEqual([]);
      expect((await queries.listContactLeadAttachments(ids.contactB, actors.AdminB)).items.map((i) => i.fileName)).toEqual(["other-company.pdf"]);
      expect([...admin.items, ...agent1.items].some((i) => i.fileName === "other-company.pdf")).toBe(false);
      // and no signed-out / missing viewer gets anything
      expect((await queries.listContactLeadAttachments(ids.contactA, null)).items).toEqual([]);
    });

    it("lists metadata only: it never loads file bytes or reads storage", async () => {
      await upload("Agent1", ids.LA1, { name: "m.pdf", type: "application/pdf", bytes: PDF });
      const before = fake.removed.length;
      const res = await queries.listContactLeadAttachments(ids.contactA, actors.Admin);
      expect(Object.keys(res.items[0]).sort()).toEqual(["createdAt", "description", "fileName", "fileSize", "fileType", "id", "leadId", "leadRoute", "uploadedBy"]);
      expect(fake.removed.length).toBe(before);
    });
  });

  // ── lifecycle ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("lead deletion cleans up storage", () => {
    it("deleting a lead removes its stored objects (and a failed purge is recorded for reconciliation)", async () => {
      const c = await prisma.contact.create({ data: { firstName: "Del", lastName: `D-${TAG}`, primaryEmail: `d-${TAG}@example.test`, companyId: "default-company", ownerId: actors.Agent1.id } });
      contactIds.push(c.id);
      const lead = await makeLead("LDEL", c.id, "Agent1");
      const d1 = await upload("Agent1", lead.id, { name: "d1.pdf", type: "application/pdf", bytes: PDF });
      const d2 = await upload("Agent1", lead.id, { name: "d2.pdf", type: "application/pdf", bytes: PDF });
      as("Admin");
      await leadActions.deleteLead(lead.id);
      expect(await prisma.attachment.count({ where: { leadId: lead.id } })).toBe(0);
      expect(fake.store.has(d1.key!) || fake.store.has(d2.key!)).toBe(false);

      // storage down during the purge → keys are written to the audit log
      const lead2 = await makeLead("LDEL2", c.id, "Agent1");
      const d3 = await upload("Agent1", lead2.id, { name: "d3.pdf", type: "application/pdf", bytes: PDF });
      as("Admin");
      fake.failRemove = true;
      await leadActions.deleteLead(lead2.id);
      fake.failRemove = false;
      const orphan = await prisma.auditLog.findFirst({ where: { action: "ATTACHMENT_STORAGE_ORPHANED", actorId: actors.Admin.id }, orderBy: { createdAt: "desc" } });
      expect(JSON.stringify(orphan?.metadata)).toContain(d3.key!);
    });
  });

  describe("database integrity", () => {
    it("a stored object must belong to a lead and a company (CHECK constraint)", async () => {
      await expect(prisma.attachment.create({ data: { fileName: "x.pdf", storageKey: `k-${TAG}-1`, status: "READY" } })).rejects.toThrow();
      await expect(prisma.attachment.create({ data: { fileName: "x.pdf", storageKey: `k-${TAG}-2`, leadId: ids.LA1, status: "READY" } })).rejects.toThrow();
    });

    it("object keys are unique", async () => {
      const a = await prisma.attachment.create({ data: { fileName: "x.pdf", storageKey: `k-${TAG}-3`, leadId: ids.LA1, companyId: "default-company", status: "READY" } });
      await expect(prisma.attachment.create({ data: { fileName: "y.pdf", storageKey: `k-${TAG}-3`, leadId: ids.LA1, companyId: "default-company", status: "READY" } })).rejects.toThrow();
      await prisma.attachment.delete({ where: { id: a.id } });
    });

    it("pre-existing placeholder rows (no storage key) are never listed or openable", async () => {
      const legacy = await prisma.attachment.create({ data: { fileName: "legacy.pdf", fileUrl: "https://example.test/legacy.pdf", leadId: ids.LA1, status: "READY" } });
      as("Admin");
      expect((await queries.listLeadAttachments(ids.LA1, actors.Admin)).items.find((i) => i.id === legacy.id)).toBeUndefined();
      expect((await callRoute(legacy.id)).status).toBe(404);
      await prisma.attachment.delete({ where: { id: legacy.id } });
    });
  });
});
