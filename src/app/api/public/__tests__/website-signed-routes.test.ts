import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { signWebsiteRequestV2 } from "@/server/website-request-signature";
import { VISITOR_CONTEXT_HEADER, VISITOR_SIGNATURE_HEADER } from "@/server/lead-ingest-context";

// The two public website routes (contact inquiry, newsletter subscribe) with signing v2 enforced: unsigned, replayed, cross-route and cross-company
// requests are refused BEFORE anything is stored, and the per-visitor rate limit is keyed on the verified visitor IP. Prisma, notifications and the
// rate limiter are mocks (no database); the nonce store is a Set with the same first-insert-wins contract as the real unique key.

const SECRET = "unit-test-ingest-secret-0123456789-abcdefghijkl"; // throwaway
const nonces = new Set<string>();
const stored: Array<Record<string, unknown>> = [];
const subscribed: string[] = [];
const limiter = vi.fn(async (...args: unknown[]) => (void args, { allowed: true }) as { allowed: boolean; retryAfterSeconds?: number });

vi.mock("@/server/admin-notifications", () => ({ notifyNewInquiry: vi.fn(async () => {}), notifyNewSubscriber: vi.fn(async () => {}) }));
vi.mock("@/server/geo/ip-geolocation", () => ({ lookupIpLocation: vi.fn(async () => ({ status: "unresolved", reason: "not-found" })) }));
vi.mock("@/server/security/rate-limit", () => ({
  checkPublicRateLimit: vi.fn(async () => ({ allowed: true })),
  checkPublicRateLimitForKey: (...args: unknown[]) => limiter(...args),
  RATE_LIMITS: { CONTACT_INQUIRY: { windowMs: 1000, maxAttempts: 20 }, CRM_INQUIRY: { windowMs: 1000, maxAttempts: 20 }, SUBSCRIBE: { windowMs: 1000, maxAttempts: 30 } },
}));
vi.mock("@/lib/prisma", () => {
  const prisma: Record<string, unknown> = {
    company: { findUnique: vi.fn(async () => ({ id: "company-1" })) },
    contact: { findFirst: vi.fn(async () => null) },
    contactInquiry: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        stored.push(data);
        return { id: `inquiry-${stored.length}`, ...data };
      }),
    },
    subscriber: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async ({ create }: { create: { email: string } }) => {
        subscribed.push(create.email);
        return { id: "sub-1", ...create };
      }),
    },
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async (_s: unknown, _id: unknown, key: string) => (nonces.has(key) ? [] : (nonces.add(key), [{ id: "n" }]))),
  };
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);
  return { prisma };
});

const COMPANY = "company-1";
const CONTACT_BODY = { companyId: COMPANY, firstName: "Jane", lastName: "Traveler", email: "jane@example.test", phone: "+14155550123", subject: "GENERAL_INQUIRY", message: "Hello, I have a question." };
const SUBSCRIBE_BODY = { companyId: COMPANY, email: "news@example.test", source: "website-footer" };

type Over = { path?: string; company?: string; method?: string; payload?: Record<string, unknown>; secret?: string };
function request(path: string, body: Record<string, unknown>, over: Over | false = {}, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  let signed: Record<string, string> = {};
  if (over !== false) {
    const s = signWebsiteRequestV2({
      secret: over.secret ?? SECRET,
      method: over.method ?? "POST",
      path: over.path ?? path,
      companyId: over.company ?? String(body.companyId),
      body: text,
      payload: { v: 2, ts: Math.floor(Date.now() / 1000), nonce: randomBytes(16).toString("base64url"), ...(over.payload ?? {}) } as never,
    });
    signed = { [VISITOR_CONTEXT_HEADER]: s.context, [VISITOR_SIGNATURE_HEADER]: s.signature };
  }
  return new Request(`http://crm.internal${path}`, { method: "POST", body: text, headers: { "content-type": "application/json", ...signed, ...headers } });
}

beforeEach(() => {
  nonces.clear();
  stored.length = 0;
  subscribed.length = 0;
  limiter.mockClear();
  limiter.mockImplementation(async () => ({ allowed: true }));
  vi.stubEnv("LEAD_INGEST_SECRET", SECRET);
  vi.stubEnv("WEBSITE_SIGNATURE_REQUIRED", "true"); // as production does; production itself and development without the switch are tested below
  vi.stubEnv("TRUSTED_PROXY", "none");
});
afterEach(() => vi.unstubAllEnvs());

const contact = async (req: Request) => (await import("@/app/api/public/contact-inquiry/route")).POST(req);
const subscribe = async (req: Request) => (await import("@/app/api/public/subscribe/route")).POST(req);

describe("POST /api/public/contact-inquiry with signing v2", () => {
  const PATH = "/api/public/contact-inquiry";

  it("a correctly signed request is stored once, with the visitor facts of the authenticated context", async () => {
    const res = await contact(request(PATH, CONTACT_BODY, { payload: { ip: "203.0.113.20", country: "AU" } }));
    expect(res.status).toBe(200);
    expect(stored).toHaveLength(1);
    expect((stored[0].submissionInfo as { create: Record<string, unknown> }).create).toMatchObject({ ipAddress: "203.0.113.20", countryCode: "AU" });
  });

  it("unsigned: refused with 401 and nothing stored", async () => {
    const res = await contact(request(PATH, CONTACT_BODY, false));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "Invalid request signature." });
    expect(stored).toHaveLength(0);
  });

  it("the same signed request replayed is refused and does not store a second inquiry", async () => {
    const req = request(PATH, CONTACT_BODY);
    const headers = { [VISITOR_CONTEXT_HEADER]: req.headers.get(VISITOR_CONTEXT_HEADER) as string, [VISITOR_SIGNATURE_HEADER]: req.headers.get(VISITOR_SIGNATURE_HEADER) as string };
    expect((await contact(req)).status).toBe(200);
    expect((await contact(request(PATH, CONTACT_BODY, false, headers))).status).toBe(401);
    expect(stored).toHaveLength(1);
  });

  it("a captured signature cannot authorise a DIFFERENT submission (modified body)", async () => {
    const original = request(PATH, CONTACT_BODY);
    const headers = { [VISITOR_CONTEXT_HEADER]: original.headers.get(VISITOR_CONTEXT_HEADER) as string, [VISITOR_SIGNATURE_HEADER]: original.headers.get(VISITOR_SIGNATURE_HEADER) as string };
    const res = await contact(request(PATH, { ...CONTACT_BODY, message: "Something else entirely." }, false, headers));
    expect(res.status).toBe(401);
    expect(stored).toHaveLength(0);
  });

  it("a signature made for another route (the newsletter) cannot be used here", async () => {
    const res = await contact(request(PATH, CONTACT_BODY, { path: "/api/public/subscribe" }));
    expect(res.status).toBe(401);
    expect(stored).toHaveLength(0);
  });

  it("a signature made for another company cannot be used here (cross-company substitution)", async () => {
    const res = await contact(request(PATH, CONTACT_BODY, { company: "company-2" }));
    expect(res.status).toBe(401);
    expect(stored).toHaveLength(0);
  });

  it("retries: two separately signed attempts of the same message are both accepted by the signature check (the idempotency key makes them one inquiry)", async () => {
    const body = { ...CONTACT_BODY, submissionId: "retry-key-abcdef.0123abcd4567ef89" };
    expect((await contact(request(PATH, body))).status).toBe(200);
    expect((await contact(request(PATH, body))).status).toBe(200);
  });

  it("rate-limits per verified visitor IP in a website-only bucket; over the limit is 429 and nothing is stored", async () => {
    limiter.mockImplementation(async () => ({ allowed: false, retryAfterSeconds: 30 }));
    const res = await contact(request(PATH, CONTACT_BODY, { payload: { ip: "203.0.113.20" } }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(limiter).toHaveBeenCalledWith("203.0.113.20", "CONTACT_INQUIRY:website", { windowMs: 1000, maxAttempts: 20 });
    expect(stored).toHaveLength(0);
  });

  it("a spoofed forwarding header on the website's connection is never used as the rate-limit key", async () => {
    await contact(request(PATH, CONTACT_BODY, { payload: { ip: "203.0.113.20" } }, { "x-forwarded-for": "198.51.100.99", "cf-connecting-ip": "198.51.100.98" }));
    expect(limiter.mock.calls.every((c) => c[0] === "203.0.113.20")).toBe(true);
  });
});

describe("POST /api/public/subscribe with signing v2", () => {
  const PATH = "/api/public/subscribe";

  it("a correctly signed request subscribes once", async () => {
    const res = await subscribe(request(PATH, SUBSCRIBE_BODY));
    expect(res.status).toBe(200);
  });

  it("unsigned: refused with 401, so nobody can enrol arbitrary addresses by calling the public route directly", async () => {
    const res = await subscribe(request(PATH, SUBSCRIBE_BODY, false));
    expect(res.status).toBe(401);
    expect(subscribed).toHaveLength(0);
  });

  it("replay, modified body (another address) and a signature made for the contact route are all refused", async () => {
    const req = request(PATH, SUBSCRIBE_BODY);
    const headers = { [VISITOR_CONTEXT_HEADER]: req.headers.get(VISITOR_CONTEXT_HEADER) as string, [VISITOR_SIGNATURE_HEADER]: req.headers.get(VISITOR_SIGNATURE_HEADER) as string };
    expect((await subscribe(req)).status).toBe(200);
    expect((await subscribe(request(PATH, SUBSCRIBE_BODY, false, headers))).status).toBe(401); // replay
    expect((await subscribe(request(PATH, { ...SUBSCRIBE_BODY, email: "victim@example.test" }, false, headers))).status).toBe(401); // modified body
    expect((await subscribe(request(PATH, SUBSCRIBE_BODY, { path: "/api/public/contact-inquiry" }))).status).toBe(401); // another route
    expect((await subscribe(request(PATH, SUBSCRIBE_BODY, { company: "company-2" }))).status).toBe(401); // another company
  });

  it("with no secret configured every request is refused with 503: nothing could be verified", async () => {
    vi.stubEnv("LEAD_INGEST_SECRET", "");
    expect((await subscribe(request(PATH, SUBSCRIBE_BODY, false))).status).toBe(503);
    expect((await subscribe(request(PATH, SUBSCRIBE_BODY))).status).toBe(503);
  });
});

describe("production requires a signature whatever the switch says: there is no optional mode", () => {
  beforeEach(() => vi.stubEnv("APP_ENV", "production"));

  it.each(["", "false", "true"])("WEBSITE_SIGNATURE_REQUIRED=%j: unsigned and replayed requests are refused, a fresh signed one is accepted", async (flag) => {
    vi.stubEnv("WEBSITE_SIGNATURE_REQUIRED", flag);
    expect((await subscribe(request("/api/public/subscribe", SUBSCRIBE_BODY, false))).status).toBe(401);
    expect((await contact(request("/api/public/contact-inquiry", CONTACT_BODY, false))).status).toBe(401);
    const req = request("/api/public/subscribe", SUBSCRIBE_BODY);
    const replay = new Request(req.url, { method: "POST", body: JSON.stringify(SUBSCRIBE_BODY), headers: req.headers });
    expect((await subscribe(req)).status).toBe(200);
    expect((await subscribe(replay)).status).toBe(401);
  });

  it.each(["", "short-secret"])("LEAD_INGEST_SECRET=%j: both public website routes answer 503", async (secret) => {
    vi.stubEnv("LEAD_INGEST_SECRET", secret);
    expect((await subscribe(request("/api/public/subscribe", SUBSCRIBE_BODY, false))).status).toBe(503);
    expect((await contact(request("/api/public/contact-inquiry", CONTACT_BODY, false))).status).toBe(503);
  });
});

describe("development without WEBSITE_SIGNATURE_REQUIRED (never production)", () => {
  beforeEach(() => vi.stubEnv("WEBSITE_SIGNATURE_REQUIRED", ""));

  it("unsigned requests are accepted on both public routes, so a local CRM needs no website secret", async () => {
    expect((await subscribe(request("/api/public/subscribe", SUBSCRIBE_BODY, false))).status).toBe(200);
    expect((await contact(request("/api/public/contact-inquiry", CONTACT_BODY, false))).status).toBeLessThan(300);
  });

  it("a v2 signature is still verified and its signed visitor keys the per-visitor limit", async () => {
    const req = request("/api/public/subscribe", SUBSCRIBE_BODY, { payload: { ip: "203.0.113.50" } });
    expect((await subscribe(req)).status).toBe(200);
    expect(limiter).toHaveBeenCalledWith("203.0.113.50", "SUBSCRIBE:website", expect.anything());
  });
});
