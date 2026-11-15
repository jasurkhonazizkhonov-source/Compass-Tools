import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const queryRaw = vi.fn();
vi.mock("@/server/system/migration-status", () => ({ getMigrationStatus: vi.fn(async () => ({ state: "current", expected: 55, applied: 55, pending: [] })) }));
vi.mock("@/lib/prisma", () => ({
  prisma: { $queryRaw: (...args: unknown[]) => queryRaw(...args) },
  getPrismaPoolStats: () => ({ total: 2, idle: 1, waiting: 0 }),
  getPoolSettings: () => ({ max: 5, connectionTimeoutMillis: 8000, idleTimeoutMillis: 10000, connectRetries: 2 }),
}));

// The detailed report needs the internal secret; the public answer is minimal (see the "public answer" block below). A throwaway test value.
const INTERNAL_SECRET = "unit-test-cron-secret-0123456789-abcdef";
const detail = () => new Request("http://localhost/api/health", { headers: { authorization: `Bearer ${INTERNAL_SECRET}` } });
const anonymous = () => new Request("http://localhost/api/health");

beforeEach(async () => {
  queryRaw.mockReset();
  vi.stubEnv("CRON_SECRET", INTERNAL_SECRET);
  const { resetHealthCacheForTests } = await import("@/lib/health-check");
  resetHealthCacheForTests();
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/health - the PUBLIC answer is minimal", () => {
  it("an anonymous caller gets only a generic status and the HTTP code: 200 + {status:ok} when the database answers", async () => {
    queryRaw.mockResolvedValue([{}]);
    const { GET } = await import("../route");
    const res = await GET(anonymous());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("an anonymous caller gets 503 + {status:down} when the database is down - never the error category, timings, pool or readiness", async () => {
    queryRaw.mockRejectedValue(new Error("connect ECONNREFUSED postgres://user:s3cret@db.internal:5432/app"));
    const { GET } = await import("../route");
    const res = await GET(anonymous());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "down" });
  });

  it("no detail leaks without the secret: a wrong secret, a malformed header, an empty Bearer, and the secret in a query string are all the minimal answer", async () => {
    queryRaw.mockResolvedValue([{}]);
    const { GET } = await import("../route");
    const attempts = [
      new Request("http://localhost/api/health", { headers: { authorization: "Bearer wrong-secret-value" } }),
      new Request("http://localhost/api/health", { headers: { authorization: INTERNAL_SECRET } }), // no "Bearer "
      new Request("http://localhost/api/health", { headers: { authorization: "Bearer " } }),
      new Request(`http://localhost/api/health?token=${INTERNAL_SECRET}&detail=1`),
      new Request("http://localhost/api/health", { headers: { "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1", host: "localhost" } }), // looking "internal" is not credentials
    ];
    for (const req of attempts) expect(await (await GET(req)).json(), req.url).toEqual({ status: "ok" });
    expect(await (await GET()).json()).toEqual({ status: "ok" }); // and a call with no request object at all
  });

  it("when CRON_SECRET is not configured nobody gets the detail - not even a request that sends an empty or guessed token", async () => {
    vi.stubEnv("CRON_SECRET", "");
    queryRaw.mockResolvedValue([{}]);
    const { GET } = await import("../route");
    for (const auth of ["Bearer ", "Bearer undefined", "Bearer null", ""]) {
      const res = await GET(new Request("http://localhost/api/health", { headers: { authorization: auth } }));
      expect(await res.json(), auth).toEqual({ status: "ok" });
    }
  });

  it("the public body never contains configuration, versions, environment, hostnames or counts - however the deployment is set up", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://compass:secret-pw@db.internal:5432/compass");
    vi.stubEnv("APP_ENV", "production");
    queryRaw.mockResolvedValue([{}]);
    const { GET } = await import("../route");
    const text = await (await GET(anonymous())).text();
    expect(text).toBe('{"status":"ok"}');
    expect(text).not.toMatch(/readiness|database|pool|schema|migrat|cardVault|databaseTls|environment|upload|websiteApi|leadIngest|checkedAt|production|secret-pw|db\.internal/i);
  });

  it("the Docker/monitor contract is intact: the HTTP code alone tells up (200) from down (503), and the body is JSON with a string status", async () => {
    const { GET } = await import("../route");
    queryRaw.mockResolvedValue([{}]);
    let res = await GET(anonymous());
    expect([res.status, res.headers.get("content-type")?.includes("application/json"), typeof (await res.json()).status]).toEqual([200, true, "string"]);
    const { resetHealthCacheForTests } = await import("@/lib/health-check");
    resetHealthCacheForTests();
    queryRaw.mockRejectedValue(new Error("down"));
    res = await GET(anonymous());
    expect([res.status, typeof (await res.json()).status]).toEqual([503, "string"]);
  });
});

describe("GET /api/health - the detailed report (internal secret required)", () => {
  it("reports ok with round-trip timings and pool occupancy when the database answers", async () => {
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const { GET } = await import("../route");

    const res = await GET(detail());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.status).toBe("ok");
    expect(body.database.ok).toBe(true);
    expect(typeof body.database.secondQueryMs).toBe("number");
    expect(body.pool).toEqual({ max: 5, total: 2, idle: 1, waiting: 0 });
  });

  const KEYS = ["APP_ENV", "TRUSTED_PROXY", "CARD_ENCRYPTION_KEY", "CARD_ENCRYPTION_KEYS", "CARD_ENCRYPTION_KEY_ID", "CARD_VAULT_MODE", "VERCEL", "VERCEL_ENV", "NODE_ENV", "LEAD_INGEST_SECRET"];
  async function withEnv(vars: Record<string, string | undefined>, fn: (get: () => Promise<{ readiness: Record<string, unknown> }>) => Promise<void>) {
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
    try {
      const { resetHealthCacheForTests } = await import("@/lib/health-check");
      const { GET } = await import("../route");
      await fn(async () => {
        resetHealthCacheForTests();
        return (await GET(detail())).json();
      });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }
  const GOOD_KEY = Buffer.alloc(32, 9).toString("base64");

  it("reports whether a customer's Finish Booking can store a card RIGHT NOW (categories only): explicit vault enablement, environment and the key ring", async () => {
    queryRaw.mockResolvedValue([{}]);
    await withEnv({ APP_ENV: "staging", TRUSTED_PROXY: "vercel", CARD_ENCRYPTION_KEY: GOOD_KEY }, async (get) => {
      expect((await get()).readiness).toEqual({
        bookingCardStorage: "available",
        cardVaultKey: "configured",
        cardVaultState: "available",
        cardVaultKeyVersion: "v1",
        cardVaultEnabled: true,
        environment: "test",
        databaseTls: "unverified",
        leadIngestSecret: "not_configured",
        websiteApi: "not_configured",
        signerIpCapture: "enabled",
        uploadStorage: expect.stringMatching(/^(ready|low_space|unavailable)$/),
        sequenceScheduler: expect.stringMatching(/^(running|not_started|stalled|disabled)$/),
        schema: "current",
        pendingMigrations: 0,
      });
    });
    await withEnv({ APP_ENV: "production", CARD_ENCRYPTION_KEY: GOOD_KEY }, async (get) => {
      const body = await get();
      expect(body.readiness).toEqual({
        bookingCardStorage: "unavailable",
        cardVaultKey: "configured",
        cardVaultState: "disabled",
        cardVaultKeyVersion: "v1",
        cardVaultEnabled: false,
        environment: "production",
        databaseTls: "unverified",
        leadIngestSecret: "not_configured",
        websiteApi: "not_configured",
        signerIpCapture: "disabled",
        uploadStorage: expect.stringMatching(/^(ready|low_space|unavailable)$/),
        sequenceScheduler: expect.stringMatching(/^(running|not_started|stalled|disabled)$/),
        schema: "current",
        pendingMigrations: 0,
      });
      expect(JSON.stringify(body)).not.toContain(GOOD_KEY);
    });
  });

  it("a production deployment is reported as production and only opens with the explicit vault mode — APP_ENV=staging changes nothing", async () => {
    queryRaw.mockResolvedValue([{}]);
    await withEnv({ NODE_ENV: "production", APP_ENV: "staging", CARD_ENCRYPTION_KEY: GOOD_KEY }, async (get) => {
      expect((await get()).readiness).toMatchObject({ environment: "production", cardVaultEnabled: false, bookingCardStorage: "unavailable" });
    });
    await withEnv({ NODE_ENV: "production", CARD_ENCRYPTION_KEY: GOOD_KEY, CARD_VAULT_MODE: "true" }, async (get) => {
      expect((await get()).readiness).toMatchObject({ cardVaultEnabled: false, bookingCardStorage: "unavailable" });
    });
    await withEnv({ NODE_ENV: "production", CARD_ENCRYPTION_KEY: GOOD_KEY, CARD_VAULT_MODE: "application-encryption-risk-accepted" }, async (get) => {
      expect((await get()).readiness).toMatchObject({ environment: "production", cardVaultEnabled: true, cardVaultState: "available_risk_accepted", bookingCardStorage: "available", cardVaultKeyVersion: "v1" });
    });
  });

  it("THE PRODUCTION CONFIGURATION (APP_ENV=production + the existing CARD_ENCRYPTION_KEY + CARD_VAULT_MODE, no ring, no key id) reports the available, risk-accepted vault on key v1", async () => {
    queryRaw.mockResolvedValue([{}]);
    await withEnv({ APP_ENV: "production", NODE_ENV: "production", CARD_ENCRYPTION_KEY: GOOD_KEY, CARD_VAULT_MODE: "application-encryption-risk-accepted" }, async (get) => {
      const body = await get();
      expect(body.readiness).toMatchObject({ environment: "production", cardVaultState: "available_risk_accepted", bookingCardStorage: "available", cardVaultKey: "configured", cardVaultKeyVersion: "v1", cardVaultEnabled: true });
      const text = JSON.stringify(body);
      expect(text).not.toContain(GOOD_KEY);
      expect(text).not.toMatch(/CARD_ENCRYPTION_KEYS?|CRON_SECRET|DATABASE_URL|postgres/i);
    });
    // and without CARD_VAULT_MODE it fails closed with a distinct, non-secret state
    await withEnv({ APP_ENV: "production", NODE_ENV: "production", CARD_ENCRYPTION_KEY: GOOD_KEY }, async (get) => {
      expect((await get()).readiness).toMatchObject({ cardVaultState: "disabled", bookingCardStorage: "unavailable" });
    });
  });

  it("exposes the current key VERSION label only — never key material — and a ring's newest id", async () => {
    queryRaw.mockResolvedValue([{}]);
    const K2 = Buffer.alloc(32, 4).toString("base64");
    await withEnv({ CARD_ENCRYPTION_KEY: GOOD_KEY, CARD_ENCRYPTION_KEYS: `k2:${K2}`, CARD_ENCRYPTION_KEY_ID: "k2" }, async (get) => {
      const body = await get();
      expect(body.readiness).toMatchObject({ cardVaultKey: "configured", cardVaultKeyVersion: "k2" });
      expect(JSON.stringify(body)).not.toContain(GOOD_KEY);
      expect(JSON.stringify(body)).not.toContain(K2);
    });
  });

  it("a missing or malformed key ring makes card storage unavailable and is reported as a category, never a value", async () => {
    queryRaw.mockResolvedValue([{}]);
    await withEnv({ APP_ENV: "staging" }, async (get) => {
      expect((await get()).readiness).toMatchObject({ bookingCardStorage: "unavailable", cardVaultKey: "missing", cardVaultKeyVersion: null });
    });
    await withEnv({ APP_ENV: "staging", CARD_ENCRYPTION_KEY: "short-and-wrong-value" }, async (get) => {
      const body = await get();
      expect(body.readiness).toMatchObject({ bookingCardStorage: "unavailable", cardVaultKey: "invalid" });
      expect(JSON.stringify(body)).not.toContain("short-and-wrong-value");
    });
  });

  it("reports whether the website lead-ingest secret is configured — a category only, never the value; a too-short value counts as not configured", async () => {
    queryRaw.mockResolvedValue([{}]);
    const secret = "s".repeat(40);
    await withEnv({ LEAD_INGEST_SECRET: secret }, async (get) => {
      const body = await get();
      expect(body.readiness.leadIngestSecret).toBe("configured");
      expect(JSON.stringify(body)).not.toContain(secret);
    });
    await withEnv({ LEAD_INGEST_SECRET: "too-short" }, async (get) => {
      expect((await get()).readiness.leadIngestSecret).toBe("not_configured");
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
      expect((await (await GET(detail())).json()).readiness.signerIpCapture).toBe("enabled");
      process.env.TRUSTED_PROXY = "none";
      resetHealthCacheForTests();
      expect((await (await GET(detail())).json()).readiness.signerIpCapture).toBe("disabled");
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

    const res = await GET(detail());
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

    await Promise.all([GET(detail()), GET(detail()), GET(detail())]);
    await GET(detail());

    // Two queries per real check, one real check for the whole burst.
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it("reports the Lead-document store as a category (ready / low_space / unavailable) - never a path or a size", async () => {
    queryRaw.mockResolvedValue([{}]);
    const os = await import("node:os");
    const fsp = await import("node:fs/promises");
    const path = await import("node:path");
    const { resetStatusCacheForTests } = await import("@/server/storage/local");
    const { resetHealthCacheForTests } = await import("@/lib/health-check");
    const { GET } = await import("../route");
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "compass-health-uploads-"));
    const read = async () => {
      resetStatusCacheForTests();
      resetHealthCacheForTests();
      const text = JSON.stringify(await (await GET(detail())).json());
      expect(text).not.toContain(dir);
      expect(text).not.toMatch(/compass-health-uploads|UPLOAD_|freeBytes/);
      return JSON.parse(text).readiness.uploadStorage as string;
    };
    try {
      vi.stubEnv("UPLOAD_STORAGE_DIR", dir);
      vi.stubEnv("UPLOAD_MIN_FREE_MB", "0");
      expect(await read()).toBe("ready");
      vi.stubEnv("UPLOAD_STORAGE_DIR", "relative/not/absolute");
      expect(await read()).toBe("unavailable");
      vi.stubEnv("UPLOAD_STORAGE_DIR", dir);
      vi.stubEnv("UPLOAD_MIN_FREE_MB", "999999999");
      expect(["low_space", "ready"]).toContain(await read()); // "ready" only where the filesystem cannot report free space
    } finally {
      vi.unstubAllEnvs();
      await fsp.rm(dir, { recursive: true, force: true });
      resetStatusCacheForTests();
    }
  });

  it("reports the database TLS state truthfully: disabled (private Docker database) is never shown as verified, and exposes no host, URL or certificate", async () => {
    queryRaw.mockResolvedValue([{}]);
    const { resetHealthCacheForTests } = await import("@/lib/health-check");
    const { GET } = await import("../route");
    const readTls = async () => {
      resetHealthCacheForTests();
      const body = await (await GET(detail())).json();
      expect(JSON.stringify(body)).not.toMatch(/postgresql:|secret-pw|BEGIN CERTIFICATE|@db/);
      return body.readiness.databaseTls;
    };
    try {
      vi.stubEnv("DATABASE_URL", "postgresql://compass:secret-pw@db:5432/compass");
      expect(await readTls()).toBe("unverified");
      vi.stubEnv("DATABASE_SSL_MODE", "disable");
      expect(await readTls()).toBe("disabled");
      vi.stubEnv("DATABASE_SSL_MODE", "");
      vi.stubEnv("DATABASE_SSL_VERIFY", "system");
      expect(await readTls()).toBe("verified");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
