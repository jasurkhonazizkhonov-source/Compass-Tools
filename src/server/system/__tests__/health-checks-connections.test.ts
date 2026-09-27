import { describe, it, expect, vi, beforeEach } from "vitest";

// Pure-logic coverage for "Database connection headroom" (checkConnectionPressure,
// health-checks.ts) — the real production incident this documents ("Connection
// usage is high", open 1 minute, self-resolved) was a genuine, correctly-reported
// transient spike, not a bug. What actually needs proving is the THRESHOLD logic
// itself: it fires at the right ratio, escalates to CRITICAL only when truly
// nearly exhausted, and degrades honestly (never guesses "healthy") when the
// managed database hides pg_stat_activity from this role.

let serverUsed: number | null = null;
let serverMax: number | null = null;
let queryShouldThrow = false;
let poolStats: { total: number; idle: number; waiting: number } | null = null;
let poolMax = 2;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("");
      if (sql.includes("pg_stat_activity")) {
        if (queryShouldThrow) throw new Error("permission denied for view pg_stat_activity");
        return [{ used: serverUsed, max: serverMax }];
      }
      return [];
    }),
  },
  getPrismaPoolStats: () => poolStats,
  getPoolSettings: () => ({ max: poolMax }),
}));

// runHealthChecks() exercises every check; only "database.connections" is asserted
// on, so the rest are free to report UNKNOWN against this minimal prisma mock.
import { runHealthChecks } from "../health-checks";

beforeEach(() => {
  serverUsed = null;
  serverMax = null;
  queryShouldThrow = false;
  poolStats = { total: 1, idle: 1, waiting: 0 };
  poolMax = 2;
});

async function connectionsResult() {
  const results = await runHealthChecks();
  return results.find((r) => r.id === "database.connections")!;
}

describe("checkConnectionPressure — thresholds", () => {
  it("comfortable usage (well under 80%) is HEALTHY", async () => {
    serverUsed = 10;
    serverMax = 100;
    const r = await connectionsResult();
    expect(r.state).toBe("HEALTHY");
    expect(r.summary).toMatch(/comfortable/i);
  });

  it("just under 80% is still HEALTHY (the threshold is a floor, not approximate)", async () => {
    serverUsed = 79;
    serverMax = 100;
    expect((await connectionsResult()).state).toBe("HEALTHY");
  });

  it("80% or more is WARNING, not CRITICAL", async () => {
    serverUsed = 80;
    serverMax = 100;
    const r = await connectionsResult();
    expect(r.state).toBe("WARNING");
    expect(r.summary).toMatch(/high/i);
  });

  it("95% or more is CRITICAL", async () => {
    serverUsed = 95;
    serverMax = 100;
    const r = await connectionsResult();
    expect(r.state).toBe("CRITICAL");
    expect(r.summary).toMatch(/nearly out of connections/i);
  });

  it("100% is CRITICAL", async () => {
    serverUsed = 100;
    serverMax = 100;
    expect((await connectionsResult()).state).toBe("CRITICAL");
  });

  it("low server-wide usage but THIS instance's own pool has a waiter is still a WARNING (a real local symptom, not noise)", async () => {
    serverUsed = 5;
    serverMax = 100;
    poolStats = { total: 2, idle: 0, waiting: 3 };
    const r = await connectionsResult();
    expect(r.state).toBe("WARNING");
  });

  it("a managed database that hides pg_stat_activity from this role reports HEALTHY honestly — never a false CRITICAL/WARNING from missing data", async () => {
    queryShouldThrow = true;
    const r = await connectionsResult();
    expect(r.state).toBe("HEALTHY");
    expect(JSON.stringify(r.facts)).toContain("Unavailable");
  });

  it("never leaks a connection string, host or credential in its facts", async () => {
    serverUsed = 90;
    serverMax = 100;
    const r = await connectionsResult();
    expect(JSON.stringify(r)).not.toMatch(/postgres(ql)?:\/\//i);
  });
});
