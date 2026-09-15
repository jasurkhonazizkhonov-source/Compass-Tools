import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { duplicateContactWhere } from "@/lib/contact-matching";
import { normalizePhoneNumber } from "@/lib/phone";
import { notifyNewInquiry } from "@/server/admin-notifications";
import { checkPublicRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";

// Part 9 — the public company website's "Get in Touch" form posts here.
// Unauthenticated by design (mirrors /api/track/quote-open, the one
// existing precedent for a public-facing route in this app) — a visitor
// has no CRM session. companyId is required in the payload rather than
// inferred, since this app is multi-tenant (Compass Tools serves many
// travel agencies, each with their own public site) and there is no
// other signal (subdomain, referer) this route can safely trust to
// determine which company's inbox an inquiry belongs to.
const inquirySchema = z.object({
  companyId: z.string().min(1),
  firstName: z.string().min(1).max(200),
  lastName: z.string().min(1).max(200),
  email: z.string().email(),
  phone: z.string().max(50).optional(),
  subject: z.enum(["GENERAL_INQUIRY", "FLIGHT_REQUEST_HELP", "EXISTING_BOOKING", "CORPORATE_TRAVEL", "OTHER"]),
  message: z.string().min(1).max(5000),
});

export async function POST(req: Request) {
  // Pass 26 §35 — public-endpoint rate limiting, same pattern as
  // lead-capture's own route (see its comment).
  const rateLimitCheck = await checkPublicRateLimit(req.headers, "CONTACT_INQUIRY", RATE_LIMITS.CONTACT_INQUIRY);
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

  const parsed = inquirySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid submission" }, { status: 400 });
  }
  const data = parsed.data;

  const company = await prisma.company.findUnique({ where: { id: data.companyId }, select: { id: true } });
  if (!company) {
    return NextResponse.json({ ok: false, error: "Unknown company" }, { status: 400 });
  }

  const normalizedPhone = data.phone ? normalizePhoneNumber(data.phone) ?? data.phone : undefined;

  // Real bug found and fixed: unlike lead-capture's own route (which
  // already wraps its write path and returns a clean, structured error),
  // this route's database calls were unguarded — an unexpected exception
  // (a transient database hiccup, the same class of failure the CRM's own
  // connection-pool sizing fix addresses) would propagate straight out of
  // this Route Handler as Next's own generic, unstructured error response
  // rather than the same clean `{ok:false,error}` JSON shape this
  // endpoint returns on every other failure path — harder for the
  // website's own integration to handle gracefully, and a worse signal
  // for "was this inquiry actually lost" than a clear failure response.
  let inquiryId: string;
  try {
    // Matches an existing Contact by normalized phone/email (same helper
    // createLead's dedup flow uses) — purely informational, never auto-
    // overwrites the matched contact's own data (Part 9's explicit
    // requirement). Scoped to this company only, same isolation as every
    // other cross-entity lookup in this app.
    const orConditions = duplicateContactWhere(normalizedPhone, data.email);
    const matchedContact = orConditions.length > 0
      ? await prisma.contact.findFirst({ where: { companyId: data.companyId, OR: orConditions }, select: { id: true } })
      : null;

    const inquiry = await prisma.contactInquiry.create({
      data: {
        companyId: data.companyId,
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        phone: normalizedPhone,
        subject: data.subject,
        message: data.message,
        matchedContactId: matchedContact?.id,
      },
    });
    inquiryId = inquiry.id;
  } catch {
    return NextResponse.json({ ok: false, error: "Could not submit your request. Please try again or contact us directly." }, { status: 500 });
  }

  await notifyNewInquiry(data.companyId, inquiryId, `${data.firstName} ${data.lastName}`).catch(() => undefined);

  return NextResponse.json({ ok: true, id: inquiryId });
}
