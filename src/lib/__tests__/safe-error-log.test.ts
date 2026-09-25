import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { safeErrorTag, describeDatabaseTarget } from "../safe-error-log";

// Shared by google-auth.ts, proxy.ts, and (crm)/layout.tsx (see
// safe-error-log.ts's own comment) specifically so a Prisma/driver error's
// message — which can embed connection-string fragments or other
// sensitive detail — never reaches a server log. This proves the contract
// every caller relies on: only the error's class name (plus, for a known
// Prisma request error, its own stable P-code — never the message) is
// ever returned.

describe("safeErrorTag", () => {
  it("returns the constructor name for a plain Error", () => {
    expect(safeErrorTag(new Error("connection terminated"))).toBe("Error");
  });

  it("returns the constructor name for a named Error subclass, never the message", () => {
    class PrismaClientInitializationError extends Error {}
    const err = new PrismaClientInitializationError("postgresql://user:secret@host/db unreachable");
    const tag = safeErrorTag(err);
    expect(tag).toBe("PrismaClientInitializationError");
    expect(tag).not.toContain("secret");
    expect(tag).not.toContain("postgresql");
  });

  // Real gap found and fixed: a bare class name doesn't distinguish "the
  // database was briefly unreachable" from "the schema this code expects
  // isn't applied to whatever database DATABASE_URL actually points at" —
  // directly modeled on a confirmed real production incident on this
  // deployment's sibling application (the public website sharing this
  // same database), where exactly that ambiguity — logged only as a bare
  // class name — cost several exchanges before someone read the actual
  // Prisma error code (P2021) from Vercel's logs. Including the code here
  // means any future incident is immediately distinguishable from the log
  // line alone.
  it("includes the Prisma error's own stable code for a PrismaClientKnownRequestError, never its message", () => {
    const err = new Prisma.PrismaClientKnownRequestError("The table public.Company does not exist in the current database.", {
      code: "P2021",
      clientVersion: "test",
    });
    const tag = safeErrorTag(err);
    expect(tag).toBe("PrismaClientKnownRequestError(P2021)");
    expect(tag).not.toContain("Company");
    expect(tag).not.toContain("does not exist");
  });

  it("never throws and returns a safe typeof-based tag for a non-Error thrown value", () => {
    expect(safeErrorTag("a raw string throw")).toBe("string");
    expect(safeErrorTag(null)).toBe("object");
    expect(safeErrorTag(undefined)).toBe("undefined");
    expect(safeErrorTag(42)).toBe("number");
  });
});

function prismaError(code: string, meta: Record<string, unknown> | undefined, message = "boom") {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "test", meta });
}

// Prisma wraps EVERY raw-driver failure in the same generic P2010, so a
// production report of "P2010" could not distinguish a database that refused
// a connection ("too many clients") from a bad query. The tag now carries the
// driver adapter's fixed-vocabulary `kind` and the Postgres SQLSTATE — never
// free text.
describe("safeErrorTag — driver detail", () => {
  it("adds the driver kind and SQLSTATE that distinguish 'too many clients' from a bad query", () => {
    const tooMany = prismaError("P2010", { driverAdapterError: { cause: { kind: "TooManyConnections", originalCode: "53300" } } });
    expect(safeErrorTag(tooMany)).toBe("PrismaClientKnownRequestError(P2010/TooManyConnections/53300)");

    const unreachable = prismaError("P2010", { driverAdapterError: { cause: { kind: "DatabaseNotReachable", host: "db.internal", port: 5432 } } });
    expect(safeErrorTag(unreachable)).toBe("PrismaClientKnownRequestError(P2010/DatabaseNotReachable)");
  });

  it("NEVER includes free text: messages, hosts and users are ignored even when present on the error", () => {
    const err = prismaError(
      "P2010",
      { driverAdapterError: { cause: { kind: "postgres", code: "28P01", originalMessage: 'password authentication failed for user "avnadmin"', host: "db.internal" } } },
      "postgres://avnadmin:s3cret@db.internal/app"
    );
    const tag = safeErrorTag(err);
    expect(tag).toBe("PrismaClientKnownRequestError(P2010/postgres/28P01)");
    for (const secret of ["avnadmin", "s3cret", "db.internal", "password"]) expect(tag).not.toContain(secret);
  });

  it("rejects values that do not match the safe vocabulary", () => {
    const err = prismaError("P2010", { driverAdapterError: { cause: { kind: "has spaces and secret=abc", originalCode: "not-a-sqlstate" } } });
    expect(safeErrorTag(err)).toBe("PrismaClientKnownRequestError(P2010)");
  });

  it("includes fixed Node/system error codes and never the message", () => {
    const e = Object.assign(new Error("connect ECONNRESET postgres://u:p@h/db"), { code: "ECONNRESET" });
    expect(safeErrorTag(e)).toBe("Error(ECONNRESET)");
  });
});

describe("describeDatabaseTarget", () => {
  let originalDatabaseUrl: string | undefined;

  beforeEach(() => {
    originalDatabaseUrl = process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("returns only hostname:port/dbname — never the username or password", () => {
    process.env.DATABASE_URL = "postgresql://someuser:s3cretPassword@pg-example.aivencloud.com:24692/defaultdb?sslmode=require";
    const target = describeDatabaseTarget();
    expect(target).toBe("pg-example.aivencloud.com:24692/defaultdb");
    expect(target).not.toContain("someuser");
    expect(target).not.toContain("s3cretPassword");
  });

  it("reports plainly when DATABASE_URL is unset, rather than throwing", () => {
    delete process.env.DATABASE_URL;
    expect(describeDatabaseTarget()).toBe("DATABASE_URL is not set in this runtime");
  });

  it("reports plainly when DATABASE_URL is not a valid URL, rather than throwing", () => {
    process.env.DATABASE_URL = "not-a-valid-connection-string";
    expect(describeDatabaseTarget()).toBe("DATABASE_URL is set but is not a valid URL");
  });
});
