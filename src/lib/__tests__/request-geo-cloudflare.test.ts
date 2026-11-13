import { describe, it, expect, afterEach, vi } from "vitest";
import { CLOUDFLARE_GEO_SOURCE, GEO_SOURCE, geoSourceOf, getRequestLocation, locationToIpCaptureColumns, readCloudflareLocation } from "../request-geo";

// Cloudflare's approximate, IP-derived location: what is read, when it is trusted, what is deliberately not read, and how it is labelled.
// Mocked headers and fake places only. This is where a NETWORK probably is - never GPS, never an address - and the source label says so.

afterEach(() => vi.unstubAllEnvs());

const FULL = {
  "cf-ipcountry": "AU",
  "cf-ipcity": "Sydney",
  "cf-region": "New South Wales",
  "cf-region-code": "NSW",
  "cf-timezone": "Australia/Sydney",
};

describe("readCloudflareLocation", () => {
  it("reads country, country code, city, region (name and code) and time zone, and labels the source", () => {
    expect(readCloudflareLocation(new Headers(FULL))).toEqual({
      city: "Sydney",
      regionCode: "NSW",
      region: "New South Wales",
      country: "Australia",
      countryCode: "AU",
      timeZone: "Australia/Sydney",
      source: CLOUDFLARE_GEO_SOURCE,
    });
    expect(CLOUDFLARE_GEO_SOURCE).toMatch(/approximate/i);
  });

  it("never reads coordinates or the postal code, even when Cloudflare sends them (policy: no latitude/longitude is stored anywhere)", () => {
    const l = readCloudflareLocation(new Headers({ ...FULL, "cf-iplatitude": "-33.8688", "cf-iplongitude": "151.2093", "cf-postal-code": "2000", "cf-metro-code": "999" }));
    expect(JSON.stringify(l)).not.toMatch(/33\.8688|151\.2093|2000|999|lat|lon|postal/i);
  });

  it("partial location: a city alone, or a region alone, is kept and nothing is invented for the rest", () => {
    expect(readCloudflareLocation(new Headers({ "cf-ipcity": "Lyon" }))).toEqual({ city: "Lyon", source: CLOUDFLARE_GEO_SOURCE });
    expect(readCloudflareLocation(new Headers({ "cf-ipcountry": "US", "cf-region-code": "CA" }))).toEqual({
      regionCode: "CA",
      region: "California", // a well-known US/CA/AU code is expanded; anything else stays a code
      country: "United States",
      countryCode: "US",
      source: CLOUDFLARE_GEO_SOURCE,
    });
    expect(readCloudflareLocation(new Headers({ "cf-ipcountry": "DE", "cf-region-code": "BY" }))).toMatchObject({ regionCode: "BY", countryCode: "DE" });
    expect(readCloudflareLocation(new Headers({ "cf-ipcountry": "DE", "cf-region-code": "BY" }))?.region).toBeUndefined();
  });

  it("a country-only answer (the only header Cloudflare always sends) is NOT a location here - it is left to the existing fallback chain", () => {
    expect(readCloudflareLocation(new Headers({ "cf-ipcountry": "DE" }))).toBeUndefined();
  });

  it("missing geolocation: no headers, empty headers, 'unknown' (XX) and Tor (T1) all give nothing", () => {
    expect(readCloudflareLocation(new Headers())).toBeUndefined();
    expect(readCloudflareLocation(new Headers({ "cf-ipcity": "", "cf-region": " ", "cf-ipcountry": "" }))).toBeUndefined();
    expect(readCloudflareLocation(new Headers({ "cf-ipcountry": "XX" }))).toBeUndefined();
    expect(readCloudflareLocation(new Headers({ "cf-ipcountry": "T1", "cf-ipcity": "Berlin" }))).toEqual({ city: "Berlin", source: CLOUDFLARE_GEO_SOURCE }); // Tor names no country
  });

  it("malformed values are dropped, never stored: bad country, bad region code, control characters, over-long text, unknown time zone", () => {
    const l = readCloudflareLocation(
      new Headers({ "cf-ipcountry": "USA", "cf-ipcity": "Paris", "cf-region-code": "<script>", "cf-region": "x".repeat(300), "cf-timezone": "Mars/Olympus" })
    );
    expect(l).toEqual({ city: "Paris", source: CLOUDFLARE_GEO_SOURCE });
    expect(readCloudflareLocation(new Headers({ "cf-ipcity": "Zu%00rich" }))?.city).toBe("Zu rich"); // a header cannot carry a raw NUL; a percent-encoded one decodes to it
  });

  it("a percent-encoded city is decoded; undecodable text is dropped", () => {
    expect(readCloudflareLocation(new Headers({ "cf-ipcity": "S%C3%A3o%20Paulo" }))?.city).toBe("São Paulo");
    expect(readCloudflareLocation(new Headers({ "cf-ipcity": "%E0%A4%A" }))).toBeUndefined();
  });
});

describe("getRequestLocation honours the trusted-proxy gate", () => {
  it("cloudflare: reads the Cloudflare headers, never the Vercel ones", () => {
    vi.stubEnv("TRUSTED_PROXY", "cloudflare");
    expect(getRequestLocation(new Headers({ ...FULL, "x-vercel-ip-city": "Atlantis" }))?.city).toBe("Sydney");
    expect(getRequestLocation(new Headers({ "x-vercel-ip-city": "Atlantis", "x-vercel-ip-country": "US" }))).toBeUndefined();
  });

  it("vercel: reads the Vercel headers, never the Cloudflare ones", () => {
    vi.stubEnv("TRUSTED_PROXY", "vercel");
    expect(getRequestLocation(new Headers({ ...FULL, "x-vercel-ip-city": "Frankfurt", "x-vercel-ip-country": "DE" }))?.city).toBe("Frankfurt");
    expect(getRequestLocation(new Headers(FULL))).toBeUndefined();
  });

  it.each(["none", "nginx", "generic", ""])("TRUSTED_PROXY=%j: forged Cloudflare or Vercel location headers are ignored", (mode) => {
    vi.stubEnv("TRUSTED_PROXY", mode);
    vi.stubEnv("VERCEL", "");
    expect(getRequestLocation(new Headers({ ...FULL, "x-vercel-ip-city": "Atlantis", "x-vercel-ip-country": "US" }))).toBeUndefined();
  });
});

describe("source labels and stored columns", () => {
  it("a Vercel location keeps its label, a Cloudflare one carries its own", () => {
    expect(geoSourceOf({ city: "X" })).toBe(GEO_SOURCE);
    expect(geoSourceOf({ city: "X", source: CLOUDFLARE_GEO_SOURCE })).toBe(CLOUDFLARE_GEO_SOURCE);
  });

  it("the booking-vault columns store the right source, and nothing when there is no location", () => {
    vi.stubEnv("TRUSTED_PROXY", "cloudflare");
    const cols = locationToIpCaptureColumns(getRequestLocation(new Headers(FULL)));
    expect(cols).toEqual({ geoCity: "Sydney", geoRegion: "New South Wales", geoCountry: "Australia", geoCountryCode: "AU", geoTimeZone: "Australia/Sydney", geoSource: CLOUDFLARE_GEO_SOURCE });
    expect(Object.keys(cols).join()).not.toMatch(/lat|lon/i);
    expect(locationToIpCaptureColumns(undefined)).toEqual({ geoCity: null, geoRegion: null, geoCountry: null, geoCountryCode: null, geoTimeZone: null, geoSource: null });
  });
});
