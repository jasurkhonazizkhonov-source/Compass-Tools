import { rejectUnauthorizedCron } from "@/server/security/cron-auth";
import { NextRequest, NextResponse } from "next/server";
import { syncSequenceReplies } from "@/server/sequence-reply-sync";
import { markSweepFinished, markSweepStarted } from "@/server/scheduler-status";

// The HTTP entry point for an EXTERNAL scheduler to run the reply check (automatic stop of a sequence when the customer replies). The CRM does not need one: its
// server process runs the same check every minute from src/instrumentation.ts (unless DISABLE_IN_PROCESS_POLLER is set). Overlap between callers is safe: a reply
// is recorded atomically and once. Same CRON_SECRET gate as /api/cron/sequences; the response carries counts only (never an address, subject or message id).
export async function GET(request: NextRequest) {
  const denied = rejectUnauthorizedCron(request);
  if (denied) return denied;
  markSweepStarted("replies");
  try {
    const result = await syncSequenceReplies();
    markSweepFinished("replies", { ok: true, processed: result.conversationsChecked, sent: result.enrollmentsStopped, failed: result.errors });
    return NextResponse.json({
      mailboxes: result.mailboxes,
      skippedNoPermission: result.skippedNoPermission,
      conversationsChecked: result.conversationsChecked,
      repliesFound: result.repliesFound,
      enrollmentsStopped: result.enrollmentsStopped,
      errors: result.errors,
    });
  } catch (err) {
    markSweepFinished("replies", { ok: false });
    throw err;
  }
}
