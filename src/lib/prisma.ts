import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { wrapPoolWithConnectRetry, type ConnectablePool } from "@/lib/db-connection-retry";

declare global {
  var __prisma: PrismaClient | undefined;
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

// Pool sizing and timeouts are configurable per environment rather than
// hard-coded from a single past measurement of one database. An earlier
// revision capped this at 3 connections / 5s based on a max_connections
// reading from a database that no longer exists; under real use that cap
// was itself the failure: one CRM page issues 20-37 statements, every open
// tab polls in the background, and with 3 connections shared by all of it
// the queue outran the 5s acquisition timeout — pg-pool then threw
// "timeout exceeded when trying to connect", which the CRM rendered as
// "This page couldn't load" (reproduced locally with 10 concurrent page
// loads against a 300ms-latency database, and against production with as
// few as 5 concurrent requests). Defaults below favour throughput on a
// high-latency link while staying modest per instance; a genuinely
// connection-limited database is handled by the connect-retry wrapper
// (see src/lib/db-connection-retry.ts) and, properly, by pointing
// DATABASE_URL at a connection pooler. Tune with:
//   DATABASE_POOL_MAX                 max connections per instance (default 5)
//   DATABASE_POOL_CONNECT_TIMEOUT_MS  per-attempt acquisition timeout (default 8000)
//   DATABASE_POOL_IDLE_TIMEOUT_MS     idle connection lifetime (default 10000)
//   DATABASE_CONNECT_RETRIES          extra acquisition attempts (default 2)
function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** Pool sizing/timeouts actually in effect (also used by the health check). */
export function getPoolSettings() {
  return {
    max: intFromEnv("DATABASE_POOL_MAX", 5, 1, 50),
    connectionTimeoutMillis: intFromEnv("DATABASE_POOL_CONNECT_TIMEOUT_MS", 8_000, 1_000, 60_000),
    idleTimeoutMillis: intFromEnv("DATABASE_POOL_IDLE_TIMEOUT_MS", 10_000, 1_000, 600_000),
    connectRetries: intFromEnv("DATABASE_CONNECT_RETRIES", 2, 0, 5),
  };
}

type PoolStatsSource = { totalCount: number; idleCount: number; waitingCount: number };
let poolForStats: PoolStatsSource | undefined;

/** Live pool occupancy for this instance, or null before first use. */
export function getPrismaPoolStats(): { total: number; idle: number; waiting: number } | null {
  if (!poolForStats) return null;
  return { total: poolForStats.totalCount, idle: poolForStats.idleCount, waiting: poolForStats.waitingCount };
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
      baseDelayMs: 300,
      onRetry: ({ attempt, reason }) => console.warn(`[db] connection acquire retry ${attempt}: ${reason}`),
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
      // Aiven's managed Postgres uses a CA not in Node's default trust store.
      // Encrypted-but-unverified is an accepted tradeoff for this dev/test DB.
      ssl: { rejectUnauthorized: false },
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
  return new PrismaClient({ adapter });
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
let cachedClient: PrismaClient | undefined;

function getPrismaClient(): PrismaClient {
  if (globalThis.__prisma) return globalThis.__prisma;
  if (cachedClient) return cachedClient;
  const client = createPrismaClient();
  cachedClient = client;
  if (process.env.NODE_ENV !== "production") {
    globalThis.__prisma = client;
  }
  return client;
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getPrismaClient();
    const value = Reflect.get(client as object, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
