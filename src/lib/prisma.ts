import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

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

// Real bug found and fixed: measured directly against the actual database
// (SELECT setting FROM pg_settings WHERE name = 'max_connections') — this
// Aiven Postgres instance allows only 20 total connections, and ~9-10 of
// those are permanently held by Aiven's own background/management
// processes (pg_failover_slots worker, management-agent, TimescaleDB
// Background Worker Launcher, pg_cron scheduler — confirmed via
// pg_stat_activity), leaving roughly 10-11 for ALL actual application
// traffic combined (this CRM, and anything else that connects to the same
// database — e.g. the public website's own lead/subscriber/inquiry
// submission path). node-postgres's own Pool defaults `max` to 10 when
// unset (confirmed in node_modules/pg-pool/index.js:
// `this.options.max = this.options.max || this.options.poolSize || 10`) —
// which this adapter never overrode. Each warm Vercel serverless
// function instance constructs its OWN separate pool (the lazy-singleton
// below caches one client per container, not across containers), so under
// even modest concurrent traffic, multiple simultaneously-warm instances
// each opening up to 10 connections can collectively exceed the
// database's entire remaining budget — at which point Postgres refuses
// new connections outright ("sorry, too many clients already") for
// whichever query happens to need one at that moment. That failure isn't
// tied to any specific page or route — it depends only on connection
// pressure at that instant — which matches an intermittent "sometimes,
// different pages" production symptom far better than any single page's
// own code. Capped conservatively here so a single instance can never
// alone consume more than a small fraction of the available budget,
// leaving headroom for other concurrent instances and for whatever else
// shares this database.
const MAX_POOL_CONNECTIONS_PER_INSTANCE = 3;

function createPrismaClient() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set. Configure it in your environment before using the database.");
  }
  const adapter = new PrismaPg({
    connectionString: connectionStringWithoutSslMode(databaseUrl),
    // Aiven's managed Postgres uses a CA not in Node's default trust store.
    // Encrypted-but-unverified is an accepted tradeoff for this dev/test DB.
    ssl: { rejectUnauthorized: false },
    max: MAX_POOL_CONNECTIONS_PER_INSTANCE,
  });
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
