import { prisma } from "@/lib/prisma";
import { checkPublicRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { maskEmail, unsubscribeResponse } from "@/server/unsubscribe-page";
import { normalizeUnsubscribeReason } from "@/lib/unsubscribe-reasons";

// The public unsubscribe page for MARKETING email (see buildMarketingCampaignEmail).
// The link in every marketing email is this URL with an opaque, unguessable
// `?token=` (Subscriber.unsubscribeToken — never the subscriber's id or e-mail, so
// the link can't be used to probe/enumerate subscribers); that capability model is
// unchanged and is the ONLY thing that identifies who is unsubscribing.
//
//   GET   renders the confirmation page (with the optional reason form). It never
//         changes anything, so a mail scanner or browser pre-fetching the link
//         cannot unsubscribe — or leave a half-recorded state — on someone's behalf.
//   POST  performs the unsubscribe and renders the confirmation. Idempotent: a
//         second click/submit (or a double-submit) finds the subscription already
//         unsubscribed and says so, without touching it — in particular it never
//         overwrites an earlier reason and can never re-subscribe anyone. Only the
//         public /subscribe endpoint ever opts someone back in.
//
// The optional reason is read from the POST body (never the URL), validated
// (known category only, plain text, bounded length), and stored only when the
// customer actually gave one.

const NO_TOKEN_FIELD = "token";

/**
 * Same-origin check for the form POST. The page sets Referrer-Policy: no-referrer so the token
 * never leaves in a Referer header — and a browser then sends "Origin: null" even for a
 * same-origin form post, so Origin alone cannot be the test. The browser's own, unforgeable
 * Fetch-Metadata header is: Sec-Fetch-Site must be same-origin (or none). When a client sends
 * no Fetch-Metadata at all, fall back to Origin: absent is allowed, present must match the host.
 */
function isSameOriginPost(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.get("host") ?? new URL(req.url).host);
  } catch {
    return false;
  }
}

async function rateLimited(req: Request, endpoint: string) {
  const check = await checkPublicRateLimit(req.headers, endpoint, RATE_LIMITS.UNSUBSCRIBE);
  return check.allowed ? null : unsubscribeResponse({ kind: "rate-limited" }, { "Retry-After": String(check.retryAfterSeconds) });
}

export async function GET(req: Request) {
  // Pass 26 §35 — public-endpoint rate limiting, blunting token-enumeration scanning.
  const limited = await rateLimited(req, "UNSUBSCRIBE");
  if (limited) return limited;

  const token = new URL(req.url).searchParams.get("token");
  if (!token) return unsubscribeResponse({ kind: "missing" });

  try {
    const subscriber = await prisma.subscriber.findUnique({
      where: { unsubscribeToken: token },
      select: { email: true, status: true },
    });
    if (!subscriber) return unsubscribeResponse({ kind: "invalid" });

    if (subscriber.status === "UNSUBSCRIBED") {
      return unsubscribeResponse({ kind: "already", maskedEmail: maskEmail(subscriber.email) });
    }
    return unsubscribeResponse({
      kind: "confirm",
      action: "/api/public/unsubscribe",
      tokenField: { name: NO_TOKEN_FIELD, value: token },
      maskedEmail: maskEmail(subscriber.email),
      askReason: true,
    });
  } catch {
    return unsubscribeResponse({ kind: "error" });
  }
}

export async function POST(req: Request) {
  const limited = await rateLimited(req, "UNSUBSCRIBE");
  if (limited) return limited;

  // The form is only ever posted from this page. Refuse a request that did not come from it
  // (the token is a capability, this is defence in depth).
  if (!isSameOriginPost(req)) return unsubscribeResponse({ kind: "error" });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return unsubscribeResponse({ kind: "missing" });
  }
  const token = form.get(NO_TOKEN_FIELD);
  if (typeof token !== "string" || !token) return unsubscribeResponse({ kind: "missing" });

  const reason = normalizeUnsubscribeReason({ category: form.get("reason"), text: form.get("comment") });

  try {
    const subscriber = await prisma.subscriber.findUnique({
      where: { unsubscribeToken: token },
      select: { id: true, email: true, status: true },
    });
    if (!subscriber) return unsubscribeResponse({ kind: "invalid" });
    const masked = maskEmail(subscriber.email);

    if (subscriber.status === "UNSUBSCRIBED") {
      return unsubscribeResponse({ kind: "already", maskedEmail: masked });
    }

    if (!reason.ok) {
      const raw = form.get("comment");
      return unsubscribeResponse({
        kind: "confirm",
        action: "/api/public/unsubscribe",
        tokenField: { name: NO_TOKEN_FIELD, value: token },
        maskedEmail: masked,
        askReason: true,
        error: reason.error,
        draft: { category: typeof form.get("reason") === "string" ? (form.get("reason") as string) : null, text: typeof raw === "string" ? raw.slice(0, 5000) : null },
      });
    }

    // Conditional on still being SUBSCRIBED: of two simultaneous submits exactly one
    // performs the change (and records its reason); the other sees "already".
    const changed = await prisma.subscriber.updateMany({
      where: { id: subscriber.id, status: "SUBSCRIBED" },
      data: {
        status: "UNSUBSCRIBED",
        unsubscribedAt: new Date(),
        unsubscribeSource: "EMAIL_LINK",
        unsubscribeReasonCategory: reason.category,
        unsubscribeReason: reason.text,
      },
    });
    if (changed.count === 0) {
      return unsubscribeResponse({ kind: "already", maskedEmail: masked });
    }
    return unsubscribeResponse({ kind: "done", maskedEmail: masked, thanked: !!(reason.category || reason.text) });
  } catch {
    return unsubscribeResponse({ kind: "error" });
  }
}
