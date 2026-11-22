import { describe, it, expect, vi, beforeEach } from "vitest";

// getAccountSignInDetails: the Users page's last sign-in data. Administrator-only AT THE QUERY (any other role gets an empty map and no database read), the full IP comes back
// only to an Administrator, and city / region / country code / time zone / source are carried separately so the page can show them. The database is faked.

const findMany = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { account: { findMany: (...a: unknown[]) => findMany(...a) } } }));

const { getAccountSignInDetails } = await import("../accounts");

const ROW = {
  id: "a1", lastSignInAt: new Date("2026-11-22T10:00:00Z"), lastSignInIp: "203.0.113.9", lastSignInCity: "Frankfurt am Main", lastSignInRegion: "Hesse", lastSignInCountry: "Germany",
  lastSignInCountryCode: "DE", lastSignInTimeZone: "Europe/Berlin", lastSignInLocationSource: "DBIP-City-Lite (2026-11-01)", lastSignInLocationAt: new Date("2026-11-22T10:00:00Z"),
};
const NULLS = { lastSignInCity: null, lastSignInRegion: null, lastSignInCountry: null, lastSignInCountryCode: null, lastSignInTimeZone: null, lastSignInLocationSource: null, lastSignInLocationAt: null };

beforeEach(() => {
  findMany.mockReset();
});

describe("getAccountSignInDetails", () => {
  it("an Administrator gets the full IP and the location in parts: city, region, country, code, time zone, source", async () => {
    findMany.mockResolvedValue([ROW]);
    const map = await getAccountSignInDetails({ role: "ADMIN", companyId: "co-1" });
    expect(map.get("a1")).toMatchObject({
      ip: "203.0.113.9", city: "Frankfurt am Main", region: "Hesse", country: "Germany", countryCode: "DE", timeZone: "Europe/Berlin", locationSource: "DBIP-City-Lite (2026-11-01)",
      location: "Frankfurt am Main, Hesse, Germany",
    });
    expect(findMany.mock.calls[0][0].where).toEqual({ companyId: "co-1" }); // this company only
    expect(findMany.mock.calls[0][0].select).toMatchObject({ lastSignInTimeZone: true, lastSignInCity: true });
  });

  it("NO other role ever receives an IP or a location: the map is empty and the database is not even read", async () => {
    for (const role of ["MANAGER", "TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"] as const) {
      expect((await getAccountSignInDetails({ role, companyId: "co-1" })).size, role).toBe(0);
    }
    expect((await getAccountSignInDetails(null)).size).toBe(0);
    expect((await getAccountSignInDetails(undefined)).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("a country-only record stays country-only: no city is invented and the source is carried", async () => {
    findMany.mockResolvedValue([{ ...ROW, lastSignInCity: null, lastSignInRegion: null, lastSignInTimeZone: null, lastSignInLocationSource: "Cloudflare edge country (CF-IPCountry)" }]);
    const d = (await getAccountSignInDetails({ role: "ADMIN", companyId: "co-1" })).get("a1")!;
    expect(d).toMatchObject({ city: null, region: null, country: "Germany", countryCode: "DE", location: "Germany", locationSource: "Cloudflare edge country (CF-IPCountry)" });
  });

  it("an IP with no location at all (no GeoIP data): the IP is still returned, every location part is null, and nothing breaks", async () => {
    findMany.mockResolvedValue([{ ...ROW, ...NULLS }]);
    const d = (await getAccountSignInDetails({ role: "ADMIN", companyId: "co-1" })).get("a1")!;
    expect(d).toMatchObject({ ip: "203.0.113.9", location: null, locationSource: null, locationNote: null, city: null, country: null, timeZone: null });
  });

  it("an account that never signed in has an entry with nothing in it (the page shows a dash)", async () => {
    findMany.mockResolvedValue([{ ...ROW, ...NULLS, id: "a2", lastSignInAt: null, lastSignInIp: null }]);
    expect((await getAccountSignInDetails({ role: "ADMIN", companyId: "co-1" })).get("a2")).toMatchObject({ lastSignInAt: null, ip: null, location: null });
  });
});
