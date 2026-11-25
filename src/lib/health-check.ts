import { prisma, getPrismaPoolStats, getPoolSettings } from "@/lib/prisma";
import { safeErrorTag } from "@/lib/safe-error-log";
import { trustedProxyMode } from "@/lib/request-ip";
import { getMigrationStatus } from "@/server/system/migration-status";
import { getCardVaultStatus } from "@/server/security/card-vault-status";
import { getDatabaseTlsMode } from "@/lib/db-tls";
import { isWebsiteApiConfigured } from "@/server/security/website-api-auth";
import { isLeadIngestSecretConfigured } from "@/server/lead-ingest-context";
import { websiteSignatureRequired } from "@/server/website-request-signature";
import { getGeoIpDatabaseStatus } from "@/server/geo/ip-geolocation";
import { status as uploadStorageStatus } from "@/server/storage/local";
import { inProcessPollerDisabled } from "@/lib/poller-config";
import { sequenceSchedulerState } from "@/server/scheduler-status";

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
    /** "unavailable" = card details cannot be stored right now, so the customer's "Finish Booking" is refused (production guard or vault key — see payment-vault.ts / card-vault-status.ts). */
    bookingCardStorage: "available" | "unavailable";
    /** Whether the card key ring is usable. A category only — never a key or any part of one. */
    cardVaultKey: "configured" | "missing" | "invalid";
    /** disabled | misconfigured | available | available_risk_accepted — see card-vault-status.ts. */
    cardVaultState: "disabled" | "misconfigured" | "available" | "available_risk_accepted";
    /** Id (an opaque label, never key material) of the key new cards are encrypted under; null when no usable key. */
    cardVaultKeyVersion: string | null;
    /** In a production-class environment: the owner explicitly enabled the vault (CARD_VAULT_MODE). Always true elsewhere. */
    cardVaultEnabled: boolean;
    /** What this process treats itself as — a production deployment is always identifiable as one. */
    environment: "production" | "preview" | "development" | "test";
    /** Whether the database connection verifies the server's certificate and host name (DATABASE_SSL_CA / DATABASE_SSL_VERIFY=system), is only encrypted, or has TLS explicitly disabled for a private-network database (DATABASE_SSL_MODE=disable). */
    databaseTls: "verified" | "unverified" | "disabled";
    /** "not_configured" = signed website visitor context (IP / location of a website lead) cannot be verified, so website leads carry no visitor IP. A boolean category only — never the secret. */
    leadIngestSecret: "configured" | "not_configured";
    /** "configured" = the authenticated website API (POST /api/v1/website/flight-inquiries) has a usable key and is enabled; "not_configured" = it answers 503. A category only — never the key. */
    websiteApi: "configured" | "not_configured";
    /** How website-to-CRM requests are authenticated: "required" (every request must carry a valid single-use v2 signature - always so in production with a secret), "optional" (outside production only: a secret is set but WEBSITE_SIGNATURE_REQUIRED is not) or "not_configured" (no usable secret: nothing can be verified, and where signatures are required every website request is refused). A category only - never the secret. */
    websiteSignature: "required" | "optional" | "not_configured";
    /** The local IP-geolocation database: "ready", "stale" (older than 90 days, still used), "missing" (locations are country-level at best) or "unusable". A category only - never a path. */
    geoIpDatabase: "ready" | "stale" | "missing" | "unusable";
    /** "disabled" = the signer's IP address is not recorded (no trusted proxy — see request-ip.ts). */
    signerIpCapture: "enabled" | "disabled";
    /**
     * The Lead-document store on the VPS disk: "ready"; "low_space" = free space is below the reserve (UPLOAD_MIN_FREE_MB), so NEW uploads are
     * refused while existing files stay readable; "unavailable" = the directory is missing / not writable / misconfigured (for example the
     * bind mount is absent). A category only - never a path or a size.
     */
    uploadStorage: "ready" | "low_space" | "unavailable";
    /**
     * Whether automatic sequence sending is alive in THIS server process: "running" (the once-a-minute poller, or an external caller of /api/cron/sequences, has
     * completed a sweep within the last three minutes), "not_started", "stalled" (started but silent or failing), or "disabled" (DISABLE_IN_PROCESS_POLLER is on and
     * nothing has called the cron route recently - sequence steps are then NOT being sent from here). A category only; see server/scheduler-status.ts.
     */
    sequenceScheduler: "running" | "not_started" | "stalled" | "disabled";
    /** "pending" = this build expects a database migration the database has not applied (count only; names are Admin-only). */
    schema: "current" | "pending" | "unknown";
    pendingMigrations: number;
  };
};
type HealthResult = { body: HealthBody; status: number };

let cached: { at: number; result: HealthResult } | null = null;
let inflight: Promise<HealthResult> | null = null;

function readiness(schema: Awaited<ReturnType<typeof getMigrationStatus>> | null, uploadStorage: HealthBody["readiness"]["uploadStorage"], geoIpDatabase: HealthBody["readiness"]["geoIpDatabase"]): HealthBody["readiness"] {
  const vault = getCardVaultStatus();
  return {
    bookingCardStorage: vault.storageAvailable ? "available" : "unavailable",
    cardVaultKey: vault.key,
    cardVaultState: vault.state,
    cardVaultKeyVersion: vault.keyVersion,
    cardVaultEnabled: !vault.productionClass || vault.modeAccepted,
    environment: vault.environment,
    databaseTls: ((mode) => (mode === "unverified" ? "unverified" : mode === "disabled" ? "disabled" : "verified"))(getDatabaseTlsMode()),
    leadIngestSecret: isLeadIngestSecretConfigured() ? "configured" : "not_configured",
    websiteApi: isWebsiteApiConfigured() ? "configured" : "not_configured",
    websiteSignature: !isLeadIngestSecretConfigured() ? "not_configured" : websiteSignatureRequired() ? "required" : "optional",
    geoIpDatabase,
    signerIpCapture: trustedProxyMode() === "none" ? "disabled" : "enabled",
    uploadStorage,
    sequenceScheduler: sequenceSchedulerState(inProcessPollerDisabled()),
    schema: schema?.state ?? "unknown",
    pendingMigrations: schema && schema.state !== "unknown" ? schema.pending.length : 0,
  };
}

function poolSnapshot() {
  const stats = getPrismaPoolStats();
  return stats ? { max: getPoolSettings().max, ...stats } : null;
}

/** The GeoIP database category for the report; never throws (a failure to look is reported as "unusable", not as an error of the database probe). */
async function geoIpState(): Promise<HealthBody["readiness"]["geoIpDatabase"]> {
  try {
    return (await getGeoIpDatabaseStatus()).state;
  } catch {
    return "unusable";
  }
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
        readiness: readiness(schema, (await uploadStorageStatus()).state, await geoIpState()),
      },
    };
  } catch (err) {
    console.error(`[health] DATABASE_CHECK_FAILED (${safeErrorTag(err)})`);
    return {
      status: 503,
      body: { status: "down", checkedAt: new Date().toISOString(), database: { ok: false, error: safeErrorTag(err) }, pool: poolSnapshot(), readiness: readiness(null, (await uploadStorageStatus()).state, await geoIpState()) },
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
