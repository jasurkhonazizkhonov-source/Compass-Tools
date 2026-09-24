import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

// Regression coverage for scripts/vercel-build.mjs — the Vercel-only build
// step that applies pending Prisma migrations before `next build` (see
// that file's own extensive header comment for the full safety model and
// the real incident on this deployment's sibling application that
// motivated the DATABASE_AUTO_INIT ambiguity gate). Importing the module
// for these tests does NOT run migrate deploy or `next build` — that only
// happens via the `isMain` guard at the bottom of the file, which checks
// whether the script was invoked directly.

let redact: (text: unknown) => string;
let isDatabaseEmptyOfCrmPresence: (prisma: { $queryRawUnsafe: (sql: string) => Promise<unknown[]> }) => Promise<boolean>;
let tryInitializeDatabase: () => Promise<void>;

beforeAll(async () => {
  ({ redact, isDatabaseEmptyOfCrmPresence, tryInitializeDatabase } = await import("../vercel-build.mjs"));
});

function fakePrisma(row: { company_exists: boolean; migrations_table_exists: boolean }) {
  return { $queryRawUnsafe: async () => [row] };
}

describe("vercel-build.mjs redact()", () => {
  it("strips username and password from a postgres:// URL, keeping host/port/dbname visible", () => {
    const input = "Can't reach database server at `postgres://avnadmin:hunter2@pg-example.aivencloud.com:24692/defaultdb`";
    const output = redact(input);
    expect(output).not.toContain("avnadmin");
    expect(output).not.toContain("hunter2");
    expect(output).toContain("pg-example.aivencloud.com:24692/defaultdb");
    expect(output).toContain("[redacted]");
  });

  it("handles multiple connection strings in the same text", () => {
    const input = "postgres://a:b@host1.example.com/db1 and postgresql://c:d@host2.example.com/db2";
    const output = redact(input);
    expect(output).not.toMatch(/:b@|:d@/);
    expect(output).toContain("host1.example.com/db1");
    expect(output).toContain("host2.example.com/db2");
  });

  it("leaves text with no connection string unchanged", () => {
    const input = "No pending migrations to apply.";
    expect(redact(input)).toBe(input);
  });

  it("handles a non-string input without throwing", () => {
    expect(() => redact(null)).not.toThrow();
    expect(() => redact(undefined)).not.toThrow();
    expect(redact(42)).toBe("42");
  });
});

describe("vercel-build.mjs isDatabaseEmptyOfCrmPresence() — the safety gate itself", () => {
  it("treats a database with an existing Company table as NOT empty (migrate deploy proceeds unconditionally)", async () => {
    const result = await isDatabaseEmptyOfCrmPresence(fakePrisma({ company_exists: true, migrations_table_exists: false }));
    expect(result).toBe(false);
  });

  it("treats a database with an existing _prisma_migrations table as NOT empty, even with no Company row yet", async () => {
    const result = await isDatabaseEmptyOfCrmPresence(fakePrisma({ company_exists: false, migrations_table_exists: true }));
    expect(result).toBe(false);
  });

  it("treats a database with NEITHER table as empty — this is the only case requiring DATABASE_AUTO_INIT=true", async () => {
    const result = await isDatabaseEmptyOfCrmPresence(fakePrisma({ company_exists: false, migrations_table_exists: false }));
    expect(result).toBe(true);
  });

  it("a fully-migrated database (both signals present) is NOT empty", async () => {
    const result = await isDatabaseEmptyOfCrmPresence(fakePrisma({ company_exists: true, migrations_table_exists: true }));
    expect(result).toBe(false);
  });
});

describe("vercel-build.mjs tryInitializeDatabase() — real (non-stubbed) code path", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    vi.restoreAllMocks();
  });

  // This exercises the actual, unmocked function — not a stub — including
  // its real dynamic imports (@prisma/adapter-pg, the generated Prisma
  // client). It exists specifically because an earlier version of this
  // function imported a helper from src/lib/safe-error-log.ts, which
  // internally uses the "@/" tsconfig path alias; plain Node ESM resolution
  // (which is what actually runs this script, on both Windows and Vercel's
  // Linux build) doesn't understand that alias, so the import threw
  // Cannot find package '@/generated' — an uncaught, build-failing error
  // that stub-only unit tests of isDatabaseEmptyOfCrmPresence() could never
  // have caught, since they never invoke the real import chain.
  it("missing DATABASE_URL: resolves without throwing and logs a clear diagnostic", async () => {
    delete process.env.DATABASE_URL;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(tryInitializeDatabase()).resolves.toBeUndefined();
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes("DATABASE_URL not set"))).toBe(true);
  });

  it("unreachable DATABASE_URL: resolves without throwing (never fails the build) and logs a warning", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@does-not-exist.invalid:5432/testdb";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(tryInitializeDatabase()).resolves.toBeUndefined();
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes("does-not-exist.invalid"))).toBe(true);
    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("Could not check database state"))).toBe(true);
  }, 20_000);
});
