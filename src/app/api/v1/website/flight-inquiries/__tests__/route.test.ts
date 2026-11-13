import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

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

vi.mock("@/lib/prisma", () => ({
  prisma: {
    company: { findUnique: vi.fn(async () => (companyExists ? { id: "default-company" } : null)) },
    lead: { findUnique: vi.fn(async () => existing) },
  },
}));
vi.mock("@/server/security/rate-limit", () => ({
  checkAccountRateLimit: vi.fn(async () => ({ allowed: true })),
  RATE_LIMITS: { WEBSITE_API_AUTH_FAILURES: {}, WEBSITE_API_REQUESTS: {} },
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

const call = async (body: unknown, headers: Record<string, string> = {}, raw = false) => {
  const { POST } = await import("../route");
  return POST(
    new Request("http://crm.internal/api/v1/website/flight-inquiries", {
      method: "POST",
      body: raw ? (body as string) : JSON.stringify(body),
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, "idempotency-key": "9b1f3c52-77aa-4d0e-8d51-0a1b2c3d4e5f.0123456789abcdef", ...headers },
    })
  );
};

beforeEach(() => {
  created.length = 0;
  audits.length = 0;
  createResult = { status: "created", id: "lead-1" };
  existing = null;
  companyExists = true;
  vi.stubEnv("WEBSITE_API_KEY", KEY);
  vi.stubEnv("WEBSITE_API_KEY_NEXT", "");
  vi.stubEnv("WEBSITE_API_COMPANY_ID", "");
  vi.stubEnv("WEBSITE_API_ALLOW_PUBLIC_ROUTE", "");
  vi.stubEnv("LEAD_INGEST_SECRET", SECRET);
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
  const visitorContext = (payload: object, secret = SECRET) => {
    const context = Buffer.from(JSON.stringify({ v: 1, ts: Math.floor(Date.now() / 1000), ...payload })).toString("base64url");
    return { "x-ct-visitor-context": context, "x-ct-visitor-signature": createHmac("sha256", secret).update(context).digest("hex") };
  };

  it("with no signed visitor context the lead carries NO IP and NO location (the connection is the website's own server, never the visitor)", async () => {
    await call(ONE_WAY, { "x-forwarded-for": "198.51.100.66", "x-vercel-forwarded-for": "198.51.100.66" });
    expect(created[0].submissionInfo).toBeUndefined();
  });

  it("a verified signed context supplies the visitor's full IPv4 or IPv6 (canonical) and approximate location, and nothing from the body is believed", async () => {
    await call(ONE_WAY, visitorContext({ ip: "203.0.113.42", city: "Sydney", region: "NSW", country: "AU", timezone: "Australia/Sydney" }));
    expect(created[0].submissionInfo).toMatchObject({ ipAddress: "203.0.113.42", ipVersion: "v4", city: "Sydney", countryCode: "AU", timeZone: "Australia/Sydney" });
    await call(ONE_WAY, visitorContext({ ip: "2001:0DB8:85A3:0:0:8A2E:370:7334", country: "NL" }));
    expect(created[1].submissionInfo).toMatchObject({ ipAddress: "2001:db8:85a3::8a2e:370:7334", ipVersion: "v6", countryCode: "NL" });
  });

  it("a forged, stale or wrongly signed context is ignored (the lead is still created, without IP)", async () => {
    await call(ONE_WAY, visitorContext({ ip: "198.51.100.66" }, "some-other-secret-0123456789-abcdefghijklmnop"));
    await call(ONE_WAY, visitorContext({ ip: "198.51.100.66", ts: 1 }));
    expect(created).toHaveLength(2);
    expect(created[0].submissionInfo).toBeUndefined();
    expect(created[1].submissionInfo).toBeUndefined();
  });

  it("an internal or private address in the context is never stored as the visitor", async () => {
    await call(ONE_WAY, visitorContext({ ip: "172.18.0.2" }));
    await call(ONE_WAY, visitorContext({ ip: "fd00::2" }));
    expect(created[0].submissionInfo).toBeUndefined();
    expect(created[1].submissionInfo).toBeUndefined();
  });
});
