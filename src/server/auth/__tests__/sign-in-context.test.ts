import { describe, it, expect, afterEach } from "vitest";
import { captureSignInContext, formatSignInLocation } from "../sign-in-context";

// What the server records about a SUCCESSFUL sign-in comes only from the request's own trusted path: the same getClientIp /
// getRequestLocation every other IP-bearing record uses. Nothing is taken from a body, and nothing is invented.

const ENV_KEYS = ["TRUSTED_PROXY", "VERCEL"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function headers(init: Record<string, string>) {
  return new Headers(init);
}

const VERCEL_HEADERS = {
  "x-vercel-forwarded-for": "203.0.113.9",
  "x-vercel-ip-city": "Frankfurt",
  "x-vercel-ip-country": "DE",
  "x-vercel-ip-country-region": "HE",
  "x-vercel-ip-timezone": "Europe/Berlin",
};

describe("captureSignInContext", () => {
  it("on a trusted Vercel path records the client IP and the approximate location from the platform headers", () => {
    process.env.TRUSTED_PROXY = "vercel";
    const ctx = captureSignInContext(headers(VERCEL_HEADERS));
    expect(ctx).toMatchObject({ ip: "203.0.113.9", city: "Frankfurt", countryCode: "DE", timeZone: "Europe/Berlin" });
    expect(ctx.country).toBeTruthy();
  });

  it("with no trusted proxy it records NOTHING from forwarded-for / geo headers a client could have forged", () => {
    process.env.TRUSTED_PROXY = "none";
    const ctx = captureSignInContext(headers({ ...VERCEL_HEADERS, "x-forwarded-for": "198.51.100.77" }));
    expect(ctx).toEqual({ ip: null, city: null, region: null, country: null, countryCode: null, timeZone: null });
  });

  it("an unconfigured, non-Vercel server trusts nothing either", () => {
    delete process.env.TRUSTED_PROXY;
    delete process.env.VERCEL;
    expect(captureSignInContext(headers({ ...VERCEL_HEADERS, "x-real-ip": "198.51.100.77" })).ip).toBeNull();
  });

  it("an IP without geo headers gives an IP and no location — the location is never fabricated", () => {
    process.env.TRUSTED_PROXY = "vercel";
    const ctx = captureSignInContext(headers({ "x-vercel-forwarded-for": "203.0.113.9" }));
    expect(ctx.ip).toBe("203.0.113.9");
    expect(ctx).toMatchObject({ city: null, region: null, country: null, countryCode: null, timeZone: null });
  });

  it("a malformed forwarded value is not stored as an IP", () => {
    process.env.TRUSTED_PROXY = "vercel";
    expect(captureSignInContext(headers({ "x-vercel-forwarded-for": "not-an-ip; DROP TABLE" })).ip).toBeNull();
  });

  it("IPv6 addresses are kept in full", () => {
    process.env.TRUSTED_PROXY = "vercel";
    expect(captureSignInContext(headers({ "x-vercel-forwarded-for": "2001:db8::8a2e:370:7334" })).ip).toBe("2001:db8::8a2e:370:7334");
  });
});

describe("formatSignInLocation", () => {
  it("joins the parts that exist: city, region, country", () => {
    expect(formatSignInLocation({ city: "Frankfurt", region: "Hesse", country: "Germany", countryCode: "DE" })).toBe("Frankfurt, Hesse, Germany");
  });

  it("omits missing parts without leaving gaps, and falls back to the country code", () => {
    expect(formatSignInLocation({ city: null, region: null, country: "Germany" })).toBe("Germany");
    expect(formatSignInLocation({ city: "Frankfurt", region: null, country: null, countryCode: "DE" })).toBe("Frankfurt, DE");
    expect(formatSignInLocation({ city: "  ", region: "", country: null, countryCode: null })).toBeNull();
  });

  it("returns null (the neutral 'Location unavailable' state) when nothing is known", () => {
    expect(formatSignInLocation({})).toBeNull();
    expect(formatSignInLocation({ city: null, region: null, country: null, countryCode: null })).toBeNull();
  });
});
