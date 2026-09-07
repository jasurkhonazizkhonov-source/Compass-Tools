"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canManageContactPaymentMethods, canDeletePaymentMethod } from "@/lib/permissions";
import { contactVisibilityWhere } from "@/server/visibility";
import { canAccessPaymentMethod } from "@/server/payment-method-access";
import { getPaymentVault } from "@/server/security/payment-vault";
import { isValidCardNumber, isValidExpiry, detectCardBrand, lastFour, digitsOnly } from "@/lib/card-validation";
import { getClientIp } from "@/lib/request-ip";
import { logActivity } from "@/server/activity-log";

const GENERIC_DENIAL = "You are not authorized to manage payment methods for this contact";
const GENERIC_VALIDATION_ERROR = "Payment information could not be processed";

async function auditPaymentMethodMutation(params: {
  actorId: string | undefined;
  paymentMethodId: string;
  contactId: string | undefined | null;
  last4: string | undefined | null;
  action: "PAYMENT_METHOD_CREATED" | "PAYMENT_METHOD_EDITED" | "PAYMENT_METHOD_REMOVED" | "PAYMENT_METHOD_MUTATION_DENIED";
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
      action: params.action,
      entityType: "PaymentMethod",
      entityId: params.paymentMethodId,
      // Never the PAN or CVV — only last4 (already-masked) and the
      // requesting actor's own IP, matching every other payment audit
      // record in this codebase.
      metadata: {
        contactId: params.contactId ?? null,
        last4: params.last4 ?? null,
        result: params.success ? "SUCCESS" : "DENIED",
        reason: params.reason ?? null,
        ip: ip ?? null,
      },
    },
  });
}

const addCardSchema = z.object({
  contactId: z.string(),
  cardholderName: z.string().min(1),
  cardNumber: z.string().min(12).max(23), // allows spaces; stripped before validation
  expiryMonth: z.number().int().min(1).max(12),
  expiryYear: z.number().int(),
});

/**
 * "+ Add Another Credit Card" from the Contact page — a card added directly
 * by an authorized agent, independent of any specific booking form
 * submission. Deliberately collects NO CVV: unlike a customer's own signed
 * booking-form submission (which has clear provenance for the transient
 * supplier-authorization workflow — see cvv-authorization.ts), a card
 * entered here has no signed-form artifact behind it, so there is no
 * legitimate channel to even transiently cache a CVV for it. If this card
 * is later used for a supplier charge, the agent obtains the CVV directly
 * from the customer for that call, same as any other card-not-present
 * phone transaction — never something this CRM stores or reveals.
 */
export async function addContactPaymentMethod(input: z.infer<typeof addCardSchema>) {
  const data = addCardSchema.parse(input);
  const actor = await getCurrentAccount();

  if (!actor || actor.status !== "ACTIVE" || !canManageContactPaymentMethods(actor)) {
    await auditPaymentMethodMutation({ actorId: actor?.id, paymentMethodId: "n/a", contactId: data.contactId, last4: undefined, action: "PAYMENT_METHOD_MUTATION_DENIED", success: false, reason: "MISSING_PERMISSION" });
    throw new Error(GENERIC_DENIAL);
  }

  // IDOR/BOLA protection — a valid contactId alone is not enough.
  const contact = await prisma.contact.findFirst({
    where: { id: data.contactId, ...contactVisibilityWhere(actor) },
    select: { id: true },
  });
  if (!contact) {
    await auditPaymentMethodMutation({ actorId: actor.id, paymentMethodId: "n/a", contactId: data.contactId, last4: undefined, action: "PAYMENT_METHOD_MUTATION_DENIED", success: false, reason: "CONTACT_NOT_ACCESSIBLE" });
    throw new Error(GENERIC_DENIAL);
  }

  const cardNumberDigits = digitsOnly(data.cardNumber);
  const cardBrand = detectCardBrand(cardNumberDigits);
  if (!isValidCardNumber(cardNumberDigits)) throw new Error(GENERIC_VALIDATION_ERROR);
  if (!isValidExpiry(data.expiryMonth, data.expiryYear)) throw new Error(GENERIC_VALIDATION_ERROR);

  const encryptedPan = await getPaymentVault().store(cardNumberDigits);
  const paymentMethod = await prisma.paymentMethod.create({
    data: {
      contactId: contact.id,
      cardholderName: data.cardholderName,
      encryptedPan,
      last4: lastFour(cardNumberDigits),
      cardBrand: cardBrand === "Unknown" ? undefined : cardBrand,
      expiryMonth: data.expiryMonth,
      expiryYear: data.expiryYear,
      consentGivenAt: new Date(),
    },
  });

  await auditPaymentMethodMutation({ actorId: actor.id, paymentMethodId: paymentMethod.id, contactId: contact.id, last4: paymentMethod.last4, action: "PAYMENT_METHOD_CREATED", success: true });
  await logActivity({ contactId: contact.id, actorId: actor.id, type: "PAYMENT_METHOD_ADDED", description: `Added a payment method (${paymentMethod.cardBrand ?? "card"} ending ${paymentMethod.last4})` });

  revalidatePath(`/contacts/${contact.id}`);
  return { id: paymentMethod.id, last4: paymentMethod.last4, cardBrand: paymentMethod.cardBrand };
}

const editCardSchema = z.object({
  paymentMethodId: z.string(),
  cardholderName: z.string().min(1),
  expiryMonth: z.number().int().min(1).max(12),
  expiryYear: z.number().int(),
  // Present only when the agent is replacing the PAN — requires the full
  // number to be securely re-entered; the existing PAN is never pre-filled,
  // decrypted for editing, or reused as a starting point.
  cardNumber: z.string().min(12).max(23).optional(),
});

/**
 * Edit a payment method's cardholder name/expiration, and optionally
 * replace the PAN via secure re-entry. Never touches CVV in any way — there
 * is no CVV to "keep" or "update"; editing a card must never surface a
 * historical CVV value merely because the record is being edited (§9).
 */
export async function editPaymentMethod(input: z.infer<typeof editCardSchema>) {
  const data = editCardSchema.parse(input);
  const actor = await getCurrentAccount();

  if (!actor || actor.status !== "ACTIVE" || !canManageContactPaymentMethods(actor)) {
    await auditPaymentMethodMutation({ actorId: actor?.id, paymentMethodId: data.paymentMethodId, contactId: undefined, last4: undefined, action: "PAYMENT_METHOD_MUTATION_DENIED", success: false, reason: "MISSING_PERMISSION" });
    throw new Error(GENERIC_DENIAL);
  }

  const existing = await prisma.paymentMethod.findUnique({
    where: { id: data.paymentMethodId },
    select: { id: true, bookingId: true, contactId: true, last4: true },
  });
  if (!existing) {
    await auditPaymentMethodMutation({ actorId: actor.id, paymentMethodId: data.paymentMethodId, contactId: undefined, last4: undefined, action: "PAYMENT_METHOD_MUTATION_DENIED", success: false, reason: "NOT_FOUND" });
    throw new Error(GENERIC_DENIAL);
  }

  const accessible = await canAccessPaymentMethod(actor, existing);
  if (!accessible) {
    await auditPaymentMethodMutation({ actorId: actor.id, paymentMethodId: existing.id, contactId: existing.contactId, last4: existing.last4, action: "PAYMENT_METHOD_MUTATION_DENIED", success: false, reason: "RECORD_NOT_ACCESSIBLE" });
    throw new Error(GENERIC_DENIAL);
  }

  if (!isValidExpiry(data.expiryMonth, data.expiryYear)) throw new Error(GENERIC_VALIDATION_ERROR);

  const updateData: {
    cardholderName: string;
    expiryMonth: number;
    expiryYear: number;
    encryptedPan?: string;
    last4?: string;
    cardBrand?: string;
  } = {
    cardholderName: data.cardholderName,
    expiryMonth: data.expiryMonth,
    expiryYear: data.expiryYear,
  };

  if (data.cardNumber) {
    const digits = digitsOnly(data.cardNumber);
    if (!isValidCardNumber(digits)) throw new Error(GENERIC_VALIDATION_ERROR);
    const brand = detectCardBrand(digits);
    updateData.encryptedPan = await getPaymentVault().store(digits);
    updateData.last4 = lastFour(digits);
    updateData.cardBrand = brand === "Unknown" ? undefined : brand;
  }

  const updated = await prisma.paymentMethod.update({ where: { id: existing.id }, data: updateData });

  await auditPaymentMethodMutation({ actorId: actor.id, paymentMethodId: existing.id, contactId: existing.contactId, last4: updated.last4, action: "PAYMENT_METHOD_EDITED", success: true });
  await logActivity({ contactId: existing.contactId ?? undefined, actorId: actor.id, type: "PAYMENT_METHOD_EDITED", description: `Updated payment method ending ${updated.last4}` });

  if (existing.contactId) revalidatePath(`/contacts/${existing.contactId}`);
  if (existing.bookingId) revalidatePath(`/bookings/${existing.bookingId}`);
  return { id: updated.id, last4: updated.last4, cardBrand: updated.cardBrand };
}

/**
 * Removes (soft-deletes via status=ARCHIVED, never a hard DELETE) a payment
 * method — preserves its PaymentCharge/audit history rather than losing it,
 * consistent with this app's "disable, never delete" pattern elsewhere
 * (accounts, etc.). An archived card is excluded from the active Payment
 * Methods list but its history remains intact for audit purposes.
 */
export async function removePaymentMethod(paymentMethodId: string) {
  const actor = await getCurrentAccount();

  // Deliberately admin-only (canDeletePaymentMethod), narrower than the
  // canManageContactPaymentMethods ceiling add/edit still use — see that
  // function's own doc comment for why.
  if (!actor || actor.status !== "ACTIVE" || !canDeletePaymentMethod(actor)) {
    await auditPaymentMethodMutation({ actorId: actor?.id, paymentMethodId, contactId: undefined, last4: undefined, action: "PAYMENT_METHOD_MUTATION_DENIED", success: false, reason: "MISSING_PERMISSION" });
    throw new Error(GENERIC_DENIAL);
  }

  const existing = await prisma.paymentMethod.findUnique({
    where: { id: paymentMethodId },
    select: { id: true, bookingId: true, contactId: true, last4: true },
  });
  if (!existing) {
    await auditPaymentMethodMutation({ actorId: actor.id, paymentMethodId, contactId: undefined, last4: undefined, action: "PAYMENT_METHOD_MUTATION_DENIED", success: false, reason: "NOT_FOUND" });
    throw new Error(GENERIC_DENIAL);
  }

  const accessible = await canAccessPaymentMethod(actor, existing);
  if (!accessible) {
    await auditPaymentMethodMutation({ actorId: actor.id, paymentMethodId: existing.id, contactId: existing.contactId, last4: existing.last4, action: "PAYMENT_METHOD_MUTATION_DENIED", success: false, reason: "RECORD_NOT_ACCESSIBLE" });
    throw new Error(GENERIC_DENIAL);
  }

  await prisma.paymentMethod.update({ where: { id: existing.id }, data: { status: "ARCHIVED" } });

  await auditPaymentMethodMutation({ actorId: actor.id, paymentMethodId: existing.id, contactId: existing.contactId, last4: existing.last4, action: "PAYMENT_METHOD_REMOVED", success: true });
  await logActivity({ contactId: existing.contactId ?? undefined, actorId: actor.id, type: "PAYMENT_METHOD_REMOVED", description: `Removed payment method ending ${existing.last4}` });

  if (existing.contactId) revalidatePath(`/contacts/${existing.contactId}`);
  if (existing.bookingId) revalidatePath(`/bookings/${existing.bookingId}`);
}
