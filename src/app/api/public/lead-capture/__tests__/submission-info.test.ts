import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The public lead endpoint captures what the SERVER learns about the submitting request — the IP and
// the approximate location — in the SAME insert as the lead, from trusted request headers only, never
// from the JSON body. These tests pin that: persistence with the lead, IPv4/IPv6, the trusted-proxy
// gate, spoof resistance, and "nothing invented" when it is unknown.

let leads: Array<Record<string, unknown>>;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    company: { findUnique: vi.fn(async () => ({ id: "company-1" })) },
    contact: { findUnique: vi.fn(async () => ({ ownerId: null })) },
    lead: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        leads.push(data);
        return { id: `lead-${leads.length}` };
      }),
    },
  },
}));
vi.mock("@/server/contact-resolution", () => ({ resolveContactForNewLead: vi.fn(async () => ({ contactId: "contact-1", isNewContact: true })) }));
vi.mock("@/server/actions/lead-queue", () => ({ distributeNewWebsiteLead: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("@/server/queries/reference-data", () => ({ resolveAirportCodes: vi.fn(async () => ({})) }));
vi.mock("@/server/security/rate-limit", () => ({
  checkPublicRateLimit: vi.fn(async () => ({ allowed: true })),
  RATE_LIMITS: { LEAD_CAPTURE: { windowMs: 1, maxAttempts: 1 } },
}));

const BODY = { companyId: "company-1", firstName: "Jane", lastName: "Traveler", phone: "+14155550100" };
const post = (headers: Record<string, string> = {}, body: Record<string, unknown> = BODY) =>
  new Request("http://localhost/api/public/lead-capture", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

beforeEach(() => {
  leads = [];
});
afterEach(() => vi.unstubAllEnvs());

type Created = { submissionInfo?: { create: Record<string, unknown> } };
const infoOf = (i = 0) => (leads[i] as Created).submissionInfo?.create;

describe("POST /api/public/lead-capture — submission info", () => {
  it("stores IPv4, approximate city/country/region/time zone and the capture time WITH the lead, in the same insert", async () => {
    vi.stubEnv("TRUSTED_PROXY", "vercel");
    const { POST } = await import("../route");
    const res = await POST(
      post({ "x-vercel-forwarded-for": "203.0.113.42", "x-vercel-ip-city": "Los%20Angeles", "x-vercel-ip-country": "US", "x-vercel-ip-country-region": "CA", "x-vercel-ip-timezone": "America/Los_Angeles" })
    );
    expect(res.status).toBe(200);
    expect(leads).toHaveLength(1); // one insert — the info cannot be lost or detached from the lead
    expect(infoOf()).toMatchObject({
      ipAddress: "203.0.113.42",
      ipVersion: "v4",
      city: "Los Angeles",
      region: "California",
      country: "United States",
      countryCode: "US",
      timeZone: "America/Los_Angeles",
      geoSource: "Vercel edge geolocation (approximate)",
    });
    expect(infoOf()!.capturedAt).toBeInstanceOf(Date);
  });

  it("stores an IPv6 client in full", async () => {
    vi.stubEnv("TRUSTED_PROXY", "vercel");
    const { POST } = await import("../route");
    await POST(post({ "x-vercel-forwarded-for": "2001:db8:85a3::8a2e:370:7334", "x-vercel-ip-country": "NL" }));
    expect(infoOf()).toMatchObject({ ipAddress: "2001:db8:85a3::8a2e:370:7334", ipVersion: "v6", countryCode: "NL", city: null });
  });

  it("an IP or location typed into the JSON body is ignored — it is never authoritative", async () => {
    vi.stubEnv("TRUSTED_PROXY", "vercel");
    const { POST } = await import("../route");
    await POST(
      post({ "x-vercel-forwarded-for": "203.0.113.42" }, { ...BODY, ipAddress: "8.8.8.8", ip: "8.8.8.8", city: "Atlantis", country: "Mars", submissionInfo: { create: { ipAddress: "6.6.6.6" } } })
    );
    expect(infoOf()).toMatchObject({ ipAddress: "203.0.113.42", city: null });
    expect(JSON.stringify(leads[0])).not.toMatch(/8\.8\.8\.8|6\.6\.6\.6|Atlantis|Mars/);
  });

  it("a spoofed x-forwarded-for / Forwarded header cannot override the platform's address", async () => {
    vi.stubEnv("TRUSTED_PROXY", "vercel");
    const { POST } = await import("../route");
    await POST(post({ "x-vercel-forwarded-for": "203.0.113.42", "x-forwarded-for": "8.8.8.8", forwarded: "for=1.1.1.1", "x-real-ip": "9.9.9.9" }));
    expect(infoOf()!.ipAddress).toBe("203.0.113.42");
  });

  it("with no trusted proxy configured forged headers are ignored: the lead is still created, with NO submission info", async () => {
    vi.stubEnv("TRUSTED_PROXY", "none");
    const { POST } = await import("../route");
    const res = await POST(post({ "x-forwarded-for": "8.8.8.8", "x-vercel-forwarded-for": "8.8.8.8", "x-vercel-ip-city": "Atlantis", "x-vercel-ip-country": "US" }));
    expect(res.status).toBe(200);
    expect(leads).toHaveLength(1);
    expect(infoOf()).toBeUndefined();
  });

  it("location unavailable: the IP is stored and the city/country are null — not guessed", async () => {
    vi.stubEnv("TRUSTED_PROXY", "vercel");
    const { POST } = await import("../route");
    await POST(post({ "x-vercel-forwarded-for": "198.51.100.23" }));
    expect(infoOf()).toMatchObject({ ipAddress: "198.51.100.23", city: null, country: null, countryCode: null, region: null, timeZone: null, geoSource: null });
  });

  it("the response never echoes the IP or location back to the (public) caller", async () => {
    vi.stubEnv("TRUSTED_PROXY", "vercel");
    const { POST } = await import("../route");
    const res = await POST(post({ "x-vercel-forwarded-for": "203.0.113.42", "x-vercel-ip-city": "Paris", "x-vercel-ip-country": "FR" }));
    const text = await res.text();
    expect(text).not.toMatch(/203\.0\.113|Paris|France/);
    expect(JSON.parse(text)).toEqual({ ok: true, id: expect.any(String) });
  });
});
