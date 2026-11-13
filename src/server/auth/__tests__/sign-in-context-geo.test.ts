// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCityDatabase } from "@/server/geo/__tests__/mmdb-fixture";
import { resetIpGeolocationForTests } from "@/server/geo/ip-geolocation";
import { resolveSignInContext } from "../sign-in-context";

// The sign-in location pipeline: trusted-path IP → (platform headers | local database | Cloudflare country) → what gets stored.
// The database here is generated in memory with fictional data (see mmdb-fixture.ts); every address is a documentation range.

const dir = mkdtempSync(path.join(tmpdir(), "signin-geo-"));
const dbFile = path.join(dir, "city.mmdb");
const ENV_KEYS = ["TRUSTED_PROXY", "VERCEL", "GEOIP_DB_PATH"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeAll(() => {
  writeFileSync(
    dbFile,
    buildCityDatabase({
      entries: [
        { cidr: "203.0.113.0/24", record: { city: "Frankfurt am Main", subdivision: { name: "Hesse", iso: "HE" }, country: { name: "Germany", iso: "DE" }, location: { time_zone: "Europe/Berlin", latitude: 50.1, longitude: 8.7 } } },
        { cidr: "198.51.100.0/24", record: { country: { name: "France", iso: "FR" } } },
        { cidr: "2001:db8:85a3::/48", record: { city: "Sydney", subdivision: { name: "New South Wales" }, country: { name: "Australia", iso: "AU" } } },
      ],
    })
  );
});
beforeEach(() => {
  resetIpGeolocationForTests();
  process.env.GEOIP_DB_PATH = dbFile;
  delete process.env.VERCEL;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
  vi.doUnmock("@/server/geo/ip-geolocation");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NO_LOCATION = { city: null, region: null, country: null, countryCode: null, timeZone: null, locationSource: null, locationResolvedAt: null };

describe("resolveSignInContext — behind Cloudflare (the case that used to show 'Location unavailable')", () => {
  beforeEach(() => {
    process.env.TRUSTED_PROXY = "cloudflare";
  });

  it("resolves the visitor's IP to city, region and country from the local database and records where that came from", async () => {
    const ctx = await resolveSignInContext(new Headers({ "cf-connecting-ip": "203.0.113.9" }));
    expect(ctx).toMatchObject({ ip: "203.0.113.9", city: "Frankfurt am Main", region: "Hesse", country: "Germany", countryCode: "DE", timeZone: "Europe/Berlin", locationSource: "DBIP-City-Lite (2026-11-01)" });
    expect(ctx.locationResolvedAt).toBeInstanceOf(Date);
  });

  it("IPv6: the FULL address is stored (canonical form, nothing truncated) and is geolocated", async () => {
    const full = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";
    const ctx = await resolveSignInContext(new Headers({ "cf-connecting-ip": full }));
    expect(ctx.ip).toBe("2001:db8:85a3::8a2e:370:7334");
    expect(ctx).toMatchObject({ city: "Sydney", country: "Australia", countryCode: "AU" });
  });

  it("an IPv4-mapped IPv6 address is stored as the plain IPv4 address and geolocated", async () => {
    const ctx = await resolveSignInContext(new Headers({ "cf-connecting-ip": "::ffff:203.0.113.9" }));
    expect(ctx).toMatchObject({ ip: "203.0.113.9", city: "Frankfurt am Main" });
  });

  it("a country-only record gives a country only", async () => {
    const ctx = await resolveSignInContext(new Headers({ "cf-connecting-ip": "198.51.100.5" }));
    expect(ctx).toMatchObject({ ip: "198.51.100.5", city: null, region: null, country: "France", countryCode: "FR" });
  });

  it("an address the database does not know keeps the IP and no location — nothing is invented", async () => {
    const ctx = await resolveSignInContext(new Headers({ "cf-connecting-ip": "203.0.200.1" }));
    expect(ctx).toEqual({ ip: "203.0.200.1", ...NO_LOCATION });
  });

  it("a forged X-Forwarded-For is ignored: only Cloudflare's own header is believed in this mode", async () => {
    const ctx = await resolveSignInContext(new Headers({ "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.9", forwarded: "for=203.0.113.9" }));
    expect(ctx).toEqual({ ip: null, ...NO_LOCATION });
  });

  it("an internal address in the trusted header (a misconfigured hop) is neither stored nor geolocated", async () => {
    for (const internal of ["172.18.0.3", "10.0.0.7", "100.64.1.1", "::1"]) {
      expect(await resolveSignInContext(new Headers({ "cf-connecting-ip": internal }))).toEqual({ ip: null, ...NO_LOCATION });
    }
  });

  it("with the database missing, Cloudflare's own country (CF-IPCountry) is used — country only", async () => {
    process.env.GEOIP_DB_PATH = path.join(dir, "missing.mmdb");
    const ctx = await resolveSignInContext(new Headers({ "cf-connecting-ip": "203.0.113.9", "cf-ipcountry": "de" }));
    expect(ctx).toMatchObject({ ip: "203.0.113.9", city: null, region: null, country: "Germany", countryCode: "DE", locationSource: "Cloudflare edge country (CF-IPCountry)" });
  });

  it.each(["XX", "T1", "", "Germany", "D"])("CF-IPCountry %j names no country and is not used", async (value) => {
    process.env.GEOIP_DB_PATH = path.join(dir, "missing.mmdb");
    const ctx = await resolveSignInContext(new Headers({ "cf-connecting-ip": "203.0.113.9", "cf-ipcountry": value }));
    expect(ctx).toMatchObject({ ip: "203.0.113.9", ...NO_LOCATION });
  });

  it("the database is preferred over CF-IPCountry (more specific, and the header cannot disagree with it silently)", async () => {
    const ctx = await resolveSignInContext(new Headers({ "cf-connecting-ip": "203.0.113.9", "cf-ipcountry": "FR" }));
    expect(ctx).toMatchObject({ city: "Frankfurt am Main", countryCode: "DE" });
  });
});

describe("resolveSignInContext — trust boundaries", () => {
  it("with NO trusted proxy nothing is geolocated, whatever the request claims (a forged header cannot pick a location)", async () => {
    delete process.env.TRUSTED_PROXY;
    const ctx = await resolveSignInContext(new Headers({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.9", "cf-ipcountry": "DE", "x-vercel-ip-city": "Frankfurt", "x-vercel-ip-country": "DE" }));
    expect(ctx).toEqual({ ip: null, ...NO_LOCATION });
  });

  it("CF-IPCountry is not believed unless Cloudflare is the configured trusted proxy", async () => {
    process.env.TRUSTED_PROXY = "nginx";
    process.env.GEOIP_DB_PATH = path.join(dir, "missing.mmdb");
    const ctx = await resolveSignInContext(new Headers({ "x-forwarded-for": "203.0.113.9", "cf-ipcountry": "FR" }));
    expect(ctx).toMatchObject({ ip: "203.0.113.9", country: null, countryCode: null });
  });

  it("behind a generic/nginx proxy the first forwarded hop is geolocated from the local database", async () => {
    process.env.TRUSTED_PROXY = "nginx";
    const ctx = await resolveSignInContext(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.2" }));
    expect(ctx).toMatchObject({ ip: "203.0.113.9", city: "Frankfurt am Main", countryCode: "DE" });
  });

  it("on Vercel the platform's own geo headers still win and the database is not consulted (behaviour unchanged)", async () => {
    process.env.TRUSTED_PROXY = "vercel";
    const ctx = await resolveSignInContext(new Headers({ "x-vercel-forwarded-for": "203.0.113.9", "x-vercel-ip-city": "Munich", "x-vercel-ip-country": "DE", "x-vercel-ip-country-region": "BY" }));
    expect(ctx).toMatchObject({ ip: "203.0.113.9", city: "Munich", countryCode: "DE", locationSource: "Vercel edge geolocation (approximate)" });
  });

  it("on Vercel without geo headers the database fills the gap", async () => {
    process.env.TRUSTED_PROXY = "vercel";
    const ctx = await resolveSignInContext(new Headers({ "x-vercel-forwarded-for": "203.0.113.9" }));
    expect(ctx).toMatchObject({ city: "Frankfurt am Main", locationSource: "DBIP-City-Lite (2026-11-01)" });
  });
});

describe("resolveSignInContext — failure never breaks signing in", () => {
  it.each([
    ["missing database", () => path.join(dir, "nope.mmdb")],
    ["corrupt database", () => { const f = path.join(dir, "bad.mmdb"); writeFileSync(f, "garbage"); return f; }],
  ])("%s → the IP is still recorded, location fields are null, nothing throws", async (_label, makePath) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.TRUSTED_PROXY = "generic";
    process.env.GEOIP_DB_PATH = makePath();
    await expect(resolveSignInContext(new Headers({ "x-forwarded-for": "203.0.113.9" }))).resolves.toEqual({ ip: "203.0.113.9", ...NO_LOCATION });
  });

  it("even a lookup that throws unexpectedly is contained", async () => {
    vi.resetModules();
    vi.doMock("@/server/geo/ip-geolocation", () => ({ lookupIpLocation: () => Promise.reject(new Error("boom")) }));
    const { resolveSignInContext: guarded } = await import("../sign-in-context");
    process.env.TRUSTED_PROXY = "generic";
    await expect(guarded(new Headers({ "x-forwarded-for": "203.0.113.9" }))).resolves.toEqual({ ip: "203.0.113.9", ...NO_LOCATION });
  });
});
