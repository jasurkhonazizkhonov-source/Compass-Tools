import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { InquirySource } from "@/generated/prisma/client";
import { duplicateContactWhere } from "@/lib/contact-matching";
import { INVALID_EMAIL_MESSAGE, isDisposableEmail } from "@/lib/email-quality";
import { normalizePhoneNumber, isSupportedCountry, type CountryCode } from "@/lib/phone";
import { notifyNewInquiry } from "@/server/admin-notifications";
import { deriveInquiryId } from "@/server/inquiry-id";
import { buildInquirySubmissionInfo } from "@/server/inquiry-submission-info";
import { checkPublicRateLimit, type RateLimitConfig } from "@/server/security/rate-limit";
import { readLimitedJson } from "@/server/security/read-limited-json";

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
  // The submitter's per-submission key (opt-in per route, see `acceptSubmissionId`): a repeat of the SAME submission (a double click, a retry after a
  // timeout, an answer that was lost) is recognised and answered as a duplicate instead of being stored twice. Optional, so a caller that never
  // sends it is completely unaffected. Same shape as the lead endpoint's key.
  submissionId: z
    .string()
    .trim()
    .min(8)
    .max(200)
    .regex(/^[A-Za-z0-9._-]+$/)
    .optional(),
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
  /** True when the caller is another SERVER posting on a visitor's behalf (the Business Flights website's own backend), not the visitor's browser.
   * The connection and forwarded headers then describe THAT server, so they are never used as the visitor's IP; only a verified signed visitor
   * context is (see inquiry-submission-info.ts). Off by default = the request itself is the visitor. */
  serverToServer?: boolean;
  /** When true, a `submissionId` in the body makes the submission idempotent: the inquiry's id is derived from (company, source, key) and a repeat of
   * the same key with the same content is answered as a duplicate (`{ ok: true, id, duplicate: true }`), while the same key with DIFFERENT content is
   * refused (409). Off by default: a route that does not opt in ignores the field. */
  acceptSubmissionId?: boolean;
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

  // Bounded read (see read-limited-json.ts): an unauthenticated caller cannot make the server buffer an arbitrarily large body.
  const limited = await readLimitedJson(req);
  if (!limited.ok) return limited.response;
  const body: unknown = limited.value;

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

  // Real gap found during the CRM health/reliability audit: only the
  // duplicate-guard/create block below was wrapped in try/catch — this
  // lookup sat BEFORE it, so a transient database failure here (the exact
  // class this app has hit in production, see db-connection-retry.ts) threw
  // uncaught and surfaced as Next's bare, empty-body 500 instead of this
  // same route's own clean { ok:false, error } JSON every other failure path
  // already returns. Every database call in this handler is now inside one
  // guarded block.
  // Full IP + approximate location of whoever submitted, from the server's own trusted view of the request - never from the body. Best effort:
  // it returns undefined (and never throws) when nothing trustworthy is known, so it can never cost the business an inquiry.
  const submissionInfo = await buildInquirySubmissionInfo(req.headers, { serverToServer: options.serverToServer === true });

  let inquiryId = "";
  let isDuplicate = false;
  let keyConflict = false;
  // The id a keyed submission always lands on (see inquiry-id.ts); undefined for a caller or route that does not use submission keys.
  const keyedId = options.acceptSubmissionId && data.submissionId ? deriveInquiryId(data.companyId, options.source, data.submissionId) : undefined;
  try {
    const company = await prisma.company.findUnique({ where: { id: data.companyId }, select: { id: true } });
    if (!company) {
      return NextResponse.json({ ok: false, error: "Unknown company" }, { status: 400 });
    }

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
      submissionInfo: submissionInfo ? { create: submissionInfo } : undefined,
    };

    if (options.duplicateWindowMs || keyedId) {
      const windowMs = options.duplicateWindowMs;
      // A double-click fires two requests within milliseconds, so a plain
      // "look for a recent copy, else insert" races. A transaction-scoped
      // advisory lock keyed on the submission's identity makes the second
      // request wait for the first to commit, then see its row. The content
      // lock (as before) serialises identical messages; a keyed submission
      // ALSO takes a lock on its derived id, always in the same order
      // (content, then key) so two requests can never deadlock, which
      // serialises simultaneous requests that share a key but differ in
      // content (one stored, the other refused as a key conflict).
      const lockKey = createHash("sha256")
        .update(JSON.stringify([data.companyId, options.source, data.email.trim().toLowerCase(), data.message]))
        .digest("hex");
      const result = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
        if (keyedId) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${keyedId}, 0))`;
          const existing = await tx.contactInquiry.findUnique({ where: { id: keyedId }, select: { id: true, companyId: true, source: true, email: true, message: true } });
          if (existing) {
            // A repeat is only a clean repeat when it is the same message from the same address in the same company and inbox.
            const same =
              existing.companyId === data.companyId &&
              existing.source === options.source &&
              existing.email.trim().toLowerCase() === data.email.trim().toLowerCase() &&
              existing.message === data.message;
            return { id: existing.id, duplicate: same, conflict: !same };
          }
        }
        if (windowMs) {
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
          if (recent) return { id: recent.id, duplicate: true, conflict: false };
        }
        const created = await tx.contactInquiry.create({ data: keyedId ? { ...createData, id: keyedId } : createData });
        return { id: created.id, duplicate: false, conflict: false };
      });
      inquiryId = result.id;
      isDuplicate = result.duplicate;
      keyConflict = result.conflict;
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

  // The same key was already used for a DIFFERENT message: nothing was stored and the caller is told so (the website derives its key from the content,
  // so this only happens if a key is reused by mistake). The existing inquiry is never overwritten and its id is not revealed.
  if (keyConflict) {
    return NextResponse.json({ ok: false, error: "This submission key was already used for a different message." }, { status: 409 });
  }

  if (!isDuplicate) {
    await notifyNewInquiry(data.companyId, inquiryId, `${data.firstName} ${data.lastName}`, options.source).catch(() => undefined);
  }

  // `duplicate` is additive: it appears only when this was a repeat, so every existing caller's response is unchanged.
  return NextResponse.json({ ok: true, id: inquiryId, ...(isDuplicate ? { duplicate: true } : {}) });
}
