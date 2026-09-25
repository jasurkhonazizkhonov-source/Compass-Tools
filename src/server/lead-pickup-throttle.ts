// Stranded website leads (created while every eligible agent was momentarily
// busy, or while nobody was accepting) used to be picked up only when an
// agent re-joined the queue or an external cron hit /api/cron/leads — and no
// cron is scheduled for it on this deployment. Every agent's offer poll now
// also nudges distribution of pending leads, but at most once per interval
// per server instance so N agents polling every few seconds do not each run
// the scan.
export const PENDING_PICKUP_MIN_INTERVAL_MS = 20_000;

let lastRunAt = 0;

/** True at most once per interval; records the run when it returns true. */
export function shouldRunPendingPickup(now: number = Date.now()): boolean {
  if (now - lastRunAt < PENDING_PICKUP_MIN_INTERVAL_MS) return false;
  lastRunAt = now;
  return true;
}

/** Test seam. */
export function resetPendingPickupThrottleForTests() {
  lastRunAt = 0;
}
