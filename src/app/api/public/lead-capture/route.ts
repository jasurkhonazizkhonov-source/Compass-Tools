import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { readLimitedJson } from "@/server/security/read-limited-json";
import { checkPublicRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { buildLeadSubmissionInfoCreate, withLocalLocation } from "@/server/lead-submission-info";
import { createWebsiteFlightLead, flightInquiryBase, refinePhone } from "@/server/lead-intake";
import { guardWebsiteRequest, websiteGuardResponse } from "@/server/website-signature-guard";

// Part 12/25 — the public company website's flight-request form posts
// here. Unauthenticated by design, same precedent as
// /api/public/contact-inquiry: a visitor has no CRM session. companyId is
// required in the payload rather than inferred, for the same multi-tenant
// reason contact-inquiry's own route documents.
//
// This is the BROWSER-facing path. A trusted server-to-server integration (the website's own backend) should use the authenticated,
// versioned POST /api/v1/website/flight-inquiries instead (docs/WEBSITE_LEAD_API.md).
//
// Signing v2 (website-signature-guard.ts): like every other route the Business Flights website's server can reach, this one goes through the website signature guard. In
// the transitional default (WEBSITE_SIGNATURE_REQUIRED unset) a request WITHOUT a signature behaves exactly as it always did; a valid v2 signature is verified, single-use
// and its signed visitor facts are used. With WEBSITE_SIGNATURE_REQUIRED=true an unsigned, v1, invalid, expired or replayed request is refused with 401 BEFORE anything is
// stored - so strict mode can no longer be bypassed by posting a lead here directly. (The updated website does not call this route; it uses the authenticated API.)
//
// This route and the authenticated API share ONE lead-creation implementation (src/server/lead-intake.ts), so the business rules cannot drift; this route
// keeps its original contract and behaviour.
const leadCaptureSchema = flightInquiryBase
  .extend({ companyId: z.string().min(1) })
  // This endpoint is unauthenticated and reachable by anyone, not just the real website widget — a direct POST with phone: "123" must
  // be rejected here rather than silently creating a low-quality Lead.
  .superRefine(refinePhone);

export async function POST(req: Request) {
  // Pass 26 §35 — public-endpoint rate limiting, checked first, before any parsing/DB work. Uses the Request's own headers directly.
  const rateLimitCheck = await checkPublicRateLimit(req.headers, "LEAD_CAPTURE", RATE_LIMITS.LEAD_CAPTURE);
  if (!rateLimitCheck.allowed) {
    return NextResponse.json(
      { ok: false, error: "Too many requests from this connection. Please wait a few minutes and try again." },
      { status: 429, headers: { "Retry-After": String(rateLimitCheck.retryAfterSeconds) } }
    );
  }

  // Bounded read (see read-limited-json.ts): an unauthenticated caller cannot make the server buffer an arbitrarily large body.
  const limited = await readLimitedJson(req);
  if (!limited.ok) return limited.response;
  const body: unknown = limited.value;

  const parsed = leadCaptureSchema.safeParse(body);
  if (!parsed.success) {
    // Surface the specific field/message (e.g. "phone: That doesn't look like a valid phone number") rather than an opaque "Invalid
    // submission" — the website's own backend integrates against this, so the caller needs enough detail to show its visitor a
    // meaningful error (or fix its own integration) without us leaking a stack trace or any internal detail beyond "this specific
    // field didn't validate".
    const firstIssue = parsed.error.issues[0];
    const detail = firstIssue ? `${firstIssue.path.join(".")}: ${firstIssue.message}` : "Invalid submission";
    return NextResponse.json({ ok: false, error: detail }, { status: 400 });
  }
  const { companyId, ...data } = parsed.data;

  // Strict mode / signature: after validation (the body is known to be well-formed) and before ANY database work.
  const guard = await guardWebsiteRequest({ req, body: limited.raw, companyId, rateLimit: { endpoint: "LEAD_CAPTURE", config: RATE_LIMITS.LEAD_CAPTURE } });
  if (!guard.ok) return websiteGuardResponse(guard);

  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
  if (!company) {
    return NextResponse.json({ ok: false, error: "Unknown company" }, { status: 400 });
  }

  // The submitting connection's IP and approximate location, from the request's own trusted headers only (see lead-submission-info.ts)
  // — written in the SAME insert as the lead, so it can never be lost or detached from it.
  const submissionInfo = await withLocalLocation(buildLeadSubmissionInfoCreate(req.headers, new Date(), { budgetCurrency: data.approximateBudget !== undefined ? data.budgetCurrency : undefined, ...(guard.visitor ? { verifiedVisitor: guard.visitor } : {}) }));

  const result = await createWebsiteFlightLead({ data, companyId, submissionInfo });
  if (result.status === "failed") {
    // Do NOT silently lose the lead's raw information on an unexpected failure — but also never leak internal error detail to a public
    // caller. The website should show its own generic error state.
    return NextResponse.json({ ok: false, error: "Could not submit your request. Please try again or contact us directly." }, { status: 500 });
  }
  return NextResponse.json(result.status === "duplicate" ? { ok: true, id: result.id, duplicate: true } : { ok: true, id: result.id });
}
