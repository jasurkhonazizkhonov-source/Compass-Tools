import { Prisma } from "@/generated/prisma/client";

// Shared by every call site that needs to log "something failed" without
// ever risking a secret leaking into server logs. Some Prisma/driver error
// messages embed connection-string fragments, query text, or other detail
// that must never reach logs any more than the browser — so this logs ONLY
// the error's constructor name (e.g. "PrismaClientInitializationError"),
// never `err.message`. Originally added in google-auth.ts (Pass 41); moved
// here so src/proxy.ts can use the exact same safe-logging convention for
// its own unguarded database call instead of duplicating the helper.
//
// Extended to also include a Prisma error's own stable `code` (P1xxx =
// connection/engine layer, P2xxx = query layer, P3xxx = migration) when
// the thrown error is a PrismaClientKnownRequestError — this class name
// alone doesn't distinguish "database briefly unreachable" from "the
// schema this code expects isn't applied to whatever database
// DATABASE_URL actually points at," which are very different problems
// requiring very different fixes. Directly modeled on a real, CONFIRMED
// production incident on this deployment's sibling application (the
// public Business Flights Travel website, which shares this exact same
// Postgres database): its own Vercel Runtime Logs, once actually read,
// showed `PrismaClientKnownRequestError P2021 — the table public.Company
// does not exist in the current database`, meaning ITS production
// DATABASE_URL was pointing at a database without this app's schema
// applied — a wrong-database/misconfigured-environment-variable problem,
// not a connectivity one, and one that a bare class-name log could never
// have distinguished from a transient connection failure. This CRM is a
// SEPARATE Vercel project with its own independently-configured
// DATABASE_URL, so that specific incident does not by itself prove this
// app has the same misconfiguration — but it is a real, evidenced
// precedent for exactly this failure class existing in this deployment
// ecosystem, so this app gets the same category of safe diagnostic
// up front rather than only after a second incident forces it.
//
// Prisma wraps EVERY raw-driver failure — an unreachable server, a refused
// connection, "too many clients", a missing table — in the same generic
// P2010, which made production reports say nothing useful ("P2010" for both
// a bad query and a database that refused a connection). The driver adapter
// error underneath carries two values that are safe to expose because they
// are short, fixed vocabularies and never free text: a `kind` (e.g.
// "DatabaseNotReachable", "TooManyConnections", "TableDoesNotExist") and the
// Postgres SQLSTATE (e.g. "53300"). Both are validated against a strict
// pattern before being included; the free-text message is still never used.
const SAFE_KIND = /^[A-Za-z]{1,40}$/;
const SAFE_SQLSTATE = /^[0-9A-Z]{5}$/;
const SAFE_NODE_CODE = /^[A-Z][A-Z0-9_]{2,30}$/;

function driverDetail(err: Prisma.PrismaClientKnownRequestError): string {
  const cause = (err.meta as { driverAdapterError?: { cause?: { kind?: unknown; originalCode?: unknown; code?: unknown } } } | undefined)
    ?.driverAdapterError?.cause;
  if (!cause) return "";
  const parts: string[] = [];
  if (typeof cause.kind === "string" && SAFE_KIND.test(cause.kind)) parts.push(cause.kind);
  const sqlstate = typeof cause.originalCode === "string" ? cause.originalCode : typeof cause.code === "string" ? cause.code : undefined;
  if (sqlstate && SAFE_SQLSTATE.test(sqlstate)) parts.push(sqlstate);
  return parts.length ? `/${parts.join("/")}` : "";
}

export function safeErrorTag(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return `PrismaClientKnownRequestError(${err.code}${driverDetail(err)})`;
  }
  if (err instanceof Error) {
    const name = err.constructor.name || "Error";
    // Node/system error codes (ECONNRESET, ETIMEDOUT...) are fixed constants.
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" && SAFE_NODE_CODE.test(code) ? `${name}(${code})` : name;
  }
  return typeof err;
}

/** Safe metadata ONLY — hostname, port, and database name, read via the
 * standard URL accessors that never touch `.username`/`.password`. Answers
 * "which database is this runtime actually pointed at?" from inside
 * Vercel's own runtime logs, without requiring anyone to separately open
 * the dashboard's Environment Variables page and compare by hand — the
 * exact gap the sibling website's own incident above sat blocked on for
 * several exchanges before someone thought to log this alongside the
 * error itself. Never include this string, or any part of it, in a
 * response sent to the browser — same rule as safeErrorTag(). */
export function describeDatabaseTarget(): string {
  const url = process.env.DATABASE_URL;
  if (!url) return "DATABASE_URL is not set in this runtime";
  try {
    const u = new URL(url);
    const db = u.pathname.replace(/^\//, "") || "(no path)";
    return `${u.hostname}:${u.port || "(default)"}/${db}`;
  } catch {
    return "DATABASE_URL is set but is not a valid URL";
  }
}
