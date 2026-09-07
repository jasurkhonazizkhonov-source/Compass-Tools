// Encrypts IP addresses at rest for the IpCapture "vault" table (see its
// schema doc comment in prisma/schema.prisma). Deliberately mirrors
// card-encryption.ts / gmail-token-encryption.ts's approach (AES-256-GCM
// via Node's built-in `crypto`, same audited primitive, same envelope
// shape) but is its own module with its own dedicated key — an IP address
// is an unrelated secret from a card PAN or an OAuth token and should
// never share a key with either.
//
// Unlike card-encryption.ts, there is no PCI-DSS-style external mandate
// that specifically prohibits application-managed AES keys for IP address
// storage — general data-protection practice (GDPR, CCPA, etc. all treat
// an IP address as personal data, not as the tightly-regulated "sensitive
// authentication data" category CVV falls under) is satisfied by strong
// at-rest encryption + tight RBAC + audit logging, all of which the
// calling actions (ip-vault.ts) already provide. So — unlike
// payment-vault.ts's ProductionVaultNotConfigured — this module does NOT
// refuse to run in production; it's a plain encrypt/decrypt pair, safe to
// use once IP_ENCRYPTION_KEY/IP_HASH_KEY are set to real generated keys.
// Same caveat as every sibling module still applies, though: a single
// symmetric key from an environment variable is not genuine enterprise key
// management (no HSM, no envelope encryption, no rotation) — replace with
// real KMS-backed encryption before this holds real customer data at
// meaningful scale.
import { createCipheriv, createDecipheriv, randomBytes, createHmac, timingSafeEqual } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const raw = process.env.IP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("IP vault encryption is not configured");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    // Deliberately generic — never echo the misconfigured value back.
    throw new Error("IP vault encryption is not configured correctly");
  }
  return key;
}

function getHashKey(): Buffer {
  // A SEPARATE key from IP_ENCRYPTION_KEY, by design — the hash key only
  // ever needs to produce a one-way blind index (never decrypts anything),
  // so it deliberately doesn't share a key with the reversible cipher.
  const raw = process.env.IP_HASH_KEY;
  if (!raw) {
    throw new Error("IP vault search index is not configured");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length < 16) {
    throw new Error("IP vault search index is not configured correctly");
  }
  return key;
}

/** Encrypts an IP address into a single base64-encoded blob: iv || authTag
 * || ciphertext. Never logs or echoes the plaintext input. */
export function encryptIp(ip: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(ip, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

/** Decrypts a blob produced by encryptIp(). Only ever call this from
 * within a dedicated, permission-checked, audited reveal/search action —
 * never from an ordinary list/display query. */
export function decryptIp(encoded: string): string {
  const key = getEncryptionKey();
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * Deterministic HMAC-SHA256 "blind index" of an IP address — the same
 * input always produces the same output, which is exactly what makes an
 * indexed `WHERE ipHash = ?` exact-match search possible without ever
 * decrypting (or storing in searchable form) the plaintext IP. This is a
 * one-way function: knowing the hash never lets you recover the IP (unlike
 * encryptedIp, which exists specifically so an authorized reveal CAN
 * recover it) — the two columns serve deliberately different purposes.
 */
export function hashIpForSearch(ip: string): string {
  return createHmac("sha256", getHashKey()).update(ip).digest("hex");
}

/** The network-prefix portion of an IP — first 3 octets for IPv4 (a /24),
 * first 3 hextets for IPv6 (a /48, the common ISP-allocation boundary) —
 * used only as input to hashSubnetForSearch() below, never stored or
 * returned on its own. */
function subnetPrefix(ip: string, version: "v4" | "v6"): string {
  const parts = ip.split(version === "v4" ? "." : ":");
  return parts.slice(0, 3).join(version === "v4" ? "." : ":");
}

/**
 * Deterministic HMAC-SHA256 blind index of just an IP's network-prefix
 * (see subnetPrefix above) — one level coarser than hashIpForSearch,
 * enabling "how many distinct signers used the same subnet" fraud queries
 * (src/server/security/ip-risk.ts) without ever decrypting a row or
 * exposing the network prefix in queryable plaintext. A `"subnet:"` input
 * prefix keeps this HMAC's input space distinguishable from
 * hashIpForSearch's, purely as defense-in-depth against an (extremely
 * unlikely) prefix/full-IP string collision.
 */
export function hashSubnetForSearch(ip: string, version: "v4" | "v6"): string {
  return createHmac("sha256", getHashKey()).update(`subnet:${subnetPrefix(ip, version)}`).digest("hex");
}

/** Constant-time comparison for a caller-provided hash against a stored
 * one, avoiding a timing side-channel on an otherwise-indexed lookup. Not
 * currently required (Postgres does the equality match, not app code) but
 * exported for any future in-app comparison need. */
export function ipHashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Generates a fresh 32-byte key, base64-encoded, suitable for
 * IP_ENCRYPTION_KEY or IP_HASH_KEY in a local/dev .env file. Never call
 * this in a request-handling code path — it's a one-off setup utility. */
export function generateDevKey(): string {
  return randomBytes(32).toString("base64");
}

/** First octet (IPv4) or first hextet (IPv6) followed by a masked
 * placeholder — e.g. "203.x.x.x" / "2001:x:x:x:x:x:x:x" — shown to any
 * authenticated staff account who can see the booking at all, even
 * without the stricter Reveal permission. Deliberately reveals almost
 * nothing (a /8 or /16 block covers a huge address range) while still
 * giving non-privileged viewers SOME visual confirmation an IP was
 * captured, rather than either the full value or a bare "Restricted" with
 * zero information.
 */
export function maskIp(ip: string, version: "v4" | "v6"): string {
  if (version === "v4") {
    const first = ip.split(".")[0] ?? "x";
    return `${first}.x.x.x`;
  }
  const first = ip.split(":")[0] || "x";
  return `${first}:x:x:x:x:x:x:x`;
}
