import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { signVisitorContext, resolveVisitorContext, VISITOR_CONTEXT_HEADER, VISITOR_SIGNATURE_HEADER } from "../lead-ingest-context";
import { buildLeadSubmissionInfoCreate } from "../lead-submission-info";
import { signWebsiteRequestV2 } from "../website-request-signature";
import { randomBytes } from "node:crypto";
import { CLOUDFLARE_GEO_SOURCE, GEO_SOURCE } from "@/lib/request-geo";

// What the CRM does with the signed visitor context the Business Flights website attaches to a contact inquiry (and to a flight request): which IP
// forms are accepted and preserved, how the location is read, and - new - which edge the location is attributed to. Prisma, the rate limiter and the
// local geolocation database are mocks, so this proves the HANDLER's mapping and validation, not PostgreSQL storage (the column is TEXT, unbounded).
// The permission and masking rules for showing the stored values are covered in queries/__tests__/inquiry-submission-info.test.ts.

const SECRET = "unit-test-secret-0123456789-abcdefghijkl"; // throwaway
let created: Array<Record<string, unknown>>;
const nonces = new Set<string>();

vi.mock("@/server/admin-notifications", () => ({ notifyNewInquiry: vi.fn(async () => {}) }));
vi.mock("@/server/geo/ip-geolocation", () => ({ lookupIpLocation: vi.fn(async () => ({ status: "unresolved", reason: "not-found" })) }));
vi.mock("@/server/security/rate-limit", () => ({
  checkPublicRateLimit: vi.fn(async () => ({ allowed: true })),
  checkPublicRateLimitForKey: vi.fn(async () => ({ allowed: true })),
  RATE_LIMITS: { CONTACT_INQUIRY: { windowMs: 1, maxAttempts: 1 }, CRM_INQUIRY: { windowMs: 1, maxAttempts: 1 } },
}));
vi.mock("@/lib/prisma", () => {
  const prisma: Record<string, unknown> = {
    company: { findUnique: vi.fn(async () => ({ id: "company-1" })) },
    contact: { findFirst: vi.fn(async () => null) },
    contactInquiry: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: `inquiry-${created.length}`, ...data };
      }),
    },
    $executeRaw: vi.fn(async () => 0),
    // the one-time nonce store (RateLimitCounter unique key): the first insert of a key wins
    $queryRaw: vi.fn(async (_s: unknown, _id: unknown, key: string) => (nonces.has(key) ? [] : (nonces.add(key), [{ id: "n" }]))),
  };
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);
  return { prisma };
});

const BODY = { companyId: "company-1", firstName: "Jane", lastName: "Traveler", email: "jane@example.com", phone: "+14155550123", subject: "GENERAL_INQUIRY", message: "Hello, I have a question." };
// `v2(payload)` is a marker that post() turns into a REAL v2 signature over the exact body it sends (method, path and company bound).
const v2 = (payload: Record<string, unknown>, secret = SECRET) => ({ "x-test-v2": JSON.stringify({ payload, secret }) });
const post = (headers: Record<string, string> = {}, body: Record<string, unknown> = BODY) => {
  const text = JSON.stringify(body);
  const { "x-test-v2": marker, ...rest } = headers;
  let signedHeaders: Record<string, string> = {};
  if (marker) {
    const { payload, secret } = JSON.parse(marker) as { payload: Record<string, unknown>; secret: string };
    const s = signWebsiteRequestV2({ secret, method: "POST", path: "/api/public/contact-inquiry", companyId: String(body.companyId), body: text, payload: { v: 2, ts: Math.floor(Date.now() / 1000), nonce: randomBytes(16).toString("base64url"), ...payload } as never });
    signedHeaders = { [VISITOR_CONTEXT_HEADER]: s.context, [VISITOR_SIGNATURE_HEADER]: s.signature };
  }
  return new Request("http://localhost/api/public/contact-inquiry", { method: "POST", body: text, headers: { "content-type": "application/json", ...signedHeaders, ...rest } });
};
const signed = (payload: Record<string, unknown>, secret = SECRET) => {
  const s = signVisitorContext({ v: 1, ts: Math.floor(Date.now() / 1000), ...payload } as never, secret);
  return { [VISITOR_CONTEXT_HEADER]: s.context, [VISITOR_SIGNATURE_HEADER]: s.signature };
};
const info = (i = 0) => (created[i] as { submissionInfo?: { create: Record<string, unknown> } }).submissionInfo?.create;

beforeEach(() => {
  created = [];
  nonces.clear();
  vi.stubEnv("LEAD_INGEST_SECRET", SECRET);
  vi.stubEnv("WEBSITE_SIGNATURE_REQUIRED", "true"); // strict mode (the final rollout state)
  vi.stubEnv("TRUSTED_PROXY", "cloudflare"); // the CRM's own connection is never the visitor: it must be ignored in every case below
});
afterEach(() => vi.unstubAllEnvs());

describe("resolveVisitorContext: the IP", () => {
  const ipOf = (ip: string) => {
    const r = resolveVisitorContext(new Headers(signed({ ip })));
    return r.state === "verified" ? r.ip : "INVALID-CONTEXT";
  };

  it("accepts IPv4 and IPv6 in every notation and preserves the whole address", () => {
    expect(ipOf("203.0.113.77")).toBe("203.0.113.77");
    expect(ipOf("2001:4860:4860::8888")).toBe("2001:4860:4860::8888");
    expect(ipOf("2001:4860:4860:0:0:0:0:8888")).toBe("2001:4860:4860::8888");
    expect(ipOf("2001:4860:4860:0000:0000:0000:0000:8888")).toBe("2001:4860:4860::8888");
    expect(ipOf("2A00:1450:4001:081B:0123:4567:89AB:CDEF")).toBe("2a00:1450:4001:81b:123:4567:89ab:cdef"); // the longest form, nothing truncated
    expect(ipOf("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });

  it("drops (but does not fail on) an invalid, private or reserved address: the context stays verified, the IP is simply absent", () => {
    for (const bad of ["", "not-an-ip", "999.1.1.1", "10.0.0.5", "192.168.1.1", "127.0.0.1", "::1", "fe80::1", "fd00::1", "2001:4860:4860::8888::1", "8.8.8.8/24", "8.8.8.8, 1.1.1.1"]) {
      expect(ipOf(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("a non-string ip is ignored", () => {
    for (const weird of [123, null, ["8.8.8.8"], { ip: "8.8.8.8" }, true]) {
      const r = resolveVisitorContext(new Headers(signed({ ip: weird })));
      expect(r.state === "verified" && r.ip, JSON.stringify(weird)).toBeFalsy();
    }
  });
});

describe("resolveVisitorContext: the location and its source", () => {
  const verified = (payload: Record<string, unknown>) => {
    const r = resolveVisitorContext(new Headers(signed(payload)));
    if (r.state !== "verified") throw new Error("expected a verified context");
    return r;
  };

  it("maps the location fields (the city arrives percent-encoded) and attributes them to Cloudflare when the website says so", () => {
    const r = verified({ ip: "203.0.113.77", city: encodeURIComponent("São Paulo"), region: "SP", country: "BR", timezone: "America/Sao_Paulo", source: "cloudflare" });
    expect(r.location).toMatchObject({ city: "São Paulo", countryCode: "BR", timeZone: "America/Sao_Paulo" });
    expect(r.locationSource).toBe(CLOUDFLARE_GEO_SOURCE);
  });

  it("keeps the long-standing label for a context without a source (an older website) and for 'vercel'", () => {
    expect(verified({ country: "AU", city: "Sydney" }).locationSource).toBe(GEO_SOURCE);
    expect(verified({ country: "AU", source: "vercel" }).locationSource).toBe(GEO_SOURCE);
  });

  it("the source is looked up in an allow-list, never copied: anything else keeps the default label and cannot inject text", () => {
    for (const evil of ["<script>alert(1)</script>", "Cloudflare edge geolocation (approximate)", "CLOUDFLARE", "__proto__", "constructor", "toString", "hasOwnProperty", "", 7, null, ["cloudflare"]]) {
      const r = verified({ country: "AU", source: evil });
      expect(r.locationSource, JSON.stringify(evil)).toBe(GEO_SOURCE);
    }
  });

  it("with no usable location there is no source, whatever the website claimed; the IP is unaffected", () => {
    const r = verified({ ip: "203.0.113.77", source: "cloudflare" });
    expect(r.ip).toBe("203.0.113.77");
    expect(r.location).toBeUndefined();
    expect(r.locationSource).toBeUndefined();
  });

  it("a malformed country, an over-long value or a non-string location part is ignored; partial locations keep the parts that are valid", () => {
    expect(verified({ country: "Australia??", source: "cloudflare" }).location?.countryCode).toBeUndefined();
    const partial = verified({ country: "GB", city: 5, region: "x".repeat(200), source: "cloudflare" });
    expect(partial.location).toMatchObject({ countryCode: "GB" });
    expect(partial.location?.city).toBeUndefined();
  });
});

describe("resolveVisitorContext: authenticity is unchanged", () => {
  it("rejects a wrong secret, a tampered context, a stale timestamp, a missing signature and an oversized context", () => {
    expect(resolveVisitorContext(new Headers(signed({ ip: "203.0.113.77" }, "another-secret-value-that-is-long-enough-xx"))).state).toBe("invalid");
    const good = signed({ ip: "203.0.113.77", source: "cloudflare" });
    const tampered = Buffer.from(JSON.stringify({ v: 1, ts: Math.floor(Date.now() / 1000), ip: "198.51.100.9", source: "cloudflare" })).toString("base64url");
    expect(resolveVisitorContext(new Headers({ ...good, [VISITOR_CONTEXT_HEADER]: tampered })).state).toBe("invalid");
    expect(resolveVisitorContext(new Headers(signed({ ip: "203.0.113.77", ts: 1 }))).state).toBe("invalid");
    expect(resolveVisitorContext(new Headers({ [VISITOR_CONTEXT_HEADER]: good[VISITOR_CONTEXT_HEADER] })).state).toBe("invalid");
    expect(resolveVisitorContext(new Headers(signed({ ip: "203.0.113.77", pad: "x".repeat(3000) }))).state).toBe("invalid");
    expect(resolveVisitorContext(new Headers({})).state).toBe("absent");
  });

  it("without LEAD_INGEST_SECRET configured here, a context is refused", () => {
    vi.stubEnv("LEAD_INGEST_SECRET", "");
    expect(resolveVisitorContext(new Headers(signed({ ip: "203.0.113.77" }))).state).toBe("invalid");
  });
});

describe("POST /api/public/contact-inquiry with the website's signed context", () => {
  it("stores the complete IPv6 address, its version, the approximate location and the Cloudflare source, in the same insert as the inquiry", async () => {
    const { POST } = await import("@/app/api/public/contact-inquiry/route");
    const res = await POST(
      post(v2({ ip: "2A00:1450:4001:081B:0123:4567:89AB:CDEF", city: encodeURIComponent("Zürich"), region: "ZH", country: "CH", timezone: "Europe/Zurich", source: "cloudflare" }), {
        ...BODY,
        ipAddress: "6.6.6.6", // a body field is never believed
      })
    );
    expect(res.status).toBe(200);
    expect(created).toHaveLength(1);
    expect(info()).toMatchObject({ ipAddress: "2a00:1450:4001:81b:123:4567:89ab:cdef", ipVersion: "v6", city: "Zürich", countryCode: "CH", timeZone: "Europe/Zurich", geoSource: CLOUDFLARE_GEO_SOURCE });
    expect(JSON.stringify(created[0])).not.toContain("6.6.6.6");
  });

  it("stores an IPv4 visitor with a partial location; the location source follows the location, not the IP", async () => {
    const { POST } = await import("@/app/api/public/contact-inquiry/route");
    await POST(post(v2({ ip: "203.0.113.5", country: "GB", source: "cloudflare" })));
    expect(info()).toMatchObject({ ipAddress: "203.0.113.5", ipVersion: "v4", countryCode: "GB", city: null, geoSource: CLOUDFLARE_GEO_SOURCE });
  });

  it("an IP with no location is stored with a null location source (the local database is mocked as 'not found')", async () => {
    const { POST } = await import("@/app/api/public/contact-inquiry/route");
    await POST(post(v2({ ip: "203.0.113.6", source: "cloudflare" })));
    expect(info()).toMatchObject({ ipAddress: "203.0.113.6", city: null, country: null, geoSource: null });
  });

  it("a location with no IP is stored (the IP column stays empty, never invented)", async () => {
    const { POST } = await import("@/app/api/public/contact-inquiry/route");
    await POST(post(v2({ country: "DE", city: "Berlin", source: "cloudflare" })));
    expect(info()).toMatchObject({ ipAddress: null, ipVersion: null, countryCode: "DE", geoSource: CLOUDFLARE_GEO_SOURCE });
  });

  it("an older website's context (no source) is stored exactly as before", async () => {
    const { POST } = await import("@/app/api/public/contact-inquiry/route");
    await POST(post(v2({ ip: "203.0.113.7", country: "AU", city: "Sydney" })));
    expect(info()).toMatchObject({ ipAddress: "203.0.113.7", countryCode: "AU", geoSource: GEO_SOURCE });
  });

  it("no signature, or a wrongly signed one, is refused and nothing is stored - the connection's own forwarding headers are never a substitute", async () => {
    const { POST } = await import("@/app/api/public/contact-inquiry/route");
    const connection = { "cf-connecting-ip": "203.0.113.8", "x-forwarded-for": "8.8.8.8", "cf-ipcountry": "US" }; // describes the website's server, never the visitor
    expect((await POST(post(connection))).status).toBe(401); // unsigned: refused, there is no unsigned fallback once the CRM has a secret
    expect((await POST(post({ ...connection, ...v2({ ip: "198.51.100.1" }, "wrong-secret-value-that-is-long-enough-xxxx") }))).status).toBe(401);
    expect(created).toHaveLength(0);
    vi.stubEnv("LEAD_INGEST_SECRET", ""); // no secret configured here: the route behaves as before, and records nothing about the visitor
    expect((await POST(post(connection))).status).toBe(200);
    expect(created).toHaveLength(1);
    expect(info(0)).toBeUndefined();
  });

  it("the inquiry fields and validation are untouched: a missing required field is still refused and nothing is stored", async () => {
    const { POST } = await import("@/app/api/public/contact-inquiry/route");
    const { email: _omitted, ...withoutEmail } = BODY;
    void _omitted;
    expect((await POST(post(v2({ ip: "203.0.113.9" }), withoutEmail))).status).toBe(400);
    expect(created).toHaveLength(0);
  });
});

describe("the flight API uses the same attribution", () => {
  it("a verified context with a Cloudflare source is stored with the Cloudflare label; without a source the old label", () => {
    const now = new Date();
    const cf = buildLeadSubmissionInfoCreate(new Headers(signed({ ip: "2001:4860:4860::8888", country: "US", city: "Mountain View", source: "cloudflare" })), now, { serverToServer: true });
    expect(cf).toMatchObject({ ipAddress: "2001:4860:4860::8888", ipVersion: "v6", countryCode: "US", geoSource: CLOUDFLARE_GEO_SOURCE });
    const old = buildLeadSubmissionInfoCreate(new Headers(signed({ ip: "203.0.113.1", country: "US" })), now, { serverToServer: true });
    expect(old).toMatchObject({ geoSource: GEO_SOURCE });
    expect(buildLeadSubmissionInfoCreate(new Headers({}), now, { serverToServer: true })).toBeUndefined();
  });
});
