import { NextRequest, NextResponse } from "next/server";
import { processDueSequenceSteps } from "@/server/actions/sequences";

// Extension point for a real scheduler (Vercel Cron, GitHub Actions
// schedule, an external queue worker, etc.) to trigger sequence sends.
// No such scheduler is deployed in this dev environment — trigger manually
// with `curl http://localhost:3000/api/cron/sequences`, or use the
// "Process Due Steps" button in the Sequences UI.
//
// If CRON_SECRET is set, requests must carry it as a bearer token —
// matching /api/cron/tasks's gate. This route actually sends real emails
// (sequence steps), so unlike lead distribution it must not stay reachable
// by anyone once a real scheduler/secret is configured; it stays open only
// when CRON_SECRET is unset (this dev environment).
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await processDueSequenceSteps();
  return NextResponse.json(result);
}
