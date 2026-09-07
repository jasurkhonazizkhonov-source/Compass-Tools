// Plain server-only module — deliberately NOT a "use server" file. Every
// exported async function in a "use server" file becomes an RPC endpoint
// any client can call directly; quote-status transitions must only ever be
// driven by server-verified conditions (a booking's own status, actually
// persisted in the DB), never by a value a browser hands us. Keeping this
// logic in a plain module — reachable from other server code (server
// actions, route handlers) but not callable from the client — is what
// actually enforces that, rather than just convention.
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { logActivity } from "@/server/activity-log";
import type { BookingStatus, Prisma, QuoteStatus } from "@/generated/prisma/client";

type Db = Prisma.TransactionClient | typeof prisma;

// Customer-driven engagement milestones that notify the assigned agent —
// deliberately excludes agent/system-driven transitions (SENT, CANCELED)
// the agent already knows about because they triggered them, and
// BOOKED/CHARGED, which are booking-ticketing-driven and already visible on
// the booking itself.
const NOTIFY_STATUSES: Partial<Record<QuoteStatus, { title: string; body: (contactName: string, quoteNumber: string) => string }>> = {
  READ: {
    title: "Quote Opened",
    body: (name, num) => `Customer ${name} opened the quote email for #${num}.`,
  },
  VIEWED: {
    title: "Quote Viewed",
    body: (name, num) => `Customer ${name} viewed the flight itinerary for quote #${num}.`,
  },
  SIGNED: {
    title: "Quote Signed",
    body: (name, num) => `Customer ${name} completed and signed the booking form for quote #${num}.`,
  },
};

/**
 * Creates the agent-facing Notification for a customer-driven quote
 * milestone (READ/VIEWED/SIGNED only — a no-op for any other status, and
 * for an unassigned quote). Factored out of transitionQuoteStatus() so
 * submitBooking() — which must transition SIGNED inside its own
 * transaction alongside a Lead status update, and so can't route through
 * transitionQuoteStatus()'s own transaction — can reuse the exact same
 * notification logic instead of duplicating it.
 */
export async function notifyQuoteActivity(
  quote: { id: string; agentId: string | null; leadId: string; quoteNumber: string; contact: { firstName: string; lastName: string } },
  toStatus: QuoteStatus
) {
  const notify = NOTIFY_STATUSES[toStatus];
  if (!notify || !quote.agentId) return;
  const contactName = `${quote.contact.firstName} ${quote.contact.lastName}`;
  await prisma.notification.create({
    data: {
      accountId: quote.agentId,
      quoteId: quote.id,
      leadId: quote.leadId,
      type: `QUOTE_${toStatus}`,
      title: notify.title,
      body: notify.body(contactName, quote.quoteNumber),
    },
  });
}

// Linear progression rank, used only to reject an accidental backward
// transition (e.g. a later unrelated booking edit re-triggering an earlier
// auto-transition function and trying to move CHARGED back to BOOKED).
// CANCELED is excluded from the ranking — it's reachable from any
// non-terminal status and, once set, nothing should auto-transition out of
// it (that guard lives in reconcileQuoteStatus below, not here, since
// "terminal" isn't expressible as a single rank number).
//
// The exchange/cancellation statuses are NOT written through this
// function at all — see src/server/exchange.ts and
// src/server/cancellation.ts, which write them directly (their own
// preconditions ARE the authorization/ordering guard, not this generic
// rank check). They still need a rank here purely so this Record stays
// exhaustive and so EXCHANGE_APPROVED — the one status among them that DOES
// flow back through this function, via the ordinary sendQuote() ->
// transitionQuoteStatus(quoteId, "SENT") call once an exchange quote is
// approved and sent — has a low-enough rank for that forward move into
// SENT to be allowed. All given the same rank as CANCELED for that reason.
const STATUS_RANK: Record<QuoteStatus, number> = {
  DRAFT: 0,
  SENT: 1,
  READ: 2,
  VIEWED: 3,
  SIGNED: 4,
  BOOKED: 5,
  CHARGED: 6,
  CANCELED: -1,
  EXCHANGED: -1,
  PENDING_EXCHANGE_APPROVAL: -1,
  EXCHANGE_APPROVED: -1,
  EXCHANGE_DISAPPROVED: -1,
  EXCHANGE_SUPERSEDED: -1,
  PENDING_CANCELLATION_APPROVAL: -1,
  CANCELLATION_APPROVED: -1,
  CANCELLATION_FORM_SENT: -1,
  CANCELLATION_SUBMITTED: -1,
  CANCELLATION_CONFIRMED: -1,
};

const TIMESTAMP_FIELD: Record<QuoteStatus, string | null> = {
  DRAFT: null,
  SENT: "sentAt",
  READ: "readAt",
  VIEWED: "viewedAt",
  SIGNED: "signedAt",
  BOOKED: "bookedAt",
  CHARGED: "chargedAt",
  CANCELED: "canceledAt",
  // No dedicated timestamp column for any of these — QuoteStatusHistory
  // (written by every caller of this function/of the dedicated
  // exchange/cancellation writers) already records exactly when each of
  // these was set, satisfying the audit-trail requirement without seven
  // more nullable DateTime columns that would only ever be read from
  // there anyway.
  EXCHANGED: null,
  PENDING_EXCHANGE_APPROVAL: null,
  EXCHANGE_APPROVED: null,
  EXCHANGE_DISAPPROVED: null,
  EXCHANGE_SUPERSEDED: null,
  PENDING_CANCELLATION_APPROVAL: null,
  CANCELLATION_APPROVED: null,
  CANCELLATION_FORM_SENT: null,
  CANCELLATION_SUBMITTED: null,
  CANCELLATION_CONFIRMED: null,
};

type QuoteWithContact = Prisma.QuoteGetPayload<{ include: { contact: { select: { firstName: true; lastName: true } } } }>;

async function writeQuoteStatus(
  db: Db,
  quoteId: string,
  toStatus: QuoteStatus,
  actorId: string | undefined,
  extra?: Record<string, unknown>
): Promise<QuoteWithContact | null> {
  const quote = await db.quote.findUniqueOrThrow({
    where: { id: quoteId },
    include: { contact: { select: { firstName: true, lastName: true } } },
  });

  if (toStatus !== "CANCELED") {
    // Once CANCELED, nothing auto-transitions it back onto the linear
    // progression. Otherwise, only a strictly-forward move is allowed.
    if (quote.status === "CANCELED" || STATUS_RANK[toStatus] <= STATUS_RANK[quote.status]) {
      return null;
    }
  }

  const field = TIMESTAMP_FIELD[toStatus];
  await db.quote.update({
    where: { id: quoteId },
    data: {
      status: toStatus,
      lastActivityAt: new Date(),
      ...(field ? { [field]: new Date() } : {}),
      ...extra,
    },
  });
  await db.quoteStatusHistory.create({
    data: { quoteId, fromStatus: quote.status, toStatus, changedById: actorId },
  });

  return quote;
}

async function fireQuoteStatusSideEffects(quote: QuoteWithContact, toStatus: QuoteStatus, actorId: string | undefined, activityDescription?: string) {
  await logActivity({
    quoteId: quote.id,
    leadId: quote.leadId,
    contactId: quote.contactId,
    actorId,
    type: "QUOTE_STATUS_CHANGED",
    description: activityDescription ?? `Quote status changed from ${quote.status} to ${toStatus}`,
  });

  await notifyQuoteActivity(quote, toStatus);
}

/**
 * The single choke point for every Quote.status change — sets the status,
 * its matching timestamp field, lastActivityAt (drives the CRM quote
 * list's "most recently active" ordering), a QuoteStatusHistory row, an
 * activity-log entry, and (for customer-driven milestones) a Notification.
 * Every caller that changes a quote's status should go through this rather
 * than hand-rolling the same status+timestamp+history writes, so all of the
 * above stays consistent.
 *
 * Refuses to move a quote backward along the linear DRAFT..CHARGED
 * progression (CANCELED is always allowed through, in either direction, as
 * the one legitimate exception) — a silent no-op, not a throw, since every
 * caller today only ever requests a forward transition and this exists
 * purely as a defensive backstop against a future caller's bug, not a
 * condition any current code path should ever actually hit.
 *
 * Opens (and commits) its own transaction for the atomic status write. If
 * you need the status write to commit atomically alongside OTHER writes in
 * an outer transaction, do not use this function from inside that
 * transaction — the activity-log/notification side effects it fires
 * afterward would then run as extra round-trips while the outer
 * transaction is still open, needlessly extending how long it stays open
 * and risking Prisma's interactive-transaction timeout under any latency.
 * Use reconcileQuoteStatus's `tx` parameter instead (see its own doc
 * comment) — it performs ONLY the atomic write inside your transaction and
 * returns a callback you invoke for the side effects once your transaction
 * has actually committed.
 */
export async function transitionQuoteStatus(
  quoteId: string,
  toStatus: QuoteStatus,
  options?: { extra?: Record<string, unknown>; activityDescription?: string }
) {
  const actorId = (await getCurrentAccount())?.id;
  const quote = await prisma.$transaction((tx) => writeQuoteStatus(tx, quoteId, toStatus, actorId, options?.extra));
  if (!quote) return;
  await fireQuoteStatusSideEffects(quote, toStatus, actorId, options?.activityDescription);
}

// The one authoritative Booking-ticketing-status -> Quote-status mapping.
// TICKETED and CONFIRMED drive a forward Quote transition; PENDING_TICKETING
// and CANCELED are deliberately absent — the Quote is left exactly as it is
// (CANCELED does NOT revert the Quote away from SIGNED "for now", per an
// explicit product decision — a Booking later un-canceling back to TICKETED/
// CONFIRMED will still drive the Quote forward correctly, since
// transitionQuoteStatus only ever refuses a backward move, never a stale
// forward one).
const BOOKING_STATUS_TO_QUOTE_STATUS: Partial<Record<BookingStatus, QuoteStatus>> = {
  TICKETED: "BOOKED",
  CONFIRMED: "CHARGED",
};

/**
 * Syncs a Quote's status from its Booking's CURRENT ticketing status —
 * the single authoritative signal (see BOOKING_STATUS_TO_QUOTE_STATUS).
 * Deliberately does NOT depend on a payment charge existing or a
 * confirmation email having sent — those used to gate this transition, but
 * per product decision the Booking's own ticketing status is now the sole
 * driver, checked directly against the real Booking->Quote relationship
 * (Booking.quoteId is unique — never customer name/email matching, which
 * could hit the wrong quote for a repeat customer).
 *
 * @param tx When provided, ONLY the atomic status write (quote.update +
 * quoteStatusHistory.create) runs inside this transaction, so a Booking
 * status write and its Quote's status write commit atomically — see
 * updateBookingTicketing, the only production call site that changes
 * Booking.status. The activity-log entry and customer-milestone
 * notification are deliberately NOT fired here — they're returned as a
 * callback (`fireSideEffects`) so the caller can invoke it AFTER their own
 * outer transaction has actually committed, rather than as extra
 * round-trips that would otherwise hold that transaction open longer than
 * necessary (see transitionQuoteStatus's own doc comment for why this
 * matters — an earlier version of this function did exactly that and hit
 * Prisma's interactive-transaction timeout under real network latency).
 * When `tx` is omitted, this behaves as a single self-contained call — the
 * side effects fire immediately and there is nothing for the caller to do.
 *
 * @returns `{ transitioned: boolean, fireSideEffects: () => Promise<void> }`.
 * `fireSideEffects` is always safe to call (a no-op if nothing transitioned
 * or if it already fired) — call it once, after your transaction commits.
 */
export async function reconcileQuoteStatus(
  bookingId: string,
  tx?: Prisma.TransactionClient
): Promise<{ transitioned: boolean; fireSideEffects: () => Promise<void> }> {
  const noop = { transitioned: false, fireSideEffects: async () => {} };
  const db: Db = tx ?? prisma;
  const booking = await db.booking.findUnique({ where: { id: bookingId }, select: { status: true, quoteId: true } });
  if (!booking) return noop;

  const targetStatus = BOOKING_STATUS_TO_QUOTE_STATUS[booking.status];
  if (!targetStatus) return noop; // PENDING_TICKETING or CANCELED — Quote is left unchanged.

  if (!tx) {
    await transitionQuoteStatus(booking.quoteId, targetStatus);
    return { transitioned: true, fireSideEffects: async () => {} };
  }

  const actorId = (await getCurrentAccount())?.id;
  const quote = await writeQuoteStatus(tx, booking.quoteId, targetStatus, actorId);
  if (!quote) return noop;

  let fired = false;
  return {
    transitioned: true,
    fireSideEffects: async () => {
      if (fired) return;
      fired = true;
      await fireQuoteStatusSideEffects(quote, targetStatus, actorId);
    },
  };
}
