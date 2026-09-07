"use server";

import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canRevealBookingIp } from "@/lib/permissions";
import { bookingVisibilityWhere } from "@/server/visibility";
import { requireRecentAuthentication } from "@/server/security/privileged-access";
import { getClientIp } from "@/lib/request-ip";

const GENERIC_DENIAL = "You are not authorized to reveal this booking's submission IP";

async function auditBookingIpAccess(params: {
  actorId: string | undefined;
  bookingId: string;
  success: boolean;
  reason?: string;
}) {
  let ip: string | undefined;
  try {
    ip = getClientIp(await headers());
  } catch {
    // headers() can throw outside a request context — audit logging must never block on it.
  }
  await prisma.auditLog.create({
    data: {
      actorId: params.actorId,
      action: params.success ? "BOOKING_IP_REVEALED" : "BOOKING_IP_REVEAL_DENIED",
      entityType: "Booking",
      entityId: params.bookingId,
      // Deliberately never includes the booking's own stored/revealed
      // submission IP — only the requesting actor's IP (who did the
      // revealing), which is standard audit-log practice and distinct from
      // the sensitive value being protected.
      metadata: {
        result: params.success ? "SUCCESS" : "DENIED",
        reason: params.reason ?? null,
        requestingIp: ip ?? null,
      },
    },
  });
}

/**
 * Privileged reveal of a booking's server-captured submission IP address
 * (and User-Agent, captured alongside it at signing time — see
 * submitBooking() in src/server/actions/booking.ts). Gated identically to
 * the IP itself: same permission, same IDOR/visibility check, same
 * step-up-auth requirement, same audit log entry. User-Agent is supporting
 * fraud-investigation context, never proof of identity on its own.
 * Mirrors revealPaymentMethod()'s exact structure/checks:
 *   1-3: authenticated session, active account, role + explicit
 *        bookings.reveal_ip permission (canRevealBookingIp checks both).
 *   4:   IDOR/BOLA protection — reuses bookingVisibilityWhere(), the same
 *        row-level scope every other booking-detail access goes through.
 *   5:   recent authentication / MFA via requireRecentAuthentication() —
 *        fails closed in production, no-op-but-labeled in development.
 *   6:   audit event for both success and denial, referencing the booking
 *        rather than duplicating its stored IP into the audit record.
 *   7-8: return only to this call's caller — auto-hide/Hide is client-side.
 *
 * Pass 33 — retention: booking submission IP information is retained
 * indefinitely by design, with no automatic age-based expiration of any
 * kind. This function previously also enforced an OPTIONAL age-based
 * restriction on Reveal itself (a since-removed `BOOKING_IP_RETENTION_DAYS`
 * env var — never a data-deletion mechanism; nothing in this codebase ever
 * deleted a booking's stored/encrypted IP based on age, that check only
 * ever gated whether an otherwise-fully-authorized user could currently
 * view it). Removed entirely: an authorized user may now reveal a
 * booking's submission IP regardless of the booking's age. The underlying
 * data was, and remains, permanently retained — only ever removable via an
 * explicit, deliberate, out-of-band data-management action (e.g. a direct,
 * authorized deletion an administrator performs), never automatically.
 */
export async function revealBookingIp(bookingId: string) {
  const actor = await getCurrentAccount();

  if (!actor || actor.status !== "ACTIVE") {
    await auditBookingIpAccess({ actorId: actor?.id, bookingId, success: false, reason: "NO_ACTIVE_SESSION" });
    throw new Error(GENERIC_DENIAL);
  }
  if (!canRevealBookingIp(actor)) {
    await auditBookingIpAccess({ actorId: actor.id, bookingId, success: false, reason: "MISSING_PERMISSION" });
    throw new Error(GENERIC_DENIAL);
  }

  // IDOR/BOLA protection — a valid bookingId alone is not enough; it must
  // also be a booking this account can see under normal row-level scope.
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, ...bookingVisibilityWhere(actor) },
    select: { id: true, signature: { select: { ipAddress: true, userAgent: true } } },
  });
  if (!booking) {
    await auditBookingIpAccess({ actorId: actor.id, bookingId, success: false, reason: "BOOKING_NOT_ACCESSIBLE" });
    throw new Error(GENERIC_DENIAL);
  }

  const stepUp = requireRecentAuthentication();
  if (!stepUp.ok) {
    await auditBookingIpAccess({ actorId: actor.id, bookingId, success: false, reason: stepUp.reason });
    throw new Error(GENERIC_DENIAL);
  }

  await auditBookingIpAccess({ actorId: actor.id, bookingId, success: true });

  return { ipAddress: booking.signature?.ipAddress ?? null, userAgent: booking.signature?.userAgent ?? null };
}
