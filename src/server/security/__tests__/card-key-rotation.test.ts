import { describe, it, expect, vi, afterEach } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { decryptPan, encryptPan, inspectReference, PURGED_REFERENCE } from "../card-encryption";
import { rotateCardKeys, verifyCardKeys, type Queryable } from "../card-key-rotation";
import { parseRotationArgs } from "../card-key-rotation-cli";

// Rotation safety, with test keys only (nothing here is a real key or card). The in-memory "database" implements just the
// statements the tool issues, including the compare-and-swap UPDATE.

const K1 = Buffer.alloc(32, 21).toString("base64"); // the existing key: id v1 (CARD_ENCRYPTION_KEY)
const K2 = Buffer.alloc(32, 22).toString("base64");

function legacyBlob(pan: string, keyB64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), iv);
  const enc = Buffer.concat([cipher.update(pan, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}
function ring(env: Record<string, string>) {
  for (const k of ["CARD_ENCRYPTION_KEY", "CARD_ENCRYPTION_KEYS", "CARD_ENCRYPTION_KEY_ID"]) vi.stubEnv(k, env[k] ?? "");
}

class FakeDb implements Queryable {
  rows = new Map<string, string>();
  audit: unknown[] = [];
  writes = 0;
  async query(sql: string, params: unknown[] = []) {
    if (/^SELECT "id", "encryptedPan"/.test(sql)) {
      const after = String(params[0]);
      const only = /ANY/.test(sql) ? new Set(params[2] as string[]) : null;
      const limit = Number(params[1]);
      const out = [...this.rows.entries()]
        .filter(([id]) => id > after && (!only || only.has(id)))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .slice(0, limit)
        .map(([id, encryptedPan]) => ({ id, encryptedPan }));
      return { rows: out };
    }
    if (/^UPDATE "PaymentMethod"/.test(sql)) {
      const [newRef, id, oldRef] = params as string[];
      if (this.rows.get(id) === oldRef) {
        this.rows.set(id, newRef);
        this.writes++;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (/^INSERT INTO "AuditLog"/.test(sql)) {
      this.audit.push(JSON.parse(String(params[1])));
      return { rows: [], rowCount: 1 };
    }
    throw new Error("unexpected sql " + sql.slice(0, 40));
  }
}

afterEach(() => vi.unstubAllEnvs());

describe("rotateCardKeys", () => {
  function seed() {
    ring({ CARD_ENCRYPTION_KEY: K1 });
    const db = new FakeDb();
    db.rows.set("a-legacy", legacyBlob("4242424242424242", K1));
    db.rows.set("b-v1", encryptPan("5555555555554444", "b-v1")); // versioned under v1
    db.rows.set("c-purged", PURGED_REFERENCE);
    return db;
  }
  const rotateRing = () => ring({ CARD_ENCRYPTION_KEY: K1, CARD_ENCRYPTION_KEYS: `k2:${K2}`, CARD_ENCRYPTION_KEY_ID: "k2" });

  it("DRY RUN is the default behaviour of the function: nothing is written, no key is needed to count", async () => {
    const db = seed();
    const before = new Map(db.rows);
    rotateRing();
    const dry = await rotateCardKeys(db, { apply: false });
    expect(dry).toMatchObject({ apply: false, total: 3, purged: 1, rotated: 0, toRotate: { legacy: 1, v1: 1 } });
    expect(db.rows).toEqual(before);
    expect(db.writes).toBe(0);
    expect(db.audit).toHaveLength(0);
  });

  it("apply re-encrypts under the new key, keeps every plaintext intact, never touches a purged row, and writes one audit row without any card data", async () => {
    const db = seed();
    rotateRing();
    const done = await rotateCardKeys(db, { apply: true });
    expect(done).toMatchObject({ rotated: 2, raced: 0, failed: [], purged: 1 });
    expect(inspectReference(db.rows.get("a-legacy")!)).toEqual({ format: "envelope", keyId: "k2" });
    expect(inspectReference(db.rows.get("b-v1")!)).toEqual({ format: "envelope", keyId: "k2" });
    expect(db.rows.get("c-purged")).toBe(PURGED_REFERENCE);
    expect(decryptPan(db.rows.get("a-legacy")!, "a-legacy")).toBe("4242424242424242");
    expect(decryptPan(db.rows.get("b-v1")!, "b-v1")).toBe("5555555555554444");
    expect(JSON.stringify(db.audit)).not.toMatch(/4242|5555|cv2\.|k2:/);
    expect(db.audit).toHaveLength(1);
  });

  it("is idempotent and resumable: a second apply finds everything current and changes nothing", async () => {
    const db = seed();
    rotateRing();
    await rotateCardKeys(db, { apply: true });
    const snapshot = new Map(db.rows);
    const again = await rotateCardKeys(db, { apply: true });
    expect(again).toMatchObject({ rotated: 0, alreadyCurrent: 2, failed: [] });
    expect(db.rows).toEqual(snapshot);
  });

  it("a canary batch (ids) rotates only the named rows", async () => {
    const db = seed();
    rotateRing();
    const res = await rotateCardKeys(db, { apply: true, ids: ["a-legacy"] });
    expect(res.rotated).toBe(1);
    expect(inspectReference(db.rows.get("b-v1")!)).toEqual({ format: "envelope", keyId: "v1" });
  });

  it("a concurrent edit by the application wins: the compare-and-swap leaves the newer value alone", async () => {
    const db = seed();
    rotateRing();
    const original = db.query.bind(db);
    db.query = async (sql, params) => {
      if (/^UPDATE "PaymentMethod"/.test(sql)) db.rows.set(String(params![1]), "concurrent-edit"); // app changes the row first
      return original(sql, params);
    };
    const res = await rotateCardKeys(db, { apply: true, ids: ["a-legacy"] });
    expect(res).toMatchObject({ rotated: 0, raced: 1 });
    expect(db.rows.get("a-legacy")).toBe("concurrent-edit");
  });

  it("a row that cannot be decrypted is reported by id and code, left untouched, and the rest still rotate", async () => {
    const db = seed();
    db.rows.set("d-bad", legacyBlob("4111111111111111", Buffer.alloc(32, 99).toString("base64")));
    const bad = db.rows.get("d-bad");
    rotateRing();
    const res = await rotateCardKeys(db, { apply: true });
    expect(res.rotated).toBe(2);
    expect(res.failed).toEqual([{ id: "d-bad", code: "AUTH_FAILED" }]);
    expect(db.rows.get("d-bad")).toBe(bad);
    expect(JSON.stringify(res)).not.toMatch(/4111|4242|cv2\./);
  });

  it("refuses to run at all without a usable key ring", async () => {
    ring({});
    await expect(rotateCardKeys(new FakeDb(), { apply: true })).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });
});

describe("verifyCardKeys — the read-only proof before an old key is retired", () => {
  const rotateRing = () => ring({ CARD_ENCRYPTION_KEY: K1, CARD_ENCRYPTION_KEYS: `k2:${K2}`, CARD_ENCRYPTION_KEY_ID: "k2" });

  it("while any row still depends on the old key, that key is NOT retirable", async () => {
    ring({ CARD_ENCRYPTION_KEY: K1 });
    const db = new FakeDb();
    db.rows.set("a-legacy", legacyBlob("4242424242424242", K1));
    db.rows.set("b-v1", encryptPan("5555555555554444", "b-v1"));
    rotateRing();
    const v = await verifyCardKeys(db);
    expect(v).toMatchObject({ currentKeyId: "k2", total: 2, decryptable: 2, byKey: { legacy: 1, v1: 1 }, retirableKeyIds: [], safeToRetireListedKeys: true });
  });

  it("after a full rotation the old key is reported retirable, and everything still decrypts under its own key", async () => {
    ring({ CARD_ENCRYPTION_KEY: K1 });
    const db = new FakeDb();
    db.rows.set("a-legacy", legacyBlob("4242424242424242", K1));
    db.rows.set("p", PURGED_REFERENCE);
    rotateRing();
    await rotateCardKeys(db, { apply: true });
    const v = await verifyCardKeys(db);
    expect(v).toMatchObject({ total: 2, purged: 1, decryptable: 1, byKey: { k2: 1 }, retirableKeyIds: ["v1"], safeToRetireListedKeys: true });
  });

  it("verification is read-only, and one undecryptable row blocks retirement", async () => {
    ring({ CARD_ENCRYPTION_KEY: K1 });
    const db = new FakeDb();
    db.rows.set("ok", encryptPan("4242424242424242", "ok"));
    db.rows.set("broken", `cv2.v1.${Buffer.from("garbage-garbage-garbage-garbage-garbage").toString("base64url")}`);
    rotateRing();
    const before = new Map(db.rows);
    const v = await verifyCardKeys(db);
    expect(v.failed).toEqual([{ id: "broken", code: expect.any(String) }]);
    expect(v.safeToRetireListedKeys).toBe(false);
    expect(db.rows).toEqual(before);
    expect(db.writes).toBe(0);
    expect(JSON.stringify(v)).not.toMatch(/4242|cv2\./);
  });

  it("refuses without a usable key ring", async () => {
    ring({});
    await expect(verifyCardKeys(new FakeDb())).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });
});

describe("parseRotationArgs — a production run must be deliberate", () => {
  it("no flags is a dry run", () => {
    expect(parseRotationArgs([])).toEqual({ mode: "dry-run", ids: undefined });
  });
  it("--apply alone is refused, with the preconditions spelled out", () => {
    const r = parseRotationArgs(["--apply"]);
    expect(r).toEqual({ error: expect.stringMatching(/--confirm[\s\S]*backup[\s\S]*CARD_ENCRYPTION_KEYS/) });
  });
  it("--apply --confirm applies; --ids narrows it to a canary batch", () => {
    expect(parseRotationArgs(["--apply", "--confirm"])).toEqual({ mode: "apply", ids: undefined });
    expect(parseRotationArgs(["--apply", "--confirm", "--ids=a,b"])).toEqual({ mode: "apply", ids: ["a", "b"] });
  });
  it("--verify is read-only and cannot be mixed with apply or a subset", () => {
    expect(parseRotationArgs(["--verify"])).toEqual({ mode: "verify" });
    expect(parseRotationArgs(["--verify", "--apply", "--confirm"])).toEqual({ error: expect.any(String) });
    expect(parseRotationArgs(["--verify", "--ids=a"])).toEqual({ error: expect.any(String) });
  });
  it("--confirm without --apply, unknown flags and an empty --ids are rejected", () => {
    expect(parseRotationArgs(["--confirm"])).toEqual({ error: expect.any(String) });
    expect(parseRotationArgs(["--force"])).toEqual({ error: expect.stringMatching(/Unknown argument/) });
    expect(parseRotationArgs(["--ids="])).toEqual({ error: expect.any(String) });
  });
});
