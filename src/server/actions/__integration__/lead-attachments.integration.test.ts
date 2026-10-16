// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

// REAL-DATABASE proof of Lead document storage on the VPS disk: authorisation (lead / company / role), IDOR, cross-company isolation, the
// upload (request -> same-origin PUT of the bytes -> complete) with server-side size and content verification, Admin/Manager-only edit +
// delete, Contact aggregation that respects Lead visibility, consistency between PostgreSQL and the file store, the audit trail, and the
// handling of rows whose key is not one of ours. Files are REAL files in a temporary directory; nothing is faked, and no storage credentials
// of any kind are present in the environment. Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL with this repo's migrations applied.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "compass-int-uploads-"));
if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
  process.env.UPLOAD_STORAGE_DIR = UPLOAD_DIR;
  process.env.UPLOAD_MIN_FREE_MB = "0";
}

type Role = "ADMIN" | "MANAGER" | "TRAVEL_AGENT" | "TICKETING_AGENT" | "FLIGHT_EXPERT" | "MARKETING_AGENT";
type Actor = { id: string; role: Role; status: string; companyId: string; fullName: string; email: string; phone: string | null; paymentPermissions: string[]; bookingPermissions: string[]; sessionCreatedAt: Date };

let currentActor: Actor | null = null;
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));

const TAG = `att-${Date.now()}`;
const PDF = new TextEncoder().encode("%PDF-1.7\n%test document\n");
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const DOCX = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const EXE = new TextEncoder().encode("MZ\x90\x00\x03\x00\x00\x00");

describe.skipIf(!enabled)("Lead documents — real PostgreSQL, real local files", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let actions: typeof import("../lead-attachments");
  let queries: typeof import("@/server/queries/lead-attachments");
  let cleanup: typeof import("@/server/attachments/cleanup");
  let route: typeof import("@/app/api/attachments/[id]/file/route");
  let uploadRoute: typeof import("@/app/api/attachments/[id]/upload/route");
  let leadActions: typeof import("../leads");
  let contactActions: typeof import("../contacts");
  let local: typeof import("@/server/storage/local");
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

  const getReq = (id: string, qs = "") => new NextRequest(`http://localhost/api/attachments/${id}/file${qs}`);
  const callRoute = (id: string, qs = "") => route.GET(getReq(id, qs), { params: Promise.resolve({ id }) });

  /** The browser's PUT of the bytes. `length` overrides the Content-Length header (undefined = the real length, null = none). */
  async function putBytes(id: string, bytes: Uint8Array | ReadableStream<Uint8Array>, opts: { length?: number | null; headers?: Record<string, string> } = {}) {
    const headers = new Headers({ host: "localhost", "content-type": "application/pdf", ...(opts.headers ?? {}) });
    const length = opts.length === undefined ? (bytes instanceof Uint8Array ? bytes.length : null) : opts.length;
    if (length !== null) headers.set("content-length", String(length));
    const init: RequestInit & { duplex?: "half" } = { method: "PUT", headers, body: bytes as BodyInit };
    if (!(bytes instanceof Uint8Array)) init.duplex = "half";
    return uploadRoute.PUT(new NextRequest(`http://localhost/api/attachments/${id}/upload`, init as ConstructorParameters<typeof NextRequest>[1]), { params: Promise.resolve({ id }) });
  }
  const stream = (bytes: Uint8Array, chunk = 5) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk));
        c.close();
      },
    });

  /** A full legitimate upload as `who`: request -> PUT the bytes to the upload route -> complete. */
  async function upload(who: string, leadId: string, file: { name: string; type?: string; bytes: Uint8Array; description?: string }) {
    as(who);
    const req = await actions.requestLeadAttachmentUpload({ leadId, fileName: file.name, contentType: file.type ?? "", size: file.bytes.length, description: file.description });
    if (!req.ok) return { req, put: null as null, done: null as null };
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: req.attachmentId } });
    const put = await putBytes(req.attachmentId, file.bytes);
    const done = put.status === 200 ? await actions.completeLeadAttachmentUpload(req.attachmentId) : ({ ok: false, error: "put failed" } as const);
    return { req, put, done, id: req.attachmentId, key: row.storageKey! };
  }
  const onDisk = (key: string) => fs.existsSync(local.pathForKey(key, UPLOAD_DIR));
  const readBack = (key: string) => fsp.readFile(local.pathForKey(key, UPLOAD_DIR));
  /** Everything stored under the upload root (relative, "/"-separated), excluding the temp area. */
  async function storedFiles(): Promise<string[]> {
    const out: string[] = [];
    for (const shard of await fsp.readdir(UPLOAD_DIR)) {
      if (shard === ".tmp") continue;
      for (const f of await fsp.readdir(path.join(UPLOAD_DIR, shard))) out.push(`${shard}/${f}`);
    }
    return out.sort();
  }
  const tempFiles = async () => (fs.existsSync(path.join(UPLOAD_DIR, ".tmp")) ? fsp.readdir(path.join(UPLOAD_DIR, ".tmp")) : []);
  const auditActions = async (attachmentId?: string) =>
    (await prisma.auditLog.findMany({ where: { entityType: "Attachment", ...(attachmentId ? { entityId: attachmentId } : {}), createdAt: { gte: new Date(Date.now() - 600_000) } }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
  /** Makes every filesystem call under the upload root fail with `code` (restored by the returned function). */
  function breakFs(method: "open" | "unlink" | "mkdir", code: string) {
    const real = (fsp[method] as (...a: unknown[]) => Promise<unknown>).bind(fsp);
    const spy = vi.spyOn(fsp, method as "open").mockImplementation((async (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith(UPLOAD_DIR)) throw Object.assign(new Error(`${code}: simulated failure at '${args[0]}'`), { code });
      return real(...args);
    }) as never);
    return () => spy.mockRestore();
  }

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    actions = await import("../lead-attachments");
    queries = await import("@/server/queries/lead-attachments");
    cleanup = await import("@/server/attachments/cleanup");
    route = await import("@/app/api/attachments/[id]/file/route");
    uploadRoute = await import("@/app/api/attachments/[id]/upload/route");
    leadActions = await import("../leads");
    contactActions = await import("../contacts");
    local = await import("@/server/storage/local");
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
    await fsp.rm(UPLOAD_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    // every test starts from a clean slate for the fixture leads
    await prisma.attachment.deleteMany({ where: { leadId: { in: [ids.LA1, ids.LA2, ids.LB1] } } });
    for (const shard of fs.existsSync(UPLOAD_DIR) ? await fsp.readdir(UPLOAD_DIR) : []) await fsp.rm(path.join(UPLOAD_DIR, shard), { recursive: true, force: true });
    process.env.UPLOAD_STORAGE_DIR = UPLOAD_DIR;
    process.env.UPLOAD_MIN_FREE_MB = "0";
    local.resetStatusCacheForTests();
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
        expect(r.put?.status, f.name).toBe(200);
        expect(r.done, f.name).toEqual({ ok: true, attachmentId: r.id });
      }
      const list = await queries.listLeadAttachments(ids.LA1, actors.Agent1);
      expect(list.items.map((i) => i.fileName).sort()).toEqual(["form.docx", "id.png", "passport.pdf"]);
      expect(await storedFiles()).toHaveLength(3);
    });

    it("the record is tied to the lead, contact, company and uploader, with an opaque key that never reaches the browser", async () => {
      const r = await upload("Agent1", ids.LA1, { name: "../../etc/Passport Copy.pdf", type: "application/pdf", bytes: PDF, description: "Passport copy" });
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: r.id! } });
      expect(row).toMatchObject({ leadId: ids.LA1, contactId: ids.contactA, companyId: "default-company", uploadedById: actors.Agent1.id, status: "READY", fileType: "application/pdf", description: "Passport copy", fileName: "Passport Copy.pdf" });
      expect(row.storageKey).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{64}$/);
      expect(row.storageKey).not.toMatch(/Passport|etc|default-company|\.\./);
      expect(row.storageKey).not.toContain(ids.LA1);
      expect(Buffer.from(await readBack(row.storageKey!)).equals(Buffer.from(PDF))).toBe(true);
      // the metadata queries never select the key
      const list = await queries.listLeadAttachments(ids.LA1, actors.Agent1);
      expect(JSON.stringify(list)).not.toContain(row.storageKey!);
      expect(Object.keys(list.items[0])).not.toContain("storageKey");
      // the browser is told only a same-origin address for exactly this attachment
      const req = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "x.pdf", contentType: "application/pdf", size: PDF.length });
      expect(req.ok && req.uploadUrl).toBe(`/api/attachments/${req.ok ? req.attachmentId : ""}/upload`);
      expect(JSON.stringify(req)).not.toMatch(/https?:|UPLOAD_DIR|compass-int-uploads/i);
    });

    it.skipIf(process.platform === "win32")("the stored file is private to the application user (0600) in a private directory (0700)", async () => {
      const r = await upload("Agent1", ids.LA1, { name: "perm.pdf", type: "application/pdf", bytes: PDF });
      const p = local.pathForKey(r.key!, UPLOAD_DIR);
      expect((await fsp.stat(p)).mode & 0o777).toBe(0o600);
      expect((await fsp.stat(path.dirname(p))).mode & 0o777).toBe(0o700);
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
      expect(await storedFiles()).toEqual([]);
    });

    it("an executable renamed to .pdf is refused when the bytes arrive: nothing is published and the record is removed", async () => {
      const r = await upload("Agent1", ids.LA1, { name: "statement.pdf", type: "application/pdf", bytes: EXE });
      expect(r.req.ok).toBe(true);
      expect(r.put?.status).toBe(422);
      expect(await prisma.attachment.count({ where: { id: r.id } })).toBe(0);
      expect(onDisk(r.key!)).toBe(false);
      expect(await storedFiles()).toEqual([]);
      expect(await tempFiles()).toEqual([]);
      expect(await auditActions(r.id)).toContain("ATTACHMENT_UPLOAD_REJECTED");
    });

    it("a body whose declared Content-Length is not the authorised size is refused before any byte is read", async () => {
      as("Agent1");
      for (const length of [PDF.length + 1, PDF.length - 1, 999_999_999]) {
        const req = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "a.pdf", contentType: "application/pdf", size: PDF.length });
        if (!req.ok) throw new Error("setup");
        let pulled = false;
        const body = new ReadableStream<Uint8Array>({ pull() { pulled = true; } }, { highWaterMark: 0 }); // pulls only if something reads it
        const res = await putBytes(req.attachmentId, body, { length });
        expect([400, 413], String(length)).toContain(res.status);
        expect(pulled, `body must not be read for length ${length}`).toBe(false);
        expect(await prisma.attachment.count({ where: { id: req.attachmentId } })).toBe(0);
      }
      expect(await storedFiles()).toEqual([]);
    });

    it("a streamed body with no Content-Length that runs past the authorised size is cut off (413) and nothing is stored", async () => {
      as("Agent1");
      const req = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "a.pdf", contentType: "application/pdf", size: PDF.length });
      if (!req.ok) throw new Error("setup");
      const tooMuch = new Uint8Array(PDF.length + 500);
      tooMuch.set(PDF);
      const res = await putBytes(req.attachmentId, stream(tooMuch, 16), { length: null });
      expect(res.status).toBe(413);
      expect(await storedFiles()).toEqual([]);
      expect(await tempFiles()).toEqual([]);
      expect(await prisma.attachment.count({ where: { id: req.attachmentId } })).toBe(0);
    });

    it("a streamed body shorter than authorised is refused (400) and nothing is stored", async () => {
      as("Agent1");
      const req = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "a.pdf", contentType: "application/pdf", size: PDF.length + 40 });
      if (!req.ok) throw new Error("setup");
      const res = await putBytes(req.attachmentId, stream(PDF), { length: null });
      expect(res.status).toBe(400);
      expect(await storedFiles()).toEqual([]);
      expect(await prisma.attachment.count({ where: { id: req.attachmentId } })).toBe(0);
    });

    it("complete RE-VERIFIES the stored file: a wrong-size file that appears on disk without the route is rejected and removed", async () => {
      as("Agent1");
      const req = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "a.pdf", contentType: "application/pdf", size: 50 });
      if (!req.ok) throw new Error("setup");
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: req.attachmentId } });
      await fsp.mkdir(path.dirname(local.pathForKey(row.storageKey!, UPLOAD_DIR)), { recursive: true });
      await fsp.writeFile(local.pathForKey(row.storageKey!, UPLOAD_DIR), PDF); // not 50 bytes
      expect(await actions.completeLeadAttachmentUpload(req.attachmentId)).toMatchObject({ ok: false });
      expect(await prisma.attachment.count({ where: { id: req.attachmentId } })).toBe(0);
      expect(onDisk(row.storageKey!)).toBe(false);
    });

    it("complete RE-VERIFIES the content: an executable placed on disk under a .pdf record is rejected and removed", async () => {
      as("Agent1");
      const req = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "a.pdf", contentType: "application/pdf", size: EXE.length });
      if (!req.ok) throw new Error("setup");
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: req.attachmentId } });
      await fsp.mkdir(path.dirname(local.pathForKey(row.storageKey!, UPLOAD_DIR)), { recursive: true });
      await fsp.writeFile(local.pathForKey(row.storageKey!, UPLOAD_DIR), EXE);
      expect(await actions.completeLeadAttachmentUpload(req.attachmentId)).toMatchObject({ ok: false });
      expect(await prisma.attachment.count({ where: { id: req.attachmentId } })).toBe(0);
      expect(onDisk(row.storageKey!)).toBe(false);
    });

    it("completing without the bytes having been uploaded fails and leaves no visible file", async () => {
      as("Agent1");
      const req = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "a.pdf", contentType: "application/pdf", size: PDF.length });
      if (!req.ok) throw new Error("setup");
      expect(await actions.completeLeadAttachmentUpload(req.attachmentId)).toMatchObject({ ok: false });
      expect((await queries.listLeadAttachments(ids.LA1, actors.Agent1)).items.find((i) => i.id === req.attachmentId)).toBeUndefined();
    });

    it("a PENDING upload is never listed or downloadable; only the uploader can send its bytes or complete it", async () => {
      as("Agent1");
      const req = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "pending.pdf", contentType: "application/pdf", size: PDF.length });
      if (!req.ok) throw new Error("setup");
      as("Admin"); // sees the lead, but did not start this upload
      expect((await putBytes(req.attachmentId, PDF)).status).toBe(404);
      as("Agent1");
      expect((await putBytes(req.attachmentId, PDF)).status).toBe(200);
      expect((await queries.listLeadAttachments(ids.LA1, actors.Agent1)).items.find((i) => i.id === req.attachmentId)).toBeUndefined();
      expect((await callRoute(req.attachmentId)).status).toBe(404);
      as("Admin");
      expect(await actions.completeLeadAttachmentUpload(req.attachmentId)).toMatchObject({ ok: false });
      expect((await prisma.attachment.findUniqueOrThrow({ where: { id: req.attachmentId } })).status).toBe("PENDING");
      as("Agent1");
      expect(await actions.completeLeadAttachmentUpload(req.attachmentId)).toMatchObject({ ok: true });
    });

    it("storage not set up / almost full is a clear, safe message and leaves no record", async () => {
      as("Agent1");
      const before = await prisma.attachment.count({ where: { leadId: ids.LA1 } });
      // not set up: the configured location is not a directory
      const notADir = path.join(UPLOAD_DIR, "i-am-a-file");
      await fsp.writeFile(notADir, "x");
      process.env.UPLOAD_STORAGE_DIR = notADir;
      local.resetStatusCacheForTests();
      const notReady = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "a.pdf", contentType: "application/pdf", size: 10 });
      expect(notReady).toMatchObject({ ok: false });
      expect(JSON.stringify(notReady)).not.toMatch(/bucket|S3|secret|credential|compass-int|\/tmp|\\\\/i);
      // almost full: less free space than the reserve
      process.env.UPLOAD_STORAGE_DIR = UPLOAD_DIR;
      process.env.UPLOAD_MIN_FREE_MB = "999999999";
      local.resetStatusCacheForTests();
      const full = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "a.pdf", contentType: "application/pdf", size: 10 });
      if ((await local.status()).state === "low_space") {
        expect(full).toMatchObject({ ok: false });
        expect(JSON.stringify(full)).toMatch(/full/i);
      }
      expect(await prisma.attachment.count({ where: { leadId: ids.LA1 } })).toBe(before);
    });

    it("a filesystem failure while completing leaves the row PENDING for a retry; the sweep removes abandoned ones (file and row)", async () => {
      as("Agent1");
      const req = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "a.pdf", contentType: "application/pdf", size: PDF.length });
      if (!req.ok) throw new Error("setup");
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: req.attachmentId } });
      expect((await putBytes(req.attachmentId, PDF)).status).toBe(200);
      const restore = breakFs("open", "EIO");
      const failed = await actions.completeLeadAttachmentUpload(req.attachmentId);
      restore();
      expect(failed).toMatchObject({ ok: false });
      expect(JSON.stringify(failed)).not.toMatch(/EIO|compass-int|simulated/);
      expect((await prisma.attachment.findUniqueOrThrow({ where: { id: req.attachmentId } })).status).toBe("PENDING");
      // not yet stale
      expect((await cleanup.sweepStalePendingAttachments()).removed).toBe(0);
      expect(onDisk(row.storageKey!)).toBe(true);
      // two hours later it is abandoned
      const swept = await cleanup.sweepStalePendingAttachments(Date.now() + 2 * 3600_000);
      expect(swept.removed).toBeGreaterThanOrEqual(1);
      expect(await prisma.attachment.count({ where: { id: req.attachmentId } })).toBe(0);
      expect(onDisk(row.storageKey!)).toBe(false);
    });

    it("the stale sweep keeps a row whose file it could not remove (retried next run) and never touches READY attachments", async () => {
      const ready = await upload("Agent1", ids.LA1, { name: "keep.pdf", type: "application/pdf", bytes: PDF });
      as("Agent1");
      const req = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "stuck.pdf", contentType: "application/pdf", size: PDF.length });
      if (!req.ok) throw new Error("setup");
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: req.attachmentId } });
      await putBytes(req.attachmentId, PDF);
      const far = Date.now() + 5 * 3600_000;
      const restore = breakFs("unlink", "EPERM");
      const first = await cleanup.sweepStalePendingAttachments(far);
      restore();
      expect(first.failed).toBeGreaterThanOrEqual(1);
      expect(await prisma.attachment.count({ where: { id: req.attachmentId } })).toBe(1); // row kept
      expect(onDisk(row.storageKey!)).toBe(true); //     file kept
      const second = await cleanup.sweepStalePendingAttachments(far);
      expect(second.removed).toBeGreaterThanOrEqual(1);
      expect(await prisma.attachment.count({ where: { id: req.attachmentId } })).toBe(0);
      expect(onDisk(row.storageKey!)).toBe(false);
      // the completed attachment, however old, is untouched
      expect(onDisk(ready.key!)).toBe(true);
      expect((await prisma.attachment.findUniqueOrThrow({ where: { id: ready.id! } })).status).toBe("READY");
    });

    it("the sweep also clears temp files left by a cut-off upload, but only stale ones", async () => {
      await fsp.mkdir(path.join(UPLOAD_DIR, ".tmp"), { recursive: true });
      const stale = path.join(UPLOAD_DIR, ".tmp", `${"a".repeat(32)}.part`);
      const fresh = path.join(UPLOAD_DIR, ".tmp", `${"b".repeat(32)}.part`);
      await fsp.writeFile(stale, "x");
      await fsp.writeFile(fresh, "x");
      await fsp.utimes(stale, new Date(Date.now() - 5 * 3600_000), new Date(Date.now() - 5 * 3600_000));
      const swept = await cleanup.sweepStalePendingAttachments();
      expect(swept.tempFilesRemoved).toBe(1);
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
    });

    it("a failed attempt is reported with stage / kind / status only, audited, and the retry then works", async () => {
      as("Agent1");
      const first = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "retry.pdf", contentType: "application/pdf", size: PDF.length });
      if (!first.ok) throw new Error("setup");
      await actions.abandonLeadAttachmentUpload(first.attachmentId, { stage: "put", kind: "blocked", status: 0 });
      expect(await prisma.attachment.count({ where: { id: first.attachmentId } })).toBe(0);
      const failed = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "Attachment", entityId: first.attachmentId, action: "ATTACHMENT_UPLOAD_FAILED" } });
      expect(failed.metadata).toMatchObject({ stage: "put", kind: "blocked", status: 0, leadId: ids.LA1, companyId: "default-company" });
      expect(JSON.stringify(failed.metadata)).not.toMatch(/https?:|sig=/);
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

    it("the browser giving up (abandon) removes the pending record AND any bytes it had already sent; a cancelled upload leaves nothing", async () => {
      as("Agent1");
      const req = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "a.pdf", contentType: "application/pdf", size: PDF.length });
      if (!req.ok) throw new Error("setup");
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: req.attachmentId } });
      expect((await putBytes(req.attachmentId, PDF)).status).toBe(200);
      expect(onDisk(row.storageKey!)).toBe(true);
      expect(await actions.abandonLeadAttachmentUpload(req.attachmentId, { stage: "cancelled", kind: "other", status: 0 })).toEqual({ ok: true });
      expect(await prisma.attachment.count({ where: { id: req.attachmentId } })).toBe(0);
      expect(onDisk(row.storageKey!)).toBe(false);
      expect(await storedFiles()).toEqual([]);
      // abandoning again, or an upload that never sent a byte, is a harmless no-op
      expect(await actions.abandonLeadAttachmentUpload(req.attachmentId)).toEqual({ ok: true });
    });

    it("every upload is audited with actor, lead and company — and never the file name, key or path", async () => {
      const r = await upload("Agent1", ids.LA1, { name: "Secret Name.pdf", type: "application/pdf", bytes: PDF });
      const log = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "Attachment", entityId: r.id, action: "ATTACHMENT_UPLOADED" } });
      expect(log.actorId).toBe(actors.Agent1.id);
      expect(log.metadata).toMatchObject({ leadId: ids.LA1, contactId: ids.contactA, companyId: "default-company" });
      expect(JSON.stringify(log)).not.toContain("Secret Name");
      expect(JSON.stringify(log)).not.toContain(r.key!);
      expect(JSON.stringify(log)).not.toContain("compass-int-uploads");
    });
  });

  // ── the upload route itself ──────────────────────────────────────────────────────────────────────────────────────────────
  describe("PUT /api/attachments/{id}/upload", () => {
    async function pending(who = "Agent1", leadId = ids.LA1, size = PDF.length) {
      as(who);
      const req = await actions.requestLeadAttachmentUpload({ leadId, fileName: "p.pdf", contentType: "application/pdf", size });
      if (!req.ok) throw new Error("setup");
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: req.attachmentId } });
      return { id: req.attachmentId, key: row.storageKey! };
    }

    it("signed-out, wrong-role, non-owner, other-lead, other-company and made-up requests all get the same refusal and store nothing", async () => {
      const mine = await pending();
      as(null);
      expect((await putBytes(mine.id, PDF)).status).toBe(401);
      for (const who of ["Ticketing", "Admin", "Agent2", "MgrTeam", "AdminB", "AgentB"]) {
        as(who);
        const res = await putBytes(mine.id, PDF);
        expect(res.status, who).toBe(404);
      }
      as("Agent1");
      expect((await putBytes("does-not-exist", PDF)).status).toBe(404);
      expect(onDisk(mine.key)).toBe(false);
      expect(await storedFiles()).toEqual([]);
      const denied = await prisma.auditLog.findMany({ where: { action: "ATTACHMENT_ACCESS_DENIED", entityType: "Attachment", createdAt: { gte: new Date(Date.now() - 60_000) } } });
      expect(denied.length).toBeGreaterThanOrEqual(5);
    });

    it("an attachment id from another company's pending upload is invisible (404), and the lead in the record - not the request - decides", async () => {
      const other = await pending("AgentB", ids.LB1);
      as("Agent1");
      expect((await putBytes(other.id, PDF)).status).toBe(404);
      as("AdminB");
      expect((await putBytes(other.id, PDF)).status).toBe(404); // not the uploader
      as("AgentB");
      expect((await putBytes(other.id, PDF)).status).toBe(200);
    });

    it("a request that names another site as its origin is refused; the page's own origin is accepted", async () => {
      const p = await pending();
      expect((await putBytes(p.id, PDF, { headers: { origin: "https://evil.example" } })).status).toBe(403);
      expect((await putBytes(p.id, PDF, { headers: { origin: "not a url" } })).status).toBe(403);
      expect(onDisk(p.key)).toBe(false);
      expect((await putBytes(p.id, PDF, { headers: { origin: "http://localhost" } })).status).toBe(200);
    });

    it("the request's Content-Type and any name are ignored: the stored type is the server's own", async () => {
      const p = await pending();
      expect((await putBytes(p.id, PDF, { headers: { "content-type": "text/html", "x-file-name": "../../evil.html" } })).status).toBe(200);
      expect(await actions.completeLeadAttachmentUpload(p.id)).toMatchObject({ ok: true });
      expect((await prisma.attachment.findUniqueOrThrow({ where: { id: p.id } })).fileType).toBe("application/pdf");
    });

    it("a duplicate PUT never overwrites the first: it is a 409 and the original bytes stand", async () => {
      const p = await pending();
      expect((await putBytes(p.id, PDF)).status).toBe(200);
      const other = new TextEncoder().encode("%PDF-1.7\n%diff document\n");
      expect(other.length).toBe(PDF.length);
      expect((await putBytes(p.id, other)).status).toBe(409);
      expect(Buffer.from(await readBack(p.key)).equals(Buffer.from(PDF))).toBe(true);
      expect(await tempFiles()).toEqual([]);
    });

    it("concurrent PUTs of one attachment: exactly one is accepted, the rest are 409, and the file is complete and valid", async () => {
      const p = await pending();
      const variants = Array.from({ length: 6 }, (_, i) => new TextEncoder().encode(`%PDF-1.7\n%variant ${i}%\n`.padEnd(PDF.length, "x")));
      expect(new Set(variants.map((v) => v.length)).size).toBe(1);
      const p2 = await pending("Agent1", ids.LA1, variants[0].length);
      const statuses = (await Promise.all(variants.map((v) => putBytes(p2.id, v)))).map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(variants.length - 1);
      const written = Buffer.from(await readBack(p2.key));
      expect(variants.some((v) => Buffer.from(v).equals(written))).toBe(true); // the winner's bytes, whole - never an interleaving
      expect(await actions.completeLeadAttachmentUpload(p2.id)).toMatchObject({ ok: true });
      expect(await tempFiles()).toEqual([]);
      void p;
    });

    it("duplicate and concurrent COMPLETION is idempotent: one READY row, one ATTACHMENT_UPLOADED audit, one activity entry", async () => {
      const p = await pending();
      await putBytes(p.id, PDF);
      const activityBefore = await prisma.activity.count({ where: { leadId: ids.LA1, type: "DOCUMENT_ADDED" } });
      const results = await Promise.all([1, 2, 3, 4].map(() => actions.completeLeadAttachmentUpload(p.id)));
      expect(results.every((r) => r.ok)).toBe(true);
      expect(await actions.completeLeadAttachmentUpload(p.id)).toEqual({ ok: true, attachmentId: p.id });
      expect((await prisma.attachment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("READY");
      expect((await auditActions(p.id)).filter((a) => a === "ATTACHMENT_UPLOADED")).toHaveLength(1);
      expect((await prisma.activity.count({ where: { leadId: ids.LA1, type: "DOCUMENT_ADDED" } })) - activityBefore).toBe(1);
    });

    it("a disk-full condition while receiving is a generic 507 and leaves no partial file", async () => {
      const p = await pending();
      process.env.UPLOAD_MIN_FREE_MB = "999999999"; // the reserve is now larger than any disk
      local.resetStatusCacheForTests();
      const res = await putBytes(p.id, PDF);
      if ((await local.status()).state === "low_space") {
        expect(res.status).toBe(507);
        const text = await res.text();
        expect(text).not.toMatch(/compass-int|\/tmp|\\\\|ENOSPC|UPLOAD_/);
      }
      expect(await storedFiles()).toEqual([]);
      expect(await tempFiles()).toEqual([]);
    });

    it("an unwritable store is a generic 503 (no path, no code), never a 500 with internals", async () => {
      const p = await pending();
      const restore = breakFs("mkdir", "EACCES");
      const res = await putBytes(p.id, PDF);
      restore();
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).not.toMatch(/EACCES|compass-int|simulated|\/tmp|\\\\/);
      expect(await storedFiles()).toEqual([]);
    });

    it("an empty body is refused", async () => {
      const p = await pending();
      expect((await putBytes(p.id, new Uint8Array(0), { length: 0 })).status).toBe(400);
      expect(await prisma.attachment.count({ where: { id: p.id } })).toBe(0);
    });

    it("the route is outside the proxy matcher, so Next never buffers the request body", () => {
      const proxy = fs.readFileSync(path.join(process.cwd(), "src", "proxy.ts"), "utf-8");
      const matcher = proxy.slice(proxy.indexOf("export const config"));
      expect(matcher).not.toMatch(/api\/attachments|\/api\//);
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
      expect(own.status).toBe(200);
      expect(Buffer.from(await own.arrayBuffer()).equals(Buffer.from(PDF))).toBe(true);
      const denied = await Promise.all([docA2.id, docB.id, "no-such-id"].map((id) => callRoute(id)));
      for (const r of denied) {
        expect(r.status).toBe(404);
        expect(r.headers.get("location")).toBeNull();
        expect(r.headers.get("content-disposition")).toBeNull();
      }
      const bodies = await Promise.all(denied.map((r) => r.text()));
      expect(new Set(bodies).size).toBe(1);
      for (const body of bodies) {
        expect(body).not.toContain(docB.key);
        expect(body).not.toContain("compass-int");
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
      expect(onDisk(docA1.key) && onDisk(docB.key)).toBe(true);
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
      expect((await callRoute(d.id!)).status).toBe(200);
      expect(await actions.updateLeadAttachmentDescription(d.id, "changed")).toEqual({ ok: false, error: "You can't access this file." });
      expect(await actions.deleteLeadAttachment(d.id)).toEqual({ ok: false, error: "You can't access this file." });
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: d.id! } });
      expect(row.description).toBe("orig");
      expect(onDisk(d.key!)).toBe(true);
      expect(await auditActions(d.id)).toContain("ATTACHMENT_ACCESS_DENIED");
    });

    it("the Admin can edit the description WITHOUT touching the stored file, and can delete (the file is removed from disk)", async () => {
      const d = await upload("Agent1", ids.LA1, { name: "doc.pdf", type: "application/pdf", bytes: PDF, description: "Passport copy" });
      const p = local.pathForKey(d.key!, UPLOAD_DIR);
      const before = await fsp.stat(p);
      as("Admin");
      expect(await actions.updateLeadAttachmentDescription(d.id, "Passport copy — verified")).toEqual({ ok: true, description: "Passport copy — verified" });
      const after = await fsp.stat(p);
      expect(after.mtimeMs).toBe(before.mtimeMs); // same file, not rewritten
      expect(Buffer.from(await fsp.readFile(p)).equals(Buffer.from(PDF))).toBe(true);
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: d.id! } });
      expect(row).toMatchObject({ description: "Passport copy — verified", storageKey: d.key, fileSize: PDF.length, status: "READY" });
      expect(await actions.updateLeadAttachmentDescription(d.id, "   ")).toEqual({ ok: true, description: null });
      expect(await actions.deleteLeadAttachment(d.id)).toEqual({ ok: true });
      expect(await prisma.attachment.count({ where: { id: d.id } })).toBe(0);
      expect(onDisk(d.key!)).toBe(false);
      expect(await storedFiles()).toEqual([]);
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

    it("if the file can't be deleted, the record is kept and the user can simply retry", async () => {
      const d = await upload("Agent1", ids.LA1, { name: "keep.pdf", type: "application/pdf", bytes: PDF });
      as("Admin");
      const restore = breakFs("unlink", "EPERM");
      const r = await actions.deleteLeadAttachment(d.id);
      restore();
      expect(r).toMatchObject({ ok: false });
      expect(JSON.stringify(r)).not.toMatch(/bucket|S3|EPERM|compass-int/i);
      expect(await prisma.attachment.count({ where: { id: d.id } })).toBe(1);
      expect(onDisk(d.key!)).toBe(true);
      expect(await actions.deleteLeadAttachment(d.id)).toEqual({ ok: true });
      expect(await prisma.attachment.count({ where: { id: d.id } })).toBe(0);
    });

    it("deleting when the file is already gone succeeds (missing file)", async () => {
      const d = await upload("Agent1", ids.LA1, { name: "gone.pdf", type: "application/pdf", bytes: PDF });
      await fsp.rm(local.pathForKey(d.key!, UPLOAD_DIR));
      as("Admin");
      expect(await actions.deleteLeadAttachment(d.id)).toEqual({ ok: true });
    });
  });

  // ── download ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("open / download", () => {
    it("streams the file with the type and disposition the SERVER chose, never a path or a redirect", async () => {
      const pdf = await upload("Agent1", ids.LA1, { name: "Ünïcode \"quote\".pdf", type: "application/pdf", bytes: PDF });
      as("Agent1");
      const open = await callRoute(pdf.id!);
      expect(open.status).toBe(200);
      expect(open.headers.get("location")).toBeNull();
      expect(open.headers.get("content-type")).toBe("application/pdf");
      expect(open.headers.get("content-disposition")).toMatch(/^inline; filename=/);
      expect(open.headers.get("content-length")).toBe(String(PDF.length));
      expect(open.headers.get("x-content-type-options")).toBe("nosniff");
      expect(open.headers.get("cache-control")).toBe("private, no-store");
      expect(open.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(Buffer.from(await open.arrayBuffer()).equals(Buffer.from(PDF))).toBe(true);
      const dl = await callRoute(pdf.id!, "?download=1");
      expect(dl.headers.get("content-disposition")).toMatch(/^attachment; filename=/);
      await dl.arrayBuffer();
      expect(await auditActions(pdf.id)).toEqual(expect.arrayContaining(["ATTACHMENT_OPENED", "ATTACHMENT_DOWNLOADED"]));
    });

    it("non-PDF / non-image types are ALWAYS served as a download", async () => {
      const d = await upload("Agent1", ids.LA1, { name: "notes.txt", type: "text/plain", bytes: new TextEncoder().encode("hello") });
      as("Agent1");
      const r = await callRoute(d.id!);
      expect(r.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(r.headers.get("content-type")).toBe("text/plain");
      expect(await r.text()).toBe("hello");
    });

    it("an uploaded file can never be served as HTML: the type comes from the record, not from the bytes or the request", async () => {
      // a text file whose CONTENT is HTML is refused at upload (the text signature rejects markup) …
      const html = await upload("Agent1", ids.LA1, { name: "page.txt", type: "text/plain", bytes: new TextEncoder().encode("<html><script>alert(1)</script></html>") });
      expect(html.put?.status).toBe(422);
      // … and whatever is stored is always labelled with the validated type
      const d = await upload("Agent1", ids.LA1, { name: "ok.txt", type: "text/plain", bytes: new TextEncoder().encode("plain words") });
      as("Agent1");
      const r = await callRoute(d.id!);
      expect(r.headers.get("content-type")).toBe("text/plain");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("the object key and the file's location are never written to the audit log or sent in any response", async () => {
      const d = await upload("Agent1", ids.LA1, { name: "a.pdf", type: "application/pdf", bytes: PDF });
      as("Agent1");
      const r = await callRoute(d.id!);
      for (const [, v] of r.headers) expect(v).not.toContain(d.key!);
      await r.arrayBuffer();
      const logs = await prisma.auditLog.findMany({ where: { entityType: "Attachment", entityId: d.id } });
      expect(JSON.stringify(logs)).not.toMatch(new RegExp(`${d.key!.slice(0, 12)}|compass-int-uploads|sig=|companies/`));
    });

    it("a READY record whose file has gone missing is a plain 404 — no path, no stack", async () => {
      const d = await upload("Agent1", ids.LA1, { name: "a.pdf", type: "application/pdf", bytes: PDF });
      await fsp.rm(local.pathForKey(d.key!, UPLOAD_DIR));
      as("Agent1");
      const r = await callRoute(d.id!);
      expect(r.status).toBe(404);
      expect(await r.text()).not.toMatch(/compass-int|ENOENT|\/tmp/);
    });

    it("a filesystem failure while opening is a generic 503, no internals", async () => {
      const d = await upload("Agent1", ids.LA1, { name: "a.pdf", type: "application/pdf", bytes: PDF });
      as("Agent1");
      const restore = breakFs("open", "EIO");
      const r = await callRoute(d.id!);
      restore();
      expect(r.status).toBe(503);
      expect(await r.text()).not.toMatch(/EIO|compass-int|simulated|bucket/i);
    });

    it("downloads are rate limited per account", async () => {
      const d = await upload("Agent1", ids.LA1, { name: "a.pdf", type: "application/pdf", bytes: PDF });
      as("Agent1");
      await prisma.rateLimitCounter.deleteMany({ where: { key: { startsWith: `acct:${actors.Agent1.id}|attachment-download` } } });
      let last = 200;
      for (let i = 0; i < 125; i++) {
        const r = await callRoute(d.id!);
        last = r.status;
        await r.arrayBuffer();
      }
      expect(last).toBe(429);
    });
  });

  // ── rows whose key is not one of ours ──────────────────────────────────────────────────────────────────────────────────────
  describe("a stored key that is not exactly one of ours never reaches the filesystem", () => {
    async function oddRow(name: string, key: string, status: "READY" | "PENDING" = "READY") {
      return prisma.attachment.create({
        data: { id: `odd-${name}-${TAG}`.slice(0, 60), leadId: ids.LA1, contactId: ids.contactA, companyId: "default-company", fileName: `${name}.pdf`, fileType: "application/pdf", fileSize: PDF.length, uploadedById: actors.Agent1.id, storageKey: key, status },
      });
    }

    async function pendingLocal() {
      as("Agent1");
      const req = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "p.pdf", contentType: "application/pdf", size: PDF.length });
      if (!req.ok) throw new Error("setup");
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: req.attachmentId } });
      await putBytes(req.attachmentId, PDF);
      return { id: req.attachmentId, key: row.storageKey! };
    }

    it("a full lifecycle (upload, list, open, download, edit, delete, abandon, sweep) uses only the local directory and needs no storage credentials", async () => {
      for (const name of Object.keys(process.env)) expect(name, "no cloud-storage credential may be needed").not.toMatch(/^(AWS_|S3_)/);
      const d = await upload("Agent1", ids.LA1, { name: "local.pdf", type: "application/pdf", bytes: PDF });
      expect(onDisk(d.key!)).toBe(true);
      as("Agent1");
      expect((await callRoute(d.id!)).status).toBe(200);
      expect((await callRoute(d.id!, "?download=1")).status).toBe(200);
      as("Admin");
      expect(await actions.updateLeadAttachmentDescription(d.id, "x")).toMatchObject({ ok: true });
      expect(await actions.deleteLeadAttachment(d.id)).toEqual({ ok: true });
      expect(onDisk(d.key!)).toBe(false);
      const abandoned = await upload("Agent1", ids.LA1, { name: "gone.pdf", type: "application/pdf", bytes: PDF });
      await actions.abandonLeadAttachmentUpload(abandoned.id);
      await cleanup.sweepStalePendingAttachments(Date.now() + 5 * 3600_000);
    });

    it("traversal-looking and foreign-shaped keys are refused by the storage module: opening is a generic 503, deleting keeps the record, nothing outside the directory is touched", async () => {
      const real = await upload("Agent1", ids.LA1, { name: "real.pdf", type: "application/pdf", bytes: PDF });
      const opened = vi.spyOn(fsp, "open");
      const unlinked = vi.spyOn(fsp, "unlink");
      for (const [i, key] of ["../../../etc/passwd", "/etc/passwd", "companies/default-company/leads/x/attachments/y/0123456789abcdef0123456789abcdef", `ab/${"a".repeat(63)}`, `cd/${"ab".padEnd(64, "c")}`].entries()) {
        const row = await oddRow(`k${i}`, key);
        as("Agent1");
        const open = await callRoute(row.id);
        expect(open.status).toBe(503);
        expect(await open.text()).not.toMatch(/etc|passwd|companies|bucket|S3/i);
        as("Admin");
        const del = await actions.deleteLeadAttachment(row.id);
        expect(del.ok).toBe(false);
        expect(JSON.stringify(del)).not.toMatch(/etc|passwd|companies|bucket|S3/i);
        expect(await prisma.attachment.count({ where: { id: row.id } })).toBe(1); // kept, never silently dropped
        await prisma.attachment.delete({ where: { id: row.id } });
      }
      expect(opened.mock.calls.filter((c) => !String(c[0]).startsWith(UPLOAD_DIR))).toHaveLength(0);
      expect(unlinked.mock.calls.filter((c) => !String(c[0]).startsWith(UPLOAD_DIR))).toHaveLength(0);
      expect(onDisk(real.key!)).toBe(true);
      opened.mockRestore();
      unlinked.mockRestore();
    });

    it("a stale PENDING row with a key that is not ours is kept (and counted as failed) rather than dropped blindly; a stale local one is removed through the filesystem", async () => {
      const odd = await oddRow("pend", "companies/default-company/leads/x/attachments/y/0123456789abcdef0123456789abcdef", "PENDING");
      const localPending = await pendingLocal();
      const result = await cleanup.sweepStalePendingAttachments(Date.now() + 5 * 3600_000);
      expect(result.failed).toBeGreaterThanOrEqual(1);
      expect(await prisma.attachment.count({ where: { id: odd.id } })).toBe(1);
      expect(await prisma.attachment.count({ where: { id: localPending.id } })).toBe(0);
      await prisma.attachment.delete({ where: { id: odd.id } });
    });
  });

  describe("lead and contact deletion remove the stored files", () => {
    it("lead deletion removes the files of file, each through its own provider; a failed purge is recorded for reconciliation", async () => {
      const c = await prisma.contact.create({ data: { firstName: "Del", lastName: `D-${TAG}`, primaryEmail: `d-${TAG}@example.test`, companyId: "default-company", ownerId: actors.Agent1.id } });
      contactIds.push(c.id);
      const lead = await makeLead("LDEL", c.id, "Agent1");
      const d1 = await upload("Agent1", lead.id, { name: "d1.pdf", type: "application/pdf", bytes: PDF });
      const d2 = await upload("Agent1", lead.id, { name: "d2.pdf", type: "application/pdf", bytes: PDF });
      as("Admin");
      await leadActions.deleteLead(lead.id);
      expect(await prisma.attachment.count({ where: { leadId: lead.id } })).toBe(0);
      expect(onDisk(d1.key!) || onDisk(d2.key!)).toBe(false);

      // the file store failing during the purge -> the opaque keys are written to the audit log
      const lead2 = await makeLead("LDEL2", c.id, "Agent1");
      const d3 = await upload("Agent1", lead2.id, { name: "d3.pdf", type: "application/pdf", bytes: PDF });
      as("Admin");
      const restore = breakFs("unlink", "EPERM");
      await leadActions.deleteLead(lead2.id);
      restore();
      const orphan = await prisma.auditLog.findFirst({ where: { action: "ATTACHMENT_STORAGE_ORPHANED", actorId: actors.Admin.id }, orderBy: { createdAt: "desc" } });
      expect(JSON.stringify(orphan?.metadata)).toContain(d3.key!);
      expect(JSON.stringify(orphan?.metadata)).not.toContain("compass-int-uploads");
    });

    it("contact deletion removes the stored files of all its leads", async () => {
      const c = await prisma.contact.create({ data: { firstName: "Del", lastName: `DC-${TAG}`, primaryEmail: `dc-${TAG}@example.test`, companyId: "default-company", ownerId: actors.Agent1.id } });
      contactIds.push(c.id);
      const lead = await makeLead("LDELC", c.id, "Agent1");
      const d = await upload("Agent1", lead.id, { name: "dc.pdf", type: "application/pdf", bytes: PDF });
      expect(onDisk(d.key!)).toBe(true);
      as("Admin");
      await contactActions.deleteContact(c.id);
      expect(await prisma.attachment.count({ where: { leadId: lead.id } })).toBe(0);
      expect(onDisk(d.key!)).toBe(false);
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

    it("lists metadata only: it never opens a stored file", async () => {
      await upload("Agent1", ids.LA1, { name: "m.pdf", type: "application/pdf", bytes: PDF });
      const open = vi.spyOn(fsp, "open");
      const res = await queries.listContactLeadAttachments(ids.contactA, actors.Admin);
      expect(Object.keys(res.items[0]).sort()).toEqual(["createdAt", "description", "fileName", "fileSize", "fileType", "id", "leadId", "leadRoute", "uploadedBy"]);
      expect(open.mock.calls.filter((c) => String(c[0]).startsWith(UPLOAD_DIR))).toHaveLength(0);
    });
  });

  // ── persistence ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("persistence", () => {
    it("files survive a fresh module instance (a restarted server) because they live on disk, not in memory", async () => {
      const d = await upload("Agent1", ids.LA1, { name: "persist.pdf", type: "application/pdf", bytes: PDF });
      vi.resetModules();
      const freshLocal = await import("@/server/storage/local");
      const file = await freshLocal.localStorage.openRead(d.key!);
      expect(file?.size).toBe(PDF.length);
      file?.stream.destroy();
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

  // ── races between the stale sweep, completion, cancellation and the bytes arriving ────────────────────────────────────────────
  // The invariant under test: a file that a READY attachment depends on is never removed, and a request is never told "saved" for an
  // attachment that was swept away. Each test forces the interleaving deterministically (no sleep decides the outcome).
  describe("races with the stale-upload sweep", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const age = (id: string) => prisma.attachment.update({ where: { id }, data: { createdAt: new Date(Date.now() - 3 * 3600_000) } });
    /** A PENDING attachment whose bytes have been received (file on disk) but that has not been completed yet. */
    async function receivedButNotCompleted() {
      as("Agent1");
      const req = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "race.pdf", contentType: "application/pdf", size: PDF.length });
      if (!req.ok) throw new Error("setup");
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: req.attachmentId } });
      expect((await putBytes(req.attachmentId, PDF)).status).toBe(200);
      return { id: req.attachmentId, key: row.storageKey! };
    }

    it("a completion that lands between the sweep reading a row and removing its file is never undone: READY keeps its file, or the attachment is cleanly gone", async () => {
      for (let round = 0; round < 3; round++) {
        const p = await receivedButNotCompleted();
        await age(p.id);
        const realRemove = local.localStorage.remove.bind(local.localStorage);
        let completing: Promise<{ ok: boolean }> | undefined;
        vi.spyOn(local.localStorage, "remove").mockImplementationOnce(async (key: string) => {
          // the uploader finally finishes the very same upload at this exact moment (not awaited: it may have to wait for the sweep)
          as("Agent1");
          completing = actions.completeLeadAttachmentUpload(p.id);
          await sleep(250);
          return realRemove(key);
        });
        await cleanup.sweepStalePendingAttachments(Date.now());
        const done = await completing!;
        vi.restoreAllMocks();

        const row = await prisma.attachment.findUnique({ where: { id: p.id } });
        if (row?.status === "READY") expect(onDisk(p.key), "a READY attachment lost its file").toBe(true);
        if (!row) expect(onDisk(p.key), "a deleted attachment left its file behind").toBe(false);
        if (done.ok) {
          expect(row?.status, "told 'saved' but the attachment is gone or not READY").toBe("READY");
          expect(onDisk(p.key)).toBe(true);
        }
        await prisma.attachment.deleteMany({ where: { id: p.id } });
      }
    });

    it("cancelling an upload while it is being completed cannot leave a READY attachment without its file", async () => {
      const p = await receivedButNotCompleted();
      const realRemove = local.localStorage.remove.bind(local.localStorage);
      let completing: Promise<{ ok: boolean }> | undefined;
      vi.spyOn(local.localStorage, "remove").mockImplementationOnce(async (key: string) => {
        as("Agent1");
        completing = actions.completeLeadAttachmentUpload(p.id);
        await sleep(250);
        return realRemove(key);
      });
      as("Agent1");
      await actions.abandonLeadAttachmentUpload(p.id);
      const done = await completing!;
      vi.restoreAllMocks();
      const row = await prisma.attachment.findUnique({ where: { id: p.id } });
      if (row?.status === "READY") expect(onDisk(p.key), "a READY attachment lost its file").toBe(true);
      if (done.ok) expect(row?.status).toBe("READY");
      if (!row) expect(onDisk(p.key)).toBe(false);
    });

    it("bytes that arrive after their upload was swept (or its lead deleted) are not left behind as an unreferenced file", async () => {
      as("Agent1");
      const req = await actions.requestLeadAttachmentUpload({ leadId: ids.LA1, fileName: "late.pdf", contentType: "application/pdf", size: PDF.length });
      if (!req.ok) throw new Error("setup");
      await age(req.attachmentId);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let step = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          if (step++ === 0) return void c.enqueue(PDF.slice(0, 6));
          await gate; // the client stalls here, mid-upload
          c.enqueue(PDF.slice(6));
          c.close();
        },
      });
      const putting = putBytes(req.attachmentId, body, { length: PDF.length });
      await sleep(150);
      const swept = await cleanup.sweepStalePendingAttachments(Date.now()); // the row is >1 h old: removed while the bytes are still in flight
      expect(swept.removed).toBe(1);
      release();
      const res = await putting;
      expect(res.status).not.toBe(200);
      expect(await storedFiles(), "an unreferenced file was left on disk").toEqual([]);
      expect(await tempFiles()).toEqual([]);
    });

    it("a sweep never touches a READY attachment, a recent upload, or a row it cannot lock", async () => {
      const ready = await upload("Agent1", ids.LA1, { name: "keep.pdf", type: "application/pdf", bytes: PDF });
      await age(ready.id!);
      const recent = await receivedButNotCompleted();
      const swept = await cleanup.sweepStalePendingAttachments(Date.now());
      expect(swept.removed).toBe(0);
      expect(onDisk(ready.key!)).toBe(true);
      expect(onDisk(recent.key)).toBe(true);
      expect((await prisma.attachment.findUniqueOrThrow({ where: { id: ready.id! } })).status).toBe("READY");

      // a row another transaction currently holds is skipped (and left intact), not waited for or removed
      const stale = await receivedButNotCompleted();
      await age(stale.id);
      let locked!: () => void;
      const held = new Promise<void>((r) => (locked = r));
      const holder = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Attachment" WHERE "id" = ${stale.id} FOR UPDATE`;
        locked();
        await sleep(600);
      });
      await held;
      const during = await cleanup.sweepStalePendingAttachments(Date.now());
      await holder;
      expect(during.removed).toBe(0);
      expect(onDisk(stale.key)).toBe(true);
      expect(await prisma.attachment.count({ where: { id: stale.id } })).toBe(1);
      const after = await cleanup.sweepStalePendingAttachments(Date.now()); // once free, it is collected normally
      expect(after.removed).toBe(1);
      expect(onDisk(stale.key)).toBe(false);
    });
  });
});
