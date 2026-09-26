"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { logActivity } from "@/server/activity-log";
import { canRevealPaymentMethod, canConfirmPayment } from "@/lib/permissions";
import { getPaymentVault } from "@/server/security/payment-vault";
import { CardVaultError, PURGED_REFERENCE } from "@/server/security/card-encryption";
import { requireRecentLogin, RECENT_LOGIN_WINDOW_MS } from "@/server/security/privileged-access";
import { checkAccountRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { auditCardEvent } from "@/server/security/card-audit";
import { isChargeAmountAllowed } from "@/lib/payment-limits";
import { canAccessPaymentMethod } from "@/server/payment-method-access";
import { bookingVisibilityWhere } from "@/server/visibility";
import { formatMoney, isSupportedCurrency } from "@/lib/currency";

async function auditPaymentMethodAccess(params: {
  actorId: string | undefined;
  paymentMethodId: string;
  bookingId: string | undefined | null;
  last4: string | undefined | null;
  success: boolean;
  reason?: string;
}) {
  await auditCardEvent({
    actorId: params.actorId,
    action: params.success ? "PAYMENT_METHOD_REVEALED" : "PAYMENT_METHOD_REVEAL_DENIED",
    entityId: params.paymentMethodId,
    success: params.success,
    reason: params.reason,
    // Deliberately never includes the PAN or CVV — only the last four
    // digits (already-masked data), never the full card number.
    details: { bookingId: params.bookingId ?? null, last4: params.last4 ?? null },
  });
}

const GENERIC_DENIAL = "You are not authorized to reveal this payment method";

/**
 * A refusal the user can act on (sign in again, wait, ...) is RETURNED, not
 * thrown: Next.js replaces the message of any error thrown from a Server
 * Action with an opaque digest in production, so a thrown "please sign in
 * again" would reach the user as gibberish. Authorization failures (no
 * session / no grant / not found / not accessible) still throw the generic
 * denial — they must not explain themselves.
 */
export type RevealResult =
  | { cardholderName: string; pan: string; cardBrand: string | null; expiryMonth: number; expiryYear: number }
  | { error: string };

/**
 * The privileged reveal workflow. Every step fails closed and is audited:
 *   1. Authenticated, ACTIVE session.
 *   2. Per-account rate limit (CARD_REVEAL) — counts every attempt, so a
 *      stolen session or a script cannot harvest cards; hitting it is audited.
 *   3. Explicit `payments.reveal` grant on an eligible role. No role — Admin
 *      included — has Reveal by role alone.
 *   4. This specific record is one the account may see (IDOR/BOLA) — the same
 *      row-level visibility every other booking/contact read uses.
 *   5. Recent sign-in (privileged-access.ts requireRecentLogin) in every
 *      production-class environment, however the vault was enabled.
 *   6. Decrypt through the PaymentVault (row id is bound into the ciphertext).
 *      A decrypt failure is audited with a fixed error code, never a message.
 *   7. Audit the success (actor, record, IP, user agent, correlation id).
 *   The PAN is returned only to this call's caller; the UI shows it briefly,
 *   never persists it, and hides it on a timer / tab change.
 * This is the only export in the codebase that reads encryptedPan.
 */
export async function revealPaymentMethod(paymentMethodId: string): Promise<RevealResult> {
  const actor = await getCurrentAccount();

  if (!actor || actor.status !== "ACTIVE") {
    await auditPaymentMethodAccess({ actorId: actor?.id, paymentMethodId, bookingId: undefined, last4: undefined, success: false, reason: "NO_ACTIVE_SESSION" });
    throw new Error(GENERIC_DENIAL);
  }

  const limit = await checkAccountRateLimit(actor.id, "CARD_REVEAL", RATE_LIMITS.CARD_REVEAL);
  if (!limit.allowed) {
    await auditCardEvent({
      actorId: actor.id,
      action: "PAYMENT_METHOD_REVEAL_RATE_LIMITED",
      entityId: paymentMethodId,
      success: false,
      reason: "RATE_LIMITED",
      details: { retryAfterSeconds: limit.retryAfterSeconds },
    });
    return { error: `Too many Reveal attempts. Please wait ${Math.max(1, Math.ceil(limit.retryAfterSeconds / 60))} minute(s) and try again.` };
  }

  if (!canRevealPaymentMethod(actor)) {
    await auditPaymentMethodAccess({ actorId: actor.id, paymentMethodId, bookingId: undefined, last4: undefined, success: false, reason: "MISSING_PERMISSION" });
    throw new Error(GENERIC_DENIAL);
  }

  const paymentMethod = await prisma.paymentMethod.findUnique({
    where: { id: paymentMethodId },
    select: { id: true, encryptedPan: true, status: true, cardholderName: true, cardBrand: true, expiryMonth: true, expiryYear: true, last4: true, bookingId: true, contactId: true },
  });
  if (!paymentMethod) {
    await auditPaymentMethodAccess({ actorId: actor.id, paymentMethodId, bookingId: undefined, last4: undefined, success: false, reason: "NOT_FOUND" });
    throw new Error(GENERIC_DENIAL);
  }

  // Protects against IDOR/BOLA — a valid paymentMethodId alone is not
  // enough; the underlying booking OR contact (whichever this card is
  // actually attached to) must also be one this account can see.
  const accessible = await canAccessPaymentMethod(actor, paymentMethod);
  if (!accessible) {
    await auditPaymentMethodAccess({ actorId: actor.id, paymentMethodId, bookingId: paymentMethod.bookingId, last4: paymentMethod.last4, success: false, reason: "RECORD_NOT_ACCESSIBLE" });
    throw new Error(GENERIC_DENIAL);
  }

  if (paymentMethod.status === "ARCHIVED" || paymentMethod.encryptedPan === PURGED_REFERENCE) {
    await auditPaymentMethodAccess({ actorId: actor.id, paymentMethodId, bookingId: paymentMethod.bookingId, last4: paymentMethod.last4, success: false, reason: "CARD_REMOVED" });
    return { error: "This card has been removed and can no longer be revealed" };
  }

  const stepUp = requireRecentLogin(actor.sessionCreatedAt);
  if (!stepUp.ok) {
    await auditPaymentMethodAccess({ actorId: actor.id, paymentMethodId, bookingId: paymentMethod.bookingId, last4: paymentMethod.last4, success: false, reason: stepUp.reason });
    return { error: `For security, Reveal requires a sign-in within the last ${RECENT_LOGIN_WINDOW_MS / 60000} minutes. Sign out, sign back in, then try again.` };
  }

  let pan: string;
  try {
    pan = await getPaymentVault().reveal(paymentMethod.encryptedPan, paymentMethod.id);
  } catch (err) {
    const code = err instanceof CardVaultError ? err.code : "UNKNOWN";
    await auditCardEvent({
      actorId: actor.id,
      action: "CARD_DECRYPTION_FAILED",
      entityId: paymentMethod.id,
      success: false,
      reason: code,
      details: { bookingId: paymentMethod.bookingId, last4: paymentMethod.last4 },
    });
    return { error: "This card could not be decrypted. Please contact an administrator." };
  }
  await auditPaymentMethodAccess({ actorId: actor.id, paymentMethodId, bookingId: paymentMethod.bookingId, last4: paymentMethod.last4, success: true });

  return {
    cardholderName: paymentMethod.cardholderName,
    pan,
    cardBrand: paymentMethod.cardBrand,
    expiryMonth: paymentMethod.expiryMonth,
    expiryYear: paymentMethod.expiryYear,
  };
}

const confirmPaymentSchema = z.object({
  bookingId: z.string(),
  paymentMethodId: z.string(),
  amount: z.number().positive(),
  status: z.enum(["SUCCEEDED", "FAILED"]),
  // A card number typed into a free-text note must never be stored.
  referenceNote: z
    .string()
    .max(500)
    .refine((v) => !/\b(?:\d[ -]?){13,19}\b/.test(v), "Never put card numbers in a note")
    .optional(),
});

/**
 * Replaces the old Stripe-driven automatic charge-success signal: an
 * authorized human (payments.charge) attests that they personally
 * processed a SPECIFIC payment method's charge with the airline/supplier
 * — using the card revealed above, entered by hand into that external
 * system — and records the outcome. A booking may have multiple payment
 * methods (split payment across cards); each is confirmed independently,
 * identified explicitly by paymentMethodId rather than assuming "the"
 * booking's card. Does NOT touch Quote status — that's driven purely by
 * the Booking's own ticketing status via updateBookingTicketing() (see
 * quote-status.ts's reconcileQuoteStatus).
 */
export async function confirmPaymentReceived(input: z.infer<typeof confirmPaymentSchema>) {
  const data = confirmPaymentSchema.parse(input);
  const actor = await getCurrentAccount();
  if (!actor || actor.status !== "ACTIVE" || !canConfirmPayment(actor)) {
    throw new Error("You are not authorized to record payment confirmations");
  }

  // IDOR/BOLA protection — a valid bookingId alone is not enough; it must
  // also be a booking this account can see under normal row-level scope.
  // Previously this looked up ANY booking by raw id with no ownership/
  // visibility check, letting any account with payments.charge record a
  // charge against a booking outside their own scope.
  const accessible = await prisma.booking.findFirst({
    where: { id: data.bookingId, ...bookingVisibilityWhere(actor) },
    select: { id: true },
  });
  if (!accessible) {
    throw new Error("This booking is not accessible");
  }

  const booking = await prisma.booking.findUniqueOrThrow({
    where: { id: data.bookingId },
    select: {
      id: true,
      leadId: true,
      contactId: true,
      paymentMethods: { select: { id: true, amountAllocated: true } },
      quote: { select: { currency: true } },
    },
  });
  const paymentMethod = booking.paymentMethods.find((pm) => pm.id === data.paymentMethodId);
  if (!paymentMethod) {
    throw new Error("This payment method is not on file for this booking");
  }
  // Sanity-capped against this specific card's own allocation, not the
  // whole booking total — a $200 card should never be charged $2,000 just
  // because the booking total happens to be that large.
  if (!isChargeAmountAllowed(data.amount, Number(paymentMethod.amountAllocated))) {
    throw new Error("That amount is outside the allowed range for this payment method");
  }

  // The customer's own payment currency (never a bare $ for AUD/EUR/GBP…).
  const chargeCurrency = isSupportedCurrency(booking.quote.currency) ? booking.quote.currency : "USD";
  const charge = await prisma.paymentCharge.create({
    data: {
      paymentMethodId: paymentMethod.id,
      amount: data.amount,
      // amountAllocated (validated above) is denominated in the booking's
      // own currency (inherited from the quote) — this charge record must
      // say the same, not silently default to "usd".
      currency: booking.quote.currency.toLowerCase(),
      status: data.status,
      referenceNote: data.referenceNote,
      initiatedById: actor?.id,
    },
  });

  await prisma.paymentMethod.update({
    where: { id: paymentMethod.id },
    data: { workflowStatus: data.status === "SUCCEEDED" ? "CONFIRMED" : "FAILED" },
  });

  await logActivity({
    bookingId: booking.id,
    leadId: booking.leadId,
    contactId: booking.contactId,
    actorId: actor?.id,
    type: "PAYMENT_CONFIRMED",
    description:
      data.status === "SUCCEEDED"
        ? `Payment of ${formatMoney(data.amount, chargeCurrency)} confirmed manually`
        : `Payment attempt of ${formatMoney(data.amount, chargeCurrency)} recorded as failed`,
  });

  // Quote status is no longer driven by payment confirmation — it's now
  // keyed purely off the Booking's own ticketing status (see
  // reconcileQuoteStatus in quote-status.ts), which is updated exclusively
  // by updateBookingTicketing(). A manual payment confirmation here no
  // longer needs to (and, per that design, should not) trigger a Quote
  // transition on its own.

  revalidatePath(`/bookings/${booking.id}`);
  return { id: charge.id, status: charge.status };
}

const updateWorkflowStatusSchema = z.object({
  paymentMethodId: z.string(),
  bookingId: z.string(),
  workflowStatus: z.enum(["PENDING", "AUTHORIZED", "FAILED", "CONFIRMED", "CANCELLED"]),
});

/**
 * Explicit status transitions an authorized agent sets directly — covers
 * the states confirmPaymentReceived() doesn't drive automatically:
 * AUTHORIZED (the agent recorded that a supplier charge was attempted) and CANCELLED (this payment method was voided,
 * e.g. the customer wants to use a different card). PENDING/CONFIRMED/
 * FAILED can also be set here directly, but confirmPaymentReceived is the
 * normal path for CONFIRMED/FAILED since it also records the underlying
 * PaymentCharge.
 */
export async function updatePaymentMethodWorkflowStatus(input: z.infer<typeof updateWorkflowStatusSchema>) {
  const data = updateWorkflowStatusSchema.parse(input);
  const actor = await getCurrentAccount();
  if (!actor || actor.status !== "ACTIVE" || !canConfirmPayment(actor)) {
    throw new Error("You are not authorized to update payment method status");
  }

  // IDOR/BOLA protection — matching bookingId alone is not enough; the
  // booking itself must be one this account can see under normal
  // row-level scope (previously any account with payments.charge could
  // touch a payment method on ANY booking by id, regardless of ownership).
  const booking = await prisma.booking.findFirst({
    where: { id: data.bookingId, ...bookingVisibilityWhere(actor) },
    select: { id: true },
  });
  if (!booking) {
    throw new Error("This booking is not accessible");
  }

  const paymentMethod = await prisma.paymentMethod.findFirst({
    where: { id: data.paymentMethodId, bookingId: data.bookingId },
    select: { id: true },
  });
  if (!paymentMethod) {
    throw new Error("This payment method is not on file for this booking");
  }

  await prisma.paymentMethod.update({
    where: { id: paymentMethod.id },
    data: { workflowStatus: data.workflowStatus },
  });

  await logActivity({
    bookingId: data.bookingId,
    actorId: actor?.id,
    type: "PAYMENT_CONFIRMED",
    description: `Payment method status changed to ${data.workflowStatus}`,
  });

  revalidatePath(`/bookings/${data.bookingId}`);
}
