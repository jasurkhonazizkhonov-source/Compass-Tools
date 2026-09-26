import { describe, it, expect } from "vitest";
import { getKeyringStatus, getCurrentKey, getKeyBuffer } from "../card-keyring";

const K1 = Buffer.alloc(32, 1).toString("base64");
const K2 = Buffer.alloc(32, 2).toString("base64");
const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("card key ring (environment parsing — startup validation)", () => {
  it("nothing configured → missing", () => {
    expect(getKeyringStatus(env({})).state).toBe("missing");
    expect(getCurrentKey(env({}))).toBeNull();
  });

  it("the original single CARD_ENCRYPTION_KEY is the current key with id v1", () => {
    const s = getKeyringStatus(env({ CARD_ENCRYPTION_KEY: K1 }));
    expect(s).toMatchObject({ state: "configured", currentKeyId: "v1", keyIds: ["v1"], problems: [] });
  });

  it("a ring with an explicit current id; older keys retained; legacy key still present as v1", () => {
    const s = getKeyringStatus(env({ CARD_ENCRYPTION_KEY: K1, CARD_ENCRYPTION_KEYS: `k2:${K2}`, CARD_ENCRYPTION_KEY_ID: "k2" }));
    expect(s.state).toBe("configured");
    expect(s.currentKeyId).toBe("k2");
    expect(s.keyIds.sort()).toEqual(["k2", "v1"]);
    const cur = getCurrentKey(env({ CARD_ENCRYPTION_KEY: K1, CARD_ENCRYPTION_KEYS: `k2:${K2}`, CARD_ENCRYPTION_KEY_ID: "k2" }))!;
    expect(cur.id).toBe("k2");
    expect(cur.key.equals(Buffer.from(K2, "base64"))).toBe(true);
  });

  it("the current id must be explicit when a ring is used, and must exist in it (never a silent default)", () => {
    expect(getKeyringStatus(env({ CARD_ENCRYPTION_KEYS: `k2:${K2}` })).state).toBe("invalid");
    expect(getKeyringStatus(env({ CARD_ENCRYPTION_KEYS: `k2:${K2}`, CARD_ENCRYPTION_KEY_ID: "nope" })).state).toBe("invalid");
  });

  it("rejects wrong-length / non-base64 / duplicate / badly-named keys, naming the id but never the value", () => {
    const bad = getKeyringStatus(env({ CARD_ENCRYPTION_KEYS: `k2:${Buffer.alloc(16).toString("base64")},k3:!!!,k2:${K2},bad id:${K2}`, CARD_ENCRYPTION_KEY_ID: "k2" }));
    expect(bad.state).toBe("invalid");
    const text = bad.problems.join(" | ");
    expect(text).toMatch(/k2/);
    expect(text).toMatch(/k3/);
    expect(text).not.toContain(K2);
    expect(text).not.toContain(Buffer.alloc(16).toString("base64"));
  });

  it("an invalid legacy key makes the whole ring invalid (it may protect existing cards)", () => {
    expect(getKeyringStatus(env({ CARD_ENCRYPTION_KEY: "short", CARD_ENCRYPTION_KEYS: `k2:${K2}`, CARD_ENCRYPTION_KEY_ID: "k2" })).state).toBe("invalid");
  });

  it("an unusable ring hands out no key material at all", () => {
    expect(getKeyBuffer("v1", env({ CARD_ENCRYPTION_KEY: "short" }))).toBeNull();
    expect(getCurrentKey(env({ CARD_ENCRYPTION_KEYS: `k2:${K2}` }))).toBeNull();
  });

  it("status objects never contain key material", () => {
    const s = getKeyringStatus(env({ CARD_ENCRYPTION_KEY: K1, CARD_ENCRYPTION_KEYS: `k2:${K2}`, CARD_ENCRYPTION_KEY_ID: "k2" }));
    expect(JSON.stringify(s)).not.toContain(K1);
    expect(JSON.stringify(s)).not.toContain(K2);
  });
});
