import { prisma } from "@/lib/prisma";
import { bookingVisibilityWhere, contactVisibilityWhere, type Viewer } from "@/server/visibility";

/**
 * IDOR/BOLA check for a PaymentMethod row that may be attached to a
 * Booking, a Contact, or both. A booking-submitted card always has both
 * bookingId and contactId set (see submitBooking()); a card added directly
 * from the Contact page has only contactId. Access is granted if the
 * actor's normal row-level visibility covers whichever parent record(s)
 * are actually present — never a bare "the id exists" check.
 */
export async function canAccessPaymentMethod(
  actor: Viewer,
  paymentMethod: { bookingId: string | null; contactId: string | null }
): Promise<boolean> {
  if (paymentMethod.bookingId) {
    const booking = await prisma.booking.findFirst({
      where: { id: paymentMethod.bookingId, ...bookingVisibilityWhere(actor) },
      select: { id: true },
    });
    if (booking) return true;
  }
  if (paymentMethod.contactId) {
    const contact = await prisma.contact.findFirst({
      where: { id: paymentMethod.contactId, ...contactVisibilityWhere(actor) },
      select: { id: true },
    });
    if (contact) return true;
  }
  // Neither reference resolved to something the actor can see (or the row
  // has neither reference at all, which should never happen) — fail closed.
  return false;
}
