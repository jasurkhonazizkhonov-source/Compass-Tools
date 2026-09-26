import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createCipheriv, randomBytes } from "crypto";

// Proves — with the real code — what a production deployment that ONLY has the
// original CARD_ENCRYPTION_KEY needs in order to keep every existing card
// decryptable, and which "migrations" of that variable are safe or unsafe.
// Only test keys and the official test card number are used.

const KEY = Buffer.alloc(32, 41).toString("base64"); // stands in for the existing production key
const K2 = Buffer.alloc(32, 42).toString("base64");
const PAN = "4242424242424242";
const PHRASE = "application-encryption-risk-accepted";

/** A card exactly as the ORIGINAL implementation stored it: base64(iv ‖ tag ‖ ciphertext), no key id, no AAD. */
function legacyCard(keyB64: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), iv);
  const enc = Buffer.concat([c.update(PAN, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

function setEnv(env: Record<string, string>) {
  for (const k of ["APP_ENV", "NODE_ENV", "VERCEL_ENV", "CARD_ENCRYPTION_KEY", "CARD_ENCRYPTION_KEYS", "CARD_ENCRYPTION_KEY_ID", "CARD_VAULT_MODE"]) vi.stubEnv(k, env[k] ?? "");
}
const mods = async () => {
  vi.resetModules();
  return {
    enc: await import("../card-encryption"),
    status: await import("../card-vault-status"),
    vault: await import("../payment-vault"),
  };
};
beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllEnvs());

const PROD_TODAY = { APP_ENV: "production", NODE_ENV: "production", CARD_ENCRYPTION_KEY: KEY };

describe("the current production configuration (APP_ENV=production + CARD_ENCRYPTION_KEY only)", () => {
  it("is CLOSED without CARD_VAULT_MODE, and reports 'disabled' (not misconfigured)", async () => {
    setEnv(PROD_TODAY);
    const { status } = await mods();
    expect(status.getCardVaultStatus()).toMatchObject({ storageAvailable: false, state: "disabled", environment: "production", key: "configured", keyVersion: "v1", blockedBy: "vault_not_enabled" });
  });

  it("adding ONLY CARD_VAULT_MODE opens it: no ring, no key id, no re-encryption — the existing key is key id v1", async () => {
    setEnv({ ...PROD_TODAY, CARD_VAULT_MODE: PHRASE });
    const { status, enc, vault } = await mods();
    expect(status.getCardVaultStatus()).toMatchObject({ storageAvailable: true, state: "available_risk_accepted", keyVersion: "v1", keyIds: ["v1"], problems: [] });
    // an existing (original-format) card still decrypts, for whatever row it is in
    const existing = legacyCard(KEY);
    expect(enc.decryptPan(existing, "any-existing-row-id")).toBe(PAN);
    expect(await vault.getPaymentVault().reveal(existing, "any-existing-row-id")).toBe(PAN);
    // new cards are stored as versioned envelopes under v1 and round-trip
    const fresh = await vault.getPaymentVault().store(PAN, "row-new");
    expect(fresh).toMatch(/^cv2\.v1\./);
    expect(await vault.getPaymentVault().reveal(fresh, "row-new")).toBe(PAN);
  });

  it("tolerates whitespace around the pasted mode value, but no other spelling", async () => {
    for (const [value, open] of [[`${PHRASE}\n`, true], [` ${PHRASE} `, true], ["Application-Encryption-Risk-Accepted", false], ["true", false], ["staging", false], ["", false]] as const) {
      setEnv({ ...PROD_TODAY, CARD_VAULT_MODE: value });
      const { status } = await mods();
      expect(status.getCardVaultStatus().storageAvailable, JSON.stringify(value)).toBe(open);
    }
  });

  it("APP_ENV=production with the mode set stays production; the only accepted CARD_VAULT_MODE value is the phrase", async () => {
    const { status } = await mods();
    expect(status.CARD_VAULT_MODE_ACCEPTED).toBe(PHRASE);
    setEnv({ ...PROD_TODAY, CARD_VAULT_MODE: PHRASE });
    expect((await mods()).status.getCardVaultStatus().environment).toBe("production");
  });
});

describe("migrating CARD_ENCRYPTION_KEY into the key ring — what is safe and what loses cards", () => {
  it("SAFE: keep CARD_ENCRYPTION_KEY and add a new key for future cards (rotation start): old cards still read, new cards use the new key", async () => {
    setEnv({ ...PROD_TODAY, CARD_VAULT_MODE: PHRASE, CARD_ENCRYPTION_KEYS: `k2:${K2}`, CARD_ENCRYPTION_KEY_ID: "k2" });
    const { enc } = await mods();
    expect(enc.decryptPan(legacyCard(KEY), "row-1")).toBe(PAN);
    expect(enc.inspectReference(enc.encryptPan(PAN, "row-2"))).toEqual({ format: "envelope", keyId: "k2" });
  });

  it("SAFE: the same key listed in the ring under id v1 (legacy variable kept or removed) reads legacy AND v1-envelope cards", async () => {
    setEnv({ ...PROD_TODAY, CARD_VAULT_MODE: PHRASE });
    const beforeRing = (await mods()).enc.encryptPan(PAN, "row-a"); // a card stored while only the legacy variable existed
    for (const legacyVar of [KEY, ""]) {
      setEnv({ ...PROD_TODAY, CARD_ENCRYPTION_KEY: legacyVar, CARD_VAULT_MODE: PHRASE, CARD_ENCRYPTION_KEYS: `v1:${KEY}`, CARD_ENCRYPTION_KEY_ID: "v1" });
      const { enc, status } = await mods();
      expect(status.getCardVaultStatus(), `legacy var ${legacyVar ? "kept" : "removed"}`).toMatchObject({ storageAvailable: true, keyVersion: "v1", problems: [] });
      expect(enc.decryptPan(legacyCard(KEY), "row-legacy")).toBe(PAN);
      expect(enc.decryptPan(beforeRing, "row-a")).toBe(PAN);
    }
  });

  it("UNSAFE (proven): moving the key into the ring under any id OTHER than v1 and removing CARD_ENCRYPTION_KEY strands every existing card", async () => {
    setEnv({ ...PROD_TODAY, CARD_VAULT_MODE: PHRASE });
    const stored = (await mods()).enc.encryptPan(PAN, "row-a"); // cv2.v1.*
    setEnv({ ...PROD_TODAY, CARD_ENCRYPTION_KEY: "", CARD_VAULT_MODE: PHRASE, CARD_ENCRYPTION_KEYS: `prod1:${KEY}`, CARD_ENCRYPTION_KEY_ID: "prod1" });
    const { enc } = await mods();
    expect(() => enc.decryptPan(legacyCard(KEY), "row-1")).toThrowError(/KEY_UNKNOWN/);
    expect(() => enc.decryptPan(stored, "row-a")).toThrowError(/KEY_UNKNOWN/);
  });

  it("REJECTED: the same id defined twice with different keys is invalid (it would change what existing cards decrypt with)", async () => {
    setEnv({ ...PROD_TODAY, CARD_VAULT_MODE: PHRASE, CARD_ENCRYPTION_KEYS: `v1:${K2}`, CARD_ENCRYPTION_KEY_ID: "v1" });
    const { status } = await mods();
    expect(status.getCardVaultStatus()).toMatchObject({ storageAvailable: false, state: "misconfigured", key: "invalid" });
    expect(status.getCardVaultStatus().problems.join(" ")).toMatch(/twice with different keys/);
  });

  it("REJECTED: renaming the old variable to CARD_ENCRYPTION_KEYS as a bare key is not the format (it must be id:key) — the ring is invalid and the vault closes", async () => {
    setEnv({ ...PROD_TODAY, CARD_ENCRYPTION_KEY: "", CARD_VAULT_MODE: PHRASE, CARD_ENCRYPTION_KEYS: KEY, CARD_ENCRYPTION_KEY_ID: "v1" });
    const { status } = await mods();
    expect(status.getCardVaultStatus()).toMatchObject({ storageAvailable: false, state: "misconfigured" });
  });

  it("the key id is not secret, is 1–12 letters/digits, and is never generated: v1 is the legacy id and the default", async () => {
    setEnv({ ...PROD_TODAY, CARD_VAULT_MODE: PHRASE });
    const { status } = await mods();
    expect(JSON.stringify(status.getCardVaultStatus())).not.toContain(KEY);
    for (const bad of ["", "has space", "a-b", "toolongidentifier1", "é"]) {
      setEnv({ ...PROD_TODAY, CARD_VAULT_MODE: PHRASE, CARD_ENCRYPTION_KEYS: `${bad}:${K2}`, CARD_ENCRYPTION_KEY_ID: "k2" });
      expect((await mods()).status.getCardVaultStatus().state, bad).toBe("misconfigured");
    }
  });
});
