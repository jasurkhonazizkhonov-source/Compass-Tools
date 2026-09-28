import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { InquirySource } from "@/generated/prisma/client";
import { duplicateContactWhere } from "@/lib/contact-matching";
import { INVALID_EMAIL_MESSAGE, isDisposableEmail } from "@/lib/email-quality";
import { normalizePhoneNumber, isSupportedCountry, type CountryCode } from "@/lib/phone";
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
//
// `phoneCountry`, the honeypot field and the duplicate-submission guard are
// all OPT-IN per caller (see HandlePublicInquiryOptions below) and every new
// input field is optional at the schema level — a caller that never sends
// them (the Business Flights website, posting directly to
// /api/public/contact-inquiry, is a separate application this repo does not
// control) is completely unaffected; its existing behavior is unchanged byte
// for byte. Only /api/public/crm-inquiry opts into the stricter behavior.
const inquirySchema = z.object({
  companyId: z.string().min(1),
  firstName: z.string().min(1).max(200),
  lastName: z.string().min(1).max(200),
  email: z.string().email(),
  phone: z.string().max(50).optional(),
  // The country the visitor selected for `phone` (e.g. "US", "GB", "AU") —
  // used only to resolve a national-format number with no leading "+".
  // Optional and ignored by the lenient (contact-inquiry) path.
  phoneCountry: z.string().max(4).optional(),
  subject: z.enum(["GENERAL_INQUIRY", "FLIGHT_REQUEST_HELP", "EXISTING_BOOKING", "CORPORATE_TRAVEL", "OTHER"]),
  message: z.string().min(1).max(5000),
  // Honeypot: a field a real visitor never sees or fills (see the calling
  // component). A human never has a value here; a bot's autofill/heuristics
  // frequently do. Named generically so its purpose isn't obvious from the
  // wire format either.
  companyWebsite: z.string().max(200).optional(),
});

export type HandlePublicInquiryOptions = {
  source: InquirySource;
  rateLimitEndpoint: string;
  rateLimit: RateLimitConfig;
  /** Reject the submission when `phone` is missing or does not parse to a real,
   * possible number for `phoneCountry`. Off by default (the lenient historical
   * behavior every existing caller of this module already relies on). */
  requirePhone?: boolean;
  /** When true and the honeypot field is filled, silently succeed (same
   * response shape as a real submission) without creating anything. Off by
   * default. */
  honeypot?: boolean;
  /** When set, an identical (companyId, source, email, message) submission
   * within this many milliseconds returns the EXISTING inquiry's id instead of
   * creating a second one — covers a double-click, a repeated tap, or a
   * browser/network retry. Off (undefined) by default. */
  duplicateWindowMs?: number;
  /** Reject addresses at known throwaway-inbox services with a generic
   * "invalid email" message (the screening rule is never described to the
   * visitor). Off by default. */
  rejectDisposableEmail?: boolean;
};

const GENERIC_PHONE_ERROR = "Please check the phone number and country code.";

export async function handlePublicInquiryPost(req: Request, options: HandlePublicInquiryOptions) {
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

  if (options.rejectDisposableEmail && isDisposableEmail(data.email)) {
    return NextResponse.json({ ok: false, error: INVALID_EMAIL_MESSAGE }, { status: 400 });
  }

  // Honeypot: a real visitor's browser never populates this field (it is
  // hidden from sighted users and removed from the tab order and the
  // accessibility tree alike). Reporting success without writing anything
  // keeps a scripted submitter from learning its submission was rejected —
  // see this option's own doc comment.
  if (options.honeypot && data.companyWebsite && data.companyWebsite.trim().length > 0) {
    return NextResponse.json({ ok: true });
  }

  const phoneCountry = data.phoneCountry && isSupportedCountry(data.phoneCountry) ? (data.phoneCountry as CountryCode) : undefined;
  const normalizedPhone = data.phone ? normalizePhoneNumber(data.phone, phoneCountry) : null;
  if (options.requirePhone && !normalizedPhone) {
    return NextResponse.json({ ok: false, error: GENERIC_PHONE_ERROR }, { status: 400 });
  }
  // The lenient (contact-inquiry) path keeps its historical fallback exactly:
  // store the normalized form when it parses, otherwise the raw input as-is
  // — never reject a submission this route has never validated before.
  const phoneToStore = normalizedPhone ?? (options.requirePhone ? undefined : data.phone);

  const company = await prisma.company.findUnique({ where: { id: data.companyId }, select: { id: true } });
  if (!company) {
    return NextResponse.json({ ok: false, error: "Unknown company" }, { status: 400 });
  }

  // The database calls are guarded so a transient failure returns the same
  // clean { ok:false, error } JSON shape as every other failure path (and a
  // clear "was this inquiry lost" signal) rather than Next's generic 500.
  let inquiryId = "";
  let isDuplicate = false;
  try {
    // Matches an existing Contact by normalized phone/email — purely
    // informational, never overwrites the matched contact's own data.
    const orConditions = duplicateContactWhere(phoneToStore ?? undefined, data.email);
    const matchedContact =
      orConditions.length > 0
        ? await prisma.contact.findFirst({ where: { companyId: data.companyId, OR: orConditions }, select: { id: true } })
        : null;

    const createData = {
      companyId: data.companyId,
      source: options.source,
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email,
      phone: phoneToStore || undefined,
      subject: data.subject,
      message: data.message,
      matchedContactId: matchedContact?.id,
    };

    if (options.duplicateWindowMs) {
      const windowMs = options.duplicateWindowMs;
      // A double-click fires two requests within milliseconds, so a plain
      // "look for a recent copy, else insert" races. A transaction-scoped
      // advisory lock keyed on the submission's identity makes the second
      // request wait for the first to commit, then see its row.
      const lockKey = createHash("sha256")
        .update(JSON.stringify([data.companyId, options.source, data.email.trim().toLowerCase(), data.message]))
        .digest("hex");
      const result = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
        const recent = await tx.contactInquiry.findFirst({
          where: {
            companyId: data.companyId,
            source: options.source,
            email: { equals: data.email.trim(), mode: "insensitive" },
            message: data.message,
            createdAt: { gte: new Date(Date.now() - windowMs) },
          },
          select: { id: true },
          orderBy: { createdAt: "desc" },
        });
        if (recent) return { id: recent.id, duplicate: true };
        const created = await tx.contactInquiry.create({ data: createData });
        return { id: created.id, duplicate: false };
      });
      inquiryId = result.id;
      isDuplicate = result.duplicate;
    } else {
      inquiryId = (await prisma.contactInquiry.create({ data: createData })).id;
    }
  } catch (e) {
    // Server log only (error class + Prisma code — never the submission's
    // contents); the visitor still gets the generic message below.
    const code = typeof e === "object" && e && "code" in e ? String((e as { code: unknown }).code) : "";
    console.error(`[public-inquiry] ${options.source} submission failed: ${e instanceof Error ? e.name : "unknown"} ${code}`.trim());
    return NextResponse.json({ ok: false, error: "Could not submit your request. Please try again or contact us directly." }, { status: 500 });
  }

  if (!isDuplicate) {
    await notifyNewInquiry(data.companyId, inquiryId, `${data.firstName} ${data.lastName}`, options.source).catch(() => undefined);
  }

  return NextResponse.json({ ok: true, id: inquiryId });
}
