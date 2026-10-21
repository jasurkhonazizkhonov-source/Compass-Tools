import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { checkPublicRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { buildLeadSubmissionInfoCreate } from "@/server/lead-submission-info";
import { createWebsiteFlightLead, flightInquiryBase, refinePhone } from "@/server/lead-intake";

// Part 12/25 — the public company website's flight-request form posts
// here. Unauthenticated by design, same precedent as
// /api/public/contact-inquiry: a visitor has no CRM session. companyId is
// required in the payload rather than inferred, for the same multi-tenant
// reason contact-inquiry's own route documents.
//
// This is the BROWSER-facing path. A trusted server-to-server integration (the website's own backend) should use the authenticated,
// versioned POST /api/v1/website/flight-inquiries instead (docs/WEBSITE_LEAD_API.md). Both share ONE lead-creation implementation
// (src/server/lead-intake.ts), so the business rules cannot drift; this route keeps its original contract and behaviour.
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

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

  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
  if (!company) {
    return NextResponse.json({ ok: false, error: "Unknown company" }, { status: 400 });
  }

  // The submitting connection's IP and approximate location, from the request's own trusted headers only (see lead-submission-info.ts)
  // — written in the SAME insert as the lead, so it can never be lost or detached from it.
  const submissionInfo = buildLeadSubmissionInfoCreate(req.headers, new Date(), { budgetCurrency: data.approximateBudget !== undefined ? data.budgetCurrency : undefined });

  const result = await createWebsiteFlightLead({ data, companyId, submissionInfo });
  if (result.status === "failed") {
    // Do NOT silently lose the lead's raw information on an unexpected failure — but also never leak internal error detail to a public
    // caller. The website should show its own generic error state.
    return NextResponse.json({ ok: false, error: "Could not submit your request. Please try again or contact us directly." }, { status: 500 });
  }
  return NextResponse.json(result.status === "duplicate" ? { ok: true, id: result.id, duplicate: true } : { ok: true, id: result.id });
}
