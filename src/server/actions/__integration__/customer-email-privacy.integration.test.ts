// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

// REAL-DATABASE proof of the customer-email reveal allowance under genuine concurrency (separate connections, row locks, ON CONFLICT):
//   * twenty simultaneous reveals of different customers by one user admit exactly five - never six;
//   * simultaneous reveals of the SAME customer (two tabs / devices / retries) cost exactly one;
//   * a refused reveal leaves no reveal record behind;
//   * the counter is per user and per business day.
// Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL with this repo's migrations applied (see src/test/integration-database-guard.ts).

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
  process.env.CARD_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_HASH_KEY ??= randomBytes(32).toString("base64");
}

const TAG = `cep-${Date.now()}`;
const CO = `co-${TAG}`;
const NOW = new Date("2026-11-20T20:00:00Z");

describe.skipIf(!enabled)("customer email reveal allowance - real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let reveal: typeof import("@/server/privacy/customer-email").revealCustomerEmails;
  const accountIds: string[] = [];
  const contactIds: string[] = [];

  const viewer = (id: string) => ({ id, companyId: CO, restricted: true, unlimited: false, isAdmin: false });

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ revealCustomerEmails: reveal } = await import("@/server/privacy/customer-email"));
    for (const name of ["a", "b"]) {
      const acc = await prisma.account.create({ data: { fullName: `Agent ${name}`, email: `${name}-${TAG}@example.test`, role: "TRAVEL_AGENT", status: "ACTIVE", companyId: CO } });
      accountIds.push(acc.id);
    }
    for (let i = 0; i < 20; i++) {
      const c = await prisma.contact.create({ data: { firstName: `C${i}`, lastName: TAG, primaryEmail: `cust${i}-${TAG}@example.test`, companyId: CO } });
      contactIds.push(c.id);
    }
  });

  afterAll(async () => {
    if (!enabled) return;
    await prisma.customerEmailRevealEvent.deleteMany({ where: { userId: { in: accountIds } } });
    await prisma.customerEmailRevealUsage.deleteMany({ where: { userId: { in: accountIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: accountIds } } });
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.$disconnect();
  });

  it("twenty simultaneous reveals of different customers admit exactly five", async () => {
    const results = await Promise.all(contactIds.map((contactId) => reveal(viewer(accountIds[0]), { contactId, now: NOW })));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.code === "LIMIT_REACHED")).toHaveLength(15);
    expect(await prisma.customerEmailRevealEvent.count({ where: { userId: accountIds[0] } })).toBe(5);
    const usage = await prisma.customerEmailRevealUsage.findUnique({ where: { userId_dayKey: { userId: accountIds[0], dayKey: "2026-11-20" } } });
    expect(usage?.count).toBe(5);
  });

  it("a different user has an independent allowance", async () => {
    expect(await reveal(viewer(accountIds[1]), { contactId: contactIds[0], now: NOW })).toMatchObject({ ok: true, charged: true, usage: { used: 1 } });
  });

  it("the next business day starts fresh (midnight Pacific), the previous day's count is untouched", async () => {
    const next = new Date("2026-11-21T08:00:00Z");
    expect(await reveal(viewer(accountIds[0]), { contactId: contactIds[19], now: next })).toMatchObject({ ok: true, charged: true, usage: { used: 1 } });
    const prev = await prisma.customerEmailRevealUsage.findUnique({ where: { userId_dayKey: { userId: accountIds[0], dayKey: "2026-11-20" } } });
    expect(prev?.count).toBe(5);
  });

  it("simultaneous reveals of the SAME customer cost exactly one", async () => {
    const [first] = contactIds.slice(5, 6);
    const results = await Promise.all(Array.from({ length: 8 }, () => reveal(viewer(accountIds[1]), { contactId: first, now: new Date("2026-11-22T20:00:00Z") })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && r.charged)).toHaveLength(1);
    const usage = await prisma.customerEmailRevealUsage.findUnique({ where: { userId_dayKey: { userId: accountIds[1], dayKey: "2026-11-22" } } });
    expect(usage?.count).toBe(1);
  });

  it("a refused reveal leaves no reveal record and no audit entry for that customer", async () => {
    const refused = contactIds[10];
    const r = await reveal(viewer(accountIds[0]), { contactId: refused, now: NOW });
    expect(r).toMatchObject({ ok: false, code: "LIMIT_REACHED" });
    expect(await prisma.customerEmailRevealEvent.count({ where: { userId: accountIds[0], contactId: refused } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { actorId: accountIds[0], entityId: refused, action: "CUSTOMER_EMAIL_REVEALED" } })).toBe(0);
  });
});
