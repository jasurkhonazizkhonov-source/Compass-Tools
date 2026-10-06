import { prisma } from "@/lib/prisma";
import { canRevealBookingCvv } from "@/lib/permissions";
import { bookingVisibilityWhere, type Viewer } from "@/server/visibility";

type CvvViewer = NonNullable<Viewer> & { status?: string; paymentPermissions?: string[] };

export type BookingCvvState = { available: true; expiresAt: string } | { available: false };

/**
 * For the Booking page only: which of this booking's cards still have a retained security code, so the Admin-only
 * "Reveal CVV/CVC" control can be shown or replaced by "no longer available". It reads NO ciphertext — only existence, expiry and
 * whether the record was destroyed — and returns nothing at all unless the viewer is an Admin who may reveal it and the booking is
 * one they can see in their own company. The value itself is only ever returned by the dedicated reveal action.
 */
export async function getBookingCvvStates(viewer: CvvViewer | null, bookingId: string): Promise<Record<string, BookingCvvState> | null> {
  if (!viewer || viewer.status === "INACTIVE" || !canRevealBookingCvv(viewer as Parameters<typeof canRevealBookingCvv>[0])) return null;
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, ...bookingVisibilityWhere(viewer), contact: { companyId: viewer.companyId } },
    select: { paymentMethods: { select: { id: true, retainedSecurityCode: { select: { expiresAt: true, destroyedAt: true } } } } },
  });
  if (!booking) return null;
  const now = Date.now();
  return Object.fromEntries(
    booking.paymentMethods.map((pm) => {
      const r = pm.retainedSecurityCode;
      const live = !!r && !r.destroyedAt && r.expiresAt.getTime() > now;
      return [pm.id, live ? { available: true as const, expiresAt: r!.expiresAt.toISOString() } : { available: false as const }];
    })
  );
}
