import { describe, it, expect, vi, beforeEach } from "vitest";

// Customer-email privacy policy against an in-memory database. The SQL itself (INSERT .. ON CONFLICT, the conditional counter) is emulated statement by statement here,
// so these tests prove the policy and the transaction/rollback logic; the same behaviour against real PostgreSQL concurrency is covered by
// __integration__/customer-email-privacy.integration.test.ts (it runs only against a disposable database).

type EventRow = { id: string; userId: string; contactId: string; dayKey: string; method: string };
let events: EventRow[];
let usage: Map<string, number>;
let audits: Array<Record<string, unknown>>;
let accounts: Map<string, { unlimitedCustomerEmailAccess: boolean }>;
let contactEmails: Array<{ id: string; contactId: string; email: string; createdAt: Date }>;
let contacts: Array<{ id: string; primaryEmail: string | null }>;
let failAccountRead = false;
let failAddressRead = false;

// Each transaction keeps an undo log, so a rollback removes only ITS OWN writes (concurrent transactions are not disturbed - as in a real database).
function makeDb(undo: Array<() => void> = []) {
  const queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes('INTO "CustomerEmailRevealEvent"')) {
      const [id, userId, , contactId, , dayKey] = values as string[];
      if (events.some((e) => e.userId === userId && e.contactId === contactId && e.dayKey === dayKey)) return [];
      const row = { id, userId, contactId, dayKey, method: "DAILY_ALLOWANCE" };
      events.push(row);
      undo.push(() => void (events = events.filter((e) => e !== row)));
      return [{ id }];
    }
    if (sql.includes('INTO "CustomerEmailRevealUsage"')) {
      const [userId, dayKey, limit] = [values[0], values[1], values[2]] as [string, string, number];
      const key = `${userId}|${dayKey}`;
      const current = usage.get(key);
      if (current === undefined) {
        usage.set(key, 1);
        undo.push(() => void usage.delete(key));
        return [{ count: 1 }];
      }
      if (current < limit) {
        usage.set(key, current + 1);
        undo.push(() => void usage.set(key, (usage.get(key) ?? 1) - 1));
        return [{ count: current + 1 }];
      }
      return [];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const reads = {
    contactEmail: {
      findMany: vi.fn(async ({ where }: { where: { contactId: string; id?: { in: string[] } } }) => {
        if (failAddressRead) throw new Error("db down");
        return contactEmails
          .filter((e) => e.contactId === where.contactId && (!where.id || where.id.in.includes(e.id)))
          .map((e) => ({ id: e.id, email: e.email }));
      }),
    },
    contact: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => contacts.find((c) => c.id === where.id) ?? null) },
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        undo.push(() => void (audits = audits.filter((a) => a !== data)));
      }),
    },
  };
  return { ...reads, $queryRaw: queryRaw };
}

vi.mock("@/lib/prisma", () => {
  const db = makeDb();
  return {
    prisma: {
      ...db,
      account: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
          if (failAccountRead) throw new Error("db down");
          return accounts.get(where.id) ?? null;
        }),
      },
      customerEmailRevealEvent: {
        findMany: vi.fn(async ({ where }: { where: { userId: string; dayKey: string; contactId: { in: string[] } } }) =>
          events.filter((e) => e.userId === where.userId && e.dayKey === where.dayKey && where.contactId.in.includes(e.contactId)).map((e) => ({ contactId: e.contactId }))
        ),
      },
      customerEmailRevealUsage: {
        findUnique: vi.fn(async ({ where }: { where: { userId_dayKey: { userId: string; dayKey: string } } }) => {
          const c = usage.get(`${where.userId_dayKey.userId}|${where.userId_dayKey.dayKey}`);
          return c === undefined ? null : { count: c };
        }),
      },
      // A transaction that throws rolls EVERYTHING it wrote back, like the database does.
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const undo: Array<() => void> = [];
        try {
          return await fn(makeDb(undo));
        } catch (err) {
          for (const step of undo.reverse()) step();
          throw err;
        }
      }),
    },
  };
});

const NOON = new Date("2026-11-20T20:00:00Z"); // 12:00 in Los Angeles, Nov 20
const viewerOf = (id: string, restricted = true) => ({ id, companyId: "co-1", restricted, unlimited: !restricted, isAdmin: false });

beforeEach(() => {
  events = [];
  usage = new Map();
  audits = [];
  accounts = new Map([
    ["agent-1", { unlimitedCustomerEmailAccess: false }],
    ["agent-2", { unlimitedCustomerEmailAccess: false }],
    ["trusted-1", { unlimitedCustomerEmailAccess: true }],
  ]);
  contacts = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, primaryEmail: `customer${i}@example.com` }));
  contactEmails = contacts.map((c, i) => ({ id: `e${i}`, contactId: c.id, email: c.primaryEmail!, createdAt: new Date(2026, 0, 1 + i) }));
  failAccountRead = false;
  failAddressRead = false;
});

describe("who is restricted", () => {
  it("an Administrator is never restricted, and no database read is needed to decide it", async () => {
    const { getEmailViewer } = await import("../customer-email");
    expect(await getEmailViewer({ id: "admin-1", role: "ADMIN", companyId: "co-1" })).toMatchObject({ restricted: false, isAdmin: true });
  });

  it.each(["MANAGER", "TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"])("a %s is restricted by default", async (role) => {
    const { getEmailViewer } = await import("../customer-email");
    expect(await getEmailViewer({ id: "agent-1", role, companyId: "co-1" })).toMatchObject({ restricted: true, unlimited: false });
  });

  it("Unlimited Customer Email Access lifts the restriction, and turning it off restricts again on the very next decision (read fresh every time)", async () => {
    const { getEmailViewer } = await import("../customer-email");
    expect((await getEmailViewer({ id: "trusted-1", role: "TRAVEL_AGENT", companyId: "co-1" })).restricted).toBe(false);
    accounts.set("trusted-1", { unlimitedCustomerEmailAccess: false });
    expect((await getEmailViewer({ id: "trusted-1", role: "TRAVEL_AGENT", companyId: "co-1" })).restricted).toBe(true);
  });

  it("fails closed: an unreadable permission, or a missing account, means restricted", async () => {
    const { getEmailViewer, isEmailRestricted } = await import("../customer-email");
    failAccountRead = true;
    expect((await getEmailViewer({ id: "trusted-1", role: "TRAVEL_AGENT", companyId: "co-1" })).restricted).toBe(true);
    failAccountRead = false;
    expect((await getEmailViewer({ id: "ghost", role: "TRAVEL_AGENT", companyId: "co-1" })).restricted).toBe(true);
    expect(await isEmailRestricted(null)).toBe(true);
    expect(await isEmailRestricted(undefined)).toBe(true);
  });
});

describe("reveal allowance - five per business day", () => {
  it("a first reveal returns the customer's complete addresses, counts one, and writes an audit entry that holds no address", async () => {
    const { revealCustomerEmails } = await import("../customer-email");
    const r = await revealCustomerEmails(viewerOf("agent-1"), { contactId: "c0", now: NOON });
    expect(r).toMatchObject({ ok: true, charged: true, addresses: [{ address: "customer0@example.com" }], usage: { used: 1, limit: 5, remaining: 4 } });
    expect(events).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: "agent-1", action: "CUSTOMER_EMAIL_REVEALED", entityType: "Contact", entityId: "c0" });
    expect(JSON.stringify(audits[0])).not.toMatch(/@example\.com/);
  });

  it("revealing the SAME customer again the same day is free, returns the addresses, and writes no second audit entry", async () => {
    const { revealCustomerEmails } = await import("../customer-email");
    await revealCustomerEmails(viewerOf("agent-1"), { contactId: "c0", now: NOON });
    const again = await revealCustomerEmails(viewerOf("agent-1"), { contactId: "c0", now: new Date(NOON.getTime() + 3_600_000) });
    expect(again).toMatchObject({ ok: true, charged: false, addresses: [{ address: "customer0@example.com" }], usage: { used: 1 } });
    expect(events).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it("five different customers succeed; the sixth is refused, leaves NO reveal record behind and does not change the counter", async () => {
    const { revealCustomerEmails } = await import("../customer-email");
    for (let i = 0; i < 5; i++) expect((await revealCustomerEmails(viewerOf("agent-1"), { contactId: `c${i}`, now: NOON })).ok).toBe(true);
    const sixth = await revealCustomerEmails(viewerOf("agent-1"), { contactId: "c5", now: NOON });
    expect(sixth).toMatchObject({ ok: false, code: "LIMIT_REACHED", usage: { used: 5, remaining: 0 } });
    expect((sixth as { error: string }).error).toMatch(/all 5/);
    expect(events).toHaveLength(5);
    expect(events.some((e) => e.contactId === "c5")).toBe(false);
    expect(audits).toHaveLength(5);
    // an already-revealed customer is still free after the limit is hit
    expect(await revealCustomerEmails(viewerOf("agent-1"), { contactId: "c0", now: NOON })).toMatchObject({ ok: true, charged: false });
  });

  it("a refused sixth reveal never returns an address", async () => {
    const { revealCustomerEmails } = await import("../customer-email");
    for (let i = 0; i < 5; i++) await revealCustomerEmails(viewerOf("agent-1"), { contactId: `c${i}`, now: NOON });
    const sixth = await revealCustomerEmails(viewerOf("agent-1"), { contactId: "c7", now: NOON });
    expect(JSON.stringify(sixth)).not.toMatch(/customer7@example\.com/);
  });

  it("concurrent reveals of ten DIFFERENT customers admit exactly five", async () => {
    const { revealCustomerEmails } = await import("../customer-email");
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => revealCustomerEmails(viewerOf("agent-1"), { contactId: `c${i}`, now: NOON })));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.code === "LIMIT_REACHED")).toHaveLength(5);
    expect(usage.get("agent-1|2026-11-20")).toBe(5);
    expect(events).toHaveLength(5);
  });

  it("concurrent reveals of the SAME customer (two tabs, a retry, a second device) cost exactly one", async () => {
    const { revealCustomerEmails } = await import("../customer-email");
    const results = await Promise.all(Array.from({ length: 6 }, () => revealCustomerEmails(viewerOf("agent-1"), { contactId: "c3", now: NOON })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && r.charged)).toHaveLength(1);
    expect(usage.get("agent-1|2026-11-20")).toBe(1);
  });

  it("a failure while reading the addresses consumes nothing (the reveal record and the counter roll back with it)", async () => {
    const { revealCustomerEmails } = await import("../customer-email");
    vi.spyOn(console, "error").mockImplementation(() => {});
    failAddressRead = true;
    const r = await revealCustomerEmails(viewerOf("agent-1"), { contactId: "c0", now: NOON });
    expect(r).toMatchObject({ ok: false, code: "ERROR" });
    expect((r as { error: string }).error).toMatch(/Nothing was counted/);
    expect(events).toHaveLength(0);
    expect(usage.size).toBe(0);
    expect(audits).toHaveLength(0);
    failAddressRead = false;
    expect(await revealCustomerEmails(viewerOf("agent-1"), { contactId: "c0", now: NOON })).toMatchObject({ ok: true, charged: true, usage: { used: 1 } });
  });

  it("each user has their own allowance", async () => {
    const { revealCustomerEmails } = await import("../customer-email");
    for (let i = 0; i < 5; i++) await revealCustomerEmails(viewerOf("agent-1"), { contactId: `c${i}`, now: NOON });
    expect(await revealCustomerEmails(viewerOf("agent-2"), { contactId: "c0", now: NOON })).toMatchObject({ ok: true, charged: true, usage: { used: 1 } });
  });

  it("the allowance resets at midnight Pacific time, not at midnight UTC and not after 24 hours", async () => {
    const { revealCustomerEmails } = await import("../customer-email");
    const lateEvening = new Date("2026-11-21T07:59:00Z"); // 23:59 PST, Nov 20
    for (let i = 0; i < 5; i++) await revealCustomerEmails(viewerOf("agent-1"), { contactId: `c${i}`, now: lateEvening });
    expect(await revealCustomerEmails(viewerOf("agent-1"), { contactId: "c6", now: new Date("2026-11-21T07:59:59Z") })).toMatchObject({ ok: false, code: "LIMIT_REACHED" });
    // 00:00:00 PST on Nov 21 is a new business day (even though it is only one second later)
    expect(await revealCustomerEmails(viewerOf("agent-1"), { contactId: "c6", now: new Date("2026-11-21T08:00:00Z") })).toMatchObject({ ok: true, charged: true, usage: { used: 1 } });
  });

  it("an unrestricted viewer reveals without counting anything or writing any record", async () => {
    const { revealCustomerEmails } = await import("../customer-email");
    const r = await revealCustomerEmails(viewerOf("trusted-1", false), { contactId: "c0", now: NOON });
    expect(r).toMatchObject({ ok: true, charged: false, usage: { unlimited: true } });
    expect(events).toHaveLength(0);
    expect(usage.size).toBe(0);
  });

  it("when a contact has only the denormalized primary email, that one is returned", async () => {
    const { revealCustomerEmails } = await import("../customer-email");
    contactEmails = [];
    const r = await revealCustomerEmails(viewerOf("agent-1"), { contactId: "c2", now: NOON });
    expect(r).toMatchObject({ ok: true, addresses: [{ id: "primary:c2", address: "customer2@example.com" }] });
  });
});

describe("usage and today's reveals", () => {
  it("reports used / limit for a restricted viewer, and unlimited for everyone else", async () => {
    const { getEmailUsage, revealCustomerEmails } = await import("../customer-email");
    await revealCustomerEmails(viewerOf("agent-1"), { contactId: "c0", now: NOON });
    await revealCustomerEmails(viewerOf("agent-1"), { contactId: "c1", now: NOON });
    expect(await getEmailUsage(viewerOf("agent-1"), NOON)).toMatchObject({ used: 2, limit: 5, remaining: 3, unlimited: false });
    expect(await getEmailUsage(viewerOf("agent-1"), new Date("2026-11-22T20:00:00Z"))).toMatchObject({ used: 0, remaining: 5 });
    expect(await getEmailUsage(viewerOf("trusted-1", false), NOON)).toMatchObject({ unlimited: true });
  });

  it("revealedContactIdsToday lists only today's reveals for THIS user", async () => {
    const { revealCustomerEmails, revealedContactIdsToday } = await import("../customer-email");
    await revealCustomerEmails(viewerOf("agent-1"), { contactId: "c0", now: NOON });
    await revealCustomerEmails(viewerOf("agent-2"), { contactId: "c1", now: NOON });
    expect([...(await revealedContactIdsToday(viewerOf("agent-1"), ["c0", "c1", "c2"], NOON))]).toEqual(["c0"]);
    expect((await revealedContactIdsToday(viewerOf("agent-1"), ["c0"], new Date("2026-11-22T20:00:00Z"))).size).toBe(0);
  });
});

describe("what a page / list is given", () => {
  it("a restricted, not-yet-revealed customer: masked display, no address in the recipient options, masked rows", async () => {
    const { buildContactEmailView } = await import("../customer-email");
    const view = await buildContactEmailView({ id: "agent-1", role: "TRAVEL_AGENT", companyId: "co-1" }, "c0", [{ id: "e0", email: "customer0@example.com", isPrimary: true }], "customer0@example.com");
    expect(view.masked).toBe(true);
    expect(view.rows[0].email).toBe("c*******0@example.com");
    expect(view.primaryDisplay).toBe("c*******0@example.com");
    expect(view.recipients).toEqual([{ id: "e0", display: "c*******0@example.com", address: null }]);
    expect(view.privacy).toMatchObject({ masked: true, used: 0, limit: 5 });
    expect(JSON.stringify(view)).not.toContain("customer0@example.com");
  });

  it("after revealing that customer today the same page shows complete addresses (and keeps counting)", async () => {
    const { buildContactEmailView, revealCustomerEmails } = await import("../customer-email");
    await revealCustomerEmails(viewerOf("agent-1"), { contactId: "c0" });
    const view = await buildContactEmailView({ id: "agent-1", role: "TRAVEL_AGENT", companyId: "co-1" }, "c0", [{ id: "e0", email: "customer0@example.com", isPrimary: true }], "customer0@example.com");
    expect(view.masked).toBe(false);
    expect(view.rows[0].email).toBe("customer0@example.com");
    expect(view.privacy).toMatchObject({ masked: false, used: 1 });
  });

  it("an Administrator, and a user with Unlimited access, get complete addresses and no allowance UI", async () => {
    const { buildContactEmailView } = await import("../customer-email");
    for (const actor of [{ id: "admin-1", role: "ADMIN", companyId: "co-1" }, { id: "trusted-1", role: "TRAVEL_AGENT", companyId: "co-1" }]) {
      const view = await buildContactEmailView(actor, "c0", [{ id: "e0", email: "customer0@example.com", isPrimary: true }], "customer0@example.com");
      expect(view).toMatchObject({ masked: false, privacy: undefined });
      expect(view.recipients[0]).toMatchObject({ address: "customer0@example.com" });
    }
  });

  it("no signed-in viewer is treated as restricted", async () => {
    const { buildContactEmailView } = await import("../customer-email");
    const view = await buildContactEmailView(null, "c0", [{ id: "e0", email: "customer0@example.com", isPrimary: true }], "customer0@example.com");
    expect(view.masked).toBe(true);
    expect(JSON.stringify(view)).not.toContain("customer0@example.com");
  });

  it("withEmailPrivacy masks list rows for a restricted viewer, spares revealed customers, and returns rows untouched for others", async () => {
    const { withEmailPrivacy, revealCustomerEmails } = await import("../customer-email");
    await revealCustomerEmails(viewerOf("agent-1"), { contactId: "c1" });
    const rows = [{ id: "c0", primaryEmail: "customer0@example.com" }, { id: "c1", primaryEmail: "customer1@example.com" }, { id: "c9", primaryEmail: null }];
    const apply = (r: (typeof rows)[number], email: string | null) => ({ ...r, primaryEmail: email });
    const masked = await withEmailPrivacy({ id: "agent-1", role: "TRAVEL_AGENT", companyId: "co-1" }, rows, (r) => r, apply);
    expect(masked.map((r) => r.primaryEmail)).toEqual(["c*******0@example.com", "customer1@example.com", null]);
    expect(await withEmailPrivacy({ id: "admin-1", role: "ADMIN", companyId: "co-1" }, rows, (r) => r, apply)).toBe(rows);
    expect((await withEmailPrivacy(null, rows, (r) => r, apply))[1].primaryEmail).toBe("c*******1@example.com");
  });
});

describe("recipients by id", () => {
  it("resolves ids of THIS customer to addresses, and refuses an id that belongs to another customer, an unknown id, or another customer's primary handle", async () => {
    const { resolveRecipientIds } = await import("../customer-email");
    expect(await resolveRecipientIds("c0", ["e0"])).toEqual(["customer0@example.com"]);
    expect(await resolveRecipientIds("c0", ["e1"])).toBeNull();
    expect(await resolveRecipientIds("c0", ["nope"])).toBeNull();
    expect(await resolveRecipientIds("c0", ["primary:c1"])).toBeNull();
    expect(await resolveRecipientIds("c0", ["e0", "e1"])).toBeNull(); // one bad id refuses the whole send
    expect(await resolveRecipientIds("c0", [])).toEqual([]);
    expect(await resolveRecipientIds("c0", ["primary:c0"])).toEqual(["customer0@example.com"]);
  });

  it("a restricted viewer can never supply a raw address; an unrestricted one still can", async () => {
    const { resolveSendRecipients } = await import("../customer-email");
    await expect(resolveSendRecipients(viewerOf("agent-1"), "c0", { to: "customer0@example.com" })).rejects.toThrow(/Choose the recipient/);
    await expect(resolveSendRecipients(viewerOf("agent-1"), "c0", { to: "anyone@elsewhere.com" })).rejects.toThrow(/Choose the recipient/);
    expect(await resolveSendRecipients(viewerOf("agent-1"), "c0", { recipientIds: ["e0"] })).toBe("customer0@example.com");
    expect(await resolveSendRecipients(viewerOf("trusted-1", false), "c0", { to: "customer0@example.com" })).toBe("customer0@example.com");
    await expect(resolveSendRecipients(viewerOf("agent-1"), "c0", { recipientIds: ["e5"] })).rejects.toThrow(/not available/);
  });

  it("buildRecipientOptions exposes the address only when the viewer may see it", async () => {
    const { buildRecipientOptions } = await import("../customer-email");
    const emails = [{ id: "e1", email: "second@example.com", isPrimary: false }, { id: "e0", email: "first.person@example.com", isPrimary: true }];
    expect(buildRecipientOptions("c0", emails, null, false)).toEqual([
      { id: "e0", display: "f**********n@example.com", address: null },
      { id: "e1", display: "s****d@example.com", address: null },
    ]);
    expect(buildRecipientOptions("c0", emails, null, true).map((o) => o.address)).toEqual(["first.person@example.com", "second@example.com"]);
    expect(buildRecipientOptions("c0", [], "only@example.com", false)).toEqual([{ id: "primary:c0", display: "o**y@example.com", address: null }]);
  });
});

describe("recipientsMaySeeCustomerEmail - who may be shown an address inside an internal notification", () => {
  it("true only when EVERY recipient is an Administrator or has Unlimited access; false for any restricted, unknown, missing or unreadable recipient", async () => {
    const { prisma } = await import("@/lib/prisma");
    const rows = [
      { id: "admin", role: "ADMIN", unlimitedCustomerEmailAccess: false },
      { id: "trusted", role: "TRAVEL_AGENT", unlimitedCustomerEmailAccess: true },
      { id: "plain", role: "MANAGER", unlimitedCustomerEmailAccess: false },
    ];
    (prisma as unknown as { account: Record<string, unknown> }).account.findMany = vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => rows.filter((r) => where.id.in.includes(r.id)));
    const { recipientsMaySeeCustomerEmail } = await import("../customer-email");
    expect(await recipientsMaySeeCustomerEmail(["admin"])).toBe(true);
    expect(await recipientsMaySeeCustomerEmail(["admin", "trusted", "admin"])).toBe(true);
    expect(await recipientsMaySeeCustomerEmail(["admin", "plain"])).toBe(false); // one restricted recipient hides it from the one shared message
    expect(await recipientsMaySeeCustomerEmail(["ghost"])).toBe(false);
    expect(await recipientsMaySeeCustomerEmail(["admin", "ghost"])).toBe(false);
    expect(await recipientsMaySeeCustomerEmail([])).toBe(false);
    expect(await recipientsMaySeeCustomerEmail([undefined])).toBe(false);
    (prisma as unknown as { account: Record<string, unknown> }).account.findMany = vi.fn(async () => {
      throw new Error("db down");
    });
    expect(await recipientsMaySeeCustomerEmail(["admin"])).toBe(false); // unreadable -> fail closed
  });
});
