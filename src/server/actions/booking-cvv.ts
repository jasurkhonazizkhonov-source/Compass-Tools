"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canRevealBookingCvv } from "@/lib/permissions";
import { bookingVisibilityWhere } from "@/server/visibility";
import { CardVaultError } from "@/server/security/card-encryption";
import { getCvvVault } from "@/server/security/payment-vault";
import { requireRecentLogin, RECENT_LOGIN_WINDOW_MS } from "@/server/security/privileged-access";
import { checkAccountRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { auditCardEvent } from "@/server/security/card-audit";
import { destroyCvv, isCvvExpired } from "@/server/security/booking-cvv";

// The Admin-only Reveal / Destroy of a booking's temporarily retained security code (CVV/CVC). These two exports are the ONLY
// code that reads `encryptedCvv` besides the creation/cleanup module (server/security/booking-cvv.ts). Nothing here returns the
// ciphertext; the decrypted value leaves the server only in a successful reveal's own response.
//
// One request is (Booking id + that booking's card id) → that card's code. There is deliberately no list, search, by-contact,
// by-lead or bulk variant, and the code is never part of any booking, quote, contact or lead read.

const GENERIC_DENIAL = "You are not authorized to reveal this security code";

export type RevealCvvResult = { cvv: string } | { error: string };
export type DestroyCvvResult = { destroyed: true } | { error: string };

type Denial = "NO_ACTIVE_SESSION" | "NOT_ADMIN" | "MISSING_PERMISSION" | "BOOKING_NOT_ACCESSIBLE" | "CARD_NOT_ON_BOOKING" | "NOT_RETAINED" | "EXPIRED" | "DESTROYED" | "RECENT_LOGIN_REQUIRED" | "DECRYPT_FAILED";

async function deny(actorId: string | undefined, paymentMethodId: string, bookingId: string, companyId: string | undefined, reason: Denial | string, action: "CVV_REVEAL_DENIED" | "CVV_REVEAL_RATE_LIMITED" = "CVV_REVEAL_DENIED") {
  // Ids and a reason category only — never the code, its ciphertext or any card number.
  await auditCardEvent({ actorId, action, entityId: paymentMethodId, success: false, reason, details: { bookingId, companyId: companyId ?? null } }).catch(() => {});
}

/**
 * Reveals one booking card's retained security code. Every step fails closed and is audited:
 *   1. an authenticated, ACTIVE session;
 *   2. the ADMIN role AND the explicit `payments.reveal` grant (canRevealBookingCvv) — no other role, whatever card permissions it holds;
 *   3. a dedicated per-account rate limit (CVV_REVEAL) that counts every attempt;
 *   4. the booking is one the account can see AND is in the account's own company; the card belongs to THAT booking;
 *   5. a sign-in within the last 15 minutes (the same step-up as the card Reveal);
 *   6. a record exists, was not destroyed, and has NOT passed its 24-hour expiry (an expired record is destroyed on the spot);
 *   7. only then is it decrypted — server-side, with the card-specific AAD — and returned.
 * Revealing never changes the expiry and never destroys the value (the Admin needs it to key in the charge).
 */
export async function revealBookingCvv(bookingId: string, paymentMethodId: string): Promise<RevealCvvResult> {
  const actor = await getCurrentAccount();
  if (!actor || actor.status !== "ACTIVE") {
    await deny(actor?.id, paymentMethodId, bookingId, undefined, "NO_ACTIVE_SESSION");
    throw new Error(GENERIC_DENIAL);
  }
  if (actor.role !== "ADMIN" || !canRevealBookingCvv(actor)) {
    await deny(actor.id, paymentMethodId, bookingId, actor.companyId, actor.role !== "ADMIN" ? "NOT_ADMIN" : "MISSING_PERMISSION");
    throw new Error(GENERIC_DENIAL);
  }

  const limit = await checkAccountRateLimit(actor.id, "CVV_REVEAL", RATE_LIMITS.CVV_REVEAL);
  if (!limit.allowed) {
    await deny(actor.id, paymentMethodId, bookingId, actor.companyId, "RATE_LIMITED", "CVV_REVEAL_RATE_LIMITED");
    return { error: `Too many attempts. Please wait ${Math.max(1, Math.ceil(limit.retryAfterSeconds / 60))} minute(s) and try again.` };
  }

  // Booking scope: visible to this account AND in its own company (bookingVisibilityWhere is company-scoped for every role).
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, ...bookingVisibilityWhere(actor), contact: { companyId: actor.companyId } },
    select: { id: true },
  });
  if (!booking) {
    await deny(actor.id, paymentMethodId, bookingId, actor.companyId, "BOOKING_NOT_ACCESSIBLE");
    throw new Error(GENERIC_DENIAL);
  }
  const card = await prisma.paymentMethod.findFirst({ where: { id: paymentMethodId, bookingId: booking.id }, select: { id: true } });
  if (!card) {
    await deny(actor.id, paymentMethodId, bookingId, actor.companyId, "CARD_NOT_ON_BOOKING");
    throw new Error(GENERIC_DENIAL);
  }

  const stepUp = requireRecentLogin(actor.sessionCreatedAt);
  if (!stepUp.ok) {
    await deny(actor.id, paymentMethodId, bookingId, actor.companyId, "RECENT_LOGIN_REQUIRED");
    return { error: `For security, revealing the CVV/CVC requires a sign-in within the last ${RECENT_LOGIN_WINDOW_MS / 60000} minutes. Sign out, sign back in, then try again.` };
  }

  // The only read of the ciphertext in the whole application besides cleanup.
  const record = await prisma.paymentMethodCvv.findUnique({
    where: { paymentMethodId: card.id },
    select: { paymentMethodId: true, encryptedCvv: true, expiresAt: true, destroyedAt: true },
  });
  const unavailable = "CVV/CVC is no longer available.";
  if (!record) {
    await deny(actor.id, card.id, bookingId, actor.companyId, "NOT_RETAINED");
    return { error: unavailable };
  }
  if (isCvvExpired(record.expiresAt)) {
    // Reveal-time enforcement: a record the daily cleanup has not reached yet is destroyed here, and the reveal is refused.
    await prisma.paymentMethodCvv.deleteMany({ where: { paymentMethodId: card.id, expiresAt: { lte: new Date() } } }).catch(() => {});
    await deny(actor.id, card.id, bookingId, actor.companyId, "EXPIRED");
    return { error: "CVV/CVC is no longer available because the 24-hour retention period has expired." };
  }
  if (record.encryptedCvv === null || record.destroyedAt) {
    await deny(actor.id, card.id, bookingId, actor.companyId, "DESTROYED");
    return { error: unavailable };
  }

  let cvv: string;
  try {
    cvv = await getCvvVault().reveal(record.encryptedCvv, card.id);
  } catch (err) {
    await deny(actor.id, card.id, bookingId, actor.companyId, err instanceof CardVaultError ? `DECRYPT_${err.code}` : "DECRYPT_FAILED");
    return { error: "The CVV/CVC could not be decrypted. Please contact an administrator." };
  }
  await auditCardEvent({ actorId: actor.id, action: "CVV_REVEALED", entityId: card.id, success: true, details: { bookingId, companyId: actor.companyId } }).catch(() => {});
  return { cvv };
}

/**
 * Explicit, Admin-only destruction of a card's retained security code (the "Destroy CVV/CVC" control, behind the CRM's own
 * confirmation dialog). Same authorization and booking scope as the reveal; it does not need the recent-sign-in step-up because it
 * only ever REMOVES data. Idempotent. After it returns, no request can recover the value.
 */
export async function destroyBookingCvv(bookingId: string, paymentMethodId: string): Promise<DestroyCvvResult> {
  const actor = await getCurrentAccount();
  if (!actor || actor.status !== "ACTIVE") {
    await deny(actor?.id, paymentMethodId, bookingId, undefined, "NO_ACTIVE_SESSION");
    throw new Error(GENERIC_DENIAL);
  }
  if (actor.role !== "ADMIN" || !canRevealBookingCvv(actor)) {
    await deny(actor.id, paymentMethodId, bookingId, actor.companyId, actor.role !== "ADMIN" ? "NOT_ADMIN" : "MISSING_PERMISSION");
    throw new Error(GENERIC_DENIAL);
  }
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, ...bookingVisibilityWhere(actor), contact: { companyId: actor.companyId } },
    select: { id: true },
  });
  const card = booking ? await prisma.paymentMethod.findFirst({ where: { id: paymentMethodId, bookingId: booking.id }, select: { id: true } }) : null;
  if (!booking || !card) {
    await deny(actor.id, paymentMethodId, bookingId, actor.companyId, booking ? "CARD_NOT_ON_BOOKING" : "BOOKING_NOT_ACCESSIBLE");
    throw new Error(GENERIC_DENIAL);
  }
  await destroyCvv(card.id, "ADMIN_DESTROYED", actor.id);
  revalidatePath(`/bookings/${booking.id}`);
  return { destroyed: true };
}
