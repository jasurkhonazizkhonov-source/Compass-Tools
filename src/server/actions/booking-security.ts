"use server";

import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canRevealBookingIp } from "@/lib/permissions";
import { bookingVisibilityWhere } from "@/server/visibility";
import { requireRecentLogin, RECENT_LOGIN_WINDOW_MS } from "@/server/security/privileged-access";
import { getClientIp } from "@/lib/request-ip";
import { checkAccountRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";

const GENERIC_DENIAL = "You are not authorized to reveal this booking's submission IP";

/**
 * A refusal the user can act on (sign in again) is RETURNED, not thrown:
 * Next.js replaces the message of any error thrown from a Server Action with an
 * opaque digest in production, which React surfaces to the client as
 * "Minified React error #441" (the masked "error occurred in the Server
 * Components render"). Authorization failures (no session / no grant / not
 * found / not accessible) still throw the generic denial — they must not
 * explain themselves. Same contract as revealPaymentMethod's RevealResult.
 */
/**
 * What a successful reveal returns. `location` is the platform's APPROXIMATE,
 * IP-derived estimate of where the signer's network is — stored with the signing
 * event itself (never looked up again here) and `null` when it was not captured
 * (older bookings, or a deployment without a trusted edge) — never invented.
 */
export type BookingIpLocation = {
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  timeZone: string | null;
  source: string | null;
};
export type BookingIpRevealResult =
  | { ipAddress: string | null; userAgent: string | null; ipVersion: "v4" | "v6" | null; signedAt: Date | null; location: BookingIpLocation | null }
  | { error: string };

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
 *   5:   recent sign-in via requireRecentLogin() — the same real step-up the
 *        card Reveal uses (a Google sign-in within the last 15 minutes) in
 *        every production-class environment; a stale session is refused with
 *        a returned, actionable message. (This previously used
 *        requireRecentAuthentication(), which fails closed in production
 *        unconditionally and THREW — the cause of React error #441.)
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
export async function revealBookingIp(bookingId: string): Promise<BookingIpRevealResult> {
  const actor = await getCurrentAccount();

  if (!actor || actor.status !== "ACTIVE") {
    await auditBookingIpAccess({ actorId: actor?.id, bookingId, success: false, reason: "NO_ACTIVE_SESSION" });
    throw new Error(GENERIC_DENIAL);
  }
  // Per-account throttle, counting every attempt (like the card Reveal): a stolen session or a script
  // cannot harvest addresses. Returned, not thrown, so the user sees why.
  const limit = await checkAccountRateLimit(actor.id, "IP_REVEAL", RATE_LIMITS.IP_REVEAL);
  if (!limit.allowed) {
    await auditBookingIpAccess({ actorId: actor.id, bookingId, success: false, reason: "RATE_LIMITED" });
    return { error: `Too many Reveal attempts. Please wait ${Math.max(1, Math.ceil(limit.retryAfterSeconds / 60))} minute(s) and try again.` };
  }
  if (!canRevealBookingIp(actor)) {
    await auditBookingIpAccess({ actorId: actor.id, bookingId, success: false, reason: "MISSING_PERMISSION" });
    throw new Error(GENERIC_DENIAL);
  }

  // IDOR/BOLA protection — a valid bookingId alone is not enough; it must
  // also be a booking this account can see under normal row-level scope.
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, ...bookingVisibilityWhere(actor) },
    select: { id: true, signature: { select: { ipAddress: true, userAgent: true, signedAt: true } } },
  });
  if (!booking) {
    await auditBookingIpAccess({ actorId: actor.id, bookingId, success: false, reason: "BOOKING_NOT_ACCESSIBLE" });
    throw new Error(GENERIC_DENIAL);
  }

  const stepUp = requireRecentLogin(actor.sessionCreatedAt);
  if (!stepUp.ok) {
    await auditBookingIpAccess({ actorId: actor.id, bookingId, success: false, reason: stepUp.reason });
    return { error: `For security, Reveal requires a sign-in within the last ${RECENT_LOGIN_WINDOW_MS / 60000} minutes. Sign out, sign back in, then try again.` };
  }

  await auditBookingIpAccess({ actorId: actor.id, bookingId, success: true });

  // Geography captured WITH the original signing event (the earliest new-booking or
  // exchange-booking capture). Columns only — the encrypted IP is never touched here.
  const capture = await prisma.ipCapture.findFirst({
    where: { bookingId, softDeletedAt: null, formType: { in: ["NEW_BOOKING", "EXCHANGE_BOOKING"] } },
    orderBy: [{ capturedAt: "asc" }, { id: "asc" }],
    select: { ipVersion: true, capturedAt: true, geoCity: true, geoRegion: true, geoCountry: true, geoCountryCode: true, geoTimeZone: true, geoSource: true },
  });
  const hasGeo = !!capture && !!(capture.geoCity || capture.geoRegion || capture.geoCountry || capture.geoCountryCode || capture.geoTimeZone);
  const ip = booking.signature?.ipAddress ?? null;

  return {
    ipAddress: ip,
    userAgent: booking.signature?.userAgent ?? null,
    ipVersion: ip ? (ip.includes(":") ? "v6" : "v4") : null,
    signedAt: booking.signature?.signedAt ?? capture?.capturedAt ?? null,
    location: hasGeo
      ? { city: capture!.geoCity, region: capture!.geoRegion, country: capture!.geoCountry, countryCode: capture!.geoCountryCode, timeZone: capture!.geoTimeZone, source: capture!.geoSource }
      : null,
  };
}
