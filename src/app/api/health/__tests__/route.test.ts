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

  it("reports configuration readiness for the booking flow (never values): card storage and signer-IP capture", async () => {
    queryRaw.mockResolvedValue([{}]);
    const original = { APP_ENV: process.env.APP_ENV, TRUSTED_PROXY: process.env.TRUSTED_PROXY };
    try {
      process.env.APP_ENV = "staging";
      process.env.TRUSTED_PROXY = "vercel";
      const { resetHealthCacheForTests } = await import("@/lib/health-check");
      resetHealthCacheForTests();
      const { GET } = await import("../route");
      expect((await (await GET()).json()).readiness).toEqual({ bookingCardStorage: "available", paymentProvider: "not_configured", signerIpCapture: "enabled", schema: "current", pendingMigrations: 0 });

      process.env.APP_ENV = "production";
      delete process.env.TRUSTED_PROXY;
      resetHealthCacheForTests();
      const body = await (await GET()).json();
      expect(body.readiness).toEqual({ bookingCardStorage: "unavailable", paymentProvider: "not_configured", signerIpCapture: "disabled", schema: "current", pendingMigrations: 0 });
      expect(JSON.stringify(body)).not.toContain("vercel");
    } finally {
      for (const [k, v] of Object.entries(original)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("APP_ENV cannot relabel a Vercel production deployment: card storage stays unavailable even with APP_ENV=staging", async () => {
    queryRaw.mockResolvedValue([{}]);
    const original = { APP_ENV: process.env.APP_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
    try {
      process.env.APP_ENV = "staging";
      process.env.VERCEL_ENV = "production";
      const { resetHealthCacheForTests } = await import("@/lib/health-check");
      resetHealthCacheForTests();
      const { GET } = await import("../route");
      expect((await (await GET()).json()).readiness.bookingCardStorage).toBe("unavailable");
    } finally {
      for (const [k, v] of Object.entries(original)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
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
