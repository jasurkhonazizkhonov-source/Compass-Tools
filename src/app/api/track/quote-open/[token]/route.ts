import { NextResponse } from "next/server";
import { trackQuoteView } from "@/server/actions/booking";
import { checkPublicRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";

// Nodemailer/Gmail SMTP has no delivery/open webhook support (that's a
// Resend/SES/SendGrid feature this app doesn't use) — a tracking pixel is
// the only mechanism available for READ detection. Like all pixel-based
// tracking, this is inherently unreliable: many clients (Apple Mail
// Privacy Protection, image-blocking clients, corporate proxies) never
// request it, so a quote can validly stay at SENT indefinitely. That's a
// property of the technique, not a bug — trackQuoteView is a one-way,
// idempotent SENT→READ transition regardless of how many times this route
// is hit.
const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7",
  "base64",
);

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // A flood of pixel requests would cost one database lookup each. Over the (generous) per-IP ceiling the image is still answered - an email must never show a broken picture - but
  // nothing is looked up or recorded. A failure of the limiter itself never blocks the pixel either (it fails open, as for every public endpoint).
  const limited = await checkPublicRateLimit(req.headers, "QUOTE_OPEN_TRACKING", RATE_LIMITS.QUOTE_OPEN_TRACKING).catch(() => ({ allowed: true as const }));
  if (limited.allowed) await trackQuoteView(token).catch(() => undefined);

  return new NextResponse(TRANSPARENT_GIF, {
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(TRANSPARENT_GIF.length),
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
    },
  });
}
