"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { logActivity } from "@/server/activity-log";
import { canConfirmPayment } from "@/lib/permissions";
import { isChargeAmountAllowed } from "@/lib/payment-limits";
import { bookingVisibilityWhere } from "@/server/visibility";
import { formatMoney, isSupportedCurrency } from "@/lib/currency";

// There is intentionally NO "reveal card number" action in this file (or
// anywhere): payment methods are vaulted by the payment provider, so Compass
// Tools holds no card number to reveal. Charging is done through the provider
// (see src/server/actions/manual-charge.ts). What remains here is RECORD
// keeping for payments an agent made outside the CRM.

const confirmPaymentSchema = z.object({
  bookingId: z.string(),
  paymentMethodId: z.string(),
  amount: z.number().positive(),
  status: z.enum(["SUCCEEDED", "FAILED"]),
  // A card number pasted into a free-text note must never be stored.
  referenceNote: z
    .string()
    .max(500)
    .refine((v) => !/(?:d[ -]?){13,19}/.test(v), "Never put card numbers in a note")
    .optional(),
});

/**
 * RECORD-ONLY: an authorized human (payments.charge) attests that a payment
 * was taken OUTSIDE the CRM (for example directly with the airline or supplier)
 * and records the outcome. Charging the vaulted card through the payment
 * provider is a different, Admin-only action (manual-charge.ts) that moves real
 * money and is verified by the provider; this one only writes a note. A booking may have multiple payment
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
        ? `Payment of ${formatMoney(data.amount, chargeCurrency)} recorded as received (taken outside the CRM)`
        : `Payment attempt of ${formatMoney(data.amount, chargeCurrency)} recorded as failed (taken outside the CRM)`,
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
