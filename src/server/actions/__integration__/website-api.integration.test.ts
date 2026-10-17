// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";

// REAL-DATABASE proof of the authenticated website API: POST /api/v1/website/flight-inquiries (docs/WEBSITE_LEAD_API.md).
// Authentication and the private-network rule, strict validation and size limits, rate limiting, idempotency (sequential,
// concurrent, mixed with the public endpoint, same key with a different request), the company being fixed by the credential,
// atomic creation with its fingerprint, the audit trail, server-to-server IP/location handling, and safe errors that never carry
// personal data or internals. Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL with this repo's migrations applied.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
  process.env.CARD_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_HASH_KEY ??= randomBytes(32).toString("base64");
}
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/actions/lead-queue", () => ({ distributeNewWebsiteLead: vi.fn(async () => ({ ok: true })) }));
// The real rate limiter (real database), wrapped so one test can make it fail.
vi.mock("@/server/security/rate-limit", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/security/rate-limit")>();
  return { ...original, checkAccountRateLimit: vi.fn(original.checkAccountRateLimit) };
});

const TAG = `wapi-${Date.now()}`;
// Throwaway test values, not real secrets.
const KEY = "k".repeat(16) + randomBytes(16).toString("hex");
const KEY_NEXT = "n".repeat(16) + randomBytes(16).toString("hex");
const INGEST_SECRET = "test-ingest-secret-0123456789-abcdefghij";
let seq = 0;

describe.skipIf(!enabled)("website API — real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let POST: (req: Request) => Promise<Response>;
  let publicPOST: (req: Request) => Promise<Response>;
  let ctx: typeof import("@/server/lead-ingest-context");
  let deriveId: typeof import("@/server/website-lead-id").deriveWebsiteLeadId;
  const leadIds = new Set<string>();
  const emails = new Set<string>();

  const payload = (over: Record<string, unknown> = {}) => {
    const n = ++seq;
    const email = `wapi${n}-${TAG}@example.test`;
    emails.add(email);
    return { firstName: "Jane", lastName: `Api${n}`, phone: `+1415556${String(1000 + n)}`, email, tripType: "ONE_WAY", departureAirportIata: "FRA", arrivalAirportIata: "MSP", departureDate: "2026-12-01", adults: 2, ...over };
  };
  const newKey = () => `${TAG}-${++seq}-${randomBytes(4).toString("hex")}`;
  const call = (body: unknown, opts: { key?: string | null; auth?: string | null; headers?: Record<string, string>; raw?: string; contentType?: string | null } = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.contentType !== null) headers["content-type"] = opts.contentType ?? "application/json";
    if (opts.auth !== null) headers.authorization = opts.auth ?? `Bearer ${KEY}`;
    if (opts.key !== null) headers["idempotency-key"] = opts.key ?? newKey();
    return POST(new Request("http://compass-crm:3000/api/v1/website/flight-inquiries", { method: "POST", headers, body: opts.raw ?? JSON.stringify(body) }));
  };
  const json = async (res: Response) => (await res.json()) as { ok: boolean; leadId?: string; duplicate?: boolean; error?: { code: string; message: string; fields?: { path: string; message: string }[] } };
  const track = (id?: string) => {
    if (id) leadIds.add(id);
    return id;
  };
  const clearLimits = () => prisma.rateLimitCounter.deleteMany({ where: { key: { startsWith: "acct:website-api|" } } });
  const counts = async (leadId: string) => ({
    leads: await prisma.lead.count({ where: { id: leadId } }),
    fingerprints: await prisma.leadIngestFingerprint.count({ where: { leadId } }),
    history: await prisma.leadStatusHistory.count({ where: { leadId } }),
    created: await prisma.activity.count({ where: { leadId, type: "LEAD_CREATED" } }),
    audits: await prisma.auditLog.count({ where: { entityType: "Lead", entityId: leadId, action: { startsWith: "WEBSITE_API_" } } }),
  });

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ POST } = await import("@/app/api/v1/website/flight-inquiries/route"));
    ({ POST: publicPOST } = await import("@/app/api/public/lead-capture/route"));
    ctx = await import("@/server/lead-ingest-context");
    ({ deriveWebsiteLeadId: deriveId } = await import("@/server/website-lead-id"));
    await prisma.company.upsert({ where: { id: "default-company" }, update: {}, create: { id: "default-company", name: "Test Co", signatureTemplate: "Regards" } });
    await prisma.company.upsert({ where: { id: `other-${TAG}` }, update: {}, create: { id: `other-${TAG}`, name: "Other Co", signatureTemplate: "Regards" } });
  });
  beforeEach(async () => {
    vi.stubEnv("WEBSITE_API_KEY", KEY);
    vi.stubEnv("WEBSITE_API_KEY_NEXT", "");
    vi.stubEnv("WEBSITE_API_COMPANY_ID", "");
    vi.stubEnv("WEBSITE_API_ALLOW_PUBLIC_ROUTE", "");
    vi.stubEnv("LEAD_INGEST_SECRET", INGEST_SECRET);
    await clearLimits();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    if (!enabled) return;
    await clearLimits();
    const ids = [...leadIds];
    await prisma.auditLog.deleteMany({ where: { entityType: "Lead", entityId: { in: ids } } }).catch(() => undefined); // append-only in production; tolerated here
    await prisma.activity.deleteMany({ where: { leadId: { in: ids } } });
    await prisma.lead.deleteMany({ where: { id: { in: ids } } }); // cascades fingerprint, segments, submission info, history
    const contacts = await prisma.contact.findMany({ where: { primaryEmail: { in: [...emails] } }, select: { id: true } });
    await prisma.activity.deleteMany({ where: { contactId: { in: contacts.map((c) => c.id) } } });
    await prisma.contact.deleteMany({ where: { id: { in: contacts.map((c) => c.id) } } });
    await prisma.company.deleteMany({ where: { id: `other-${TAG}` } });
    await prisma.$disconnect();
  });

  // ── contract: success ────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("creates the lead: 201, the documented response, and every CRM default (source, status, company, contact, history, activity, fingerprint, audit)", async () => {
    const key = newKey();
    const body = payload({ cabinClass: "BUSINESS", children: 1, infants: 1, datesFlexible: true, preferredAirline: "LH", approximateBudget: 1500.5, budgetCurrency: "eur", additionalNotes: "Window seat" });
    const res = await call(body, { key });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const j = await json(res);
    expect(j).toEqual({ ok: true, leadId: deriveId(key), duplicate: false });
    track(j.leadId);

    const lead = await prisma.lead.findUniqueOrThrow({
      where: { id: j.leadId },
      include: { contact: true, departureAirport: true, arrivalAirport: true, statusHistory: true, submissionInfo: true, ingestFingerprint: true },
    });
    expect(lead).toMatchObject({ source: "WEBSITE", priority: "MEDIUM", status: "ATTEMPTING_TO_CONTACT", tripType: "ONE_WAY", cabinClass: "BUSINESS", adults: 2, children: 1, infants: 1, flexibleDates: true, preferredAirline: "LH", notes: "Window seat" });
    expect(Number(lead.budget)).toBe(1500.5);
    expect(lead.departureAirport?.iata).toBe("FRA");
    expect(lead.arrivalAirport?.iata).toBe("MSP");
    expect(lead.contact).toMatchObject({ companyId: "default-company", firstName: "Jane", primaryEmail: body.email });
    expect(lead.statusHistory).toHaveLength(1);
    expect(lead.submissionInfo?.budgetCurrency).toBe("EUR");
    expect(lead.ingestFingerprint).toMatchObject({ source: "website-api" });
    expect(lead.ingestFingerprint?.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await counts(j.leadId!)).toEqual({ leads: 1, fingerprints: 1, history: 1, created: 1, audits: 1 });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "Lead", entityId: j.leadId, action: "WEBSITE_API_LEAD_CREATED" } });
    expect(audit.actorId).toBeNull();
    expect(audit.metadata).toEqual({ channel: "website-api", companyId: "default-company" });
    expect(JSON.stringify(audit)).not.toContain(body.email as string);
    expect(JSON.stringify(audit)).not.toContain(key);
  });

  it("stores every leg of a multi-city request, in order, in the same insert", async () => {
    const res = await call(payload({ tripType: "MULTI_CITY", departureAirportIata: undefined, arrivalAirportIata: undefined, departureDate: undefined, segments: [{ departureAirportIata: "FRA", arrivalAirportIata: "MSP", departureDate: "2026-12-01" }, { departureAirportIata: "MSP", arrivalAirportIata: "LAX", departureDate: "2026-12-10" }, { departureAirportIata: "LAX", arrivalAirportIata: "FRA", departureDate: "2026-12-20" }] }));
    expect(res.status).toBe(201);
    const j = await json(res);
    track(j.leadId);
    const segs = await prisma.leadSegment.findMany({ where: { leadId: j.leadId }, orderBy: { sequence: "asc" }, include: { departureAirport: true, arrivalAirport: true } });
    expect(segs.map((s) => `${s.departureAirport?.iata}-${s.arrivalAirport?.iata}`)).toEqual(["FRA-MSP", "MSP-LAX", "LAX-FRA"]);
  });

  it("a repeat customer's lead goes to that contact's existing owner (the shared business rule), without a second contact", async () => {
    const owner = await prisma.account.create({ data: { fullName: "Owner", email: `owner-${TAG}@example.test`, role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "default-company" } });
    try {
      const first = payload();
      const j1 = await json(await call(first));
      track(j1.leadId);
      await prisma.contact.updateMany({ where: { primaryEmail: first.email }, data: { ownerId: owner.id } });
      const j2 = await json(await call({ ...payload(), phone: first.phone, email: first.email }));
      track(j2.leadId);
      const second = await prisma.lead.findUniqueOrThrow({ where: { id: j2.leadId } });
      expect(second).toMatchObject({ assignedAgentId: owner.id, status: "ACCEPTED" });
      expect(await prisma.contact.count({ where: { primaryEmail: first.email } })).toBe(1);
    } finally {
      await prisma.lead.updateMany({ where: { assignedAgentId: owner.id }, data: { assignedAgentId: null } });
      await prisma.contact.updateMany({ where: { ownerId: owner.id }, data: { ownerId: null } });
      await prisma.account.delete({ where: { id: owner.id } }).catch(() => undefined);
    }
  });

  // ── authentication ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("authentication", () => {
    it("refuses a missing, wrong, malformed or non-bearer credential with 401 and creates nothing", async () => {
      const before = await prisma.lead.count();
      for (const auth of [null, "", "Bearer", `Bearer ${KEY}x`, `Bearer ${"z".repeat(40)}`, `Basic ${KEY}`, KEY, `Token ${KEY}`]) {
        const res = await call(payload(), { auth });
        expect(res.status, String(auth)).toBe(401);
        expect(res.headers.get("www-authenticate")).toBe("Bearer");
        const j = await json(res);
        expect(j).toEqual({ ok: false, error: { code: "unauthorized", message: "Missing or invalid credentials." } });
      }
      expect(await prisma.lead.count()).toBe(before);
    });

    it("the error never reveals the configured key, a hint about it, or which part was wrong", async () => {
      const res = await call(payload(), { auth: `Bearer ${KEY.slice(0, 20)}` });
      const text = JSON.stringify(await json(res));
      expect(text).not.toContain(KEY.slice(0, 10));
      expect(text).not.toMatch(/length|prefix|expected|configured/i);
    });

    it("is disabled (503) until a usable key is configured; a short key counts as not configured", async () => {
      vi.stubEnv("WEBSITE_API_KEY", "");
      expect((await call(payload())).status).toBe(503);
      vi.stubEnv("WEBSITE_API_KEY", "too-short");
      const res = await call(payload(), { auth: "Bearer too-short" });
      expect(res.status).toBe(503);
      expect((await json(res)).error?.code).toBe("not_configured");
    });

    it("rotation: during the overlap both keys work; once the old one is removed it stops", async () => {
      vi.stubEnv("WEBSITE_API_KEY_NEXT", KEY_NEXT);
      for (const k of [KEY, KEY_NEXT]) {
        const res = await call(payload(), { auth: `Bearer ${k}` });
        expect(res.status).toBe(201);
        track((await json(res)).leadId);
      }
      vi.stubEnv("WEBSITE_API_KEY", KEY_NEXT);
      vi.stubEnv("WEBSITE_API_KEY_NEXT", "");
      expect((await call(payload(), { auth: `Bearer ${KEY}` })).status).toBe(401);
      expect((await call(payload(), { auth: `Bearer ${KEY_NEXT}` })).status).toBe(201);
    });

    it("other CRM secrets are not accepted as the website key", async () => {
      vi.stubEnv("CRON_SECRET", "cron-secret-".padEnd(40, "c"));
      expect((await call(payload(), { auth: `Bearer ${"cron-secret-".padEnd(40, "c")}` })).status).toBe(401);
      expect((await call(payload(), { auth: `Bearer ${INGEST_SECRET}` })).status).toBe(401);
    });

    it("a request that came through the public Cloudflare hostname is a plain 404 - even with the right key - unless explicitly allowed", async () => {
      for (const h of [{ "cf-ray": "8a1b2c3d4e5f-FRA" }, { "cf-connecting-ip": "203.0.113.7" }] as Record<string, string>[]) {
        const res = await call(payload(), { headers: h });
        expect(res.status).toBe(404);
        expect((await json(res)).error?.code).toBe("not_found");
      }
      vi.stubEnv("WEBSITE_API_ALLOW_PUBLIC_ROUTE", "true");
      const ok = await call(payload(), { headers: { "cf-ray": "8a1b2c3d4e5f-FRA" } });
      expect(ok.status).toBe(201);
      track((await json(ok)).leadId);
      vi.stubEnv("WEBSITE_API_ALLOW_PUBLIC_ROUTE", "");
      expect((await call(payload(), { headers: { "cf-ray": "x" }, auth: null })).status).toBe(404); // 404 before authentication: nothing to probe
    });
  });

  // ── rate limiting ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("rate limiting", () => {
    it("repeated failed authentication is throttled (429 + Retry-After) but never blocks the legitimate caller", async () => {
      let last = 0;
      let retryAfter: string | null = null;
      for (let i = 0; i < 32; i++) {
        const res = await call(payload(), { auth: `Bearer ${"w".repeat(40)}` });
        last = res.status;
        retryAfter = res.headers.get("retry-after");
        if (last === 429) break;
      }
      expect(last).toBe(429);
      expect(Number(retryAfter)).toBeGreaterThan(0);
      const good = await call(payload());
      expect(good.status).toBe(201); // the real caller has its own budget
      track((await json(good)).leadId);
    });

    it("the authenticated caller has a hard per-minute ceiling (429 + Retry-After) that a retry loop cannot exceed", async () => {
      let limited: Response | null = null;
      for (let i = 0; i < 125 && !limited; i++) {
        const res = await call(null, { contentType: "text/plain" }); // cheapest valid-auth request: rejected as 415 after being counted
        if (res.status === 429) limited = res;
        else expect(res.status).toBe(415);
      }
      expect(limited).not.toBeNull();
      expect(Number(limited!.headers.get("retry-after"))).toBeGreaterThan(0);
      expect((await json(limited!)).error?.code).toBe("rate_limited");
    });
  });

  // ── request shape, size and validation ───────────────────────────────────────────────────────────────────────────────────────
  describe("input handling", () => {
    it("requires JSON, a bounded body and an Idempotency-Key (415 / 413 / 400)", async () => {
      expect((await call(payload(), { contentType: "text/plain" })).status).toBe(415);
      expect((await call(payload(), { contentType: null })).status).toBe(415);
      expect((await call(payload(), { contentType: "application/json; charset=utf-8" })).status).toBe(201);
      for (const key of [null, "", "short", "has space in it", "bad/slash/key!", "x".repeat(201)]) {
        const res = await call(payload(), { key });
        expect(res.status, String(key)).toBe(400);
        expect((await json(res)).error?.code).toBe("idempotency_key_required");
      }
      const big = await call(payload({ additionalNotes: "n".repeat(5000) }), { headers: { "content-length": String(40 * 1024) } });
      expect(big.status).toBe(413);
      expect((await json(big)).error?.code).toBe("payload_too_large");
    });

    it("cuts off an oversized body while reading it, even when no Content-Length is declared", async () => {
      const chunk = new TextEncoder().encode("a".repeat(8 * 1024));
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= 64) return controller.close();
          sent++;
          controller.enqueue(chunk);
        },
      });
      const res = await POST(
        new Request("http://compass-crm:3000/api/v1/website/flight-inquiries", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, "idempotency-key": newKey() },
          body,
          // @ts-expect-error Node's fetch requires duplex for a streamed request body
          duplex: "half",
        })
      );
      expect(res.status).toBe(413);
      expect(sent).toBeLessThan(10); // stopped reading long before the 512 KB was consumed
    });

    it("rejects malformed JSON, non-objects and an empty body (400)", async () => {
      for (const raw of ["{not json", "[]", "null", "42", '"text"', ""]) {
        const res = await call(null, { raw });
        expect(res.status, raw).toBe(400);
        expect((await json(res)).error?.code).toBe("invalid_json");
      }
    });

    it("validates every field strictly, names the field and the rule, and never echoes the submitted value", async () => {
      const cases: [string, Record<string, unknown>][] = [
        ["firstName", { firstName: "" }],
        ["lastName", { lastName: undefined }],
        ["phone", { phone: "123" }],
        ["email", { email: "not-an-email" }],
        ["adults", { adults: 0 }],
        ["adults", { adults: 21 }],
        ["adults", { adults: "two" }],
        ["tripType", { tripType: "SIDEWAYS" }],
        ["cabinClass", { cabinClass: "STANDING" }],
        ["departureAirportIata", { departureAirportIata: "FRANKFURT" }],
        ["budgetCurrency", { budgetCurrency: "euros" }],
        ["approximateBudget", { approximateBudget: -5 }],
        ["additionalNotes", { additionalNotes: "x".repeat(5001) }],
        ["segments", { segments: [] }],
        ["segments", { segments: Array.from({ length: 21 }, () => ({ departureAirportIata: "FRA", arrivalAirportIata: "MSP" })) }],
      ];
      for (const [field, over] of cases) {
        const res = await call({ ...payload(), ...over });
        expect(res.status, field).toBe(400);
        const j = await json(res);
        expect(j.error?.code).toBe("validation_failed");
        expect(j.error?.fields?.some((f) => f.path.split(".")[0] === field), field).toBe(true);
        const text = JSON.stringify(j);
        expect(text).not.toContain("not-an-email");
        expect(text).not.toContain("FRANKFURT");
        expect(text).not.toMatch(/stack|prisma|postgres|SELECT|at Object/i);
      }
    });

    it("rejects unknown fields instead of ignoring them - including a caller-chosen company and a body submissionId", async () => {
      for (const extra of [{ companyId: "default-company" }, { companyId: `other-${TAG}` }, { submissionId: "abcdefgh12345" }, { source: "REFERRAL" }, { status: "ACCEPTED" }, { assignedAgentId: "x" }, { priority: "HIGH" }, { ipAddress: "203.0.113.5" }]) {
        const before = await prisma.lead.count();
        const res = await call({ ...payload(), ...extra });
        expect(res.status, JSON.stringify(extra)).toBe(400);
        expect((await json(res)).error?.code).toBe("validation_failed");
        expect(await prisma.lead.count()).toBe(before);
      }
    });
  });

  // ── tenant ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("company", () => {
    it("the credential fixes the company: leads and contacts belong to WEBSITE_API_COMPANY_ID", async () => {
      vi.stubEnv("WEBSITE_API_COMPANY_ID", `other-${TAG}`);
      const res = await call(payload());
      expect(res.status).toBe(201);
      const j = await json(res);
      track(j.leadId);
      const lead = await prisma.lead.findUniqueOrThrow({ where: { id: j.leadId }, include: { contact: true } });
      expect(lead.contact.companyId).toBe(`other-${TAG}`);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "Lead", entityId: j.leadId } });
      expect(audit.metadata).toMatchObject({ companyId: `other-${TAG}` });
    });

    it("a configured company that does not exist is a server problem (503), not a created lead", async () => {
      vi.stubEnv("WEBSITE_API_COMPANY_ID", "no-such-company");
      const before = await prisma.lead.count();
      const res = await call(payload());
      expect(res.status).toBe(503);
      expect((await json(res)).error?.code).toBe("not_configured");
      expect(await prisma.lead.count()).toBe(before);
    });
  });

  // ── idempotency ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("idempotency", () => {
    it("the same key and the same request again: 200 + duplicate:true, the SAME lead, and nothing else is written", async () => {
      const key = newKey();
      const body = payload();
      const first = await json(await call(body, { key }));
      track(first.leadId);
      const before = await counts(first.leadId!);
      const contactsBefore = await prisma.contact.count({ where: { primaryEmail: body.email } });

      const res = await call(body, { key });
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ ok: true, leadId: first.leadId, duplicate: true });
      const after = await counts(first.leadId!);
      expect(after).toEqual({ ...before, audits: before.audits + 1 }); // only the audit of the repeat; no second lead, history, activity or fingerprint
      expect(await prisma.contact.count({ where: { primaryEmail: body.email } })).toBe(contactsBefore);
    });

    it("the same request with its keys in a different order, or with defaults spelled out, is still the same request", async () => {
      const key = newKey();
      const body = payload();
      const first = await json(await call(body, { key }));
      track(first.leadId);
      const reordered = Object.fromEntries(Object.entries({ ...body, tripType: "ONE_WAY", cabinClass: "ECONOMY", children: 0, infants: 0 }).reverse());
      const res = await call(reordered, { key, raw: JSON.stringify(reordered, null, 2) });
      expect(res.status).toBe(200);
      expect((await json(res)).leadId).toBe(first.leadId);
    });

    it("the same key with a DIFFERENT request is refused (409) and changes nothing", async () => {
      const key = newKey();
      const body = payload();
      const first = await json(await call(body, { key }));
      track(first.leadId);
      for (const different of [{ ...body, adults: 5 }, { ...body, additionalNotes: "changed" }, { ...body, lastName: "Someone Else" }, { ...body, arrivalAirportIata: "LAX" }]) {
        const res = await call(different, { key });
        expect(res.status).toBe(409);
        const j = await json(res);
        expect(j.error?.code).toBe("idempotency_key_reused");
        expect(j.leadId).toBeUndefined();
      }
      const lead = await prisma.lead.findUniqueOrThrow({ where: { id: first.leadId } });
      expect(lead.adults).toBe(2);
      expect(lead.notes).toBeNull();
      expect(await prisma.auditLog.count({ where: { entityId: first.leadId, action: "WEBSITE_API_LEAD_CONFLICT" } })).toBe(4);
    });

    it("concurrent retries of one submission create exactly one lead; every caller gets that lead id", async () => {
      const key = newKey();
      const body = payload();
      const responses = await Promise.all(Array.from({ length: 10 }, () => call(body, { key })));
      const results = await Promise.all(responses.map(async (r) => ({ status: r.status, j: await json(r) })));
      const ids = new Set(results.map((r) => r.j.leadId));
      expect(ids.size).toBe(1);
      track([...ids][0]);
      expect(results.every((r) => r.status === 201 || r.status === 200)).toBe(true);
      expect(results.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => r.j.ok)).toBe(true);
      const c = await counts([...ids][0]!);
      expect(c).toMatchObject({ leads: 1, fingerprints: 1, history: 1, created: 1 });
      expect(await prisma.contact.count({ where: { primaryEmail: body.email } })).toBe(1);
    });

    it("concurrent requests reusing one key with DIFFERENT content: one wins, the others get 409, still one lead", async () => {
      const key = newKey();
      const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => call({ ...payload(), adults: i + 1 }, { key })));
      const statuses = responses.map((r) => r.status).sort();
      const lead = await prisma.lead.findUnique({ where: { id: deriveId(key) } });
      track(lead?.id);
      expect(lead).not.toBeNull();
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.every((s) => s === 201 || s === 409 || s === 200)).toBe(true);
      expect(await prisma.lead.count({ where: { id: deriveId(key) } })).toBe(1);
    });

    it("shares idempotency with the public endpoint and the website's direct write: one submission is one lead whichever route it takes", async () => {
      const key = newKey();
      const viaPublic = await publicPOST(
        new Request("http://localhost/api/public/lead-capture", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ companyId: "default-company", submissionId: key, ...payload() }) })
      );
      const pj = (await viaPublic.json()) as { id: string };
      track(pj.id);
      const res = await call(payload(), { key });
      expect(res.status).toBe(200); // created elsewhere: no fingerprint to compare, so it is the same submission by key
      expect(await json(res)).toEqual({ ok: true, leadId: pj.id, duplicate: true });
      expect(await prisma.lead.count({ where: { id: pj.id } })).toBe(1);
    });

    it("a key that resolves to a lead of ANOTHER company is never answered with that lead", async () => {
      const key = newKey();
      vi.stubEnv("WEBSITE_API_COMPANY_ID", `other-${TAG}`);
      const j = await json(await call(payload(), { key }));
      track(j.leadId);
      vi.stubEnv("WEBSITE_API_COMPANY_ID", "default-company");
      const res = await call(payload(), { key });
      expect(res.status).toBe(409);
      expect(JSON.stringify(await json(res))).not.toContain(j.leadId!);
    });
  });

  // ── visitor IP / location ────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("visitor IP and location", () => {
    const signed = (p: Partial<import("@/server/lead-ingest-context").VisitorContextPayload>, secret = INGEST_SECRET) => {
      const s = ctx.signVisitorContext({ v: 1, ts: Math.floor(Date.now() / 1000), ...p }, secret);
      return { [ctx.VISITOR_CONTEXT_HEADER]: s.context, [ctx.VISITOR_SIGNATURE_HEADER]: s.signature };
    };

    it("records the visitor's IP and location only from a VERIFIED signed context", async () => {
      const res = await call(payload(), { headers: signed({ ip: "203.0.113.42", city: "Frankfurt%20am%20Main", country: "DE", timezone: "Europe/Berlin" }) });
      const j = await json(res);
      track(j.leadId);
      const info = await prisma.leadSubmissionInfo.findUniqueOrThrow({ where: { leadId: j.leadId } });
      expect(info).toMatchObject({ ipAddress: "203.0.113.42", countryCode: "DE", timeZone: "Europe/Berlin" });
    });

    it("never records the connection's own addresses: this is the website's server, not the visitor", async () => {
      vi.stubEnv("TRUSTED_PROXY", "vercel");
      const res = await call(payload(), { headers: { "x-vercel-forwarded-for": "198.51.100.77", "x-forwarded-for": "198.51.100.78", "x-real-ip": "198.51.100.79", "x-vercel-ip-city": "Nowhere", "x-vercel-ip-country": "US" } });
      const j = await json(res);
      track(j.leadId);
      expect(await prisma.leadSubmissionInfo.count({ where: { leadId: j.leadId } })).toBe(0);
    });

    it("an unverifiable context (wrong secret, forged signature, stale timestamp) yields no IP and no location", async () => {
      for (const headers of [signed({ ip: "203.0.113.50" }, "x".repeat(40)), { ...signed({ ip: "203.0.113.51" }), [ctx.VISITOR_SIGNATURE_HEADER]: "0".repeat(64) }, signed({ ip: "203.0.113.52", ts: Math.floor(Date.now() / 1000) - 3600 })]) {
        const j = await json(await call(payload(), { headers }));
        track(j.leadId);
        expect(await prisma.leadSubmissionInfo.count({ where: { leadId: j.leadId } })).toBe(0);
      }
    });

    it("an IP in the JSON body is rejected, not stored", async () => {
      const res = await call({ ...payload(), ipAddress: "203.0.113.99", city: "Paris" });
      expect(res.status).toBe(400);
    });
  });

  // ── failures never lose a submission and never leak ──────────────────────────────────────────────────────────────────────────
  describe("failure handling", () => {
    it("an unexpected database failure is a generic 500 with no personal data or internals; the retry with the same key then succeeds with one lead", async () => {
      const errors: string[] = [];
      vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
      const key = newKey();
      const body = payload();
      const spy = vi.spyOn(prisma.lead, "create").mockRejectedValueOnce(new Error(`connection to server at "10.0.0.5" failed for ${body.email}`));
      const failed = await call(body, { key });
      expect(failed.status).toBe(500);
      const text = JSON.stringify(await json(failed));
      expect(text).toContain("internal_error");
      expect(text).not.toMatch(/10\.0\.0\.5|connection|prisma|postgres/i);
      expect(text).not.toContain(body.email as string);
      expect(await prisma.lead.count({ where: { id: deriveId(key) } })).toBe(0); // nothing half-saved under that key
      spy.mockRestore();

      const retry = await call(body, { key });
      expect(retry.status).toBe(201);
      const j = await json(retry);
      track(j.leadId);
      expect(await prisma.lead.count({ where: { id: deriveId(key) } })).toBe(1);
      expect(await prisma.contact.count({ where: { primaryEmail: body.email } })).toBe(1); // the contact from the failed attempt is reused, not duplicated

      const logged = errors.join("\n");
      expect(logged).not.toContain(body.email as string);
      expect(logged).not.toContain(body.phone as string);
      expect(logged).not.toContain(KEY);
      expect(logged).not.toContain(key);
    });

    it("an unanticipated failure (the database failing while the rate limit is checked) still answers with the JSON error contract: generic 500, nothing saved, no internals", async () => {
      const errors: string[] = [];
      vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
      const body = payload();
      const key = newKey();
      const limiter = await import("@/server/security/rate-limit");
      vi.mocked(limiter.checkAccountRateLimit).mockRejectedValueOnce(new Error("SECRET-DB-DETAIL connection to 10.0.0.5 refused"));
      const res = await call(body, { key });
      vi.restoreAllMocks();
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      const j = await json(res);
      expect(j).toEqual({ ok: false, error: { code: "internal_error", message: "The request could not be saved. Retry with the same Idempotency-Key." } });
      expect(JSON.stringify(j)).not.toMatch(/SECRET-DB-DETAIL|10\.0\.0\.5|prisma|stack/i);
      expect(await prisma.lead.count({ where: { id: deriveId(key) } })).toBe(0);
      const logged = errors.join("\n");
      expect(logged).not.toMatch(/SECRET-DB-DETAIL|10\.0\.0\.5/);
      expect(logged).not.toContain(body.email as string);
      // the retry with the same key then works and creates exactly one lead
      const retry = await call(body, { key });
      expect(retry.status).toBe(201);
      track((await json(retry)).leadId);
    });

    it("logs neither the credential nor customer data on any path", async () => {
      const lines: string[] = [];
      for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
      const body = payload();
      for (const r of [await call(body, { auth: `Bearer ${"q".repeat(40)}` }), await call({ ...body, phone: "1" }), await call(body, { key: "bad" }), await call(body)]) await r.arrayBuffer();
      track(deriveId(newKey()));
      const all = lines.join("\n");
      expect(all).not.toContain(KEY);
      expect(all).not.toContain("q".repeat(40));
      expect(all).not.toContain(body.email as string);
      expect(all).not.toContain(body.phone as string);
      const created = await prisma.lead.findFirst({ where: { contact: { primaryEmail: body.email } } });
      track(created?.id);
    });
  });
});
