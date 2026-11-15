// Starts the in-process task-due notification poller when the Next.js
// server boots. This is the dev-environment stand-in for a real scheduler
// (Vercel Cron, a queue worker, etc.) — see api/cron/tasks/route.ts, which
// remains the entry point a real external scheduler should hit in
// production. Guarded by a globalThis flag (same pattern as
// src/lib/prisma.ts) so Next dev's fast-refresh never double-registers the
// interval, and skipped entirely on the edge runtime since it depends on
// Prisma/Node APIs.
//
// It calls the sweep (src/server/due-task-notifications.ts), which is not a Server Action. The signed-in "Process Due Tasks" button uses a separate,
// role-checked action (processDueTaskNotifications in actions/tasks.ts), because this poller has no signed-in user to check.
//
// Default: ON, exactly as before - the VPS deployment relies on it for task-due notifications (docs/DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md) and, since the
// sequence-automation work, for sending due sequence steps (the same once-a-minute tick; see below). Setting
// DISABLE_IN_PROCESS_POLLER=true turns it off for a process that must not run background work at boot: a local or review instance pointed at a
// database it should not touch, a one-off script, or a deployment that schedules /api/cron/tasks externally instead. Overlap with an external
// scheduler is safe either way: each task is claimed atomically, so it is notified once.
declare global {
  var __taskNotifierStarted: boolean | undefined;
}

const POLL_INTERVAL_MS = 60_000;
/** A background run older than this is considered stuck and no longer blocks the next tick. */
const STUCK_RUN_MS = 10 * 60_000;

export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { inProcessPollerDisabled } = await import("@/lib/poller-config");
  if (inProcessPollerDisabled()) return;
  if (globalThis.__taskNotifierStarted) return;
  globalThis.__taskNotifierStarted = true;

  const { runDueTaskNotifications } = await import("@/server/due-task-notifications");
  const { drainDueSequenceSteps } = await import("@/server/due-sequence-steps");
  const { markPollerStarted, markSweepStarted, markSweepFinished } = await import("@/server/scheduler-status");
  markPollerStarted();

  // The same once-a-minute tick drives BOTH background jobs: task-due notifications and the automatic sending of sequence steps. A job whose previous run
  // is still going is skipped (never two overlapping runs of one job in this process), and one job failing never stops the other or the interval. Across
  // processes (a second instance, an external caller of /api/cron/sequences) overlap is safe because every enrollment is claimed atomically before sending.
  // A run that never settles (a provider call that hangs) must not stop its job forever: after STUCK_RUN_MS a new run may start, and the atomic claim keeps that
  // safe. Each run is a token, so a stuck run that finally settles cannot clear the flag of the run that replaced it.
  let tasksRun: object | null = null;
  let tasksRunStartedAt = 0;
  let sequencesRun: object | null = null;
  let sequencesRunStartedAt = 0;
  setInterval(() => {
    if (!tasksRun || Date.now() - tasksRunStartedAt > STUCK_RUN_MS) {
      const mine = {};
      tasksRun = mine;
      tasksRunStartedAt = Date.now();
      markSweepStarted("tasks");
      runDueTaskNotifications()
        .then(() => markSweepFinished("tasks", { ok: true }))
        .catch((err) => {
          markSweepFinished("tasks", { ok: false });
          console.error("[task-notifier] runDueTaskNotifications failed:", err);
        })
        .finally(() => {
          if (tasksRun === mine) tasksRun = null;
        });
    }
    if (!sequencesRun || Date.now() - sequencesRunStartedAt > STUCK_RUN_MS) {
      const mine = {};
      sequencesRun = mine;
      sequencesRunStartedAt = Date.now();
      markSweepStarted("sequences");
      drainDueSequenceSteps()
        .then((r) => markSweepFinished("sequences", { ok: true, ...r }))
        .catch((err) => {
          markSweepFinished("sequences", { ok: false });
          console.error("[sequence-sender] drainDueSequenceSteps failed:", err);
        })
        .finally(() => {
          if (sequencesRun === mine) sequencesRun = null;
        });
    }
  }, POLL_INTERVAL_MS);
}

// Unhandled server errors (500s) become de-duplicated System Health incidents
// — see src/server/system/server-errors.ts for exactly what is (and is not)
// recorded. Node runtime only; awaited, as Next requires; never throws (the
// recorder swallows its own failures).
export async function onRequestError(err: unknown, _request: unknown, context: { routePath?: unknown; routeType?: unknown }) {
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { recordServerError } = await import("@/server/system/server-errors");
  await recordServerError(err, context);
}
