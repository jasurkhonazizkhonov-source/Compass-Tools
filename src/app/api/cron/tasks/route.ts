import { rejectUnauthorizedCron } from "@/server/security/cron-auth";
import { NextRequest, NextResponse } from "next/server";
import { processDueTaskNotifications } from "@/server/actions/tasks";
import { cleanupExpiredRateLimitCounters } from "@/server/security/rate-limit";
import { runScheduledCardRetention } from "@/server/security/card-retention-schedule";
import { destroyExpiredCvvs } from "@/server/security/booking-cvv";

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
  const denied = rejectUnauthorizedCron(request);
  if (denied) return denied;
  const result = await processDueTaskNotifications();
  // Pass 28 §30 — best-effort, never lets a cleanup failure fail the
  // actual task-notification cron run this route exists for.
  const rateLimitCleanup = await cleanupExpiredRateLimitCounters().catch(() => ({ deleted: 0 }));
  // Opt-in card retention purge (CARD_RETENTION_DAYS; disabled unless set, and only
  // ever run by an AUTHENTICATED cron in production). Never fails the cron run.
  const cardRetention = await runScheduledCardRetention().catch(() => ({ status: "failed" as const }));
  // The 24-hour limit on retained security codes (CVV/CVC): every record whose window has ended is destroyed here, every day,
  // whether or not CARD_RETENTION_DAYS is set. Idempotent; never fails the run. (Reveal also refuses and destroys an expired
  // record on its own, so the limit holds even if this run is late.)
  const cvvCleanup = await destroyExpiredCvvs().catch(() => ({ deleted: 0 }));
  return NextResponse.json({ ...result, rateLimitCountersDeleted: rateLimitCleanup.deleted, cardRetention, cvvRecordsDestroyed: cvvCleanup.deleted });
}
