import { describe, it, expect, vi, afterEach } from "vitest";
import { readApproximateLocation, getRequestLocation, formatLocation, locationToIpCaptureColumns, GEO_SOURCE } from "../request-geo";

// The approximate, IP-derived location. It is an estimate of where the NETWORK is, read only
// from the platform edge's own headers and only behind the trusted-proxy gate; anything that
// is absent or malformed is omitted (never invented).

const h = (init: Record<string, string>) => new Headers(init);
afterEach(() => vi.unstubAllEnvs());

describe("readApproximateLocation", () => {
  it("reads city, region, country, country code and time zone from the Vercel edge headers", () => {
    const loc = readApproximateLocation(
      h({ "x-vercel-ip-city": "Los%20Angeles", "x-vercel-ip-country": "US", "x-vercel-ip-country-region": "CA", "x-vercel-ip-timezone": "America/Los_Angeles" })
    );
    expect(loc).toEqual({ city: "Los Angeles", regionCode: "CA", region: "California", country: "United States", countryCode: "US", timeZone: "America/Los_Angeles" });
  });

  it("URL-decodes accented city names", () => {
    expect(readApproximateLocation(h({ "x-vercel-ip-city": "S%C3%A3o%20Paulo", "x-vercel-ip-country": "BR" }))?.city).toBe("São Paulo");
  });

  it("City unavailable: only the fields that exist are returned, and no city is made up", () => {
    const loc = readApproximateLocation(h({ "x-vercel-ip-country": "GB" }))!;
    expect(loc).toEqual({ country: "United Kingdom", countryCode: "GB" });
    expect("city" in loc).toBe(false);
  });

  it("Country unavailable but a city present is kept as-is (the platform supplied it)", () => {
    expect(readApproximateLocation(h({ "x-vercel-ip-city": "Lisbon" }))).toEqual({ city: "Lisbon" });
  });

  it("no usable header → undefined (the UI says 'Not available' rather than showing a guess)", () => {
    expect(readApproximateLocation(h({}))).toBeUndefined();
    expect(readApproximateLocation(h({ "x-vercel-ip-country": "ZZZ", "x-vercel-ip-timezone": "Not/AZone" }))).toBeUndefined();
  });

  it("rejects malformed values: bad country code, bad region, unknown time zone, overlong or control-character city", () => {
    const loc = readApproximateLocation(
      h({ "x-vercel-ip-country": "usa", "x-vercel-ip-country-region": "TOO-LONG-REGION", "x-vercel-ip-timezone": "Mars/Olympus", "x-vercel-ip-city": "A".repeat(200) })
    );
    expect(loc).toBeUndefined();
    expect(readApproximateLocation(h({ "x-vercel-ip-city": "Bad%00%07City", "x-vercel-ip-country": "US" }))?.city).toBe("Bad City");
    expect(readApproximateLocation(h({ "x-vercel-ip-city": "%E0%A4%A" }))).toBeUndefined(); // undecodable
  });

  it("knows readable region names for US states, Canadian provinces and Australian states; otherwise only the code", () => {
    expect(readApproximateLocation(h({ "x-vercel-ip-country": "CA", "x-vercel-ip-country-region": "ON" }))?.region).toBe("Ontario");
    expect(readApproximateLocation(h({ "x-vercel-ip-country": "AU", "x-vercel-ip-country-region": "NSW" }))?.region).toBe("New South Wales");
    const other = readApproximateLocation(h({ "x-vercel-ip-country": "FR", "x-vercel-ip-country-region": "IDF" }))!;
    expect(other.region).toBeUndefined();
    expect(other.regionCode).toBe("IDF");
  });

  it("never reads precise coordinates or postal codes", () => {
    const loc = readApproximateLocation(h({ "x-vercel-ip-latitude": "34.05", "x-vercel-ip-longitude": "-118.24", "x-vercel-ip-postal-code": "90001", "x-vercel-ip-country": "US" }))!;
    expect(JSON.stringify(loc)).not.toMatch(/34\.05|118|90001/);
  });
});

describe("getRequestLocation — the trusted-proxy gate", () => {
  const spoofed = h({ "x-vercel-ip-city": "Atlantis", "x-vercel-ip-country": "US" });

  it("with no trusted proxy the geo headers are ignored entirely — a client could have sent them", () => {
    vi.stubEnv("TRUSTED_PROXY", "none");
    expect(getRequestLocation(spoofed)).toBeUndefined();
    vi.stubEnv("TRUSTED_PROXY", "");
    vi.stubEnv("VERCEL", "");
    expect(getRequestLocation(spoofed)).toBeUndefined();
  });

  it("other proxy modes (nginx / generic / cloudflare) do not vouch for Vercel's geo headers either", () => {
    for (const mode of ["nginx", "generic", "cloudflare"]) {
      vi.stubEnv("TRUSTED_PROXY", mode);
      expect(getRequestLocation(spoofed), mode).toBeUndefined();
    }
  });

  it("behind Vercel (explicit or the platform's own VERCEL=1) the headers are read", () => {
    vi.stubEnv("TRUSTED_PROXY", "vercel");
    expect(getRequestLocation(spoofed)?.city).toBe("Atlantis");
    vi.stubEnv("TRUSTED_PROXY", "");
    vi.stubEnv("VERCEL", "1");
    expect(getRequestLocation(spoofed)?.countryCode).toBe("US");
  });
});

describe("formatting and storage mapping", () => {
  it("formatLocation joins only the parts that exist", () => {
    expect(formatLocation({ city: "Paris", country: "France", countryCode: "FR" })).toBe("Paris, France");
    expect(formatLocation({ countryCode: "FR" })).toBe("FR");
    expect(formatLocation({ city: "Lyon", regionCode: "ARA" })).toBe("Lyon, ARA");
  });

  it("locationToIpCaptureColumns stores nulls — not empty strings, not guesses — for what was not supplied", () => {
    expect(locationToIpCaptureColumns(undefined)).toEqual({ geoCity: null, geoRegion: null, geoCountry: null, geoCountryCode: null, geoTimeZone: null, geoSource: null });
    expect(locationToIpCaptureColumns({ countryCode: "US", country: "United States" })).toEqual({
      geoCity: null,
      geoRegion: null,
      geoCountry: "United States",
      geoCountryCode: "US",
      geoTimeZone: null,
      geoSource: GEO_SOURCE,
    });
    expect(locationToIpCaptureColumns({ city: "Austin", region: "Texas", regionCode: "TX", country: "United States", countryCode: "US", timeZone: "America/Chicago" })).toMatchObject({ geoRegion: "Texas", geoCity: "Austin" });
  });
});
