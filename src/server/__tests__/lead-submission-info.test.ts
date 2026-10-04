import { describe, it, expect, vi, afterEach } from "vitest";
import { buildLeadSubmissionInfoCreate } from "../lead-submission-info";

// What the server learns about a lead-submitting request. The IP and the location come ONLY from the
// request's own trusted path — never from a body field — and a spoofed header cannot become authoritative.

const h = (init: Record<string, string>) => new Headers(init);
afterEach(() => vi.unstubAllEnvs());

describe("buildLeadSubmissionInfoCreate", () => {
  it("behind Vercel: records the IPv4 the edge saw, with its approximate location", () => {
    vi.stubEnv("TRUSTED_PROXY", "vercel");
    const now = new Date("2026-10-04T12:00:00Z");
    const info = buildLeadSubmissionInfoCreate(
      h({ "x-vercel-forwarded-for": "203.0.113.42", "x-vercel-ip-city": "Los%20Angeles", "x-vercel-ip-country": "US", "x-vercel-ip-country-region": "CA", "x-vercel-ip-timezone": "America/Los_Angeles" }),
      now
    );
    expect(info).toEqual({
      ipAddress: "203.0.113.42",
      ipVersion: "v4",
      city: "Los Angeles",
      region: "California",
      country: "United States",
      countryCode: "US",
      timeZone: "America/Los_Angeles",
      geoSource: "Vercel edge geolocation (approximate)",
      capturedAt: now,
    });
  });

  it("records an IPv6 client in full and labels it v6", () => {
    vi.stubEnv("TRUSTED_PROXY", "vercel");
    const info = buildLeadSubmissionInfoCreate(h({ "x-vercel-forwarded-for": "2001:db8:85a3::8a2e:370:7334", "x-vercel-ip-country": "DE" }))!;
    expect(info.ipAddress).toBe("2001:db8:85a3::8a2e:370:7334");
    expect(info.ipVersion).toBe("v6");
    expect(info.countryCode).toBe("DE");
  });

  it("collapses an IPv4-mapped IPv6 address to plain IPv4", () => {
    vi.stubEnv("TRUSTED_PROXY", "vercel");
    expect(buildLeadSubmissionInfoCreate(h({ "x-real-ip": "::ffff:198.51.100.7" }))?.ipAddress).toBe("198.51.100.7");
  });

  it("a client-supplied header cannot override the platform's: x-vercel-forwarded-for wins over a spoofed x-forwarded-for", () => {
    vi.stubEnv("TRUSTED_PROXY", "vercel");
    const info = buildLeadSubmissionInfoCreate(h({ "x-vercel-forwarded-for": "203.0.113.42", "x-forwarded-for": "8.8.8.8, 203.0.113.42", forwarded: "for=1.1.1.1" }))!;
    expect(info.ipAddress).toBe("203.0.113.42");
  });

  it("Vercel mode never reads the RFC 7239 Forwarded or CF-Connecting-IP headers (a client can send those directly)", () => {
    vi.stubEnv("TRUSTED_PROXY", "vercel");
    expect(buildLeadSubmissionInfoCreate(h({ forwarded: "for=8.8.8.8", "cf-connecting-ip": "8.8.4.4" }))).toBeUndefined();
  });

  it("with NO trusted proxy nothing is trusted: forged IP and location headers produce no row at all", () => {
    vi.stubEnv("TRUSTED_PROXY", "none");
    expect(buildLeadSubmissionInfoCreate(h({ "x-forwarded-for": "8.8.8.8", "x-real-ip": "8.8.8.8", "x-vercel-forwarded-for": "8.8.8.8", "x-vercel-ip-city": "Atlantis", "x-vercel-ip-country": "US" }))).toBeUndefined();
  });

  it("a private / loopback / garbage address is never stored as the customer's IP", () => {
    vi.stubEnv("TRUSTED_PROXY", "vercel");
    for (const bad of ["10.0.0.5", "192.168.1.9", "127.0.0.1", "::1", "not-an-ip", "999.1.1.1"]) {
      const info = buildLeadSubmissionInfoCreate(h({ "x-vercel-forwarded-for": bad }));
      expect(info?.ipAddress ?? null, bad).toBeNull();
    }
  });

  it("IP unknown but location known: the row carries the location and a null IP (nothing invented)", () => {
    vi.stubEnv("TRUSTED_PROXY", "vercel");
    const info = buildLeadSubmissionInfoCreate(h({ "x-vercel-ip-country": "FR" }))!;
    expect(info.ipAddress).toBeNull();
    expect(info.ipVersion).toBeNull();
    expect(info.city).toBeNull();
    expect(info.country).toBe("France");
  });

  it("neither IP nor location → no row", () => {
    vi.stubEnv("TRUSTED_PROXY", "vercel");
    expect(buildLeadSubmissionInfoCreate(h({}))).toBeUndefined();
  });

  it("cloudflare mode reads only CF-Connecting-IP and attaches no location (no trusted source for it)", () => {
    vi.stubEnv("TRUSTED_PROXY", "cloudflare");
    const info = buildLeadSubmissionInfoCreate(h({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "8.8.8.8", "x-vercel-ip-city": "Atlantis" }))!;
    expect(info.ipAddress).toBe("203.0.113.9");
    expect(info.city).toBeNull();
    expect(info.geoSource).toBeNull();
  });
});
