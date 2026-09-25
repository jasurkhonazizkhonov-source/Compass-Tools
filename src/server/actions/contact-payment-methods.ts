"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canManageContactPaymentMethods, canDeletePaymentMethod } from "@/lib/permissions";
import { contactVisibilityWhere } from "@/server/visibility";
import { canAccessPaymentMethod } from "@/server/payment-method-access";
import { getClientIp } from "@/lib/request-ip";
import { logActivity } from "@/server/activity-log";
import { getPaymentProvider, PaymentProviderError } from "@/server/payments/provider";
import { getOrCreateProviderCustomer, verifyVaultedSetup } from "@/server/payments/vaulted-methods";
import { recordHealthEvent } from "@/server/system/health-events";

const GENERIC_DENIAL = "You are not authorized to manage payment methods for this contact";
const GENERIC_VALIDATION_ERROR = "Payment information could not be processed";

type Action = "PAYMENT_METHOD_CREATED" | "PAYMENT_METHOD_EDITED" | "PAYMENT_METHOD_REMOVED" | "PAYMENT_METHOD_MUTATION_DENIED";

async function auditPaymentMethodMutation(params: {
  actorId: string | undefined;
  paymentMethodId: string;
  contactId: string | undefined | null;
  last4: string | undefined | null;
  action: Action;
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
      // Never a card number or security code — only last4 (already masked)
      // and the requesting actor's own IP.
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

/** Shared gate for adding a card to a contact: signed in, allowed, and the contact is one this account can see. */
async function authorizeContact(contactId: string) {
  const actor = await getCurrentAccount();
  if (!actor || actor.status !== "ACTIVE" || !canManageContactPaymentMethods(actor)) {
    await auditPaymentMethodMutation({ actorId: actor?.id, paymentMethodId: "n/a", contactId, last4: undefined, action: "PAYMENT_METHOD_MUTATION_DENIED", success: false, reason: "MISSING_PERMISSION" });
    throw new Error(GENERIC_DENIAL);
  }
  // IDOR/BOLA protection — a valid contactId alone is not enough.
  const contact = await prisma.contact.findFirst({ where: { id: contactId, ...contactVisibilityWhere(actor) }, select: { id: true, providerCustomerId: true } });
  if (!contact) {
    await auditPaymentMethodMutation({ actorId: actor.id, paymentMethodId: "n/a", contactId, last4: undefined, action: "PAYMENT_METHOD_MUTATION_DENIED", success: false, reason: "CONTACT_NOT_ACCESSIBLE" });
    throw new Error(GENERIC_DENIAL);
  }
  return { actor, contact };
}

const setupSchema = z.object({ contactId: z.string().min(1), slotKey: z.string().regex(/^[A-Za-z0-9-]{8,64}$/) });

export type ContactSetupResult = { ok: true; clientSecret: string; setupIntentId: string } | { ok: false; error: string };

/**
 * Step 1 of "+ Add Another Credit Card" on the Contact page: starts a provider
 * capture. The staff member then types the card into the provider's hosted
 * fields (never into this app), exactly like a customer would on the booking
 * form.
 */
export async function createContactPaymentSetup(input: z.input<typeof setupSchema>): Promise<ContactSetupResult> {
  const data = setupSchema.parse(input);
  const { contact } = await authorizeContact(data.contactId);
  const provider = getPaymentProvider();
  if (!provider) return { ok: false, error: "No payment provider is configured, so a card can't be added right now." };
  try {
    const customerId = await getOrCreateProviderCustomer(contact.id, provider);
    const session = await provider.createSetupSession({ customerId, metadata: { contactId: contact.id, purpose: "contact" }, idempotencyKey: `si-contact-${contact.id}-${data.slotKey}` });
    return { ok: true, clientSecret: session.clientSecret, setupIntentId: session.setupIntentId };
  } catch (err) {
    await recordHealthEvent({
      type: "PAYMENT_PROVIDER_ERROR",
      category: "payment",
      severity: "WARNING",
      discriminator: "create_setup_contact",
      message: "The payment provider could not start a card capture from a contact page.",
      metadata: { providerCategory: err instanceof PaymentProviderError ? err.category : "unknown" },
    });
    return { ok: false, error: "The payment provider could not start secure card entry. Please try again." };
  }
}

const saveSchema = z.object({ contactId: z.string().min(1), setupIntentId: z.string().min(6).max(80), cardholderName: z.string().trim().min(1).max(200) });

/**
 * Step 2: after the provider confirmed the capture in the browser, verify it
 * server-side (authoritative) and record the vaulted method — provider
 * references plus brand/last4/expiry, never a card number or security code.
 */
export async function saveContactPaymentMethod(input: z.input<typeof saveSchema>) {
  const data = saveSchema.parse(input);
  const { actor, contact } = await authorizeContact(data.contactId);

  const verified = await verifyVaultedSetup(data.setupIntentId, { contactId: contact.id, providerCustomerId: contact.providerCustomerId });
  if (!verified.ok) {
    if (verified.reason === "provider_unavailable" || verified.reason === "not_configured") throw new Error("The payment provider could not be reached to confirm this card. Nothing was saved. Please try again.");
    throw new Error(GENERIC_VALIDATION_ERROR);
  }
  const m = verified.method;
  const paymentMethod = await prisma.paymentMethod.create({
    data: {
      contactId: contact.id,
      cardholderName: data.cardholderName,
      provider: m.provider,
      providerCustomerId: m.providerCustomerId,
      providerPaymentMethodId: m.providerPaymentMethodId,
      providerSetupIntentId: m.providerSetupIntentId,
      cardFunding: m.cardFunding,
      vaultStatus: "VAULTED",
      last4: m.last4,
      cardBrand: m.cardBrand,
      expiryMonth: m.expiryMonth,
      expiryYear: m.expiryYear,
      consentGivenAt: new Date(),
    },
  });

  await auditPaymentMethodMutation({ actorId: actor.id, paymentMethodId: paymentMethod.id, contactId: contact.id, last4: paymentMethod.last4, action: "PAYMENT_METHOD_CREATED", success: true });
  await logActivity({ contactId: contact.id, actorId: actor.id, type: "PAYMENT_METHOD_ADDED", description: `Added a payment method (${paymentMethod.cardBrand ?? "card"} ending ${paymentMethod.last4})` });

  revalidatePath(`/contacts/${contact.id}`);
  return { id: paymentMethod.id, last4: paymentMethod.last4, cardBrand: paymentMethod.cardBrand };
}

const editCardSchema = z.object({ paymentMethodId: z.string(), cardholderName: z.string().trim().min(1).max(200) });

/**
 * Edit the cardholder name on a saved payment method. The card itself (number,
 * expiry) lives with the payment provider and cannot be edited here — to change
 * a card, add a new one and remove the old one.
 */
export async function editPaymentMethod(input: z.infer<typeof editCardSchema>) {
  const data = editCardSchema.parse(input);
  const actor = await getCurrentAccount();

  if (!actor || actor.status !== "ACTIVE" || !canManageContactPaymentMethods(actor)) {
    await auditPaymentMethodMutation({ actorId: actor?.id, paymentMethodId: data.paymentMethodId, contactId: undefined, last4: undefined, action: "PAYMENT_METHOD_MUTATION_DENIED", success: false, reason: "MISSING_PERMISSION" });
    throw new Error(GENERIC_DENIAL);
  }

  const existing = await prisma.paymentMethod.findUnique({ where: { id: data.paymentMethodId }, select: { id: true, bookingId: true, contactId: true, last4: true } });
  if (!existing) {
    await auditPaymentMethodMutation({ actorId: actor.id, paymentMethodId: data.paymentMethodId, contactId: undefined, last4: undefined, action: "PAYMENT_METHOD_MUTATION_DENIED", success: false, reason: "NOT_FOUND" });
    throw new Error(GENERIC_DENIAL);
  }
  if (!(await canAccessPaymentMethod(actor, existing))) {
    await auditPaymentMethodMutation({ actorId: actor.id, paymentMethodId: existing.id, contactId: existing.contactId, last4: existing.last4, action: "PAYMENT_METHOD_MUTATION_DENIED", success: false, reason: "RECORD_NOT_ACCESSIBLE" });
    throw new Error(GENERIC_DENIAL);
  }

  const updated = await prisma.paymentMethod.update({ where: { id: existing.id }, data: { cardholderName: data.cardholderName } });

  await auditPaymentMethodMutation({ actorId: actor.id, paymentMethodId: existing.id, contactId: existing.contactId, last4: updated.last4, action: "PAYMENT_METHOD_EDITED", success: true });
  await logActivity({ contactId: existing.contactId ?? undefined, actorId: actor.id, type: "PAYMENT_METHOD_EDITED", description: `Updated payment method ending ${updated.last4}` });

  if (existing.contactId) revalidatePath(`/contacts/${existing.contactId}`);
  if (existing.bookingId) revalidatePath(`/bookings/${existing.bookingId}`);
  return { id: updated.id, last4: updated.last4, cardBrand: updated.cardBrand };
}

/**
 * Removes a payment method: the vaulted credential is DETACHED at the payment
 * provider first (so it can no longer be charged by anyone), then the record is
 * soft-deleted (status=ARCHIVED, never a hard DELETE) so its PaymentCharge and
 * audit history survive. If the provider cannot be reached the removal is
 * refused — never leave a chargeable credential behind a card the CRM shows as
 * removed.
 */
export async function removePaymentMethod(paymentMethodId: string) {
  const actor = await getCurrentAccount();

  // Deliberately admin-only (canDeletePaymentMethod), narrower than the
  // canManageContactPaymentMethods ceiling add/edit use.
  if (!actor || actor.status !== "ACTIVE" || !canDeletePaymentMethod(actor)) {
    await auditPaymentMethodMutation({ actorId: actor?.id, paymentMethodId, contactId: undefined, last4: undefined, action: "PAYMENT_METHOD_MUTATION_DENIED", success: false, reason: "MISSING_PERMISSION" });
    throw new Error(GENERIC_DENIAL);
  }

  const existing = await prisma.paymentMethod.findUnique({
    where: { id: paymentMethodId },
    select: { id: true, bookingId: true, contactId: true, last4: true, vaultStatus: true, providerPaymentMethodId: true },
  });
  if (!existing) {
    await auditPaymentMethodMutation({ actorId: actor.id, paymentMethodId, contactId: undefined, last4: undefined, action: "PAYMENT_METHOD_MUTATION_DENIED", success: false, reason: "NOT_FOUND" });
    throw new Error(GENERIC_DENIAL);
  }
  if (!(await canAccessPaymentMethod(actor, existing))) {
    await auditPaymentMethodMutation({ actorId: actor.id, paymentMethodId: existing.id, contactId: existing.contactId, last4: existing.last4, action: "PAYMENT_METHOD_MUTATION_DENIED", success: false, reason: "RECORD_NOT_ACCESSIBLE" });
    throw new Error(GENERIC_DENIAL);
  }

  if (existing.vaultStatus === "VAULTED" && existing.providerPaymentMethodId) {
    const provider = getPaymentProvider();
    if (!provider) throw new Error("The payment provider isn't available, so this card can't be removed safely right now. Try again once it is.");
    try {
      await provider.detachPaymentMethod(existing.providerPaymentMethodId);
    } catch {
      throw new Error("The payment provider could not remove this card. Nothing was changed. Please try again.");
    }
  }

  await prisma.paymentMethod.update({ where: { id: existing.id }, data: { status: "ARCHIVED", ...(existing.vaultStatus === "VAULTED" ? { vaultStatus: "DETACHED" as const } : {}) } });

  await auditPaymentMethodMutation({ actorId: actor.id, paymentMethodId: existing.id, contactId: existing.contactId, last4: existing.last4, action: "PAYMENT_METHOD_REMOVED", success: true });
  await logActivity({ contactId: existing.contactId ?? undefined, actorId: actor.id, type: "PAYMENT_METHOD_REMOVED", description: `Removed payment method ending ${existing.last4}` });

  if (existing.contactId) revalidatePath(`/contacts/${existing.contactId}`);
  if (existing.bookingId) revalidatePath(`/bookings/${existing.bookingId}`);
}
