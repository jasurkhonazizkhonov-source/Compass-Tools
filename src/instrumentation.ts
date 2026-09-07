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
