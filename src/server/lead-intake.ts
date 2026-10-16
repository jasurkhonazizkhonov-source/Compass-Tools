import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { resolveContactForNewLead } from "@/server/contact-resolution";
import { distributeNewWebsiteLead } from "@/server/actions/lead-queue";
import { logActivity } from "@/server/activity-log";
import { resolveAirportCodes } from "@/server/queries/reference-data";
import { normalizePhoneNumberWithRecovery } from "@/lib/phone";
import { MAX_LEAD_SEGMENTS } from "@/lib/lead-itinerary";
import { deriveWebsiteLeadId } from "@/server/website-lead-id";
import type { LeadStatus, Prisma } from "@/generated/prisma/client";

// The ONE implementation of "a customer's flight request arrives from the company website and becomes a CRM Lead". It is shared by
//   • POST /api/public/lead-capture            (browser-facing, unauthenticated by design, company chosen by the payload), and
//   • POST /api/v1/website/flight-inquiries    (server-to-server, authenticated, company fixed by the credential),
// so contact de-duplication, ownership, status, multi-city legs, airports, activity and queue distribution can never drift apart.
// Plain server-only module (NOT "use server"): nothing here is an RPC endpoint, and it trusts its caller to have authenticated the
// request and chosen the company.

/** The request fields common to both entry points. `companyId` is deliberately NOT here: each entry point decides the company itself. */
export const flightInquiryBase = z.object({
  firstName: z.string().min(1).max(200),
  lastName: z.string().min(1).max(200),
  phone: z.string().min(1).max(50),
  email: z.string().trim().email().optional(),

  // Airports are submitted by IATA code (what a public form can reasonably collect), resolved to the internal Airport row server-side
  // below — never trusted as a raw internal id.
  departureAirportIata: z.string().length(3).optional(),
  arrivalAirportIata: z.string().length(3).optional(),
  departureDate: z.string().optional(),
  // A multi-city request's ordered legs. Optional and additive: a form that only sends the single departure/arrival pair above keeps
  // working exactly as before. When this is present with more than one leg (or with tripType MULTI_CITY) every leg is stored, in
  // order, and shown in the CRM's Travel Request — none is collapsed into the first route.
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

  datesFlexible: z.boolean().optional(),
  preferredAirline: z.string().max(200).optional(),
  approximateBudget: z.number().positive().optional(),
  // ISO 4217 code of the currency the budget was entered in — kept with the submission details, never mixed into the amount.
  budgetCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  // The form's per-submission key (random, minted by the website per mounted form). The Lead id is derived from it, so a retry or
  // repeat of the SAME submission — through either endpoint or the website's direct write — is a no-op that returns the existing lead.
  submissionId: z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9._-]+$/).optional(),
  additionalNotes: z.string().max(5000).optional(),
});

export type FlightInquiry = z.infer<typeof flightInquiryBase>;

/**
 * Hard-rejects a phone number that cannot be a real, possible number — the same standard the authenticated manual "New Lead" form applies
 * (createLeadSchema in leads.ts). It first attempts the same Excel-mangled-NANP recovery, so a genuine number typed without a "+" is not
 * rejected over a formatting quirk; only something that still cannot be confirmed after that fails.
 */
export function refinePhone(data: { phone: string }, ctx: z.RefinementCtx): void {
  if (!normalizePhoneNumberWithRecovery(data.phone)) {
    ctx.addIssue({ code: "custom", path: ["phone"], message: "That doesn't look like a valid phone number" });
  }
}

export type CreateWebsiteLeadResult = { status: "created"; id: string } | { status: "duplicate"; id: string } | { status: "failed" };

/**
 * Creates the Lead (and its Contact, status history, submission information and every multi-city leg) for one website flight request.
 *
 * `idempotency` is optional extra bookkeeping for the authenticated API: when given, a fingerprint row is written in the SAME insert as
 * the Lead, so a later retry can tell "same request again" from "same key, different request".
 */
export async function createWebsiteFlightLead(params: {
  data: FlightInquiry;
  companyId: string;
  submissionInfo: Prisma.LeadSubmissionInfoCreateWithoutLeadInput | undefined;
  idempotency?: { requestHash: string; source: string };
}): Promise<CreateWebsiteLeadResult> {
  const { data, companyId, submissionInfo, idempotency } = params;

  // Resolve IATA codes to real Airport rows — never fabricated, and simply omitted (not an error) when the code doesn't match a known
  // airport, so a typo'd/unsupported code never blocks the whole submission. Goes through the same centralized, self-healing
  // reference-data lookup every other part of the app uses. resolveAirportCodes returns its map keyed by the exact original string
  // passed in, so upper-case once, up front, and reuse that same value for both the resolve call and the lookup.
  const departureIata = data.departureAirportIata?.toUpperCase();
  const arrivalIata = data.arrivalAirportIata?.toUpperCase();
  // Multi-city: more than one leg, or an explicit MULTI_CITY with legs, means the legs ARE the itinerary. (A lone leg on a
  // one-way/round-trip request is just that request's route.) All codes are resolved in one lookup.
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
  // For a multi-city lead the lead-level route mirrors the FIRST leg, so every consumer that only understands one route keeps working.
  const first = isMultiCity ? legs[0] : null;
  const departureAirport = first ? airportCodes[first.departureIata] : departureIata ? airportCodes[departureIata] : null;
  const arrivalAirport = first ? airportCodes[first.arrivalIata] : arrivalIata ? airportCodes[arrivalIata] : null;
  const firstDepartureDate = first ? first.departureDate : data.departureDate;

  // Idempotency: a submission key fixes the Lead's primary key. An already-saved submission returns that lead before anything else is
  // written (no second contact, lead, segments, submission row, activity or queue entry).
  const derivedLeadId = data.submissionId ? deriveWebsiteLeadId(data.submissionId) : undefined;
  if (derivedLeadId) {
    const existing = await prisma.lead.findUnique({ where: { id: derivedLeadId }, select: { id: true } });
    if (existing) return { status: "duplicate", id: existing.id };
  }

  try {
    // Same dedup-by-phone/email logic createLead uses for an agent-entered lead — never a second, parallel implementation.
    const { contactId, isNewContact } = await resolveContactForNewLead(data.phone, data.email, { firstName: data.firstName, lastName: data.lastName }, companyId);

    if (isNewContact) {
      await logActivity({ contactId, type: "CONTACT_CREATED", description: "Contact created from website lead capture" });
    }

    // Same ownership rule createLead applies: a lead against an EXISTING Contact always belongs to that Contact's current owner — a
    // repeat website submission from the same customer must never be treated as an unowned new lead for the queue to hand out.
    const matchedContact = isNewContact ? null : await prisma.contact.findUnique({ where: { id: contactId }, select: { ownerId: true } });
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
        ...(idempotency ? { ingestFingerprint: { create: { requestHash: idempotency.requestHash, source: idempotency.source } } } : {}),
      },
      select: { id: true },
    });

    await logActivity({ leadId: lead.id, contactId, type: "LEAD_CREATED", description: "Lead created from website" });

    // Best-effort — a cron sweep (/api/cron/leads) also picks up any WEBSITE-sourced, unassigned, never-queued lead, so a failure here
    // never loses the lead, only delays its distribution. A first-time Contact's ownership is never decided here; the REAL "assign the
    // Contact once its Lead is actually accepted" logic lives in acceptLeadOffer (src/server/actions/lead-queue.ts).
    if (!assignedAgentId) {
      await distributeNewWebsiteLead(lead.id).catch(() => undefined);
    }
    return { status: "created", id: lead.id };
  } catch {
    // A concurrent duplicate of the same submission loses on the primary key: that is success, not an error.
    if (derivedLeadId) {
      const existing = await prisma.lead.findUnique({ where: { id: derivedLeadId }, select: { id: true } }).catch(() => null);
      if (existing) return { status: "duplicate", id: existing.id };
    }
    return { status: "failed" };
  }
}
