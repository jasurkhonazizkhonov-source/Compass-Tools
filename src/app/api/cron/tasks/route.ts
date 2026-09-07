import { NextRequest, NextResponse } from "next/server";
import { processDueTaskNotifications } from "@/server/actions/tasks";
import { cleanupExpiredRateLimitCounters } from "@/server/security/rate-limit";

// Entry point for a real scheduler (Vercel Cron, GitHub Actions schedule,
// an external queue worker, etc.) to trigger task-due notifications. In
// this dev environment the actual trigger is src/instrumentation.ts's
// in-process poller (started when the server boots) plus the "Process Due
// Tasks" button on the Tasks page — this route is what a production
// scheduler should call instead once one is configured (see vercel.json).
//
// If CRON_SECRET is set, requests must carry it as a bearer token —
// otherwise (e.g. this dev environment, where no scheduler exists yet)
// the route stays open so `curl`/the instrumentation poller can reach it
// without extra configuration.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await processDueTaskNotifications();
  // Pass 28 §30 — best-effort, never lets a cleanup failure fail the
  // actual task-notification cron run this route exists for.
  const rateLimitCleanup = await cleanupExpiredRateLimitCounters().catch(() => ({ deleted: 0 }));
  return NextResponse.json({ ...result, rateLimitCountersDeleted: rateLimitCleanup.deleted });
}
