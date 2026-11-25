import { describe, it, expect, vi, beforeEach } from "vitest";
import { rateLimitBucketForClient } from "@/lib/request-ip";

// An IPv6 owner can use any address in their /64, so a counter per full address would give one client an unlimited allowance. The limiter counts the /64;
// IPv4 clients and the fixed bucket names are counted exactly as before. Only the COUNTER KEY is affected: no stored address is changed.
const counts = new Map<string, number>();
const queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
  if (strings.join("?").trim().startsWith("SELECT")) return counts.has(String(values[0])) ? [{ count: counts.get(String(values[0])) }] : [];
  const key = String(values[1]);
  counts.set(key, (counts.get(key) ?? 0) + 1);
  return [{ count: counts.get(key) }];
});
vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => queryRaw(strings, ...values) } }));

beforeEach(() => counts.clear());

describe("rateLimitBucketForClient", () => {
  it.each([
    ["2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::/64"],
    ["2001:DB8:0001:0002::1", "2001:db8:1:2::/64"],
    ["2001:db8:1:2::", "2001:db8:1:2::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["2001:db8:1::5:6:7:8", "2001:db8:1:0::/64"],
    ["::1", "0:0:0:0::/64"],
  ])("%s is counted as %s", (address, bucket) => {
    expect(rateLimitBucketForClient(address)).toBe(bucket);
  });

  it.each(["203.0.113.7", "198.51.100.1", "website-unattributed", "unresolved", ""])("%j is counted unchanged", (key) => {
    expect(rateLimitBucketForClient(key)).toBe(key);
  });

  it("an IPv4-mapped IPv6 address is the IPv4 client it stands for", () => {
    expect(rateLimitBucketForClient("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });
});

describe("the public limiter counts an IPv6 client by its /64", () => {
  const config = { windowMs: 60_000, maxAttempts: 3 };

  it("rotating addresses inside one /64 shares one allowance; another /64 and an IPv4 client are unaffected", async () => {
    const { checkPublicRateLimitForKey, peekRateLimitForKey } = await import("@/server/security/rate-limit");
    for (let i = 1; i <= 3; i++) expect((await checkPublicRateLimitForKey(`2001:db8:1:2::${i}`, "X", config)).allowed).toBe(true);
    expect((await checkPublicRateLimitForKey("2001:db8:1:2:ffff:ffff:ffff:ffff", "X", config)).allowed).toBe(false);
    expect((await peekRateLimitForKey("2001:db8:1:2::abcd", "X", config)).allowed).toBe(false);
    expect((await checkPublicRateLimitForKey("2001:db8:1:3::1", "X", config)).allowed).toBe(true);
    expect((await checkPublicRateLimitForKey("203.0.113.7", "X", config)).allowed).toBe(true);
    expect([...counts.keys()].map((k) => k.split("|")[0]).sort()).toEqual(["2001:db8:1:2::/64", "2001:db8:1:3::/64", "203.0.113.7"]);
  });
});
