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

  it("a platform location that names only the country is COMPLETED from the local database (city, region, time zone), and the source names both origins", async () => {
    vi.stubEnv("TRUSTED_PROXY", "vercel");
    lookup = async () => LOCAL_DB;
    const ctx = await ctxFor({ "x-vercel-forwarded-for": "203.0.113.42", "x-vercel-ip-country": "DE" });
    expect(ctx).toMatchObject({ ip: "203.0.113.42", city: "Frankfurt am Main", region: "Hesse", country: "Germany", countryCode: "DE", timeZone: "Europe/Berlin" });
    expect(ctx.locationSource).toBe("Vercel edge geolocation (approximate) + DBIP-City-Lite (2026-11-01)");
    expect(ctx.locationResolvedAt).toBeInstanceOf(Date);
  });

  it("...but a database answer for ANOTHER country is ignored: the platform's country stands alone and nothing is blended", async () => {
    vi.stubEnv("TRUSTED_PROXY", "vercel");
    lookup = async () => ({ ...LOCAL_DB, location: { ...LOCAL_DB.location, city: "Paris", region: "Ile-de-France", regionCode: "IDF", country: "France", countryCode: "FR" } });
    const ctx = await ctxFor({ "x-vercel-forwarded-for": "203.0.113.42", "x-vercel-ip-country": "DE" });
    expect(ctx).toMatchObject({ city: null, region: null, country: "Germany", countryCode: "DE", locationSource: "Vercel edge geolocation (approximate)" });
  });

  it("a platform location that already names a city is kept exactly as supplied and the database is not asked", async () => {
    vi.stubEnv("TRUSTED_PROXY", "vercel");
    const asked = vi.fn(async () => LOCAL_DB);
    lookup = asked;
    const ctx = await ctxFor({ "x-vercel-forwarded-for": "203.0.113.42", "x-vercel-ip-country": "US", "x-vercel-ip-city": "Los%20Angeles" });
    expect(ctx).toMatchObject({ city: "Los Angeles", countryCode: "US", locationSource: "Vercel edge geolocation (approximate)" });
    expect(asked).not.toHaveBeenCalled();
  });

  it("coordinates are never part of what is returned or stored", async () => {
    lookup = async () => LOCAL_DB; // the database knows latitude/longitude
    const ctx = await ctxFor({ ...IP, "cf-iplatitude": "-33.9", "cf-iplongitude": "151.2" });
    expect(Object.keys(ctx).join()).not.toMatch(/lat|lon/i);
    // locationResolvedAt is `new Date()`: serialised, its seconds.milliseconds (e.g. "...:08.712Z") can contain "8.7", "50.1" or "33.9" by chance (roughly 1 run in 75, which is
    // how this failed CI on 2026-11-23). A timestamp is not a coordinate, so it is left out of the text that is searched.
    const { locationResolvedAt, ...withoutTimestamp } = ctx;
    expect(locationResolvedAt === null || locationResolvedAt instanceof Date).toBe(true);
    expect(JSON.stringify(withoutTimestamp)).not.toMatch(/50\.1|8\.7|33\.9|151\.2/);
  });
});

describe("resolveSignInContext - who is believed (every address below is a documentation range)", () => {
  const NOTHING = { ip: null, city: null, region: null, country: null, countryCode: null, timeZone: null, locationSource: null, locationResolvedAt: null };
  const FORGED_EDGE = { "cf-connecting-ip": "203.0.113.42", "cf-ipcountry": "DE", "cf-ipcity": "Berlin", "cf-region": "Berlin", "x-forwarded-for": "198.51.100.9", "x-real-ip": "198.51.100.8", "x-vercel-forwarded-for": "198.51.100.7", "x-vercel-ip-city": "Paris", "x-vercel-ip-country": "FR" };

  it("no trusted proxy configured: NO header is believed - no address, no location, and the local database is never asked", async () => {
    vi.stubEnv("TRUSTED_PROXY", "");
    const asked = vi.fn(async () => LOCAL_DB);
    lookup = asked;
    expect(await ctxFor(FORGED_EDGE)).toEqual(NOTHING);
    expect(asked).not.toHaveBeenCalled();
  });

  it("TRUSTED_PROXY=none is explicit distrust: the same", async () => {
    vi.stubEnv("TRUSTED_PROXY", "none");
    expect(await ctxFor(FORGED_EDGE)).toEqual(NOTHING);
  });

  it("Cloudflare mode reads CF-Connecting-IP and nothing else: a Vercel city header or an X-Forwarded-For hop cannot change the address or the place", async () => {
    vi.stubEnv("TRUSTED_PROXY", "cloudflare");
    lookup = async () => ({ status: "unresolved", reason: "not-found" });
    const ctx = await ctxFor({ "cf-connecting-ip": "203.0.113.42", "x-forwarded-for": "198.51.100.9", "x-real-ip": "198.51.100.8", "x-vercel-forwarded-for": "198.51.100.7", "x-vercel-ip-city": "Paris", "x-vercel-ip-country": "FR" });
    expect(ctx.ip).toBe("203.0.113.42");
    expect(ctx.city).toBeNull();
    expect(ctx.countryCode).toBeNull();
  });

  it("the database is asked about the trusted address only: a forged forwarded-for next to the real CF-Connecting-IP is never looked up", async () => {
    vi.stubEnv("TRUSTED_PROXY", "cloudflare");
    const asked = vi.fn(async () => LOCAL_DB);
    lookup = asked;
    await ctxFor({ "cf-connecting-ip": "203.0.113.42", "x-forwarded-for": "198.51.100.66" });
    expect(asked).toHaveBeenCalledTimes(1);
    expect(asked).toHaveBeenCalledWith("203.0.113.42");
  });

  it.each(["10.1.2.3", "172.17.0.2", "192.168.0.5", "127.0.0.1", "::1", "fd00::1", "100.64.0.1", "2002:a00:1::1", "64:ff9b::a00:1", "::ffff:10.0.0.1", "not-an-ip", "203.0.113.42, 198.51.100.1", "[::1]", "1.2.3", "999.1.1.1", ""])(
    "a CF-Connecting-IP of %j (an internal hop or malformed) records no address and no location, and the database is not asked",
    async (value) => {
      vi.stubEnv("TRUSTED_PROXY", "cloudflare");
      const asked = vi.fn(async () => LOCAL_DB);
      lookup = asked;
      const ctx = await ctxFor({ "cf-connecting-ip": value, "cf-ipcountry": "DE" });
      expect(ctx.ip).toBeNull();
      expect(ctx.city).toBeNull();
      expect(ctx.locationSource).toBeNull();
      expect(asked).not.toHaveBeenCalled();
    }
  );

  it("a proxy that appends a port to the address is tolerated by design (the port is dropped, the address is still the trusted one)", async () => {
    vi.stubEnv("TRUSTED_PROXY", "cloudflare");
    expect((await ctxFor({ "cf-connecting-ip": "203.0.113.42:8080" })).ip).toBe("203.0.113.42");
  });

  it("a failing, slow-to-fail or malformed database answer never breaks the sign-in: the address is kept and the location is simply absent", async () => {
    vi.stubEnv("TRUSTED_PROXY", "cloudflare");
    for (const broken of [async () => { throw new Error("boom"); }, async () => ({ status: "resolved", location: "not an object" }), async () => null, async () => ({ status: "unresolved", reason: "database-error" })]) {
      lookup = broken as typeof lookup;
      const ctx = await ctxFor({ "cf-connecting-ip": "203.0.113.42" });
      expect(ctx.ip).toBe("203.0.113.42");
      expect(ctx.city).toBeNull();
      expect(ctx.country).toBeNull();
    }
  });

  it("a Cloudflare country that is unknown (XX), Tor (T1), malformed or lower-case junk names no place", async () => {
    vi.stubEnv("TRUSTED_PROXY", "cloudflare");
    for (const code of ["XX", "T1", "D", "DEU", "1A", "de!"]) {
      const ctx = await ctxFor({ "cf-connecting-ip": "203.0.113.42", "cf-ipcountry": code });
      expect(ctx.countryCode, code).toBeNull();
    }
  });
});
