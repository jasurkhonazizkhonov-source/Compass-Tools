// The System Health check catalogue. Every check answers ONE question and
// returns one of four states:
//   HEALTHY  — working, or intentionally not in use (an OPTIONAL feature that
//              is simply not configured is HEALTHY with a note, never a fault)
//   WARNING  — degraded or needs attention, but customers are not blocked
//   CRITICAL — a core flow is broken or blocked
//   UNKNOWN  — the check itself could not run (never silently "fine")
//
// Hard rules:
//   - NEVER return a secret, key, connection string, host, user, SQL text or
//     stack trace. Configuration is reported only as Configured / Missing /
//     Invalid, and failures only by a short safe category (safeErrorTag).
//   - Read-only. Nothing here writes to business tables or "fixes" anything.
//   - A check that throws is UNKNOWN, not an unhandled error and not a guess.
import { prisma, getPrismaPoolStats, getPoolSettings } from "@/lib/prisma";
import { safeErrorTag } from "@/lib/safe-error-log";
import { isProductionEnvironment } from "@/lib/env";
import { trustedProxyConfig } from "@/lib/request-ip";
import { getMigrationStatus } from "@/server/system/migration-status";
import { getPaymentProviderStatus } from "@/server/payments/provider";

export type HealthState = "HEALTHY" | "WARNING" | "CRITICAL" | "UNKNOWN";
export type HealthGroup = "critical" | "warning" | "informational";

export type HealthCheckResult = {
  id: string;
  category: string;
  title: string;
  state: HealthState;
  summary: string;
  /** What an Admin should do, when there is something to do. */
  action?: string;
  /** Short, non-sensitive facts (counts, milliseconds, Configured/Missing). */
  facts?: Array<{ label: string; value: string }>;
};

export type ConfigStatus = "Configured" | "Missing" | "Invalid";

/** Presence/validity of a base64 key WITHOUT ever exposing it. */
export function base64KeyStatus(raw: string | undefined, expectedBytes: number | { min: number }): ConfigStatus {
  const value = raw?.trim();
  if (!value) return "Missing";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return "Invalid";
  const length = Buffer.from(value, "base64").length;
  if (typeof expectedBytes === "number" ? length !== expectedBytes : length < expectedBytes.min) return "Invalid";
  return "Configured";
}

function envStatus(name: string): ConfigStatus {
  return process.env[name]?.trim() ? "Configured" : "Missing";
}

/** Group an Admin sees a check under. UNKNOWN is a warning: unverified is not "fine". */
export function groupForState(state: HealthState): HealthGroup {
  if (state === "CRITICAL") return "critical";
  if (state === "HEALTHY") return "informational";
  return "warning";
}

export function overallState(results: readonly Pick<HealthCheckResult, "state">[]): HealthState {
  if (results.some((r) => r.state === "CRITICAL")) return "CRITICAL";
  if (results.some((r) => r.state === "WARNING")) return "WARNING";
  if (results.some((r) => r.state === "UNKNOWN")) return "UNKNOWN";
  return "HEALTHY";
}

async function guarded(id: string, category: string, title: string, run: () => Promise<Omit<HealthCheckResult, "id" | "category" | "title">>): Promise<HealthCheckResult> {
  try {
    return { id, category, title, ...(await run()) };
  } catch (err) {
    return { id, category, title, state: "UNKNOWN", summary: `This check could not run (${safeErrorTag(err)}).`, action: "Retry; if it persists, check the database connection." };
  }
}

// ── database ──────────────────────────────────────────────────────────────

async function checkDatabaseConnectivity(): Promise<HealthCheckResult> {
  return guarded("database.connectivity", "database", "Database reachable", async () => {
    const t0 = performance.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      return { state: "CRITICAL", summary: `The database did not answer (${safeErrorTag(err)}).`, action: "Check the database service and DATABASE_URL. See docs/DEPLOYMENT.md (database connections)." };
    }
    const ms = Math.round(performance.now() - t0);
    return {
      state: ms > 2500 ? "WARNING" : "HEALTHY",
      summary: ms > 2500 ? "The database answers, but slowly." : "The database answers normally.",
      facts: [{ label: "Round trip", value: `${ms} ms` }],
      action: ms > 2500 ? "A cold connection can take ~1s; consistently slow answers point to network distance or an overloaded database." : undefined,
    };
  });
}

async function checkMigrations(): Promise<HealthCheckResult> {
  return guarded("database.migrations", "database", "Database schema up to date", async () => {
    const status = await getMigrationStatus();
    if (status.state === "unknown") {
      return { state: "UNKNOWN", summary: "The migration history could not be read.", facts: [{ label: "Expected migrations", value: String(status.expected) }] };
    }
    if (status.state === "pending") {
      return {
        state: "CRITICAL",
        summary: `${status.pending.length} migration(s) this version needs have not been applied. Features that use the new columns will fail.`,
        action: "Run `prisma migrate deploy` (the Vercel build does this automatically). See docs/DEPLOYMENT.md.",
        facts: [{ label: "Pending", value: status.pending.slice(0, 5).join(", ") + (status.pending.length > 5 ? ", …" : "") }],
      };
    }
    return { state: "HEALTHY", summary: "Every migration this version expects is applied.", facts: [{ label: "Applied / expected", value: `${status.applied} / ${status.expected}` }] };
  });
}

async function checkConnectionPressure(): Promise<HealthCheckResult> {
  return guarded("database.connections", "database", "Database connection headroom", async () => {
    const pool = getPrismaPoolStats();
    const max = getPoolSettings().max;
    const facts: Array<{ label: string; value: string }> = [{ label: "This instance's pool", value: pool ? `${pool.total} open / ${max} max, ${pool.waiting} waiting` : "not yet used" }];
    let serverUsed: number | null = null;
    let serverMax: number | null = null;
    try {
      const rows = await prisma.$queryRaw<Array<{ used: number; max: number }>>`
        SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::int AS used,
               current_setting('max_connections')::int AS max`;
      serverUsed = rows[0]?.used ?? null;
      serverMax = rows[0]?.max ?? null;
    } catch {
      // Managed databases may hide pg_stat_activity — report that honestly.
    }
    if (serverUsed !== null && serverMax !== null) facts.push({ label: "Database connections", value: `${serverUsed} of ${serverMax}` });
    else facts.push({ label: "Database connections", value: "Unavailable (not visible to this role)" });

    const ratio = serverUsed !== null && serverMax ? serverUsed / serverMax : null;
    if (ratio !== null && ratio >= 0.95) return { state: "CRITICAL", summary: "The database is nearly out of connections; new requests will start failing.", facts, action: "Use a connection pooler (e.g. PgBouncer) and/or raise the plan's connection limit. See docs/DEPLOYMENT.md." };
    if ((ratio !== null && ratio >= 0.8) || (pool && pool.waiting > 0)) return { state: "WARNING", summary: "Connection usage is high.", facts, action: "Watch this; a pooler or a larger connection limit is the durable fix. See docs/DEPLOYMENT.md." };
    return { state: "HEALTHY", summary: "Connection usage is comfortable.", facts };
  });
}

// ── configuration ─────────────────────────────────────────────────────────

async function checkAuthConfig(): Promise<HealthCheckResult> {
  return guarded("auth.google", "auth", "Google sign-in configuration", async () => {
    const id = envStatus("GOOGLE_CLIENT_ID");
    const secret = envStatus("GOOGLE_CLIENT_SECRET");
    const base = envStatus("APP_BASE_URL");
    const facts = [
      { label: "GOOGLE_CLIENT_ID", value: id },
      { label: "GOOGLE_CLIENT_SECRET", value: secret },
      { label: "APP_BASE_URL", value: base },
    ];
    if (id === "Missing") return { state: "CRITICAL", summary: "Google sign-in is not configured, so no one can log in.", facts, action: "Set GOOGLE_CLIENT_ID (and the secret) in the environment." };
    if (secret === "Missing") return { state: "WARNING", summary: "Google sign-in works, but Gmail connection (which needs the client secret) will not.", facts, action: "Set GOOGLE_CLIENT_SECRET." };
    return { state: "HEALTHY", summary: "Google sign-in credentials are configured.", facts };
  });
}

async function checkGmail(): Promise<HealthCheckResult> {
  return guarded("email.gmail", "email", "Gmail sending", async () => {
    const key = base64KeyStatus(process.env.GMAIL_TOKEN_ENCRYPTION_KEY, 32);
    const [connected, needsReauth, sent24h, failed24h] = await Promise.all([
      prisma.gmailConnection.count({ where: { status: "CONNECTED" } }),
      prisma.gmailConnection.count({ where: { status: { not: "CONNECTED" } } }),
      prisma.emailLog.count({ where: { status: "SENT", createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } } }),
      prisma.emailLog.count({ where: { status: "FAILED", createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } } }),
    ]);
    const facts = [
      { label: "Token encryption key", value: key },
      { label: "Connected mailboxes", value: String(connected) },
      { label: "Mailboxes needing reconnect", value: String(needsReauth) },
      { label: "Emails sent / failed (24h)", value: `${sent24h} / ${failed24h}` },
    ];
    if (key !== "Configured") return { state: "CRITICAL", summary: `Gmail token encryption key is ${key.toLowerCase()}, so emails cannot be sent.`, facts, action: "Set GMAIL_TOKEN_ENCRYPTION_KEY to a base64-encoded 32-byte key (existing connections must be re-linked if it changes)." };
    if (failed24h >= 5 && failed24h > sent24h) return { state: "CRITICAL", summary: "Most emails in the last 24 hours failed to send.", facts, action: "Open Gmail settings, reconnect the affected mailbox, and check Google's status." };
    if (needsReauth > 0) return { state: "WARNING", summary: `${needsReauth} mailbox(es) must be reconnected before they can send.`, facts, action: "The affected user should reconnect Gmail from their settings." };
    if (failed24h >= 3) return { state: "WARNING", summary: "Several emails failed in the last 24 hours.", facts, action: "Review the recent failures in the email log." };
    if (connected === 0) return { state: "WARNING", summary: "No mailbox is connected, so quotes and notifications cannot be emailed.", facts, action: "Connect Gmail for at least one user." };
    return { state: "HEALTHY", summary: "Gmail sending is configured and working.", facts };
  });
}

async function checkPaymentProvider(): Promise<HealthCheckResult> {
  return guarded("payment.provider", "payment", "Payment provider & booking readiness", async () => {
    const status = getPaymentProviderStatus();
    const production = isProductionEnvironment();
    const facts = [
      { label: "Environment", value: production ? "production" : "non-production" },
      { label: "Provider adapter", value: status.adapterAvailable ? (status.provider ?? "available") : "none installed" },
      { label: "Provider configuration", value: status.state === "ready" ? "Configured" : status.missing.length ? `Missing: ${status.missing.join(", ")}` : "Not applicable" },
      { label: "Card security code", value: "Never collected or stored by Compass Tools" },
    ];
    if (status.state === "ready") return { state: "HEALTHY", summary: `Payments are handled by ${status.provider}; the CRM keeps only tokens and display details.`, facts };
    if (production) {
      return {
        state: "CRITICAL",
        summary: "No PCI-compliant payment provider is integrated. Customer bookings cannot be completed in production (card storage is deliberately refused).",
        action: "Choose a provider and implement its adapter behind src/server/payments/provider.ts — see docs/PAYMENT_ARCHITECTURE.md. Do not work around this with APP_ENV.",
        facts,
      };
    }
    return { state: "HEALTHY", summary: "Non-production: the development test vault is in use (sandbox/test card numbers only; the production vault is fail-closed).", facts };
  });
}

async function checkSignerIp(): Promise<HealthCheckResult> {
  return guarded("signer.ip", "security", "Signer IP capture", async () => {
    const cfg = trustedProxyConfig();
    const facts: Array<{ label: string; value: string }> = [
      { label: "Trusted proxy mode", value: cfg.mode === "none" ? "none" : `${cfg.mode} (${cfg.source === "platform" ? "detected from the platform" : "explicit"})` },
    ];
    if (cfg.mode === "none") {
      if (isProductionEnvironment()) {
        return { state: "WARNING", summary: "Signer IP addresses are NOT being recorded: no trusted proxy is configured (or it was explicitly set to none).", facts, action: "Set TRUSTED_PROXY to describe the real proxy in front of the app (vercel / cloudflare / nginx / generic). See docs/DEPLOYMENT.md." };
      }
      return { state: "HEALTHY", summary: "Local/development: there is no proxy, so no IP is recorded (expected).", facts };
    }
    const recent = await prisma.signature.findMany({ orderBy: { signedAt: "desc" }, take: 10, select: { ipAddress: true } });
    const missing = recent.filter((s) => !s.ipAddress).length;
    facts.push({ label: "Recent signings without an IP", value: `${missing} of ${recent.length}` });
    if (recent.length >= 5 && missing === recent.length) {
      return { state: "WARNING", summary: "IP capture is enabled but none of the latest signings recorded an address.", facts, action: "Check that the configured proxy really sets the forwarding header (see docs/DEPLOYMENT.md)." };
    }
    return { state: "HEALTHY", summary: "Signer IP capture is enabled.", facts };
  });
}

async function checkEncryptionKeys(): Promise<HealthCheckResult> {
  return guarded("security.keys", "security", "Encryption keys", async () => {
    const ipEnc = base64KeyStatus(process.env.IP_ENCRYPTION_KEY, 32);
    const ipHash = base64KeyStatus(process.env.IP_HASH_KEY, { min: 16 });
    const gmail = base64KeyStatus(process.env.GMAIL_TOKEN_ENCRYPTION_KEY, 32);
    const production = isProductionEnvironment();
    const facts = [
      { label: "IP vault encryption key", value: ipEnc },
      { label: "IP vault search key", value: ipHash },
      { label: "Gmail token key", value: gmail },
      { label: "Card vault key", value: production ? "Not used (no card vault in production)" : envStatus("CARD_ENCRYPTION_KEY") },
    ];
    if (ipEnc === "Invalid" || ipHash === "Invalid" || gmail === "Invalid") {
      return { state: "CRITICAL", summary: "An encryption key is set but not a valid key; anything it protects cannot be read or written.", facts, action: "Regenerate it as a base64-encoded 32-byte key and update the environment." };
    }
    if (ipEnc !== "Configured" || ipHash !== "Configured") {
      return { state: "WARNING", summary: "The IP vault keys are not configured, so the encrypted cross-booking IP history is not being written.", facts, action: "Set IP_ENCRYPTION_KEY and IP_HASH_KEY (each a base64-encoded 32-byte key)." };
    }
    return { state: "HEALTHY", summary: "Encryption keys are present and well-formed.", facts };
  });
}

// ── data integrity ────────────────────────────────────────────────────────

async function checkBookingIntegrity(): Promise<HealthCheckResult> {
  return guarded("bookings.integrity", "bookings", "Bookings complete and consistent", async () => {
    const [incomplete, signedNoBooking] = await Promise.all([
      prisma.$queryRaw<Array<{ ref: string }>>`
        SELECT b."bookingReference" AS ref
        FROM "Booking" b
        JOIN "Quote" q ON q."id" = b."quoteId"
        LEFT JOIN "PaymentMethod" pm ON pm."bookingId" = b."id"
        LEFT JOIN "Signature" s ON s."bookingId" = b."id"
        GROUP BY b."id", q."id", s."id"
        HAVING COUNT(pm."id") = 0 OR q."status" IN ('SENT', 'READ', 'VIEWED') OR s."id" IS NULL
        ORDER BY b."createdAt" DESC
        LIMIT 20`,
      prisma.quote.count({ where: { status: "SIGNED", booking: { is: null }, updatedAt: { lt: new Date(Date.now() - 15 * 60_000) } } }),
    ]);
    const facts = [
      { label: "Bookings needing review", value: String(incomplete.length) + (incomplete.length === 20 ? "+" : "") },
      { label: "Signed quotes with no booking", value: String(signedNoBooking) },
    ];
    if (incomplete.length > 0) facts.push({ label: "References", value: incomplete.slice(0, 8).map((r) => r.ref).join(", ") });
    if (incomplete.length === 0 && signedNoBooking === 0) return { state: "HEALTHY", summary: "No half-finished bookings found.", facts };
    return {
      state: "WARNING",
      summary: "Some bookings look incomplete (no saved payment method, no signature, or the quote was never marked signed). Nothing is changed automatically.",
      action: "Review each reference with the customer and repair or remove it by hand. `npm run db:find-incomplete-bookings` prints the same list.",
      facts,
    };
  });
}

async function checkLeadQueue(): Promise<HealthCheckResult> {
  return guarded("leads.queue", "leads", "Lead distribution queue", async () => {
    const stalledBefore = new Date(Date.now() - 30 * 60_000);
    const [stalled, activeWorkers] = await Promise.all([
      prisma.lead.count({ where: { source: "WEBSITE", assignedAgentId: null, queueDistributedAt: null, createdAt: { lt: stalledBefore } } }),
      prisma.leadQueueEntry.count({ where: { isActive: true } }),
    ]);
    const facts = [
      { label: "Website leads waiting > 30 min", value: String(stalled) },
      { label: "Workers accepting leads", value: String(activeWorkers) },
    ];
    if (stalled > 0 && activeWorkers > 0) return { state: "WARNING", summary: "Website leads are waiting for assignment even though workers are available.", facts, action: "Open Leads → Queue to assign them, or check for a stuck distribution pass." };
    if (stalled > 0) return { state: "HEALTHY", summary: "Some website leads are waiting, but no worker has joined the queue (nothing is stuck — no one is available).", facts };
    return { state: "HEALTHY", summary: "No website leads are stuck.", facts };
  });
}

async function checkRecentIncidents(): Promise<HealthCheckResult> {
  return guarded("incidents.open", "incidents", "Recorded incidents", async () => {
    // CHECK_* incidents are just this catalogue recorded over time — counting them here
    // would report every failing check a second time. Only event-driven incidents
    // (recorded where a failure actually happened) are summarised.
    const grouped = await prisma.healthEvent.groupBy({ by: ["severity"], where: { resolvedAt: null, NOT: { type: { startsWith: "CHECK_" } } }, _count: { _all: true } });
    const count = (s: string) => grouped.find((g) => g.severity === s)?._count._all ?? 0;
    const critical = count("CRITICAL");
    const warning = count("WARNING");
    const facts = [
      { label: "Open critical", value: String(critical) },
      { label: "Open warnings", value: String(warning) },
    ];
    if (critical > 0) return { state: "CRITICAL", summary: `${critical} critical incident(s) are open (see Incidents below).`, facts, action: "Review the open incidents and resolve their cause." };
    if (warning > 0) return { state: "WARNING", summary: `${warning} warning incident(s) are open (see Incidents below).`, facts };
    return { state: "HEALTHY", summary: "No open incidents.", facts };
  });
}

/** Runs the whole catalogue. Independent checks run in parallel; each is isolated (a failure is one UNKNOWN row). */
export async function runHealthChecks(): Promise<HealthCheckResult[]> {
  // Database connectivity first: if it fails, the DB-dependent checks report UNKNOWN on their own.
  const results = await Promise.all([
    checkDatabaseConnectivity(),
    checkMigrations(),
    checkConnectionPressure(),
    checkAuthConfig(),
    checkGmail(),
    checkPaymentProvider(),
    checkSignerIp(),
    checkEncryptionKeys(),
    checkBookingIntegrity(),
    checkLeadQueue(),
    checkRecentIncidents(),
  ]);
  return results;
}
