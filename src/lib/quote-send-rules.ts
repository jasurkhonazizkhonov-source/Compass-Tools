import type { QuoteStatus } from "@/generated/prisma/client";

// One shared definition of which quote statuses may be priced or sent, so the
// server actions (the real enforcement) and any UI hint can never drift apart.
// Deliberately a plain module, not a "use server" file: everything exported
// from a server-actions file becomes a network-callable endpoint.

/**
 * Pricing may only change while the quote is still an unsent DRAFT. Once a
 * quote has been sent, pricingSnapshot has frozen what the customer was
 * shown and the booking recomputes its charge from the quote's stored
 * pricing — editing it afterwards would silently charge a different amount
 * than the customer saw. (A price change after sending is a new quote or an
 * exchange, both of which have their own workflows.)
 */
export const PRICING_EDITABLE_STATUSES: readonly QuoteStatus[] = ["DRAFT"];

export function isQuotePricingEditable(status: QuoteStatus): boolean {
  return PRICING_EDITABLE_STATUSES.includes(status);
}

/**
 * Statuses from which a quote may be (re)sent to the customer: a fresh draft,
 * an approved exchange proposal, and the "already sent, customer has not
 * acted yet" states (a deliberate resend). Everything after signing —
 * SIGNED, BOOKED, CHARGED, CANCELED, exchange/cancellation review — must
 * never email a stale quote or overwrite its frozen pricing snapshot.
 */
export const SENDABLE_QUOTE_STATUSES: readonly QuoteStatus[] = ["DRAFT", "EXCHANGE_APPROVED", "SENT", "READ", "VIEWED"];

export function isQuoteSendable(status: QuoteStatus): boolean {
  return SENDABLE_QUOTE_STATUSES.includes(status);
}

/**
 * Two sends of the same quote to the same address inside this window are one
 * send (double click, retried request, two open tabs). Long enough to swallow
 * any accidental duplicate, short enough that an agent who deliberately
 * resends a minute later is never blocked.
 */
export const QUOTE_SEND_DEDUPE_WINDOW_MS = 30_000;
