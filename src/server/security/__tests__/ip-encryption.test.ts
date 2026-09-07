import { describe, it, expect, beforeEach, vi } from "vitest";

// Fresh 32-byte dev keys, distinct from any real .env value — generated
// once for this test file only, matching card-encryption.test.ts's own
// convention (never assert against the real .env-configured key).
const ENCRYPTION_KEY = "YgfNgrkVYRowXtQi3KJgD2vQOgze0r12K6kTBWUQTQI=";
const HASH_KEY = "oYQZyGTNHuPCyHRql2/SVOgH3IJHTeGSchk4rLRMjzg=";

beforeEach(() => {
  vi.stubEnv("IP_ENCRYPTION_KEY", ENCRYPTION_KEY);
  vi.stubEnv("IP_HASH_KEY", HASH_KEY);
});

describe("ip-encryption — encryptIp/decryptIp", () => {
  it("round-trips an IPv4 address", async () => {
    const { encryptIp, decryptIp } = await import("../ip-encryption");
    const blob = encryptIp("203.0.113.42");
    expect(decryptIp(blob)).toBe("203.0.113.42");
  });

  it("round-trips an IPv6 address", async () => {
    const { encryptIp, decryptIp } = await import("../ip-encryption");
    const blob = encryptIp("2001:0db8:85a3:0000:0000:8a2e:0370:7334");
    expect(decryptIp(blob)).toBe("2001:0db8:85a3:0000:0000:8a2e:0370:7334");
  });

  it("never embeds the plaintext IP in the ciphertext blob", async () => {
    const { encryptIp } = await import("../ip-encryption");
    const blob = encryptIp("203.0.113.42");
    expect(blob).not.toContain("203.0.113.42");
  });

  it("produces a different ciphertext each time (random IV) even for the same input", async () => {
    const { encryptIp } = await import("../ip-encryption");
    const a = encryptIp("203.0.113.42");
    const b = encryptIp("203.0.113.42");
    expect(a).not.toBe(b);
  });

  it("throws (never silently returns garbage) when IP_ENCRYPTION_KEY is unset", async () => {
    vi.unstubAllEnvs();
    const { encryptIp } = await import("../ip-encryption");
    expect(() => encryptIp("203.0.113.42")).toThrow(/not configured/i);
  });

  it("throws when IP_ENCRYPTION_KEY is not a valid 32-byte base64 key", async () => {
    vi.stubEnv("IP_ENCRYPTION_KEY", "not-valid-base64-key");
    const { encryptIp } = await import("../ip-encryption");
    expect(() => encryptIp("203.0.113.42")).toThrow(/not configured correctly/i);
  });
});

describe("ip-encryption — hashIpForSearch (blind index)", () => {
  it("is deterministic — the same IP always hashes to the same value", async () => {
    const { hashIpForSearch } = await import("../ip-encryption");
    expect(hashIpForSearch("203.0.113.42")).toBe(hashIpForSearch("203.0.113.42"));
  });

  it("produces different hashes for different IPs", async () => {
    const { hashIpForSearch } = await import("../ip-encryption");
    expect(hashIpForSearch("203.0.113.42")).not.toBe(hashIpForSearch("203.0.113.43"));
  });

  it("never reveals the plaintext IP in its output", async () => {
    const { hashIpForSearch } = await import("../ip-encryption");
    expect(hashIpForSearch("203.0.113.42")).not.toContain("203.0.113.42");
  });

  it("uses a SEPARATE key from encryption — changing only IP_HASH_KEY changes the hash but not encryptIp's key requirement", async () => {
    const { hashIpForSearch } = await import("../ip-encryption");
    const first = hashIpForSearch("203.0.113.42");
    vi.stubEnv("IP_HASH_KEY", "b25lLXR3by10aHJlZS1mb3VyLWZpdmUtc2l4LXNldmVuLTg=");
    const second = hashIpForSearch("203.0.113.42");
    expect(first).not.toBe(second);
  });
});

describe("ip-encryption — hashSubnetForSearch (subnet blind index)", () => {
  it("is deterministic for two IPs sharing a /24 (IPv4)", async () => {
    const { hashSubnetForSearch } = await import("../ip-encryption");
    expect(hashSubnetForSearch("203.0.113.42", "v4")).toBe(hashSubnetForSearch("203.0.113.99", "v4"));
  });

  it("differs across two IPs NOT sharing a /24 (IPv4)", async () => {
    const { hashSubnetForSearch } = await import("../ip-encryption");
    expect(hashSubnetForSearch("203.0.113.42", "v4")).not.toBe(hashSubnetForSearch("203.0.114.42", "v4"));
  });

  it("is deterministic for two IPv6 addresses sharing their first 3 hextets", async () => {
    const { hashSubnetForSearch } = await import("../ip-encryption");
    expect(hashSubnetForSearch("2001:0db8:85a3:0000:0000:8a2e:0370:7334", "v6")).toBe(hashSubnetForSearch("2001:0db8:85a3:1111:2222:3333:4444:5555", "v6"));
  });

  it("differs from the exact-IP hash (hashIpForSearch) for the same address — distinguishable input spaces", async () => {
    const { hashSubnetForSearch, hashIpForSearch } = await import("../ip-encryption");
    expect(hashSubnetForSearch("203.0.113.42", "v4")).not.toBe(hashIpForSearch("203.0.113.42"));
  });

  it("never reveals the plaintext network prefix in its output", async () => {
    const { hashSubnetForSearch } = await import("../ip-encryption");
    expect(hashSubnetForSearch("203.0.113.42", "v4")).not.toContain("203.0.113");
  });
});

describe("ip-encryption — maskIp", () => {
  it("masks an IPv4 address to only its first octet", async () => {
    const { maskIp } = await import("../ip-encryption");
    expect(maskIp("203.0.113.42", "v4")).toBe("203.x.x.x");
  });

  it("masks an IPv6 address to only its first hextet", async () => {
    const { maskIp } = await import("../ip-encryption");
    expect(maskIp("2001:0db8:85a3:0000:0000:8a2e:0370:7334", "v6")).toBe("2001:x:x:x:x:x:x:x");
  });

  it("never leaves the full address recoverable from the masked form", async () => {
    const { maskIp } = await import("../ip-encryption");
    const masked = maskIp("203.0.113.42", "v4");
    expect(masked).not.toContain("113.42");
  });
});
