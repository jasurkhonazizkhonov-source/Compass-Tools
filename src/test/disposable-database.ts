// Fail-closed gate for tests that talk to a REAL PostgreSQL.
//
// A test file opts in by mocking "@/lib/prisma" with loadPrismaForDisposableTest() and calling releaseDisposableDatabase() in afterAll
// (see src/server/queries/__tests__/reference-data.test.ts). Vitest hoists vi.mock above every import, so the decision below is made
// BEFORE the real prisma module - and with it the generated client, the pg adapter and any pool - is loaded.
//
// What this does NOT do: it does not read DATABASE_URL, a .env file or any PG* variable, and it does not read or change DATABASE_SSL_*,
// db-tls.ts or the way prisma.ts initialises the client. The validation is static (no driver, no client, no connection).
//
// What it cannot prove: that a loopback port is not an SSH/Docker port-forward to a real server that happens to hold a database
// called "compass_test". The exact database name, the explicit opt-in variable and the loopback literal make that an unlikely accident,
// not an impossibility.

const TARGET_VARIABLE = "INTEGRATION_DATABASE_URL";
/** Literal loopback addresses only: a name such as "localhost" needs a lookup and could be made to point elsewhere. */
const ALLOWED_HOSTS = new Set(["127.0.0.1", "[::1]"]);
/** Exact, reviewed list (CI's database). No prefix, suffix or substring logic: production_test and compass_tools_test are simply absent. A new name is a code change. */
const APPROVED_DATABASES = new Set(["compass_test"]);
/**
 * The query string must be empty or exactly one safe sslmode. The app strips this value from the connection string (prisma.ts,
 * connectionStringWithoutSslMode), so it never changes the app's TLS behaviour - that comes from DATABASE_SSL_MODE / DATABASE_SSL_CA /
 * DATABASE_SSL_VERIFY through db-tls.ts, which this file does not touch. `disable`, `allow`, `prefer`, duplicates, other spellings and every
 * other parameter (host, hostaddr, options, ...) are refused.
 */
const ALLOWED_SEARCH = /^(\?sslmode=(require|verify-ca|verify-full))?$/;

type Env = Record<string, string | undefined>;
/** globalThis, injectable so unit tests never touch the real one. prisma.ts publishes its client as globalThis.__prisma (when NODE_ENV is not "production"). */
type Scope = { __prisma?: unknown };

export type DisposableTarget = { url: string; database: string };

/** Any character up to and including the space, or DEL, or any other Unicode whitespace. Written without a control-character regex. */
function hasWhitespaceOrControl(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || /\s/.test(ch)) return true;
  }
  return false;
}

/** Whether a disposable database was asked for at all. Blank counts as not configured. */
export function isDisposableDatabaseConfigured(env: Env = process.env): boolean {
  return !!env[TARGET_VARIABLE]?.trim();
}

/**
 * null = not configured. Throws when configured but not an approved local disposable database. The message names the broken rule only:
 * it never contains the URL, host, user or password. Pure: reads `env`, writes nothing.
 */
export function resolveDisposableDatabase(env: Env = process.env): DisposableTarget | null {
  const raw = env[TARGET_VARIABLE]?.trim();
  if (!raw) return null;
  const { database } = parseLoopbackUrl(raw, TARGET_VARIABLE, APPROVED_DATABASES);
  return { url: raw, database };
}

// ---- The ONE narrow exception: the admin URL --------------------------------------------------------------------------------------------
// scripts/__integration__/vercel-build.integration.test.ts must connect to the server's maintenance database (`postgres`) to CREATE and DROP its
// own scratch databases (recovery_it_<timestamp>). That is the only test that needs it, and the exception is exactly this wide:
//   * INTEGRATION_DATABASE_URL must ALSO be configured and approved (so an admin URL can never be used on its own);
//   * every rule above applies unchanged (loopback literal host, explicit port and user, no fragment, only the three safe sslmode values);
//   * the database must be exactly `postgres`;
//   * host AND port must be identical to the approved INTEGRATION_DATABASE_URL, i.e. the same local disposable server - never another one.
// It grants no access to any other server. It does mean the credentials used can touch every database on that disposable server, so that server
// must hold nothing but disposable databases.
const ADMIN_VARIABLE = "INTEGRATION_ADMIN_DATABASE_URL";
const ADMIN_DATABASES = new Set(["postgres"]);

export type DisposableAdminTarget = { url: string; database: string; host: string; port: string };

export function isDisposableAdminDatabaseConfigured(env: Env = process.env): boolean {
  return !!env[ADMIN_VARIABLE]?.trim();
}

/** null = not configured. Throws when configured but not the maintenance database of the approved local disposable server. */
export function resolveDisposableAdminDatabase(env: Env = process.env): DisposableAdminTarget | null {
  const raw = env[ADMIN_VARIABLE]?.trim();
  if (!raw) return null;
  const main = resolveDisposableDatabase(env); // throws when INTEGRATION_DATABASE_URL is configured but unsafe
  if (!main) throw new Error(`${ADMIN_VARIABLE} refused: ${TARGET_VARIABLE} must also be configured. No database client was created.`);
  const admin = parseLoopbackUrl(raw, ADMIN_VARIABLE, ADMIN_DATABASES);
  const target = new URL(main.url);
  if (admin.host !== target.hostname || admin.port !== target.port) {
    throw new Error(`${ADMIN_VARIABLE} refused: it must point at the same host and port as ${TARGET_VARIABLE}. No database client was created.`);
  }
  return { url: raw, database: admin.database, host: admin.host, port: admin.port };
}

/**
 * The shared, static syntax check. Pure: no driver, no client, no connection. Throws (message names the broken rule only - never the URL, host,
 * user or password) unless `raw` is a loopback-literal PostgreSQL URL with an explicit port and user, an empty query or exactly one safe sslmode,
 * and a database name from `approved`.
 */
function parseLoopbackUrl(raw: string, variable: string, approved: ReadonlySet<string>): { host: string; port: string; database: string } {
  const refuse = (rule: string): never => {
    throw new Error(`${variable} refused: ${rule}. No database client was created.`);
  };
  if (hasWhitespaceOrControl(raw)) refuse("it contains whitespace or control characters");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return refuse("it is not a valid URL");
  }
  if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") refuse("the scheme must be postgresql://");
  if (!ALLOWED_HOSTS.has(u.hostname)) refuse("the host must be exactly 127.0.0.1 or [::1]");
  if (!u.port) refuse("an explicit port is required");
  if (!u.username) refuse("an explicit user is required");
  if ((raw.match(/@/g) ?? []).length !== 1) refuse("it must contain exactly one @ (an extra @ makes the host ambiguous between parsers)");
  if (raw.includes("#")) refuse("it must not have a fragment");
  if (raw.includes("?") && u.search === "") refuse("it has an empty query string");
  if (!ALLOWED_SEARCH.test(u.search)) refuse("the query string must be empty or exactly one sslmode of require, verify-ca or verify-full");
  const database = u.pathname.startsWith("/") ? u.pathname.slice(1) : u.pathname;
  if (!approved.has(database)) refuse(approved === APPROVED_DATABASES ? "the database is not on the approved disposable list" : "the database must be exactly postgres");
  return { host: u.hostname, port: u.port, database };
}

// One active session per process: what to put back afterwards. Created only AFTER every check has passed.
let session: { env: Env; scope: Scope; hadUrl: boolean; previousUrl: string | undefined } | null = null;

/**
 * For vi.mock("@/lib/prisma", ...). Every refusal below happens before any write and before importOriginal is referenced, so an unsafe
 * or unconfigured setup never loads the real prisma module (and so never creates a client, adapter or pool).
 *
 * Safe path: DATABASE_URL is set to the validated value, because prisma.ts reads it lazily on the first query and must see exactly that
 * value. releaseDisposableDatabase() puts it back.
 */
export async function loadPrismaForDisposableTest<T>(
  importOriginal: () => Promise<T>,
  env: Env = process.env,
  scope: Scope = globalThis as unknown as Scope
): Promise<T | { prisma: object }> {
  const target = resolveDisposableDatabase(env); // 1. pure; throws when unsafe
  if (!target) {
    // 2. Not configured: no write, the real module is never loaded. The stub fails loudly if anything touches the database anyway.
    const blocked = new Proxy(
      {},
      {
        get(_target, property) {
          if (typeof property === "symbol" || property === "then") return undefined;
          throw new Error(`Database access blocked: ${TARGET_VARIABLE} is not set.`);
        },
      }
    );
    return { prisma: blocked };
  }
  if (session) throw new Error("A disposable-database session is already active in this process."); // 3
  // 3b. prisma.ts publishes its client to globalThis.__prisma only when NODE_ENV is not "production"; without that the client could be
  // neither detected beforehand nor closed afterwards. Vitest sets NODE_ENV to "test" unless it was already set.
  if (env.NODE_ENV === "production") throw new Error("NODE_ENV=production is not supported for database tests: the client would not be tracked or closed.");
  // 4. prisma.ts returns globalThis.__prisma before it ever reads DATABASE_URL, so an existing client would silently ignore the validated URL.
  if (scope.__prisma !== undefined) throw new Error("A database client already exists in this process; it could ignore the validated URL.");
  session = { env, scope, hadUrl: "DATABASE_URL" in env, previousUrl: env.DATABASE_URL }; // 5. first and only write
  env.DATABASE_URL = target.url;
  try {
    return await importOriginal(); // 6.
  } catch (error) {
    await releaseDisposableDatabase();
    throw error;
  }
}

/**
 * Closes the client this session created (when prisma.ts published it to scope.__prisma) and restores DATABASE_URL exactly.
 * A no-op without a session. A session exists only if the guard saw NO client at the start, so a pre-existing client is never touched.
 */
export async function releaseDisposableDatabase(): Promise<void> {
  if (!session) return;
  const { env, scope, hadUrl, previousUrl } = session;
  session = null; // cleared first: a failure below can never leave a stuck session
  try {
    const client = scope.__prisma as { $disconnect?: () => unknown } | undefined;
    if (client !== undefined) {
      // Only reachable if the guard found none at the start, so this is the client created during this session. Disconnect the exact
      // object - not through the lazy `prisma` proxy, which would create a client if none existed.
      try {
        await client.$disconnect?.();
      } catch {
        // Best effort: the pool's own idle timeout (prisma.ts) is the backstop.
      } finally {
        delete scope.__prisma;
      }
    }
  } finally {
    if (hadUrl) env.DATABASE_URL = previousUrl as string; // an existing value comes back exactly
    else delete env.DATABASE_URL; // never the string "undefined"
  }
}
