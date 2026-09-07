// ═══════════════════════════════════════════════════════════════════════
// Transient CVV cache — the ONLY place a CVV value ever exists anywhere in
// this application after the customer submits their booking.
//
// This is a plain in-process JavaScript Map. It is explicitly NOT:
//   - a database column (no CVV field exists anywhere in prisma/schema.prisma)
//   - Redis, or any other external/persistent cache
//   - written to disk, a backup, or a snapshot in any form
// It IS:
//   - wiped completely on every process restart/redeploy (nothing to
//     recover — there's no on-disk state to inspect)
//   - bounded by a short, fixed TTL measured from the moment the customer
//     submitted the booking (CVV_TTL_MS below) — not renewed, not extended,
//     not sliding
//   - explicitly destroyed on authorization success, authorization failure,
//     agent cancellation, the owning account's next-observed session
//     expiry/sign-out (see destroyCvvAuthorizationsForAccount, called from
//     src/lib/dev-session.ts's getCurrentAccount and from
//     src/server/actions/dev-session.ts's signOut)
//
// Why an in-memory Map is the right shape for a DEV implementation, and NOT
// sufficient for production: this only works because `next dev`/`next
// start` here runs as one long-lived Node process. A real multi-instance /
// serverless production deployment would need a real short-TTL ephemeral
// secrets store (e.g. a KMS/HSM transit-style single-use lease, or an
// encrypted Redis entry with a hard TTL and a strict access-count limit)
// so authorization state is consistent across instances — see the "Remaining
// production requirements" section of this project's most recent
// implementation report for the full list. Do not "fix" this by moving CVV
// into Postgres or a long-lived Redis cache — that would violate the
// non-negotiable requirement this module exists to satisfy.
// ═══════════════════════════════════════════════════════════════════════

type CvvEntry = {
  cvv: string;
  expiresAt: number;
  /** Set once an authorized agent has started a supplier-payment
   * authorization for this card — lets sign-out/session-expiry destroy only
   * the CVV state that specific agent is actively using, without disturbing
   * a different agent's separate, legitimate in-progress authorization on
   * the same payment method. */
  authorizedByAccountId?: string;
};

/**
 * From booking submission to first (or next) authorized use. Set to 24
 * hours — a deliberate business decision to give agents a full business
 * day to pick up a freshly submitted booking and call the supplier, while
 * still being a bounded, single-authorization-scoped window, not a de
 * facto permanent store. This is NOT the same thing as multi-day/month
 * CVV retention: the value is destroyed the moment it's used for its one
 * authorization (success or failure), on agent cancellation, on the
 * claiming account's sign-out/session-expiry, or once this TTL elapses —
 * whichever happens first. At 24 hours, the in-memory-only nature of this
 * cache (see the file header above) matters more in practice than it did
 * at 30 minutes: a dev-server restart or redeploy within the window loses
 * the cached value early. That's expected here and is exactly why a real
 * production deployment needs the KMS/HSM-backed ephemeral store described
 * above, not a longer-lived version of this Map.
 */
export const CVV_TTL_MS = 24 * 60 * 60 * 1000;

const store = new Map<string, CvvEntry>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
}

/** Called once, immediately after a booking's PaymentMethod rows are
 * created — never called again for that payment method afterward. */
export function cacheCvv(paymentMethodId: string, cvv: string): void {
  purgeExpired();
  store.set(paymentMethodId, { cvv, expiresAt: Date.now() + CVV_TTL_MS });
}

/** Returns the still-valid cached CVV, or undefined if it was never cached,
 * already destroyed, or has expired. Marks the entry as claimed by the
 * given account so a later sign-out/session-expiry for that account can
 * find and destroy it. Does not extend the TTL. */
export function claimCvvForAuthorization(paymentMethodId: string, accountId: string): string | undefined {
  purgeExpired();
  const entry = store.get(paymentMethodId);
  if (!entry) return undefined;
  entry.authorizedByAccountId = accountId;
  return entry.cvv;
}

/** Read-only check used by the "not retained" UI state — never re-reveals
 * the value itself. */
export function hasCachedCvv(paymentMethodId: string): boolean {
  purgeExpired();
  return store.has(paymentMethodId);
}

/** Explicit destruction — call on authorization success, authorization
 * failure, and agent-initiated cancellation. Idempotent. */
export function destroyCvv(paymentMethodId: string): void {
  store.delete(paymentMethodId);
}

/** Destroys every CVV entry currently claimed by the given account —
 * called on sign-out and on lazily-detected session expiry, so an agent's
 * privileged CVV access never outlives their own session. Entries never
 * claimed by this account (a different agent's active authorization, or a
 * freshly submitted booking nobody has looked at yet) are left untouched. */
export function destroyCvvAuthorizationsForAccount(accountId: string): void {
  for (const [key, entry] of store) {
    if (entry.authorizedByAccountId === accountId) store.delete(key);
  }
}

/** Test-only reset so test files don't leak cache state into each other. */
export function __resetCvvCacheForTests(): void {
  store.clear();
}
