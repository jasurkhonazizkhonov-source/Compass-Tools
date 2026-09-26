"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canManageContactPaymentMethods, canDeletePaymentMethod } from "@/lib/permissions";
import { contactVisibilityWhere } from "@/server/visibility";
import { canAccessPaymentMethod } from "@/server/payment-method-access";
import { getPaymentVault } from "@/server/security/payment-vault";
import { CardVaultError, PURGED_REFERENCE } from "@/server/security/card-encryption";
import { checkAccountRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { auditCardEvent, type CardAuditAction } from "@/server/security/card-audit";
import { isValidCardNumber, isValidExpiry, detectCardBrand, lastFour, digitsOnly } from "@/lib/card-validation";
import { logActivity } from "@/server/activity-log";

const GENERIC_DENIAL = "You are not authorized to manage payment methods for this contact";
const GENERIC_VALIDATION_ERROR = "Payment information could not be processed";
const GENERIC_VAULT_ERROR = "We couldn't securely store this card right now. Nothing was saved.";

async function auditPaymentMethodMutation(params: {
  actorId: string | undefined;
  paymentMethodId: string;
  contactId: string | undefined | null;
  last4: string | undefined | null;
  action: Extract<CardAuditAction, "PAYMENT_METHOD_CREATED" | "PAYMENT_METHOD_EDITED" | "PAYMENT_METHOD_REMOVED" | "PAYMENT_METHOD_PURGED" | "PAYMENT_METHOD_MUTATION_DENIED" | "PAYMENT_METHOD_MUTATION_RATE_LIMITED" | "CARD_ENCRYPTION_FAILED">;
  success: boolean;
  reason?: string;
}) {
  // Never the PAN or CVV — only last4 (already-masked) and request context.
  await auditCardEvent({
    actorId: params.actorId,
    action: params.action,
    entityId: params.paymentMethodId,
    success: params.success,
    reason: params.reason,
    details: { contactId: params.contactId ?? null, last4: params.last4 ?? null },
  });
}

/** Per-account throttle for card mutations; an over-limit attempt is audited and refused. */
async function assertMutationAllowed(actorId: string, paymentMethodId: string, contactId: string | undefined | null) {
  const limit = await checkAccountRateLimit(actorId, "CARD_MUTATION", RATE_LIMITS.CARD_MUTATION);
  if (limit.allowed) return;
  await auditPaymentMethodMutation({ actorId, paymentMethodId, contactId, last4: undefined, action: "PAYMENT_METHOD_MUTATION_RATE_LIMITED", success: false, reason: "RATE_LIMITED" });
  throw new Error(`Too many card changes. Please wait ${Math.max(1, Math.ceil(limit.retryAfterSeconds / 60))} minute(s) and try again.`);
}

/** Encrypts under the row's own id; a vault failure is audited (fixed code only) and never partially saved. */
async function encryptForRow(actorId: string, paymentMethodId: string, contactId: string | null, digits: string): Promise<string> {
  try {
    return await getPaymentVault().store(digits, paymentMethodId);
  } catch (err) {
    await auditPaymentMethodMutation({
      actorId,
      paymentMethodId,
      contactId,
      last4: undefined,
      action: "CARD_ENCRYPTION_FAILED",
      success: false,
      reason: err instanceof CardVaultError ? err.code : "UNKNOWN",
    });
    throw new Error(GENERIC_VAULT_ERROR);
  }
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
 * submission. Compass Tools never collects, caches or stores a card security
 * code (CVV/CVC) for any card — see docs/PAYMENT_ARCHITECTURE.md.
 */
export async function addContactPaymentMethod(input: z.infer<typeof addCardSchema>) {
  const data = addCardSchema.parse(input);
  const actor = await getCurrentAccount();

  if (!actor || actor.status !== "ACTIVE" || !canManageContactPaymentMethods(actor)) {
    await auditPaymentMethodMutation({ actorId: actor?.id, paymentMethodId: "n/a", contactId: data.contactId, last4: undefined, action: "PAYMENT_METHOD_MUTATION_DENIED", success: false, reason: "MISSING_PERMISSION" });
    throw new Error(GENERIC_DENIAL);
  }
  await assertMutationAllowed(actor.id, "n/a", data.contactId);

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

  // The row id is chosen first so it can be bound into the ciphertext.
  const paymentMethodId = crypto.randomUUID();
  const encryptedPan = await encryptForRow(actor.id, paymentMethodId, contact.id, cardNumberDigits);
  const paymentMethod = await prisma.paymentMethod.create({
    data: {
      id: paymentMethodId,
      contactId: contact.id,
      cardholderName: data.cardholderName,
      encryptedPan,
      last4: lastFour(cardNumberDigits),
      cardBrand: cardBrand === "Unknown" ? undefined : cardBrand,
      expiryMonth: data.expiryMonth,
      expiryYear: data.expiryYear,
      consentGivenAt: new Date(),
    },
    select: { id: true, last4: true, cardBrand: true },
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
 * replace the PAN via secure re-entry. There is no security code anywhere in
 * this app, so editing a card can never surface one. A removed (archived /
 * purged) card cannot be edited.
 */
export async function editPaymentMethod(input: z.infer<typeof editCardSchema>) {
  const data = editCardSchema.parse(input);
  const actor = await getCurrentAccount();

  if (!actor || actor.status !== "ACTIVE" || !canManageContactPaymentMethods(actor)) {
    await auditPaymentMethodMutation({ actorId: actor?.id, paymentMethodId: data.paymentMethodId, contactId: undefined, last4: undefined, action: "PAYMENT_METHOD_MUTATION_DENIED", success: false, reason: "MISSING_PERMISSION" });
    throw new Error(GENERIC_DENIAL);
  }
  await assertMutationAllowed(actor.id, data.paymentMethodId, undefined);

  const existing = await prisma.paymentMethod.findUnique({
    where: { id: data.paymentMethodId },
    select: { id: true, bookingId: true, contactId: true, last4: true, status: true },
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
  if (existing.status === "ARCHIVED") {
    await auditPaymentMethodMutation({ actorId: actor.id, paymentMethodId: existing.id, contactId: existing.contactId, last4: existing.last4, action: "PAYMENT_METHOD_MUTATION_DENIED", success: false, reason: "CARD_REMOVED" });
    throw new Error("This card has been removed and can no longer be edited");
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
    updateData.encryptedPan = await encryptForRow(actor.id, existing.id, existing.contactId, digits);
    updateData.last4 = lastFour(digits);
    updateData.cardBrand = brand === "Unknown" ? undefined : brand;
  }

  const updated = await prisma.paymentMethod.update({
    where: { id: existing.id },
    data: updateData,
    select: { id: true, last4: true, cardBrand: true },
  });

  await auditPaymentMethodMutation({ actorId: actor.id, paymentMethodId: existing.id, contactId: existing.contactId, last4: updated.last4, action: "PAYMENT_METHOD_EDITED", success: true });
  await logActivity({ contactId: existing.contactId ?? undefined, actorId: actor.id, type: "PAYMENT_METHOD_EDITED", description: `Updated payment method ending ${updated.last4}` });

  if (existing.contactId) revalidatePath(`/contacts/${existing.contactId}`);
  if (existing.bookingId) revalidatePath(`/bookings/${existing.bookingId}`);
  return { id: updated.id, last4: updated.last4, cardBrand: updated.cardBrand };
}

/**
 * Removes a payment method. The row is kept (status=ARCHIVED, last4/brand/
 * expiry and its PaymentCharge history stay for accounting and audit) but the
 * ENCRYPTED CARD NUMBER IS DESTROYED in the same write: encryptedPan is
 * replaced by a tombstone and panPurgedAt is stamped, so a removed card can
 * never be decrypted again — not by Reveal, not by rotation. (Copies of the
 * old ciphertext in database backups persist until those backups expire; see
 * docs/CARD_VAULT_SECURITY.md.) Admin-only, and irreversible by design.
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
  await assertMutationAllowed(actor.id, paymentMethodId, undefined);

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

  await prisma.paymentMethod.update({
    where: { id: existing.id },
    data: { status: "ARCHIVED", encryptedPan: PURGED_REFERENCE, panPurgedAt: new Date() },
    select: { id: true },
  });

  await auditPaymentMethodMutation({ actorId: actor.id, paymentMethodId: existing.id, contactId: existing.contactId, last4: existing.last4, action: "PAYMENT_METHOD_REMOVED", success: true });
  await auditPaymentMethodMutation({ actorId: actor.id, paymentMethodId: existing.id, contactId: existing.contactId, last4: existing.last4, action: "PAYMENT_METHOD_PURGED", success: true });
  await logActivity({ contactId: existing.contactId ?? undefined, actorId: actor.id, type: "PAYMENT_METHOD_REMOVED", description: `Removed payment method ending ${existing.last4}` });

  if (existing.contactId) revalidatePath(`/contacts/${existing.contactId}`);
  if (existing.bookingId) revalidatePath(`/bookings/${existing.bookingId}`);
}
