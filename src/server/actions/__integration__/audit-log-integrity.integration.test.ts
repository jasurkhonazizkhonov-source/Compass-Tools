// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

// REAL-DATABASE proof that EVERY audit row is append-only through the application's own database access: a row cannot be
// edited or deleted (Prisma or raw SQL), its metadata cannot be rewritten, new rows can still be written, and the single
// permitted change — clearing actorId when the actor's account is removed — works without altering anything else.
// Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL with this repo's migrations applied.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
  process.env.CARD_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_HASH_KEY ??= randomBytes(32).toString("base64");
}

const TAG = `aud-${Date.now()}`;
const APPEND_ONLY = /append-only/;

describe.skipIf(!enabled)("audit log integrity — real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let actorId = "";
  const rowIds: string[] = [];

  const write = async (action: string, metadata: object = { note: "original" }, withActor = true) => {
    const row = await prisma.auditLog.create({ data: { actorId: withActor ? actorId : undefined, action, entityType: "Lead", entityId: `${TAG}-${rowIds.length}`, metadata } });
    rowIds.push(row.id);
    return row;
  };

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    await prisma.company.upsert({ where: { id: "default-company" }, update: {}, create: { id: "default-company", name: "Test Co", signatureTemplate: "Regards" } });
    actorId = (await prisma.account.create({ data: { fullName: "Auditor", email: `auditor-${TAG}@example.test`, role: "ADMIN", status: "ACTIVE", companyId: "default-company" } })).id;
  });
  afterAll(async () => {
    if (!enabled) return;
    await prisma.account.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("new audit rows can still be written (any action, with and without an actor)", async () => {
    const a = await write("LEAD_IP_REVEALED");
    const b = await write("ROLE_NOTE", { x: 1 }, false);
    expect(a.id).toBeTruthy();
    expect(b.actorId).toBeNull();
  });

  it.each([
    ["an IP-reveal record", "LEAD_IP_REVEALED"],
    ["a role-change record", "ACCOUNT_ROLE_CHANGED"],
    ["a deletion record", "LEAD_DELETED"],
    ["an email-action record", "AIRLINE_CONFIRMATION_SENT"],
    ["a card-vault record (still protected)", "CARD_KEYS_ROTATED"],
  ])("%s cannot be edited or deleted — through Prisma or raw SQL", async (_label, action) => {
    const row = await write(action);
    await expect(prisma.auditLog.update({ where: { id: row.id }, data: { action: "SOMETHING_ELSE" } })).rejects.toThrow(APPEND_ONLY);
    await expect(prisma.auditLog.update({ where: { id: row.id }, data: { metadata: { note: "rewritten" } } })).rejects.toThrow(APPEND_ONLY);
    await expect(prisma.auditLog.update({ where: { id: row.id }, data: { actorId: null, metadata: { note: "rewritten" } } })).rejects.toThrow(APPEND_ONLY); // clearing the actor is only allowed on its own
    await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(APPEND_ONLY);
    await expect(prisma.auditLog.deleteMany({ where: { id: row.id } })).rejects.toThrow(APPEND_ONLY);
    await expect(prisma.auditLog.updateMany({ where: { id: row.id }, data: { createdAt: new Date(0) } })).rejects.toThrow(APPEND_ONLY);
    await expect(prisma.$executeRawUnsafe(`UPDATE "AuditLog" SET "entityId" = 'x' WHERE id = $1`, row.id)).rejects.toThrow(APPEND_ONLY);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE id = $1`, row.id)).rejects.toThrow(APPEND_ONLY);
    const after = await prisma.auditLog.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ action, actorId, metadata: { note: "original" } });
  });

  it("the one permitted change: removing the actor's account clears actorId and changes nothing else", async () => {
    const temp = await prisma.account.create({ data: { fullName: "Leaver", email: `leaver-${TAG}@example.test`, role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "default-company" } });
    const row = await prisma.auditLog.create({ data: { actorId: temp.id, action: "LEAD_REASSIGNED", entityType: "Lead", entityId: `${TAG}-leaver`, metadata: { note: "keep me" } } });
    rowIds.push(row.id);
    await prisma.account.delete({ where: { id: temp.id } });
    const after = await prisma.auditLog.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.actorId).toBeNull();
    expect(after).toMatchObject({ id: row.id, action: "LEAD_REASSIGNED", entityType: "Lead", entityId: row.entityId, metadata: { note: "keep me" } });
    expect(after.createdAt.getTime()).toBe(row.createdAt.getTime());
  });
});
