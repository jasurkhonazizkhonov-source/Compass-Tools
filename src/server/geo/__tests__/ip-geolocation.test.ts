// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCityDatabase } from "./mmdb-fixture";
import { lookupIpLocation, resetIpGeolocationForTests, MAX_DATABASE_AGE_DAYS } from "../ip-geolocation";

// All addresses are documentation ranges or fictional; the database is generated in memory (see mmdb-fixture.ts).
const dir = mkdtempSync(path.join(tmpdir(), "geoip-test-"));
const dbFile = path.join(dir, "city.mmdb");
const FRESH = Math.floor(Date.UTC(2026, 10, 1) / 1000);

const ENTRIES = [
  { cidr: "203.0.113.0/24", record: { city: "Frankfurt am Main", subdivision: { name: "Hesse", iso: "HE" }, country: { name: "Germany", iso: "DE" }, location: { latitude: 50.11, longitude: 8.68, time_zone: "Europe/Berlin" } } },
  { cidr: "198.51.100.0/24", record: { country: { name: "France", iso: "FR" } } }, // country only
  { cidr: "192.0.2.0/24", record: { location: { time_zone: "Europe/London" } } }, // a record that names no place
  { cidr: "2001:db8:85a3::/48", record: { city: "Sydney", subdivision: { name: "New South Wales", iso: "NSW" }, country: { name: "Australia", iso: "AU" } } },
  { cidr: "203.0.114.0/24", record: { city: "Bad\u0000City\u0007 Name", country: { name: "Germany", iso: "de" } } }, // control characters, lower-case code
  { cidr: "203.0.116.0/24", record: { city: "San Jose (Tasman and Zanker)", subdivision: { name: "California", iso: "CA" }, country: { name: "United States", iso: "US" } } }, // DB-IP style district suffix
  { cidr: "203.0.115.0/24", record: { city: "X".repeat(200), country: { name: "Germany", iso: "DE" } } }, // absurdly long name
];

function install(buf: Buffer) {
  writeFileSync(dbFile, buf);
}

beforeAll(() => {
  vi.stubEnv("GEOIP_DB_PATH", dbFile);
});
beforeEach(() => {
  resetIpGeolocationForTests();
  install(buildCityDatabase({ entries: ENTRIES, buildEpochSec: FRESH }));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("lookupIpLocation — resolving", () => {
  it("IPv4: city, region and country, with the database named and dated as the source", async () => {
    const r = await lookupIpLocation("203.0.113.9");
    expect(r.status).toBe("resolved");
    if (r.status !== "resolved") return;
    expect(r.location).toMatchObject({ city: "Frankfurt am Main", region: "Hesse", regionCode: "HE", country: "Germany", countryCode: "DE", timeZone: "Europe/Berlin", latitude: 50.11, longitude: 8.68 });
    expect(r.source).toBe("DBIP-City-Lite (2026-11-01)");
    expect(r.databaseStale).toBe(false);
  });

  it("IPv6: a full, uncompressed address resolves through the same database", async () => {
    const r = await lookupIpLocation("2001:0db8:85a3:0000:0000:8a2e:0370:7334");
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") expect(r.location).toMatchObject({ city: "Sydney", country: "Australia", countryCode: "AU" });
  });

  it("IPv6: a compressed address inside the same network resolves too", async () => {
    const r = await lookupIpLocation("2001:db8:85a3::1");
    expect(r.status).toBe("resolved");
  });

  it("an IPv4-mapped IPv6 address is looked up as the IPv4 address it is", async () => {
    const r = await lookupIpLocation("::ffff:203.0.113.9");
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") expect(r.location.city).toBe("Frankfurt am Main");
  });

  it("a district or street DB-IP appends in brackets is dropped - the estimate is a city, not an address", async () => {
    const r = await lookupIpLocation("203.0.116.8");
    if (r.status !== "resolved") throw new Error("expected resolved");
    expect(r.location.city).toBe("San Jose");
    expect(r.location.region).toBe("California");
  });

  it("country-only data stays country-only — no city or region is invented", async () => {
    const r = await lookupIpLocation("198.51.100.77");
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") expect(r.location).toMatchObject({ city: null, region: null, regionCode: null, country: "France", countryCode: "FR" });
  });

  it("a record that names no country, region or city is not a location", async () => {
    expect(await lookupIpLocation("192.0.2.5")).toEqual({ status: "unresolved", reason: "no-location-data" });
  });

  it("an address the database has no record for is 'not-found', not a guess", async () => {
    expect(await lookupIpLocation("203.0.200.1")).toEqual({ status: "unresolved", reason: "not-found" });
    expect(await lookupIpLocation("2001:db8:ffff::1")).toEqual({ status: "unresolved", reason: "not-found" });
  });

  it("strips control characters, rejects over-long names and normalises the country code", async () => {
    const dirty = await lookupIpLocation("203.0.114.1");
    if (dirty.status !== "resolved") throw new Error("expected resolved");
    expect(dirty.location.city).toBe("Bad City Name");
    expect(dirty.location.countryCode).toBe("DE");
    const long = await lookupIpLocation("203.0.115.1");
    if (long.status !== "resolved") throw new Error("expected resolved");
    expect(long.location.city).toBeNull(); // 200 characters is not a city name
    expect(long.location.country).toBe("Germany");
  });
});

describe("lookupIpLocation — addresses that must never be geolocated", () => {
  it.each(["10.1.2.3", "172.17.0.2", "192.168.1.10", "127.0.0.1", "169.254.1.1", "100.64.0.1", "100.127.255.254", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"])("%s is internal infrastructure, not a visitor", async (ip) => {
    expect(await lookupIpLocation(ip)).toEqual({ status: "unresolved", reason: "non-public-ip" });
  });

  it.each([null, undefined, "", "   ", "not-an-ip", "999.1.1.1", "203.0.113", "203.0.113.9.1", "2001:db8:::1", "203.0.113.9; DROP TABLE"])("%j is not an IP address", async (ip) => {
    expect(await lookupIpLocation(ip as string | null | undefined)).toEqual({ status: "unresolved", reason: "invalid-ip" });
  });

  it("100.63.x and 100.128.x are public space and are looked up normally", async () => {
    expect(await lookupIpLocation("100.63.0.1")).toEqual({ status: "unresolved", reason: "not-found" });
    expect(await lookupIpLocation("100.128.0.1")).toEqual({ status: "unresolved", reason: "not-found" });
  });
});

describe("lookupIpLocation — database problems never throw and never guess", () => {
  it("no file at the configured path → database-missing", async () => {
    vi.stubEnv("GEOIP_DB_PATH", path.join(dir, "does-not-exist.mmdb"));
    expect(await lookupIpLocation("203.0.113.9")).toEqual({ status: "unresolved", reason: "database-missing" });
    vi.stubEnv("GEOIP_DB_PATH", dbFile);
  });

  it("a corrupt file → database-error (and one warning, not one per sign-in)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    install(Buffer.from("this is not a MaxMind database at all, just text"));
    expect(await lookupIpLocation("203.0.113.9")).toEqual({ status: "unresolved", reason: "database-error" });
    vi.setSystemTime(new Date("2026-11-08T12:05:00Z"));
    expect(await lookupIpLocation("203.0.113.9")).toEqual({ status: "unresolved", reason: "database-error" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("203.0.113");
  });

  it("a database of the wrong kind (ASN, not City) is refused rather than half-used", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    install(buildCityDatabase({ databaseType: "GeoLite2-ASN", entries: ENTRIES }));
    expect(await lookupIpLocation("203.0.113.9")).toEqual({ status: "unresolved", reason: "database-error" });
  });

  it("an outdated database is still used but flagged as stale, with one warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    install(buildCityDatabase({ entries: ENTRIES, buildEpochSec: Math.floor(Date.UTC(2026, 10, 8) / 1000) - (MAX_DATABASE_AGE_DAYS + 30) * 86400 }));
    const r = await lookupIpLocation("203.0.113.9");
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") expect(r.databaseStale).toBe(true);
    await lookupIpLocation("203.0.113.9");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a database exactly at the age limit is not yet stale", async () => {
    install(buildCityDatabase({ entries: ENTRIES, buildEpochSec: Math.floor(Date.UTC(2026, 10, 8, 12) / 1000) - MAX_DATABASE_AGE_DAYS * 86400 }));
    const r = await lookupIpLocation("203.0.113.9");
    if (r.status !== "resolved") throw new Error("expected resolved");
    expect(r.databaseStale).toBe(false);
  });
});

describe("lookupIpLocation — replacing the database without a restart", () => {
  const later = (minutes: number) => vi.setSystemTime(new Date(Date.UTC(2026, 10, 8, 12, minutes)));
  const bump = (secondsAhead: number) => {
    const t = new Date(Date.UTC(2026, 10, 8, 12, 0, secondsAhead));
    utimesSync(dbFile, t, t); // make the replacement unmistakably newer than what was loaded
  };

  it("picks up a new file after the re-check interval, and not before", async () => {
    expect((await lookupIpLocation("203.0.113.9")).status).toBe("resolved");
    install(buildCityDatabase({ entries: [{ cidr: "203.0.113.0/24", record: { city: "Munich", country: { name: "Germany", iso: "DE" } } }], buildEpochSec: FRESH + 86400 }));
    bump(30);
    later(0);
    const before = await lookupIpLocation("203.0.113.9");
    if (before.status !== "resolved") throw new Error("expected resolved");
    expect(before.location.city).toBe("Frankfurt am Main"); // within the interval: no file system access at all
    later(2);
    const after = await lookupIpLocation("203.0.113.9");
    if (after.status !== "resolved") throw new Error("expected resolved");
    expect(after.location.city).toBe("Munich");
    expect(after.source).toBe("DBIP-City-Lite (2026-11-02)");
  });

  it("a broken replacement keeps the previous database serving", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await lookupIpLocation("203.0.113.9")).status).toBe("resolved");
    install(Buffer.from("truncated download"));
    bump(60);
    later(3);
    const r = await lookupIpLocation("203.0.113.9");
    if (r.status !== "resolved") throw new Error("expected the previous database to keep serving");
    expect(r.location.city).toBe("Frankfurt am Main");
  });

  it("a file that appears after a 'missing' start is found at the next re-check", async () => {
    vi.stubEnv("GEOIP_DB_PATH", path.join(dir, "later.mmdb"));
    expect(await lookupIpLocation("203.0.113.9")).toEqual({ status: "unresolved", reason: "database-missing" });
    writeFileSync(path.join(dir, "later.mmdb"), buildCityDatabase({ entries: ENTRIES, buildEpochSec: FRESH }));
    later(2);
    expect((await lookupIpLocation("203.0.113.9")).status).toBe("resolved");
    vi.stubEnv("GEOIP_DB_PATH", dbFile);
  });
});
