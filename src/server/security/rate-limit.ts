import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/request-ip";

export type RateLimitConfig = { windowMs: number; maxAttempts: number };

// Pass 28 §33 — retryAfterSeconds is only ever present on a rejection, and
// is exact (not approximate) because fixed-window limiting makes the next
// reset time trivially knowable: the current window's own boundary, which
// checkPublicRateLimit already computes as `expiresAt`. A route handler
// can set this directly as the HTTP `Retry-After` header so a legitimate
// client knows exactly when it's safe to try again, instead of guessing.
export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Pass 25 §28 / Pass 28 §30 — DB-backed, serverless-safe rate limiting for
 * PUBLIC (unauthenticated) mutation endpoints, keyed by client IP. This app
 * deploys to Vercel (see vercel.json) — genuinely serverless, so an
 * in-memory counter would be actively wrong (no shared state across
 * instances).
 *
 * Fails OPEN — never blocks — when no trustworthy client IP is available
 * (see src/lib/request-ip.ts: `getClientIp` returns `undefined` whenever
 * `TRUSTED_PROXY` is unset, which is the correct, secure default for an
 * environment with no real reverse proxy in front of it, e.g. local
 * `next dev`). An unkeyable request must NEVER fall back to one shared
 * "unknown" bucket — that would let a single burst of untrusted-header
 * traffic lock out every legitimate customer sharing that bucket, the
 * exact "no accidental global lockout" failure this function exists to
 * avoid. The practical consequence, stated plainly: this provides zero
 * protection until a real deployment sets `TRUSTED_PROXY` correctly —
 * the same honest limitation `request-ip.ts` itself already documents,
 * not a new gap this file introduces.
 *
 * Pass 28 §30 — this used to count AuditLog rows in a sliding window, then
 * write a new one — a genuine check-then-act race: under a truly
 * simultaneous burst from the same IP, several concurrent requests could
 * each pass the count check before any of their own claim rows committed,
 * letting slightly more than `maxAttempts` through right at the threshold.
 * Rewritten to a single atomic statement against the new
 * `RateLimitCounter` table (see its own schema.prisma doc comment): a
 * fixed-window key (`ip|endpoint|windowBucket`) upserted via
 * `INSERT ... ON CONFLICT (key) DO UPDATE SET count = count + 1 RETURNING
 * count` — Postgres takes a real row lock on the conflicting key, so N
 * concurrent increments to the SAME key serialize correctly; there is no
 * window where two callers can both believe they're the Nth attempt. The
 * cost of true atomicity via a single upsert is fixed-window instead of
 * continuously-sliding: a full new quota becomes available right at each
 * window boundary. That is a well-understood, openly-documented property
 * of fixed-window limiting, not a bug — and, for this app's actual threat
 * model (blunting a scripted flood, not a precise per-second SLA), a
 * strictly-enforced fixed window is a stronger guarantee than the
 * previous approach's un-enforced sliding one ever was.
 */
export async function checkPublicRateLimit(headers: Headers, endpoint: string, config: RateLimitConfig): Promise<RateLimitResult> {
  const ip = getClientIp(headers);
  if (!ip) return { allowed: true };

  const windowBucket = Math.floor(Date.now() / config.windowMs);
  const key = `${ip}|${endpoint}|${windowBucket}`;
  const expiresAt = new Date((windowBucket + 1) * config.windowMs);
  const id = crypto.randomUUID();

  // A single atomic statement — the whole point of this rewrite. No
  // separate read-then-write round trip for the actual claim/count itself
  // (the increment IS the read: RETURNING hands back the authoritative
  // post-increment count in the same statement that produced it).
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimitCounter" ("id", "key", "count", "expiresAt", "createdAt", "updatedAt")
    VALUES (${id}, ${key}, 1, ${expiresAt}, now(), now())
    ON CONFLICT ("key") DO UPDATE SET "count" = "RateLimitCounter"."count" + 1, "updatedAt" = now()
    RETURNING "count"
  `;
  const count = rows[0]?.count ?? 1;
  if (count > config.maxAttempts) {
    const retryAfterSeconds = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
    return { allowed: false, retryAfterSeconds };
  }
  return { allowed: true };
}

/**
 * Pass 28 §30 — best-effort cleanup for the fixed-window counter table
 * above. Every window that's ever been hit leaves exactly one row behind
 * forever unless something prunes it — cheap individually, but unbounded
 * over time. Piggybacks on the one cron route this app's own vercel.json
 * actually schedules (`/api/cron/tasks`) rather than registering a new,
 * separately-scheduled route purely for this — see that route's own call
 * site. Never awaited as a blocking precondition of a real rate-limit
 * check; correctness of the limiter itself never depends on this having
 * run recently, only its storage footprint does.
 */
export async function cleanupExpiredRateLimitCounters(): Promise<{ deleted: number }> {
  const result = await prisma.rateLimitCounter.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return { deleted: result.count };
}

/**
 * Convenience wrapper for the common case: read the current request's
 * headers and check the rate limit in one call. `headers()` itself can
 * throw when called outside a real request context (e.g. a test harness
 * invoking a server action directly, or an unusual runtime) — the same
 * situation `ip-vault.ts`'s `auditIpVaultAccess` already defends against;
 * treated identically here as "no trustworthy IP available," which
 * `checkPublicRateLimit` already fails open for.
 */
export async function checkPublicRateLimitFromRequest(endpoint: string, config: RateLimitConfig): Promise<RateLimitResult> {
  let requestHeaders: Headers;
  try {
    requestHeaders = await headers();
  } catch {
    return { allowed: true };
  }
  return checkPublicRateLimit(requestHeaders, endpoint, config);
}

/** Pass 25 §28 — per-endpoint windows/limits, classified by legitimate-use
 * frequency (not a single blanket threshold for every endpoint). Kept in
 * one place so the actual numbers are easy to find/adjust, rather than
 * scattered as magic numbers at each call site. */
export const RATE_LIMITS = {
  /** A customer only ever needs to submit a booking once per quote
   * (Booking.quoteId @unique enforces that already) — generous enough
   * for retries/a shared office IP submitting several different
   * customers' bookings, tight enough to block a scripted flood. */
  BOOKING_SUBMIT: { windowMs: 15 * 60 * 1000, maxAttempts: 10 } satisfies RateLimitConfig,
  /** Same reasoning as booking submission — a genuinely low-frequency,
   * high-consequence action. */
  CANCELLATION_SUBMIT: { windowMs: 15 * 60 * 1000, maxAttempts: 10 } satisfies RateLimitConfig,
  /** Pass 26 §35 — the public website's flight-request form. Looser than
   * booking/cancellation (lower consequence per submission — creates a
   * Lead, not a charge — and a shared office/kiosk IP may legitimately
   * submit several different travelers' requests), still tight enough to
   * block a scripted flood of fake leads. */
  LEAD_CAPTURE: { windowMs: 15 * 60 * 1000, maxAttempts: 20 } satisfies RateLimitConfig,
  /** Pass 26 §35 — the public "Get in Touch" form. Same low-frequency
   * profile as lead capture. */
  CONTACT_INQUIRY: { windowMs: 15 * 60 * 1000, maxAttempts: 20 } satisfies RateLimitConfig,
  /** Pass 26 §35 — the public newsletter signup form. Idempotent
   * (upsert), so a slightly higher ceiling than the others doesn't risk
   * duplicate side effects — still bounded against a scripted flood
   * hammering notifyNewSubscriber. */
  SUBSCRIBE: { windowMs: 15 * 60 * 1000, maxAttempts: 30 } satisfies RateLimitConfig,
  /** Pass 26 §35 — one-click unsubscribe links (both the marketing-
   * Subscriber and the automated-Sequence variants). A genuine recipient
   * clicks once; the higher ceiling here is deliberate — an email client's
   * own link-prescanning/security-scanning can open a link more than once
   * on a real user's behalf, and this action is idempotent and low-
   * consequence (opts someone OUT, never in) — so this limit exists to
   * blunt token-enumeration scanning, not to gate ordinary use. */
  UNSUBSCRIBE: { windowMs: 15 * 60 * 1000, maxAttempts: 30 } satisfies RateLimitConfig,
} as const;
