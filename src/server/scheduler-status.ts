// What the in-process background poller (src/instrumentation.ts) has done in THIS server process, kept so an operator can see whether automatic sequence
// sending is actually alive (src/lib/health-check.ts reports a category from it to an authorised caller). Nothing here is a setting and nothing is
// persisted: a restart starts again from "not started" until the poller's first tick, and a second app instance has its own record. It never holds a
// recipient, a subject or an error message - only counts, times and a pass/fail flag.

export type SweepJob = "sequences" | "tasks" | "campaigns" | "replies";
type JobRecord = {
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  /** Time of the last sweep that finished WITHOUT an error (null until one has). */
  lastSuccessAt: number | null;
  lastOk: boolean | null;
  /** Short category of the last failure (safeErrorTag): never a message, recipient, URL or stack. */
  lastErrorTag: string | null;
  lastProcessed: number;
  lastSent: number;
  lastFailed: number;
  consecutiveFailures: number;
};
type State = { pollerStartedAt: number | null; jobs: Record<SweepJob, JobRecord> };

declare global {
  var __schedulerStatus: State | undefined;
}

const emptyJob = (): JobRecord => ({ lastStartedAt: null, lastFinishedAt: null, lastSuccessAt: null, lastOk: null, lastErrorTag: null, lastProcessed: 0, lastSent: 0, lastFailed: 0, consecutiveFailures: 0 });
function state(): State {
  return (globalThis.__schedulerStatus ??= { pollerStartedAt: null, jobs: { sequences: emptyJob(), tasks: emptyJob(), campaigns: emptyJob(), replies: emptyJob() } });
}

export function markPollerStarted(now = Date.now()) {
  state().pollerStartedAt = now;
}
export function markSweepStarted(job: SweepJob, now = Date.now()) {
  state().jobs[job].lastStartedAt = now;
}
export function markPollerStopped() {
  state().pollerStartedAt = null;
}
export function markSweepFinished(job: SweepJob, outcome: { ok: boolean; processed?: number; sent?: number; failed?: number; errorTag?: string }, now = Date.now()) {
  const j = state().jobs[job];
  j.lastFinishedAt = now;
  j.lastOk = outcome.ok;
  if (outcome.ok) {
    j.lastSuccessAt = now;
    j.lastErrorTag = null;
  } else {
    j.lastErrorTag = (outcome.errorTag ?? "unknown").slice(0, 60);
  }
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

export type SequenceSchedulerReport = {
  state: SequenceSchedulerState;
  /** DISABLE_IN_PROCESS_POLLER is not set: this server process is meant to send sequence steps itself. */
  enabled: boolean;
  lastSuccessAt: Date | null;
  lastErrorTag: string | null;
  consecutiveFailures: number;
  /** Counts of the last sweep (what it looked at / sent / failed). */
  lastSweep: { processed: number; sent: number; failed: number } | null;
  /** Whether automatic sequence sending is, as far as this process can establish, operating right now. */
  operational: boolean;
};

/**
 * Everything the System Health page shows about automatic sequence sending, read from the SAME state the detailed /api/health uses (never a second guess).
 * It describes THIS server process; "operational" is true only for state "running" - an alive process alone never counts.
 */
export function sequenceSchedulerReport(pollerDisabled: boolean, now = Date.now()): SequenceSchedulerReport {
  const job = state().jobs.sequences;
  const s = sequenceSchedulerState(pollerDisabled, now);
  return {
    state: s,
    enabled: !pollerDisabled,
    lastSuccessAt: job.lastSuccessAt === null ? null : new Date(job.lastSuccessAt),
    lastErrorTag: job.lastOk === false ? job.lastErrorTag : null,
    consecutiveFailures: job.consecutiveFailures,
    lastSweep: job.lastFinishedAt === null ? null : { processed: job.lastProcessed, sent: job.lastSent, failed: job.lastFailed },
    operational: s === "running",
  };
}

/**
 * The same four states for the OTHER background job ("campaigns"). Unlike the sequence sweep it has no external-scheduler route, so with the
 * in-process poller disabled it simply waits ("disabled"); otherwise: not started -> "not_started"; last run failed -> "stalled"; silent for more than three minutes -> "stalled".
 */
export function backgroundJobState(job: SweepJob, pollerDisabled: boolean, now = Date.now()): SequenceSchedulerState {
  const s = state();
  if (pollerDisabled) return "disabled";
  if (s.pollerStartedAt === null) return "not_started";
  const j = s.jobs[job];
  if (j.lastOk === false) return "stalled";
  const reference = j.lastFinishedAt ?? s.pollerStartedAt;
  return now - reference > SCHEDULER_STALL_AFTER_MS ? "stalled" : "running";
}

export type BackgroundJobReport = { job: SweepJob; state: SequenceSchedulerState; lastSuccessAt: Date | null; lastErrorTag: string | null; consecutiveFailures: number; lastSweep: { processed: number; sent: number; failed: number } | null };

export function backgroundJobReport(job: SweepJob, pollerDisabled: boolean, now = Date.now()): BackgroundJobReport {
  const j = state().jobs[job];
  return {
    job,
    state: backgroundJobState(job, pollerDisabled, now),
    lastSuccessAt: j.lastSuccessAt === null ? null : new Date(j.lastSuccessAt),
    lastErrorTag: j.lastOk === false ? j.lastErrorTag : null,
    consecutiveFailures: j.consecutiveFailures,
    lastSweep: j.lastFinishedAt === null ? null : { processed: j.lastProcessed, sent: j.lastSent, failed: j.lastFailed },
  };
}
