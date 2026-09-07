// Encrypts Gmail OAuth refresh tokens at rest. Deliberately mirrors
// card-encryption.ts's approach (AES-256-GCM via Node's built-in `crypto`,
// same audited primitive, same envelope shape) but is its own module with
// its own dedicated key — a refresh token and a card PAN are unrelated
// secrets and should never share a key. This is a plain encrypt/decrypt
// pair, not a PaymentVault-style interface: unlike a PAN, a Gmail refresh
// token is never revealed to a user or shown in any UI — it's decrypted
// only internally, at send time, by gmail-send.ts. There is nothing to gate
// behind a reveal permission.
//
// Same dev/demo-only caveat as card-encryption.ts: a single symmetric key
// from an environment variable is not genuine key management (no HSM, no
// envelope encryption, no rotation). Replace with real KMS-backed
// encryption before handling real user OAuth tokens in production.
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const raw = process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("Gmail token encryption is not configured");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("Gmail token encryption is not configured correctly");
  }
  return key;
}

/** Encrypts a Gmail refresh token into a single base64 blob: iv || authTag
 * || ciphertext. Never logs or echoes the plaintext input. */
export function encryptRefreshToken(token: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

/** Decrypts a blob produced by encryptRefreshToken(). Only ever call this
 * from gmail-send.ts's internal token-refresh step — never from a query or
 * display path; the decrypted token must never reach a client response. */
export function decryptRefreshToken(encoded: string): string {
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
 * GMAIL_TOKEN_ENCRYPTION_KEY in a local/dev .env file. One-off setup
 * utility — never call this in a request-handling code path. */
export function generateDevKey(): string {
  return randomBytes(32).toString("base64");
}
