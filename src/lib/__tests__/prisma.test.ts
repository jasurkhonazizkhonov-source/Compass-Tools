import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Pass 35 — real bug found and fixed: src/lib/prisma.ts used to construct
// the Prisma client (and parse DATABASE_URL via `new URL()`) EAGERLY at
// module-evaluation time. next build's "Collecting page data" step imports
// every route module to statically analyze it — including a Route Handler
// that never touches the database until a real request arrives (e.g.
// /api/auth/gmail/callback) — so simply IMPORTING this module with
// DATABASE_URL absent/empty/malformed threw `ERR_INVALID_URL` and failed
// the entire production build, for a route that doesn't need the database
// yet. Fixed by deferring client construction (and DATABASE_URL parsing)
// behind a Proxy, so importing this module never throws — only actually
// USING it does, with a clear, actionable, credential-free error message.
//
// This suite deliberately does NOT mock @/lib/prisma (unlike every other
// test file in this codebase) — the whole point is to exercise the real
// module's lazy-initialization behavior. globalThis.__prisma is a genuine
// global (not reset by vi.resetModules(), which only clears the per-file
// module registry), so it's explicitly cleared before/after every test here
// to prevent one test's cached client from masking another's.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const globalWithPrisma = globalThis as any;
let originalDatabaseUrl: string | undefined;

beforeEach(() => {
  originalDatabaseUrl = process.env.DATABASE_URL;
  delete globalWithPrisma.__prisma;
  // Module-scoped `cachedClient` inside prisma.ts otherwise survives across
  // tests in this file (vitest caches the imported module) — resetting the
  // module registry guarantees every test below re-evaluates prisma.ts from
  // scratch, so an earlier test's successfully-constructed client can never
  // mask a later test's expectation that construction fails.
  vi.resetModules();
});

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  delete globalWithPrisma.__prisma;
});

describe("prisma client lazy initialization (Pass 35)", () => {
  it("importing the module never throws, even when DATABASE_URL is unset — the exact production build failure", async () => {
    delete process.env.DATABASE_URL;
    await expect(import("../prisma")).resolves.toBeDefined();
  });

  it("importing the module never throws when DATABASE_URL is an empty string — the exact reproduced Vercel failure", async () => {
    process.env.DATABASE_URL = "";
    await expect(import("../prisma")).resolves.toBeDefined();
  });

  it("actually USING the client without DATABASE_URL throws a clear, actionable error — not a raw URL-parser crash", async () => {
    delete process.env.DATABASE_URL;
    const { prisma } = await import("../prisma");
    expect(() => prisma.company).toThrow("DATABASE_URL is not set");
  });

  it("actually USING the client with a malformed DATABASE_URL throws a clear error that never echoes the value", async () => {
    process.env.DATABASE_URL = "not-a-valid-connection-string";
    const { prisma } = await import("../prisma");
    let caught: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      prisma.company;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("DATABASE_URL must be a valid PostgreSQL connection URL.");
    expect((caught as Error).message).not.toContain("not-a-valid-connection-string");
  });

  it("a valid connection string does not throw at client-construction time (network connection is separately lazy — not exercised here)", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db?sslmode=require";
    const { prisma } = await import("../prisma");
    expect(() => prisma.company).not.toThrow();
  });
});
