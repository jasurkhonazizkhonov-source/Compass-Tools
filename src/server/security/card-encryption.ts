// ═══════════════════════════════════════════════════════════════════════
// ⚠ DEV/DEMO-ONLY ENCRYPTION — NOT PCI DSS-APPROPRIATE KEY MANAGEMENT.
//
// This module encrypts the PAN with a single symmetric key read from an
// environment variable. That is NOT genuine key management: there is no
// HSM, no envelope encryption, no key rotation, no dual control / split
// knowledge, and no separation between "who can read the ciphertext" and
// "who can access the key" (both live in the same application process).
// A real PCI DSS-appropriate deployment would use a KMS (AWS KMS/GCP
// KMS/Azure Key Vault, ideally HSM-backed) for envelope encryption — this
// app never talks to one, because none is provisioned for this project.
//
// This uses Node's built-in `crypto` module (a standard, audited primitive
// — AES-256-GCM via OpenSSL) rather than any custom/invented cryptography,
// which is the one thing this module does follow correctly. Everything
// else about "where the key lives and who can use it" is the placeholder
// part. Do not point this at real customer card data before replacing the
// key source with genuine KMS/HSM-backed management, or — more simply —
// replacing this whole module with a call to a dedicated PCI-compliant
// card-vault provider (Basis Theory, VGS, Skyflow, etc.) instead of
// encrypting/storing the PAN in this application's own database at all.
//
// Nothing in the CRM's booking/reveal code calls encryptPan/decryptPan
// directly anymore — they're wrapped by payment-vault.ts's
// DevelopmentEncryptedVault behind a PaymentVault interface, so swapping
// this module out for a real KMS/HSM or vault provider later only means
// changing getPaymentVault()'s implementation choice, not the CRM's
// booking form, reveal UI, or permission model. See payment-vault.ts.
// ═══════════════════════════════════════════════════════════════════════
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // bytes, standard for GCM
const AUTH_TAG_LENGTH = 16; // bytes

function getKey(): Buffer {
  const raw = process.env.CARD_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("Card encryption is not configured");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    // Deliberately generic — never echo the misconfigured value back.
    throw new Error("Card encryption is not configured correctly");
  }
  return key;
}

/** Encrypts a PAN (or any short sensitive string) into a single
 * base64-encoded blob: iv || authTag || ciphertext. Never logs or echoes
 * the plaintext input. */
export function encryptPan(pan: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(pan, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

/** Decrypts a blob produced by encryptPan(). Only ever call this from
 * within the dedicated, permission-checked, audited reveal action — never
 * from an ordinary query/display path. */
export function decryptPan(encoded: string): string {
  const key = getKey();
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

/** Generates a fresh 32-byte key, base64-encoded, suitable for
 * CARD_ENCRYPTION_KEY in a local/dev .env file. Never call this in a
 * request-handling code path — it's a one-off setup utility, run manually
 * (e.g. `node -e "console.log(require('./card-encryption').generateDevKey())"`)
 * when provisioning a new environment. */
export function generateDevKey(): string {
  return randomBytes(32).toString("base64");
}
