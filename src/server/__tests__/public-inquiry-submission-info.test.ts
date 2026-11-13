import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { signVisitorContext, VISITOR_CONTEXT_HEADER, VISITOR_SIGNATURE_HEADER } from "../lead-ingest-context";

// The two public inquiry systems stay separate (own route, own source, own inbox) but BOTH now record the submitter's IP and approximate location in
// the SAME insert as the inquiry. CRM Inquiries: the request is the visitor. Business Flights Get In Touch: the request is the website's server, so
// only a verified signed visitor context may supply the visitor's IP. Neither ever reads an IP or location from the JSON body.

const SECRET = "unit-test-secret-0123456789-abcdefghijkl"; // throwaway test value

let created: Array<Record<string, unknown>>;
let failGeo = false;

vi.mock("@/server/admin-notifications", () => ({ notifyNewInquiry: vi.fn(async () => {}) }));
vi.mock("@/server/geo/ip-geolocation", () => ({
  lookupIpLocation: vi.fn(async () => {
    if (failGeo) throw new Error("mmdb exploded");
    return { status: "unresolved", reason: "not-found" };
  }),
}));
vi.mock("@/server/security/rate-limit", () => ({
  checkPublicRateLimit: vi.fn(async () => ({ allowed: true })),
  RATE_LIMITS: { CONTACT_INQUIRY: { windowMs: 1, maxAttempts: 1 }, CRM_INQUIRY: { windowMs: 1, maxAttempts: 1 } },
}));
vi.mock("@/lib/prisma", () => {
  const prisma: Record<string, unknown> = {
    company: { findUnique: vi.fn(async () => ({ id: "company-1" })) },
    contact: { findFirst: vi.fn(async () => null) },
    contactInquiry: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: `inquiry-${created.length}`, ...data };
      }),
    },
    $executeRaw: vi.fn(async () => 0),
  };
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);
  return { prisma };
});

const BODY = { companyId: "company-1", firstName: "Jane", lastName: "Traveler", email: "jane@example.com", phone: "4155550123", phoneCountry: "US", subject: "GENERAL_INQUIRY", message: "Hello, I have a question." };
const post = (path: string, headers: Record<string, string> = {}, body: Record<string, unknown> = BODY) =>
  new Request(`http://localhost/api/public/${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
const signedHeaders = (payload: object, secret = SECRET) => {
  const s = signVisitorContext({ v: 1, ts: Math.floor(Date.now() / 1000), ...payload } as never, secret);
  return { [VISITOR_CONTEXT_HEADER]: s.context, [VISITOR_SIGNATURE_HEADER]: s.signature };
};
const infoOf = (i = 0) => (created[i] as { submissionInfo?: { create: Record<string, unknown> } }).submissionInfo?.create;

beforeEach(() => {
  created = [];
  failGeo = false;
  vi.stubEnv("LEAD_INGEST_SECRET", SECRET);
  vi.stubEnv("TRUSTED_PROXY", "vercel");
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/public/crm-inquiry (CRM Inquiries) - the request IS the visitor", () => {
  it("stores the trusted IPv4 and approximate location in the same insert as the inquiry", async () => {
    const { POST } = await import("@/app/api/public/crm-inquiry/route");
    const res = await POST(post("crm-inquiry", { "x-vercel-forwarded-for": "203.0.113.42", "x-vercel-ip-city": "Los%20Angeles", "x-vercel-ip-country": "US", "x-vercel-ip-country-region": "CA" }));
    expect(res.status).toBe(200);
    expect(created).toHaveLength(1); // one insert - the info cannot be lost or detached
    expect(created[0].source).toBe("CRM_WEBSITE");
    expect(infoOf()).toMatchObject({ ipAddress: "203.0.113.42", ipVersion: "v4", city: "Los Angeles", region: "California", countryCode: "US" });
  });

  it("an IP, location or nested submissionInfo typed into the JSON body is ignored", async () => {
    const { POST } = await import("@/app/api/public/crm-inquiry/route");
    await POST(post("crm-inquiry", { "x-vercel-forwarded-for": "203.0.113.42" }, { ...BODY, ipAddress: "8.8.8.8", city: "Atlantis", country: "Mars", submissionInfo: { create: { ipAddress: "6.6.6.6" } } }));
    expect(infoOf()).toMatchObject({ ipAddress: "203.0.113.42", city: null });
    expect(JSON.stringify(created[0])).not.toMatch(/8\.8\.8\.8|6\.6\.6\.6|Atlantis|Mars/);
  });

  it("with no trustworthy IP the inquiry is still created, with NO submission row", async () => {
    vi.stubEnv("TRUSTED_PROXY", "none");
    const { POST } = await import("@/app/api/public/crm-inquiry/route");
    const res = await POST(post("crm-inquiry", { "x-forwarded-for": "8.8.8.8" }));
    expect(res.status).toBe(200);
    expect(created).toHaveLength(1);
    expect(infoOf()).toBeUndefined();
  });

  it("a geolocation failure never fails the inquiry and never loses the IP", async () => {
    failGeo = true;
    const { POST } = await import("@/app/api/public/crm-inquiry/route");
    const res = await POST(post("crm-inquiry", { "x-vercel-forwarded-for": "203.0.113.42" }));
    expect(res.status).toBe(200);
    expect(infoOf()).toMatchObject({ ipAddress: "203.0.113.42", city: null });
  });
});

describe("POST /api/public/contact-inquiry (Business Flights Get In Touch) - the request is the website's SERVER", () => {
  it("a verified signed visitor context supplies the visitor's IP and location - not the website server's connection", async () => {
    const { POST } = await import("@/app/api/public/contact-inquiry/route");
    const res = await POST(post("contact-inquiry", { "x-vercel-forwarded-for": "76.76.21.21", ...signedHeaders({ ip: "203.0.113.42", city: "Sydney", region: "NSW", country: "AU", timezone: "Australia/Sydney" }) }));
    expect(res.status).toBe(200);
    expect(created[0].source).toBe("BUSINESS_FLIGHTS_WEBSITE");
    expect(infoOf()).toMatchObject({ ipAddress: "203.0.113.42", ipVersion: "v4", city: "Sydney", countryCode: "AU", timeZone: "Australia/Sydney" });
    expect(JSON.stringify(created[0])).not.toContain("76.76.21.21");
  });

  it("with no signed context nothing is recorded (the connection is the website's server) but the inquiry is unaffected", async () => {
    const { POST } = await import("@/app/api/public/contact-inquiry/route");
    const res = await POST(post("contact-inquiry", { "x-vercel-forwarded-for": "76.76.21.21", "x-vercel-ip-country": "US" }));
    expect(res.status).toBe(200);
    expect(created).toHaveLength(1);
    expect(infoOf()).toBeUndefined();
  });

  it("a forged or wrongly-signed context is refused silently: the inquiry is created, with no submission row", async () => {
    const { POST } = await import("@/app/api/public/contact-inquiry/route");
    const res = await POST(post("contact-inquiry", signedHeaders({ ip: "6.6.6.6" }, "a-completely-different-secret-value-xx")));
    expect(res.status).toBe(200);
    expect(infoOf()).toBeUndefined();
  });

  it("an IP typed into the body is ignored here too", async () => {
    const { POST } = await import("@/app/api/public/contact-inquiry/route");
    await POST(post("contact-inquiry", {}, { ...BODY, ipAddress: "8.8.8.8", submissionInfo: { create: { ipAddress: "6.6.6.6" } } }));
    expect(infoOf()).toBeUndefined();
    expect(JSON.stringify(created[0])).not.toMatch(/8\.8\.8\.8|6\.6\.6\.6/);
  });
});
