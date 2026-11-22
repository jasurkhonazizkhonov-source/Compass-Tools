// The single decision point every Business Flights website route uses for the v2 request signature (website-request-signature.ts): the three website
// routes (flight inquiry, contact inquiry, newsletter subscribe) call it after the body has been read and before anything is stored.
//
//   * LEAD_INGEST_SECRET configured AND WEBSITE_SIGNATURE_REQUIRED=true -> a valid, single-use v2 signature is REQUIRED. A missing, malformed, v1, expired,
//     modified or replayed one is refused with 401 and a fixed log tag. There is no unsigned fallback and no v1 fallback on these routes.
//   * configured, switch not set (transitional: the CRM is deployed BEFORE the website) -> a valid v2 signature is verified and used exactly as above, but a
//     request without one is handled as it was before this release (the unchanged v1 reader may still read a v1 context; nothing else is trusted).
//   * not configured                                -> nothing can be verified; the routes behave as they always did (nothing is recorded about the
//     visitor, and a context that is present is ignored).
//   * verified                                      -> the visitor IP the website signed is the trustworthy client key for per-visitor rate limiting
//     (the connection itself is the website's server, which the per-IP limiter in the route cannot use).
import { NextResponse } from "next/server";
import { checkPublicRateLimitForKey, type RateLimitConfig } from "@/server/security/rate-limit";
import { verifyWebsiteRequestSignature, websiteSignatureRequired, type VerifiedVisitor, type WebsiteSignatureResult } from "@/server/website-request-signature";

export type WebsiteGuardOutcome =
  | { ok: true; signed: boolean; visitor?: VerifiedVisitor }
  | { ok: false; status: 401 | 429 | 503; code: "signature_required" | "invalid_signature" | "rate_limited" | "unavailable"; retryAfterSeconds?: number };

/** Unattributed website traffic (the website could not determine a visitor IP) shares one bucket with a larger allowance than a single visitor gets. */
export const WEBSITE_UNATTRIBUTED_RATE_MULTIPLIER = 5;
export const WEBSITE_UNATTRIBUTED_KEY = "website-unattributed";

export async function guardWebsiteRequest(input: {
  req: Request;
  /** The exact body bytes received. */
  body: Uint8Array | string;
  /** The company this request is for (the credential's company, or the body's companyId on the public routes). */
  companyId: string | undefined;
  /** Per-visitor limit applied once the signature is verified (omit where the route has its own budget). */
  rateLimit?: { endpoint: string; config: RateLimitConfig };
  /** Test seam. */
  verify?: (i: Parameters<typeof verifyWebsiteRequestSignature>[0]) => Promise<WebsiteSignatureResult>;
}): Promise<WebsiteGuardOutcome> {
  const required = websiteSignatureRequired();
  const verify = input.verify ?? verifyWebsiteRequestSignature;
  const result = await verify({
    headers: input.req.headers,
    method: input.req.method,
    path: new URL(input.req.url).pathname,
    companyId: input.companyId,
    body: input.body,
  });

  if (result.state === "unavailable") {
    console.error("[website-signature] refused: the one-time store is unavailable");
    return { ok: false, status: 503, code: "unavailable" };
  }
  if (result.state === "absent") {
    if (!required) return { ok: true, signed: false };
    console.warn("[website-signature] refused: no signature");
    return { ok: false, status: 401, code: "signature_required" };
  }
  if (result.state === "invalid") {
    // Not required (no secret on this server): a context that cannot be verified is ignored, exactly as before v2.
    if (!required) return { ok: true, signed: false };
    console.warn(`[website-signature] refused: ${result.reason}`);
    return { ok: false, status: 401, code: "invalid_signature" };
  }

  if (input.rateLimit) {
    const attributed = result.visitor.ip !== undefined;
    const config = attributed ? input.rateLimit.config : { ...input.rateLimit.config, maxAttempts: input.rateLimit.config.maxAttempts * WEBSITE_UNATTRIBUTED_RATE_MULTIPLIER };
    const limited = await checkPublicRateLimitForKey(result.visitor.ip ?? WEBSITE_UNATTRIBUTED_KEY, `${input.rateLimit.endpoint}:website`, config);
    if (!limited.allowed) return { ok: false, status: 429, code: "rate_limited", retryAfterSeconds: limited.retryAfterSeconds };
  }
  return { ok: true, signed: true, visitor: result.visitor };
}

/** The JSON answer of the public website routes ({ ok: false, error }) for a refused request. Fixed texts: nothing about why, no reflected input. */
export function websiteGuardResponse(guard: Extract<WebsiteGuardOutcome, { ok: false }>): NextResponse {
  const error =
    guard.code === "rate_limited"
      ? "Too many requests from this connection. Please wait a few minutes and try again."
      : guard.code === "unavailable"
        ? "The service is temporarily unavailable. Please try again."
        : "Invalid request signature.";
  return NextResponse.json(
    { ok: false, error },
    { status: guard.status, headers: { "Cache-Control": "no-store", ...(guard.retryAfterSeconds ? { "Retry-After": String(guard.retryAfterSeconds) } : {}) } }
  );
}
