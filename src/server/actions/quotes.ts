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
import { Prisma } from "@/generated/prisma/client";
import { PRICING_EDITABLE_STATUSES, SENDABLE_QUOTE_STATUSES, QUOTE_SEND_DEDUPE_WINDOW_MS, isQuotePricingEditable, isQuoteSendable } from "@/lib/quote-send-rules";

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

const updatePricingSchema = z
  .object({
    adults: z.number().int().min(1),
    children: z.number().int().min(0),
    infants: z.number().int().min(0),
    adultPrice: z.number().min(0),
    childPrice: z.number().min(0),
    infantPrice: z.number().min(0),
    taxes: z.number().min(0),
    serviceFee: z.number().min(0),
    gratuity: z.number().min(0),
    currency: z.enum(SUPPORTED_CURRENCIES).optional(),
    exchangeRate: z.number().positive().optional(),
    /** ISO timestamp of the quote version the editor loaded. When supplied,
     * the write only applies if nobody has changed the quote since — a stale
     * editor gets a clear error instead of silently overwriting newer data. */
    expectedUpdatedAt: z.string().datetime().optional(),
  })
  .refine((v) => (v.currency ?? "USD") === "USD" || (v.exchangeRate !== undefined && v.exchangeRate > 0), {
    message: "An exchange rate is required for a non-USD currency",
    path: ["exchangeRate"],
  });

export type UpdateQuotePricingInput = z.input<typeof updatePricingSchema>;

/**
 * Edits a quote's pricing — only while it is still an unsent DRAFT (see
 * quote-send-rules.ts for why). The status condition lives INSIDE the write
 * (a single conditional UPDATE), not in a separate read beforehand, so a
 * concurrent send that flips the quote to SENT between "check" and "write"
 * cannot be overwritten: the UPDATE simply matches no row. Optional
 * expectedUpdatedAt adds optimistic concurrency against a second editor.
 */
export async function updateQuotePricing(quoteId: string, patch: UpdateQuotePricingInput) {
  const { expectedUpdatedAt, ...fields } = updatePricingSchema.parse(patch);
  const actor = await getCurrentAccount();
  const existing = await prisma.quote.findFirst({ where: { id: quoteId, ...quoteVisibilityWhere(actor) }, select: { id: true, status: true } });
  if (!existing) throw new Error("Quote not found");
  if (!isQuotePricingEditable(existing.status)) {
    throw new Error("This quote has already been sent, so its pricing can no longer be changed. Create a new quote or use the Exchange workflow.");
  }

  const pricing = calculatePricing(fields);
  const currency = fields.currency ?? "USD";
  const result = await prisma.quote.updateMany({
    where: {
      id: quoteId,
      status: { in: [...PRICING_EDITABLE_STATUSES] },
      ...(expectedUpdatedAt ? { updatedAt: new Date(expectedUpdatedAt) } : {}),
    },
    data: {
      adults: fields.adults,
      children: fields.children,
      infants: fields.infants,
      adultPrice: fields.adultPrice,
      childPrice: fields.childPrice,
      infantPrice: fields.infantPrice,
      taxes: fields.taxes,
      serviceFee: fields.serviceFee,
      gratuity: fields.gratuity,
      currency,
      exchangeRate: currency === "USD" ? null : fields.exchangeRate,
      total: pricing.total,
    },
  });
  if (result.count !== 1) {
    throw new Error("This quote changed while you were editing it (it may have just been sent, or edited elsewhere). Reload it and try again.");
  }
  revalidatePath(`/quotes/${quoteId}`);
  // Plain, serializable summary — Prisma's Decimal fields can't cross the
  // server-action/RSC boundary to a client caller.
  return { id: quoteId, total: pricing.total };
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
  if (!isQuoteSendable(quote.status)) {
    return { ok: false as const, error: "This quote can no longer be sent — the customer has already acted on it, or it was canceled." };
  }

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

  // Server-side idempotency: an identical send of this quote to this address
  // inside the dedupe window (double click, retried request, second tab) is
  // one send. The claim is one atomic INSERT / conditional UPDATE, so two
  // concurrent requests can never both pass it.
  if (!(await claimQuoteSend(quoteId, toEmail))) {
    return { ok: true as const, duplicate: true as const };
  }

  // Narrowed above ("no agent" returned early); a const keeps that narrowing
  // inside the closure below.
  const agent = quote.agent;
  // Once the email has actually gone out the claim must stay, so a retry after
  // a later (post-send) failure cannot email the customer a second time.
  let emailSent = false;
  const deliverQuote = async () => {
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
    const company = await getCompanyForAccountId(agent.id);
    // Only set for an exchange quote — see Quote.originalQuoteId and
    // buildQuoteEmail's own doc comment on this param.
    const originalItinerarySegments = quote.originalQuote?.itinerary
      ? toEmailSegments(quote.originalQuote.itinerary.segments.filter((s) => !s.isExtraLeg))
      : undefined;

    const { subject, html } = buildQuoteEmail({
      customerFirstName: quote.contact.firstName,
      customerLastName: quote.contact.lastName,
      agentFullName: agent.fullName,
      agent: { fullName: agent.fullName, email: agent.email, phone: agent.phone },
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
      accountId: agent.id,
      to: toEmail,
      subject,
      html,
      senderName: agent.fullName,
      replyTo: agent.email,
    });

    emailSent = result.ok;
    await prisma.emailLog.create({
      data: {
        type: "QUOTE",
        subject,
        fromEmail: agent.email,
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
      // Nothing reached the customer — free the claim so the agent can retry
      // immediately instead of waiting out the dedupe window.
      await releaseQuoteSend(quoteId, toEmail);
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
  };

  try {
    // The status AND every pricing input are part of the write's own
    // condition: if the quote was edited or moved on after we read it (so
    // the snapshot we just computed no longer matches what is stored), the
    // UPDATE matches nothing and nothing is emailed.
    const frozen = await prisma.quote.updateMany({
      where: {
        id: quoteId,
        status: { in: [...SENDABLE_QUOTE_STATUSES] },
        currency: quote.currency,
        exchangeRate: quote.exchangeRate,
        adultPrice: quote.adultPrice,
        childPrice: quote.childPrice,
        infantPrice: quote.infantPrice,
        taxes: quote.taxes,
        serviceFee: quote.serviceFee,
        gratuity: quote.gratuity,
        total: quote.total,
      },
      // sentByAgentId is captured only once — the first time a quote is
      // actually sent — and never overwritten by a later resend or
      // reassignment, unlike agentId. See Quote.sentByAgentId's schema doc.
      data: { pricingSnapshot, sentByAgentId: quote.sentByAgentId ?? quote.agentId },
    });
    if (frozen.count !== 1) {
      await releaseQuoteSend(quoteId, toEmail);
      return { ok: false as const, error: "This quote was changed while it was being sent. Nothing was emailed — please review it and send again." };
    }
    return await deliverQuote();
  } catch (err) {
    if (!emailSent) await releaseQuoteSend(quoteId, toEmail);
    throw err;
  }
}

/**
 * Atomically claims the right to send `quoteId` to `recipientEmail`. Returns
 * false when an identical send happened inside QUOTE_SEND_DEDUPE_WINDOW_MS.
 * Insert-or-conditional-update on a (quoteId, recipientEmail) primary key, so
 * concurrent callers race on the database, not on process memory (a
 * serverless deployment runs many instances).
 */
async function claimQuoteSend(quoteId: string, recipientEmail: string): Promise<boolean> {
  const email = recipientEmail.trim().toLowerCase();
  try {
    await prisma.quoteSendClaim.create({ data: { quoteId, recipientEmail: email } });
    return true;
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
  }
  const renewed = await prisma.quoteSendClaim.updateMany({
    where: { quoteId, recipientEmail: email, claimedAt: { lt: new Date(Date.now() - QUOTE_SEND_DEDUPE_WINDOW_MS) } },
    data: { claimedAt: new Date() },
  });
  return renewed.count === 1;
}

/** Best-effort: a failed release only means a retry waits out the window. */
async function releaseQuoteSend(quoteId: string, recipientEmail: string): Promise<void> {
  try {
    await prisma.quoteSendClaim.deleteMany({ where: { quoteId, recipientEmail: recipientEmail.trim().toLowerCase() } });
  } catch {
    // ignored — see above
  }
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
