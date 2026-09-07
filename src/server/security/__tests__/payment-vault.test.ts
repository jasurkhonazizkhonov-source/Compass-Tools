import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("../card-encryption", () => ({
  encryptPan: vi.fn((pan: string) => `ENC:${pan}`),
  decryptPan: vi.fn((encoded: string) => encoded.replace(/^ENC:/, "")),
}));

describe("getPaymentVault", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("in development, returns a vault that round-trips through the underlying encryption module", async () => {
    vi.stubEnv("APP_ENV", "development");
    const { getPaymentVault } = await import("../payment-vault");
    const vault = getPaymentVault();
    const reference = await vault.store("4111111111111111");
    expect(reference).toBe("ENC:4111111111111111");
    const revealed = await vault.reveal(reference);
    expect(revealed).toBe("4111111111111111");
  });

  it("in production, store() throws rather than silently using the development vault", async () => {
    vi.stubEnv("APP_ENV", "production");
    const { getPaymentVault } = await import("../payment-vault");
    const vault = getPaymentVault();
    await expect(vault.store("4111111111111111")).rejects.toThrow(/No production-grade card vault/);
  });

  it("in production, reveal() also throws rather than silently using the development vault", async () => {
    vi.stubEnv("APP_ENV", "production");
    const { getPaymentVault } = await import("../payment-vault");
    const vault = getPaymentVault();
    await expect(vault.reveal("ENC:4111111111111111")).rejects.toThrow(/No production-grade card vault/);
  });

  it("production fail-closed applies even when NODE_ENV=production with no explicit APP_ENV", async () => {
    vi.stubEnv("APP_ENV", "");
    vi.stubEnv("NODE_ENV", "production");
    const { getPaymentVault } = await import("../payment-vault");
    const vault = getPaymentVault();
    await expect(vault.store("4111111111111111")).rejects.toThrow();
  });
});
