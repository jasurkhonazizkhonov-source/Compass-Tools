import { prisma } from "@/lib/prisma";
import { checkPublicRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { unsubscribeResponse } from "@/server/unsubscribe-page";


/**
 * Pass 16 §4/§5 — one-click unsubscribe for the automated Sequence drip
 * system, mirroring /api/public/unsubscribe's exact shape (GET-only plain
 * link, opaque token, generic "not found" for an invalid/already-used
 * link so the endpoint can't be used to probe/enumerate enrollments).
 *
 * The "token" here is simply the SequenceEnrollment's own id — a cuid,
 * already effectively opaque and unguessable, so no new schema field was
 * needed (unlike Subscriber.unsubscribeToken, which predates this and
 * whose shape this deliberately does NOT duplicate).
 *
 * Scope: unsubscribing stops ALL of this LEAD's active sequence
 * enrollments (every sequence, not just the one this particular email was
 * from) — a recipient clicking "Unsubscribe" means "stop the automated
 * emails," not "stop only this one specific drip campaign," and a
 * per-sequence-only interpretation would leave a genuinely surprised
 * customer still receiving a different automated sequence right after
 * unsubscribing from this one. This never touches: the Contact's
 * marketing Subscriber status (a separate system — see
 * /api/public/unsubscribe), or a staff member's ability to send a
 * deliberate one-off Lead/Contact email (sendLeadEmail/sendCrmEmail) —
 * both are unrelated, human-triggered communication channels.
 */
export async function GET(req: Request) {
  // Pass 26 §35 — public-endpoint rate limiting, same reasoning as
  // /api/public/unsubscribe's own (shares the UNSUBSCRIBE threshold —
  // same profile: idempotent, low-consequence, opt-out only).
  const rateLimitCheck = await checkPublicRateLimit(req.headers, "SEQUENCE_UNSUBSCRIBE", RATE_LIMITS.UNSUBSCRIBE);
  if (!rateLimitCheck.allowed) {
    return unsubscribeResponse({ kind: "rate-limited" }, { "Retry-After": String(rateLimitCheck.retryAfterSeconds) });
  }

  const enrollmentId = new URL(req.url).searchParams.get("enrollment");
  if (!enrollmentId) {
    return unsubscribeResponse({ kind: "missing" });
  }

  const enrollment = await prisma.sequenceEnrollment.findUnique({
    where: { id: enrollmentId },
    select: { id: true, leadId: true },
  });
  if (!enrollment) {
    return unsubscribeResponse({ kind: "invalid" });
  }

  await prisma.sequenceEnrollment.updateMany({
    where: { leadId: enrollment.leadId, status: "ACTIVE" },
    data: { status: "UNSUBSCRIBED" },
  });

  return unsubscribeResponse({ kind: "done", variant: "sequence" });
}
