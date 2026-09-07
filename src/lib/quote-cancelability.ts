import type { QuoteStatus } from "@/generated/prisma/client";

// Shared between the client "Cancel Quote" button (quote-actions.tsx) and
// the server action itself (cancelQuote, src/server/actions/quotes.ts) —
// one definition so the two can never drift apart again. Pass 22 fix: this
// set previously existed ONLY as a client-side const inside
// quote-actions.tsx, and cancelQuote() itself had NO status precondition
// at all (transitionQuoteStatus's own STATUS_RANK table deliberately
// exempts CANCELED from its forward-only check, by design, for every
// OTHER caller — but that means cancelQuote() had no server-side floor of
// its own). Two real gaps followed from that: (1) CHARGED was missing
// from the client-side set entirely, so the destructive "Cancel Quote"
// button was shown and clickable on an already-paid quote; (2) even for a
// status the client DID hide the button for (e.g. BOOKED), nothing
// stopped a direct call to the cancelQuote server action from doing it
// anyway — the client-side Set was never actually a security boundary.
//
// The generic "Cancel Quote" action (a whole-quote discard, distinct from
// the Cancellation workflow's per-segment request — see
// server/actions/cancellation.ts) doesn't make sense once a quote has
// entered any of these more specific states: CANCELED/BOOKED/CHARGED
// already have (or, for BOOKED/CHARGED, require) more specific handling —
// a real booking and/or a completed payment exists, so the only correct
// path once real money/tickets are involved is the formal, approval-gated
// cancellation workflow, never this blunt shortcut. The exchange/
// cancellation branch statuses are excluded because "cancel this quote"
// is ambiguous once it's mid-exchange or mid-cancellation-review — those
// have their own explicit actions (Approve/Disapprove, Confirm/Disregard)
// instead.
export const NON_CANCELABLE_QUOTE_STATUSES = new Set<QuoteStatus>([
  "CANCELED",
  "BOOKED",
  "CHARGED",
  "EXCHANGED",
  "PENDING_EXCHANGE_APPROVAL",
  "EXCHANGE_APPROVED",
  "EXCHANGE_DISAPPROVED",
  // Pass 26 — same reasoning as EXCHANGE_DISAPPROVED directly above: a
  // superseded proposal is already a terminal branch of the exchange
  // workflow, preserved for audit; the blunt "Cancel Quote" action doesn't
  // apply to it any more than it applies to a disapproved one.
  "EXCHANGE_SUPERSEDED",
  "PENDING_CANCELLATION_APPROVAL",
  "CANCELLATION_APPROVED",
  "CANCELLATION_FORM_SENT",
  "CANCELLATION_SUBMITTED",
  "CANCELLATION_CONFIRMED",
]);

export function isQuoteCancelable(status: QuoteStatus): boolean {
  return !NON_CANCELABLE_QUOTE_STATUSES.has(status);
}
