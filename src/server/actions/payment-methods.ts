"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { logActivity } from "@/server/activity-log";
import { canRevealPaymentMethod, canConfirmPayment } from "@/lib/permissions";
import { getPaymentVault } from "@/server/security/payment-vault";
import { requireRecentAuthentication } from "@/server/security/privileged-access";
import { isChargeAmountAllowed } from "@/lib/payment-limits";
import { getClientIp } from "@/lib/request-ip";
import { destroyCvv } from "@/server/security/cvv-cache";
import { canAccessPaymentMethod } from "@/server/payment-method-access";
import { bookingVisibilityWhere } from "@/server/visibility";

async function auditPaymentMethodAccess(params: {
  actorId: string | undefined;
  paymentMethodId: string;
  bookingId: string | undefined | null;
  last4: string | undefined | null;
  success: boolean;
  reason?: string;
}) {
  let ip: string | undefined;
  try {
    ip = getClientIp(await headers());
  } catch {
    // headers() can throw outside a request context (e.g. a test harness) — audit logging must never block on it.
  }
  await prisma.auditLog.create({
    data: {
      actorId: params.actorId,
      action: params.success ? "PAYMENT_METHOD_REVEALED" : "PAYMENT_METHOD_REVEAL_DENIED",
      entityType: "PaymentMethod",
      entityId: params.paymentMethodId,
      // Deliberately never includes the PAN or CVV — only the last four
      // digits (already-masked data), never the full card number.
      metadata: {
        bookingId: params.bookingId ?? null,
        last4: params.last4 ?? null,
        result: params.success ? "SUCCESS" : "DENIED",
        reason: params.reason ?? null,
        ip: ip ?? null,
      },
    },
  });
}

const GENERIC_DENIAL = "You are not authorized to reveal this payment method";

/**
 * The privileged reveal workflow — every step below corresponds directly
 * to the numbered steps in the spec this was built against:
 *   1-3: authenticated session, active account, role + explicit
 *        payments.reveal permission (canRevealPaymentMethod checks both).
 *   4:   this specific booking's payment method, not just "any" — reuses
 *        the exact same bookingVisibilityWhere() every other booking-detail
 *        access goes through, so a restricted agent can't reveal a card on
 *        a booking outside their own scope even with payments.reveal.
 *   5-6: recent authentication / MFA — see requireRecentAuthentication in
 *        privileged-access.ts. Fails closed in production (no real MFA
 *        system exists yet); development explicitly reports
 *        NOT_AVAILABLE_IN_DEVELOPMENT and allows the action through.
 *   7:   audit event recorded for both success and denial.
 *   8-9: decrypt server-side via the PaymentVault abstraction, return only
 *        to this call's caller.
 *   10-11: auto-hide timeout + Hide button — implemented client-side in
 *        the component that calls this action, never here.
 *   12:  this is the only export in the codebase that ever reads
 *        encryptedPan — no other query/action touches that column.
 */
export async function revealPaymentMethod(paymentMethodId: string) {
  const actor = await getCurrentAccount();

  if (!actor || actor.status !== "ACTIVE") {
    await auditPaymentMethodAccess({ actorId: actor?.id, paymentMethodId, bookingId: undefined, last4: undefined, success: false, reason: "NO_ACTIVE_SESSION" });
    throw new Error(GENERIC_DENIAL);
  }
  if (!canRevealPaymentMethod(actor)) {
    await auditPaymentMethodAccess({ actorId: actor.id, paymentMethodId, bookingId: undefined, last4: undefined, success: false, reason: "MISSING_PERMISSION" });
    throw new Error(GENERIC_DENIAL);
  }

  const paymentMethod = await prisma.paymentMethod.findUnique({
    where: { id: paymentMethodId },
    select: { id: true, encryptedPan: true, cardholderName: true, cardBrand: true, expiryMonth: true, expiryYear: true, last4: true, bookingId: true, contactId: true },
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

  const stepUp = requireRecentAuthentication();
  if (!stepUp.ok) {
    await auditPaymentMethodAccess({ actorId: actor.id, paymentMethodId, bookingId: paymentMethod.bookingId, last4: paymentMethod.last4, success: false, reason: stepUp.reason });
    throw new Error(GENERIC_DENIAL);
  }

  const pan = await getPaymentVault().reveal(paymentMethod.encryptedPan);
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
  referenceNote: z.string().max(500).optional(),
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

  // Authorization success or failure is one of the required CVV-destruction
  // triggers — the supplier charge attempt this authorization existed for
  // is now over, one way or the other, so nothing should be able to reuse
  // that CVV afterward. Idempotent: a no-op if no authorization was active.
  destroyCvv(paymentMethod.id);

  await logActivity({
    bookingId: booking.id,
    leadId: booking.leadId,
    contactId: booking.contactId,
    actorId: actor?.id,
    type: "PAYMENT_CONFIRMED",
    description:
      data.status === "SUCCEEDED"
        ? `Payment of $${data.amount.toFixed(2)} confirmed manually`
        : `Payment attempt of $${data.amount.toFixed(2)} recorded as failed`,
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
 * AUTHORIZED (CVV entered, supplier charge attempted — see
 * cvv-authorization.ts) and CANCELLED (this payment method was voided,
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
