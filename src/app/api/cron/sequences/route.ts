import { rejectUnauthorizedCron } from "@/server/security/cron-auth";
import { NextRequest, NextResponse } from "next/server";
import { drainDueSequenceSteps } from "@/server/due-sequence-steps";
import { markSweepFinished, markSweepStarted } from "@/server/scheduler-status";

// The HTTP entry point for an EXTERNAL scheduler (a cron job, Vercel Cron, a GitHub Actions schedule) to trigger sequence sends. The CRM does not need
// one: its server process already runs the same sweep every minute from src/instrumentation.ts (unless DISABLE_IN_PROCESS_POLLER is set), so this route is
// a redundant second trigger and the way to run the sweep when the in-process poller is turned off. Overlap between the two is safe - every enrollment is
// claimed atomically before it is sent, so a step goes out once.
//
// If CRON_SECRET is set, requests must carry it as a bearer token —
// matching /api/cron/tasks's gate. This route actually sends real emails
// (sequence steps), so unlike lead distribution it must not stay reachable
// by anyone once a real scheduler/secret is configured; it stays open only
// when CRON_SECRET is unset (this dev environment).
export async function GET(request: NextRequest) {
  const denied = rejectUnauthorizedCron(request);
  if (denied) return denied;
  markSweepStarted("sequences");
  try {
    const result = await drainDueSequenceSteps();
    markSweepFinished("sequences", { ok: true, ...result });
    return NextResponse.json({ processed: result.processed, sent: result.sent, failed: result.failed });
  } catch (err) {
    markSweepFinished("sequences", { ok: false });
    throw err;
  }
}
