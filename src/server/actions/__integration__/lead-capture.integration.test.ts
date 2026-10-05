// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { randomBytes } from "node:crypto";

// REAL-DATABASE proof that the CRM's /api/public/lead-capture is an authoritative, atomic, idempotent ingestion
// boundary: every submission becomes a Lead + status history + submission information (+ ALL multi-city legs as
// structured rows) in one write; a retry never duplicates anything; and the IP / location are server-derived — a
// body field, a forged header or an unverifiable context can never set them.
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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/security/rate-limit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/security/rate-limit")>()), checkPublicRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/server/actions/lead-queue", () => ({ distributeNewWebsiteLead: vi.fn(async () => ({ ok: true })) }));

const TAG = `lc-${Date.now()}`;
const SECRET = "test-ingest-secret-0123456789-abcdefghij"; // a throwaway test value, not a real secret
let phoneSeq = 0;

describe.skipIf(!enabled)("lead capture — real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let POST: (req: Request) => Promise<Response>;
  let ctx: typeof import("@/server/lead-ingest-context");
  let deriveId: typeof import("@/server/website-lead-id").deriveWebsiteLeadId;
  const leadIds = new Set<string>();
  const emails = new Set<string>();

  const body = (over: Record<string, unknown> = {}) => {
    const n = ++phoneSeq;
    const email = `cust${n}-${TAG}@example.test`;
    emails.add(email);
    return { companyId: "default-company", firstName: "Jane", lastName: `Cap${n}`, phone: `+1415555${String(2000 + n)}`, email, ...over };
  };
  const post = (b: Record<string, unknown>, headers: Record<string, string> = {}) =>
    POST(new Request("http://localhost/api/public/lead-capture", { method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json", ...headers } }));
  const ok = async (res: Response) => {
    const j = (await res.json()) as { ok: boolean; id: string; duplicate?: boolean };
    if (j.id) leadIds.add(j.id);
    return j;
  };
  const signed = (payload: Partial<import("@/server/lead-ingest-context").VisitorContextPayload>, secret = SECRET) => {
    const s = ctx.signVisitorContext({ v: 1, ts: Math.floor(Date.now() / 1000), ...payload }, secret);
    return { [ctx.VISITOR_CONTEXT_HEADER]: s.context, [ctx.VISITOR_SIGNATURE_HEADER]: s.signature };
  };
  const counts = async (leadId: string) => ({
    leads: await prisma.lead.count({ where: { id: leadId } }),
    segments: await prisma.leadSegment.count({ where: { leadId } }),
    info: await prisma.leadSubmissionInfo.count({ where: { leadId } }),
    history: await prisma.leadStatusHistory.count({ where: { leadId } }),
    created: await prisma.activity.count({ where: { leadId, type: "LEAD_CREATED" } }),
  });

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ POST } = await import("@/app/api/public/lead-capture/route"));
    ctx = await import("@/server/lead-ingest-context");
    ({ deriveWebsiteLeadId: deriveId } = await import("@/server/website-lead-id"));
    await prisma.company.upsert({ where: { id: "default-company" }, update: {}, create: { id: "default-company", name: "Test Co", signatureTemplate: "Regards" } });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    if (!enabled) return;
    const ids = [...leadIds];
    await prisma.activity.deleteMany({ where: { leadId: { in: ids } } });
    await prisma.lead.deleteMany({ where: { id: { in: ids } } }); // cascades segments, submission info, status history
    const contacts = await prisma.contact.findMany({ where: { primaryEmail: { in: [...emails] } }, select: { id: true } });
    await prisma.activity.deleteMany({ where: { contactId: { in: contacts.map((c) => c.id) } } });
    await prisma.contact.deleteMany({ where: { id: { in: contacts.map((c) => c.id) } } });
    await prisma.$disconnect();
  });

  it("a normal one-way lead: lead + status history + source + submission info (server-derived IP and approximate location, budget currency)", async () => {
    vi.stubEnv("TRUSTED_PROXY", "vercel");
    const res = await post(body({ tripType: "ONE_WAY", departureAirportIata: "FRA", arrivalAirportIata: "MSP", departureDate: "2026-12-01", approximateBudget: 900, budgetCurrency: "eur" }), {
      "x-vercel-forwarded-for": "203.0.113.42",
      "x-vercel-ip-city": "Frankfurt%20am%20Main",
      "x-vercel-ip-country": "DE",
      "x-vercel-ip-timezone": "Europe/Berlin",
    });
    expect(res.status).toBe(200);
    const j = await ok(res);
    expect(j.duplicate).toBeUndefined();
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: j.id }, include: { submissionInfo: true, departureAirport: true, arrivalAirport: true } });
    expect(lead).toMatchObject({ source: "WEBSITE", tripType: "ONE_WAY" });
    expect(lead.departureAirport?.iata).toBe("FRA");
    expect(lead.arrivalAirport?.iata).toBe("MSP");
    expect(lead.submissionInfo).toMatchObject({ ipAddress: "203.0.113.42", ipVersion: "v4", city: "Frankfurt am Main", country: "Germany", countryCode: "DE", timeZone: "Europe/Berlin", budgetCurrency: "EUR" });
    expect(await counts(j.id)).toMatchObject({ leads: 1, info: 1, history: 1, created: 1, segments: 0 });
  });

  it("a multi-city lead keeps EVERY leg as a structured, ordered segment (no leg collapsed into notes) — atomically with the lead", async () => {
    const res = await post(
      body({
        tripType: "MULTI_CITY",
        segments: [
          { departureAirportIata: "FRA", arrivalAirportIata: "JFK", departureDate: "2026-12-01" },
          { departureAirportIata: "JFK", arrivalAirportIata: "LAX", departureDate: "2026-12-05" },
          { departureAirportIata: "LAX", arrivalAirportIata: "ZRH", departureDate: "2026-12-12" },
        ],
      })
    );
    const j = await ok(res);
    const segs = await prisma.leadSegment.findMany({ where: { leadId: j.id }, orderBy: { sequence: "asc" }, include: { departureAirport: true, arrivalAirport: true } });
    expect(segs.map((s) => `${s.sequence}:${s.departureAirport?.iata}>${s.arrivalAirport?.iata}`)).toEqual(["1:FRA>JFK", "2:JFK>LAX", "3:LAX>ZRH"]);
    expect(segs[2].departureDate?.toISOString().slice(0, 10)).toBe("2026-12-12");
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: j.id }, include: { departureAirport: true, arrivalAirport: true } });
    expect(lead.tripType).toBe("MULTI_CITY");
    expect(lead.departureAirport?.iata).toBe("FRA"); // lead-level route mirrors the first leg
    expect(lead.arrivalAirport?.iata).toBe("JFK");
  });

  it("idempotent: the same submission key returns the SAME lead and creates nothing again (lead, segments, info, history, activity all stay at one)", async () => {
    const b = body({ tripType: "MULTI_CITY", submissionId: `key-${TAG}-1`, segments: [{ departureAirportIata: "FRA", arrivalAirportIata: "JFK" }, { departureAirportIata: "JFK", arrivalAirportIata: "LAX" }] });
    const first = await ok(await post(b));
    const retry = await ok(await post(b));
    const third = await ok(await post(b));
    expect(first.id).toBe(deriveId(`key-${TAG}-1`)); // the same derivation the website's own database write uses
    expect(retry).toMatchObject({ id: first.id, duplicate: true });
    expect(third).toMatchObject({ id: first.id, duplicate: true });
    expect(await counts(first.id)).toMatchObject({ leads: 1, segments: 2, history: 1, created: 1 });
    expect(await prisma.contact.count({ where: { primaryEmail: b.email as string } })).toBe(1);
  });

  it("two simultaneous posts of one submission produce exactly one lead", async () => {
    const b = body({ submissionId: `key-${TAG}-race`, tripType: "ONE_WAY", departureAirportIata: "FRA", arrivalAirportIata: "MSP" });
    const [a, c] = await Promise.all([post(b), post(b)]);
    const [ja, jc] = [await ok(a), await ok(c)];
    expect(a.status).toBe(200);
    expect(c.status).toBe(200);
    expect(ja.id).toBe(jc.id);
    expect((await counts(ja.id)).leads).toBe(1);
    expect(await prisma.leadSubmissionInfo.count({ where: { leadId: ja.id } })).toBeLessThanOrEqual(1);
  });

  it("two different submissions are two different leads (no heuristic de-duplication by name or route)", async () => {
    const x = await ok(await post(body({ submissionId: `key-${TAG}-a1`, tripType: "ONE_WAY", departureAirportIata: "FRA", arrivalAirportIata: "MSP" })));
    const y = await ok(await post(body({ submissionId: `key-${TAG}-a2`, tripType: "ONE_WAY", departureAirportIata: "FRA", arrivalAirportIata: "MSP" })));
    expect(x.id).not.toBe(y.id);
  });

  it("missing optional fields still succeed: no email, no airports, no budget, no submission headers", async () => {
    const b = body();
    delete (b as Record<string, unknown>).email;
    const j = await ok(await post(b));
    expect(await prisma.lead.count({ where: { id: j.id } })).toBe(1);
    expect(await prisma.leadSubmissionInfo.count({ where: { leadId: j.id } })).toBe(0); // nothing known -> no row, nothing invented
  });

  describe("the IP and location are server-derived — never client-supplied", () => {
    it("IP / location fields in the JSON body are ignored", async () => {
      const j = await ok(await post(body({ ipAddress: "8.8.8.8", ip: "8.8.8.8", clientIp: "8.8.8.8", city: "Atlantis", country: "Nowhere", countryCode: "ZZ", timeZone: "Mars/Base", submittedAt: "1999-01-01T00:00:00Z", id: "cattacker0000000000000000", capturedAt: "1999-01-01" })));
      expect(j.id).not.toBe("cattacker0000000000000000");
      expect(await prisma.leadSubmissionInfo.count({ where: { leadId: j.id } })).toBe(0);
      const lead = await prisma.lead.findUniqueOrThrow({ where: { id: j.id } });
      expect(lead.createdAt.getFullYear()).toBeGreaterThan(2000); // creation time is the server's
    });

    it("forged forwarding / geo headers are ignored when no trusted proxy is configured", async () => {
      vi.stubEnv("TRUSTED_PROXY", "none");
      const j = await ok(await post(body(), { "x-forwarded-for": "8.8.8.8", "x-real-ip": "8.8.4.4", "x-vercel-forwarded-for": "8.8.8.8", "x-vercel-ip-city": "Atlantis", "x-vercel-ip-country": "US" }));
      expect(await prisma.leadSubmissionInfo.count({ where: { leadId: j.id } })).toBe(0);
    });

    it("a private / reserved forwarded address is never stored", async () => {
      vi.stubEnv("TRUSTED_PROXY", "vercel");
      const j = await ok(await post(body(), { "x-vercel-forwarded-for": "10.0.0.5" }));
      expect(await prisma.leadSubmissionInfo.count({ where: { leadId: j.id } })).toBe(0);
    });

    it("SIGNED visitor context (the website's server posting for a visitor): the visitor's IP and location are stored — not the connection's", async () => {
      vi.stubEnv("TRUSTED_PROXY", "vercel");
      vi.stubEnv("LEAD_INGEST_SECRET", SECRET);
      const j = await ok(
        await post(body({ approximateBudget: 500, budgetCurrency: "GBP" }), {
          // what the CRM itself sees on the connection: the website server
          "x-vercel-forwarded-for": "198.51.100.200",
          "x-vercel-ip-city": "Ashburn",
          "x-vercel-ip-country": "US",
          ...signed({ ip: "203.0.113.42", city: "Frankfurt%20am%20Main", region: "HE", country: "DE", timezone: "Europe/Berlin" }),
        })
      );
      const info = await prisma.leadSubmissionInfo.findUniqueOrThrow({ where: { leadId: j.id } });
      expect(info).toMatchObject({ ipAddress: "203.0.113.42", city: "Frankfurt am Main", country: "Germany", countryCode: "DE", timeZone: "Europe/Berlin", budgetCurrency: "GBP" });
      expect(info.city).not.toBe("Ashburn");
    });

    it.each([
      ["a wrong signature", () => ({ ...signed({ ip: "203.0.113.42" }), [ctxSignatureHeader()]: "0".repeat(64) })],
      ["a signature made with another secret", () => signed({ ip: "203.0.113.42" }, "another-secret-another-secret-another!")],
      ["a stale timestamp (replay of an old envelope)", () => signed({ ip: "203.0.113.42", ts: Math.floor(Date.now() / 1000) - 3600 })],
      ["a future-dated timestamp", () => signed({ ip: "203.0.113.42", ts: Math.floor(Date.now() / 1000) + 3600 })],
      ["a context without its signature", () => ({ [ctxContextHeader()]: (signed({ ip: "203.0.113.42" }) as Record<string, string>)[ctxContextHeader()] })],
    ])("%s: the context is refused and NOTHING is recorded (never a fallback to the connection headers)", async (_label, headers) => {
      vi.stubEnv("TRUSTED_PROXY", "vercel");
      vi.stubEnv("LEAD_INGEST_SECRET", SECRET);
      const j = await ok(await post(body(), { "x-vercel-forwarded-for": "198.51.100.200", "x-vercel-ip-city": "Ashburn", "x-vercel-ip-country": "US", ...headers() }));
      expect(await prisma.leadSubmissionInfo.count({ where: { leadId: j.id } })).toBe(0);
    });

    it("a signed context is refused when this deployment has no ingest secret configured", async () => {
      vi.stubEnv("TRUSTED_PROXY", "vercel");
      vi.stubEnv("LEAD_INGEST_SECRET", "");
      const j = await ok(await post(body(), { "x-vercel-forwarded-for": "198.51.100.200", ...signed({ ip: "203.0.113.42" }) }));
      expect(await prisma.leadSubmissionInfo.count({ where: { leadId: j.id } })).toBe(0);
    });

    it("a correctly signed context still cannot smuggle a private address", async () => {
      vi.stubEnv("LEAD_INGEST_SECRET", SECRET);
      const j = await ok(await post(body(), signed({ ip: "192.168.1.5", country: "DE" })));
      const info = await prisma.leadSubmissionInfo.findUnique({ where: { leadId: j.id } });
      expect(info?.ipAddress ?? null).toBeNull();
      expect(info?.countryCode).toBe("DE");
    });
  });

  describe("malformed input is rejected without creating anything", () => {
    const leadsBefore = () => prisma.lead.count({ where: { source: "WEBSITE" } });
    it.each([
      ["a segment with a bad IATA length", { segments: [{ departureAirportIata: "FR", arrivalAirportIata: "JFK" }] }],
      ["an empty segments array", { segments: [] }],
      ["too many segments", { segments: Array.from({ length: 30 }, () => ({ departureAirportIata: "FRA", arrivalAirportIata: "JFK" })) }],
      ["a non-array segments value", { segments: "FRA-JFK" }],
      ["an invalid phone", { phone: "123" }],
      ["a malformed budget currency", { approximateBudget: 100, budgetCurrency: "EURO" }],
      ["a malformed submission key", { submissionId: "bad key with spaces!" }],
      ["a too-short submission key", { submissionId: "abc" }],
    ])("%s -> 400", async (_label, over) => {
      const before = await leadsBefore();
      const res = await post(body(over as Record<string, unknown>));
      expect(res.status).toBe(400);
      expect(await leadsBefore()).toBe(before);
    });

    it("an unknown company -> 400; invalid JSON -> 400", async () => {
      expect((await post(body({ companyId: "no-such-company" }))).status).toBe(400);
      const res = await POST(new Request("http://localhost/api/public/lead-capture", { method: "POST", body: "{bad", headers: { "content-type": "application/json" } }));
      expect(res.status).toBe(400);
    });
  });
});

// header-name accessors usable inside it.each tables (evaluated before the module is imported)
function ctxContextHeader() {
  return "x-ct-visitor-context";
}
function ctxSignatureHeader() {
  return "x-ct-visitor-signature";
}
