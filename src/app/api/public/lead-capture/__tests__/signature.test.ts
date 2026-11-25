import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { signWebsiteRequestV2 } from "@/server/website-request-signature";
import { VISITOR_CONTEXT_HEADER, VISITOR_SIGNATURE_HEADER, signVisitorContext } from "@/server/lead-ingest-context";

// POST /api/public/lead-capture behind the website signature guard. Before this change it was the one website-facing route WITHOUT the guard, so strict mode
// (WEBSITE_SIGNATURE_REQUIRED=true) could be bypassed by posting a lead here directly. Now: where signatures are required (always in production) an unsigned, v1, invalid, expired, modified, cross-route, cross-company or
// replayed request is refused with 401 BEFORE anything is stored; development without the switch -> unsigned accepted, plus a valid v2 signature is verified and used.
// No database: Prisma, the limiter and lead distribution are mocks; the nonce store is a Set with the same first-insert-wins contract as the real unique key.

const SECRET = "unit-test-ingest-secret-0123456789-abcdefghijkl"; // throwaway
const COMPANY = "company-1";
const PATH = "/api/public/lead-capture";
const nonces = new Set<string>();
const leads: Array<Record<string, unknown>> = [];
const companyLookups = vi.fn(async ({ where }: { where: { id: string } }) => (where.id === COMPANY ? { id: COMPANY } : null));
const limiter = vi.fn(async (...args: unknown[]) => (void args, { allowed: true }) as { allowed: boolean; retryAfterSeconds?: number });

vi.mock("@/lib/prisma", () => {
  const prisma: Record<string, unknown> = {
    company: { findUnique: (...a: unknown[]) => (companyLookups as unknown as (...x: unknown[]) => unknown)(...a) },
    contact: { findUnique: vi.fn(async () => ({ ownerId: null })) },
    lead: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        leads.push(data);
        return { id: `lead-${leads.length}` };
      }),
    },
    $queryRaw: vi.fn(async (_s: unknown, _id: unknown, key: string) => (nonces.has(key) ? [] : (nonces.add(key), [{ id: "n" }]))),
  };
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);
  return { prisma };
});
vi.mock("@/server/contact-resolution", () => ({ resolveContactForNewLead: vi.fn(async () => ({ contactId: "contact-1", isNewContact: true })) }));
vi.mock("@/server/actions/lead-queue", () => ({ distributeNewWebsiteLead: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("@/server/queries/reference-data", () => ({ resolveAirportCodes: vi.fn(async () => ({})) }));
vi.mock("@/server/geo/ip-geolocation", () => ({ lookupIpLocation: vi.fn(async () => ({ status: "unresolved", reason: "not-found" })) }));
vi.mock("@/server/security/rate-limit", () => ({
  checkPublicRateLimit: vi.fn(async () => ({ allowed: true })),
  checkPublicRateLimitForKey: (...args: unknown[]) => limiter(...args),
  RATE_LIMITS: { LEAD_CAPTURE: { windowMs: 1000, maxAttempts: 20 } },
}));

const BODY = { companyId: COMPANY, firstName: "Jane", lastName: "Traveler", phone: "+14155550100" };
const SIGNED_IP = "203.0.113.50";

type Over = { path?: string; company?: string; payload?: Record<string, unknown>; secret?: string; body?: string };
function request(body: Record<string, unknown>, over: Over | false = {}, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  let signed: Record<string, string> = {};
  if (over !== false) {
    const s = signWebsiteRequestV2({
      secret: over.secret ?? SECRET,
      method: "POST",
      path: over.path ?? PATH,
      companyId: over.company ?? String(body.companyId),
      body: over.body ?? text, // a signature computed over DIFFERENT bytes than the ones sent
      payload: { v: 2, ts: Math.floor(Date.now() / 1000), nonce: randomBytes(16).toString("base64url"), ip: SIGNED_IP, ...(over.payload ?? {}) } as never,
    });
    signed = { [VISITOR_CONTEXT_HEADER]: s.context, [VISITOR_SIGNATURE_HEADER]: s.signature };
  }
  return new Request(`http://crm.internal${PATH}`, { method: "POST", body: text, headers: { "content-type": "application/json", ...signed, ...headers } });
}
const post = async (req: Request) => (await import("../route")).POST(req);

beforeEach(() => {
  nonces.clear();
  leads.length = 0;
  companyLookups.mockClear();
  limiter.mockClear();
  limiter.mockImplementation(async () => ({ allowed: true }));
  vi.stubEnv("LEAD_INGEST_SECRET", SECRET);
  vi.stubEnv("WEBSITE_SIGNATURE_REQUIRED", "true"); // as production does; development without the switch is tested below
  vi.stubEnv("TRUSTED_PROXY", "none");
});

describe("strict mode (WEBSITE_SIGNATURE_REQUIRED=true)", () => {
  it("a correctly signed request creates the lead once, with the IP the website signed (never the connection's)", async () => {
    const res = await post(request(BODY));
    expect(res.status).toBe(200);
    expect(leads).toHaveLength(1);
    expect(JSON.stringify(leads[0])).toContain(SIGNED_IP);
  });

  it("unsigned: 401, nothing stored, and the database is not even consulted", async () => {
    const res = await post(request(BODY, false));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "Invalid request signature." });
    expect(leads).toHaveLength(0);
    expect(companyLookups).not.toHaveBeenCalled();
  });

  it("the same signed request replayed is refused: one lead, never two", async () => {
    const first = request(BODY);
    const replay = new Request(first.url, { method: "POST", body: JSON.stringify(BODY), headers: first.headers });
    expect((await post(first)).status).toBe(200);
    expect((await post(replay)).status).toBe(401);
    expect(leads).toHaveLength(1);
  });

  it("a captured signature cannot authorise a DIFFERENT submission (modified body)", async () => {
    const res = await post(request({ ...BODY, firstName: "Mallory" }, { body: JSON.stringify(BODY) }));
    expect(res.status).toBe(401);
    expect(leads).toHaveLength(0);
  });

  it("a signature made for another route (contact inquiry) cannot be used here", async () => {
    expect((await post(request(BODY, { path: "/api/public/contact-inquiry" }))).status).toBe(401);
    expect(leads).toHaveLength(0);
  });

  it("a signature made for another company cannot be used here (cross-company substitution)", async () => {
    expect((await post(request(BODY, { company: "company-2" }))).status).toBe(401);
    expect(leads).toHaveLength(0);
  });

  it("a signature made with a different secret, an expired one and a far-future one are all refused", async () => {
    expect((await post(request(BODY, { secret: "another-completely-different-secret-value-xx" }))).status).toBe(401);
    expect((await post(request(BODY, { payload: { ts: Math.floor(Date.now() / 1000) - 3600 } }))).status).toBe(401);
    expect((await post(request(BODY, { payload: { ts: Math.floor(Date.now() / 1000) + 3600 } }))).status).toBe(401);
    expect(leads).toHaveLength(0);
  });

  it("there is no downgrade: the old v1 visitor context is refused too", async () => {
    const v1 = signVisitorContext({ v: 1, ts: Math.floor(Date.now() / 1000), ip: SIGNED_IP } as never, SECRET);
    const res = await post(request(BODY, false, { [VISITOR_CONTEXT_HEADER]: v1.context, [VISITOR_SIGNATURE_HEADER]: v1.signature }));
    expect(res.status).toBe(401);
    expect(leads).toHaveLength(0);
  });

  it("rate-limits per VERIFIED visitor IP in a website-only bucket (the website's own connection is not the key); over the limit is 429 and nothing is stored", async () => {
    await post(request(BODY));
    expect(limiter).toHaveBeenCalledWith(SIGNED_IP, "LEAD_CAPTURE:website", expect.objectContaining({ maxAttempts: 20 }));
    limiter.mockImplementation(async () => ({ allowed: false, retryAfterSeconds: 120 }));
    leads.length = 0;
    const res = await post(request(BODY));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("120");
    expect(leads).toHaveLength(0);
  });

  it("an invalid body is still a plain 400 (validation precedes the guard, so a signature oracle is not offered to a malformed request)", async () => {
    const res = await post(request({ ...BODY, phone: "123" }, false));
    expect(res.status).toBe(400);
  });
});

describe("development without WEBSITE_SIGNATURE_REQUIRED (production always requires a signature)", () => {
  beforeEach(() => vi.stubEnv("WEBSITE_SIGNATURE_REQUIRED", ""));

  it("outside production an unsigned request is accepted: the lead is created", async () => {
    const res = await post(request(BODY, false));
    expect(res.status).toBe(200);
    expect(leads).toHaveLength(1);
  });

  it("a valid v2 signature is already verified and used (its visitor IP is stored)", async () => {
    expect((await post(request(BODY))).status).toBe(200);
    expect(JSON.stringify(leads[0])).toContain(SIGNED_IP);
  });

  it("a REPLAYED v2 signature is not given the signed visitor facts (it is handled as an unsigned request)", async () => {
    const first = request(BODY);
    const replay = new Request(first.url, { method: "POST", body: JSON.stringify(BODY), headers: first.headers });
    await post(first);
    leads.length = 0;
    const res = await post(replay);
    expect(res.status).toBe(200);
    expect(JSON.stringify(leads[0] ?? {})).not.toContain(SIGNED_IP);
  });

  it("with the switch set and no secret, every request is refused with 503 and no lead is created (a requirement that cannot be checked is never dropped)", async () => {
    vi.stubEnv("LEAD_INGEST_SECRET", "");
    vi.stubEnv("WEBSITE_SIGNATURE_REQUIRED", "true");
    expect((await post(request(BODY, false))).status).toBe(503);
    expect((await post(request(BODY))).status).toBe(503);
    expect(leads).toHaveLength(0);
  });

  it("in production an unsigned or replayed request creates no lead, even with the switch unset", async () => {
    vi.stubEnv("APP_ENV", "production");
    expect((await post(request(BODY, false))).status).toBe(401);
    expect(leads).toHaveLength(0);
    const first = request(BODY);
    const replay = new Request(first.url, { method: "POST", body: JSON.stringify(BODY), headers: first.headers });
    expect((await post(first)).status).toBe(200);
    expect((await post(replay)).status).toBe(401);
    expect(leads).toHaveLength(1);
  });
});
