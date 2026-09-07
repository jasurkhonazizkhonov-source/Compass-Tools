import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isValidIpAddress, getClientIp, trustedProxyMode, normalizeIp, isPrivateOrReservedIp } from "../request-ip";

describe("isValidIpAddress", () => {
  it("accepts valid IPv4 addresses", () => {
    expect(isValidIpAddress("203.0.113.42")).toBe(true);
    expect(isValidIpAddress("127.0.0.1")).toBe(true);
    expect(isValidIpAddress("0.0.0.0")).toBe(true);
    expect(isValidIpAddress("255.255.255.255")).toBe(true);
  });

  it("rejects malformed IPv4-shaped strings", () => {
    expect(isValidIpAddress("999.0.0.1")).toBe(false);
    expect(isValidIpAddress("1.2.3")).toBe(false);
    expect(isValidIpAddress("1.2.3.4.5")).toBe(false);
    expect(isValidIpAddress("1.2.3.256")).toBe(false);
  });

  it("accepts valid IPv6 addresses", () => {
    expect(isValidIpAddress("::1")).toBe(true);
    expect(isValidIpAddress("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe(true);
    expect(isValidIpAddress("2001:db8::8a2e:370:7334")).toBe(true);
    expect(isValidIpAddress("::ffff:203.0.113.42")).toBe(true);
  });

  it("rejects malformed values, injection attempts, and arbitrary strings", () => {
    expect(isValidIpAddress("not-an-ip")).toBe(false);
    expect(isValidIpAddress("")).toBe(false);
    expect(isValidIpAddress("203.0.113.42; DROP TABLE bookings")).toBe(false);
    expect(isValidIpAddress("<script>alert(1)</script>")).toBe(false);
    expect(isValidIpAddress("203.0.113.42,10.0.0.1")).toBe(false);
  });
});

describe("normalizeIp", () => {
  it("collapses an IPv4-mapped IPv6 address to plain IPv4", () => {
    expect(normalizeIp("::ffff:203.0.113.42")).toBe("203.0.113.42");
  });

  it("is case-insensitive on the ffff marker", () => {
    expect(normalizeIp("::FFFF:203.0.113.42")).toBe("203.0.113.42");
  });

  it("leaves a genuine IPv6 address unchanged", () => {
    expect(normalizeIp("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe("2001:0db8:85a3:0000:0000:8a2e:0370:7334");
  });

  it("leaves a plain IPv4 address unchanged", () => {
    expect(normalizeIp("203.0.113.42")).toBe("203.0.113.42");
  });

  it("leaves the deprecated IPv4-COMPATIBLE form (no ffff marker) unchanged — deliberately not touched", () => {
    expect(normalizeIp("::203.0.113.42")).toBe("::203.0.113.42");
  });
});

describe("isPrivateOrReservedIp", () => {
  it("recognizes every RFC 1918 IPv4 private range", () => {
    expect(isPrivateOrReservedIp("10.1.2.3")).toBe(true);
    expect(isPrivateOrReservedIp("172.16.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("172.31.255.255")).toBe(true);
    expect(isPrivateOrReservedIp("192.168.1.1")).toBe(true);
  });

  it("does not treat 172.15.x or 172.32.x as private (just outside the /12 range)", () => {
    expect(isPrivateOrReservedIp("172.15.0.1")).toBe(false);
    expect(isPrivateOrReservedIp("172.32.0.1")).toBe(false);
  });

  it("recognizes IPv4 loopback, link-local, and 'this network'", () => {
    expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("169.254.1.1")).toBe(true);
    expect(isPrivateOrReservedIp("0.0.0.1")).toBe(true);
  });

  it("recognizes IPv6 loopback, unique-local, and link-local", () => {
    expect(isPrivateOrReservedIp("::1")).toBe(true);
    expect(isPrivateOrReservedIp("fc00::1")).toBe(true);
    expect(isPrivateOrReservedIp("fd12:3456:789a::1")).toBe(true);
    expect(isPrivateOrReservedIp("fe80::1")).toBe(true);
  });

  it("does not flag a genuine public IPv4/IPv6 address", () => {
    expect(isPrivateOrReservedIp("203.0.113.42")).toBe(false);
    expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedIp("2001:4860:4860::8888")).toBe(false);
  });

  it("does not flag an IPv6 documentation-range address (2001:db8::/32) — a different, non-proxy-misconfiguration case", () => {
    expect(isPrivateOrReservedIp("2001:db8::1")).toBe(false);
  });
});

describe("trustedProxyMode", () => {
  const original = process.env.TRUSTED_PROXY;
  afterEach(() => {
    if (original === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = original;
  });

  it("defaults to 'none' when unset", () => {
    delete process.env.TRUSTED_PROXY;
    expect(trustedProxyMode()).toBe("none");
  });

  it("defaults to 'none' for an unrecognized value (fails closed, never guesses)", () => {
    process.env.TRUSTED_PROXY = "some-typo";
    expect(trustedProxyMode()).toBe("none");
  });

  it("accepts each documented mode", () => {
    for (const mode of ["vercel", "cloudflare", "nginx", "generic"]) {
      process.env.TRUSTED_PROXY = mode;
      expect(trustedProxyMode()).toBe(mode);
    }
  });
});

describe("getClientIp — no trusted proxy configured (the secure default)", () => {
  const original = process.env.TRUSTED_PROXY;
  beforeEach(() => {
    delete process.env.TRUSTED_PROXY;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = original;
  });

  it("never trusts X-Forwarded-For when no trusted proxy is configured — prevents direct-client spoofing", () => {
    // Simulates an attacker connecting directly (no real proxy in front)
    // and setting the header themselves to impersonate another address.
    const headers = new Headers({ "x-forwarded-for": "8.8.8.8" });
    expect(getClientIp(headers)).toBeUndefined();
  });

  it("never trusts CF-Connecting-IP, X-Real-IP, or Forwarded either", () => {
    const headers = new Headers({
      "cf-connecting-ip": "8.8.8.8",
      "x-real-ip": "8.8.8.8",
      forwarded: "for=8.8.8.8",
    });
    expect(getClientIp(headers)).toBeUndefined();
  });

  it("returns undefined even with no headers at all — this is the expected local-dev ::1 scenario (no header to trust, not a bug)", () => {
    expect(getClientIp(new Headers())).toBeUndefined();
  });
});

describe("getClientIp — TRUSTED_PROXY=vercel", () => {
  const original = process.env.TRUSTED_PROXY;
  beforeEach(() => {
    process.env.TRUSTED_PROXY = "vercel";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = original;
  });

  it("uses the first hop of X-Forwarded-For", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.42, 10.0.0.1, 10.0.0.2" });
    expect(getClientIp(headers)).toBe("203.0.113.42");
  });

  it("handles a longer chain of multiple proxy addresses, still taking only the first (client) hop", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.42, 70.41.3.18, 150.172.238.178, 10.0.0.5" });
    expect(getClientIp(headers)).toBe("203.0.113.42");
  });

  it("falls back to X-Real-IP when X-Forwarded-For is absent", () => {
    const headers = new Headers({ "x-real-ip": "198.51.100.7" });
    expect(getClientIp(headers)).toBe("198.51.100.7");
  });

  it("prefers X-Forwarded-For over X-Real-IP when both are present", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.42", "x-real-ip": "198.51.100.7" });
    expect(getClientIp(headers)).toBe("203.0.113.42");
  });

  it("resolves a valid IPv6 address", () => {
    const headers = new Headers({ "x-forwarded-for": "2001:db8::1" });
    expect(getClientIp(headers)).toBe("2001:db8::1");
  });

  it("returns undefined when no IP header is present", () => {
    expect(getClientIp(new Headers())).toBeUndefined();
  });

  it("returns undefined (never a garbage string) for a malformed/spoofed header value", () => {
    const headers = new Headers({ "x-forwarded-for": "'; DROP TABLE bookings; --" });
    expect(getClientIp(headers)).toBeUndefined();
  });

  it("trims whitespace around the first hop", () => {
    const headers = new Headers({ "x-forwarded-for": "  203.0.113.42  , 10.0.0.1" });
    expect(getClientIp(headers)).toBe("203.0.113.42");
  });

  it("prefers the RFC 7239 Forwarded header over X-Forwarded-For when both are present", () => {
    const headers = new Headers({ forwarded: "for=192.0.2.60;proto=https", "x-forwarded-for": "203.0.113.42" });
    expect(getClientIp(headers)).toBe("192.0.2.60");
  });

  it("parses a quoted IPv6 Forwarded header with a port", () => {
    const headers = new Headers({ forwarded: 'for="[2001:db8:cafe::17]:4711";proto=https' });
    expect(getClientIp(headers)).toBe("2001:db8:cafe::17");
  });

  it("strips a port suffix from an IPv4 Forwarded value", () => {
    const headers = new Headers({ forwarded: "for=203.0.113.9:51820" });
    expect(getClientIp(headers)).toBe("203.0.113.9");
  });

  it("takes only the first element of a multi-hop Forwarded header", () => {
    const headers = new Headers({ forwarded: "for=203.0.113.42, for=70.41.3.18" });
    expect(getClientIp(headers)).toBe("203.0.113.42");
  });

  it("normalizes an IPv4-mapped IPv6 X-Forwarded-For value down to plain IPv4", () => {
    const headers = new Headers({ "x-forwarded-for": "::ffff:203.0.113.42" });
    expect(getClientIp(headers)).toBe("203.0.113.42");
  });

  it("normalizes an IPv4-mapped IPv6 X-Real-IP value too", () => {
    const headers = new Headers({ "x-real-ip": "::ffff:198.51.100.7" });
    expect(getClientIp(headers)).toBe("198.51.100.7");
  });

  it("strips a stray port from an X-Forwarded-For value (a real-world misconfigured-proxy quirk) instead of rejecting it outright", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.9:51820" });
    expect(getClientIp(headers)).toBe("203.0.113.9");
  });

  it("strips a stray port from an X-Real-IP value", () => {
    const headers = new Headers({ "x-real-ip": "198.51.100.7:8080" });
    expect(getClientIp(headers)).toBe("198.51.100.7");
  });

  it("strips a bracketed-IPv6-with-port form from X-Forwarded-For", () => {
    const headers = new Headers({ "x-forwarded-for": "[2001:db8::1]:4711" });
    expect(getClientIp(headers)).toBe("2001:db8::1");
  });

  it("handles a completely empty X-Forwarded-For header value gracefully (returns undefined, never throws)", () => {
    const headers = new Headers({ "x-forwarded-for": "" });
    expect(getClientIp(headers)).toBeUndefined();
  });

  it("handles a malformed multi-comma X-Forwarded-For value gracefully", () => {
    const headers = new Headers({ "x-forwarded-for": ",,,203.0.113.42" });
    expect(getClientIp(headers)).toBeUndefined();
  });

  it("rejects a resolved private-range IP (::1) instead of returning it — the general form of the historical loopback bug", () => {
    const headers = new Headers({ "x-forwarded-for": "::1" });
    expect(getClientIp(headers)).toBeUndefined();
  });

  it("rejects a resolved RFC 1918 private IPv4 (e.g. an internal load-balancer hop leaking through)", () => {
    const headers = new Headers({ "x-forwarded-for": "10.0.0.5" });
    expect(getClientIp(headers)).toBeUndefined();
  });

  it("still accepts a genuine public IP even when a private one would have been rejected", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.42" });
    expect(getClientIp(headers)).toBe("203.0.113.42");
  });
});

describe("getClientIp — TRUSTED_PROXY=cloudflare", () => {
  const original = process.env.TRUSTED_PROXY;
  beforeEach(() => {
    process.env.TRUSTED_PROXY = "cloudflare";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = original;
  });

  it("prefers CF-Connecting-IP over X-Forwarded-For", () => {
    const headers = new Headers({ "cf-connecting-ip": "198.51.100.9", "x-forwarded-for": "203.0.113.42" });
    expect(getClientIp(headers)).toBe("198.51.100.9");
  });

  it("falls back to X-Forwarded-For when CF-Connecting-IP is absent", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.42" });
    expect(getClientIp(headers)).toBe("203.0.113.42");
  });
});

// A separate dynamic-import-per-test block (unlike the static top-level
// import used by every describe above) — the production-warning fires at
// most ONCE per module instance (warnedMissingTrustedProxyInProduction is
// module-level state, deliberately, so it doesn't spam on every request),
// so each test here needs its own fresh module instance via
// vi.resetModules() to observe the warning in isolation.
describe("getClientIp — production TRUSTED_PROXY warning (never a trust decision, only a log line)", () => {
  const originalTrustedProxy = process.env.TRUSTED_PROXY;
  const originalAppEnv = process.env.APP_ENV;
  const originalVercel = process.env.VERCEL;

  afterEach(() => {
    if (originalTrustedProxy === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = originalTrustedProxy;
    if (originalAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
    vi.restoreAllMocks();
  });

  it("warns once when TRUSTED_PROXY is unset in production", async () => {
    vi.resetModules();
    delete process.env.TRUSTED_PROXY;
    delete process.env.VERCEL;
    process.env.APP_ENV = "production";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getClientIp: freshGetClientIp } = await import("../request-ip");
    freshGetClientIp(new Headers());
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/TRUSTED_PROXY is not configured/i);
  });

  it("warns only once even across multiple calls in the same process — not once per request", async () => {
    vi.resetModules();
    delete process.env.TRUSTED_PROXY;
    delete process.env.VERCEL;
    process.env.APP_ENV = "production";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getClientIp: freshGetClientIp } = await import("../request-ip");
    freshGetClientIp(new Headers());
    freshGetClientIp(new Headers());
    freshGetClientIp(new Headers());
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("never warns in development even when TRUSTED_PROXY is unset — this is the expected local-dev state", async () => {
    vi.resetModules();
    delete process.env.TRUSTED_PROXY;
    delete process.env.APP_ENV;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getClientIp: freshGetClientIp } = await import("../request-ip");
    freshGetClientIp(new Headers());
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("never warns in production once TRUSTED_PROXY is actually configured", async () => {
    vi.resetModules();
    process.env.TRUSTED_PROXY = "vercel";
    process.env.APP_ENV = "production";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getClientIp: freshGetClientIp } = await import("../request-ip");
    freshGetClientIp(new Headers());
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("suggests the detected platform in the warning message when a platform-identifying env var is present", async () => {
    vi.resetModules();
    delete process.env.TRUSTED_PROXY;
    process.env.APP_ENV = "production";
    process.env.VERCEL = "1";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getClientIp: freshGetClientIp } = await import("../request-ip");
    freshGetClientIp(new Headers());
    expect(warnSpy.mock.calls[0][0]).toMatch(/vercel/i);
  });

  it("never blindly trusts the detected platform hint — a spoofed header is still rejected even with the hint present", async () => {
    vi.resetModules();
    delete process.env.TRUSTED_PROXY;
    process.env.APP_ENV = "production";
    process.env.VERCEL = "1";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getClientIp: freshGetClientIp } = await import("../request-ip");
    const headers = new Headers({ "x-forwarded-for": "8.8.8.8" });
    expect(freshGetClientIp(headers)).toBeUndefined();
  });
});
