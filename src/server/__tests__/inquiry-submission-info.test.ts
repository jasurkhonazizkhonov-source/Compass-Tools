import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { signVisitorContext, VISITOR_CONTEXT_HEADER, VISITOR_SIGNATURE_HEADER } from "../lead-ingest-context";

// What the server records about WHO submitted a public inquiry. The decisive property is that the visitor's IP/location comes only from the request's
// own trusted path: the platform's headers for a visitor posting directly, or the website's HMAC-signed visitor context for the website's server -
// never from anything a visitor or script can simply type. The local geolocation lookup is mocked (its own behaviour is tested in geo/).

const SECRET = "unit-test-secret-0123456789-abcdefghijkl"; // throwaway test value
const NOW = new Date(Date.UTC(2026, 10, 13, 12, 0, 0));
const ts = Math.floor(NOW.getTime() / 1000);

let lookup: (ip: string) => Promise<unknown>;
vi.mock("@/server/geo/ip-geolocation", () => ({ lookupIpLocation: (ip: string) => lookup(ip) }));

const resolved = (over: Record<string, unknown> = {}) => ({
  status: "resolved",
  location: { city: "Sydney", region: "New South Wales", regionCode: "NSW", country: "Australia", countryCode: "AU", timeZone: "Australia/Sydney", latitude: -33.8, longitude: 151.2, accuracyRadiusKm: null, ...over },
  source: "DBIP-City-Lite (2026-11-01)",
  databaseBuiltAt: new Date(),
  databaseStale: false,
});

const signed = (payload: object, secret = SECRET) => {
  const s = signVisitorContext({ v: 1, ts, ...payload } as never, secret);
  return { [VISITOR_CONTEXT_HEADER]: s.context, [VISITOR_SIGNATURE_HEADER]: s.signature };
};

beforeEach(() => {
  lookup = async () => ({ status: "unresolved", reason: "not-found" });
  vi.stubEnv("LEAD_INGEST_SECRET", SECRET);
  vi.stubEnv("TRUSTED_PROXY", "vercel");
});
afterEach(() => vi.unstubAllEnvs());

const build = async (headers: Record<string, string>, serverToServer: boolean) => {
  const { buildInquirySubmissionInfo } = await import("../inquiry-submission-info");
  return buildInquirySubmissionInfo(new Headers(headers), { serverToServer }, NOW);
};

describe("buildInquirySubmissionInfo - a visitor posting directly (CRM Inquiries)", () => {
  it("records the trusted-proxy IPv4 and the platform's approximate location, with the capture time and no coordinates", async () => {
    const info = await build({ "x-vercel-forwarded-for": "203.0.113.42", "x-vercel-ip-city": "Los%20Angeles", "x-vercel-ip-country": "US", "x-vercel-ip-country-region": "CA", "x-vercel-ip-timezone": "America/Los_Angeles" }, false);
    expect(info).toMatchObject({ ipAddress: "203.0.113.42", ipVersion: "v4", city: "Los Angeles", region: "California", country: "United States", countryCode: "US", timeZone: "America/Los_Angeles", geoSource: "Vercel edge geolocation (approximate)", capturedAt: NOW });
    expect(Object.keys(info!).join()).not.toMatch(/lat|lon/i);
  });

  it("records an IPv6 client in full, and falls back to the LOCAL database (with its source) when the platform sent no location", async () => {
    lookup = async (ip) => (ip === "2001:db8::7334" ? resolved() : { status: "unresolved", reason: "not-found" });
    const info = await build({ "x-vercel-forwarded-for": "2001:db8::7334" }, false);
    expect(info).toMatchObject({ ipAddress: "2001:db8::7334", ipVersion: "v6", city: "Sydney", region: "New South Wales", country: "Australia", countryCode: "AU", timeZone: "Australia/Sydney", geoSource: "DBIP-City-Lite (2026-11-01)" });
  });

  it("an IP the database cannot place is still recorded, honestly without any location (and without a geo source)", async () => {
    const info = await build({ "x-vercel-forwarded-for": "198.51.100.7" }, false);
    expect(info).toMatchObject({ ipAddress: "198.51.100.7", ipVersion: "v4", city: null, region: null, country: null, countryCode: null, timeZone: null, geoSource: null });
  });

  it("a forged x-forwarded-for / Forwarded / x-real-ip cannot override the platform's address, and with NO trusted proxy forged headers record nothing", async () => {
    const forged = { "x-forwarded-for": "8.8.8.8", forwarded: "for=1.1.1.1", "x-real-ip": "9.9.9.9" };
    expect((await build({ "x-vercel-forwarded-for": "203.0.113.42", ...forged }, false))!.ipAddress).toBe("203.0.113.42");
    vi.stubEnv("TRUSTED_PROXY", "none");
    expect(await build({ "x-vercel-forwarded-for": "203.0.113.42", ...forged }, false)).toBeUndefined();
  });

  it("private, loopback, carrier-grade-NAT and garbage addresses are never stored as a visitor's IP", async () => {
    for (const bad of ["10.0.0.5", "192.168.1.1", "127.0.0.1", "100.64.0.1", "169.254.1.1", "::1", "fe80::1", "not-an-ip"]) {
      expect(await build({ "x-vercel-forwarded-for": bad }, false), bad).toBeUndefined();
    }
  });

  it("an IPv4-mapped IPv6 address is stored as the IPv4 it really is", async () => {
    expect(await build({ "x-vercel-forwarded-for": "::ffff:203.0.113.9" }, false)).toMatchObject({ ipAddress: "203.0.113.9", ipVersion: "v4" });
  });

  it("a failing geolocation lookup never loses the IP and never throws", async () => {
    lookup = async () => {
      throw new Error("mmdb exploded");
    };
    expect(await build({ "x-vercel-forwarded-for": "203.0.113.42" }, false)).toMatchObject({ ipAddress: "203.0.113.42", city: null, geoSource: null });
  });

  it("a direct visitor who also sends a signed context is believed only if it verifies; an unverifiable one records NOTHING (it is not silently replaced by headers)", async () => {
    expect(await build({ "x-vercel-forwarded-for": "203.0.113.42", ...signed({ ip: "198.51.100.77" }) }, false)).toMatchObject({ ipAddress: "198.51.100.77" });
    expect(await build({ "x-vercel-forwarded-for": "203.0.113.42", ...signed({ ip: "198.51.100.77" }, "a-completely-different-secret-value-xx") }, false)).toBeUndefined();
  });
});

describe("buildInquirySubmissionInfo - the website's SERVER posting for the visitor (Business Flights Get In Touch)", () => {
  it("the connection's own headers describe the WEBSITE'S server and are never consulted: with no signed context nothing is recorded", async () => {
    expect(await build({ "x-vercel-forwarded-for": "76.76.21.21", "x-forwarded-for": "76.76.21.21", "x-vercel-ip-country": "US" }, true)).toBeUndefined();
  });

  it("a verified signed context supplies the visitor's IP and the website edge's approximate location", async () => {
    const info = await build({ "x-vercel-forwarded-for": "76.76.21.21", ...signed({ ip: "203.0.113.42", city: "Los%20Angeles", region: "CA", country: "US", timezone: "America/Los_Angeles" }) }, true);
    expect(info).toMatchObject({ ipAddress: "203.0.113.42", ipVersion: "v4", city: "Los Angeles", region: "California", country: "United States", countryCode: "US", timeZone: "America/Los_Angeles" });
    expect(info!.ipAddress).not.toBe("76.76.21.21");
  });

  it("a verified IP with no location is resolved against the local database", async () => {
    lookup = async () => resolved();
    expect(await build({ ...signed({ ip: "203.0.113.42" }) }, true)).toMatchObject({ ipAddress: "203.0.113.42", city: "Sydney", countryCode: "AU", geoSource: "DBIP-City-Lite (2026-11-01)" });
  });

  it("a verified context that names ONLY the country (what the website's Cloudflare edge usually sends) is completed with the city and region the local database knows, and the label names both origins", async () => {
    lookup = async () => resolved();
    const info = await build({ ...signed({ ip: "203.0.113.42", country: "AU" }) }, true);
    expect(info).toMatchObject({ ipAddress: "203.0.113.42", city: "Sydney", region: "New South Wales", countryCode: "AU", timeZone: "Australia/Sydney" });
    expect(info!.geoSource).toBe("Vercel edge geolocation (approximate) + DBIP-City-Lite (2026-11-01)");
  });

  it("a country-only context whose country the database contradicts is NOT blended: it stays country-only, with the website's own label", async () => {
    lookup = async () => resolved({ country: "France", countryCode: "FR", city: "Paris", region: "Ile-de-France", regionCode: "IDF", timeZone: "Europe/Paris" });
    const info = await build({ ...signed({ ip: "203.0.113.42", country: "AU" }) }, true);
    expect(info).toMatchObject({ city: null, countryCode: "AU" });
    expect(info!.geoSource ?? "").not.toMatch(/DBIP/);
  });

  it("a forged context (wrong secret, tampered body, stale timestamp, missing signature) records nothing and cannot be used to plant an IP", async () => {
    expect(await build({ ...signed({ ip: "6.6.6.6" }, "a-completely-different-secret-value-xx") }, true)).toBeUndefined();
    const good = signed({ ip: "203.0.113.42" });
    const tampered = Buffer.from(JSON.stringify({ v: 1, ts, ip: "6.6.6.6" })).toString("base64url");
    expect(await build({ [VISITOR_CONTEXT_HEADER]: tampered, [VISITOR_SIGNATURE_HEADER]: good[VISITOR_SIGNATURE_HEADER] }, true)).toBeUndefined();
    expect(await build({ ...signed({ ip: "6.6.6.6", ts: ts - 3600 }) }, true)).toBeUndefined();
    expect(await build({ [VISITOR_CONTEXT_HEADER]: good[VISITOR_CONTEXT_HEADER] }, true)).toBeUndefined();
  });

  it("a verified context carrying a private/garbage IP and no location records nothing", async () => {
    expect(await build({ ...signed({ ip: "10.1.2.3" }) }, true)).toBeUndefined();
  });

  it("an unconfigured LEAD_INGEST_SECRET can never verify a context", async () => {
    vi.stubEnv("LEAD_INGEST_SECRET", "");
    expect(await build({ ...signed({ ip: "203.0.113.42" }) }, true)).toBeUndefined();
  });
});
