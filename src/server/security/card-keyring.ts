// Versioned key ring for the card vault. Pure environment parsing — no
// database, and no key material ever leaves this module except as a Buffer
// handed to card-encryption.ts (which zeroes it after use). Nothing here
// generates a key: a key that is regenerated per deployment would make every
// stored card undecryptable, so keys are ONLY ever supplied by the owner.
//
// Configuration (all secrets — set them in the host's secret store, never Git):
//
//   CARD_ENCRYPTION_KEY        The original single key. Still supported: it is
//                              key id "v1" and is the ONLY key that can decrypt
//                              cards stored before versioned envelopes existed.
//   CARD_ENCRYPTION_KEYS       Optional ring: "id:base64key,id:base64key". ids are
//                              1–12 letters/digits. Each key is base64, 32 bytes.
//   CARD_ENCRYPTION_KEY_ID     The id used to ENCRYPT new cards. Required when
//                              CARD_ENCRYPTION_KEYS is set; otherwise defaults to
//                              "v1" (the legacy key).
//
// Rotation (docs/CARD_VAULT_SECURITY.md): add the new key to the ring, point
// CARD_ENCRYPTION_KEY_ID at it, keep every older key in the ring, deploy, run
// `npm run cards:rotate`, and only retire an old key once no stored row — and
// no backup you may still restore — uses it.

export const LEGACY_KEY_ID = "v1";
const KEY_ID = /^[A-Za-z0-9]{1,12}$/;

export type KeyringState = "configured" | "missing" | "invalid";

export type KeyringStatus = {
  state: KeyringState;
  /** Id used for new encryptions, when the ring is usable. */
  currentKeyId: string | null;
  /** Ids (never key material) present in the ring. */
  keyIds: string[];
  /** Human-safe reasons (key ids and variable names only, never values). */
  problems: string[];
};

function isBase64Key(raw: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(raw) && Buffer.from(raw, "base64").length === 32;
}

type Parsed = { status: KeyringStatus; raw: Map<string, string> };

function parse(env: NodeJS.ProcessEnv): Parsed {
  const problems: string[] = [];
  const raw = new Map<string, string>();

  const legacy = env.CARD_ENCRYPTION_KEY?.trim();
  if (legacy) {
    if (isBase64Key(legacy)) raw.set(LEGACY_KEY_ID, legacy);
    else problems.push("CARD_ENCRYPTION_KEY is not a base64-encoded 32-byte key");
  }

  const ring = env.CARD_ENCRYPTION_KEYS?.trim();
  if (ring) {
    for (const entry of ring.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const sep = trimmed.indexOf(":");
      const id = sep > 0 ? trimmed.slice(0, sep).trim() : "";
      const value = sep > 0 ? trimmed.slice(sep + 1).trim() : "";
      if (!KEY_ID.test(id)) {
        problems.push("CARD_ENCRYPTION_KEYS contains an entry with an invalid key id");
        continue;
      }
      if (raw.has(id)) {
        // The SAME key listed again under the SAME id (e.g. "v1" in the ring while
        // CARD_ENCRYPTION_KEY still holds it) is harmless and makes migrating the
        // legacy variable into the ring safe. A DIFFERENT key under an id that is
        // already taken would silently change what existing cards decrypt with.
        if (raw.get(id) !== value) problems.push(`Key id "${id}" is defined twice with different keys`);
        continue;
      }
      if (!isBase64Key(value)) {
        problems.push(`Key "${id}" is not a base64-encoded 32-byte key`);
        continue;
      }
      raw.set(id, value);
    }
  }

  const declaredCurrent = env.CARD_ENCRYPTION_KEY_ID?.trim();
  let currentKeyId: string | null = null;
  if (declaredCurrent) {
    if (raw.has(declaredCurrent)) currentKeyId = declaredCurrent;
    else problems.push(`CARD_ENCRYPTION_KEY_ID "${KEY_ID.test(declaredCurrent) ? declaredCurrent : "(invalid id)"}" is not in the key ring`);
  } else if (ring) {
    problems.push("CARD_ENCRYPTION_KEYS is set but CARD_ENCRYPTION_KEY_ID is not (the id used for new cards must be explicit)");
  } else if (raw.has(LEGACY_KEY_ID)) {
    currentKeyId = LEGACY_KEY_ID;
  }

  const anyConfigured = !!(legacy || ring || declaredCurrent);
  const state: KeyringState = !anyConfigured ? "missing" : problems.length > 0 || !currentKeyId ? "invalid" : "configured";
  return { status: { state, currentKeyId: state === "configured" ? currentKeyId : null, keyIds: [...raw.keys()], problems }, raw };
}

/** Non-secret summary of the ring (used by health checks and readiness). */
export function getKeyringStatus(env: NodeJS.ProcessEnv = process.env): KeyringStatus {
  return parse(env).status;
}

/** A fresh Buffer for one key id — the caller must zero it after use. */
export function getKeyBuffer(keyId: string, env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const { status, raw } = parse(env);
  if (status.state !== "configured") return null;
  const value = raw.get(keyId);
  return value ? Buffer.from(value, "base64") : null;
}

/** The id and a fresh key Buffer for encrypting new data, or null when the ring is not usable. */
export function getCurrentKey(env: NodeJS.ProcessEnv = process.env): { id: string; key: Buffer } | null {
  const { status, raw } = parse(env);
  if (status.state !== "configured" || !status.currentKeyId) return null;
  const value = raw.get(status.currentKeyId);
  return value ? { id: status.currentKeyId, key: Buffer.from(value, "base64") } : null;
}
