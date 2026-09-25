import { prisma, getPrismaPoolStats, getPoolSettings } from "@/lib/prisma";
import { safeErrorTag } from "@/lib/safe-error-log";
import { isProductionEnvironment } from "@/lib/env";
import { trustedProxyMode } from "@/lib/request-ip";
import { getMigrationStatus } from "@/server/system/migration-status";
import { getPaymentProviderStatus } from "@/server/payments/provider";

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
  // Configuration READINESS only (never a value or secret): whether the two
  // settings the customer booking flow silently depends on are in place.
  // Both fail closed by design, so a missing one shows up to customers as a
  // failed or incomplete booking rather than as an obvious error.
  readiness: {
    /** false = card details cannot be stored in this environment, so the customer's "Finish Booking" is refused (see payment-vault.ts / APP_ENV). */
    bookingCardStorage: "available" | "unavailable";
    /** "not_configured" = no PCI-compliant payment provider is integrated (see docs/PAYMENT_ARCHITECTURE.md). A category only — never a provider name, key or value. */
    paymentProvider: "ready" | "not_configured";
    /** "disabled" = the signer's IP address is not recorded (no trusted proxy — see request-ip.ts). */
    signerIpCapture: "enabled" | "disabled";
    /** "pending" = this build expects a database migration the database has not applied (count only; names are Admin-only). */
    schema: "current" | "pending" | "unknown";
    pendingMigrations: number;
  };
};
type HealthResult = { body: HealthBody; status: number };

let cached: { at: number; result: HealthResult } | null = null;
let inflight: Promise<HealthResult> | null = null;

function readiness(schema: Awaited<ReturnType<typeof getMigrationStatus>> | null): HealthBody["readiness"] {
  return {
    bookingCardStorage: isProductionEnvironment() ? "unavailable" : "available",
    paymentProvider: getPaymentProviderStatus().state === "ready" ? "ready" : "not_configured",
    signerIpCapture: trustedProxyMode() === "none" ? "disabled" : "enabled",
    schema: schema?.state ?? "unknown",
    pendingMigrations: schema && schema.state !== "unknown" ? schema.pending.length : 0,
  };
}

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
    const schema = await getMigrationStatus();
    return {
      status: 200,
      body: {
        status: "ok",
        checkedAt: new Date().toISOString(),
        // The first query may include establishing a connection; the second
        // is the steady-state round trip to the database.
        database: { ok: true, firstQueryMs: Math.round(t1 - t0), secondQueryMs: Math.round(t2 - t1) },
        pool: poolSnapshot(),
        readiness: readiness(schema),
      },
    };
  } catch (err) {
    console.error(`[health] DATABASE_CHECK_FAILED (${safeErrorTag(err)})`);
    return {
      status: 503,
      body: { status: "down", checkedAt: new Date().toISOString(), database: { ok: false, error: safeErrorTag(err) }, pool: poolSnapshot(), readiness: readiness(null) },
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
