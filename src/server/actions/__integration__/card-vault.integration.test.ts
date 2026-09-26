// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import pg from "pg";

// REAL-DATABASE integration test for the card vault's storage-level guarantees.
// Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL
// database with this repo's migrations applied (see booking-submit's header).
// Only the card networks' published test numbers are used.
//
// Proves what unit tests with a fake Prisma cannot:
//   • Prisma never returns the ciphertext unless a query opts in;
//   • the database itself rejects a plaintext-looking value in encryptedPan;
//   • card-vault audit rows are append-only at the database;
//   • key rotation re-encrypts legacy / older-key rows and is safe to re-run;
//   • the retention purge destroys ciphertext and is irreversible.

// Acting account for the permission-grant test (the real action reads the session cookie).
let actingAccount: { id: string; role: string; status: string; companyId: string } | null = null;
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => actingAccount) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map([["user-agent", "IntegrationTest/1.0"]])) }));

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) process.env.DATABASE_URL = URL_UNDER_TEST;

const K1 = Buffer.alloc(32, 21).toString("base64"); // legacy key (id v1)
const K2 = Buffer.alloc(32, 22).toString("base64");
const TAG = `cv-${Date.now()}`;

function legacyBlob(pan: string, keyB64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), iv);
  const enc = Buffer.concat([cipher.update(pan, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

describe.skipIf(!enabled)("card vault storage guarantees — real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let enc: typeof import("@/server/security/card-encryption");
  let rotation: typeof import("@/server/security/card-key-rotation");
  let retention: typeof import("@/server/security/card-retention");
  let client: pg.Client;
  let contactId: string;
  const ids: string[] = [];

  function ring(env: Record<string, string>) {
    for (const k of ["CARD_ENCRYPTION_KEY", "CARD_ENCRYPTION_KEYS", "CARD_ENCRYPTION_KEY_ID"]) vi.stubEnv(k, env[k] ?? "");
  }
  async function makeRow(encryptedPan: string, extra: Record<string, unknown> = {}) {
    const row = await prisma.paymentMethod.create({
      data: { contactId, cardholderName: "Vault Test", encryptedPan, last4: "4242", expiryMonth: 12, expiryYear: 2099, ...extra },
      select: { id: true },
    });
    ids.push(row.id);
    return row.id;
  }
  const readRef = async (id: string) => (await prisma.paymentMethod.findUniqueOrThrow({ where: { id }, select: { encryptedPan: true } })).encryptedPan;

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    enc = await import("@/server/security/card-encryption");
    rotation = await import("@/server/security/card-key-rotation");
    retention = await import("@/server/security/card-retention");
    await prisma.company.upsert({ where: { id: "default-company" }, update: {}, create: { id: "default-company", name: "Test Co", signatureTemplate: "Regards" } });
    const contact = await prisma.contact.create({ data: { firstName: "Vault", lastName: TAG, primaryEmail: `vault-${TAG}@example.test`, companyId: "default-company" } });
    contactId = contact.id;
    client = new pg.Client({ connectionString: URL_UNDER_TEST });
    await client.connect();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (!enabled) return;
    await client.end();
    await prisma.contact.deleteMany({ where: { id: contactId } }); // cascades the PaymentMethod rows
    await prisma.$disconnect();
  });

  describe("ORM exposure", () => {
    it("no generic read returns the ciphertext (global omit) — find, include, nested and create/update results — but an explicit select does", async () => {
      ring({ CARD_ENCRYPTION_KEY: K1 });
      const id = await makeRow(enc.encryptPan("4242424242424242", "placeholder"));
      expect(await prisma.paymentMethod.findUnique({ where: { id } })).not.toHaveProperty("encryptedPan");
      expect((await prisma.paymentMethod.findMany({ where: { contactId } }))[0]).not.toHaveProperty("encryptedPan");
      const viaContact = await prisma.contact.findUniqueOrThrow({ where: { id: contactId }, include: { paymentMethods: true } });
      expect(viaContact.paymentMethods[0]).not.toHaveProperty("encryptedPan");
      const updated = await prisma.paymentMethod.update({ where: { id }, data: { cardholderName: "Renamed" } });
      expect(updated).not.toHaveProperty("encryptedPan");
      expect(JSON.stringify(viaContact)).not.toMatch(/cv2\./);
      expect(await readRef(id)).toMatch(/^cv2\./); // explicit select is the ONLY way
    });
  });

  describe("database constraints", () => {
    it("rejects a plaintext-looking card number in encryptedPan (CHECK), however it is written", async () => {
      for (const bad of ["4242424242424242", "4242 4242 4242 4242", "4242-4242-4242-4242", "short"]) {
        await expect(makeRow(bad), bad).rejects.toThrow();
      }
      await expect(client.query(`UPDATE "PaymentMethod" SET "encryptedPan" = '4242424242424242' WHERE "contactId" = $1`, [contactId])).rejects.toThrow(/PaymentMethod_encryptedPan_not_plaintext/);
    });

    it("accepts a versioned envelope, a legacy base64 blob and the purge tombstone", async () => {
      ring({ CARD_ENCRYPTION_KEY: K1 });
      await makeRow(enc.encryptPan("4242424242424242", "x"));
      await makeRow(legacyBlob("4242424242424242", K1));
      await makeRow(enc.PURGED_REFERENCE);
    });

    it("card-vault audit rows are append-only (no UPDATE, no DELETE), while ordinary audit rows are unaffected", async () => {
      const cardRow = await prisma.auditLog.create({ data: { action: "PAYMENT_METHOD_CREATED", entityType: "PaymentMethod", entityId: `${TAG}-a`, metadata: { last4: "4242" } } });
      await expect(prisma.auditLog.update({ where: { id: cardRow.id }, data: { entityId: "tampered" } })).rejects.toThrow(/append-only/);
      await expect(prisma.auditLog.delete({ where: { id: cardRow.id } })).rejects.toThrow(/append-only/);
      const permRow = await prisma.auditLog.create({ data: { action: "PAYMENT_PERMISSIONS_CHANGED", entityType: "Account", entityId: `${TAG}-b` } });
      await expect(prisma.auditLog.delete({ where: { id: permRow.id } })).rejects.toThrow(/append-only/);
      const decryptFail = await prisma.auditLog.create({ data: { action: "CARD_DECRYPTION_FAILED", entityType: "PaymentMethod", entityId: `${TAG}-c` } });
      await expect(prisma.auditLog.update({ where: { id: decryptFail.id }, data: { metadata: { edited: true } } })).rejects.toThrow(/append-only/);
      const ordinary = await prisma.auditLog.create({ data: { action: "SOMETHING_ELSE", entityType: "Lead", entityId: `${TAG}-d` } });
      await prisma.auditLog.delete({ where: { id: ordinary.id } });
      expect(await prisma.auditLog.count({ where: { id: ordinary.id } })).toBe(0);
    });
  });

  describe("Reveal grants are administrator changes and are audited", () => {
    it("an Admin can grant and revoke payments.reveal; each change is an append-only audit event; non-Admins cannot; ineligible roles cannot hold it", async () => {
      const { updatePaymentPermissions } = await import("@/server/actions/accounts");
      const mk = (role: "ADMIN" | "MANAGER" | "TRAVEL_AGENT", n: string) =>
        prisma.account.create({ data: { fullName: `${role} ${n}`, email: `${role.toLowerCase()}-${n}-${TAG}@example.test`, role, status: "ACTIVE", companyId: "default-company" } });
      const admin = await mk("ADMIN", "a");
      const manager = await mk("MANAGER", "m");
      const agent = await mk("TRAVEL_AGENT", "t");
      try {
        actingAccount = { id: admin.id, role: "ADMIN", status: "ACTIVE", companyId: "default-company" };
        await updatePaymentPermissions(manager.id, ["payments.reveal"]);
        expect((await prisma.account.findUniqueOrThrow({ where: { id: manager.id } })).paymentPermissions).toEqual(["payments.reveal"]);
        await updatePaymentPermissions(manager.id, []);
        const events = await prisma.auditLog.findMany({ where: { action: "PAYMENT_PERMISSIONS_CHANGED", entityId: manager.id }, orderBy: { createdAt: "asc" } });
        expect(events).toHaveLength(2);
        expect(events[0].actorId).toBe(admin.id);
        expect(events[0].metadata).toMatchObject({ granted: ["payments.reveal"], revoked: [], targetRole: "MANAGER", result: "SUCCESS" });
        expect(events[1].metadata).toMatchObject({ granted: [], revoked: ["payments.reveal"] });
        expect(events[0].metadata).toHaveProperty("correlationId");

        // an Admin can hold the Reveal grant themselves (explicit, audited) — and only that one is needed for Reveal
        await updatePaymentPermissions(admin.id, ["payments.reveal"]);
        expect(await prisma.auditLog.count({ where: { action: "PAYMENT_PERMISSIONS_CHANGED", entityId: admin.id } })).toBe(1);

        // ineligible role cannot be granted Reveal (rejected before anything is written)
        await expect(updatePaymentPermissions(agent.id, ["payments.reveal"])).rejects.toThrow(/cannot be granted/i);
        expect(await prisma.auditLog.count({ where: { action: "PAYMENT_PERMISSIONS_CHANGED", entityId: agent.id } })).toBe(0);

        // a non-Admin cannot change grants at all
        actingAccount = { id: manager.id, role: "MANAGER", status: "ACTIVE", companyId: "default-company" };
        await expect(updatePaymentPermissions(manager.id, ["payments.reveal"])).rejects.toThrow(/only admins/i);
      } finally {
        actingAccount = null;
      }
    });
  });

  describe("key rotation (npm run cards:rotate)", () => {
    it("dry run changes nothing; apply re-encrypts legacy and older-key rows under the current key; re-running is a no-op; purged rows are skipped", async () => {
      // Fresh, isolated rows for this scenario.
      await prisma.paymentMethod.deleteMany({ where: { contactId } });
      ids.length = 0;
      ring({ CARD_ENCRYPTION_KEY: K1 });
      const legacyId = await makeRow(legacyBlob("4242424242424242", K1));
      const v1Id = await makeRow("placeholder-not-used-yet-aaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      await prisma.paymentMethod.update({ where: { id: v1Id }, data: { encryptedPan: enc.encryptPan("5555555555554444", v1Id) } });
      const purgedId = await makeRow(enc.PURGED_REFERENCE);
      const beforeLegacy = await readRef(legacyId);
      const beforeV1 = await readRef(v1Id);

      // New ring: k2 current, v1 (CARD_ENCRYPTION_KEY) retained for decryption.
      ring({ CARD_ENCRYPTION_KEY: K1, CARD_ENCRYPTION_KEYS: `k2:${K2}`, CARD_ENCRYPTION_KEY_ID: "k2" });

      const dry = await rotation.rotateCardKeys(client, { apply: false, ids: [legacyId, v1Id, purgedId] });
      expect(dry.toRotate).toEqual({ legacy: 1, v1: 1 });
      expect(dry.purged).toBe(1);
      expect(dry.rotated).toBe(0);
      expect(await readRef(legacyId)).toBe(beforeLegacy);
      expect(await readRef(v1Id)).toBe(beforeV1);

      const done = await rotation.rotateCardKeys(client, { apply: true, ids: [legacyId, v1Id, purgedId] });
      expect(done).toMatchObject({ rotated: 2, raced: 0, failed: [] });
      for (const id of [legacyId, v1Id]) expect(enc.inspectReference(await readRef(id))).toEqual({ format: "envelope", keyId: "k2" });
      expect(await readRef(purgedId)).toBe(enc.PURGED_REFERENCE);
      expect(await prisma.auditLog.count({ where: { action: "CARD_KEYS_ROTATED", metadata: { path: ["currentKeyId"], equals: "k2" } } })).toBeGreaterThanOrEqual(1);

      // The old key can now be RETIRED: everything still decrypts with only k2.
      ring({ CARD_ENCRYPTION_KEYS: `k2:${K2}`, CARD_ENCRYPTION_KEY_ID: "k2" });
      expect(enc.decryptPan(await readRef(legacyId), legacyId)).toBe("4242424242424242");
      expect(enc.decryptPan(await readRef(v1Id), v1Id)).toBe("5555555555554444");

      const again = await rotation.rotateCardKeys(client, { apply: true, ids: [legacyId, v1Id, purgedId] });
      expect(again).toMatchObject({ rotated: 0, alreadyCurrent: 2, purged: 1, failed: [] });
    });

    it("a row that cannot be decrypted is reported by id + code and left untouched; the rest still rotate", async () => {
      await prisma.paymentMethod.deleteMany({ where: { contactId } });
      ring({ CARD_ENCRYPTION_KEY: K1 });
      const okId = await makeRow(legacyBlob("4242424242424242", K1));
      const wrongKeyId = await makeRow(legacyBlob("4242424242424242", Buffer.alloc(32, 99).toString("base64")));
      const badBefore = await readRef(wrongKeyId);
      ring({ CARD_ENCRYPTION_KEY: K1, CARD_ENCRYPTION_KEYS: `k2:${K2}`, CARD_ENCRYPTION_KEY_ID: "k2" });
      const res = await rotation.rotateCardKeys(client, { apply: true, ids: [okId, wrongKeyId] });
      expect(res.rotated).toBe(1);
      expect(res.failed).toEqual([{ id: wrongKeyId, code: "AUTH_FAILED" }]);
      expect(await readRef(wrongKeyId)).toBe(badBefore);
      expect(enc.inspectReference(await readRef(okId))).toEqual({ format: "envelope", keyId: "k2" });
      expect(JSON.stringify(res)).not.toMatch(/4242|cv2\./);
    });

    it("refuses to run without a usable key ring", async () => {
      ring({});
      await expect(rotation.rotateCardKeys(client, { apply: true })).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    });
  });

  describe("scheduled retention (cron) uses the same purge through Prisma", () => {
    it("destroys cards older than CARD_RETENTION_DAYS and removed cards; leaves recent ones; runs only when configured", async () => {
      await prisma.paymentMethod.deleteMany({ where: { contactId } });
      ring({ CARD_ENCRYPTION_KEY: K1 });
      const { runScheduledCardRetention } = await import("@/server/security/card-retention-schedule");
      const oldId = await makeRow(enc.encryptPan("4242424242424242", "tmp"));
      const freshId = await makeRow(enc.encryptPan("4242424242424242", "tmp"));
      await client.query(`UPDATE "PaymentMethod" SET "createdAt" = now() - interval '4000 days' WHERE "id" = $1`, [oldId]);
      const freshBefore = await readRef(freshId);

      expect(await runScheduledCardRetention({} as NodeJS.ProcessEnv)).toEqual({ status: "disabled" });
      expect(await readRef(oldId)).toMatch(/^cv2./); // disabled => nothing touched

      const res = await runScheduledCardRetention({ CARD_RETENTION_DAYS: "3650" } as unknown as NodeJS.ProcessEnv);
      expect(res).toMatchObject({ status: "ran", apply: true });
      expect(await readRef(oldId)).toBe(enc.PURGED_REFERENCE);
      expect(await readRef(freshId)).toBe(freshBefore);
      expect(await prisma.auditLog.count({ where: { action: "PAYMENT_METHOD_PURGED", entityId: oldId } })).toBe(1);
    });
  });

  describe("retention purge (npm run cards:purge)", () => {
    it("requires an explicit selector; dry run matches without changing; apply destroys the ciphertext irreversibly and audits each card", async () => {
      await prisma.paymentMethod.deleteMany({ where: { contactId } });
      ring({ CARD_ENCRYPTION_KEY: K1 });
      const archivedId = await makeRow(enc.encryptPan("4242424242424242", "tmp"), { status: "ARCHIVED" });
      const oldId = await makeRow(enc.encryptPan("4242424242424242", "tmp"));
      const freshId = await makeRow(enc.encryptPan("4242424242424242", "tmp"));
      await client.query(`UPDATE "PaymentMethod" SET "createdAt" = now() - interval '400 days' WHERE "id" = $1`, [oldId]);
      const freshBefore = await readRef(freshId);

      const scope = [archivedId, oldId, freshId];
      await expect(retention.purgeCardData(client, { apply: true, ids: scope })).rejects.toThrow(/at least one selector/i);
      await expect(retention.purgeCardData(client, { apply: true, olderThanDays: 0, ids: scope })).rejects.toThrow();

      const dry = await retention.purgeCardData(client, { apply: false, archived: true, olderThanDays: 365, ids: scope });
      expect(dry).toMatchObject({ matched: 2, purged: 0 });
      expect(await readRef(archivedId)).toMatch(/^cv2\./);

      const done = await retention.purgeCardData(client, { apply: true, archived: true, olderThanDays: 365, ids: scope });
      expect(done).toMatchObject({ matched: 2, purged: 2 });
      for (const id of [archivedId, oldId]) {
        expect(await readRef(id)).toBe(enc.PURGED_REFERENCE);
        expect(() => enc.decryptPan(enc.PURGED_REFERENCE, id)).toThrow();
        const row = await prisma.paymentMethod.findUniqueOrThrow({ where: { id } });
        expect(row.panPurgedAt).toBeInstanceOf(Date);
        expect(row.status).toBe("ARCHIVED");
        expect(row.last4).toBe("4242"); // masked display data stays
        expect(await prisma.auditLog.count({ where: { action: "PAYMENT_METHOD_PURGED", entityId: id } })).toBe(1);
      }
      expect(await readRef(freshId)).toBe(freshBefore); // untouched
      expect((await retention.purgeCardData(client, { apply: true, archived: true, olderThanDays: 365, ids: scope })).matched).toBe(0); // idempotent
    });
  });
});
