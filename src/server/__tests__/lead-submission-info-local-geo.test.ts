import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Prisma } from "@/generated/prisma/client";

// withLocalLocation: the local geolocation database fills in a location when a trusted IP exists and the platform gave none - or gave only a country.

const lookup = vi.hoisted(() => vi.fn<(ip: string) => Promise<unknown>>());
vi.mock("@/server/geo/ip-geolocation", () => ({ lookupIpLocation: (ip: string) => lookup(ip) }));

const resolved = {
  status: "resolved",
  location: { city: "Sydney", region: "New South Wales", regionCode: "NSW", country: "Australia", countryCode: "AU", timeZone: "Australia/Sydney", latitude: -33.8, longitude: 151.2, accuracyRadiusKm: null },
  source: "DBIP-City-Lite (2026-11-01)",
  databaseBuiltAt: new Date(),
  databaseStale: false,
};
const NOW = new Date(Date.UTC(2026, 10, 13));
const ipOnly: Prisma.LeadSubmissionInfoCreateWithoutLeadInput = { ipAddress: "203.0.113.42", ipVersion: "v4", city: null, region: null, country: null, countryCode: null, timeZone: null, geoSource: null, capturedAt: NOW };

beforeEach(() => lookup.mockReset());

describe("withLocalLocation", () => {
  it("fills the location for an IP the platform did not locate, recording the database as the source, with no coordinates", async () => {
    lookup.mockResolvedValue(resolved);
    const { withLocalLocation } = await import("../lead-submission-info");
    const out = await withLocalLocation(ipOnly);
    expect(lookup).toHaveBeenCalledWith("203.0.113.42");
    expect(out).toMatchObject({ ipAddress: "203.0.113.42", ipVersion: "v4", city: "Sydney", region: "New South Wales", country: "Australia", countryCode: "AU", timeZone: "Australia/Sydney", geoSource: "DBIP-City-Lite (2026-11-01)", capturedAt: NOW });
    expect(Object.keys(out!).join()).not.toMatch(/lat|lon/i);
  });

  it("keeps a location the platform already supplied and does not ask the database", async () => {
    const withGeo = { ...ipOnly, city: "Los Angeles", countryCode: "US", geoSource: "Vercel edge geolocation (approximate)" };
    const { withLocalLocation } = await import("../lead-submission-info");
    expect(await withLocalLocation(withGeo)).toBe(withGeo);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("a platform location that names only the COUNTRY is completed (city, region, time zone), only when the database agrees, and the source names both", async () => {
    lookup.mockResolvedValue(resolved);
    const { withLocalLocation } = await import("../lead-submission-info");
    const countryOnly = { ...ipOnly, country: "Australia", countryCode: "AU", geoSource: "Cloudflare edge country (CF-IPCountry)" };
    expect(await withLocalLocation(countryOnly)).toMatchObject({ city: "Sydney", region: "New South Wales", country: "Australia", countryCode: "AU", timeZone: "Australia/Sydney", geoSource: "Cloudflare edge country (CF-IPCountry) + DBIP-City-Lite (2026-11-01)" });
    const conflicting = { ...ipOnly, country: "New Zealand", countryCode: "NZ", geoSource: "Cloudflare edge country (CF-IPCountry)" };
    expect(await withLocalLocation(conflicting)).toBe(conflicting); // two sources that disagree are not blended
  });

  it("does nothing without an IP (a budget-currency-only or missing record) - there is nobody to geolocate", async () => {
    const { withLocalLocation } = await import("../lead-submission-info");
    expect(await withLocalLocation(undefined)).toBeUndefined();
    const noIp = { ...ipOnly, ipAddress: null, ipVersion: null, budgetCurrency: "EUR" };
    expect(await withLocalLocation(noIp)).toBe(noIp);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("an unresolved or throwing lookup leaves the record exactly as it was", async () => {
    const { withLocalLocation } = await import("../lead-submission-info");
    lookup.mockResolvedValueOnce({ status: "unresolved", reason: "not-found" });
    expect(await withLocalLocation(ipOnly)).toBe(ipOnly);
    lookup.mockRejectedValueOnce(new Error("mmdb exploded"));
    expect(await withLocalLocation(ipOnly)).toBe(ipOnly);
  });
});
