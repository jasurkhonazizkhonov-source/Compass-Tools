import { prisma, getPrismaPoolStats, getPoolSettings } from "@/lib/prisma";
import { safeErrorTag } from "@/lib/safe-error-log";

// Database liveness/latency probe behind /api/health. Exposes numbers and a
// safe error category only — never a hostname, credential, connection
// string, query or message text (same rule as safeErrorTag).
//
// Every real check costs two trivial queries, so results are memoized per
// instance for a couple of seconds, INCLUDING the in-flight check: a burst
// of simultaneous requests shares one check instead of each running its own.

const CACHE_TTL_MS = 2_000;

export type HealthBody = {
  status: "ok" | "down";
  checkedAt: string;
  database: { ok: boolean; firstQueryMs?: number; secondQueryMs?: number; error?: string };
  pool: { max: number; total: number; idle: number; waiting: number } | null;
};
type HealthResult = { body: HealthBody; status: number };

let cached: { at: number; result: HealthResult } | null = null;
let inflight: Promise<HealthResult> | null = null;

function poolSnapshot() {
  const stats = getPrismaPoolStats();
  return stats ? { max: getPoolSettings().max, ...stats } : null;
}

async function runCheck(): Promise<HealthResult> {
  try {
    const t0 = performance.now();
    await prisma.$queryRaw`SELECT 1`;
    const t1 = performance.now();
    await prisma.$queryRaw`SELECT 1`;
    const t2 = performance.now();
    return {
      status: 200,
      body: {
        status: "ok",
        checkedAt: new Date().toISOString(),
        // The first query may include establishing a connection; the second
        // is the steady-state round trip to the database.
        database: { ok: true, firstQueryMs: Math.round(t1 - t0), secondQueryMs: Math.round(t2 - t1) },
        pool: poolSnapshot(),
      },
    };
  } catch (err) {
    console.error(`[health] DATABASE_CHECK_FAILED (${safeErrorTag(err)})`);
    return {
      status: 503,
      body: { status: "down", checkedAt: new Date().toISOString(), database: { ok: false, error: safeErrorTag(err) }, pool: poolSnapshot() },
    };
  }
}

export async function getHealth(): Promise<HealthResult> {
  if (cached && Date.now() - cached.at <= CACHE_TTL_MS) return cached.result;
  if (!inflight) {
    inflight = runCheck()
      .then((result) => {
        cached = { at: Date.now(), result };
        return result;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Test seam: drops the per-instance memo. */
export function resetHealthCacheForTests() {
  cached = null;
  inflight = null;
}
