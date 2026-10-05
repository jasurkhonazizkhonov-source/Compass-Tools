import { customAlphabet } from "nanoid";

/**
 * The booking reference ("BFT-7QX2M9A"), generated in ONE place.
 *
 * Where it appears (audited in code, see src/lib/__tests__/booking-reference.test.ts): the CRM's own pages (Bookings,
 * Commissions, Lead and Contact detail), the internal "Booking Form Signed" staff email, and the `submitBooking` response
 * payload (not rendered). It is NOT printed on any customer-facing page or email — the customer confirmation email accepts
 * the value but never renders it. The prefix is therefore an internal identifier, not company branding shown to customers,
 * and changing it is a business decision rather than a security requirement. To change it for NEW bookings, edit
 * BOOKING_REFERENCE_PREFIX below: nothing in the application parses or depends on the prefix (lookups are by id, secure token
 * or exact stored value), and references already issued are stored strings that are never rewritten.
 *
 * The 7-character body is drawn from an alphabet without look-alike characters (no 0/O, 1/I). Uniqueness is enforced by the
 * database (`Booking.bookingReference` is unique): a collision (about 1 in 10^10) fails the booking atomically and the
 * customer's retry simply draws a new reference.
 */
export const BOOKING_REFERENCE_PREFIX = "BFT-";
const BODY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const body = customAlphabet(BODY_ALPHABET, 7);

export function generateBookingReference(): string {
  return `${BOOKING_REFERENCE_PREFIX}${body()}`;
}
