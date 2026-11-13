import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Sign-in location precedence behind Cloudflare: (1) Cloudflare's own city/region headers when the managed transform sends them, (2) the LOCAL geolocation
// database, (3) Cloudflare's country-only header, (4) nothing. The IP itself comes only from CF-Connecting-IP. The local database is mocked here (its own tests
// are in server/geo/__tests__); nothing leaves the process.

let lookup: (ip: string) => Promise<unknown>;
vi.mock("@/server/geo/ip-geolocation", () => ({ lookupIpLocation: (ip: string) => lookup(ip) }));

const LOCAL_DB = {
  status: "resolved",
  location: { city: "Frankfurt am Main", region: "Hesse", regionCode: "HE", country: "Germany", countryCode: "DE", timeZone: "Europe/Berlin", latitude: 50.1, longitude: 8.7, accuracyRadiusKm: null },
  source: "DBIP-City-Lite (2026-11-01)",
  databaseBuiltAt: new Date(),
  databaseStale: false,
};

beforeEach(() => {
  lookup = async () => ({ status: "unresolved", reason: "not-found" });
  vi.stubEnv("TRUSTED_PROXY", "cloudflare");
});
afterEach(() => vi.unstubAllEnvs());

const ctxFor = async (headers: Record<string, string>) => {
  const { resolveSignInContext } = await import("../sign-in-context");
  return resolveSignInContext(new Headers(headers));
};
const IP = { "cf-connecting-ip": "203.0.113.42" };

describe("resolveSignInContext behind Cloudflare", () => {
  it("full Cloudflare location: used as is, labelled as Cloudflare's, and the local database is not even asked", async () => {
    const asked = vi.fn(async () => LOCAL_DB);
    lookup = asked;
    const ctx = await ctxFor({ ...IP, "cf-ipcountry": "AU", "cf-ipcity": "Sydney", "cf-region": "New South Wales", "cf-region-code": "NSW", "cf-timezone": "Australia/Sydney" });
    expect(ctx).toMatchObject({ ip: "203.0.113.42", city: "Sydney", region: "New South Wales", country: "Australia", countryCode: "AU", timeZone: "Australia/Sydney", locationSource: "Cloudflare edge geolocation (approximate)" });
    expect(ctx.locationResolvedAt).toBeInstanceOf(Date);
    expect(asked).not.toHaveBeenCalled();
  });

  it("partial Cloudflare location (city + country only): kept, the rest stays null - nothing is borrowed from elsewhere", async () => {
    const ctx = await ctxFor({ ...IP, "cf-ipcountry": "FR", "cf-ipcity": "Lyon" });
    expect(ctx).toMatchObject({ city: "Lyon", region: null, country: "France", countryCode: "FR", timeZone: null });
  });

  it("only the always-present country header: the more specific local database wins; Cloudflare's country is the last resort", async () => {
    lookup = async () => LOCAL_DB;
    const withDb = await ctxFor({ ...IP, "cf-ipcountry": "DE" });
    expect(withDb).toMatchObject({ city: "Frankfurt am Main", locationSource: "DBIP-City-Lite (2026-11-01)" });
    lookup = async () => ({ status: "unresolved", reason: "not-found" });
    const countryOnly = await ctxFor({ ...IP, "cf-ipcountry": "DE" });
    expect(countryOnly).toMatchObject({ city: null, country: "Germany", countryCode: "DE", locationSource: "Cloudflare edge country (CF-IPCountry)" });
  });

  it("no location anywhere: the IP is still recorded and every location field is explicitly null (never invented)", async () => {
    const ctx = await ctxFor({ ...IP, "cf-ipcountry": "XX" });
    expect(ctx).toMatchObject({ ip: "203.0.113.42", city: null, region: null, country: null, countryCode: null, timeZone: null, locationSource: null, locationResolvedAt: null });
  });

  it("no CF-Connecting-IP: no IP, and no location is guessed from headers alone", async () => {
    lookup = async () => LOCAL_DB;
    const ctx = await ctxFor({ "x-forwarded-for": "198.51.100.66", "cf-ipcountry": "XX" });
    expect(ctx.ip).toBeNull();
    expect(ctx.city).toBeNull();
  });

  it("a forged X-Forwarded-For next to a real CF-Connecting-IP never changes the stored address or its location lookup", async () => {
    const seen: string[] = [];
    lookup = async (ip) => {
      seen.push(ip);
      return LOCAL_DB;
    };
    const ctx = await ctxFor({ ...IP, "x-forwarded-for": "198.51.100.66", "cf-ipcountry": "DE" });
    expect(ctx.ip).toBe("203.0.113.42");
    expect(seen).toEqual(["203.0.113.42"]);
  });

  it("IPv6 visitor: the whole address is stored in canonical form, and the local lookup receives that same text", async () => {
    const seen: string[] = [];
    lookup = async (ip) => {
      seen.push(ip);
      return LOCAL_DB;
    };
    const ctx = await ctxFor({ "cf-connecting-ip": "2001:0DB8:85A3:0000:0000:8A2E:0370:7334" });
    expect(ctx.ip).toBe("2001:db8:85a3::8a2e:370:7334");
    expect(seen).toEqual(["2001:db8:85a3::8a2e:370:7334"]);
  });

  it("coordinates are never part of what is returned or stored", async () => {
    lookup = async () => LOCAL_DB; // the database knows latitude/longitude
    const ctx = await ctxFor({ ...IP, "cf-iplatitude": "-33.9", "cf-iplongitude": "151.2" });
    expect(Object.keys(ctx).join()).not.toMatch(/lat|lon/i);
    expect(JSON.stringify(ctx)).not.toMatch(/50\.1|8\.7|33\.9|151\.2/);
  });
});
