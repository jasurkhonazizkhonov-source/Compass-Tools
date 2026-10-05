import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { resolveContactForNewLead } from "@/server/contact-resolution";
import { distributeNewWebsiteLead } from "@/server/actions/lead-queue";
import { logActivity } from "@/server/activity-log";
import { resolveAirportCodes } from "@/server/queries/reference-data";
import { normalizePhoneNumberWithRecovery } from "@/lib/phone";
import { checkPublicRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { MAX_LEAD_SEGMENTS } from "@/lib/lead-itinerary";
import { buildLeadSubmissionInfoCreate } from "@/server/lead-submission-info";
import { deriveWebsiteLeadId } from "@/server/website-lead-id";
import type { LeadStatus } from "@/generated/prisma/client";

// Part 12/25 — the public company website's flight-request form posts
// here. Unauthenticated by design, same precedent as
// /api/public/contact-inquiry: a visitor has no CRM session. companyId is
// required in the payload rather than inferred, for the same multi-tenant
// reason contact-inquiry's own route documents.
const leadCaptureSchema = z
  .object({
    companyId: z.string().min(1),
    firstName: z.string().min(1).max(200),
    lastName: z.string().min(1).max(200),
    phone: z.string().min(1).max(50),
    email: z.string().trim().email().optional(),

    // Airports are submitted by IATA code (what a public form can reasonably
    // collect), resolved to the internal Airport row server-side below —
    // never trusted as a raw internal id.
    departureAirportIata: z.string().length(3).optional(),
    arrivalAirportIata: z.string().length(3).optional(),
    departureDate: z.string().optional(),
    // A multi-city request's ordered legs. Optional and additive: a form that
    // only sends the single departure/arrival pair above keeps working exactly
    // as before. When this is present with more than one leg (or with tripType
    // MULTI_CITY) every leg is stored, in order, and shown in the CRM's Travel
    // Request — none is collapsed into the first route.
    segments: z
      .array(
        z.object({
          departureAirportIata: z.string().length(3),
          arrivalAirportIata: z.string().length(3),
          departureDate: z.string().optional(),
        })
      )
      .min(1)
      .max(MAX_LEAD_SEGMENTS)
      .optional(),
    returnDate: z.string().optional(),
    tripType: z.enum(["ONE_WAY", "ROUND_TRIP", "MULTI_CITY"]).default("ROUND_TRIP"),
    cabinClass: z.enum(["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"]).default("ECONOMY"),
    adults: z.number().min(1).max(20).default(1),
    children: z.number().min(0).max(20).default(0),
    infants: z.number().min(0).max(20).default(0),

    // Part 12 — the additional optional fields the website form now collects.
    datesFlexible: z.boolean().optional(),
    preferredAirline: z.string().max(200).optional(),
    approximateBudget: z.number().positive().optional(),
    // ISO 4217 code of the currency the budget was entered in — kept with the submission details, never mixed into the amount.
    budgetCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
    // The form's per-submission key (random, minted by the website per mounted form). The Lead id is derived from it, so
    // a retry or repeat of the SAME submission — through this endpoint or the website's direct write — is a no-op that
    // returns the existing lead instead of creating a second one.
    submissionId: z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9._-]+$/).optional(),
    additionalNotes: z.string().max(5000).optional(),
  })
  .superRefine((data, ctx) => {
    // This endpoint is unauthenticated and reachable by anyone, not just
    // the real website widget — a direct POST with phone: "123" must be
    // rejected here rather than silently creating a low-quality Lead, the
    // same hard-reject standard the authenticated manual "New Lead" form
    // already applies (see createLeadSchema in leads.ts). Attempts the same
    // Excel-mangled-NANP recovery first so a genuine customer number typed
    // without a "+" (e.g. copy/pasted from a spreadsheet-like source) isn't
    // rejected over a formatting quirk — only something that still can't be
    // confirmed as a real, possible phone number after that fails.
    if (!normalizePhoneNumberWithRecovery(data.phone)) {
      ctx.addIssue({ code: "custom", path: ["phone"], message: "That doesn't look like a valid phone number" });
    }
  });

export async function POST(req: Request) {
  // Pass 26 §35 — public-endpoint rate limiting, checked first, before any
  // parsing/DB work. Uses the Request's own headers directly (a route
  // handler already has real request headers — no need for the
  // next/headers-reading FromRequest wrapper submitBooking/
  // confirmCancellationByCustomer use as server actions).
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
    // Surface the specific field/message (e.g. "phone: That doesn't look
    // like a valid phone number") rather than an opaque "Invalid
    // submission" — this is a machine-to-machine API the website's own
    // backend integrates against, not a CRM user-facing form, so the
    // caller needs enough detail to show its visitor a meaningful error
    // (or fix its own integration) without us leaking a stack trace or any
    // internal detail beyond "this specific field didn't validate".
    const firstIssue = parsed.error.issues[0];
    const detail = firstIssue ? `${firstIssue.path.join(".")}: ${firstIssue.message}` : "Invalid submission";
    return NextResponse.json({ ok: false, error: detail }, { status: 400 });
  }
  const data = parsed.data;

  const company = await prisma.company.findUnique({ where: { id: data.companyId }, select: { id: true } });
  if (!company) {
    return NextResponse.json({ ok: false, error: "Unknown company" }, { status: 400 });
  }

  // Resolve IATA codes to real Airport rows — never fabricated, and simply
  // omitted (not an error) when the code doesn't match a known airport, so
  // a typo'd/unsupported code never blocks the whole submission. Goes
  // through the same centralized, self-healing reference-data lookup every
  // other part of the app uses (see reference-data.ts's
  // ensureReferenceDataSeeded) instead of a direct prisma.airport call, so
  // a fresh/unseeded database resolves a code here exactly the same way it
  // would from the CRM's own itinerary builders.
  // resolveAirportCodes returns its map keyed by the exact original string
  // passed in (not an uppercased/normalized form — see its own comment) so
  // that every caller can look a result up with the same value it supplied,
  // regardless of casing/whitespace normalization applied internally for
  // the actual DB query. Uppercase once, up front, and reuse that same
  // value for both the resolve call and the lookup.
  const departureIata = data.departureAirportIata?.toUpperCase();
  const arrivalIata = data.arrivalAirportIata?.toUpperCase();
  // Multi-city: more than one leg, or an explicit MULTI_CITY with legs, means the
  // legs ARE the itinerary. (A lone leg on a one-way/round-trip request is just
  // that request's route.) All codes are resolved in one lookup.
  const legs = (data.segments ?? []).map((seg) => ({
    departureIata: seg.departureAirportIata.toUpperCase(),
    arrivalIata: seg.arrivalAirportIata.toUpperCase(),
    departureDate: seg.departureDate,
  }));
  const isMultiCity = legs.length > 1 || (data.tripType === "MULTI_CITY" && legs.length > 0);
  const tripType = isMultiCity ? ("MULTI_CITY" as const) : data.tripType;
  const airportCodes = await resolveAirportCodes(
    [departureIata, arrivalIata, ...(isMultiCity ? legs.flatMap((l) => [l.departureIata, l.arrivalIata]) : [])].filter((c): c is string => !!c)
  );
  // For a multi-city lead the lead-level route mirrors the FIRST leg, so every
  // consumer that only understands one route keeps working.
  const first = isMultiCity ? legs[0] : null;
  const departureAirport = first ? airportCodes[first.departureIata] : departureIata ? airportCodes[departureIata] : null;
  const arrivalAirport = first ? airportCodes[first.arrivalIata] : arrivalIata ? airportCodes[arrivalIata] : null;
  const firstDepartureDate = first ? first.departureDate : data.departureDate;

  // The submitting connection's IP and approximate location, from the request's own
  // trusted headers only (see lead-submission-info.ts) — written in the SAME insert as
  // the lead, so it can never be lost or detached from it.
  const submissionInfo = buildLeadSubmissionInfoCreate(req.headers, new Date(), { budgetCurrency: data.approximateBudget !== undefined ? data.budgetCurrency : undefined });

  // Idempotency: a submission key fixes the Lead's primary key. An already-saved submission returns that lead before
  // anything else is written (no second contact, lead, segments, submission row, activity or queue entry).
  const derivedLeadId = data.submissionId ? deriveWebsiteLeadId(data.submissionId) : undefined;
  if (derivedLeadId) {
    const existing = await prisma.lead.findUnique({ where: { id: derivedLeadId }, select: { id: true } });
    if (existing) return NextResponse.json({ ok: true, id: existing.id, duplicate: true });
  }

  let leadId: string;
  try {
    // Same dedup-by-phone/email logic createLead uses for an agent-entered
    // lead — never a second, parallel implementation (see
    // resolveContactForNewLead's own doc comment).
    const { contactId, isNewContact } = await resolveContactForNewLead(
      data.phone,
      data.email,
      { firstName: data.firstName, lastName: data.lastName },
      data.companyId
    );

    if (isNewContact) {
      await logActivity({ contactId, type: "CONTACT_CREATED", description: "Contact created from website lead capture" });
    }

    // Same ownership rule createLead applies: a lead against an EXISTING
    // Contact always belongs to that Contact's current owner — a repeat
    // website submission from the same customer must never be treated as
    // an unowned new lead for the queue to hand out to someone else.
    const matchedContact = isNewContact
      ? null
      : await prisma.contact.findUnique({ where: { id: contactId }, select: { ownerId: true } });
    const assignedAgentId = matchedContact?.ownerId ?? undefined;
    const initialStatus: LeadStatus = assignedAgentId ? "ACCEPTED" : "ATTEMPTING_TO_CONTACT";

    const lead = await prisma.lead.create({
      data: {
        ...(derivedLeadId ? { id: derivedLeadId } : {}),
        contactId,
        departureAirportId: departureAirport?.id,
        arrivalAirportId: arrivalAirport?.id,
        departureDate: firstDepartureDate ? new Date(firstDepartureDate) : undefined,
        returnDate: isMultiCity ? undefined : data.returnDate ? new Date(data.returnDate) : undefined,
        tripType,
        ...(isMultiCity
          ? {
              segments: {
                create: legs.map((l, i) => ({
                  sequence: i + 1,
                  departureAirportId: airportCodes[l.departureIata]?.id,
                  arrivalAirportId: airportCodes[l.arrivalIata]?.id,
                  departureDate: l.departureDate ? new Date(l.departureDate) : undefined,
                })),
              },
            }
          : {}),
        cabinClass: data.cabinClass,
        adults: data.adults,
        children: data.children,
        infants: data.infants,
        flexibleDates: data.datesFlexible ?? false,
        preferredAirline: data.preferredAirline,
        budget: data.approximateBudget,
        notes: data.additionalNotes,
        source: "WEBSITE",
        priority: "MEDIUM",
        assignedAgentId,
        status: initialStatus,
        statusHistory: { create: [{ toStatus: initialStatus }] },
        ...(submissionInfo ? { submissionInfo: { create: submissionInfo } } : {}),
      },
      select: { id: true },
    });
    leadId = lead.id;

    await logActivity({ leadId, contactId, type: "LEAD_CREATED", description: "Lead created from website" });

    // Pass 30 — removed a dead branch that used to sit here
    // (`if (isNewContact && assignedAgentId) { ...contact.update... }`).
    // It could never actually run: `assignedAgentId` above is only ever
    // set when `matchedContact` is non-null, which itself only happens
    // when `isNewContact` is false — so `isNewContact && assignedAgentId`
    // was structurally always false. A first-time Contact's ownership is
    // never decided here; it's still genuinely unassigned at this point,
    // exactly as intended (see the block below — the Lead enters the
    // queue for a brand-new/unowned-existing Contact). The REAL "assign
    // the Contact once its Lead is actually accepted" logic now lives in
    // acceptLeadOffer (src/server/actions/lead-queue.ts), the one place
    // that genuinely knows a Lead was just successfully claimed — see its
    // own comment for the fix and reasoning.
    // Best-effort — a cron sweep (/api/cron/leads) also picks up any
    // WEBSITE-sourced, unassigned, never-queued lead, so a failure here
    // never loses the lead, only delays its distribution.
    if (!assignedAgentId) {
      await distributeNewWebsiteLead(leadId).catch(() => undefined);
    }
  } catch {
    // A concurrent duplicate of the same submission loses on the primary key: that is success, not an error.
    if (derivedLeadId) {
      const existing = await prisma.lead.findUnique({ where: { id: derivedLeadId }, select: { id: true } }).catch(() => null);
      if (existing) return NextResponse.json({ ok: true, id: existing.id, duplicate: true });
    }
    // Do NOT silently lose the lead's raw information on an unexpected
    // failure — but also never leak internal error detail to a public
    // caller. The website should show its own generic error state; the
    // company should independently reach out to Compass Tools support if
    // this becomes a recurring pattern (matches Part 22's "website lead
    // capture fails -> show appropriate website error" requirement).
    return NextResponse.json({ ok: false, error: "Could not submit your request. Please try again or contact us directly." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: leadId });
}
