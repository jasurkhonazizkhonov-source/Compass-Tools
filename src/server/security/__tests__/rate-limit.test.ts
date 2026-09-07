import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass 25 §28 / Pass 28 §30 — checkPublicRateLimit is a DB-backed,
// serverless-safe (Vercel-deployed — no shared in-memory state across
// instances) rate limiter for public endpoints, keyed by client IP. The
// properties that actually matter: (1) under the limit, requests are
// allowed and counted; over the limit, rejected; (2) when no trustworthy
// IP is available (TRUSTED_PROXY unset), it fails OPEN — never collapses
// every unkeyable request into one shared bucket, which would risk
// locking out every legitimate customer at once; (3) — new in Pass 28 —
// the actual increment is a single atomic upsert (`$queryRaw` with
// `ON CONFLICT ... DO UPDATE ... RETURNING count`), not a separate
// count-then-write pair, so this test's mock models that exact shape
// (one atomic increment-and-return per call) rather than a count() +
// create() pair, to keep the test honest about what the real code path
// now does.

let counters: Map<string, { count: number; expiresAt: Date }>;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // Mocks the tagged-template call shape Prisma's $queryRaw uses:
    // (stringsArray, ...interpolatedValues). Our query interpolates
    // (id, key, expiresAt) in that order — `id` is unused here since the
    // mock doesn't need a real row id, only the key->count relationship
    // the real UNIQUE (key) upsert enforces.
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, _id: string, key: string, expiresAt: Date) => {
      const existing = counters.get(key);
      const count = (existing?.count ?? 0) + 1;
      counters.set(key, { count, expiresAt });
      return [{ count }];
    }),
    rateLimitCounter: {
      deleteMany: vi.fn(async ({ where }: { where: { expiresAt: { lt: Date } } }) => {
        let deleted = 0;
        for (const [k, v] of counters) {
          if (v.expiresAt < where.expiresAt.lt) {
            counters.delete(k);
            deleted++;
          }
        }
        return { count: deleted };
      }),
    },
  },
}));

vi.mock("@/lib/request-ip", () => ({
  getClientIp: vi.fn(),
}));

beforeEach(() => {
  counters = new Map();
  vi.clearAllMocks();
});

describe("checkPublicRateLimit", () => {
  it("allows requests under the limit, and records each one", async () => {
    const { getClientIp } = await import("@/lib/request-ip");
    vi.mocked(getClientIp).mockReturnValue("203.0.113.42");
    const { checkPublicRateLimit } = await import("../rate-limit");

    for (let i = 0; i < 5; i++) {
      const result = await checkPublicRateLimit(new Headers(), "TEST_ENDPOINT", { windowMs: 60_000, maxAttempts: 10 });
      expect(result.allowed).toBe(true);
    }
    expect(counters.size).toBe(1); // same IP+endpoint+window bucket -> one row, incremented
    expect([...counters.values()][0].count).toBe(5);
  });

  it("rejects once the limit within the window is reached", async () => {
    const { getClientIp } = await import("@/lib/request-ip");
    vi.mocked(getClientIp).mockReturnValue("203.0.113.42");
    const { checkPublicRateLimit } = await import("../rate-limit");

    for (let i = 0; i < 3; i++) {
      await checkPublicRateLimit(new Headers(), "TEST_ENDPOINT", { windowMs: 60_000, maxAttempts: 3 });
    }
    const fourth = await checkPublicRateLimit(new Headers(), "TEST_ENDPOINT", { windowMs: 60_000, maxAttempts: 3 });
    expect(fourth.allowed).toBe(false);
  });

  it("different IPs are tracked completely independently — one IP hitting the limit never blocks another", async () => {
    const { getClientIp } = await import("@/lib/request-ip");
    const { checkPublicRateLimit } = await import("../rate-limit");

    vi.mocked(getClientIp).mockReturnValue("203.0.113.42");
    await checkPublicRateLimit(new Headers(), "TEST_ENDPOINT", { windowMs: 60_000, maxAttempts: 1 });
    const blockedForFirstIp = await checkPublicRateLimit(new Headers(), "TEST_ENDPOINT", { windowMs: 60_000, maxAttempts: 1 });
    expect(blockedForFirstIp.allowed).toBe(false);

    vi.mocked(getClientIp).mockReturnValue("198.51.100.7");
    const allowedForSecondIp = await checkPublicRateLimit(new Headers(), "TEST_ENDPOINT", { windowMs: 60_000, maxAttempts: 1 });
    expect(allowedForSecondIp.allowed).toBe(true);
  });

  it("different endpoints are tracked independently for the same IP — exhausting one never blocks another", async () => {
    const { getClientIp } = await import("@/lib/request-ip");
    vi.mocked(getClientIp).mockReturnValue("203.0.113.42");
    const { checkPublicRateLimit } = await import("../rate-limit");

    await checkPublicRateLimit(new Headers(), "BOOKING_SUBMIT", { windowMs: 60_000, maxAttempts: 1 });
    const blockedForBooking = await checkPublicRateLimit(new Headers(), "BOOKING_SUBMIT", { windowMs: 60_000, maxAttempts: 1 });
    expect(blockedForBooking.allowed).toBe(false);

    const allowedForCancellation = await checkPublicRateLimit(new Headers(), "CANCELLATION_SUBMIT", { windowMs: 60_000, maxAttempts: 1 });
    expect(allowedForCancellation.allowed).toBe(true);
  });

  it("fails OPEN (never blocks, never writes a row) when no trustworthy client IP is available", async () => {
    const { getClientIp } = await import("@/lib/request-ip");
    vi.mocked(getClientIp).mockReturnValue(undefined);
    const { checkPublicRateLimit } = await import("../rate-limit");

    const result = await checkPublicRateLimit(new Headers(), "TEST_ENDPOINT", { windowMs: 60_000, maxAttempts: 1 });
    expect(result.allowed).toBe(true);
    // Critically: no shared "unknown" bucket entry was created either —
    // an unkeyable request leaves no trace that could later block a
    // DIFFERENT unkeyable request.
    expect(counters.size).toBe(0);
  });

  it("many rapid unkeyable requests never accumulate into a shared lockout", async () => {
    const { getClientIp } = await import("@/lib/request-ip");
    vi.mocked(getClientIp).mockReturnValue(undefined);
    const { checkPublicRateLimit } = await import("../rate-limit");

    for (let i = 0; i < 50; i++) {
      const result = await checkPublicRateLimit(new Headers(), "TEST_ENDPOINT", { windowMs: 60_000, maxAttempts: 1 });
      expect(result.allowed).toBe(true);
    }
  });

  // Pass 28 §30 — the actual point of the rewrite: N "concurrent" calls
  // (fired without awaiting each other first, exactly modeling a genuine
  // simultaneous burst) against the SAME key must never let more than
  // maxAttempts succeed. The mock's Map-based increment is synchronous
  // JS (no real interleaving), which is a real limitation of this test —
  // it proves the ALGORITHM is correct (strict count-then-compare, one
  // shared counter, no duplicate "fresh" reads), but a genuine two-
  // Postgres-connection race can only be proven against a real database,
  // which this unit-test harness does not have. Documented, not hidden.
  it("a burst of concurrent-fired requests against the same key never lets more than maxAttempts through", async () => {
    const { getClientIp } = await import("@/lib/request-ip");
    vi.mocked(getClientIp).mockReturnValue("203.0.113.42");
    const { checkPublicRateLimit } = await import("../rate-limit");

    const results = await Promise.all(
      Array.from({ length: 10 }, () => checkPublicRateLimit(new Headers(), "TEST_ENDPOINT", { windowMs: 60_000, maxAttempts: 3 }))
    );
    const allowedCount = results.filter((r) => r.allowed).length;
    expect(allowedCount).toBe(3);
  });

  it("a fixed window boundary allows a fresh quota — the documented trade-off for single-statement atomicity", async () => {
    vi.useFakeTimers();
    try {
      const { getClientIp } = await import("@/lib/request-ip");
      vi.mocked(getClientIp).mockReturnValue("203.0.113.42");
      const { checkPublicRateLimit } = await import("../rate-limit");

      vi.setSystemTime(new Date(0));
      await checkPublicRateLimit(new Headers(), "TEST_ENDPOINT", { windowMs: 60_000, maxAttempts: 1 });
      const blocked = await checkPublicRateLimit(new Headers(), "TEST_ENDPOINT", { windowMs: 60_000, maxAttempts: 1 });
      expect(blocked.allowed).toBe(false);

      // Cross into the next 60s window bucket.
      vi.setSystemTime(new Date(61_000));
      const nextWindow = await checkPublicRateLimit(new Headers(), "TEST_ENDPOINT", { windowMs: 60_000, maxAttempts: 1 });
      expect(nextWindow.allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("cleanupExpiredRateLimitCounters", () => {
  it("deletes only rows whose window has already expired", async () => {
    const { cleanupExpiredRateLimitCounters } = await import("../rate-limit");
    counters.set("expired-key", { count: 5, expiresAt: new Date(Date.now() - 1000) });
    counters.set("live-key", { count: 2, expiresAt: new Date(Date.now() + 100_000) });

    const result = await cleanupExpiredRateLimitCounters();
    expect(result.deleted).toBe(1);
    expect(counters.has("expired-key")).toBe(false);
    expect(counters.has("live-key")).toBe(true);
  });
});
