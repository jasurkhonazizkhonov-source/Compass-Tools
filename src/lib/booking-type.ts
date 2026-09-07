// Pass 13 §7 — "Type" column for the Bookings list: derived purely from
// already-authoritative structured data (Quote.status/Quote.originalQuoteId),
// never inferred from note text. Deliberately NOT a stored/duplicated field
// on Booking — a cancellation reuses the SAME Booking row the original sale
// created (see cancellation.ts's confirmCancellationByCustomer, which
// explicitly never creates a second Booking: "Booking.quoteId is @unique
// and this quote's Booking already exists from the original charge"), so
// the type is a live reflection of the quote's current lifecycle state,
// not a fact fixed once at booking-creation time. This is exactly why it
// "remains consistent after booking-form signing / exchange-form signing /
// cancellation-form signing / subsequent ticketing activity" — every one
// of those events is a Quote.status transition this function already
// reads.

export type BookingType = "NEW_TICKET" | "EXCHANGE" | "CANCELLATION";

export const BOOKING_TYPE_LABELS: Record<BookingType, string> = {
  NEW_TICKET: "New Ticket",
  EXCHANGE: "Exchange",
  CANCELLATION: "Cancellation",
};

const CANCELLATION_QUOTE_STATUSES = new Set([
  "PENDING_CANCELLATION_APPROVAL",
  "CANCELLATION_APPROVED",
  "CANCELLATION_FORM_SENT",
  "CANCELLATION_SUBMITTED",
  "CANCELLATION_CONFIRMED",
]);

export function getBookingType(quote: { status: string; originalQuoteId: string | null }): BookingType {
  // A cancellation in progress or completed takes precedence over "this
  // happens to be an exchange quote" — once cancellation enters the
  // picture, that's the more specific, more recent business event a
  // Ticketing/ops user needs to see at a glance, exchange-origin or not.
  if (CANCELLATION_QUOTE_STATUSES.has(quote.status)) return "CANCELLATION";
  if (quote.originalQuoteId != null) return "EXCHANGE";
  return "NEW_TICKET";
}
