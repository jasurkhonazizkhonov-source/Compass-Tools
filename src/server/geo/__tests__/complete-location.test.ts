import { describe, it, expect, vi, beforeEach } from "vitest";

// completeLocationFromDatabase: a partial location (typically country-only) is completed from the LOCAL database, only with fields that are missing and only when the database
// agrees. The lookup is stubbed with representative provider answers; every IP here is from a documentation range (RFC 5737 / 3849) - no real customer address is used.

const lookup = vi.fn();
vi.mock("@/server/geo/ip-geolocation", () => ({ lookupIpLocation: (ip: string) => lookup(ip) }));

const { completeLocationFromDatabase } = await import("../complete-location");

const loc = (over: Record<string, unknown> = {}) => ({
  city: "Frankfurt am Main", region: "Hesse", regionCode: "HE", country: "Germany", countryCode: "DE", timeZone: "Europe/Berlin", latitude: 50.1, longitude: 8.7, accuracyRadiusKm: null, ...over,
});
const resolved = (over: Record<string, unknown> = {}) => ({ status: "resolved", location: loc(over), source: "DBIP-City-Lite (2026-11-01)", databaseBuiltAt: new Date("2026-11-01"), databaseStale: false });
const IP = "203.0.113.9";

beforeEach(() => {
  lookup.mockReset(); // not returned: a function returned from beforeEach is run by vitest as a teardown hook
});

describe("what it adds", () => {
  it("nothing known + a city-level answer: the whole answer, labelled with the database (unchanged behaviour)", async () => {
    lookup.mockResolvedValue(resolved());
    expect(await completeLocationFromDatabase(IP, {})).toEqual({
      city: "Frankfurt am Main", region: "Hesse", country: "Germany", countryCode: "DE", timeZone: "Europe/Berlin", source: "DBIP-City-Lite (2026-11-01)", completedFromDatabase: true,
    });
  });

  it("a country-only location (the Cloudflare case) is completed with city, region and time zone, and BOTH origins are named in the source", async () => {
    lookup.mockResolvedValue(resolved());
    const r = await completeLocationFromDatabase(IP, { country: "Germany", countryCode: "DE" }, "Cloudflare edge country (CF-IPCountry)");
    expect(r).toMatchObject({ city: "Frankfurt am Main", region: "Hesse", country: "Germany", countryCode: "DE", timeZone: "Europe/Berlin", completedFromDatabase: true });
    expect(r.source).toBe("Cloudflare edge country (CF-IPCountry) + DBIP-City-Lite (2026-11-01)");
  });

  it("a country code alone is enough to agree, and the missing country NAME is filled too", async () => {
    lookup.mockResolvedValue(resolved());
    expect(await completeLocationFromDatabase(IP, { countryCode: "de" })).toMatchObject({ country: "Germany", countryCode: "DE", city: "Frankfurt am Main", completedFromDatabase: true });
  });

  it("only MISSING fields are filled: a known time zone and region are never replaced", async () => {
    lookup.mockResolvedValue(resolved());
    const r = await completeLocationFromDatabase(IP, { country: "Germany", countryCode: "DE", region: "HE", timeZone: "Europe/Busingen" }, "Edge");
    expect(r).toMatchObject({ city: "Frankfurt am Main", region: "HE", timeZone: "Europe/Busingen", completedFromDatabase: true });
  });

  it("a region the edge gave as a CODE agrees with the database's name for it", async () => {
    lookup.mockResolvedValue(resolved());
    expect(await completeLocationFromDatabase(IP, { countryCode: "DE", region: "HE" })).toMatchObject({ city: "Frankfurt am Main", completedFromDatabase: true });
  });

  it("a database answer with no region is used as far as it goes: the city is added, the region stays empty (nothing is invented)", async () => {
    lookup.mockResolvedValue(resolved({ region: null, regionCode: null }));
    const r = await completeLocationFromDatabase(IP, { countryCode: "DE" });
    expect(r).toMatchObject({ city: "Frankfurt am Main", region: null, completedFromDatabase: true });
  });

  it("a database answer that is itself country-only keeps the location country-only - no city is invented", async () => {
    lookup.mockResolvedValue(resolved({ city: null, region: null, regionCode: null, timeZone: null }));
    const r = await completeLocationFromDatabase(IP, {});
    expect(r).toMatchObject({ city: null, region: null, country: "Germany", countryCode: "DE", completedFromDatabase: true });
  });

  it("when the database adds nothing new, the input comes back untouched and is not reported as completed", async () => {
    lookup.mockResolvedValue(resolved({ city: null, region: null, regionCode: null, timeZone: null }));
    const r = await completeLocationFromDatabase(IP, { country: "Germany", countryCode: "DE" }, "Edge");
    expect(r).toMatchObject({ completedFromDatabase: false, source: "Edge", city: null });
  });

  it("the stored label never exceeds the 120 characters the narrowest column allows", async () => {
    lookup.mockResolvedValue(resolved());
    const r = await completeLocationFromDatabase(IP, { countryCode: "DE" }, "X".repeat(200));
    expect(r.source!.length).toBeLessThanOrEqual(120);
  });
});

describe("what it refuses to do", () => {
  it("a location that already names a city is left exactly as it is, and the database is not even asked", async () => {
    const r = await completeLocationFromDatabase(IP, { city: "Los Angeles", countryCode: "US" }, "Vercel");
    expect(r).toMatchObject({ city: "Los Angeles", region: null, completedFromDatabase: false, source: "Vercel" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("different countries are never blended: the edge says Germany, the database says France -> the edge value stands, nothing is merged", async () => {
    lookup.mockResolvedValue(resolved({ city: "Paris", region: "Ile-de-France", regionCode: "IDF", country: "France", countryCode: "FR", timeZone: "Europe/Paris" }));
    const r = await completeLocationFromDatabase(IP, { country: "Germany", countryCode: "DE" }, "Edge");
    expect(r).toMatchObject({ city: null, country: "Germany", countryCode: "DE", completedFromDatabase: false, source: "Edge" });
  });

  it("a country NAME that disagrees is a conflict too, when there is no code to compare", async () => {
    lookup.mockResolvedValue(resolved());
    expect(await completeLocationFromDatabase(IP, { country: "Austria" })).toMatchObject({ completedFromDatabase: false, city: null, country: "Austria" });
  });

  it("a region that disagrees (same country) is a conflict: the city of another region is not attached to it", async () => {
    lookup.mockResolvedValue(resolved());
    expect(await completeLocationFromDatabase(IP, { countryCode: "DE", region: "Bavaria" })).toMatchObject({ completedFromDatabase: false, city: null, region: "Bavaria" });
  });

  it("no IP -> no lookup", async () => {
    for (const ip of [null, undefined, ""]) expect(await completeLocationFromDatabase(ip, { countryCode: "DE" })).toMatchObject({ completedFromDatabase: false });
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("when the database cannot answer, the input is returned unchanged and nothing throws", () => {
  it.each([
    ["invalid-ip", { status: "unresolved", reason: "invalid-ip" }],
    ["non-public-ip (private / loopback / reserved)", { status: "unresolved", reason: "non-public-ip" }],
    ["database-missing (provider unavailable)", { status: "unresolved", reason: "database-missing" }],
    ["database-error (corrupt or unreadable)", { status: "unresolved", reason: "database-error" }],
    ["not-found", { status: "unresolved", reason: "not-found" }],
    ["no-location-data", { status: "unresolved", reason: "no-location-data" }],
  ])("%s", async (_name, answer) => {
    lookup.mockResolvedValue(answer);
    const r = await completeLocationFromDatabase(IP, { country: "Germany", countryCode: "DE" }, "Edge");
    expect(r).toEqual({ city: null, region: null, country: "Germany", countryCode: "DE", timeZone: null, source: "Edge", completedFromDatabase: false });
  });

  it("a lookup that rejects or times out", async () => {
    lookup.mockImplementation(async () => {
      throw new Error("lookup timed out");
    });
    await expect(completeLocationFromDatabase(IP, { countryCode: "DE" })).resolves.toMatchObject({ completedFromDatabase: false, countryCode: "DE" });
  });

  it("a lookup that throws synchronously", async () => {
    lookup.mockImplementation(() => {
      throw new Error("synchronous failure");
    });
    await expect(completeLocationFromDatabase(IP, { countryCode: "DE" })).resolves.toMatchObject({ completedFromDatabase: false, countryCode: "DE" });
  });

  it.each([
    ["resolved but no location object", { status: "resolved", source: "x" }],
    ["a location of the wrong shape", { status: "resolved", location: "Frankfurt", source: "x" }],
    ["a non-object answer", "garbage"],
    ["null", null],
  ])("a malformed answer (%s)", async (_name, answer) => {
    lookup.mockResolvedValue(answer);
    await expect(completeLocationFromDatabase(IP, { countryCode: "DE" })).resolves.toMatchObject({ completedFromDatabase: false, city: null });
  });
});
