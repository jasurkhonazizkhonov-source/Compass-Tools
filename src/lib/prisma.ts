import { after } from "next/server";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { wrapPoolWithConnectRetry, type ConnectablePool } from "@/lib/db-connection-retry";
import { resolveDatabaseSsl } from "@/lib/db-tls";

// The client type INCLUDING the global omit config (see createPrismaClient), so
// query result types correctly exclude PaymentMethod.encryptedPan.
type AppPrismaClient = ReturnType<typeof createPrismaClient>;

declare global {
  var __prisma: AppPrismaClient | undefined;
}

function connectionStringWithoutSslMode(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // Never echo the value itself — it's a credential-bearing connection
    // string, and this message can surface in a build/deploy log.
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  u.searchParams.delete("sslmode");
  return u.toString();
}

// WHY THESE DEFAULTS (measured against production, not guessed):
//   - GET /api/health showed a steady-state round trip of ~68ms but ~970ms to
//     open a NEW connection, so reusing a connection is valuable but a big
//     pool buys little — the queries are cheap once connected.
//   - Under concurrent load the production database answered with Postgres
//     SQLSTATE 53300 (too_many_connections): each concurrently running
//     serverless instance opens its own connection(s), so total demand is
//     (instances x pool max) and the database's small connection limit is
//     the binding constraint. Hence a SMALL per-instance pool (a request
//     rarely needs more than a couple of connections at once), idle
//     connections released quickly and — critically — BEFORE the instance
//     is suspended (see holdInstanceUntilIdleConnectionsClose), and patient
//     jittered retries when the database is momentarily out of slots so a
//     burst becomes a short queue rather than a wall of 500s.
//   - An earlier revision capped the pool at 3 / 5s from a reading of a
//     database that no longer exists, with no retry: connection-slot errors
//     surfaced as "This page couldn't load".
// The durable fix is a connection pooler in front of Postgres and/or Vercel
// Fluid compute (many requests per instance) — see docs/DEPLOYMENT.md §5b.
// Tune with:
//   DATABASE_POOL_MAX                 max connections per instance (default 2)
//   DATABASE_POOL_CONNECT_TIMEOUT_MS  per-attempt acquisition timeout (default 8000)
//   DATABASE_POOL_IDLE_TIMEOUT_MS     idle connection lifetime (default 4000)
//   DATABASE_CONNECT_RETRIES          extra acquisition attempts (default 6)
function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** Pool sizing/timeouts actually in effect (also used by the health check). */
export function getPoolSettings() {
  return {
    max: intFromEnv("DATABASE_POOL_MAX", 2, 1, 50),
    connectionTimeoutMillis: intFromEnv("DATABASE_POOL_CONNECT_TIMEOUT_MS", 8_000, 1_000, 60_000),
    idleTimeoutMillis: intFromEnv("DATABASE_POOL_IDLE_TIMEOUT_MS", 4_000, 1_000, 600_000),
    connectRetries: intFromEnv("DATABASE_CONNECT_RETRIES", 6, 0, 10),
  };
}

type PoolStatsSource = { totalCount: number; idleCount: number; waitingCount: number };
let poolForStats: PoolStatsSource | undefined;

/** Live pool occupancy for this instance, or null before first use. */
export function getPrismaPoolStats(): { total: number; idle: number; waiting: number } | null {
  if (!poolForStats) return null;
  return { total: poolForStats.totalCount, idle: poolForStats.idleCount, waiting: poolForStats.waitingCount };
}

// A serverless instance is frozen soon after its last response, and a frozen
// process cannot run the pool's idle timer — so its open database
// connections stay occupied (counting against the database's small
// connection limit) until the instance is eventually recycled, potentially
// minutes later. That is how a modest burst of traffic can leave the
// production database "full" long after the burst ended. The fix (the same
// idea as Vercel's attachDatabasePool) is to keep the instance alive, via
// after(), just long enough for the pool to close its idle connections
// itself. Debounced: every release extends one shared deadline rather than
// scheduling a new hold. Outside a request scope (tests, scripts, build)
// after() throws and this is a harmless no-op.
let holdUntil = 0;
let holdActive = false;
function holdInstanceUntilIdleConnectionsClose(idleTimeoutMs: number) {
  holdUntil = Date.now() + idleTimeoutMs + 500;
  if (holdActive) return;
  holdActive = true;
  try {
    after(async () => {
      while (Date.now() < holdUntil) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(50, Math.min(500, holdUntil - Date.now()))));
      }
      holdActive = false;
    });
  } catch {
    holdActive = false;
  }
}

// Subclassed (rather than importing "pg" directly, which is only a
// transitive dependency) to reach the adapter's own Pool exactly once, when
// Prisma first connects.
class ResilientPrismaPg extends PrismaPg {
  async connect() {
    const adapter = await super.connect();
    const pool = adapter.underlyingDriver() as unknown as ConnectablePool & PoolStatsSource;
    poolForStats = pool;
    wrapPoolWithConnectRetry(pool, {
      retries: getPoolSettings().connectRetries,
      baseDelayMs: 250,
      onRetry: ({ attempt, reason }) => console.warn(`[db] connection acquire retry ${attempt}: ${reason}`),
      onRelease: () => holdInstanceUntilIdleConnectionsClose(getPoolSettings().idleTimeoutMillis),
    });
    return adapter;
  }
}

function createPrismaClient() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set. Configure it in your environment before using the database.");
  }
  const settings = getPoolSettings();
  const adapter = new ResilientPrismaPg(
    {
      connectionString: connectionStringWithoutSslMode(databaseUrl),
      // TLS: verified when DATABASE_SSL_CA (or DATABASE_SSL_VERIFY=system) is set;
      // otherwise encrypted-but-unverified — Aiven's CA is not in Node's default
      // trust store, so verification needs the project CA certificate. See
      // src/lib/db-tls.ts and docs/CARD_VAULT_SECURITY.md.
      ssl: resolveDatabaseSsl(),
      max: settings.max,
      connectionTimeoutMillis: settings.connectionTimeoutMillis,
      idleTimeoutMillis: settings.idleTimeoutMillis,
      keepAlive: true,
    },
    {
      // An idle pooled client can error (the server closed it, a NAT
      // dropped it). Without a listener Node treats that as an uncaught
      // exception; log a safe tag and let the pool discard the client.
      onPoolError: (err) => console.error(`[db] idle pool client error (${err.constructor.name})`),
    }
  );
  return new PrismaClient({
    adapter,
    // Defence in depth for the card vault: the encrypted card number is left
    // out of EVERY read unless a query opts in explicitly (`select: {
    // encryptedPan: true }` — only revealPaymentMethod and the key-rotation
    // module do). A forgotten `select`, a generic `findMany`, or an object
    // passed to a client component can therefore never carry ciphertext.
    omit: { paymentMethod: { encryptedPan: true } },
  });
}

// Pass 35 — real bug found and fixed: this module used to construct the
// Prisma client (and parse DATABASE_URL) eagerly at MODULE EVALUATION time
// (`export const prisma = ... ?? createPrismaClient()` ran the moment
// anything imported this file). `next build`'s "Collecting page data" step
// imports every route module to statically analyze it — including a Route
// Handler that's never statically rendered and only touches the database
// once a real request arrives (e.g. /api/auth/gmail/callback) — so any file
// that transitively imports this module got its DB connection constructed
// (and DATABASE_URL parsed) DURING THE BUILD, not at request time. If
// DATABASE_URL is absent/empty/malformed in the build environment, that
// throws `ERR_INVALID_URL` from inside `new URL()` and fails the entire
// build for a route that doesn't need the database yet. Every other
// secret-reading module in this codebase (card-encryption.ts,
// ip-encryption.ts, gmail-token-encryption.ts, google-config.ts) already
// defers its process.env read into a function called at actual use time —
// this brings prisma.ts in line with that same established pattern via a
// Proxy, so every existing `prisma.xxx.yyy()` / `prisma.$transaction(...)`
// call site elsewhere in the app is completely unchanged; only the timing
// of client construction moves from "on import" to "on first real use".
// Functions are bound to the real client (not the Proxy) so internal `this`
// usage inside Prisma's own methods still resolves correctly.
let cachedClient: AppPrismaClient | undefined;

function getPrismaClient(): AppPrismaClient {
  if (globalThis.__prisma) return globalThis.__prisma;
  if (cachedClient) return cachedClient;
  const client = createPrismaClient();
  cachedClient = client;
  if (process.env.NODE_ENV !== "production") {
    globalThis.__prisma = client;
  }
  return client;
}

export const prisma = new Proxy({} as AppPrismaClient, {
  get(_target, prop) {
    const client = getPrismaClient();
    const value = Reflect.get(client as object, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
