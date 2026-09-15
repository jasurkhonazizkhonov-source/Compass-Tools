import { describe, it, expect, vi, beforeEach } from "vitest";

// Real bug found and fixed: measured directly against the actual database
// (see src/lib/prisma.ts's own comment) — this Aiven Postgres plan allows
// only 20 total connections, ~9-10 of which are permanently held by
// Aiven's own background processes, leaving roughly 10-11 for ALL
// application traffic combined. node-postgres's Pool defaults `max` to 10
// per pool instance when unset, and this adapter never overrode it — so
// a single warm serverless instance alone could already consume nearly
// the entire remaining budget, and several concurrently-warm instances
// (an ordinary occurrence under real traffic, since each gets its own
// separate pool) could collectively exceed it, causing Postgres to refuse
// new connections for whichever query happens to need one at that moment
// — an intermittent, page-independent failure. This test proves the pool
// is now explicitly capped, distinct from prisma.test.ts (which
// deliberately exercises the real, unmocked module for its own lazy-init
// behavior) — here the adapter constructor itself is mocked so the actual
// config object passed to it can be inspected directly.

const capturedConfigs: unknown[] = [];

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: class {
    constructor(config: unknown) {
      capturedConfigs.push(config);
    }
  },
}));

vi.mock("@/generated/prisma/client", () => ({
  PrismaClient: class {},
}));

beforeEach(() => {
  capturedConfigs.length = 0;
  vi.resetModules();
});

describe("prisma pool sizing — bounded, not left at node-postgres's default", () => {
  it("passes an explicit, small max connection count to the pg adapter", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db?sslmode=require";
    const { prisma } = await import("../prisma");
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    prisma.company; // triggers lazy construction

    expect(capturedConfigs).toHaveLength(1);
    const config = capturedConfigs[0] as { max?: number };
    expect(config.max).toBeDefined();
    // Not asserting the exact tuned value (an implementation detail that
    // may change if the database plan changes) — only that it's a small,
    // deliberate cap, never node-postgres's own unset default of 10 and
    // never unbounded.
    expect(config.max).toBeGreaterThan(0);
    expect(config.max).toBeLessThanOrEqual(5);
  });
});
