import { describe, it, expect, afterEach, vi } from "vitest";
import { isIP } from "node:net";
import { getClientIp, isPrivateOrReservedIp, isValidIpAddress, normalizeIp } from "../request-ip";

// Address parsing, canonical storage form and the trusted-proxy precedence matrix. Every address is a documentation/test address (RFC 5737 / RFC 3849);
// no real visitor address is used anywhere. See request-ip.test.ts for the original behavioural tests.

afterEach(() => vi.unstubAllEnvs());

// A deterministic corpus (no Math.random, so a failure is reproducible): valid and invalid IPv4 and IPv6 spellings.
const hex = (n: number) => ((n * 2654435761) >>> 0).toString(16).slice(0, 1 + (n % 4));
function corpus(): string[] {
  const out = new Set<string>();
  for (let i = 1; i < 3000; i++) {
    const g = (k: number) => hex(i * 31 + k * 7);
    out.add(`${g(1)}:${g(2)}:${g(3)}:${g(4)}:${g(5)}:${g(6)}:${g(7)}:${g(8)}`);
    out.add(`${g(1)}:${g(2)}::${g(3)}`);
    out.add(`::${g(1)}:${g(2)}`);
    out.add(`${g(1)}::`);
    out.add(`${g(1)}:${g(2)}:${g(3)}:${g(4)}:${g(5)}:${g(6)}:${i % 256}.${(i * 3) % 256}.${(i * 7) % 256}.${(i * 11) % 256}`);
    out.add(`::ffff:${i % 256}.${(i * 3) % 256}.${(i * 7) % 256}.${(i * 11) % 256}`);
    out.add(`${i % 300}.${(i * 3) % 300}.${(i * 7) % 300}.${(i * 11) % 300}`);
    out.add(`${g(1)}:${g(2)}:${g(3)}:${g(4)}:${g(5)}:${g(6)}:${g(7)}:${g(8)}:${g(9)}`);
  }
  return [...out];
}

describe("isValidIpAddress agrees with Node's own parser (the earlier hand-written IPv6 pattern did not)", () => {
  it("accepts exactly what net.isIP accepts, over ~24,000 generated spellings (zone ids excluded on purpose)", () => {
    let compared = 0;
    for (const s of corpus()) {
      compared++;
      expect(isValidIpAddress(s), s).toBe(isIP(s) !== 0);
    }
    expect(compared).toBeGreaterThan(15000);
  });

  it.each([
    "0:0:0:0:0:ffff:203.0.113.9", // expanded IPv4-mapped with a dotted tail - the case the old pattern rejected
    "2001:db8:0:0:0:0:192.0.2.1", // full form with an embedded IPv4 tail
    "1:2:3:4:5:6:203.0.113.9",
    "2001:DB8::1", // upper case
    "2001:0db8:0000:0000:0000:0000:0000:0001", // fully expanded
    "::", "::1", "1::", "::ffff:cb00:7109", "64:ff9b::192.0.2.1",
  ])("valid IPv6: %s", (ip) => {
    expect(isValidIpAddress(ip)).toBe(true);
  });

  it.each([
    "", " ", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "1.2.3.4:80", "1.2.3.4/24", " 1.2.3.4", "1.2.3.4 ", "1.2.3.-4", "a.b.c.d",
    "1::2::3", "12345::1", "g::1", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7", "2001:db8::1/64", "[2001:db8::1]", "[2001:db8::1]:443", "::ffff:1.2.3",
    "fe80::1%eth0", "2001:db8::1%1", // a zone id names a local interface, never a visitor
    "unknown", "null", "undefined", "<script>", "203.0.113.9, 198.51.100.7", "x".repeat(200), "2001:db8::" + "0".repeat(60),
  ])("rejects malformed or non-address text: %j", (value) => {
    expect(isValidIpAddress(value)).toBe(false);
  });

  it("rejects non-strings without throwing", () => {
    for (const v of [undefined, null, 42, {}, []] as unknown[]) expect(isValidIpAddress(v as string)).toBe(false);
  });
});

describe("normalizeIp stores ONE text per address, never truncated", () => {
  it.each([
    ["203.0.113.9", "203.0.113.9"],
    ["2001:db8::1", "2001:db8::1"],
    ["2001:DB8::1", "2001:db8::1"],
    ["2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::1"],
    ["2001:db8:0:0:0:0:0:1", "2001:db8::1"],
    ["2001:db8:0:0:1:0:0:1", "2001:db8::1:0:0:1"], // the FIRST longest zero run is compressed (RFC 5952)
    ["2001:db8:85a3:0:0:8a2e:370:7334", "2001:db8:85a3::8a2e:370:7334"],
    ["1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8"], // nothing to compress: all eight groups kept
    ["::ffff:203.0.113.9", "203.0.113.9"],
    ["::ffff:cb00:7109", "203.0.113.9"],
    ["0:0:0:0:0:ffff:203.0.113.9", "203.0.113.9"],
    ["0:0:0:0:0:FFFF:CB00:7109", "203.0.113.9"],
    ["::203.0.113.9", "::cb00:7109"], // IPv4-COMPATIBLE: NOT the same as IPv4, only written canonically
    ["  2001:db8::1  ", "2001:db8::1"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeIp(input)).toBe(expected);
  });

  it("is idempotent, and every spelling of one address collapses to the same text", () => {
    const spellings = ["2001:db8::1", "2001:DB8:0:0:0:0:0:1", "2001:0db8::0001", "2001:db8:0000:0:0:0:0:1"];
    const set = new Set(spellings.map(normalizeIp));
    expect(set.size).toBe(1);
    for (const s of corpus().filter((x) => isIP(x) === 6).slice(0, 2000)) {
      const once = normalizeIp(s);
      expect(normalizeIp(once)).toBe(once);
      expect(isIP(once)).not.toBe(0);
    }
  });

  it("the longest possible result still fits any text column (39 characters at most)", () => {
    const longest = normalizeIp("ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe");
    expect(longest.length).toBe(39);
    for (const s of corpus().filter((x) => isIP(x) === 6).slice(0, 2000)) expect(normalizeIp(s).length).toBeLessThanOrEqual(39);
  });

  it("leaves invalid text unchanged (callers validate separately) and never throws", () => {
    for (const v of ["not-an-ip", "", "fe80::1%eth0", "1.2.3"]) expect(normalizeIp(v)).toBe(v);
  });
});

describe("isPrivateOrReservedIp", () => {
  it.each([
    "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "169.254.1.1", "100.64.0.1", "100.127.255.255", "0.1.2.3",
    "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255", "198.18.0.1", "198.19.255.255", "192.0.0.8",
    "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "fec0::1", "ff02::1", "ff00::",
    "::ffff:10.0.0.1", "::ffff:a00:1", "0:0:0:0:0:ffff:192.168.0.1", "::ffff:7f00:1", // IPv4-mapped private addresses, in any spelling
    // IPv6 forms that CARRY a private / reserved IPv4 address, or are reserved prefixes themselves (a client never connects from them)
    "2002:a00:1::1", "2002:c0a8:101::5", "2002:7f00:1::1", "64:ff9b::a00:1", "64:ff9b::c0a8:101", "64:ff9b::7f00:1", "64:ff9b:1::1", "100::1", "100::ffff:ffff:ffff:ffff", "::cb00:7109", "::2",
  ])("%s is private/reserved", (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(true);
  });

  it.each([
    "203.0.113.9", "198.51.100.7", "192.0.2.1", "8.8.8.8", "172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "198.17.255.255", "198.20.0.1",
    "2001:db8::1", "2a00:1450::1", "2606:4700::1111", "::ffff:203.0.113.9",
    "2002:808:808::1", "64:ff9b::808:808", "100:0:0:1::1", "2001::1", // 6to4 / NAT64 wrapping a PUBLIC IPv4, a prefix next to 100::/64, Teredo: judged as what they are
  ])("%s is a public (or documentation/test) address", (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(false);
  });
});

describe("getClientIp - trust and precedence matrix (mocked headers, fake addresses)", () => {
  const VISITOR4 = "203.0.113.42";
  const VISITOR6 = "2001:db8:85a3::8a2e:370:7334";
  const FORGED = "198.51.100.66";

  it("TRUSTED_PROXY=cloudflare: CF-Connecting-IP is the only source; IPv4 and IPv6 are both read in full", () => {
    vi.stubEnv("TRUSTED_PROXY", "cloudflare");
    expect(getClientIp(new Headers({ "cf-connecting-ip": VISITOR4 }))).toBe(VISITOR4);
    expect(getClientIp(new Headers({ "cf-connecting-ip": VISITOR6 }))).toBe(VISITOR6);
    expect(getClientIp(new Headers({ "cf-connecting-ip": "2001:DB8:85A3:0:0:8A2E:370:7334" }))).toBe(VISITOR6); // spelled differently, stored identically
  });

  it("TRUSTED_PROXY=cloudflare: a forged X-Forwarded-For / X-Real-IP / Forwarded / True-Client-IP never replaces it, and never fills in when it is missing", () => {
    vi.stubEnv("TRUSTED_PROXY", "cloudflare");
    const forged = { "x-forwarded-for": FORGED, "x-real-ip": FORGED, forwarded: `for=${FORGED}`, "true-client-ip": FORGED, "x-vercel-forwarded-for": FORGED };
    expect(getClientIp(new Headers({ ...forged, "cf-connecting-ip": VISITOR4 }))).toBe(VISITOR4);
    expect(getClientIp(new Headers(forged))).toBeUndefined(); // explicitly unavailable, not guessed
  });

  it("TRUSTED_PROXY=cloudflare: a Cloudflare edge or Docker/internal address is never stored as the visitor", () => {
    vi.stubEnv("TRUSTED_PROXY", "cloudflare");
    for (const internal of ["172.18.0.2", "172.17.0.1", "10.0.0.7", "192.168.65.1", "127.0.0.1", "::1", "fd00::2", "fe80::1", "100.64.12.1"]) {
      expect(getClientIp(new Headers({ "cf-connecting-ip": internal })), internal).toBeUndefined();
    }
  });

  it("TRUSTED_PROXY=cloudflare: a malformed or non-address value is unavailable, not stored", () => {
    vi.stubEnv("TRUSTED_PROXY", "cloudflare");
    for (const bad of ["unknown", "1.2.3", "999.1.1.1", "2001:db8::1::2", "203.0.113.9:443/x", "<script>alert(1)</script>", "", "   "]) {
      expect(getClientIp(new Headers({ "cf-connecting-ip": bad })), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it.each(["none", "vercel", "nginx", "generic", ""])("TRUSTED_PROXY=%j: a client-supplied CF-Connecting-IP is NOT believed", (mode) => {
    vi.stubEnv("TRUSTED_PROXY", mode);
    vi.stubEnv("VERCEL", "");
    expect(getClientIp(new Headers({ "cf-connecting-ip": FORGED }))).toBeUndefined();
  });

  it("unset or 'none': nothing is trusted at all, whatever the headers say", () => {
    vi.stubEnv("TRUSTED_PROXY", "");
    vi.stubEnv("VERCEL", "");
    expect(getClientIp(new Headers({ "x-forwarded-for": VISITOR4, "cf-connecting-ip": VISITOR4, "x-real-ip": VISITOR4, forwarded: `for=${VISITOR4}` }))).toBeUndefined();
    vi.stubEnv("TRUSTED_PROXY", "none");
    expect(getClientIp(new Headers({ "x-forwarded-for": VISITOR4 }))).toBeUndefined();
  });

  it("generic/nginx: Forwarded, then the FIRST X-Forwarded-For hop, then X-Real-IP; a list of hops uses the first; an internal first hop is unavailable", () => {
    vi.stubEnv("TRUSTED_PROXY", "generic");
    expect(getClientIp(new Headers({ forwarded: `for=${VISITOR4};proto=https`, "x-forwarded-for": FORGED }))).toBe(VISITOR4);
    expect(getClientIp(new Headers({ "x-forwarded-for": `${VISITOR4}, 10.0.0.1, 172.18.0.2` }))).toBe(VISITOR4);
    expect(getClientIp(new Headers({ "x-forwarded-for": `[${VISITOR6}]:4711, 10.0.0.1` }))).toBe(VISITOR6);
    expect(getClientIp(new Headers({ "x-forwarded-for": "10.0.0.5, 203.0.113.7" }))).toBeUndefined();
    expect(getClientIp(new Headers({ "x-real-ip": VISITOR4 }))).toBe(VISITOR4);
  });

  it("vercel: only the platform's own headers are read; CF-Connecting-IP and Forwarded are ignored", () => {
    vi.stubEnv("TRUSTED_PROXY", "vercel");
    expect(getClientIp(new Headers({ "cf-connecting-ip": FORGED, forwarded: `for=${FORGED}` }))).toBeUndefined();
    expect(getClientIp(new Headers({ "x-vercel-forwarded-for": VISITOR4, "cf-connecting-ip": FORGED }))).toBe(VISITOR4);
  });

  it("an IPv4-mapped IPv6 value from a trusted proxy is stored as the IPv4 it stands for, in every spelling", () => {
    vi.stubEnv("TRUSTED_PROXY", "cloudflare");
    for (const v of ["::ffff:203.0.113.42", "::ffff:cb00:712a", "0:0:0:0:0:ffff:cb00:712a"]) expect(getClientIp(new Headers({ "cf-connecting-ip": v })), v).toBe(VISITOR4);
  });
});
