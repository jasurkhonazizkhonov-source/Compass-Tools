"use server";

import { z } from "zod";
import { nanoid, customAlphabet } from "nanoid";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { logActivity } from "@/server/activity-log";
import { calculatePricing } from "@/lib/pricing";
import { sendEmail } from "@/server/email/service";
import { buildQuoteEmail } from "@/server/email/templates";
import { toEmailSegments } from "@/server/email/segment-mapper";
import { transitionQuoteStatus } from "@/server/quote-status";
import { getCompanyForAccountId } from "@/server/queries/company";
import { resolveBaseUrl } from "@/lib/company-config";
import { applyLeadStatusChange } from "@/server/actions/leads";
import { SEGMENT_SELECT } from "@/server/queries/segment-select";
import { parseAirportDateTimeString } from "@/lib/airport-datetime";
import { canDeleteQuote } from "@/lib/permissions";
import { getPassengerCount } from "@/lib/passengers";
import { quoteVisibilityWhere, leadAccessForQuoting } from "@/server/visibility";
import { SUPPORTED_CURRENCIES, buildPricingSnapshot } from "@/lib/currency";
import { isQuoteCancelable } from "@/lib/quote-cancelability";
import { segmentSchema } from "@/server/actions/quote-segment-schema";

const quoteNumberAlphabet = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 8);

const createQuoteSchema = z.object({
  leadId: z.string(),
  source: z.enum(["SABRE", "APOLLO", "MANUAL"]),
  tripType: z.enum(["ONE_WAY", "ROUND_TRIP", "MULTI_CITY"]),
  segments: z.array(segmentSchema).min(1),
  adults: z.number().min(1),
  children: z.number().min(0),
  infants: z.number().min(0),
  adultPrice: z.number().min(0),
  childPrice: z.number().min(0),
  infantPrice: z.number().min(0),
  taxes: z.number().min(0),
  serviceFee: z.number().min(0),
  gratuity: z.number().min(0),
  // Customer-facing currency + the rate used to convert the USD prices
  // above. Rate is required for any non-USD currency (validated below —
  // z.enum alone can't express "required unless X", so this is checked in
  // a .refine); USD needs no rate since its rate is always exactly 1.
  currency: z.enum(SUPPORTED_CURRENCIES).default("USD"),
  exchangeRate: z.number().positive().optional(),
  termsAndConditions: z.string().optional(),
  // Agent-only — never exposed on any customer-facing page/email/API.
  internalNotes: z.string().optional(),
  netTicketCost: z.number().min(0).optional(),
}).refine((v) => v.currency === "USD" || (v.exchangeRate !== undefined && v.exchangeRate > 0), {
  message: "An exchange rate is required for a non-USD currency",
  path: ["exchangeRate"],
});

export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;

export async function createQuote(input: CreateQuoteInput) {
  const parsed = createQuoteSchema.parse(input);
  const actor = await getCurrentAccount();

  const lead = await prisma.lead.findFirst({ where: { id: parsed.leadId, ...leadAccessForQuoting(actor) } });
  if (!lead) throw new Error("Lead not found");
  const pricing = calculatePricing(parsed);

  const quoteNumber = `Q-${quoteNumberAlphabet()}`;
  const secureToken = nanoid(32);

  const quote = await prisma.quote.create({
    data: {
      quoteNumber,
      secureToken,
      leadId: parsed.leadId,
      contactId: lead.contactId,
      agentId: actor?.id,
      status: "DRAFT",
      source: parsed.source,
      adults: parsed.adults,
      children: parsed.children,
      infants: parsed.infants,
      adultPrice: parsed.adultPrice,
      childPrice: parsed.childPrice,
      infantPrice: parsed.infantPrice,
      taxes: parsed.taxes,
      serviceFee: parsed.serviceFee,
      gratuity: parsed.gratuity,
      total: pricing.total,
      currency: parsed.currency,
      exchangeRate: parsed.currency === "USD" ? null : parsed.exchangeRate,
      termsAndConditions: parsed.termsAndConditions,
      internalNotes: parsed.internalNotes,
      netTicketCost: parsed.netTicketCost,
      statusHistory: { create: [{ toStatus: "DRAFT", changedById: actor?.id }] },
      itinerary: {
        create: {
          tripType: parsed.tripType,
          segments: {
            create: parsed.segments.map((s) => ({
              sequence: s.sequence,
              departureAirportId: s.departureAirportId,
              arrivalAirportId: s.arrivalAirportId,
              // s.departureAt/s.arrivalAt are naive "YYYY-MM-DDTHH:MM:00"
              // strings (airport-local wall-clock time, no real timezone
              // meaning) — see airport-datetime.ts's header comment for
              // why this must be parsed as UTC explicitly rather than via
              // a bare `new Date(...)`, which would silently depend on
              // this server process's ambient TZ.
              departureAt: parseAirportDateTimeString(s.departureAt),
              arrivalAt: parseAirportDateTimeString(s.arrivalAt),
              airlineId: s.airlineId,
              airlineCodeRaw: s.airlineCodeRaw,
              flightNumber: s.flightNumber,
              bookingClass: s.bookingClass,
              cabin: s.cabin,
              aircraftTypeId: s.aircraftTypeId,
              aircraftRaw: s.aircraftRaw,
              operatingCarrierName: s.operatingCarrierName,
              durationMinutes: s.durationMinutes,
              connectionType: s.connectionType,
              isExtraLeg: s.isExtraLeg ?? false,
            })),
          },
        },
      },
    },
  });

  await logActivity({
    leadId: parsed.leadId,
    contactId: lead.contactId,
    quoteId: quote.id,
    actorId: actor?.id,
    type: "QUOTE_CREATED",
    description: `Quote ${quoteNumber} created`,
  });

  revalidatePath(`/leads/${parsed.leadId}`);
  revalidatePath("/quotes");

  return { quoteId: quote.id };
}

export async function updateQuotePricing(
  quoteId: string,
  patch: {
    adults: number;
    children: number;
    infants: number;
    adultPrice: number;
    childPrice: number;
    infantPrice: number;
    taxes: number;
    serviceFee: number;
    gratuity: number;
    currency?: (typeof SUPPORTED_CURRENCIES)[number];
    exchangeRate?: number;
  }
) {
  const actor = await getCurrentAccount();
  const existing = await prisma.quote.findFirst({ where: { id: quoteId, ...quoteVisibilityWhere(actor) }, select: { id: true } });
  if (!existing) throw new Error("Quote not found");

  const pricing = calculatePricing(patch);
  const currency = patch.currency ?? "USD";
  const quote = await prisma.quote.update({
    where: { id: quoteId },
    data: {
      ...patch,
      currency,
      exchangeRate: currency === "USD" ? null : patch.exchangeRate,
      total: pricing.total,
    },
  });
  revalidatePath(`/quotes/${quoteId}`);
  // Plain, serializable summary — Prisma's Decimal fields on `quote` can't
  // cross the server-action/RSC boundary to a client caller.
  return { id: quote.id, total: pricing.total };
}

/**
 * Agent-only. `internalNotes`/`netTicketCost` are never read by any
 * customer-facing query (see getQuoteByToken's explicit field allow-list)
 * — this action is the only write path for them, and there is no
 * "signed = read-only" lock on this data anywhere in the app, so it stays
 * editable regardless of the quote/booking's status.
 */
export async function updateQuoteInternalNotes(quoteId: string, patch: { internalNotes?: string | null; netTicketCost?: number | null }) {
  const actor = await getCurrentAccount();
  const existing = await prisma.quote.findFirst({ where: { id: quoteId, ...quoteVisibilityWhere(actor) }, select: { id: true } });
  if (!existing) throw new Error("Quote not found");

  await prisma.quote.update({
    where: { id: quoteId },
    data: { internalNotes: patch.internalNotes, netTicketCost: patch.netTicketCost },
  });
  revalidatePath(`/quotes/${quoteId}`);
}

/**
 * @param recipientEmail Part 17/18/19 — required when the Contact has more
 * than one email on file (the send-quote UI shows a picker in that case);
 * always re-validated server-side against the contact's OWN emails
 * (ContactEmail rows, or the denormalized primaryEmail) — never trusted
 * blindly, so a tampered request can never redirect a quote to an
 * arbitrary address. Omitted (or left undefined) when the contact has
 * exactly one email, which is used automatically.
 */
export async function sendQuote(quoteId: string, recipientEmail?: string) {
  const actor = await getCurrentAccount();
  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, ...quoteVisibilityWhere(actor) },
    include: {
      contact: { include: { emails: { orderBy: { isPrimary: "desc" } } } },
      agent: true,
      itinerary: {
        include: {
          segments: {
            select: SEGMENT_SELECT,
            orderBy: { sequence: "asc" },
          },
        },
      },
      // Only ever non-null for an EXCHANGE quote (see Quote.originalQuoteId)
      // — fetched here so the exchange email/View Deal experience can show
      // the customer's existing itinerary alongside the proposed one. A
      // cheap no-op join for every ordinary (non-exchange) quote, where
      // this is simply null.
      originalQuote: {
        include: {
          itinerary: {
            include: { segments: { select: SEGMENT_SELECT, orderBy: { sequence: "asc" } } },
          },
        },
      },
    },
  });
  if (!quote) throw new Error("Quote not found");

  // The contact's own known emails (ContactEmail rows), falling back to the
  // denormalized primaryEmail for a contact that predates that table ever
  // being populated for it — never a second, parallel list.
  const knownEmails = quote.contact.emails.length > 0
    ? quote.contact.emails.map((e) => e.email)
    : quote.contact.primaryEmail
      ? [quote.contact.primaryEmail]
      : [];
  if (knownEmails.length === 0) {
    return { ok: false as const, error: "This customer has no email address on file." };
  }

  let toEmail: string;
  if (recipientEmail) {
    // Server-side re-validation — the requested address must actually
    // belong to this contact, regardless of what the client claims.
    const match = knownEmails.find((e) => e.toLowerCase() === recipientEmail.trim().toLowerCase());
    if (!match) {
      return { ok: false as const, error: "The selected email address is not on file for this customer." };
    }
    toEmail = match;
  } else if (knownEmails.length === 1) {
    toEmail = knownEmails[0];
  } else {
    return { ok: false as const, error: "This customer has multiple email addresses — choose which one to send the quote to." };
  }

  if (!quote.agent) {
    return { ok: false as const, error: "This quote has no assigned agent to send it from." };
  }

  // Freeze the customer-facing price breakdown at the moment of sending —
  // converted once here and persisted, never recomputed on every render.
  // Every customer-facing surface (this email, View Deal, the booking page,
  // the booking confirmation) reads quote.pricingSnapshot from here on,
  // so the price a customer sees can't drift even if the agent later edits
  // the underlying USD pricing or exchange rate.
  const currency = quote.currency as (typeof SUPPORTED_CURRENCIES)[number];
  const pricingSnapshot = buildPricingSnapshot(
    {
      adultPrice: Number(quote.adultPrice),
      childPrice: Number(quote.childPrice),
      infantPrice: Number(quote.infantPrice),
      taxes: Number(quote.taxes),
      serviceFee: Number(quote.serviceFee),
      gratuity: Number(quote.gratuity),
      total: Number(quote.total),
    },
    currency,
    quote.exchangeRate ? Number(quote.exchangeRate) : 1
  );
  await prisma.quote.update({
    where: { id: quoteId },
    // Captured only once — the first time a quote is actually sent — and
    // never overwritten by a later resend or reassignment, unlike agentId.
    // See Quote.sentByAgentId's schema doc comment.
    data: { pricingSnapshot, sentByAgentId: quote.sentByAgentId ?? quote.agentId },
  });

  const baseUrl = resolveBaseUrl();
  const viewDealUrl = `${baseUrl}/quote/${quote.secureToken}`;
  const trackingPixelUrl = `${baseUrl}/api/track/quote-open/${quote.secureToken}`;
  // Extra Leg segments are a "bonus" the customer only sees once they click
  // through to View Deal — the initial quote email never includes them.
  // The segment stays untouched in the DB; this only affects what's mapped
  // into the email HTML.
  const emailSegments = (quote.itinerary?.segments ?? []).filter((s) => !s.isExtraLeg);
  // Customer-facing initial quote email — omit the aircraft row entirely
  // rather than showing a placeholder when unknown.
  const segments = toEmailSegments(emailSegments);
  const company = await getCompanyForAccountId(quote.agent.id);
  // Only set for an exchange quote — see Quote.originalQuoteId and
  // buildQuoteEmail's own doc comment on this param.
  const originalItinerarySegments = quote.originalQuote?.itinerary
    ? toEmailSegments(quote.originalQuote.itinerary.segments.filter((s) => !s.isExtraLeg))
    : undefined;

  const { subject, html } = buildQuoteEmail({
    customerFirstName: quote.contact.firstName,
    customerLastName: quote.contact.lastName,
    agentFullName: quote.agent.fullName,
    agent: { fullName: quote.agent.fullName, email: quote.agent.email, phone: quote.agent.phone },
    tripType: (quote.itinerary?.tripType ?? "ONE_WAY").replace("_", " "),
    passengerCount: getPassengerCount(quote),
    segments,
    pricing: {
      adults: quote.adults,
      children: quote.children,
      infants: quote.infants,
      ...pricingSnapshot,
    },
    viewDealUrl,
    trackingPixelUrl,
    company,
    originalItinerarySegments,
  });

  const result = await sendEmail({
    accountId: quote.agent.id,
    to: toEmail,
    subject,
    html,
    senderName: quote.agent.fullName,
    replyTo: quote.agent.email,
  });

  await prisma.emailLog.create({
    data: {
      type: "QUOTE",
      subject,
      fromEmail: quote.agent.email,
      toEmail,
      status: result.ok ? "SENT" : "FAILED",
      errorMessage: result.ok ? undefined : result.error,
      messageId: result.ok ? result.messageId : undefined,
      leadId: quote.leadId,
      quoteId: quote.id,
      contactId: quote.contactId,
    },
  });

  if (!result.ok) {
    return { ok: false as const, error: result.error };
  }

  await transitionQuoteStatus(quoteId, "SENT");

  // Auto-advance the lead to QUOTED now that the quote genuinely reached
  // the customer — only after a successful send, never merely on quote
  // creation. Guarded against regressing an already-BOOKED lead, and never
  // allowed to fail the (already-successful) send: the quote's own SENT
  // status is the authoritative, already-persisted record of what
  // happened even if this best-effort follow-up write fails.
  try {
    const lead = await prisma.lead.findUnique({ where: { id: quote.leadId }, select: { status: true } });
    if (lead && lead.status !== "QUOTED" && lead.status !== "BOOKED") {
      // Uses the unchecked core directly, not the public updateLeadStatus —
      // access to this lead was already established above via the quote's
      // own visibility (quoteVisibilityWhere), which is a different (and for
      // Flight Expert, broader) resource group than leadVisibilityWhere.
      await applyLeadStatusChange(quote.leadId, "QUOTED", actor?.id, "Automatically updated after quote was sent");
    }
  } catch (err) {
    console.error(`Failed to auto-update lead status to QUOTED (lead ${quote.leadId}):`, err);
  }

  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath(`/leads/${quote.leadId}`);
  revalidatePath("/quotes");

  return { ok: true as const };
}

/**
 * Pass 22 fix — this action previously had NO status precondition at all:
 * transitionQuoteStatus's own forward-only rank check deliberately exempts
 * CANCELED for every caller (see quote-status.ts's STATUS_RANK comment),
 * which left cancelQuote() with no floor of its own. The client-side
 * "Cancel Quote" button already tried to hide itself once a quote reached
 * a more specific state (BOOKED, mid-exchange, mid-cancellation-review),
 * but (1) it was missing CHARGED from that list entirely — an already-
 * PAID quote could have its status collapsed straight to CANCELED via
 * this blunt action, bypassing the whole approval/notify Cancellation
 * workflow that exists specifically to handle a paid booking's
 * cancellation correctly — and (2) even for a status the client DID hide
 * the button for, nothing stopped a direct call to this server action
 * from doing it anyway. isQuoteCancelable (src/lib/quote-cancelability.ts)
 * is the one shared definition the client button and this guard both
 * enforce now, so they can't drift apart again.
 */
export async function cancelQuote(quoteId: string) {
  const actor = await getCurrentAccount();
  const existing = await prisma.quote.findFirst({ where: { id: quoteId, ...quoteVisibilityWhere(actor) }, select: { id: true, status: true } });
  if (!existing) throw new Error("Quote not found");
  if (!isQuoteCancelable(existing.status)) {
    throw new Error("This quote can no longer be canceled directly — use the Exchange/Cancellation workflow once it has been booked or charged.");
  }

  await transitionQuoteStatus(quoteId, "CANCELED");
  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/quotes");
}

export async function deleteDraftQuote(quoteId: string) {
  const actor = await getCurrentAccount();
  const quote = await prisma.quote.findFirst({ where: { id: quoteId, ...quoteVisibilityWhere(actor) } });
  if (!quote) throw new Error("Quote not found");
  if (quote.status !== "DRAFT") throw new Error("Only draft quotes can be deleted");
  const leadId = quote.leadId;
  await prisma.quote.delete({ where: { id: quoteId } });
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/quotes");
}

const DELETE_QUOTE_DENIAL = "You are not authorized to delete this quote";

/**
 * Admin only, any quote status — the broader delete capability from the
 * permission matrix, distinct from deleteDraftQuote() above (which any
 * agent can already use, but only while the quote is still an unsent
 * DRAFT). Cascades to the quote's own Booking, if one exists (schema
 * onDelete: Cascade), but never touches the Lead or Contact above it.
 */
export async function deleteQuote(quoteId: string) {
  const actor = await getCurrentAccount();
  if (!actor || actor.status !== "ACTIVE" || !canDeleteQuote(actor.role)) {
    await prisma.auditLog.create({
      data: { actorId: actor?.id, action: "QUOTE_DELETE_DENIED", entityType: "Quote", entityId: quoteId, metadata: { reason: "MISSING_PERMISSION" } },
    });
    throw new Error(DELETE_QUOTE_DENIAL);
  }

  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, ...quoteVisibilityWhere(actor) },
    select: { id: true, quoteNumber: true, leadId: true, booking: { select: { id: true } } },
  });
  if (!quote) {
    await prisma.auditLog.create({
      data: { actorId: actor.id, action: "QUOTE_DELETE_DENIED", entityType: "Quote", entityId: quoteId, metadata: { reason: "NOT_ACCESSIBLE" } },
    });
    throw new Error(DELETE_QUOTE_DENIAL);
  }

  await prisma.quote.delete({ where: { id: quote.id } });

  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      action: "QUOTE_DELETED",
      entityType: "Quote",
      entityId: quote.id,
      metadata: { quoteNumber: quote.quoteNumber, leadId: quote.leadId, cascadedBooking: !!quote.booking },
    },
  });

  revalidatePath("/quotes");
  revalidatePath(`/leads/${quote.leadId}`);
  if (quote.booking) revalidatePath("/bookings");
}
