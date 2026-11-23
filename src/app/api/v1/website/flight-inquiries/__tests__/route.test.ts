import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { signWebsiteRequestV2 } from "@/server/website-request-signature";
import { websiteApiCompanyId } from "@/server/security/website-api-auth";

// Route-level contract test of POST /api/v1/website/flight-inquiries with the payloads the UPDATED Business Flights website actually builds
// (its src/lib/crm-api/flight-inquiry.ts: an explicit allow-list; budget -> approximateBudget, notes -> additionalNotes, flexibleDates -> datesFlexible,
// segments[i].from.iata -> departureAirportIata; the submission key travels in the Idempotency-Key header, never in the body).
// Everything below the route is mocked (no database, no e-mail, no network); synthetic data only. What a mocked store cannot show - the real primary-key
// race, the advisory lock, the stored fingerprint - is covered by website-api.integration.test.ts, which needs a real PostgreSQL.

const KEY = "unit-test-website-api-key-0123456789-abcdefghijkl"; // throwaway
const SECRET = "unit-test-ingest-secret-0123456789-abcdefghijkl"; // throwaway
type CreatedLead = { data: Record<string, unknown> & { segments?: unknown; submissionId?: unknown }; companyId: string; idempotency: { source: string; requestHash: string }; submissionInfo?: Record<string, unknown> };
const created: CreatedLead[] = [];
let createResult: { status: "created" | "duplicate" | "failed"; id: string };
let existing: { contact: { companyId: string }; ingestFingerprint: { requestHash: string } | null } | null;
let companyExists = true;
const audits: string[] = [];
/** Stands in for the RateLimitCounter unique key: the first INSERT of a nonce wins, every later one conflicts (the real race is an integration concern). */
const nonces = new Set<string>();
let nonceStoreDown = false;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    company: { findUnique: vi.fn(async () => (companyExists ? { id: "default-company" } : null)) },
    lead: { findUnique: vi.fn(async () => existing) },
    $queryRaw: vi.fn(async (_strings: unknown, _id: unknown, key: string) => {
      if (nonceStoreDown) throw new Error("database down");
      if (nonces.has(key)) return [];
      nonces.add(key);
      return [{ id: "n" }];
    }),
  },
}));
/** Stands in for the per-visitor fixed-window counter (checkPublicRateLimitForKey): one count per (client key, endpoint), refused above the configured allowance. */
const visitorBuckets = new Map<string, number>();
const visitorLimitCalls: { key: string; endpoint: string; maxAttempts: number }[] = [];
vi.mock("@/server/security/rate-limit", () => ({
  checkAccountRateLimit: vi.fn(async () => ({ allowed: true })),
  checkPublicRateLimitForKey: vi.fn(async (key: string, endpoint: string, config: { maxAttempts: number }) => {
    visitorLimitCalls.push({ key, endpoint, maxAttempts: config.maxAttempts });
    const bucket = `${key}|${endpoint}`;
    const count = (visitorBuckets.get(bucket) ?? 0) + 1;
    visitorBuckets.set(bucket, count);
    return count > config.maxAttempts ? { allowed: false, retryAfterSeconds: 42 } : { allowed: true };
  }),
  RATE_LIMITS: { WEBSITE_API_AUTH_FAILURES: {}, WEBSITE_API_REQUESTS: {}, LEAD_CAPTURE: { windowMs: 900000, maxAttempts: 2 } },
}));
vi.mock("@/server/website-api-audit", () => ({ auditWebsiteApi: vi.fn(async (a: { action: string }) => void audits.push(a.action)) }));
vi.mock("@/server/geo/ip-geolocation", () => ({ lookupIpLocation: vi.fn(async () => ({ status: "unresolved", reason: "not-found" })) }));
vi.mock("@/server/lead-intake", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/lead-intake")>()),
  createWebsiteFlightLead: vi.fn(async (args: CreatedLead) => {
    created.push(args);
    return createResult;
  }),
}));

const ONE_WAY = { firstName: "Ada", lastName: "Lovelace", phone: "+14155709267", email: "ada@example.test", tripType: "ONE_WAY", departureAirportIata: "JFK", arrivalAirportIata: "LHR", departureDate: "2027-03-01", cabinClass: "BUSINESS", adults: 1, children: 0, infants: 0, datesFlexible: false };
const ROUND_TRIP = { ...ONE_WAY, tripType: "ROUND_TRIP", returnDate: "2027-03-15", adults: 2, children: 1, infants: 1, datesFlexible: true, preferredAirline: "Example Air", approximateBudget: 4500, budgetCurrency: "USD", additionalNotes: "Window seats if possible." };
const MULTI_CITY = { ...ONE_WAY, tripType: "MULTI_CITY", segments: [{ departureAirportIata: "JFK", arrivalAirportIata: "LHR", departureDate: "2027-03-01" }, { departureAirportIata: "LHR", arrivalAirportIata: "DXB", departureDate: "2027-03-05" }, { departureAirportIata: "DXB", arrivalAirportIata: "JFK", departureDate: "2027-03-12" }] };

type Signing = { payload?: Record<string, unknown>; secret?: string; method?: string; path?: string; company?: string; ts?: number; nonce?: string; body?: string };
/** The headers a correct website would send for this exact body (signing v2); every field can be overridden to build a wrong one. */
const signFor = (bodyText: string, over: Signing = {}) => {
  const ts = over.ts ?? Math.floor(Date.now() / 1000);
  const nonce = over.nonce ?? randomBytes(16).toString("base64url");
  const { context, signature } = signWebsiteRequestV2({
    secret: over.secret ?? SECRET,
    method: over.method ?? "POST",
    path: over.path ?? "/api/v1/website/flight-inquiries",
    companyId: over.company ?? websiteApiCompanyId(),
    body: over.body ?? bodyText,
    payload: { v: 2, ts, nonce, ...(over.payload ?? {}) } as never,
  });
  return { "x-ct-visitor-context": context, "x-ct-visitor-signature": signature };
};
/** `signing: false` sends the request unsigned; an object signs it (default: correctly) with the given overrides. */
const call = async (body: unknown, headers: Record<string, string> = {}, raw = false, signing: false | Signing = {}) => {
  const { POST } = await import("../route");
  const bodyText = raw ? (body as string) : JSON.stringify(body);
  const signed = signing === false || "x-ct-visitor-context" in headers ? {} : signFor(bodyText, signing);
  return POST(
    new Request("http://crm.internal/api/v1/website/flight-inquiries", {
      method: "POST",
      body: bodyText,
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, "idempotency-key": "9b1f3c52-77aa-4d0e-8d51-0a1b2c3d4e5f.0123456789abcdef", ...signed, ...headers },
    })
  );
};

beforeEach(() => {
  visitorBuckets.clear();
  visitorLimitCalls.length = 0;
  created.length = 0;
  audits.length = 0;
  nonces.clear();
  nonceStoreDown = false;
  createResult = { status: "created", id: "lead-1" };
  existing = null;
  companyExists = true;
  vi.stubEnv("WEBSITE_API_KEY", KEY);
  vi.stubEnv("WEBSITE_API_KEY_NEXT", "");
  vi.stubEnv("WEBSITE_API_COMPANY_ID", "");
  vi.stubEnv("WEBSITE_API_ALLOW_PUBLIC_ROUTE", "");
  vi.stubEnv("LEAD_INGEST_SECRET", SECRET);
  vi.stubEnv("WEBSITE_SIGNATURE_REQUIRED", "true"); // strict mode (the final rollout state); the transitional default is tested separately below
  vi.stubEnv("TRUSTED_PROXY", "none");
  vi.stubEnv("VERCEL", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("the website's payloads are accepted and mapped onto the CRM lead", () => {
  it.each([["one-way", ONE_WAY], ["round trip with budget, airline and notes", ROUND_TRIP], ["multi-city (every leg, in order)", MULTI_CITY]])("%s -> 201", async (_n, body) => {
    const res = await call(body);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, leadId: "lead-1", duplicate: false });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(created).toHaveLength(1);
    const { data, companyId, idempotency } = created[0];
    expect(companyId).toBe("default-company"); // fixed by the credential, never by the caller
    expect(data.submissionId).toBe("9b1f3c52-77aa-4d0e-8d51-0a1b2c3d4e5f.0123456789abcdef"); // the header key becomes the lead's submission id
    expect(data).toMatchObject({ firstName: "Ada", lastName: "Lovelace", phone: "+14155709267", departureAirportIata: body.departureAirportIata, tripType: body.tripType });
    expect(idempotency).toMatchObject({ source: "website-api" });
    expect(idempotency.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(audits).toEqual(["WEBSITE_API_LEAD_CREATED"]);
  });

  it("passes every field through unchanged: passengers, dates, budget and its currency, notes, flexibility and all multi-city legs", async () => {
    await call(MULTI_CITY);
    await call({ ...ROUND_TRIP, submissionIgnored: undefined });
    expect(created[0].data.segments).toEqual(MULTI_CITY.segments);
    expect(created[1].data).toMatchObject({ adults: 2, children: 1, infants: 1, returnDate: "2027-03-15", datesFlexible: true, preferredAirline: "Example Air", approximateBudget: 4500, budgetCurrency: "USD", additionalNotes: "Window seats if possible." });
  });

  it("the same request body hashes identically whatever the key order (a retry is recognised as the same request)", async () => {
    await call(ROUND_TRIP);
    await call(Object.fromEntries(Object.entries(ROUND_TRIP).reverse()));
    expect(created[1].idempotency.requestHash).toBe(created[0].idempotency.requestHash);
    await call({ ...ROUND_TRIP, adults: 3 });
    expect(created[2].idempotency.requestHash).not.toBe(created[0].idempotency.requestHash);
  });
});

describe("the CRM is strict and fails safely", () => {
  it.each([
    ["a website-only field (honeypot)", { ...ONE_WAY, website: "" }],
    ["renderedAt", { ...ONE_WAY, renderedAt: 1 }],
    ["submissionId in the body (it belongs in the header)", { ...ONE_WAY, submissionId: "abcdefgh12345678" }],
    ["a caller-chosen company", { ...ONE_WAY, companyId: "other-company" }],
    ["CRM-owned fields (status, source, assignment, IP)", { ...ONE_WAY, status: "BOOKED", source: "WEBSITE", assignedAgentId: "x", ipAddress: "198.51.100.9" }],
    ["a missing last name", { ...ONE_WAY, lastName: "" }],
    ["an impossible phone number", { ...ONE_WAY, phone: "123" }],
    ["a bad airport code", { ...ONE_WAY, departureAirportIata: "JFKX" }],
    ["too many adults", { ...ONE_WAY, adults: 21 }],
    ["a non-positive budget", { ...ROUND_TRIP, approximateBudget: 0 }],
    ["a bad currency", { ...ROUND_TRIP, budgetCurrency: "dollars" }],
    ["a date flexibility above 3 days", { ...ONE_WAY, dateFlexibilityDays: 4 }],
    ["a negative date flexibility", { ...ONE_WAY, dateFlexibilityDays: -1 }],
    ["a fractional date flexibility", { ...ONE_WAY, dateFlexibilityDays: 1.5 }],
    ["a date flexibility sent as text", { ...ONE_WAY, dateFlexibilityDays: "2" }],
    ["exact dates yet 'flexible'", { ...ONE_WAY, dateFlexibilityDays: 0, datesFlexible: true }],
    ["3 days yet 'not flexible'", { ...ONE_WAY, dateFlexibilityDays: 3, datesFlexible: false }],
  ])("rejects %s with 400 validation_failed, field paths only, nothing created", async (_n, body) => {
    const res = await call(body);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("validation_failed");
    expect(JSON.stringify(json)).not.toMatch(/Lovelace|ada@example|198\.51\.100\.9/); // never echoes submitted values
    expect(created).toHaveLength(0);
  });

  it("authentication: no key / wrong key -> 401, no configured key -> 503, the public Cloudflare hostname -> 404 (private network only)", async () => {
    expect((await call(ONE_WAY, { authorization: "" })).status).toBe(401);
    expect((await call(ONE_WAY, { authorization: "Bearer wrong-key-wrong-key-wrong-key-wrong-key" })).status).toBe(401);
    vi.stubEnv("WEBSITE_API_KEY", "");
    expect((await call(ONE_WAY)).status).toBe(503);
    vi.stubEnv("WEBSITE_API_KEY", KEY);
    expect((await call(ONE_WAY, { "cf-ray": "abc-LHR" })).status).toBe(404);
    expect((await call(ONE_WAY, { "cf-connecting-ip": "198.51.100.9" })).status).toBe(404);
    expect(created).toHaveLength(0);
    vi.stubEnv("WEBSITE_API_ALLOW_PUBLIC_ROUTE", "true");
    expect((await call(ONE_WAY, { "cf-ray": "abc-LHR" })).status).toBe(201);
  });

  it("protocol: wrong content type 415, missing/short/odd Idempotency-Key 400, oversize 413, invalid JSON 400, non-object 400", async () => {
    expect((await call(ONE_WAY, { "content-type": "text/plain" })).status).toBe(415);
    for (const key of ["", "short", "has space in it 1234", "x".repeat(201)]) expect((await call(ONE_WAY, { "idempotency-key": key })).status, key).toBe(400);
    expect((await call("{not json", {}, true)).status).toBe(400);
    expect((await call("[1,2]", {}, true)).status).toBe(400);
    expect((await call(ONE_WAY, { "content-length": String(40 * 1024) })).status).toBe(413);
    expect((await call({ ...ONE_WAY, additionalNotes: "n".repeat(40 * 1024) })).status).toBe(413); // counted on the stream as well
    expect(created).toHaveLength(0);
  });

  it("a missing configured company, or a failed create, is a retryable 503/500 - never a success", async () => {
    companyExists = false;
    expect((await call(ONE_WAY)).status).toBe(503);
    companyExists = true;
    createResult = { status: "failed", id: "" };
    const res = await call(ONE_WAY);
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("internal_error");
  });
});

describe("idempotency and duplicate prevention (mocked store - the real race is in the integration test)", () => {
  it("the same key with the SAME request again -> 200 duplicate:true with the same lead id, one audit entry per outcome", async () => {
    await call(ROUND_TRIP);
    const requestHash = created[0].idempotency.requestHash;
    createResult = { status: "duplicate", id: "lead-1" };
    existing = { contact: { companyId: "default-company" }, ingestFingerprint: { requestHash } };
    const res = await call(ROUND_TRIP);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, leadId: "lead-1", duplicate: true });
    expect(audits).toEqual(["WEBSITE_API_LEAD_CREATED", "WEBSITE_API_LEAD_DUPLICATE"]);
  });

  it("the same key with a DIFFERENT request -> 409 idempotency_key_reused; the stored lead is not touched and its id is not revealed", async () => {
    createResult = { status: "duplicate", id: "lead-1" };
    existing = { contact: { companyId: "default-company" }, ingestFingerprint: { requestHash: "0".repeat(64) } };
    const res = await call(ROUND_TRIP);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("idempotency_key_reused");
    expect(JSON.stringify(json)).not.toContain("lead-1");
    expect(audits).toEqual(["WEBSITE_API_LEAD_CONFLICT"]);
  });

  it("a repeat whose original has no stored fingerprint, or belongs to another company, cannot be verified -> 409, never a false duplicate", async () => {
    createResult = { status: "duplicate", id: "lead-9" };
    existing = { contact: { companyId: "default-company" }, ingestFingerprint: null };
    expect((await call(ONE_WAY)).status).toBe(409);
    existing = { contact: { companyId: "someone-else" }, ingestFingerprint: { requestHash: "x" } };
    expect((await call(ONE_WAY)).status).toBe(409);
  });
});

describe("IP and location on website leads", () => {
  it("a signed request with no visitor facts carries NO IP and NO location (the connection is the website's own server, never the visitor)", async () => {
    await call(ONE_WAY, { "x-forwarded-for": "198.51.100.66", "x-vercel-forwarded-for": "198.51.100.66" });
    expect(created).toHaveLength(1);
    expect(created[0].submissionInfo).toBeUndefined();
  });

  it("a verified signed context supplies the visitor's full IPv4 or IPv6 (canonical) and approximate location, and nothing from the body is believed", async () => {
    await call(ONE_WAY, {}, false, { payload: { ip: "203.0.113.42", city: "Sydney", region: "NSW", country: "AU", timezone: "Australia/Sydney" } });
    expect(created[0].submissionInfo).toMatchObject({ ipAddress: "203.0.113.42", ipVersion: "v4", city: "Sydney", countryCode: "AU", timeZone: "Australia/Sydney" });
    await call(ONE_WAY, {}, false, { payload: { ip: "2001:0DB8:85A3:0:0:8A2E:370:7334", country: "NL" } });
    expect(created[1].submissionInfo).toMatchObject({ ipAddress: "2001:db8:85a3::8a2e:370:7334", ipVersion: "v6", countryCode: "NL" });
  });

  it("an internal or private address in a correctly signed context is never stored as the visitor", async () => {
    await call(ONE_WAY, {}, false, { payload: { ip: "172.18.0.2" } });
    await call(ONE_WAY, {}, false, { payload: { ip: "fd00::2" } });
    expect(created).toHaveLength(2);
    expect(created[0].submissionInfo).toBeUndefined();
    expect(created[1].submissionInfo).toBeUndefined();
  });
});

describe("request signature v2 on the flight route: bound, single-use, and never optional once the CRM has a secret", () => {
  const refused = async (res: Response) => {
    expect(res.status).toBe(401);
    const json = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("invalid_signature");
    expect(created).toHaveLength(0); // nothing was stored
  };

  it("an unsigned request is refused (no unsigned fallback)", async () => refused(await call(ONE_WAY, {}, false, false)));

  it("a v1 context is refused (no downgrade)", async () => {
    const context = Buffer.from(JSON.stringify({ v: 1, ts: Math.floor(Date.now() / 1000), ip: "203.0.113.9" })).toString("base64url");
    const { createHmac } = await import("node:crypto");
    await refused(await call(ONE_WAY, { "x-ct-visitor-context": context, "x-ct-visitor-signature": createHmac("sha256", SECRET).update(context).digest("hex") }));
  });

  it.each<[string, Signing]>([
    ["a different body than the one signed", { body: JSON.stringify({ ...ONE_WAY, lastName: "Different" }) }],
    ["a different HTTP method", { method: "PUT" }],
    ["a different path", { path: "/api/public/contact-inquiry" }],
    ["a different company", { company: "someone-else" }],
    ["the wrong secret", { secret: "some-other-secret-0123456789-abcdefghijklmnop" }],
    ["an expired timestamp (older than the window)", { ts: Math.floor(Date.now() / 1000) - 3600 }],
    ["a timestamp too far in the future", { ts: Math.floor(Date.now() / 1000) + 3600 }],
    ["an empty nonce", { payload: { nonce: "" } }],
    ["a malformed nonce", { payload: { nonce: "short" } }],
    ["an unknown signature version", { payload: { v: 3 } }],
  ])("is refused: %s", async (_name, signing) => refused(await call(ONE_WAY, {}, false, signing)));

  it("the same signed request cannot be accepted twice: the replay is refused and nothing more is stored", async () => {
    const body = JSON.stringify(ONE_WAY);
    const headers = signFor(body);
    expect((await call(ONE_WAY, headers)).status).toBe(201);
    expect(created).toHaveLength(1);
    const second = await call(ONE_WAY, headers);
    expect(second.status).toBe(401);
    expect(created).toHaveLength(1);
  });

  it("two concurrent submissions of the same signed request: exactly one is accepted", async () => {
    const headers = signFor(JSON.stringify(ONE_WAY));
    const results = await Promise.all([call(ONE_WAY, headers), call(ONE_WAY, headers), call(ONE_WAY, headers)]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 401)).toHaveLength(2);
    expect(created).toHaveLength(1);
  });

  it("a legitimate retry (a fresh signature, the SAME Idempotency-Key) is accepted and recognised as a duplicate, never a second lead", async () => {
    existing = { contact: { companyId: websiteApiCompanyId() }, ingestFingerprint: { requestHash: "" } };
    expect((await call(ONE_WAY)).status).toBe(201);
    createResult = { status: "duplicate", id: "lead-1" };
    // the website re-signs every attempt with a new nonce and timestamp; the stored fingerprint of the first request decides "same request"
    const { createHash } = await import("node:crypto");
    existing.ingestFingerprint!.requestHash = (created[0].idempotency as { requestHash: string }).requestHash;
    const retry = await call(ONE_WAY);
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { duplicate: boolean }).duplicate).toBe(true);
    expect(createHash).toBeTruthy();
  });

  it("a retry that re-sends the consumed signature is refused, so a retry must be signed afresh", async () => {
    const headers = signFor(JSON.stringify(ONE_WAY));
    await call(ONE_WAY, headers);
    expect((await call(ONE_WAY, headers)).status).toBe(401);
  });

  it("when the one-time store is unavailable the request is refused with a retryable 503 (fail closed), and nothing is stored", async () => {
    nonceStoreDown = true;
    const res = await call(ONE_WAY);
    expect(res.status).toBe(503);
    expect(created).toHaveLength(0);
  });

  it("with no LEAD_INGEST_SECRET configured the route behaves as before: no signature is required and nothing about the visitor is recorded", async () => {
    vi.stubEnv("LEAD_INGEST_SECRET", "");
    const res = await call(ONE_WAY, {}, false, false);
    expect(res.status).toBe(201);
    expect(created[0].submissionInfo).toBeUndefined();
  });

  it("transitional mode (secret configured, WEBSITE_SIGNATURE_REQUIRED not set): today's unsigned website is still accepted, so the CRM can be deployed first", async () => {
    vi.stubEnv("WEBSITE_SIGNATURE_REQUIRED", "");
    const res = await call(ONE_WAY, {}, false, false);
    expect(res.status).toBe(201);
    expect(created[0].submissionInfo).toBeUndefined(); // nothing about the visitor is trusted without a verified signature
  });

  it("the credential is still required first: a correct signature does not replace the bearer key", async () => {
    const res = await call(ONE_WAY, { authorization: "Bearer wrong-key-0123456789-abcdefghijklmnopqrstuvwxyz" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
  });
});

describe("per-visitor rate limiting on the flight route (keyed on the IP inside the VERIFIED signature)", () => {
  const as = (ip: string) => ({ payload: { ip } });

  it("a visitor over the allowance gets 429 with Retry-After and nothing more is stored; another visitor is unaffected", async () => {
    expect((await call(ONE_WAY, {}, false, as("203.0.113.9"))).status).toBe(201);
    expect((await call(ONE_WAY, {}, false, as("203.0.113.9"))).status).toBeLessThan(300);
    const limited = await call(ONE_WAY, {}, false, as("203.0.113.9"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("42");
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    expect(created).toHaveLength(2); // the third was refused before anything was stored
    expect((await call(ONE_WAY, {}, false, as("203.0.113.10"))).status).toBeLessThan(300); // a different visitor has their own allowance
  });

  it("IPv4 and IPv6 are separate keys, and an IPv6 visitor is limited on the canonical address (spelling cannot buy a second allowance)", async () => {
    for (let i = 0; i < 2; i++) expect((await call(ONE_WAY, {}, false, as("2001:db8:85a3::8a2e:370:7334"))).status).toBeLessThan(300);
    // the website signs the canonical form; a differently spelled but identical address maps to the same key
    expect((await call(ONE_WAY, {}, false, as("2001:0DB8:85A3:0:0:8A2E:370:7334"))).status).toBe(429);
    expect((await call(ONE_WAY, {}, false, as("198.51.100.4"))).status).toBeLessThan(300);
    expect(visitorLimitCalls.every((c) => c.endpoint === "WEBSITE_FLIGHT:website")).toBe(true);
  });

  it("an internal or private address in the signed context is never used as a key: that request falls into the shared unattributed bucket", async () => {
    await call(ONE_WAY, {}, false, as("172.18.0.2"));
    await call(ONE_WAY, {}, false, as("fd00::2"));
    await call(ONE_WAY, {}, false, {});
    expect(visitorLimitCalls.map((c) => c.key)).toEqual(["website-unattributed", "website-unattributed", "website-unattributed"]);
  });

  it("traffic the website could not attribute shares one bucket with a larger allowance (5x), so a misconfigured proxy neither disables the limit nor locks everyone out at once", async () => {
    for (let i = 0; i < 10; i++) expect((await call(ONE_WAY, {}, false, {})).status, `request ${i + 1}`).toBeLessThan(300);
    expect((await call(ONE_WAY, {}, false, {})).status).toBe(429);
    expect(visitorLimitCalls[0].maxAttempts).toBe(10); // 2 x 5 in this test's configuration
  });

  it("nothing a caller can put on the connection chooses the key: forged forwarding headers do not move a visitor into another bucket", async () => {
    await call(ONE_WAY, { "x-forwarded-for": "8.8.8.8", forwarded: "for=8.8.4.4", "x-real-ip": "1.1.1.1" }, false, as("203.0.113.9"));
    await call(ONE_WAY, { "x-forwarded-for": "9.9.9.9" }, false, as("203.0.113.9"));
    const limited = await call(ONE_WAY, { "x-forwarded-for": "7.7.7.7" }, false, as("203.0.113.9"));
    expect(limited.status).toBe(429);
    expect(visitorLimitCalls.map((c) => c.key)).toEqual(["203.0.113.9", "203.0.113.9", "203.0.113.9"]);
  });

  it("an unsigned or badly signed request never reaches the limiter (it cannot use up a real visitor's allowance)", async () => {
    await call(ONE_WAY, {}, false, false);
    await call(ONE_WAY, {}, false, { secret: "another-secret-0123456789-abcdefghijklmnopqrs", payload: { ip: "203.0.113.9" } });
    expect(visitorLimitCalls).toHaveLength(0);
  });

  it("a legitimate retry (fresh signature, same Idempotency-Key) counts toward the allowance like any request, and is not refused while within it", async () => {
    expect((await call(ONE_WAY, {}, false, as("203.0.113.9"))).status).toBe(201);
    const retry = await call(ONE_WAY, {}, false, as("203.0.113.9"));
    expect(retry.status).not.toBe(429);
    expect(visitorLimitCalls).toHaveLength(2);
  });
});

describe("date flexibility (the website's four choices) reaches the lead intake as the choice itself", () => {
  it.each([0, 1, 2, 3])("%i days is accepted together with its matching Boolean and passed on unchanged", async (days) => {
    const res = await call({ ...ONE_WAY, datesFlexible: days > 0, dateFlexibilityDays: days });
    expect(res.status).toBe(201);
    expect(created[0].data).toMatchObject({ datesFlexible: days > 0, dateFlexibilityDays: days });
  });

  it("the number alone is enough (the Boolean follows from it), and the Boolean alone still works exactly as before", async () => {
    const withoutBoolean = Object.fromEntries(Object.entries(ONE_WAY).filter(([key]) => key !== "datesFlexible"));
    expect((await call({ ...withoutBoolean, dateFlexibilityDays: 2 })).status).toBe(201);
    expect((await call({ ...ONE_WAY, datesFlexible: true })).status).toBe(201);
    expect(created[0].data).toMatchObject({ dateFlexibilityDays: 2 });
    expect(created[1].data).toMatchObject({ datesFlexible: true });
    expect(created[1].data).not.toHaveProperty("dateFlexibilityDays");
  });

  it("two requests that differ only in the choice are different requests (idempotency fingerprint), so a retry cannot hide a changed choice", async () => {
    await call({ ...ONE_WAY, datesFlexible: true, dateFlexibilityDays: 1 });
    await call({ ...ONE_WAY, datesFlexible: true, dateFlexibilityDays: 3 });
    expect(created[1].idempotency.requestHash).not.toBe(created[0].idempotency.requestHash);
  });
});
