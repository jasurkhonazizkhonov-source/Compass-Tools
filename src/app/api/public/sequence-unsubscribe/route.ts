import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkPublicRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";

function htmlPage(title: string, message: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f4f5f7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:36px;max-width:420px;text-align:center;}
h1{font-size:18px;margin:0 0 8px;}p{color:#6b7280;font-size:14px;margin:0;}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

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
    return new NextResponse(htmlPage("Please try again shortly", "Too many requests from this connection. Please wait a few minutes and try again."), {
      status: 429,
      headers: { "Content-Type": "text/html", "Retry-After": String(rateLimitCheck.retryAfterSeconds) },
    });
  }

  const enrollmentId = new URL(req.url).searchParams.get("enrollment");
  if (!enrollmentId) {
    return new NextResponse(htmlPage("Invalid link", "This unsubscribe link is missing its identifier."), { status: 400, headers: { "Content-Type": "text/html" } });
  }

  const enrollment = await prisma.sequenceEnrollment.findUnique({
    where: { id: enrollmentId },
    select: { id: true, leadId: true },
  });
  if (!enrollment) {
    return new NextResponse(htmlPage("Link not found", "This unsubscribe link is no longer valid."), { status: 404, headers: { "Content-Type": "text/html" } });
  }

  await prisma.sequenceEnrollment.updateMany({
    where: { leadId: enrollment.leadId, status: "ACTIVE" },
    data: { status: "UNSUBSCRIBED" },
  });

  return new NextResponse(
    htmlPage("You're unsubscribed", "You will no longer receive these automated emails. If you'd still like to hear from your travel agent directly, feel free to reply to any of their previous emails."),
    { headers: { "Content-Type": "text/html" } }
  );
}
