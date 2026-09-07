import type { QuoteStatus } from "@/generated/prisma/client";

// Pass 26 — the ONE shared definition of "an exchange proposal the customer
// has not yet acted on, so an agent may still replace it with a revised
// version." Used by both sendExchangeForApproval's revision path (the
// actual authorization boundary) and the CRM UI (to decide whether to show
// the "New Exchange Proposal" button) — the same one-definition-shared-by-
// client-and-server pattern quote-cancelability.ts already established for
// isQuoteCancelable, so the two can never drift apart.
//
// Deliberately excludes:
//  - SIGNED/BOOKED/CHARGED — the customer has already signed this exact
//    proposal; a real Booking now exists (or is about to). Revising a
//    signed proposal would orphan or duplicate that Booking — never
//    allowed. The customer's only path forward from here is a brand-new
//    exchange proposed against the (now EXCHANGED) original once this one
//    is itself charged, exactly like the very first exchange.
//  - EXCHANGE_DISAPPROVED/EXCHANGE_SUPERSEDED/CANCELED/every cancellation
//    status — already terminal for this proposal; nothing to revise.
export const REVISABLE_EXCHANGE_STATUSES: ReadonlySet<QuoteStatus> = new Set<QuoteStatus>([
  "PENDING_EXCHANGE_APPROVAL",
  "EXCHANGE_APPROVED",
  "SENT",
  "READ",
  "VIEWED",
]);

export function isExchangeProposalRevisable(status: QuoteStatus): boolean {
  return REVISABLE_EXCHANGE_STATUSES.has(status);
}

// Pass 26 — statuses a customer-facing secureToken is actually allowed to
// sign/book against. Shared by submitBooking (the real authorization
// boundary) and the customer-facing pages (for consistent, honest UX) so a
// stale/superseded/disapproved/pending-review proposal's token can never be
// used to create a Booking, even if the customer retained a link from
// before it changed state. Deliberately narrower than "not booked yet" —
// see submitBooking's own comment on why `quote.booking == null` alone was
// never a sufficient precondition.
export const BOOKABLE_QUOTE_STATUSES: ReadonlySet<QuoteStatus> = new Set<QuoteStatus>(["SENT", "READ", "VIEWED"]);

export function isQuoteBookable(status: QuoteStatus): boolean {
  return BOOKABLE_QUOTE_STATUSES.has(status);
}
