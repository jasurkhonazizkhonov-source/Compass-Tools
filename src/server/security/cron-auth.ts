import { createHash, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { isProductionEnvironment } from "@/lib/env";

// One gate for every /api/cron/* endpoint (tasks + card retention, sequences,
// leads). The secret is configured only in the host (Vercel → CRON_SECRET) and
// is never hard-coded; Vercel Cron sends it automatically as
// `Authorization: Bearer <CRON_SECRET>` when the variable exists.
//
//   Production-class environment:
//     - CRON_SECRET missing → the endpoint is DISABLED (503). Previously an unset
//       secret left these endpoints open to anyone, including the one that sends
//       real email and the one that runs the card-retention purge.
//     - CRON_SECRET set     → the request must carry it (401 otherwise).
//   Local development/tests: enforced when the secret is set, open when it is not
//   (so `curl` and the in-process poller keep working without setup).
//
// The comparison is constant-time (compares fixed-length digests) so response
// timing cannot be used to guess the secret.

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** Returns a response to send when the request is NOT allowed to run the cron job, or null when it is. */
export function rejectUnauthorizedCron(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    if (isProductionEnvironment()) {
      return NextResponse.json({ error: "Cron endpoint is not configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    return null;
  }
  const presented = request.headers.get("authorization") ?? "";
  if (!safeEqual(presented, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  return null;
}
