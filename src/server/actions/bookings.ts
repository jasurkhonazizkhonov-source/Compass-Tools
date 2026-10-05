"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { logActivity } from "@/server/activity-log";
import { sendEmail } from "@/server/email/service";
import { buildBookingConfirmationEmail, buildCancellationConfirmedEmail } from "@/server/email/templates";
import { toEmailSegments } from "@/server/email/segment-mapper";
import { reconcileQuoteStatus } from "@/server/quote-status";
import { getCompanyForAccountId, getCompanyForContactId } from "@/server/queries/company";
import { SEGMENT_SELECT } from "@/server/queries/segment-select";
import { canDeleteBooking, canEnterTicketingInfo, canSendAirlineConfirmation } from "@/lib/permissions";
import { buildRecipientOptions, resolveSelectedRecipients } from "@/server/airline-confirmation-recipients";
import { deriveNotificationDestination } from "@/server/booking-destination";
import { bookingVisibilityWhere } from "@/server/visibility";
import { SUPPORTED_CURRENCIES, buildPricingSnapshot, computeTotalSellingPriceUsd, computeBookingProfitUsd } from "@/lib/currency";
import { sendBookingProfitNotification } from "@/server/booking-notification";
import { airlineConfirmationEntrySchema, resolveAirlineConfirmations, toLegacyBookingFields } from "@/lib/airline-confirmations";
import { resolveAirlineCodes } from "@/server/queries/reference-data";

const DELETE_BOOKING_DENIAL = "You are not authorized to delete this booking";

/**
 * Admin only. Deletes the Booking and everything that only exists to
 * support it (PaymentMethod/PaymentCharge/Passenger/Signature/status
 * history, all onDelete: Cascade from Booking in schema.prisma) — never
 * touches the Quote, Lead, or Contact above it, since Booking sits at the
 * leaf end of that chain.
 */
export async function deleteBooking(bookingId: string) {
  const actor = await getCurrentAccount();
  if (!actor || actor.status !== "ACTIVE" || !canDeleteBooking(actor.role)) {
    await prisma.auditLog.create({
      data: { actorId: actor?.id, action: "BOOKING_DELETE_DENIED", entityType: "Booking", entityId: bookingId, metadata: { reason: "MISSING_PERMISSION" } },
    });
    throw new Error(DELETE_BOOKING_DENIAL);
  }

  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, ...bookingVisibilityWhere(actor) },
    select: { id: true, bookingReference: true, quoteId: true, leadId: true },
  });
  if (!booking) {
    await prisma.auditLog.create({
      data: { actorId: actor.id, action: "BOOKING_DELETE_DENIED", entityType: "Booking", entityId: bookingId, metadata: { reason: "NOT_ACCESSIBLE" } },
    });
    throw new Error(DELETE_BOOKING_DENIAL);
  }

  await prisma.booking.delete({ where: { id: booking.id } });

  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      action: "BOOKING_DELETED",
      entityType: "Booking",
      entityId: booking.id,
      metadata: { bookingReference: booking.bookingReference, quoteId: booking.quoteId, leadId: booking.leadId },
    },
  });

  revalidatePath("/bookings");
  revalidatePath(`/quotes/${booking.quoteId}`);
  revalidatePath(`/leads/${booking.leadId}`);
}

const ticketingSchema = z.object({
  bookingId: z.string(),
  // Internal-only — never appears in any customer-facing surface (see
  // buildBookingConfirmationEmail, which deliberately has no pnr param).
  pnr: z.string().optional(),
  // Pass 23 — the new, authoritative multi-entry shape. `undefined` means
  // "this save didn't touch confirmations at all" (existing value kept
  // as-is); an explicit `[]` means "the agent removed every row" and IS
  // persisted as empty. The legacy airlineConfirmationNumber/ticketNumbers
  // params below are kept only as a fallback for a client that hasn't
  // been updated to send the new shape yet — see the merge logic below.
  airlineConfirmations: z.array(airlineConfirmationEntrySchema).optional(),
  airlineConfirmationNumber: z.string().optional(),
  ticketNumbers: z.array(z.string()).optional(),
  status: z.enum(["PENDING_TICKETING", "TICKETED", "CONFIRMED", "CANCELED"]).optional(),
  // "Ticket Nett Cost" in the UI (the internal expenditure — never the customer's selling price). Pass 34 — real gap found and fixed: unlike
  // exchangeSchema's/requestCancellationSchema's equivalent money fields,
  // these had no `.min(0)`, so a negative Ticket Cost/Tax/Issuing Fee could
  // be submitted and would silently inflate the computed profitAmount (a
  // negative cost reads as extra profit). Matches the same non-negative
  // convention already enforced everywhere else money is entered.
  fareAmount: z.number().min(0).optional(),
  taxAmount: z.number().min(0).optional(),
  // "Issuing Fee" in the UI.
  serviceFeeAmount: z.number().min(0).optional(),
  // Internal-only free text — never customer-facing.
  bookingNotes: z.string().optional(),
  // profitAmount is never trusted from the client — it's always computed
  // server-side (see the profit formula below). Accepted here only so a
  // legacy/manual value passed by an older client doesn't fail parsing;
  // it's simply ignored.
  profitAmount: z.number().optional(),
});

const TICKETING_UPDATE_DENIAL = "You are not authorized to update this booking";

export async function updateBookingTicketing(input: z.infer<typeof ticketingSchema>) {
  const data = ticketingSchema.parse(input);
  const actor = await getCurrentAccount();
  if (!actor || actor.status !== "ACTIVE" || !canEnterTicketingInfo(actor.role)) {
    throw new Error(TICKETING_UPDATE_DENIAL);
  }

  // IDOR/BOLA protection — a valid bookingId alone is not enough; it must
  // also be a booking this account can see under normal row-level scope
  // (same bookingVisibilityWhere() every other booking-detail access goes
  // through — see deleteBooking()/revealBookingIp() for the identical
  // pattern). Previously this looked up ANY booking by raw id with no
  // ownership/visibility check at all.
  const accessible = await prisma.booking.findFirst({
    where: { id: data.bookingId, ...bookingVisibilityWhere(actor) },
    select: { id: true },
  });
  if (!accessible) {
    throw new Error(TICKETING_UPDATE_DENIAL);
  }

  const existing = await prisma.booking.findUniqueOrThrow({
    where: { id: data.bookingId },
    include: {
      contact: true,
      passengers: true,
      // Explicit select — deliberately NOT `include: true` — so
      // `encryptedPan` is never pulled into server memory here; this
      // function only ever needs the masked display fields for the
      // booking-confirmation email. See queries/bookings.ts for the same
      // pattern and payment-methods.ts's revealPaymentMethod() for the one
      // place encryptedPan is legitimately read.
      paymentMethods: {
        select: { id: true, cardBrand: true, last4: true, expiryMonth: true, expiryYear: true, amountAllocated: true },
      },
      quote: {
        include: {
          agent: true,
          // The user who ORIGINALLY sent the quote and obtained the signed
          // booking — commission/profit crediting anchor (Part 16), distinct
          // from `agent` (the quote's current, possibly-since-reassigned
          // owner) and from `actor` (whoever is saving THIS ticketing
          // update, recorded separately for audit — see BOOKING_UPDATED/
          // BOOKING_STATUS_CHANGED activity entries above).
          sentByAgent: { select: { id: true, fullName: true, email: true, location: true, hiredAt: true, commissionPercent: true } },
          itinerary: {
            include: {
              segments: {
                select: SEGMENT_SELECT,
                orderBy: { sequence: "asc" },
              },
            },
          },
        },
      },
    },
  });

  const { bookingId, ...patch } = data;

  // Merged (existing + patch) view of the ticketing-relevant fields — the
  // mandatory-CONFIRMED check and the profit formula both need the FINAL
  // state, not just whatever this particular partial patch happens to
  // include (a booking's PNR may have been saved in an earlier request,
  // then this request merely flips status to CONFIRMED).
  const finalStatus = patch.status ?? existing.status;
  // Pass 23 — the FINAL merged confirmation state now comes from the new
  // multi-entry array, not the single string. When this save didn't send
  // the new array, fall back to resolving from the MERGED legacy fields
  // (this patch's own airlineConfirmationNumber/ticketNumbers if it sent
  // them, else the existing persisted values) — never just `existing`
  // alone, which would ignore a legacy-only client's own patch entirely
  // and incorrectly reject a CONFIRMED save that DID include a
  // confirmation number via the old single-value fields.
  const finalConfirmations =
    patch.airlineConfirmations !== undefined
      ? patch.airlineConfirmations
      : resolveAirlineConfirmations({
          airlineConfirmations: existing.airlineConfirmations,
          airlineConfirmationNumber: patch.airlineConfirmationNumber ?? existing.airlineConfirmationNumber,
          ticketNumbers: patch.ticketNumbers ?? existing.ticketNumbers,
        });
  // Only write the legacy mirror fields when THIS save actually set the
  // new array — an old client (or a save that only touches pnr/notes/
  // status) must never silently wipe previously-saved new-format data by
  // writing `undefined` over it via a stale legacy value.
  const legacyMirror = patch.airlineConfirmations !== undefined ? toLegacyBookingFields(patch.airlineConfirmations) : undefined;
  // Only used for the pre-transaction CONFIRMED-requires-a-fare validation
  // gate below (a UX-level check, not the value actually stored) — see the
  // transaction below for the race-safe, row-locked recomputation that
  // feeds the real stored profitAmount (Pass 32).
  const finalFare = patch.fareAmount ?? (existing.fareAmount ? Number(existing.fareAmount) : undefined);

  // Server-side, not just a UI requirement: a booking may never be saved
  // CONFIRMED without at least one Airline Confirmation Number and Ticket
  // Cost, checked against the FINAL merged state. PNR Information is
  // internal-only and deliberately NOT required to confirm.
  if (finalStatus === "CONFIRMED" && (finalConfirmations.length === 0 || finalFare == null)) {
    throw new Error("At least one Airline Confirmation Number and Ticket Nett Cost are required to confirm a booking");
  }

  // Total Selling Price comes from the quote's own per-passenger USD prices
  // (adults/children/infants) — a separate, much-less-frequently-edited
  // record than the booking's own ticketing fields, so reading it once,
  // pre-transaction, carries none of the race risk described below.
  const totalSellingPrice = computeTotalSellingPriceUsd({
    adults: existing.quote.adults,
    adultPrice: Number(existing.quote.adultPrice),
    children: existing.quote.children,
    childPrice: Number(existing.quote.childPrice),
    infants: existing.quote.infants,
    infantPrice: Number(existing.quote.infantPrice),
  });

  // Pass 23 §34 re-investigation of Pass 22's "free status reversal, even
  // from CONFIRMED" note: Booking.status itself IS freely settable in any
  // direction (no transition matrix below) — deliberately left this way
  // after tracing the actual blast radius, not overlooked. Three
  // independent layers already contain it: (1) reconcileQuoteStatus's
  // Quote-status sync only ever moves the QUOTE forward — writeQuoteStatus
  // (quote-status.ts) rejects any toStatus whose rank is <= the quote's
  // current rank, so reverting a Booking back to TICKETED/PENDING_TICKETING
  // can never regress the customer-facing Quote status (e.g. un-charge a
  // CHARGED quote); (2) every status change is fully audited via
  // BookingStatusHistory (fromStatus/toStatus/changedById/changedAt,
  // visible in the CRM's own Status History panel) — never silent; (3) no
  // customer email or team notification fires automatically from a bare
  // status change — sendAirlineConfirmationEmail/sendNewSaleNotification
  // are separate, manual, idempotent actions gated on the CURRENT status
  // at click time, so a revert-then-reconfirm cycle can't trigger a
  // duplicate customer email or double-count a sale. Given that, blocking
  // the reversal outright would only break a real, common correction
  // workflow (an agent fixing a premature/mistaken CONFIRMED click) without
  // closing any actual gap — no transition-matrix guard was added.
  const statusChanged = !!patch.status && patch.status !== existing.status;

  // Booking update + BookingStatusHistory + the derived Quote-status sync
  // (see reconcileQuoteStatus's doc comment) commit as ONE atomic unit —
  // if the Quote-status write fails for any reason, the whole transaction
  // rolls back, so the Booking's own status change is never left
  // persisted without its corresponding Quote transition (and vice versa).
  // Editing PNR/notes/ticket numbers without changing `status` never
  // touches reconcileQuoteStatus at all, so it can never move the Quote.
  // Only the ATOMIC status write happens inside the transaction —
  // reconcileQuoteStatus's activity-log/notification side effects are
  // deliberately deferred (via fireQuoteStatusSideEffects, called below,
  // after commit) so they never hold this transaction open as extra
  // round-trips (see quote-status.ts's own doc comment for why that
  // matters — it's a real failure mode under real network latency, not
  // just theoretical).
  let fireQuoteStatusSideEffects = async () => {};
  const booking = await prisma.$transaction(async (tx) => {
    // Pass 32 — real (if narrow) financial-correctness race found and
    // fixed: `profitAmount` used to be computed from `existing.fareAmount`/
    // `taxAmount`/`serviceFeeAmount` — a snapshot read at the TOP of this
    // whole function, well before this transaction even opens (Zod
    // parsing, the visibility check, and the earlier findUniqueOrThrow all
    // happen first). If a SECOND concurrent save of this exact same
    // booking's ticketing form (a different agent, or the same agent in
    // two tabs, touching a DIFFERENT field — e.g. one saves fareAmount
    // while the other saves taxAmount) committed in between that early
    // read and this transaction's write, the later-committing save would
    // compute profitAmount from a STALE merge that doesn't reflect the
    // other save's already-committed field — producing a genuinely wrong
    // stored profit until some unrelated future save happens to recompute
    // it. `SELECT ... FOR UPDATE` here takes a real row lock: a second
    // concurrent transaction's own attempt to read this row blocks until
    // this one commits, then sees the true latest values — the same
    // "serialize concurrent writers via a real lock" idiom this codebase
    // already uses elsewhere (see lead-queue.ts's FOR UPDATE SKIP LOCKED),
    // just blocking rather than skipping, since here we want the second
    // writer to wait and recompute correctly, not abandon its own save.
    const locked = await tx.$queryRaw<{ fareAmount: string | null; taxAmount: string | null; serviceFeeAmount: string | null }[]>`
      SELECT "fareAmount", "taxAmount", "serviceFeeAmount" FROM "Booking" WHERE "id" = ${bookingId} FOR UPDATE
    `;
    const lockedRow = locked[0];
    const lockedFare = patch.fareAmount ?? (lockedRow?.fareAmount != null ? Number(lockedRow.fareAmount) : undefined);
    const lockedTax = patch.taxAmount ?? (lockedRow?.taxAmount != null ? Number(lockedRow.taxAmount) : undefined);
    const lockedServiceFee = patch.serviceFeeAmount ?? (lockedRow?.serviceFeeAmount != null ? Number(lockedRow.serviceFeeAmount) : undefined);
    const computedProfit = computeBookingProfitUsd({
      totalSellingPrice,
      fareAmount: lockedFare,
      taxAmount: lockedTax,
      serviceFeeAmount: lockedServiceFee,
    });

    const updated = await tx.booking.update({
      where: { id: bookingId },
      data: {
        pnr: patch.pnr,
        airlineConfirmationNumber: legacyMirror ? legacyMirror.airlineConfirmationNumber : patch.airlineConfirmationNumber,
        ticketNumbers: legacyMirror ? legacyMirror.ticketNumbers : patch.ticketNumbers,
        airlineConfirmations: patch.airlineConfirmations,
        status: patch.status,
        fareAmount: patch.fareAmount,
        taxAmount: patch.taxAmount,
        serviceFeeAmount: patch.serviceFeeAmount,
        internalNotes: patch.bookingNotes,
        profitAmount: computedProfit,
      },
    });

    if (statusChanged) {
      await tx.bookingStatusHistory.create({
        data: { bookingId, fromStatus: existing.status, toStatus: patch.status!, changedById: actor?.id },
      });
      const result = await reconcileQuoteStatus(bookingId, tx);
      fireQuoteStatusSideEffects = result.fireSideEffects;
    }

    return updated;
  });
  await fireQuoteStatusSideEffects();

  if (statusChanged) {
    await logActivity({
      bookingId,
      leadId: existing.leadId,
      contactId: existing.contactId,
      actorId: actor?.id,
      type: "BOOKING_STATUS_CHANGED",
      description: `Booking status changed from ${existing.status} to ${patch.status}`,
    });

    // Part 16/17 — the customer-facing "airline confirmation" email no
    // longer sends automatically here on a TICKETED/CONFIRMED save; it's
    // now a separate, explicit action a staff member triggers on demand
    // (see sendAirlineConfirmationEmail below) so ticketing information can
    // be saved/corrected freely without re-notifying the customer on every
    // save. The Booking/Quote status automation above is unaffected.
    //
    // The internal "new sale / profit" notification is likewise no longer
    // sent automatically on the TICKETED->CONFIRMED transition — it's now
    // triggered on demand by the "Notify Team of New Sale" button (see
    // sendNewSaleNotification below), same reasoning: a Ticketing Agent may
    // need to save/correct Ticket Cost/Taxes/Issuing Fee more than once
    // before the figures are final, and re-saving CONFIRMED should never
    // by itself imply "send the team announcement again."
  } else {
    await logActivity({
      bookingId,
      leadId: existing.leadId,
      contactId: existing.contactId,
      actorId: actor?.id,
      type: "BOOKING_UPDATED",
      description: "Booking ticketing details updated",
    });
  }

  revalidatePath(`/bookings/${bookingId}`);
  revalidatePath("/bookings");
  revalidatePath(`/leads/${existing.leadId}`);
  // Return a plain, serializable summary — the raw Prisma row carries
  // Decimal instances, which the server-action/RSC boundary can't pass
  // through to the client caller.
  return { id: booking.id, status: booking.status };
}

/**
 * Audit trail for the customer / team email actions on a booking: who did it, to which booking, and the outcome. Metadata
 * holds ids, counts and fixed reason codes only — never an email address, the message, a card or any customer detail.
 * Best effort by design: the email has already been decided/sent, so a failure to write this row is logged and must never
 * turn a successful send into an error (the EmailLog and Activity rows are written separately and unconditionally).
 */
async function auditBookingEmailAction(params: { actorId: string | undefined; action: string; bookingId: string; metadata: Record<string, string | number | boolean | null> }) {
  try {
    await prisma.auditLog.create({
      data: { actorId: params.actorId, action: params.action, entityType: "Booking", entityId: params.bookingId, metadata: params.metadata },
    });
  } catch {
    console.error(`[audit] could not record ${params.action}`);
  }
}

const SEND_AIRLINE_CONFIRMATION_DENIAL = "You are not authorized to send this confirmation";

/**
 * Role + active session + row-level access to THIS booking, in one place, shared by the recipient
 * lookup and the send. Anything that fails here is a genuine authorization denial (a forged call,
 * or a booking the viewer cannot open), so it THROWS the one generic message — the UI never reaches
 * it for a booking the viewer can see. Actionable problems (nothing to send yet, no address
 * selected, Gmail rejected it) are RETURNED instead: in production a thrown server-action error
 * reaches the browser as the opaque "Minified React error #441", which is exactly what Travel
 * Agents used to see here.
 *
 * Every role with the Quotes area may use this (see canSendAirlineConfirmation); which bookings
 * each can reach is bookingVisibilityWhere's job — own quotes for a Travel Agent, the team's for a
 * Manager, everything for Admin / Ticketing Agent / Flight Expert.
 */
async function authorizeAirlineConfirmation(bookingId: string) {
  const actor = await getCurrentAccount();
  if (!actor || actor.status !== "ACTIVE" || !canSendAirlineConfirmation(actor.role)) {
    await auditBookingEmailAction({ actorId: actor?.id, action: "AIRLINE_CONFIRMATION_DENIED", bookingId, metadata: { reason: "ROLE_OR_SESSION" } });
    throw new Error(SEND_AIRLINE_CONFIRMATION_DENIAL);
  }
  const accessible = await prisma.booking.findFirst({
    where: { id: bookingId, ...bookingVisibilityWhere(actor) },
    select: { id: true },
  });
  if (!accessible) {
    await auditBookingEmailAction({ actorId: actor.id, action: "AIRLINE_CONFIRMATION_DENIED", bookingId, metadata: { reason: "NOT_ACCESSIBLE" } });
    throw new Error(SEND_AIRLINE_CONFIRMATION_DENIAL);
  }
  return actor;
}

/**
 * The customer addresses the Send / Resend dialog offers for a booking: the email on the signed
 * Booking Form plus every address stored on the Contact, deduplicated (see
 * airline-confirmation-recipients.ts). Derived from the database on every call — the browser
 * supplies nothing but the booking id — and never includes a CRM user's address.
 */
export async function getAirlineConfirmationRecipients(bookingId: string) {
  await authorizeAirlineConfirmation(bookingId);
  const booking = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    select: {
      contactEmail: true,
      airlineConfirmationFirstSentAt: true,
      contact: { select: { primaryEmail: true, emails: { select: { email: true, isPrimary: true } } } },
      quote: { select: { sentByAgent: { select: { fullName: true, email: true } } } },
    },
  });
  const { options, defaultSelected } = buildRecipientOptions({
    bookingFormEmail: booking.contactEmail,
    contactPrimaryEmail: booking.contact.primaryEmail,
    contactEmails: booking.contact.emails,
  });
  return {
    ok: true as const,
    recipients: options,
    defaultSelected,
    hasSentBefore: booking.airlineConfirmationFirstSentAt != null,
    // The mailbox the email will come FROM — the quote's creator, never the person clicking.
    sender: booking.quote.sentByAgent ? { fullName: booking.quote.sentByAgent.fullName, email: booking.quote.sentByAgent.email } : null,
  };
}

export type SendAirlineConfirmationResult = { ok: true; sentTo: string[] } | { ok: false; error: string };

/**
 * Part 16/17 — manually sends the customer-facing "airline confirmation"
 * email (flight itinerary, airline, flight number, airline confirmation
 * number) from the Quote or Booking page. No longer fires automatically from
 * updateBookingTicketing. Re-fetches the booking fresh rather than reusing a
 * `patch`/`existing` merge, since this runs independently of any save.
 *
 * COMPLETELY SEPARATE from "Notify Team of a New Sale" (booking-notification.ts): this is a
 * customer email. It is addressed ONLY to the customer addresses the user selected — each
 * validated server-side against the booking's own verified addresses — with NO Cc and NO Bcc: no
 * Manager, no Admin, no CRM user is ever copied. The sender is always the quote's own creator
 * (quote.sentByAgent), derived from the database; if their Gmail is not connected the send fails
 * with a clear message rather than quietly going out under someone else's name.
 *
 * Returns `{ ok: false, error }` for every actionable refusal or failure (never thrown — see
 * authorizeAirlineConfirmation); only an authorization denial throws.
 */
export async function sendAirlineConfirmationEmail(
  bookingId: string,
  options?: { resend?: boolean; recipients?: string[] }
): Promise<SendAirlineConfirmationResult> {
  const actor = await authorizeAirlineConfirmation(bookingId);

  const existing = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      contact: { include: { emails: { select: { email: true, isPrimary: true } } } },
      passengers: true,
      paymentMethods: {
        select: { id: true, cardBrand: true, last4: true, expiryMonth: true, expiryYear: true, amountAllocated: true },
      },
      quote: {
        include: {
          agent: true,
          sentByAgent: { select: { id: true, fullName: true, email: true, location: true, hiredAt: true, commissionPercent: true } },
          itinerary: {
            include: {
              segments: {
                select: SEGMENT_SELECT,
                orderBy: { sequence: "asc" },
              },
            },
          },
        },
      },
    },
  });

  const confirmationEntries = resolveAirlineConfirmations(existing);
  if (!(existing.status === "TICKETED" || existing.status === "CONFIRMED") || confirmationEntries.length === 0) {
    return { ok: false, error: "Save the booking as Ticketed or Confirmed with an Airline Confirmation Number before sending this email" };
  }

  // Who it goes to: ONLY addresses chosen from this booking's own verified customer addresses. A
  // caller that names none (an older call site) gets the documented default — the signed Booking
  // Form address — while a caller that names an empty or foreign list is refused, never defaulted.
  const { options: recipientOptions, defaultSelected } = buildRecipientOptions({
    bookingFormEmail: existing.contactEmail,
    contactPrimaryEmail: existing.contact.primaryEmail,
    contactEmails: existing.contact.emails,
  });
  if (recipientOptions.length === 0) {
    return { ok: false, error: "This booking has no customer email on file" };
  }
  const selection = resolveSelectedRecipients(options?.recipients ?? defaultSelected, recipientOptions);
  if (!selection.ok) {
    return { ok: false, error: selection.error };
  }
  const recipients = selection.recipients;
  const toAddress = recipients.join(", ");


  const quote = existing.quote;
  const segments = toEmailSegments(quote.itinerary?.segments ?? []);
  const succeededPaymentMethodIds = existing.paymentMethods.length
    ? new Set(
        (
          await prisma.paymentCharge.findMany({
            where: { paymentMethodId: { in: existing.paymentMethods.map((pm) => pm.id) }, status: "SUCCEEDED" },
            select: { paymentMethodId: true },
          })
        ).map((c) => c.paymentMethodId)
      )
    : new Set<string>();
  const paymentPaid = existing.paymentMethods.length > 0 && existing.paymentMethods.every((pm) => succeededPaymentMethodIds.has(pm.id));
  const company = quote.agent ? await getCompanyForAccountId(quote.agent.id) : await getCompanyForContactId(existing.contactId);

  const confirmationCurrency = quote.currency as (typeof SUPPORTED_CURRENCIES)[number];
  const confirmationPricing = buildPricingSnapshot(
    {
      adultPrice: Number(quote.adultPrice),
      childPrice: Number(quote.childPrice),
      infantPrice: Number(quote.infantPrice),
      taxes: Number(quote.taxes),
      serviceFee: Number(quote.serviceFee),
      gratuity: Number(existing.gratuityAmount),
      total: Number(existing.totalAmount),
    },
    confirmationCurrency,
    quote.exchangeRate ? Number(quote.exchangeRate) : 1
  );

  // Resolve each entry's optional airline via the same canonical,
  // DB-backed lookup every other airline display in this app already
  // goes through (never a second/duplicate resolution scheme) — a code
  // with no match (retired/typo'd/unrecognized) resolves to null, which
  // the email builder already renders as "no airline name" rather than
  // inventing one.
  const airlineIatas = confirmationEntries.map((c) => c.airlineIata).filter((v): v is string => !!v);
  const resolvedAirlines = airlineIatas.length ? await resolveAirlineCodes(airlineIatas) : {};
  const emailConfirmations = confirmationEntries.map((c) => ({
    id: c.id,
    airlineName: (c.airlineIata && resolvedAirlines[c.airlineIata]?.name) || null,
    confirmationNumber: c.confirmationNumber,
    eTicketNumbers: c.eTicketNumbers,
  }));

  const { subject, html } = buildBookingConfirmationEmail({
    customerFirstName: existing.contact.firstName,
    agent: quote.agent ? { fullName: quote.agent.fullName, email: quote.agent.email, phone: quote.agent.phone } : undefined,
    bookingReference: existing.bookingReference,
    segments,
    pricing: {
      adults: quote.adults,
      children: quote.children,
      infants: quote.infants,
      ...confirmationPricing,
    },
    paymentMethods: existing.paymentMethods.map((pm) => ({
      cardBrand: pm.cardBrand,
      last4: pm.last4,
      expiryMonth: pm.expiryMonth,
      expiryYear: pm.expiryYear,
      amountAllocated: Number(pm.amountAllocated),
    })),
    paymentPaid,
    passengers: existing.passengers.map((p) => ({
      firstName: p.firstName,
      middleName: p.middleName,
      lastName: p.lastName,
      dateOfBirth: p.dateOfBirth,
      type: p.type,
    })),
    contactName: `${existing.contact.firstName} ${existing.contact.lastName}`,
    contactEmail: existing.contactEmail,
    contactPhone: existing.contactPhone,
    confirmations: emailConfirmations,
    company,
    // §11 — only set when this booking's own quote IS an exchange
    // (Quote.originalQuoteId non-null) AND both figures were actually
    // entered by the agent — an exchange quote with the fee/difference not
    // yet filled in falls back to the ordinary "Booking Confirmed" heading
    // rather than showing a half-empty Exchange Summary block.
    exchange:
      quote.originalQuoteId && quote.exchangeFee != null && quote.fareDifference != null
        ? { exchangeFee: Number(quote.exchangeFee), fareDifference: Number(quote.fareDifference), currency: confirmationCurrency }
        : undefined,
  });

  // Claim / recency guard comes AFTER the (side-effect-free) email build above, so an unexpected
  // failure while building can never leave a first-send claim behind.
  // Pass 23 §21-23 — first-send vs. resend, deliberately NOT a copy of
  // cancellation.ts's one-way-status claim (that pattern fits a status
  // that only ever moves forward once; Booking.status here stays
  // TICKETED/CONFIRMED across any number of legitimate resends, so there
  // is no status transition to claim against). Instead: the FIRST send is
  // protected by a genuine atomic claim (conditional updateMany, same
  // idiom as Lead.queueDistributedAt/SequenceEnrollment.nextSendAt) so two
  // near-simultaneous first clicks — a real double-click, or two agents
  // both hitting Send — can never both succeed; only one wins the claim
  // and proceeds, the other fails cleanly and can retry as a resend.
  // Explicit resends (options.resend, the UI's separate "Resend
  // Confirmation" action once a first send has already happened) skip
  // this claim entirely — resending is a real, intended workflow (a
  // corrected confirmation number, a customer asking again) — and are
  // instead guarded only by a short recency check against the last SENT
  // log, catching an accidental rapid double-click on Resend itself
  // without blocking a deliberate later resend.
  let claimedFirstSend = false;
  if (!options?.resend) {
    const claim = await prisma.booking.updateMany({
      where: { id: bookingId, airlineConfirmationFirstSentAt: null },
      data: { airlineConfirmationFirstSentAt: new Date() },
    });
    if (claim.count === 0) {
      return { ok: false, error: "A confirmation has already been sent for this booking. Use Resend Confirmation to send it again." };
    }
    claimedFirstSend = true;
  } else {
    const recentSend = await prisma.emailLog.findFirst({
      where: { bookingId, type: "BOOKING_CONFIRMATION", status: "SENT", createdAt: { gte: new Date(Date.now() - 60_000) } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (recentSend) {
      return { ok: false, error: "A confirmation email was just sent for this booking. Wait a minute before sending another." };
    }
  }
  // A first send that does not actually go out must give its claim back — otherwise the Send
  // button would be stuck on "already been sent" for an email the customer never received.
  const releaseFirstSendClaim = async () => {
    if (!claimedFirstSend) return;
    try {
      await prisma.booking.updateMany({ where: { id: bookingId }, data: { airlineConfirmationFirstSentAt: null } });
    } catch {
      // Best effort — the caller is already returning the original failure.
    }
  };

  // Sent FROM the quote's own original sender — the agent who actually
  // created the itinerary and sent the quote to the customer, never the
  // clicking user's own identity merely because they pressed this button
  // (matches sendEmail's "fails closed, never a fallback sender" contract).
  // TO is exactly the customer addresses the user selected; there is deliberately NO bcc and NO
  // cc here — this is not the internal team announcement, and no CRM user is ever copied.
  const sender = quote.sentByAgent;
  let result: Awaited<ReturnType<typeof sendEmail>>;
  if (!sender) {
    result = { ok: false, error: "This quote has no original sender to send it from." };
  } else {
    try {
      result = await sendEmail({
        accountId: sender.id,
        to: toAddress,
        subject,
        html,
        senderName: sender.fullName,
        replyTo: sender.email,
      });
    } catch {
      result = { ok: false, error: "The email could not be sent. Please try again." };
    }
  }

  await prisma.emailLog.create({
    data: {
      type: "BOOKING_CONFIRMATION",
      subject,
      fromEmail: sender?.email ?? "unassigned",
      toEmail: toAddress,
      status: result.ok ? "SENT" : "FAILED",
      errorMessage: result.ok ? undefined : result.error,
      messageId: result.ok ? result.messageId : undefined,
      leadId: existing.leadId,
      bookingId,
      contactId: existing.contactId,
    },
  });

  if (!result.ok) await releaseFirstSendClaim();

  await auditBookingEmailAction({
    actorId: actor.id,
    action: result.ok ? "AIRLINE_CONFIRMATION_SENT" : "AIRLINE_CONFIRMATION_FAILED",
    bookingId,
    metadata: {
      resend: !!options?.resend,
      recipientCount: recipients.length,
      // the quote's creator: the account the email was sent as (not necessarily the one who clicked)
      sentAsAccountId: sender?.id ?? null,
      result: result.ok ? "SENT" : "FAILED",
      ...(result.ok ? {} : { reason: result.error }),
    },
  });

  await logActivity({
    bookingId,
    leadId: existing.leadId,
    contactId: existing.contactId,
    actorId: actor.id,
    type: "BOOKING_UPDATED",
    description: result.ok
      ? `Airline confirmation email ${options?.resend ? "resent" : "sent"} to customer (${recipients.length} recipient${recipients.length === 1 ? "" : "s"})`
      : "Airline confirmation email failed to send",
  });

  revalidatePath(`/bookings/${bookingId}`);
  revalidatePath(`/quotes/${quote.id}`);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, sentTo: recipients };
}

const SEND_CANCELLATION_CONFIRMATION_DENIAL = "You are not authorized to send this confirmation";

/**
 * Cancellation workflow, the final ticketing-area action (Part 14) — the
 * customer already confirmed via their own "Confirm Cancellation" click
 * (Quote.status === CANCELLATION_SUBMITTED); this is the authorized-user
 * action that confirms the segment(s) have ACTUALLY been cancelled (e.g.
 * with the airline) and sends the true final confirmation email. Mirrors
 * sendAirlineConfirmationEmail's exact structure (same auth gate, same
 * bookingVisibilityWhere scoping, same fresh-refetch-rather-than-trust-
 * client-state pattern) but gates on the QUOTE's cancellation status
 * instead of the booking's own ticketing status — a genuinely different
 * completion signal for a genuinely different kind of confirmation.
 */
export async function sendCancellationConfirmationEmail(bookingId: string) {
  const actor = await getCurrentAccount();
  if (!actor || actor.status !== "ACTIVE" || !canEnterTicketingInfo(actor.role)) {
    throw new Error(SEND_CANCELLATION_CONFIRMATION_DENIAL);
  }

  const accessible = await prisma.booking.findFirst({
    where: { id: bookingId, ...bookingVisibilityWhere(actor) },
    select: { id: true },
  });
  if (!accessible) {
    throw new Error(SEND_CANCELLATION_CONFIRMATION_DENIAL);
  }

  const existing = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      contact: true,
      quote: {
        include: {
          agent: true,
          itinerary: { include: { segments: { select: SEGMENT_SELECT, orderBy: { sequence: "asc" } } } },
          cancellationRequests: { where: { status: "CONFIRMED" }, orderBy: { reviewedAt: "desc" }, take: 1 },
        },
      },
    },
  });

  // Pass 22 fix — CONFIRMED customer-facing duplicate-send bug: this used
  // to be a plain read-only status check here, with the email sent
  // BEFORE any status transition — two near-simultaneous calls (a
  // double-click, or two ticketing agents both clicking "Send
  // Confirmation") could both pass this check before either write
  // landed, so both would send the customer their final "cancellation
  // confirmed" email. The atomic claim below closes that: only the FIRST
  // caller's updateMany can still match `status: "CANCELLATION_SUBMITTED"`,
  // so only it proceeds. Unlike sendCancellationForm's equivalent fix,
  // this action has no separate "resend" counterpart, so a failed send
  // explicitly REVERTS the claim back to CANCELLATION_SUBMITTED (see the
  // `!result.ok` branch below) — preserving the existing "just click Send
  // again after a failure" recovery path exactly as it worked before.
  const claim = await prisma.quote.updateMany({
    where: { id: existing.quote.id, status: "CANCELLATION_SUBMITTED" },
    data: { status: "CANCELLATION_CONFIRMED", lastActivityAt: new Date() },
  });
  if (claim.count === 0) {
    throw new Error("The customer must confirm the cancellation before you can send the final confirmation.");
  }
  const confirmedRequest = existing.quote.cancellationRequests[0];
  if (!confirmedRequest) {
    throw new Error("No approved cancellation request was found for this booking's quote.");
  }
  if (!existing.contactEmail) {
    throw new Error("This booking has no customer email on file");
  }

  const quote = existing.quote;
  const segments = toEmailSegments(quote.itinerary?.segments ?? []);
  const cancelledSet = new Set(confirmedRequest.segmentIds);
  const company = quote.agent ? await getCompanyForAccountId(quote.agent.id) : await getCompanyForContactId(existing.contactId);

  const { subject, html } = buildCancellationConfirmedEmail({
    customerFirstName: existing.contact.firstName,
    agentFullName: quote.agent?.fullName ?? "Your travel agent",
    agent: quote.agent ? { fullName: quote.agent.fullName, email: quote.agent.email, phone: quote.agent.phone } : undefined,
    segments,
    cancelledSegmentIds: cancelledSet,
    company,
  });

  const result = quote.agent
    ? await sendEmail({ accountId: quote.agent.id, to: existing.contactEmail, subject, html, senderName: quote.agent.fullName, replyTo: quote.agent.email })
    : { ok: false as const, error: "This quote has no agent to send the confirmation from." };

  await prisma.emailLog.create({
    data: {
      type: "BOOKING_NOTIFICATION",
      subject,
      fromEmail: quote.agent?.email ?? "unassigned",
      toEmail: existing.contactEmail,
      status: result.ok ? "SENT" : "FAILED",
      errorMessage: result.ok ? undefined : result.error,
      leadId: existing.leadId,
      quoteId: quote.id,
      bookingId,
      contactId: existing.contactId,
    },
  });

  if (!result.ok) {
    // Revert the claim made above — the send failed, so this must go back
    // to CANCELLATION_SUBMITTED exactly as before this pass's fix, so a
    // plain retry (clicking Send again) works normally. Never left at
    // CANCELLATION_CONFIRMED with no email actually sent.
    await prisma.quote.update({ where: { id: quote.id }, data: { status: "CANCELLATION_SUBMITTED" } });
    await logActivity({
      bookingId,
      leadId: existing.leadId,
      contactId: existing.contactId,
      actorId: actor.id,
      type: "BOOKING_UPDATED",
      description: "Cancellation confirmation email failed to send",
    });
    revalidatePath(`/bookings/${bookingId}`);
    throw new Error(result.error);
  }

  // The status transition itself already happened atomically in the claim
  // above (before the send) — only the audit trail entry remains here.
  await prisma.quoteStatusHistory.create({
    data: { quoteId: quote.id, fromStatus: "CANCELLATION_SUBMITTED", toStatus: "CANCELLATION_CONFIRMED", changedById: actor.id },
  });

  await logActivity({
    bookingId,
    leadId: existing.leadId,
    contactId: existing.contactId,
    actorId: actor.id,
    type: "BOOKING_UPDATED",
    description: "Cancellation confirmation email sent to customer — segment(s) confirmed cancelled",
  });

  revalidatePath(`/bookings/${bookingId}`);
  revalidatePath(`/quotes/${quote.id}`);
  return { ok: true as const };
}

const SEND_NEW_SALE_DENIAL = "You are not authorized to send this notification";

/**
 * On-demand "internal new-sale announcement" — same reasoning and shape as
 * sendAirlineConfirmationEmail above (re-fetches the booking fresh rather
 * than trusting whatever the caller's in-memory form state happens to be,
 * same visibility/role gate, same guard against acting on stale/unsaved
 * figures). Replaces the old behavior where this fired automatically the
 * moment ticketing was saved as CONFIRMED — see updateBookingTicketing's
 * own comment for why that was too eager (a Ticketing Agent correcting
 * Ticket Cost/Taxes/Issuing Fee after the first CONFIRMED save would
 * otherwise never get a chance to fix the figures before the team-wide
 * announcement already went out with the wrong profit).
 *
 * sendBookingProfitNotification (booking-notification.ts) is itself
 * idempotent (no-ops if a BOOKING_PROFIT_NOTIFICATION was already recorded
 * SENT for this booking) and already tries every eligible connected-Gmail
 * sender in turn rather than giving up on the first expired/revoked
 * connection — both properties are reused unchanged here, not
 * reimplemented.
 */
export async function sendNewSaleNotification(bookingId: string) {
  const actor = await getCurrentAccount();
  if (!actor || actor.status !== "ACTIVE" || !canEnterTicketingInfo(actor.role)) {
    await auditBookingEmailAction({ actorId: actor?.id, action: "NEW_SALE_NOTIFICATION_DENIED", bookingId, metadata: { kind: "NEW_SALE", reason: "ROLE_OR_SESSION" } });
    throw new Error(SEND_NEW_SALE_DENIAL);
  }

  const accessible = await prisma.booking.findFirst({
    where: { id: bookingId, ...bookingVisibilityWhere(actor) },
    select: { id: true },
  });
  if (!accessible) {
    await auditBookingEmailAction({ actorId: actor.id, action: "NEW_SALE_NOTIFICATION_DENIED", bookingId, metadata: { kind: "NEW_SALE", reason: "NOT_ACCESSIBLE" } });
    throw new Error(SEND_NEW_SALE_DENIAL);
  }

  const existing = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      passengers: { select: { id: true } },
      quote: {
        include: {
          sentByAgent: { select: { id: true, fullName: true, email: true, location: true, hiredAt: true, role: true } },
          itinerary: {
            include: {
              segments: {
                select: SEGMENT_SELECT,
                orderBy: { sequence: "asc" },
              },
            },
          },
        },
      },
    },
  });

  if (existing.status !== "CONFIRMED") {
    throw new Error("Save the booking as Confirmed before sending the new-sale notification");
  }
  if (existing.fareAmount == null) {
    throw new Error("Ticket Nett Cost is required before sending the new-sale notification");
  }

  const quote = existing.quote;
  const totalSellingPrice = computeTotalSellingPriceUsd({
    adults: quote.adults,
    adultPrice: Number(quote.adultPrice),
    children: quote.children,
    childPrice: Number(quote.childPrice),
    infants: quote.infants,
    infantPrice: Number(quote.infantPrice),
  });
  const fareAmount = Number(existing.fareAmount);
  const taxAmount = existing.taxAmount != null ? Number(existing.taxAmount) : 0;
  const serviceFeeAmount = existing.serviceFeeAmount != null ? Number(existing.serviceFeeAmount) : 0;
  const profit = computeBookingProfitUsd({ totalSellingPrice, fareAmount, taxAmount, serviceFeeAmount });
  if (profit == null) {
    throw new Error("Profit could not be calculated for this booking");
  }

  const finalSegments = quote.itinerary?.segments ?? [];
  const destination = deriveNotificationDestination(finalSegments);

  // Pass 13 §8/§15 — the one real reliability fix: this now actually
  // CHECKS the outcome rather than assuming success merely because
  // sendBookingProfitNotification didn't throw. Previously a silent
  // failure (e.g. no recipient had a connected Gmail account) was still
  // logged to EmailLog as FAILED, but the ticketing agent who clicked
  // "Notify Team of New Sale" always saw a success toast regardless — the
  // exact "sometimes it sends and sometimes it doesn't [without anyone
  // knowing]" bug this pass was asked to fix. `alreadySent` is NOT a
  // failure (a retry/page-refresh after a real prior success must stay
  // silent-safe, matching the idempotency requirement).
  const outcome = await sendBookingProfitNotification({
    bookingId,
    bookingReference: existing.bookingReference,
    quoteId: quote.id,
    leadId: existing.leadId,
    contactId: existing.contactId,
    companyId: actor.companyId,
    agent: quote.sentByAgent
      ? { id: quote.sentByAgent.id, email: quote.sentByAgent.email, fullName: quote.sentByAgent.fullName, location: quote.sentByAgent.location, hiredAt: quote.sentByAgent.hiredAt, role: quote.sentByAgent.role }
      : null,
    profit,
    destination,
    // Always USD — ticketBookingCost/sellingCost/profit are all internal
    // USD figures regardless of what currency the customer was quoted in
    // (see computeBookingProfitUsd's own doc comment in currency.ts).
    currency: "USD",
    passengerCount: existing.passengers.length,
    ticketBookingCost: fareAmount + taxAmount + serviceFeeAmount,
    sellingCost: totalSellingPrice,
    segments: toEmailSegments(finalSegments.filter((s) => !s.isExtraLeg)),
    isExchange: quote.originalQuoteId != null,
  });
  await auditBookingEmailAction({
    actorId: actor.id,
    action: outcome.ok ? "NEW_SALE_NOTIFICATION_SENT" : "NEW_SALE_NOTIFICATION_FAILED",
    bookingId,
    metadata: { kind: "NEW_SALE", result: outcome.ok ? (outcome.alreadySent ? "ALREADY_SENT" : "SENT") : "FAILED", ...(outcome.ok ? {} : { reason: outcome.error ?? "UNKNOWN" }) },
  });
  if (!outcome.ok) {
    throw new Error(outcome.error ?? "Failed to notify the team — please try again or check Gmail connections.");
  }
  // A retry that found it was already sent (idempotent no-op) shouldn't add
  // a second, misleading "notification sent" entry to Activity History.
  if (!outcome.alreadySent) {
    await logActivity({
      bookingId,
      leadId: existing.leadId,
      contactId: existing.contactId,
      actorId: actor.id,
      type: "BOOKING_UPDATED",
      description: "New-sale notification sent to the team",
    });
  }

  revalidatePath(`/bookings/${bookingId}`);
}

/**
 * Part 16 — the Cancellation counterpart to sendNewSaleNotification above:
 * same deliberate, manual, non-automatic pattern (nothing about this fires
 * on its own), same role gate, same "must be the persisted state, not
 * whatever's currently typed" guard, same underlying
 * sendBookingProfitNotification infrastructure (idempotent, tries every
 * connected Gmail sender in turn) — only the trigger condition and the
 * `transactionLabel` passed through differ, so the subject/body correctly
 * read "[Cancellation]" / "Cancellation Confirmed" instead of a plain new
 * sale.
 *
 * Deliberately reports the SAME profit figure the booking already earned at
 * sale time (Ticket Cost/Taxes/Issuing Fee vs. selling price, unchanged by
 * the cancellation) — this pass does not invent any separate
 * cancellation-profit formula (QuoteCancellationRequest.cancellationFee
 * still does not net against this figure anywhere; see this task's own
 * final report for why that remains an open business-policy decision, not
 * a code gap).
 */
export async function sendCancellationNotification(bookingId: string) {
  const actor = await getCurrentAccount();
  if (!actor || actor.status !== "ACTIVE" || !canEnterTicketingInfo(actor.role)) {
    await auditBookingEmailAction({ actorId: actor?.id, action: "CANCELLATION_NOTIFICATION_DENIED", bookingId, metadata: { kind: "CANCELLATION", reason: "ROLE_OR_SESSION" } });
    throw new Error(SEND_NEW_SALE_DENIAL);
  }

  const accessible = await prisma.booking.findFirst({
    where: { id: bookingId, ...bookingVisibilityWhere(actor) },
    select: { id: true },
  });
  if (!accessible) {
    await auditBookingEmailAction({ actorId: actor.id, action: "CANCELLATION_NOTIFICATION_DENIED", bookingId, metadata: { kind: "CANCELLATION", reason: "NOT_ACCESSIBLE" } });
    throw new Error(SEND_NEW_SALE_DENIAL);
  }

  const existing = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      passengers: { select: { id: true } },
      quote: {
        include: {
          sentByAgent: { select: { id: true, fullName: true, email: true, location: true, hiredAt: true, role: true } },
          itinerary: {
            include: {
              segments: {
                select: SEGMENT_SELECT,
                orderBy: { sequence: "asc" },
              },
            },
          },
        },
      },
    },
  });

  if (existing.quote.status !== "CANCELLATION_CONFIRMED") {
    throw new Error("The cancellation must be confirmed (final) before notifying the team");
  }
  if (existing.fareAmount == null) {
    throw new Error("Ticket Nett Cost is required before sending the cancellation notification");
  }

  const quote = existing.quote;
  const totalSellingPrice = computeTotalSellingPriceUsd({
    adults: quote.adults,
    adultPrice: Number(quote.adultPrice),
    children: quote.children,
    childPrice: Number(quote.childPrice),
    infants: quote.infants,
    infantPrice: Number(quote.infantPrice),
  });
  const fareAmount = Number(existing.fareAmount);
  const taxAmount = existing.taxAmount != null ? Number(existing.taxAmount) : 0;
  const serviceFeeAmount = existing.serviceFeeAmount != null ? Number(existing.serviceFeeAmount) : 0;
  const profit = computeBookingProfitUsd({ totalSellingPrice, fareAmount, taxAmount, serviceFeeAmount });
  if (profit == null) {
    throw new Error("Profit could not be calculated for this booking");
  }

  const finalSegments = quote.itinerary?.segments ?? [];
  const destination = deriveNotificationDestination(finalSegments);

  const outcome = await sendBookingProfitNotification({
    bookingId,
    bookingReference: existing.bookingReference,
    quoteId: quote.id,
    leadId: existing.leadId,
    contactId: existing.contactId,
    companyId: actor.companyId,
    agent: quote.sentByAgent
      ? { id: quote.sentByAgent.id, email: quote.sentByAgent.email, fullName: quote.sentByAgent.fullName, location: quote.sentByAgent.location, hiredAt: quote.sentByAgent.hiredAt, role: quote.sentByAgent.role }
      : null,
    profit,
    destination,
    currency: "USD",
    passengerCount: existing.passengers.length,
    ticketBookingCost: fareAmount + taxAmount + serviceFeeAmount,
    sellingCost: totalSellingPrice,
    segments: toEmailSegments(finalSegments.filter((s) => !s.isExtraLeg)),
    transactionLabel: "CANCELLATION",
  });
  await auditBookingEmailAction({
    actorId: actor.id,
    action: outcome.ok ? "CANCELLATION_NOTIFICATION_SENT" : "CANCELLATION_NOTIFICATION_FAILED",
    bookingId,
    metadata: { kind: "CANCELLATION", result: outcome.ok ? (outcome.alreadySent ? "ALREADY_SENT" : "SENT") : "FAILED", ...(outcome.ok ? {} : { reason: outcome.error ?? "UNKNOWN" }) },
  });
  if (!outcome.ok) {
    throw new Error(outcome.error ?? "Failed to notify the team — please try again or check Gmail connections.");
  }
  if (outcome.alreadySent) {
    revalidatePath(`/bookings/${bookingId}`);
    return;
  }

  await logActivity({
    bookingId,
    leadId: existing.leadId,
    contactId: existing.contactId,
    actorId: actor.id,
    type: "BOOKING_UPDATED",
    description: "Cancellation notification sent to the team",
  });

  revalidatePath(`/bookings/${bookingId}`);
}
