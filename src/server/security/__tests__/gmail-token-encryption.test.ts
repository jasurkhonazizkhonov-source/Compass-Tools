import { describe, it, expect, beforeEach, afterEach } from "vitest";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("encryptRefreshToken / decryptRefreshToken — real AES-256-GCM round trip", () => {
  it("round-trips a refresh token through encryption and decryption unchanged", async () => {
    process.env.GMAIL_TOKEN_ENCRYPTION_KEY = "yC0m9NX6JVQYBRGiDGySigB5L6WXpA38PceXOZUXAP8=";
    const { encryptRefreshToken, decryptRefreshToken } = await import("../gmail-token-encryption");

    const token = "1//0abcDEFghijKLMNOP-fake-refresh-token";
    const encrypted = encryptRefreshToken(token);
    expect(encrypted).not.toBe(token);
    expect(decryptRefreshToken(encrypted)).toBe(token);
  });

  it("two encryptions of the identical token produce different ciphertext (random IV per call)", async () => {
    process.env.GMAIL_TOKEN_ENCRYPTION_KEY = "yC0m9NX6JVQYBRGiDGySigB5L6WXpA38PceXOZUXAP8=";
    const { encryptRefreshToken } = await import("../gmail-token-encryption");

    const a = encryptRefreshToken("same-token");
    const b = encryptRefreshToken("same-token");
    expect(a).not.toBe(b);
  });

  it("throws a generic error when the encryption key is unset — never silently no-ops", async () => {
    delete process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
    const { encryptRefreshToken } = await import("../gmail-token-encryption");
    expect(() => encryptRefreshToken("token")).toThrow(/not configured/);
  });

  it("throws a generic error (never echoing the misconfigured value) when the key is the wrong length", async () => {
    process.env.GMAIL_TOKEN_ENCRYPTION_KEY = "dG9vLXNob3J0";
    const { encryptRefreshToken } = await import("../gmail-token-encryption");
    expect(() => encryptRefreshToken("token")).toThrow(/not configured correctly/);
  });

  it("decryption fails closed (throws) on tampered ciphertext rather than returning garbage", async () => {
    process.env.GMAIL_TOKEN_ENCRYPTION_KEY = "yC0m9NX6JVQYBRGiDGySigB5L6WXpA38PceXOZUXAP8=";
    const { encryptRefreshToken, decryptRefreshToken } = await import("../gmail-token-encryption");

    const encrypted = encryptRefreshToken("a-real-token");
    const tampered = encrypted.slice(0, -4) + "abcd";
    expect(() => decryptRefreshToken(tampered)).toThrow();
  });
});

describe("generateDevKey", () => {
  it("generates a 32-byte key that round-trips through encrypt/decrypt when used", async () => {
    const { generateDevKey, encryptRefreshToken, decryptRefreshToken } = await import("../gmail-token-encryption");
    process.env.GMAIL_TOKEN_ENCRYPTION_KEY = generateDevKey();
    const encrypted = encryptRefreshToken("token-value");
    expect(decryptRefreshToken(encrypted)).toBe("token-value");
  });
});
