import { describe, it, expect, vi } from "vitest";
import { isDisposableAdminDatabaseConfigured, isDisposableDatabaseConfigured, resolveDisposableAdminDatabase, resolveDisposableDatabase } from "../disposable-database";
import setup, { verifyConnectedTarget, type VerifyClient } from "../integration-database-guard";

// The gate in front of every database-backed test. Pure (static) checks first, then the live verification with a fake client; the real driver and a
// real server are never involved here. Credentials below are throwaway placeholders.

const GOOD = "postgresql://postgres:secret@127.0.0.1:54329/compass_test?sslmode=require";
const env = (e: Record<string, string | undefined>) => e as Record<string, string | undefined>;
const refusedWith = (e: Record<string, string | undefined>, rule: RegExp) => {
  let message = "";
  try {
    resolveDisposableDatabase(env(e));
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toMatch(/^INTEGRATION_DATABASE_URL refused: /);
  expect(message).toMatch(rule);
  expect(message).toMatch(/No database client was created\.$/);
  // The message names the broken rule only - never the URL, host, user, password or database.
  expect(message).not.toMatch(/secret|54329|postgres:/);
};

describe("INTEGRATION_DATABASE_URL - accepted", () => {
  it.each([
    GOOD,
    "postgres://postgres:secret@127.0.0.1:5432/compass_test",
    "postgresql://ci@127.0.0.1:5432/compass_test?sslmode=verify-full",
    "postgresql://ci:pw@127.0.0.1:5432/compass_test?sslmode=verify-ca",
    "postgresql://ci:pw@[::1]:5432/compass_test",
  ])("%s", (url) => {
    expect(resolveDisposableDatabase(env({ INTEGRATION_DATABASE_URL: url }))).toEqual({ url, database: "compass_test" });
  });

  it("not configured (unset, empty or blank) is 'not configured', not an error - the database-backed files then skip themselves", () => {
    for (const v of [undefined, "", "   "]) {
      expect(resolveDisposableDatabase(env({ INTEGRATION_DATABASE_URL: v }))).toBeNull();
      expect(isDisposableDatabaseConfigured(env({ INTEGRATION_DATABASE_URL: v }))).toBe(false);
    }
    expect(isDisposableDatabaseConfigured(env({ INTEGRATION_DATABASE_URL: GOOD }))).toBe(true);
  });

  it("an ambient DATABASE_URL (a .env value, even a production one) never activates anything", () => {
    expect(resolveDisposableDatabase(env({ DATABASE_URL: "postgresql://prod:pw@db.example.com:5432/production" }))).toBeNull();
    expect(resolveDisposableDatabase(env({ DATABASE_URL: GOOD }))).toBeNull();
  });
});

describe("INTEGRATION_DATABASE_URL - rejected (fail closed)", () => {
  it.each([
    ["a remote host name", "postgresql://u:p@db.example.com:5432/compass_test", /host must be exactly 127\.0\.0\.1 or \[::1\]/],
    ["a remote IP address", "postgresql://u:p@10.0.0.5:5432/compass_test", /host must be exactly/],
    ["the name localhost (needs a lookup, could point elsewhere)", "postgresql://u:p@localhost:5432/compass_test", /host must be exactly/],
    ["0.0.0.0", "postgresql://u:p@0.0.0.0:5432/compass_test", /host must be exactly/],
    ["another loopback spelling (127.1)", "postgresql://u:p@127.1:5432/compass_test", /host must be exactly/],
    ["a hex/decimal IP spelling of loopback", "postgresql://u:p@2130706433:5432/compass_test", /host must be exactly/],
    ["a production database name", "postgresql://u:p@127.0.0.1:5432/production", /not on the approved disposable list/],
    ["the maintenance database", "postgresql://u:p@127.0.0.1:5432/postgres", /not on the approved disposable list/],
    ["a look-alike name (compass_tools_test)", "postgresql://u:p@127.0.0.1:5432/compass_tools_test", /not on the approved disposable list/],
    ["a prefix of the name", "postgresql://u:p@127.0.0.1:5432/compass_test_2", /not on the approved disposable list/],
    ["a different case", "postgresql://u:p@127.0.0.1:5432/Compass_Test", /not on the approved disposable list/],
    ["no database name", "postgresql://u:p@127.0.0.1:5432", /not on the approved disposable list/],
    ["no explicit port", "postgresql://u:p@127.0.0.1/compass_test", /explicit port is required/],
    ["no user", "postgresql://127.0.0.1:5432/compass_test", /explicit user is required/],
    ["the wrong scheme", "mysql://u:p@127.0.0.1:5432/compass_test", /scheme must be postgresql/],
    ["http", "http://u:p@127.0.0.1:5432/compass_test", /scheme must be postgresql/],
    ["not a URL", "not a url", /whitespace|not a valid URL/],
    ["a fragment", "postgresql://u:p@127.0.0.1:5432/compass_test#x", /fragment/],
    ["an empty query string", "postgresql://u:p@127.0.0.1:5432/compass_test?", /empty query string/],
    ["sslmode=disable", "postgresql://u:p@127.0.0.1:5432/compass_test?sslmode=disable", /one sslmode of require/],
    ["sslmode=prefer", "postgresql://u:p@127.0.0.1:5432/compass_test?sslmode=prefer", /one sslmode of require/],
    ["sslmode=allow", "postgresql://u:p@127.0.0.1:5432/compass_test?sslmode=allow", /one sslmode of require/],
    ["a duplicated sslmode", "postgresql://u:p@127.0.0.1:5432/compass_test?sslmode=require&sslmode=disable", /one sslmode of require/],
    ["a host override in the query (libpq would connect elsewhere)", "postgresql://u:p@127.0.0.1:5432/compass_test?host=db.example.com", /one sslmode of require/],
    ["a hostaddr override", "postgresql://u:p@127.0.0.1:5432/compass_test?hostaddr=10.0.0.5", /one sslmode of require/],
    ["a database override in the query", "postgresql://u:p@127.0.0.1:5432/compass_test?dbname=production", /one sslmode of require/],
    ["an options parameter", "postgresql://u:p@127.0.0.1:5432/compass_test?options=-c%20search_path=x", /one sslmode of require/],
    ["a trailing space", "postgresql://u:p@127.0.0.1:5432/compass_test ", null],
    ["an embedded space", "postgresql://u:p@127.0.0.1:5432/compass test", /whitespace/],
    ["a newline", "postgresql://u:p@127.0.0.1:5432/compass_test\nhost=evil", /whitespace/],
    ["an embedded tab", "postgresql://u:p@127.0.0.1:5432/compass_test\tx", /whitespace/],
    ["a second @ (the host is ambiguous between parsers)", "postgresql://u@evil.example.com:1:p@127.0.0.1:5432/compass_test", /exactly one @/],
    ["an unescaped @ in the password", "postgresql://u:p@ss@127.0.0.1:5432/compass_test", /exactly one @/],
    ["no user part at all", "postgresql://127.0.0.1:5432/compass_test", /explicit user is required/],
  ])("%s", (_label, url, rule) => {
    if (rule === null) {
      // trailing whitespace is trimmed from the variable, so it resolves to exactly the approved value
      expect(resolveDisposableDatabase(env({ INTEGRATION_DATABASE_URL: url }))?.database).toBe("compass_test");
      return;
    }
    refusedWith({ INTEGRATION_DATABASE_URL: url }, rule);
  });
});

describe("INTEGRATION_ADMIN_DATABASE_URL - the one narrow exception", () => {
  const ADMIN = "postgresql://postgres:secret@127.0.0.1:54329/postgres?sslmode=require";
  const both = (admin: string | undefined, main: string | null = GOOD) => env({ INTEGRATION_DATABASE_URL: main ?? undefined, INTEGRATION_ADMIN_DATABASE_URL: admin });

  it("accepts the maintenance database `postgres` on the SAME loopback host and port as the approved database", () => {
    expect(resolveDisposableAdminDatabase(both(ADMIN))).toEqual({ url: ADMIN, database: "postgres", host: "127.0.0.1", port: "54329" });
    expect(isDisposableAdminDatabaseConfigured(both(ADMIN))).toBe(true);
  });

  it("not configured is null, even when the main URL is configured", () => {
    for (const v of [undefined, "", " "]) expect(resolveDisposableAdminDatabase(both(v))).toBeNull();
  });

  it("is refused on its own: without an approved INTEGRATION_DATABASE_URL an admin URL can never be used", () => {
    expect(() => resolveDisposableAdminDatabase(both(ADMIN, null))).toThrow(/INTEGRATION_DATABASE_URL must also be configured/);
    expect(() => resolveDisposableAdminDatabase(both(ADMIN, "postgresql://u:p@db.example.com:5432/compass_test"))).toThrow(/INTEGRATION_DATABASE_URL refused/);
  });

  it.each([
    ["any database other than postgres (compass_test)", "postgresql://u:p@127.0.0.1:54329/compass_test", /must be exactly postgres/],
    ["a production database", "postgresql://u:p@127.0.0.1:54329/production", /must be exactly postgres/],
    ["template1", "postgresql://u:p@127.0.0.1:54329/template1", /must be exactly postgres/],
    ["a remote host", "postgresql://u:p@db.example.com:54329/postgres", /host must be exactly/],
    ["localhost", "postgresql://u:p@localhost:54329/postgres", /host must be exactly/],
    ["a different loopback literal than the main URL", "postgresql://u:p@[::1]:54329/postgres", /same host and port/],
    ["a different port (another server on this machine)", "postgresql://u:p@127.0.0.1:5432/postgres", /same host and port/],
    ["sslmode=disable", "postgresql://u:p@127.0.0.1:54329/postgres?sslmode=disable", /one sslmode of require/],
    ["a host override", "postgresql://u:p@127.0.0.1:54329/postgres?host=db.example.com", /one sslmode of require/],
    ["no port", "postgresql://u:p@127.0.0.1/postgres", /explicit port/],
  ])("rejects %s", (_label, url, rule) => {
    let message = "";
    try {
      resolveDisposableAdminDatabase(both(url));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^INTEGRATION_ADMIN_DATABASE_URL refused: /);
    expect(message).toMatch(rule);
    expect(message).not.toMatch(/secret|db\.example\.com|54329/);
  });
});

describe("live verification (verifyConnectedTarget) - 'could not verify' is never 'safe'", () => {
  const client = (answer: () => Promise<{ rows: Array<{ db: string; addr: string | null }> }>, extra: Partial<VerifyClient> = {}): VerifyClient => ({
    connect: async () => undefined,
    query: async () => answer(),
    end: async () => undefined,
    ...extra,
  });
  const ok = (db: string, addr: string | null) => async () => ({ rows: [{ db, addr }] });

  it("accepts compass_test answered from a loopback address, or over a local socket (no address)", async () => {
    for (const addr of ["127.0.0.1", "::1", "127.0.0.1/32", null]) await expect(verifyConnectedTarget(GOOD, "compass_test", () => client(ok("compass_test", addr)))).resolves.toBeUndefined();
  });

  it("refuses when the server says it is a different database, even though the URL named compass_test", async () => {
    await expect(verifyConnectedTarget(GOOD, "compass_test", () => client(ok("production", "127.0.0.1")))).rejects.toThrow(/connected database is not compass_test/);
  });

  it("refuses a non-loopback server address (a port-forward to a remote server)", async () => {
    await expect(verifyConnectedTarget(GOOD, "compass_test", () => client(ok("compass_test", "10.20.30.40")))).rejects.toThrow(/non-loopback address/);
  });

  it("refuses when the server cannot be reached, times out, or returns nothing - and the error never repeats the host or user", async () => {
    const down = verifyConnectedTarget(GOOD, "compass_test", () => client(ok("x", null), { connect: async () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:54329 as postgres")) }));
    const error = await down.then(() => null, (e: Error) => e);
    expect(error?.message).toMatch(/could not be verified/);
    expect(error?.message).not.toMatch(/127\.0\.0\.1|54329|ECONNREFUSED/);
    await expect(verifyConnectedTarget(GOOD, "compass_test", () => client(async () => ({ rows: [] })))).rejects.toThrow(/not compass_test/);
    await expect(verifyConnectedTarget(GOOD, "compass_test", () => client(async () => Promise.reject(new Error("boom"))))).rejects.toThrow(/could not be verified/);
  });

  it("always closes the connection, and asks for TLS without the pg driver's own sslmode policy", async () => {
    const end = vi.fn(async () => undefined);
    const seen: { cfg?: { connectionString: string; ssl: unknown } } = {};
    await verifyConnectedTarget(GOOD, "compass_test", (c) => {
      seen.cfg = c;
      return client(ok("compass_test", "127.0.0.1"), { end });
    });
    expect(end).toHaveBeenCalledOnce();
    expect(seen.cfg?.ssl).toEqual({ rejectUnauthorized: false });
    expect(seen.cfg?.connectionString).not.toContain("sslmode");
    const plain: { cfg?: { connectionString: string; ssl: unknown } } = {};
    await verifyConnectedTarget("postgresql://u:p@127.0.0.1:5432/compass_test", "compass_test", (c) => {
      plain.cfg = c;
      return client(ok("compass_test", null), { end });
    });
    expect(plain.cfg?.ssl).toBe(false);
    const failing = vi.fn(async () => undefined);
    await verifyConnectedTarget(GOOD, "compass_test", () => client(ok("production", null), { end: failing })).catch(() => undefined);
    expect(failing).toHaveBeenCalledOnce();
  });
});

describe("globalSetup (runs before any database-backed test file)", () => {
  const withEnv = async (vars: Record<string, string | undefined>, run: () => Promise<void>) => {
    const keys = ["INTEGRATION_DATABASE_URL", "INTEGRATION_ADMIN_DATABASE_URL"];
    const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== undefined)));
    try {
      await run();
    } finally {
      for (const k of keys) {
        if (before[k] === undefined) delete process.env[k];
        else process.env[k] = before[k];
      }
    }
  };

  it("does nothing when neither variable is set (no connection attempt)", async () => {
    await withEnv({}, async () => {
      await expect(setup()).resolves.toBeUndefined();
    });
  });

  it("aborts the whole run BEFORE connecting when the configured URL is unsafe", async () => {
    await withEnv({ INTEGRATION_DATABASE_URL: "postgresql://u:p@db.example.com:5432/production" }, async () => {
      await expect(setup()).rejects.toThrow(/INTEGRATION_DATABASE_URL refused/);
    });
    await withEnv({ INTEGRATION_ADMIN_DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/postgres" }, async () => {
      await expect(setup()).rejects.toThrow(/INTEGRATION_DATABASE_URL must also be configured/);
    });
  });

  it("aborts when a syntactically approved URL cannot be verified (nothing is listening on that port)", async () => {
    await withEnv({ INTEGRATION_DATABASE_URL: "postgresql://postgres:x@127.0.0.1:1/compass_test" }, async () => {
      await expect(setup()).rejects.toThrow(/could not be verified/);
    });
  });
});
