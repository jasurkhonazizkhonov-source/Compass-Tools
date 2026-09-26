import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { CARD_VAULT_MODE_ACCEPTED } from "../card-vault-status";

// The vault against the REAL encryption module (no mocks): what matters here is
// which environments open it, and that it fails closed everywhere else.
const KEY = Buffer.alloc(32, 11).toString("base64");
const PAN = "4242424242424242"; // the card networks' published test number

beforeEach(() => {
  vi.stubEnv("CARD_ENCRYPTION_KEY", KEY);
  vi.stubEnv("CARD_ENCRYPTION_KEYS", "");
  vi.stubEnv("CARD_ENCRYPTION_KEY_ID", "");
  vi.stubEnv("CARD_VAULT_MODE", "");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("APP_ENV", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("getPaymentVault", () => {
  it("in local development/tests (no explicit mode needed) round-trips a card bound to its row id", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { getPaymentVault } = await import("../payment-vault");
    const vault = getPaymentVault();
    const reference = await vault.store(PAN, "row-1");
    expect(reference).toMatch(/^cv2\.v1\./);
    expect(reference).not.toContain(PAN);
    expect(await vault.reveal(reference, "row-1")).toBe(PAN);
  });

  it("a production build stays CLOSED without the explicit vault mode — store() and reveal() throw a fixed-code error", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { getPaymentVault } = await import("../payment-vault");
    const vault = getPaymentVault();
    await expect(vault.store(PAN, "row-1")).rejects.toMatchObject({ code: "VAULT_UNAVAILABLE" });
    await expect(vault.reveal("cv2.v1.AAAA", "row-1")).rejects.toMatchObject({ code: "VAULT_UNAVAILABLE" });
  });

  it("APP_ENV=staging (or development/test/true) does NOT open a production build's vault", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const label of ["staging", "development", "test", "true", "1", "preview"]) {
      vi.stubEnv("APP_ENV", label);
      vi.resetModules();
      const { getPaymentVault } = await import("../payment-vault");
      await expect(getPaymentVault().store(PAN, "row-1"), `APP_ENV=${label}`).rejects.toMatchObject({ code: "VAULT_UNAVAILABLE" });
    }
  });

  it("a wrong / generic CARD_VAULT_MODE value does not open production; only the exact acceptance phrase does", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const mode of ["true", "1", "enabled", "staging", "application-encryption", "APPLICATION-ENCRYPTION-RISK-ACCEPTED"]) {
      vi.stubEnv("CARD_VAULT_MODE", mode);
      vi.resetModules();
      const { getPaymentVault } = await import("../payment-vault");
      await expect(getPaymentVault().store(PAN, "row-1"), mode).rejects.toMatchObject({ code: "VAULT_UNAVAILABLE" });
    }
    vi.stubEnv("CARD_VAULT_MODE", CARD_VAULT_MODE_ACCEPTED);
    vi.resetModules();
    const { getPaymentVault } = await import("../payment-vault");
    const ref = await getPaymentVault().store(PAN, "row-1");
    expect(await getPaymentVault().reveal(ref, "row-1")).toBe(PAN);
  });

  it("the explicit mode alone is not enough: a production build with no/invalid key ring is still closed", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CARD_VAULT_MODE", CARD_VAULT_MODE_ACCEPTED);
    vi.stubEnv("CARD_ENCRYPTION_KEY", "");
    let mod = await import("../payment-vault");
    await expect(mod.getPaymentVault().store(PAN, "row-1")).rejects.toMatchObject({ code: "VAULT_UNAVAILABLE" });
    vi.stubEnv("CARD_ENCRYPTION_KEY", "not-a-key");
    vi.resetModules();
    mod = await import("../payment-vault");
    await expect(mod.getPaymentVault().store(PAN, "row-1")).rejects.toMatchObject({ code: "VAULT_UNAVAILABLE" });
  });

  it("a Vercel production/preview deployment is production-class even with APP_ENV=staging and NODE_ENV=development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_ENV", "staging");
    for (const vercelEnv of ["production", "preview"]) {
      vi.stubEnv("VERCEL_ENV", vercelEnv);
      vi.resetModules();
      const { getPaymentVault } = await import("../payment-vault");
      await expect(getPaymentVault().store(PAN, "row-1"), vercelEnv).rejects.toMatchObject({ code: "VAULT_UNAVAILABLE" });
    }
  });

  it("APP_ENV=production closes the vault even locally (it can only tighten)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_ENV", "production");
    const { getPaymentVault } = await import("../payment-vault");
    await expect(getPaymentVault().store(PAN, "row-1")).rejects.toMatchObject({ code: "VAULT_UNAVAILABLE" });
  });
});
