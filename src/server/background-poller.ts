import { safeErrorTag } from "@/lib/safe-error-log";
import { markPollerStarted, markPollerStopped, markSweepFinished, markSweepStarted, type SweepJob } from "@/server/scheduler-status";

// The in-process once-a-minute poller behind automatic sequence sending and task reminders (started from src/instrumentation.ts).
//
// Concurrency model, stated precisely:
//   * Inside ONE process a job still running when the next tick fires is skipped (no overlapping runs of one job), and the two jobs are independent.
//   * Across PROCESSES (two app instances, or an external caller of /api/cron/sequences) nothing here coordinates: what keeps a step from being sent twice is
//     the row-level conditional update that claims each enrollment before it is sent (due-sequence-steps.ts). That is a database-level guarantee in PostgreSQL
//     (the second updater re-evaluates its WHERE clause after the first commits and matches nothing), but it has only been exercised here against an
//     in-memory fake - it is NOT demonstrated against PostgreSQL.
//   * A run that never settles (a provider call that hangs) stops blocking its job after STUCK_RUN_MS; the claim keeps the replacement run safe.
//   * Shutdown: SIGTERM / SIGINT stop the timer so no NEW run starts. A run already in flight is not awaited (the process is exiting); a send that was started
//     but not recorded stays IN_FLIGHT and is held as an unknown outcome by the next pickup - never resent.

export const POLL_INTERVAL_MS = 60_000;
/** A background run older than this is considered stuck and no longer blocks the next tick. */
export const STUCK_RUN_MS = 10 * 60_000;

type Job = { name: SweepJob; logTag: string; run: () => Promise<{ processed?: number; sent?: number; failed?: number } | unknown> };

let timer: ReturnType<typeof setInterval> | null = null;
let signalHandlersInstalled = false;
let stopRequested = false;

/**
 * True once the poller has been told to stop (SIGTERM / SIGINT / stopBackgroundPoller). A background run already in flight checks this BETWEEN units of work
 * (between enrollments, between batches) and stops picking up new ones, so a shutdown does not leave a long sweep sending steps for minutes after the process
 * was asked to exit. A unit already underway is left to finish or, if the process dies, is recovered by the write-ahead marker (never re-sent).
 */
export function pollerStopRequested(): boolean {
  return stopRequested;
}

export function backgroundPollerRunning(): boolean {
  return timer !== null;
}

/** Starts the interval. Idempotent: a second call while running does nothing. */
export function startBackgroundPoller(jobs: Job[], intervalMs = POLL_INTERVAL_MS): void {
  if (timer) return;
  stopRequested = false;
  markPollerStarted();
  const state = new Map<string, { run: object | null; startedAt: number }>(jobs.map((j) => [j.name, { run: null, startedAt: 0 }]));
  timer = setInterval(() => {
    for (const job of jobs) {
      const s = state.get(job.name)!;
      if (s.run && Date.now() - s.startedAt <= STUCK_RUN_MS) continue; // still running: skip, never overlap
      const mine = {};
      s.run = mine;
      s.startedAt = Date.now();
      markSweepStarted(job.name);
      job
        .run()
        .then((r) => {
          const counts = (r && typeof r === "object" ? r : {}) as { processed?: number; sent?: number; failed?: number };
          markSweepFinished(job.name, { ok: true, processed: counts.processed, sent: counts.sent, failed: counts.failed });
        })
        .catch((err) => {
          // Category only: an error object can carry a database URL, a recipient or message text.
          markSweepFinished(job.name, { ok: false, errorTag: safeErrorTag(err) });
          // The category only, never the error object: it can carry a connection string, a recipient address or message text.
          console.error(`[${job.logTag}] failed (${safeErrorTag(err)})`);
        })
        .finally(() => {
          if (s.run === mine) s.run = null;
        });
    }
  }, intervalMs);
  // Never keep the process alive just for this timer.
  if (typeof timer === "object" && timer && "unref" in timer) (timer as { unref: () => void }).unref();

  if (!signalHandlersInstalled && typeof process !== "undefined" && typeof process.once === "function") {
    signalHandlersInstalled = true;
    for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => stopBackgroundPoller());
  }
}

/** Stops scheduling new runs (does not wait for, or cancel, a run already in flight). */
export function stopBackgroundPoller(): void {
  stopRequested = true;
  if (timer) clearInterval(timer);
  timer = null;
  markPollerStopped();
}
