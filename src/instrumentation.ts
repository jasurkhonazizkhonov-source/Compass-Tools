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

export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { inProcessPollerDisabled } = await import("@/lib/poller-config");
  if (inProcessPollerDisabled()) return;
  if (globalThis.__taskNotifierStarted) return;
  globalThis.__taskNotifierStarted = true;

  const { runDueTaskNotifications } = await import("@/server/due-task-notifications");
  const { drainDueSequenceSteps } = await import("@/server/due-sequence-steps");
  const { startBackgroundPoller } = await import("@/server/background-poller");
  const { drainMarketingCampaigns } = await import("@/server/marketing/campaign-worker");

  // One once-a-minute tick drives the background jobs: task-due notifications, the automatic sending of sequence steps and campaign delivery. The overlap, stuck-run, error
  // isolation and shutdown rules (and what they do and do not guarantee across several app instances) are documented in src/server/background-poller.ts.
  startBackgroundPoller([
    { name: "tasks", logTag: "task-notifier", run: () => runDueTaskNotifications() },
    { name: "sequences", logTag: "sequence-sender", run: () => drainDueSequenceSteps() },
    // Durable marketing-campaign delivery (rate-limited batches). It claims its work in the database, so an overlapping second instance cannot double-send a
    // recipient; see server/marketing/campaign-worker.ts.
    { name: "campaigns", logTag: "campaign-sender", run: async () => { const t = await drainMarketingCampaigns(); return { processed: t.sent + t.failed + t.unknown + t.skipped, sent: t.sent, failed: t.failed }; } },
  ]);
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
