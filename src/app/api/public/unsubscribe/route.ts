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

// Part 10 — one-click unsubscribe link embedded in every marketing email
// (see buildMarketingCampaignEmail). GET, not POST, since this must work
// as a plain link click from any mail client — no JS, no form submission.
// The opaque unsubscribeToken (never the subscriber's own id/email) is the
// only thing that identifies who's unsubscribing, so the link can't be
// used to probe/enumerate subscribers.
export async function GET(req: Request) {
  // Pass 26 §35 — public-endpoint rate limiting, blunting token-
  // enumeration scanning against unsubscribeToken (see RATE_LIMITS.UNSUBSCRIBE's
  // own comment for why this ceiling is looser than the POST forms above).
  const rateLimitCheck = await checkPublicRateLimit(req.headers, "UNSUBSCRIBE", RATE_LIMITS.UNSUBSCRIBE);
  if (!rateLimitCheck.allowed) {
    return new NextResponse(htmlPage("Please try again shortly", "Too many requests from this connection. Please wait a few minutes and try again."), {
      status: 429,
      headers: { "Content-Type": "text/html", "Retry-After": String(rateLimitCheck.retryAfterSeconds) },
    });
  }

  const token = new URL(req.url).searchParams.get("token");
  if (!token) {
    return new NextResponse(htmlPage("Invalid link", "This unsubscribe link is missing its token."), { status: 400, headers: { "Content-Type": "text/html" } });
  }

  const subscriber = await prisma.subscriber.findUnique({ where: { unsubscribeToken: token } });
  if (!subscriber) {
    return new NextResponse(htmlPage("Link not found", "This unsubscribe link is no longer valid."), { status: 404, headers: { "Content-Type": "text/html" } });
  }

  if (subscriber.status !== "UNSUBSCRIBED") {
    await prisma.subscriber.update({ where: { id: subscriber.id }, data: { status: "UNSUBSCRIBED", unsubscribedAt: new Date() } });
  }

  return new NextResponse(
    htmlPage("You're unsubscribed", `${subscriber.email} will no longer receive marketing emails from us. You can re-subscribe at any time from our website.`),
    { headers: { "Content-Type": "text/html" } }
  );
}
