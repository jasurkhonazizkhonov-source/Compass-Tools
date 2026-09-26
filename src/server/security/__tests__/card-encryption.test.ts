import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createCipheriv, randomBytes } from "crypto";
import { encryptPan, decryptPan, inspectReference, CardVaultError, PURGED_REFERENCE } from "../card-encryption";

// Real AES-256-GCM, real key ring. Official test PANs only.
const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");
const PAN = "4242424242424242";

function setRing(env: Record<string, string>) {
  for (const k of ["CARD_ENCRYPTION_KEY", "CARD_ENCRYPTION_KEYS", "CARD_ENCRYPTION_KEY_ID"]) vi.stubEnv(k, env[k] ?? "");
}

beforeEach(() => setRing({ CARD_ENCRYPTION_KEY: KEY_A }));
afterEach(() => vi.unstubAllEnvs());

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof CardVaultError ? e.code : `non-vault:${String(e)}`;
  }
  return "no-error";
};

describe("envelope format and round trip", () => {
  it("produces a versioned envelope cv2.<keyId>.<payload> that does not contain the PAN and round-trips", () => {
    const ref = encryptPan(PAN, "row-1");
    expect(ref).toMatch(/^cv2\.v1\.[A-Za-z0-9_-]+$/);
    expect(ref).not.toContain(PAN);
    expect(inspectReference(ref)).toEqual({ format: "envelope", keyId: "v1" });
    expect(decryptPan(ref, "row-1")).toBe(PAN);
  });

  it("uses a fresh random IV every time: encrypting the same PAN twice never gives the same ciphertext", () => {
    const seen = new Set(Array.from({ length: 200 }, () => encryptPan(PAN, "row-1")));
    expect(seen.size).toBe(200);
    // the IV is the first 12 bytes of the payload — all distinct too
    const ivs = new Set([...seen].map((r) => Buffer.from(r.split(".")[2], "base64url").subarray(0, 12).toString("hex")));
    expect(ivs.size).toBe(200);
  });

  it("only encrypts a digits-only PAN for a real row id (never arbitrary text)", () => {
    expect(codeOf(() => encryptPan("4242 4242 4242 4242", "row-1"))).toBe("INVALID_INPUT");
    expect(codeOf(() => encryptPan("hello world!!", "row-1"))).toBe("INVALID_INPUT");
    expect(codeOf(() => encryptPan(PAN, ""))).toBe("INVALID_INPUT");
  });
});

describe("tamper resistance (authenticated encryption)", () => {
  it("any modified ciphertext, IV or tag fails authentication", () => {
    const ref = encryptPan(PAN, "row-1");
    const [, id, payload] = ref.split(".");
    const raw = Buffer.from(payload, "base64url");
    for (const offset of [0, 5, 12, 20, raw.length - 1]) {
      const mutated = Buffer.from(raw);
      mutated[offset] ^= 0x01;
      expect(codeOf(() => decryptPan(`cv2.${id}.${mutated.toString("base64url")}`, "row-1")), `byte ${offset}`).toBe("AUTH_FAILED");
    }
  });

  it("a ciphertext copied into a DIFFERENT row does not decrypt there (row id is authenticated data)", () => {
    const ref = encryptPan(PAN, "row-1");
    expect(codeOf(() => decryptPan(ref, "row-2"))).toBe("AUTH_FAILED");
    expect(decryptPan(ref, "row-1")).toBe(PAN);
  });

  it("a ciphertext rewritten to claim a different (known) key id fails rather than decrypting", () => {
    setRing({ CARD_ENCRYPTION_KEYS: `k1:${KEY_A},k2:${KEY_B}`, CARD_ENCRYPTION_KEY_ID: "k1" });
    const ref = encryptPan(PAN, "row-1");
    expect(codeOf(() => decryptPan(ref.replace("cv2.k1.", "cv2.k2."), "row-1"))).toBe("AUTH_FAILED");
  });

  it("malformed input fails closed with a fixed code and never an OpenSSL message", () => {
    for (const bad of ["", "cv2.", "cv2.v1", "cv2.v1.", "cv2.v1.AAAA", "cv2.v1.AAAA.BBBB", "cv2.!!.AAAA", "not base64 at all", "4242424242424242", "cv2.v1." + "A".repeat(10)]) {
      const code = codeOf(() => decryptPan(bad, "row-1"));
      expect(["MALFORMED", "AUTH_FAILED"], JSON.stringify(bad)).toContain(code);
    }
  });

  it("a truncated tag / empty ciphertext is rejected (the 16-byte tag is pinned)", () => {
    const iv = randomBytes(12);
    const tooShort = Buffer.concat([iv, randomBytes(8)]).toString("base64url");
    expect(codeOf(() => decryptPan(`cv2.v1.${tooShort}`, "row-1"))).toBe("MALFORMED");
  });

  it("errors carry only a fixed code — never the PAN, a key, or ciphertext", () => {
    const ref = encryptPan(PAN, "row-1");
    try {
      decryptPan(ref, "other-row");
    } catch (e) {
      const text = `${(e as Error).name} ${(e as Error).message} ${JSON.stringify(e)}`;
      expect(text).not.toContain(PAN);
      expect(text).not.toContain(KEY_A);
      expect(text).not.toContain(ref);
    }
  });
});

describe("fail closed: keys", () => {
  it("no key configured → NOT_CONFIGURED for encrypt and decrypt; nothing falls back to plaintext", () => {
    const ref = encryptPan(PAN, "row-1");
    setRing({});
    expect(codeOf(() => encryptPan(PAN, "row-1"))).toBe("NOT_CONFIGURED");
    expect(codeOf(() => decryptPan(ref, "row-1"))).toBe("NOT_CONFIGURED");
  });

  it("an invalid key (wrong length / not base64) → NOT_CONFIGURED", () => {
    for (const bad of ["short", Buffer.alloc(16, 1).toString("base64"), "!!!not-base64!!!"]) {
      setRing({ CARD_ENCRYPTION_KEY: bad });
      expect(codeOf(() => encryptPan(PAN, "row-1")), bad).toBe("NOT_CONFIGURED");
    }
  });

  it("the WRONG key cannot decrypt (AUTH_FAILED); an unknown key id is KEY_UNKNOWN", () => {
    const ref = encryptPan(PAN, "row-1");
    setRing({ CARD_ENCRYPTION_KEY: KEY_B });
    expect(codeOf(() => decryptPan(ref, "row-1"))).toBe("AUTH_FAILED");
    setRing({ CARD_ENCRYPTION_KEYS: `other:${KEY_B}`, CARD_ENCRYPTION_KEY_ID: "other" });
    expect(codeOf(() => decryptPan(ref, "row-1"))).toBe("KEY_UNKNOWN");
  });
});

describe("key rotation compatibility", () => {
  it("new cards use the newest key; older cards stay decryptable while their key remains in the ring", () => {
    const oldRef = encryptPan(PAN, "row-1"); // under v1 (KEY_A)
    setRing({ CARD_ENCRYPTION_KEY: KEY_A, CARD_ENCRYPTION_KEYS: `k2:${KEY_B}`, CARD_ENCRYPTION_KEY_ID: "k2" });
    const newRef = encryptPan("5555555555554444", "row-2");
    expect(inspectReference(newRef)).toEqual({ format: "envelope", keyId: "k2" });
    expect(decryptPan(oldRef, "row-1")).toBe(PAN); // still readable through the retained v1 key
    expect(decryptPan(newRef, "row-2")).toBe("5555555555554444");
  });

  it("once an old key is REMOVED, cards under it can no longer be read — so retire keys only after re-encryption", () => {
    const oldRef = encryptPan(PAN, "row-1");
    setRing({ CARD_ENCRYPTION_KEYS: `k2:${KEY_B}`, CARD_ENCRYPTION_KEY_ID: "k2" });
    expect(codeOf(() => decryptPan(oldRef, "row-1"))).toBe("KEY_UNKNOWN");
  });
});

describe("legacy (pre-envelope) ciphertext stays readable", () => {
  function legacyBlob(pan: string, keyB64: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), iv);
    const enc = Buffer.concat([cipher.update(pan, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
  }

  it("decrypts the original iv‖tag‖ciphertext format with CARD_ENCRYPTION_KEY (key id v1), for any row id", () => {
    const legacy = legacyBlob(PAN, KEY_A);
    expect(inspectReference(legacy)).toEqual({ format: "legacy" });
    expect(decryptPan(legacy, "whatever-row")).toBe(PAN);
  });

  it("a legacy blob under the wrong key fails closed", () => {
    setRing({ CARD_ENCRYPTION_KEY: KEY_B });
    expect(codeOf(() => decryptPan(legacyBlob(PAN, KEY_A), "row-1"))).toBe("AUTH_FAILED");
  });
});

describe("purged (tombstone) cards", () => {
  it("can never be decrypted", () => {
    expect(inspectReference(PURGED_REFERENCE)).toEqual({ format: "purged" });
    expect(codeOf(() => decryptPan(PURGED_REFERENCE, "row-1"))).toBe("PURGED");
  });
});
