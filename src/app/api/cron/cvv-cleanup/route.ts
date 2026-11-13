import { rejectUnauthorizedCron } from "@/server/security/cron-auth";
import { NextRequest, NextResponse } from "next/server";
import { destroyExpiredCvvs } from "@/server/security/booking-cvv";

// Destroys every retained security code (CVV/CVC) whose 24-hour window has ended — and NOTHING else.
//
// Why this exists next to /api/cron/tasks (which also destroys expired codes): that endpoint also sends task-due notifications,
// runs the opt-in card-number retention purge and sweeps attachment uploads. A self-hosted deployment (Docker Compose, no Vercel
// Cron) needs a scheduled CVV cleanup without triggering that unrelated work. This one has a single job.
//
// Safe to call at any time and any number of times: it only deletes rows whose expiresAt has passed (so it can never shorten or
// extend the 24 hours), the delete is idempotent, and a second call simply reports 0. The reveal path refuses and destroys an
// expired code on its own, so a late or failed run never makes an expired code readable.
//
// Same gate as every /api/cron/* endpoint (CRON_SECRET bearer; disabled with 503 in production when the secret is unset). POST only:
// it changes data, so a link prefetch or crawler issuing GET must never be able to trigger it (GET answers 405).
//
// Observable: 200 with the count on success, 500 when the database call failed (the cause is logged server-side by
// destroyExpiredCvvs as CVV_EXPIRY_CLEANUP_FAILED with a safe error tag — never a card value or payload) so the scheduler retries.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: NextRequest) {
  const denied = rejectUnauthorizedCron(request);
  if (denied) return denied;
  const result = await destroyExpiredCvvs();
  if (result.failed) {
    return NextResponse.json({ ok: false, error: "CVV cleanup failed" }, { status: 500, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true, cvvRecordsDestroyed: result.deleted, ranAt: new Date().toISOString() }, { headers: NO_STORE });
}
