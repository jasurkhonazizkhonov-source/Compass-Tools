import { NextRequest, NextResponse } from "next/server";
import { distributePendingWebsiteLeads } from "@/server/actions/lead-queue";

// Extension point for a real scheduler, matching /api/cron/sequences. Website
// leads are also distributed immediately on creation (see createLead in
// server/actions/leads.ts) — this endpoint exists to catch anything that
// couldn't be assigned at creation time (e.g. no active queue members yet)
// once a worker joins the queue later. Trigger manually with
// `curl http://localhost:3000/api/cron/leads`.
//
// Gated by CRON_SECRET when set, matching /api/cron/tasks and
// /api/cron/sequences — kept consistent across all three cron entry points
// even though this one doesn't send email itself.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await distributePendingWebsiteLeads();
  return NextResponse.json(result);
}
