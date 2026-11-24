// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

// REAL-DATABASE proof of the counter behind "failures only" limits, and that it is shared (it lives in PostgreSQL, not in a process), so any number of app instances
// see the same count. Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE database (src/test/integration-database-guard.ts).
const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
  process.env.CARD_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_HASH_KEY ??= randomBytes(32).toString("base64");
}
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));

const TAG = `rl-${Date.now()}`;
const CONFIG = { windowMs: 15 * 60 * 1000, maxAttempts: 3 };

describe.skipIf(!enabled)("failures-only rate limiting - real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let limiter: typeof import("../rate-limit");

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    limiter = await import("../rate-limit");
  });
  afterAll(async () => {
    if (!enabled) return;
    await prisma.rateLimitCounter.deleteMany({ where: { key: { startsWith: `${TAG}` } } });
    await prisma.$disconnect();
  });

  it("peeking never increments: a client that only ever succeeds is never limited, however many times it is checked", async () => {
    const ip = `${TAG}-office`;
    for (let i = 0; i < 100; i++) expect(await limiter.peekRateLimitForKey(ip, "SIGN_IN_FAILURES", CONFIG)).toEqual({ allowed: true });
    expect(await prisma.rateLimitCounter.count({ where: { key: { startsWith: ip } } })).toBe(0);
  });

  it("only recorded failures use up the allowance: allowed until maxAttempts failures, then refused with an exact retry time, and other clients are unaffected", async () => {
    const attacker = `${TAG}-attacker`;
    for (let i = 0; i < 3; i++) {
      expect(await limiter.peekRateLimitForKey(attacker, "SIGN_IN_FAILURES", CONFIG)).toEqual({ allowed: true });
      await limiter.checkPublicRateLimitForKey(attacker, "SIGN_IN_FAILURES", CONFIG); // one failure recorded
    }
    const blocked = await limiter.peekRateLimitForKey(attacker, "SIGN_IN_FAILURES", CONFIG);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
    }
    expect(await limiter.peekRateLimitForKey(`${TAG}-someone-else`, "SIGN_IN_FAILURES", CONFIG)).toEqual({ allowed: true });
    // a different kind of limit for the same client is its own counter
    expect(await limiter.peekRateLimitForKey(attacker, "SOMETHING_ELSE", CONFIG)).toEqual({ allowed: true });
  });

  it("the count is shared through the database: many simultaneous recordings (several app instances) add up exactly", async () => {
    const ip = `${TAG}-burst`;
    await Promise.all(Array.from({ length: 20 }, () => limiter.checkPublicRateLimitForKey(ip, "SIGN_IN_FAILURES", { windowMs: 15 * 60 * 1000, maxAttempts: 1000 })));
    const bucket = Math.floor(Date.now() / (15 * 60 * 1000));
    const row = await prisma.rateLimitCounter.findUniqueOrThrow({ where: { key: `${ip}|SIGN_IN_FAILURES|${bucket}` } });
    expect(row.count).toBe(20);
  });

  it("an account limit is keyed by the ACCOUNT, never the IP: two people on one office address have separate allowances", async () => {
    const config = { windowMs: 15 * 60 * 1000, maxAttempts: 2 };
    for (let i = 0; i < 2; i++) expect((await limiter.checkAccountRateLimit(`${TAG}-alice`, "DATABASE_BACKUP_CREATE", config)).allowed).toBe(true);
    expect((await limiter.checkAccountRateLimit(`${TAG}-alice`, "DATABASE_BACKUP_CREATE", config)).allowed).toBe(false);
    expect((await limiter.checkAccountRateLimit(`${TAG}-bob`, "DATABASE_BACKUP_CREATE", config)).allowed).toBe(true);
    await prisma.rateLimitCounter.deleteMany({ where: { key: { contains: `${TAG}-` } } });
  });

  it("describes a wait in plain words", () => {
    expect(limiter.describeWait(30)).toBe("30 seconds");
    expect(limiter.describeWait(89)).toBe("89 seconds");
    expect(limiter.describeWait(90)).toBe("2 minutes");
    expect(limiter.describeWait(900)).toBe("15 minutes");
    expect(limiter.describeWait(0)).toBe("1 second");
  });
});
