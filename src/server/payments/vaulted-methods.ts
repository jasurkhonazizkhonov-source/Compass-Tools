// Server-side handling of provider-vaulted payment methods: finding/creating
// the provider customer for a contact, and turning a completed hosted-field
// capture (a SetupIntent id) into verified, storable, NON-SENSITIVE metadata.
//
// Plain server module — not a "use server" file. Nothing here ever sees a card
// number or security code: the browser sent those straight to the provider.
import { prisma } from "@/lib/prisma";
import { isValidExpiry } from "@/lib/card-validation";
import { getPaymentProvider, PaymentProviderError } from "@/server/payments/provider";
import type { PaymentProviderAdapter } from "@/server/payments/provider";

/** Friendly card-brand names as shown in the CRM (the provider returns lowercase ids). */
const BRAND_LABELS: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
};

export function brandLabel(brand: string | null | undefined): string | null {
  if (!brand) return null;
  return BRAND_LABELS[brand.toLowerCase()] ?? null;
}

export type VerifiedVaultedMethod = {
  provider: string;
  providerCustomerId: string;
  providerPaymentMethodId: string;
  providerSetupIntentId: string;
  cardBrand: string | null;
  last4: string;
  expiryMonth: number;
  expiryYear: number;
  cardFunding: string | null;
  /** Name as the provider recorded it, when it did (we still store the name the customer typed). */
  providerCardholderName: string | null;
};

export type VerifyFailure =
  | "not_configured"
  | "not_completed"
  | "mismatch"
  | "invalid_card"
  | "already_used"
  | "provider_unavailable";

export type VerifyResult = { ok: true; method: VerifiedVaultedMethod } | { ok: false; reason: VerifyFailure; category?: string };

/**
 * Authoritative server-side check of a completed capture. The browser only
 * hands us a SetupIntent id; everything else comes from the provider's own
 * API, so a forged or tampered client claim cannot produce a vaulted method.
 *
 * `expected` binds the capture to the record it is for (a quote for a customer
 * booking, a contact for a card added from the Contact page): a capture made
 * for one customer's booking can never be attached to another's.
 */
export async function verifyVaultedSetup(
  setupIntentId: string,
  expected: { quoteId?: string; contactId?: string; providerCustomerId?: string | null },
  provider: PaymentProviderAdapter | null = getPaymentProvider()
): Promise<VerifyResult> {
  if (!provider) return { ok: false, reason: "not_configured" };
  if (!/^[A-Za-z0-9_]{6,80}$/.test(setupIntentId)) return { ok: false, reason: "not_completed" };

  let setup;
  try {
    setup = await provider.retrieveSetup(setupIntentId);
  } catch (err) {
    if (err instanceof PaymentProviderError && err.httpStatus === 404) return { ok: false, reason: "not_completed", category: err.category };
    return { ok: false, reason: "provider_unavailable", category: err instanceof PaymentProviderError ? err.category : "unknown" };
  }

  if (setup.status !== "succeeded" || !setup.paymentMethodId || !setup.customerId || !setup.card) return { ok: false, reason: "not_completed" };
  if (expected.quoteId && setup.metadata.quoteId !== expected.quoteId) return { ok: false, reason: "mismatch" };
  if (expected.contactId && setup.metadata.contactId !== expected.contactId) return { ok: false, reason: "mismatch" };
  if (expected.providerCustomerId && setup.customerId !== expected.providerCustomerId) return { ok: false, reason: "mismatch" };
  if (!isValidExpiry(setup.card.expMonth, setup.card.expYear) || !/^\d{4}$/.test(setup.card.last4)) return { ok: false, reason: "invalid_card" };

  const existing = await prisma.paymentMethod.findUnique({ where: { providerSetupIntentId: setup.setupIntentId }, select: { id: true } });
  if (existing) return { ok: false, reason: "already_used" };

  return {
    ok: true,
    method: {
      provider: provider.id,
      providerCustomerId: setup.customerId,
      providerPaymentMethodId: setup.paymentMethodId,
      providerSetupIntentId: setup.setupIntentId,
      cardBrand: brandLabel(setup.card.brand),
      last4: setup.card.last4,
      expiryMonth: setup.card.expMonth,
      expiryYear: setup.card.expYear,
      cardFunding: setup.card.funding,
      providerCardholderName: setup.card.cardholderName,
    },
  };
}

/**
 * The provider customer for a contact: reused when one is stored (so all of a
 * contact's vaulted methods live under one customer), otherwise created with a
 * deterministic idempotency key and persisted with a conditional write so two
 * concurrent first-time requests converge on ONE customer.
 */
export async function getOrCreateProviderCustomer(contactId: string, provider: PaymentProviderAdapter): Promise<string> {
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { firstName: true, lastName: true, primaryEmail: true, providerCustomerId: true },
  });
  if (!contact) throw new Error("Contact not found");

  const { customerId } = await provider.ensureCustomer({
    existingCustomerId: contact.providerCustomerId,
    contactId,
    name: `${contact.firstName} ${contact.lastName}`.trim() || "Customer",
    email: contact.primaryEmail,
    idempotencyKey: `cust-${contactId}`,
  });

  if (customerId !== contact.providerCustomerId) {
    // Only claim the slot if it is still empty or still the stale value we
    // read — a concurrent request that stored a customer first wins, and we
    // then use ITS customer (ours becomes an unused, harmless duplicate).
    const claimed = await prisma.contact.updateMany({
      where: { id: contactId, providerCustomerId: contact.providerCustomerId },
      data: { providerCustomerId: customerId },
    });
    if (claimed.count === 0) {
      const winner = await prisma.contact.findUnique({ where: { id: contactId }, select: { providerCustomerId: true } });
      if (winner?.providerCustomerId) return winner.providerCustomerId;
    }
  }
  return customerId;
}
