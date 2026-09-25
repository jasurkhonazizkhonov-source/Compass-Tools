// Starts the in-process task-due notification poller when the Next.js
// server boots. This is the dev-environment stand-in for a real scheduler
// (Vercel Cron, a queue worker, etc.) — see api/cron/tasks/route.ts, which
// remains the entry point a real external scheduler should hit in
// production. Guarded by a globalThis flag (same pattern as
// src/lib/prisma.ts) so Next dev's fast-refresh never double-registers the
// interval, and skipped entirely on the edge runtime since it depends on
// Prisma/Node APIs.
declare global {
  var __taskNotifierStarted: boolean | undefined;
}

const POLL_INTERVAL_MS = 60_000;

export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return;
  if (globalThis.__taskNotifierStarted) return;
  globalThis.__taskNotifierStarted = true;

  const { processDueTaskNotifications } = await import("@/server/actions/tasks");

  setInterval(() => {
    processDueTaskNotifications().catch((err) => {
      console.error("[task-notifier] processDueTaskNotifications failed:", err);
    });
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
