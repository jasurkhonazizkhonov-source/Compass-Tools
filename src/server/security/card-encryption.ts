// ═══════════════════════════════════════════════════════════════════════
// APPLICATION-LEVEL CARD ENCRYPTION — NOT PCI DSS-GRADE KEY MANAGEMENT.
//
// What this module does correctly:
//   • Authenticated encryption: AES-256-GCM (Node's OpenSSL) with a fresh
//     random 96-bit IV for every call, the 128-bit tag pinned and verified
//     before any plaintext is released.
//   • A versioned envelope: `cv2.<keyId>.<base64url(iv ‖ tag ‖ ciphertext)>`.
//     The key id says which ring key encrypted it (rotation), and the row's id
//     is bound in as additional authenticated data, so a ciphertext copied into
//     a different row fails authentication instead of decrypting there.
//   • Fail closed: a missing/invalid ring, an unknown key id, a malformed or
//     tampered blob, or a purged card all throw a CardVaultError carrying a
//     fixed code — never a message that could embed a value, never a fallback
//     to plaintext.
//   • Legacy compatibility: blobs written before envelopes existed
//     (`base64(iv ‖ tag ‖ ciphertext)`, no AAD, key "v1" = CARD_ENCRYPTION_KEY)
//     still decrypt, and are re-encrypted by the rotation script.
//
// What it is NOT: there is no HSM/KMS, no envelope encryption, no dual control
// and the key lives in the same process as the ciphertext's reader. Anyone who
// can read both the database and the application's environment can decrypt
// every card. Treat the ring as the most sensitive secret you own.
//
// Nothing outside payment-vault.ts (and the key-rotation module) should import
// this file.
// ═══════════════════════════════════════════════════════════════════════
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { getCurrentKey, getKeyBuffer, getKeyringStatus, LEGACY_KEY_ID } from "./card-keyring";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ENVELOPE_PREFIX = "cv2.";
/** Stored in place of ciphertext once a card has been purged. */
export const PURGED_REFERENCE = "cv2.purged";

export type CardVaultErrorCode =
  | "NOT_CONFIGURED"
  | "KEY_UNKNOWN"
  | "MALFORMED"
  | "AUTH_FAILED"
  | "PURGED"
  | "VAULT_UNAVAILABLE"
  | "INVALID_INPUT";

/** Carries only a fixed code — never card data, key material or an inner message. */
export class CardVaultError extends Error {
  constructor(readonly code: CardVaultErrorCode) {
    super(`Card vault error: ${code}`);
    this.name = "CardVaultError";
  }
}

function aadFor(recordId: string): Buffer {
  return Buffer.from(`compass-card-vault|cv2|${recordId}`, "utf8");
}

export type CardReference = { format: "envelope"; keyId: string } | { format: "legacy" } | { format: "purged" };

/** Classifies a stored reference without decrypting it (used by rotation and checks). */
export function inspectReference(reference: string): CardReference | null {
  if (reference === PURGED_REFERENCE) return { format: "purged" };
  if (reference.startsWith(ENVELOPE_PREFIX)) {
    const parts = reference.split(".");
    if (parts.length !== 3 || !/^[A-Za-z0-9]{1,12}$/.test(parts[1]) || !parts[2]) return null;
    return { format: "envelope", keyId: parts[1] };
  }
  return /^[A-Za-z0-9+/]+={0,2}$/.test(reference) ? { format: "legacy" } : null;
}

/**
 * Encrypts a PAN (digits only) for the row `recordId` under the ring's
 * current key. Never logs or echoes the input.
 */
export function encryptPan(pan: string, recordId: string): string {
  if (!/^\d{12,19}$/.test(pan) || !recordId) throw new CardVaultError("INVALID_INPUT");
  const current = getCurrentKey();
  if (!current) throw new CardVaultError("NOT_CONFIGURED");
  try {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, current.key, iv, { authTagLength: AUTH_TAG_LENGTH });
    cipher.setAAD(aadFor(recordId));
    const encrypted = Buffer.concat([cipher.update(pan, "utf8"), cipher.final()]);
    const payload = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
    return `${ENVELOPE_PREFIX}${current.id}.${payload}`;
  } finally {
    current.key.fill(0);
  }
}

/**
 * Decrypts a stored reference. Only ever call this from the dedicated,
 * permission-checked, audited Reveal action or the rotation module.
 */
export function decryptPan(reference: string, recordId: string): string {
  if (!recordId) throw new CardVaultError("INVALID_INPUT");
  const info = inspectReference(reference);
  if (!info) throw new CardVaultError("MALFORMED");
  if (info.format === "purged") throw new CardVaultError("PURGED");

  const keyId = info.format === "envelope" ? info.keyId : LEGACY_KEY_ID;
  if (getKeyringStatus().state !== "configured") throw new CardVaultError("NOT_CONFIGURED");
  const key = getKeyBuffer(keyId);
  if (!key) throw new CardVaultError("KEY_UNKNOWN");
  try {
    const raw = Buffer.from(info.format === "envelope" ? reference.split(".")[2] : reference, info.format === "envelope" ? "base64url" : "base64");
    if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) throw new CardVaultError("MALFORMED");
    const iv = raw.subarray(0, IV_LENGTH);
    const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    if (info.format === "envelope") decipher.setAAD(aadFor(recordId));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (err) {
    if (err instanceof CardVaultError) throw err;
    // Wrong key, modified ciphertext, wrong row (AAD) or a corrupt blob: all
    // indistinguishable on purpose, and none of them leak an OpenSSL message.
    throw new CardVaultError("AUTH_FAILED");
  } finally {
    key.fill(0);
  }
}

/** Generates a fresh 32-byte key (base64) to paste into the host's secret store — a one-off, manual setup helper. */
export function generateKey(): string {
  return randomBytes(32).toString("base64");
}
