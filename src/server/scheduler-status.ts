// What the in-process background poller (src/instrumentation.ts) has done in THIS server process, kept so an operator can see whether automatic sequence
// sending is actually alive (src/lib/health-check.ts reports a category from it to an authorised caller). Nothing here is a setting and nothing is
// persisted: a restart starts again from "not started" until the poller's first tick, and a second app instance has its own record. It never holds a
// recipient, a subject or an error message - only counts, times and a pass/fail flag.

export type SweepJob = "sequences" | "tasks";
type JobRecord = { lastStartedAt: number | null; lastFinishedAt: number | null; lastOk: boolean | null; lastProcessed: number; lastSent: number; lastFailed: number; consecutiveFailures: number };
type State = { pollerStartedAt: number | null; jobs: Record<SweepJob, JobRecord> };

declare global {
  var __schedulerStatus: State | undefined;
}

const emptyJob = (): JobRecord => ({ lastStartedAt: null, lastFinishedAt: null, lastOk: null, lastProcessed: 0, lastSent: 0, lastFailed: 0, consecutiveFailures: 0 });
function state(): State {
  return (globalThis.__schedulerStatus ??= { pollerStartedAt: null, jobs: { sequences: emptyJob(), tasks: emptyJob() } });
}

export function markPollerStarted(now = Date.now()) {
  state().pollerStartedAt = now;
}
export function markSweepStarted(job: SweepJob, now = Date.now()) {
  state().jobs[job].lastStartedAt = now;
}
export function markSweepFinished(job: SweepJob, outcome: { ok: boolean; processed?: number; sent?: number; failed?: number }, now = Date.now()) {
  const j = state().jobs[job];
  j.lastFinishedAt = now;
  j.lastOk = outcome.ok;
  j.lastProcessed = outcome.processed ?? 0;
  j.lastSent = outcome.sent ?? 0;
  j.lastFailed = outcome.failed ?? 0;
  j.consecutiveFailures = outcome.ok ? 0 : j.consecutiveFailures + 1;
}
export function getSchedulerStatus(): Readonly<State> {
  return state();
}
export function resetSchedulerStatusForTests() {
  globalThis.__schedulerStatus = undefined;
}

/** The poller ticks once a minute; three silent minutes is a stall. */
export const SCHEDULER_STALL_AFTER_MS = 3 * 60_000;

/**
 * "disabled" - DISABLE_IN_PROCESS_POLLER is on and nothing has called /api/cron/sequences in this process within the last three minutes, so no automatic
 *   sending is visible from here (an external scheduler that calls the route about once a minute shows as "running" instead);
 * "not_started" - the poller has not started in this process (yet);
 * "running" - it started and the sequence sweep finished within the last three minutes (or has not been due yet);
 * "stalled" - it started but the sweep has been silent for more than three minutes, or failed on its last run.
 */
export type SequenceSchedulerState = "disabled" | "not_started" | "running" | "stalled";
export function sequenceSchedulerState(pollerDisabled: boolean, now = Date.now()): SequenceSchedulerState {
  const s = state();
  if (pollerDisabled) {
    const last = s.jobs.sequences.lastFinishedAt;
    return last !== null && s.jobs.sequences.lastOk !== false && now - last <= SCHEDULER_STALL_AFTER_MS ? "running" : "disabled";
  }
  if (s.pollerStartedAt === null) return "not_started";
  const job = s.jobs.sequences;
  if (job.lastOk === false) return "stalled";
  const reference = job.lastFinishedAt ?? s.pollerStartedAt;
  return now - reference > SCHEDULER_STALL_AFTER_MS ? "stalled" : "running";
}
