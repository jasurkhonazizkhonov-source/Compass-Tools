// Vitest globalSetup: the fail-closed gate in front of EVERY database-backed test file (the 25 *.integration.test.ts files, reference-data.test.ts,
// and scripts/__integration__). It runs once, before any test file is loaded, so an unsafe configuration stops the whole run before a single
// connection or write can happen.
//
//   1. STATIC: INTEGRATION_DATABASE_URL (and INTEGRATION_ADMIN_DATABASE_URL when present) must pass src/test/disposable-database.ts - loopback
//      literal host, explicit port and user, only a safe sslmode, database exactly `compass_test` (admin: exactly `postgres` on the SAME host and
//      port). Anything else throws and the run is aborted.
//   2. LIVE: it then connects (one short-lived connection) and asks the server which database and address it really reached; the answer must be
//      `compass_test` on a loopback address (or a local socket). If the server cannot be reached or answers anything else the run is aborted -
//      "could not verify" is never treated as "safe".
//
// Why a PostgreSQL in a Docker container that is reached through a published port (-p 127.0.0.1:5432:5432) is REFUSED: the client connects to
// loopback, but Docker forwards the connection into the container, where the server's own address is on the container network (for example
// 172.17.0.2), so inet_server_addr() is not loopback. That is exactly what an SSH tunnel to a real remote database looks like too, and the guard
// must refuse that, so it does not try to tell the two apart or to learn Docker's address ranges. The disposable database has to be reachable on
// loopback itself: CI starts it with --network host and listen_addresses=127.0.0.1 and asserts that nothing else listens on its port
// (.github/workflows/ci.yml); a developer machine uses a PostgreSQL that listens on loopback.
// With neither variable set nothing happens (the database-backed files skip themselves, exactly as before). DATABASE_URL, .env files and every PG*
// variable are never read here.
import pg from "pg";
import { resolveDisposableAdminDatabase, resolveDisposableDatabase } from "./disposable-database";

type QueryResult = { rows: Array<{ db: string; addr: string | null }> };
export type VerifyClient = { connect(): Promise<unknown>; query(sql: string): Promise<QueryResult>; end(): Promise<unknown> };
export type VerifyClientFactory = (config: { connectionString: string; ssl: false | { rejectUnauthorized: false }; connectionTimeoutMillis: number }) => VerifyClient;

const LOOPBACK_ANSWERS = new Set(["127.0.0.1", "::1"]);
const refuse = (why: string): never => {
  throw new Error(`Database tests refused: ${why}. Nothing was run.`);
};

/**
 * What KIND of address the server answered from, never the address itself: a refusal is printed in logs (CI logs of a public repository included), and the
 * address of a database somebody pointed the tests at by mistake must not end up there. The kind is enough to diagnose a container or VPC network.
 */
export function describeNonLoopbackAddress(addr: string): string {
  const a = addr.replace(/\/\d+$/, "").toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (v4) {
    const [o1, o2] = [Number(v4[1]), Number(v4[2])];
    if (o1 === 10 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168)) return "a private IPv4 network (RFC 1918), typically a container, VPC or LAN";
    if (o1 === 127) return "a loopback-range address other than 127.0.0.1";
    if (o1 === 169 && o2 === 254) return "a link-local IPv4 address";
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return "a shared (CGNAT) IPv4 address";
    return "a public IPv4 address";
  }
  if (a.includes(":")) {
    if (a.startsWith("fc") || a.startsWith("fd")) return "an IPv6 unique-local address";
    if (a.startsWith("fe8") || a.startsWith("fe9") || a.startsWith("fea") || a.startsWith("feb")) return "an IPv6 link-local address";
    if (a.startsWith("::ffff:")) return "an IPv4-mapped IPv6 address (not accepted: only 127.0.0.1 and ::1 are)";
    return "an IPv6 address other than ::1";
  }
  return "an address that is not a recognisable IP address";
}

/** Connection string without the sslmode parameter (the pg driver would otherwise apply its own certificate policy); TLS is requested explicitly. */
function splitSslMode(url: string): { connectionString: string; ssl: false | { rejectUnauthorized: false } } {
  const u = new URL(url);
  const wantsTls = !!u.searchParams.get("sslmode");
  u.search = "";
  return { connectionString: u.toString(), ssl: wantsTls ? { rejectUnauthorized: false } : false };
}

/** Connects once and checks the server's own answer. Throws (never returns false) when the target is not exactly the approved local database. */
export async function verifyConnectedTarget(url: string, expectedDatabase: string, makeClient: VerifyClientFactory = (c) => new pg.Client(c) as unknown as VerifyClient): Promise<void> {
  const { connectionString, ssl } = splitSslMode(url);
  const client = makeClient({ connectionString, ssl, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    const { rows } = await client.query("select current_database() as db, inet_server_addr()::text as addr");
    const row = rows[0];
    if (!row || row.db !== expectedDatabase) return refuse(`the connected database is not ${expectedDatabase}`);
    // A local Unix-socket connection reports no address; a TCP connection must report a loopback one.
    if (row.addr !== null && !LOOPBACK_ANSWERS.has(row.addr.replace(/\/\d+$/, ""))) {
      return refuse(`the server answered from a non-loopback address (${describeNonLoopbackAddress(row.addr)}); the disposable database must be reachable on loopback itself, not through a forwarded or container address`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Database tests refused")) throw error;
    // The message of a connection error can contain the host or user name; it is deliberately not repeated.
    return refuse("the target database could not be verified (it is not reachable, or did not answer as expected)");
  } finally {
    await Promise.resolve(client.end()).catch(() => undefined);
  }
}

/** The whole decision for one environment, with the environment and the connection factory injectable so every outcome can be tested without a database. */
export async function verifyConfiguredTargets(env: Record<string, string | undefined> = process.env, makeClient?: VerifyClientFactory): Promise<void> {
  const target = resolveDisposableDatabase(env); // throws when configured but unsafe
  const admin = resolveDisposableAdminDatabase(env); // throws when configured but unsafe / without the main URL
  if (target) await verifyConnectedTarget(target.url, target.database, makeClient);
  if (admin) await verifyConnectedTarget(admin.url, admin.database, makeClient);
}

export default async function setup(): Promise<void> {
  await verifyConfiguredTargets();
}
