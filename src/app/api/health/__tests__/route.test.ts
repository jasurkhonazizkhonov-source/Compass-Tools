import { describe, it, expect, vi, beforeEach } from "vitest";

const queryRaw = vi.fn();
vi.mock("@/server/system/migration-status", () => ({ getMigrationStatus: vi.fn(async () => ({ state: "current", expected: 55, applied: 55, pending: [] })) }));
vi.mock("@/lib/prisma", () => ({
  prisma: { $queryRaw: (...args: unknown[]) => queryRaw(...args) },
  getPrismaPoolStats: () => ({ total: 2, idle: 1, waiting: 0 }),
  getPoolSettings: () => ({ max: 5, connectionTimeoutMillis: 8000, idleTimeoutMillis: 10000, connectRetries: 2 }),
}));

beforeEach(async () => {
  queryRaw.mockReset();
  const { resetHealthCacheForTests } = await import("@/lib/health-check");
  resetHealthCacheForTests();
});

describe("GET /api/health", () => {
  it("reports ok with round-trip timings and pool occupancy when the database answers", async () => {
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const { GET } = await import("../route");

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.status).toBe("ok");
    expect(body.database.ok).toBe(true);
    expect(typeof body.database.secondQueryMs).toBe("number");
    expect(body.pool).toEqual({ max: 5, total: 2, idle: 1, waiting: 0 });
  });

  const KEYS = ["APP_ENV", "TRUSTED_PROXY", "CARD_ENCRYPTION_KEY", "VERCEL", "VERCEL_ENV"];
  async function withEnv(vars: Record<string, string | undefined>, fn: (get: () => Promise<{ readiness: Record<string, unknown> }>) => Promise<void>) {
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
    try {
      const { resetHealthCacheForTests } = await import("@/lib/health-check");
      const { GET } = await import("../route");
      await fn(async () => {
        resetHealthCacheForTests();
        return (await GET()).json();
      });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }
  const GOOD_KEY = Buffer.alloc(32, 9).toString("base64");

  it("reports whether a customer's Finish Booking can store a card RIGHT NOW (categories only): the production guard, and the vault key", async () => {
    queryRaw.mockResolvedValue([{}]);
    await withEnv({ APP_ENV: "staging", TRUSTED_PROXY: "vercel", CARD_ENCRYPTION_KEY: GOOD_KEY }, async (get) => {
      expect((await get()).readiness).toEqual({ bookingCardStorage: "available", cardVaultKey: "configured", signerIpCapture: "enabled", schema: "current", pendingMigrations: 0 });
    });
    await withEnv({ APP_ENV: "production", CARD_ENCRYPTION_KEY: GOOD_KEY }, async (get) => {
      const body = await get();
      expect(body.readiness).toEqual({ bookingCardStorage: "unavailable", cardVaultKey: "configured", signerIpCapture: "disabled", schema: "current", pendingMigrations: 0 });
      expect(JSON.stringify(body)).not.toContain(GOOD_KEY);
    });
  });

  it("a missing or malformed CARD_ENCRYPTION_KEY makes card storage unavailable and is reported as a category, never a value", async () => {
    queryRaw.mockResolvedValue([{}]);
    await withEnv({ APP_ENV: "staging" }, async (get) => {
      expect((await get()).readiness).toMatchObject({ bookingCardStorage: "unavailable", cardVaultKey: "missing" });
    });
    await withEnv({ APP_ENV: "staging", CARD_ENCRYPTION_KEY: "short-and-wrong-value" }, async (get) => {
      const body = await get();
      expect(body.readiness).toMatchObject({ bookingCardStorage: "unavailable", cardVaultKey: "invalid" });
      expect(JSON.stringify(body)).not.toContain("short-and-wrong-value");
    });
  });

  it("on Vercel the signer-IP capture is reported enabled without any TRUSTED_PROXY setting; an explicit none turns it off", async () => {
    queryRaw.mockResolvedValue([{}]);
    const original = { TRUSTED_PROXY: process.env.TRUSTED_PROXY, VERCEL: process.env.VERCEL };
    try {
      delete process.env.TRUSTED_PROXY;
      process.env.VERCEL = "1";
      const { resetHealthCacheForTests } = await import("@/lib/health-check");
      resetHealthCacheForTests();
      const { GET } = await import("../route");
      expect((await (await GET()).json()).readiness.signerIpCapture).toBe("enabled");
      process.env.TRUSTED_PROXY = "none";
      resetHealthCacheForTests();
      expect((await (await GET()).json()).readiness.signerIpCapture).toBe("disabled");
    } finally {
      for (const [k, v] of Object.entries(original)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("returns 503 with only a safe error category — never the message, which can embed connection detail", async () => {
    queryRaw.mockRejectedValue(new Error("connect ECONNREFUSED postgres://user:s3cret@db.internal:5432/app"));
    const { GET } = await import("../route");

    const res = await GET();
    const text = await res.text();

    expect(res.status).toBe(503);
    expect(text).toContain('"status":"down"');
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("db.internal");
    expect(text).not.toContain("postgres://");
  });

  it("memoizes briefly so a flood of requests cannot become a flood of database queries", async () => {
    queryRaw.mockResolvedValue([{}]);
    const { GET } = await import("../route");

    await Promise.all([GET(), GET(), GET()]);
    await GET();

    // Two queries per real check, one real check for the whole burst.
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});
