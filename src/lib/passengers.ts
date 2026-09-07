// Pass 12 §26/§27 — the ONE source of truth for "how many passengers this
// itinerary/booking was sent for", reused by the Quotes list, Bookings
// list, and any future surface that needs the same number. A Quote's own
// adults/children/infants columns are the authoritative record — set when
// the quote is built, unchanged afterward — and a Booking has a 1:1
// relation to the Quote it was signed from (Booking.quoteId @unique), so
// there is no second, independently-maintained passenger-count field to
// drift out of sync. This deliberately does NOT count Booking.passengers
// (the named individuals filled in at signing) — that relation answers a
// different question ("who is traveling"), not "how many were quoted for".
//
// Gracefully handles legacy/incomplete data: a null/undefined field (never
// expected on a real row, since every one of these columns has a
// non-nullable default in the schema, but defensive against a malformed
// fixture or a future nullable migration) counts as 0 rather than
// producing NaN/undefined in the UI.
export type QuotePassengerCounts = { adults: number | null | undefined; children: number | null | undefined; infants: number | null | undefined };

export function getPassengerCount(counts: QuotePassengerCounts): number {
  return (counts.adults ?? 0) + (counts.children ?? 0) + (counts.infants ?? 0);
}
