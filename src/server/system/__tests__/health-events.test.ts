import { describe, it, expect, vi, beforeEach } from "vitest";

// Pure-logic coverage for the System Health incident model: what gets stored
// (nothing sensitive, ever), how "the same problem" is identified, and what
// the server-error recorder is allowed to keep. The database behaviour
// (atomic de-duplication, notifications, retention) is proven against a real
// PostgreSQL in __integration__/system-health.integration.test.ts.

const queryRaw = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
    healthEvent: { count: vi.fn(async () => 0), updateMany: vi.fn(async () => ({ count: 0 })), deleteMany: vi.fn(async () => ({ count: 0 })) },
    account: { findMany: vi.fn(async () => []) },
    notification: { createMany: vi.fn(async () => ({ count: 0 })) },
  },
  getPrismaPoolStats: () => null,
  getPoolSettings: () => ({ max: 2 }),
}));

import { sanitizeMessage, sanitizeMetadata, healthFingerprint, recordHealthEvent, resetHealthEventThrottleForTests } from "../health-events";
import { base64KeyStatus, groupForState, overallState } from "../health-checks";
import { classifyServerError, recordServerError } from "../server-errors";

beforeEach(() => {
  queryRaw.mockReset();
  queryRaw.mockResolvedValue([{ inserted: true }]);
  resetHealthEventThrottleForTests();
});

describe("sanitizeMessage — nothing credential-, card- or URL-shaped survives", () => {
  it.each([
    ["a Postgres connection string", "connect failed postgresql://admin:hunter2@db.example.com:5432/app", ["hunter2", "db.example.com", "postgresql://"]],
    ["an https URL carrying a token", "GET https://x.test/quote/AbCdEfGh1234567890abcdefghijklmn failed", ["AbCdEfGh1234567890abcdefghijklmn", "https://"]],
    ["a bearer token", "Authorization: Bearer ya29.a0AfH6SMBx-secretvalue", ["ya29", "secretvalue"]],
    ["a JWT", "bad token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl", ["eyJhbGci"]],
    ["an email address", "failed to send to jane.doe@example.com", ["jane.doe@example.com"]],
    ["a card-number-shaped run (test PAN)", "card 4111 1111 1111 1111 declined", ["4111 1111 1111 1111", "4111111111111111"]],
    ["a hyphenated card-number-shaped run", "card 5555-5555-5555-4444", ["5555-5555-5555-4444"]],
    ["a long opaque key", "key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA leaked", ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]],
  ])("%s", (_label, input, forbidden) => {
    const out = sanitizeMessage(input);
    for (const f of forbidden) expect(out).not.toContain(f);
  });

  it("keeps ordinary diagnostic text readable", () => {
    expect(sanitizeMessage("Database round trip took 3100 ms (P2024)")).toBe("Database round trip took 3100 ms (P2024)");
  });

  it("caps length", () => {
    expect(sanitizeMessage("x ".repeat(500)).length).toBeLessThanOrEqual(300);
  });

  it("tolerates non-string input", () => {
    expect(sanitizeMessage(undefined)).toBe("");
    expect(sanitizeMessage(42)).toBe("42");
  });
});

describe("sanitizeMetadata", () => {
  it("drops sensitive KEYS entirely, whatever the value", () => {
    const out = sanitizeMetadata({
      password: "x",
      apiToken: "x",
      cookie: "x",
      authorization: "x",
      cardNumber: "4111111111111111",
      cvv: "123",
      DATABASE_URL: "postgres://u:p@h/d",
      connectionString: "x",
      sessionId: "x",
      email: "a@b.co",
      ip: "203.0.113.9",
      requestBody: "x",
      stackTrace: "x",
      step: "email",
      count: 3,
    });
    expect(Object.keys(out).sort()).toEqual(["count", "step"]);
  });

  it("redacts sensitive-looking string VALUES under harmless keys", () => {
    const out = sanitizeMetadata({ note: "see postgres://u:p@h/d and 4111111111111111" });
    expect(JSON.stringify(out)).not.toContain("postgres://");
    expect(JSON.stringify(out)).not.toContain("4111111111111111");
  });

  it("bounds depth and array length, and drops non-JSON values", () => {
    const out = sanitizeMetadata({ deep: { a: { b: { c: 1 } } }, list: Array.from({ length: 50 }, (_, i) => i), fn: () => 1, big: BigInt(1), nan: Number.NaN });
    const json = JSON.stringify(out);
    expect(json).not.toContain('"c"');
    expect((out.list as unknown[]).length).toBe(10);
    expect(out.fn).toBeNull();
    expect(out.nan).toBeNull();
  });

  it("handles null/undefined", () => {
    expect(sanitizeMetadata(undefined)).toEqual({});
    expect(sanitizeMetadata(null)).toEqual({});
  });
});

describe("healthFingerprint", () => {
  it("is stable for the same problem and differs for a different one", () => {
    const a = healthFingerprint("EMAIL_SEND_FAILED", "email", "NOT_CONNECTED");
    expect(a).toBe(healthFingerprint("EMAIL_SEND_FAILED", "email", "NOT_CONNECTED"));
    expect(a).not.toBe(healthFingerprint("EMAIL_SEND_FAILED", "email", "REAUTH_REQUIRED"));
    expect(a).not.toBe(healthFingerprint("EMAIL_SEND_FAILED", "server", "NOT_CONNECTED"));
    expect(a).toHaveLength(32);
  });
});

describe("recordHealthEvent", () => {
  it("never throws — a failing database is swallowed, not propagated into the request that triggered it", async () => {
    queryRaw.mockRejectedValue(new Error("connection terminated postgres://u:pw@h/d"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(recordHealthEvent({ type: "T", category: "c", severity: "WARNING", message: "m" })).resolves.toEqual({ recorded: false, isNew: false });
    expect(spy.mock.calls.flat().join(" ")).not.toContain("pw");
    spy.mockRestore();
  });

  it("throttles a hot loop per fingerprint (one write per 10s per instance)", async () => {
    const input = { type: "T", category: "c", severity: "WARNING" as const, message: "m" };
    expect((await recordHealthEvent(input, 1_000)).recorded).toBe(true);
    expect((await recordHealthEvent(input, 2_000)).recorded).toBe(false);
    expect((await recordHealthEvent(input, 12_000)).recorded).toBe(true);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it("different fingerprints are throttled independently", async () => {
    await recordHealthEvent({ type: "A", category: "c", severity: "WARNING", message: "m" }, 1_000);
    expect((await recordHealthEvent({ type: "B", category: "c", severity: "WARNING", message: "m" }, 1_001)).recorded).toBe(true);
  });

  it("stores the SANITIZED message and metadata, never the raw input", async () => {
    await recordHealthEvent({
      type: "T",
      category: "c",
      severity: "WARNING",
      message: "failed for jane@example.com via postgres://u:pw@h/d",
      metadata: { note: "card 4111111111111111", password: "hunter2" },
    });
    const sqlArgs = JSON.stringify(queryRaw.mock.calls[0].slice(1));
    expect(sqlArgs).not.toContain("jane@example.com");
    expect(sqlArgs).not.toContain("pw@h");
    expect(sqlArgs).not.toContain("4111111111111111");
    expect(sqlArgs).not.toContain("hunter2");
  });
});

describe("classification helpers", () => {
  it("base64KeyStatus reports Configured / Missing / Invalid and never the value", () => {
    const good = Buffer.alloc(32, 7).toString("base64");
    expect(base64KeyStatus(good, 32)).toBe("Configured");
    expect(base64KeyStatus(undefined, 32)).toBe("Missing");
    expect(base64KeyStatus("   ", 32)).toBe("Missing");
    expect(base64KeyStatus("not base64 !!", 32)).toBe("Invalid");
    expect(base64KeyStatus(Buffer.alloc(16, 1).toString("base64"), 32)).toBe("Invalid");
    expect(base64KeyStatus(Buffer.alloc(16, 1).toString("base64"), { min: 16 })).toBe("Configured");
    expect(base64KeyStatus(Buffer.alloc(8, 1).toString("base64"), { min: 16 })).toBe("Invalid");
  });

  it("groups: CRITICAL -> critical; WARNING and UNKNOWN -> warning (unverified is not fine); HEALTHY -> informational", () => {
    expect(groupForState("CRITICAL")).toBe("critical");
    expect(groupForState("WARNING")).toBe("warning");
    expect(groupForState("UNKNOWN")).toBe("warning");
    expect(groupForState("HEALTHY")).toBe("informational");
  });

  it("overall status is the worst state; UNKNOWN only outranks HEALTHY", () => {
    expect(overallState([{ state: "HEALTHY" }, { state: "HEALTHY" }])).toBe("HEALTHY");
    expect(overallState([{ state: "HEALTHY" }, { state: "UNKNOWN" }])).toBe("UNKNOWN");
    expect(overallState([{ state: "UNKNOWN" }, { state: "WARNING" }])).toBe("WARNING");
    expect(overallState([{ state: "WARNING" }, { state: "CRITICAL" }, { state: "UNKNOWN" }])).toBe("CRITICAL");
    expect(overallState([])).toBe("HEALTHY");
  });
});

describe("server error recorder", () => {
  it("classifies database outages separately from ordinary application errors", () => {
    expect(classifyServerError(new Error("boom")).databaseOutage).toBe(false);
    expect(classifyServerError(Object.assign(new Error("x"), { name: "PrismaClientInitializationError" })).tag).toBeTruthy();
  });

  it("records the route PATTERN and category only — never the message, a customer token or a query string", async () => {
    await recordServerError(Object.assign(new Error("boom postgres://u:pw@h/d jane@example.com"), { digest: "abc123" }), {
      routePath: "/quote/[token]?token=AbCdEfGh1234567890abcdefghijklmn",
      routeType: "render",
    });
    const sqlArgs = JSON.stringify(queryRaw.mock.calls[0].slice(1));
    expect(sqlArgs).not.toContain("pw@h");
    expect(sqlArgs).not.toContain("jane@example.com");
    expect(sqlArgs).not.toContain("AbCdEfGh1234567890abcdefghijklmn");
    expect(sqlArgs).toContain("SERVER_ERROR");
  });

  it("collapses a suspicious route value to a fixed placeholder", async () => {
    await recordServerError(new Error("x"), { routePath: "/quote/AbCdEfGh 1234;DROP TABLE", routeType: "route" });
    expect(JSON.stringify(queryRaw.mock.calls[0].slice(1))).toContain("in route unknown");
  });
});
