import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { InquirySource } from "@/generated/prisma/client";
import { duplicateContactWhere } from "@/lib/contact-matching";
import { normalizePhoneNumber } from "@/lib/phone";
import { notifyNewInquiry } from "@/server/admin-notifications";
import { checkPublicRateLimit, type RateLimitConfig } from "@/server/security/rate-limit";

// The one implementation behind BOTH public inquiry endpoints. Each endpoint
// is a thin route file that names the inquiry SOURCE it stands for:
//   /api/public/contact-inquiry — Business Flights Travel website "Get In Touch"
//   /api/public/crm-inquiry     — the Compass Tools CRM website's contact form
// The source is fixed by WHICH ROUTE was called — never read from the request
// body — so a visitor can not choose (or forge) which Admin inbox their
// submission lands in.
//
// Unauthenticated by design (mirrors /api/track/quote-open) — a visitor has
// no CRM session. companyId is required in the payload; an unknown company is
// rejected with a generic message.
const inquirySchema = z.object({
  companyId: z.string().min(1),
  firstName: z.string().min(1).max(200),
  lastName: z.string().min(1).max(200),
  email: z.string().email(),
  phone: z.string().max(50).optional(),
  subject: z.enum(["GENERAL_INQUIRY", "FLIGHT_REQUEST_HELP", "EXISTING_BOOKING", "CORPORATE_TRAVEL", "OTHER"]),
  message: z.string().min(1).max(5000),
});

export async function handlePublicInquiryPost(
  req: Request,
  options: { source: InquirySource; rateLimitEndpoint: string; rateLimit: RateLimitConfig }
) {
  // Pass 26 §35 — public-endpoint rate limiting, same pattern as
  // lead-capture's own route. Each inquiry system has its own counter.
  const rateLimitCheck = await checkPublicRateLimit(req.headers, options.rateLimitEndpoint, options.rateLimit);
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

  // The database calls are guarded so a transient failure returns the same
  // clean { ok:false, error } JSON shape as every other failure path (and a
  // clear "was this inquiry lost" signal) rather than Next's generic 500.
  let inquiryId: string;
  try {
    // Matches an existing Contact by normalized phone/email — purely
    // informational, never overwrites the matched contact's own data.
    const orConditions = duplicateContactWhere(normalizedPhone, data.email);
    const matchedContact =
      orConditions.length > 0
        ? await prisma.contact.findFirst({ where: { companyId: data.companyId, OR: orConditions }, select: { id: true } })
        : null;

    const inquiry = await prisma.contactInquiry.create({
      data: {
        companyId: data.companyId,
        source: options.source,
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

  await notifyNewInquiry(data.companyId, inquiryId, `${data.firstName} ${data.lastName}`, options.source).catch(() => undefined);

  return NextResponse.json({ ok: true, id: inquiryId });
}
