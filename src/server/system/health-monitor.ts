// Turns the on-demand check results into durable, de-duplicated incidents and
// (for genuinely critical ones) Admin notifications. Two entry points:
//   - evaluateHealth(): run by the Admin System Health page every load.
//   - evaluateHealthThrottled(): called from the Admin notification poll, so a
//     new critical condition is noticed without anyone opening the page.
// Both are safe to call concurrently from many instances: the incident write
// is one atomic upsert per fingerprint (see health-events.ts).
import { runHealthChecks, type HealthCheckResult } from "@/server/system/health-checks";
import { recordHealthEvent, resolveHealthEvents, resolveStaleHealthEvents, pruneHealthEvents } from "@/server/system/health-events";
import { safeErrorTag } from "@/lib/safe-error-log";

const THROTTLE_MS = 5 * 60_000;
const PRUNE_EVERY_MS = 6 * 60 * 60_000;
let lastEvaluatedAt = 0;
let lastPrunedAt = 0;

/** Checks that summarise the incident table itself must not turn into incidents about themselves. */
const NOT_RECORDED = new Set(["incidents.open"]);

export function checkEventType(id: string): string {
  return `CHECK_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

export async function recordCheckResults(results: readonly HealthCheckResult[]): Promise<void> {
  for (const r of results) {
    if (NOT_RECORDED.has(r.id)) continue;
    const type = checkEventType(r.id);
    if (r.state === "CRITICAL" || r.state === "WARNING") {
      await recordHealthEvent({
        type,
        category: r.category,
        severity: r.state === "CRITICAL" ? "CRITICAL" : "WARNING",
        message: `${r.title}: ${r.summary}`,
      });
    } else if (r.state === "HEALTHY") {
      await resolveHealthEvents(type, r.category);
    }
    // UNKNOWN records nothing: "could not verify" is not an incident, and it
    // also must not resolve one.
  }
}

export async function evaluateHealth(now: number = Date.now()): Promise<HealthCheckResult[]> {
  const results = await runHealthChecks();
  await recordCheckResults(results);
  await resolveStaleHealthEvents(now);
  if (now - lastPrunedAt > PRUNE_EVERY_MS) {
    lastPrunedAt = now;
    await pruneHealthEvents(now);
  }
  lastEvaluatedAt = now;
  return results;
}

/** Best-effort, per-instance throttled. Never throws. */
export async function evaluateHealthThrottled(now: number = Date.now()): Promise<void> {
  if (now - lastEvaluatedAt < THROTTLE_MS) return;
  lastEvaluatedAt = now;
  try {
    await evaluateHealth(now);
  } catch (err) {
    console.error(`[health] EVALUATE_FAILED (${safeErrorTag(err)})`);
  }
}

export function resetHealthMonitorThrottleForTests() {
  lastEvaluatedAt = 0;
  lastPrunedAt = 0;
}
