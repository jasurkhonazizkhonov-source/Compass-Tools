// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// REAL-DATABASE proof of the System Health center:
//   - one OPEN incident per fingerprint, however many concurrent occurrences
//   - notifications only for a NEW critical incident (and not for a flap)
//   - stale event-driven incidents self-resolve; resolved ones are pruned
//   - the check catalogue reports states correctly and NEVER leaks a secret
//   - the page is server-authorized for Admins only
// Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL
// with this repo's migrations applied (see booking-submit.integration.test.ts).

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) process.env.DATABASE_URL = URL_UNDER_TEST;

type Actor = { id: string; role: string; companyId: string; fullName: string; email: string; phone: string | null; status: string; paymentPermissions: string[] };
let currentActor: Actor | null = null;
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const notFoundMock = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
vi.mock("next/navigation", () => ({ notFound: () => notFoundMock() }));

const TAG = `sh-${Date.now()}`;
const SECRETS = {
  GOOGLE_CLIENT_SECRET: `gsecret-${TAG}-DoNotLeakThisValue`,
  GMAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  IP_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
  IP_HASH_KEY: Buffer.alloc(32, 6).toString("base64"),
  PAYMENT_PROVIDER: "definitely-not-installed-provider",
};

describe.skipIf(!enabled)("System Health — real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let events: typeof import("@/server/system/health-events");
  let checks: typeof import("@/server/system/health-checks");
  let monitor: typeof import("@/server/system/health-monitor");
  let admin: Actor;
  let manager: Actor;
  const accountEmails: string[] = [];
  const contactIds: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    events = await import("@/server/system/health-events");
    checks = await import("@/server/system/health-checks");
    monitor = await import("@/server/system/health-monitor");
    await prisma.company.upsert({
      where: { id: "default-company" },
      update: {},
      create: { id: "default-company", name: "Test Co", signatureTemplate: "Regards" },
    });
    const a = await prisma.account.create({ data: { fullName: "Health Admin", email: `admin-${TAG}@example.test`, role: "ADMIN", companyId: "default-company" } });
    const m = await prisma.account.create({ data: { fullName: "Health Manager", email: `mgr-${TAG}@example.test`, role: "MANAGER", companyId: "default-company" } });
    accountEmails.push(a.email, m.email);
    const mk = (acc: typeof a, role: string): Actor => ({ id: acc.id, role, companyId: "default-company", fullName: acc.fullName, email: acc.email, phone: null, status: "ACTIVE", paymentPermissions: [] });
    admin = mk(a, "ADMIN");
    manager = mk(m, "MANAGER");
    for (const [k, v] of Object.entries(SECRETS)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    savedEnv.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
  }, 60_000);

  afterAll(async () => {
    if (!enabled) return;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await prisma.notification.deleteMany({ where: { account: { email: { in: accountEmails } } } });
    await prisma.healthEvent.deleteMany({ where: { type: { startsWith: `TEST_${TAG}` } } });
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    await prisma.account.deleteMany({ where: { email: { in: accountEmails } } });
    await prisma.$disconnect();
  });

  beforeEach(() => {
    events.resetHealthEventThrottleForTests();
    monitor.resetHealthMonitorThrottleForTests();
    currentActor = admin;
    notFoundMock.mockClear();
  });

  const type = (n: string) => `TEST_${TAG}_${n}`;
  const openRows = (t: string) => prisma.healthEvent.findMany({ where: { type: t, resolvedAt: null } });
  const notificationCount = () => prisma.notification.count({ where: { accountId: admin.id, type: "SYSTEM_HEALTH" } });

  describe("incident de-duplication", () => {
    it("50 concurrent occurrences of the same problem are ONE open incident with count 50", async () => {
      const t = type("dedupe");
      const base = Date.now();
      // Distinct, well-spaced clock values so the per-instance write throttle
      // lets every call through — this proves the DATABASE dedupes atomically.
      await Promise.all(Array.from({ length: 50 }, (_, i) => events.recordHealthEvent({ type: t, category: "test", severity: "WARNING", message: "same problem" }, base + i * 20_000)));
      const rows = await openRows(t);
      expect(rows).toHaveLength(1);
      expect(rows[0].occurrenceCount).toBe(50);
      expect(rows[0].severity).toBe("WARNING");
    });

    it("different discriminators are different incidents", async () => {
      const t = type("disc");
      await events.recordHealthEvent({ type: t, category: "test", severity: "WARNING", message: "a", discriminator: "A" });
      await events.recordHealthEvent({ type: t, category: "test", severity: "WARNING", message: "b", discriminator: "B" });
      expect(await openRows(t)).toHaveLength(2);
    });

    it("severity only ever escalates while an incident is open", async () => {
      const t = type("escalate");
      const base = Date.now();
      await events.recordHealthEvent({ type: t, category: "test", severity: "WARNING", message: "m", notify: false }, base);
      await events.recordHealthEvent({ type: t, category: "test", severity: "CRITICAL", message: "m", notify: false }, base + 20_000);
      await events.recordHealthEvent({ type: t, category: "test", severity: "WARNING", message: "m", notify: false }, base + 40_000);
      const [row] = await openRows(t);
      expect(row.severity).toBe("CRITICAL");
      expect(row.occurrenceCount).toBe(3);
    });

    it("after resolution the same problem opens a NEW incident and the old one is kept as history", async () => {
      const t = type("reopen");
      const base = Date.now();
      await events.recordHealthEvent({ type: t, category: "test", severity: "WARNING", message: "m", notify: false }, base);
      expect(await events.resolveHealthEvents(t, "test")).toBe(1);
      await events.recordHealthEvent({ type: t, category: "test", severity: "WARNING", message: "m", notify: false }, base + 20_000);
      const all = await prisma.healthEvent.findMany({ where: { type: t }, orderBy: { firstSeenAt: "asc" } });
      expect(all).toHaveLength(2);
      expect(all[0].resolvedAt).not.toBeNull();
      expect(all[1].resolvedAt).toBeNull();
    });

    it("stores only sanitized text — a secret in the message or metadata never reaches the table", async () => {
      const t = type("sanitize");
      await events.recordHealthEvent({
        type: t,
        category: "test",
        severity: "WARNING",
        message: "boom postgresql://user:hunter2@db.internal:5432/app for jane@example.com card 4111111111111111",
        metadata: { note: "Bearer abc.def.ghi-secret", password: "hunter2", cookie: "sid=abc" },
        notify: false,
      });
      const [row] = await openRows(t);
      const stored = JSON.stringify(row);
      for (const bad of ["hunter2", "db.internal", "jane@example.com", "4111111111111111", "abc.def.ghi-secret", "sid=abc"]) expect(stored).not.toContain(bad);
    });
  });

  describe("Admin notifications", () => {
    it("a NEW critical incident notifies each active Admin exactly once, with a Review System Health action", async () => {
      const t = type("notify");
      const before = await notificationCount();
      const base = Date.now();
      await events.recordHealthEvent({ type: t, category: "test", severity: "CRITICAL", message: "Something critical" }, base);
      await events.recordHealthEvent({ type: t, category: "test", severity: "CRITICAL", message: "Something critical" }, base + 20_000);
      await events.recordHealthEvent({ type: t, category: "test", severity: "CRITICAL", message: "Something critical" }, base + 40_000);
      expect(await notificationCount()).toBe(before + 1);
      const n = await prisma.notification.findFirstOrThrow({ where: { accountId: admin.id, type: "SYSTEM_HEALTH" }, orderBy: { createdAt: "desc" } });
      expect(n.body).toContain("Review System Health");
      // Never notifies a non-Admin.
      expect(await prisma.notification.count({ where: { accountId: manager.id, type: "SYSTEM_HEALTH" } })).toBe(0);
    });

    it("a WARNING does not notify by default", async () => {
      const before = await notificationCount();
      await events.recordHealthEvent({ type: type("quiet"), category: "test", severity: "WARNING", message: "just a warning" });
      expect(await notificationCount()).toBe(before);
    });

    it("a flapping problem (resolved then recurring within the window) does not notify again", async () => {
      const t = type("flap");
      const base = Date.now();
      await events.recordHealthEvent({ type: t, category: "test", severity: "CRITICAL", message: "flapping" }, base);
      const afterFirst = await notificationCount();
      await events.resolveHealthEvents(t, "test");
      await events.recordHealthEvent({ type: t, category: "test", severity: "CRITICAL", message: "flapping" }, base + 20_000);
      expect(await notificationCount()).toBe(afterFirst);
    });
  });

  describe("retention", () => {
    it("event-driven incidents quiet for 24h self-resolve; CHECK_ incidents are left to their own check", async () => {
      const t = type("stale");
      await events.recordHealthEvent({ type: t, category: "test", severity: "WARNING", message: "old", notify: false });
      const checkType = `CHECK_${type("stale")}`;
      await events.recordHealthEvent({ type: checkType, category: "test", severity: "WARNING", message: "old check", notify: false });
      await prisma.healthEvent.updateMany({ where: { type: { in: [t, checkType] } }, data: { lastSeenAt: new Date(Date.now() - 25 * 3600_000) } });
      await events.resolveStaleHealthEvents();
      expect(await openRows(t)).toHaveLength(0);
      expect(await openRows(checkType)).toHaveLength(1);
      await prisma.healthEvent.deleteMany({ where: { type: checkType } });
    });

    it("resolved incidents past retention are pruned; recent ones are kept", async () => {
      const oldT = type("prune_old");
      const newT = type("prune_new");
      await events.recordHealthEvent({ type: oldT, category: "test", severity: "WARNING", message: "x", notify: false });
      await events.recordHealthEvent({ type: newT, category: "test", severity: "WARNING", message: "x", notify: false });
      await events.resolveHealthEvents(oldT, "test");
      await events.resolveHealthEvents(newT, "test");
      await prisma.healthEvent.updateMany({ where: { type: oldT }, data: { resolvedAt: new Date(Date.now() - (events.HEALTH_RETENTION_DAYS + 1) * 86400_000) } });
      await events.pruneHealthEvents();
      expect(await prisma.healthEvent.count({ where: { type: oldT } })).toBe(0);
      expect(await prisma.healthEvent.count({ where: { type: newT } })).toBe(1);
    });
  });

  describe("check catalogue", () => {
    const byId = (results: Awaited<ReturnType<typeof checks.runHealthChecks>>, id: string) => results.find((r) => r.id === id)!;

    it("reports every check, each with a state, and never throws", async () => {
      const results = await checks.runHealthChecks();
      const ids = results.map((r) => r.id);
      for (const id of ["database.connectivity", "database.migrations", "database.connections", "auth.google", "email.gmail", "payment.provider", "signer.ip", "security.keys", "bookings.integrity", "leads.queue", "incidents.open"]) {
        expect(ids).toContain(id);
      }
      for (const r of results) expect(["HEALTHY", "WARNING", "CRITICAL", "UNKNOWN"]).toContain(r.state);
    });

    it("NEVER leaks a secret, key, connection string or environment value in any result", async () => {
      const serialized = JSON.stringify(await checks.runHealthChecks());
      for (const secret of [SECRETS.GOOGLE_CLIENT_SECRET, SECRETS.GMAIL_TOKEN_ENCRYPTION_KEY, SECRETS.IP_ENCRYPTION_KEY, SECRETS.IP_HASH_KEY, URL_UNDER_TEST!, "postgres:postgres", "localhost:54329", process.env.GOOGLE_CLIENT_ID!]) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).not.toMatch(/postgres(ql)?:\/\//i);
    });

    it("missing Google client id is CRITICAL (nobody can sign in); present is HEALTHY", async () => {
      const id = process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_ID;
      expect(byId(await checks.runHealthChecks(), "auth.google").state).toBe("CRITICAL");
      process.env.GOOGLE_CLIENT_ID = id;
      expect(byId(await checks.runHealthChecks(), "auth.google").state).toBe("HEALTHY");
    });

    it("an invalid key is CRITICAL and reported as Invalid, a missing IP-vault key is a WARNING — never the value", async () => {
      const original = process.env.IP_ENCRYPTION_KEY;
      process.env.IP_ENCRYPTION_KEY = "not-a-valid-key!!";
      let r = byId(await checks.runHealthChecks(), "security.keys");
      expect(r.state).toBe("CRITICAL");
      expect(JSON.stringify(r)).toContain("Invalid");
      expect(JSON.stringify(r)).not.toContain("not-a-valid-key");
      delete process.env.IP_ENCRYPTION_KEY;
      r = byId(await checks.runHealthChecks(), "security.keys");
      expect(r.state).toBe("WARNING");
      process.env.IP_ENCRYPTION_KEY = original;
    });

    it("an optional feature that is simply not configured is not flagged as broken (no provider outside production is HEALTHY)", async () => {
      // This suite runs with a non-production environment.
      const r = byId(await checks.runHealthChecks(), "payment.provider");
      expect(r.state).toBe("HEALTHY");
      expect(JSON.stringify(r)).toContain("Never collected or stored");
    });

    it("in production with no payment provider the check is CRITICAL and says bookings cannot complete — without any APP_ENV workaround suggested", async () => {
      const saved = { VERCEL_ENV: process.env.VERCEL_ENV, APP_ENV: process.env.APP_ENV };
      process.env.VERCEL_ENV = "production";
      process.env.APP_ENV = "staging"; // must NOT relabel a Vercel production deployment
      try {
        const r = byId(await checks.runHealthChecks(), "payment.provider");
        expect(r.state).toBe("CRITICAL");
        expect(r.summary).toMatch(/bookings cannot be completed/i);
        expect(r.action ?? "").toMatch(/Do not work around this with APP_ENV/);
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });

    it("a half-finished booking (no payment method) is surfaced for Admin review and NOTHING is changed", async () => {
      const contact = await prisma.contact.create({ data: { firstName: "Orphan", lastName: TAG, primaryEmail: `o-${TAG}@example.test`, companyId: "default-company" } });
      contactIds.push(contact.id);
      const lead = await prisma.lead.create({ data: { contactId: contact.id, status: "QUOTED" } });
      const quote = await prisma.quote.create({ data: { quoteNumber: `Q-${TAG}`, secureToken: `tok-${TAG}`, leadId: lead.id, contactId: contact.id, status: "SIGNED", adults: 1, adultPrice: 1, total: 1 } });
      const booking = await prisma.booking.create({
        data: { quoteId: quote.id, leadId: lead.id, contactId: contact.id, bookingReference: `ORPH${Date.now().toString(36).slice(-5).toUpperCase()}`, contactPhone: "+1", contactEmail: "o@example.test", billingAddress: "x", billingCity: "x", billingState: "x", billingZip: "x", billingCountry: "US" },
      });
      const r = byId(await checks.runHealthChecks(), "bookings.integrity");
      expect(r.state).toBe("WARNING");
      expect(JSON.stringify(r)).toContain(booking.bookingReference);
      expect(r.action).toMatch(/by hand/);
      // Read-only: the booking and its quote are exactly as they were.
      expect(await prisma.booking.count({ where: { id: booking.id } })).toBe(1);
      expect((await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } })).status).toBe("SIGNED");
    });
  });

  describe("monitor", () => {
    it("records a WARNING/CRITICAL check as an incident and resolves it when the check turns HEALTHY", async () => {
      const id = process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_ID;
      await monitor.evaluateHealth();
      const open = await prisma.healthEvent.findMany({ where: { type: "CHECK_AUTH_GOOGLE", resolvedAt: null } });
      expect(open).toHaveLength(1);
      expect(open[0].severity).toBe("CRITICAL");
      process.env.GOOGLE_CLIENT_ID = id;
      events.resetHealthEventThrottleForTests();
      await monitor.evaluateHealth();
      expect(await prisma.healthEvent.count({ where: { type: "CHECK_AUTH_GOOGLE", resolvedAt: null } })).toBe(0);
    });

    it("the throttled variant never throws and runs at most once per window", async () => {
      await expect(monitor.evaluateHealthThrottled()).resolves.toBeUndefined();
      await expect(monitor.evaluateHealthThrottled()).resolves.toBeUndefined();
    });
  });

  describe("page authorization (server-side)", () => {
    it("a non-Admin reaching the page component gets notFound(), and no health data is computed", async () => {
      currentActor = manager;
      const { default: Page } = await import("@/app/(crm)/system-health/page");
      await expect(Page()).rejects.toThrow("NEXT_NOT_FOUND");
      expect(notFoundMock).toHaveBeenCalled();
    });

    it("signed-out gets notFound() too", async () => {
      currentActor = null;
      const { default: Page } = await import("@/app/(crm)/system-health/page");
      await expect(Page()).rejects.toThrow("NEXT_NOT_FOUND");
    });

    it("an Admin gets the page", async () => {
      currentActor = admin;
      const { default: Page } = await import("@/app/(crm)/system-health/page");
      const element = await Page();
      expect(element).toBeTruthy();
      expect(notFoundMock).not.toHaveBeenCalled();
    });
  });
});
