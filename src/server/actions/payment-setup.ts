"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { isQuoteBookable } from "@/lib/exchange-proposal";
import { checkPublicRateLimitFromRequest, RATE_LIMITS } from "@/server/security/rate-limit";
import { getPaymentProvider, PaymentProviderError } from "@/server/payments/provider";
import { getOrCreateProviderCustomer } from "@/server/payments/vaulted-methods";
import { recordHealthEvent } from "@/server/system/health-events";
import { safeErrorTag } from "@/lib/safe-error-log";

const setupSchema = z.object({
  token: z.string().min(1).max(200),
  /**
   * Client-generated, stable per card slot per form visit. It is the provider
   * idempotency key: a retried request (double click, refresh, network retry)
   * gets the SAME setup back instead of creating another one.
   */
  slotKey: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
});

export type CreatePaymentSetupResult = { ok: true; clientSecret: string; setupIntentId: string } | { ok: false; error: string };

/**
 * Public (customer, secureToken-authorized) step 1 of adding a card to a
 * booking: creates a provider SetupIntent the browser then completes inside the
 * provider's hosted card fields. The response carries only a one-purpose client
 * secret — no card data flows through this action, in either direction.
 */
export async function createBookingPaymentSetup(input: z.input<typeof setupSchema>): Promise<CreatePaymentSetupResult> {
  const parsed = setupSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Something went wrong. Please reload the page and try again." };

  try {
    const limit = await checkPublicRateLimitFromRequest("PAYMENT_SETUP", RATE_LIMITS.PAYMENT_SETUP);
    if (!limit.allowed) return { ok: false, error: "Too many attempts from this connection. Please wait a few minutes and try again." };
  } catch (err) {
    // An anti-abuse control must not itself block a customer if the database hiccups.
    console.error(`[payment-setup] RATE_LIMIT_CHECK_FAILED (${safeErrorTag(err)})`);
  }

  const provider = getPaymentProvider();
  if (!provider) return { ok: false, error: "Online booking is temporarily unavailable. Please contact your travel agent." };

  const quote = await prisma.quote.findUnique({ where: { secureToken: parsed.data.token }, select: { id: true, status: true, contactId: true, booking: { select: { id: true } } } });
  // Same answer for "no such quote", "already booked" and "not bookable": nothing to enumerate.
  if (!quote || quote.booking || !isQuoteBookable(quote.status)) return { ok: false, error: "This link is no longer active. Please contact your travel agent." };

  try {
    const customerId = await getOrCreateProviderCustomer(quote.contactId, provider);
    const session = await provider.createSetupSession({
      customerId,
      metadata: { quoteId: quote.id, purpose: "booking" },
      idempotencyKey: `si-${quote.id}-${parsed.data.slotKey}`,
    });
    return { ok: true, clientSecret: session.clientSecret, setupIntentId: session.setupIntentId };
  } catch (err) {
    const category = err instanceof PaymentProviderError ? err.category : "unknown";
    console.error(`[payment-setup] SETUP_FAILED category=${category}`);
    await recordHealthEvent({
      type: "PAYMENT_PROVIDER_ERROR",
      category: "payment",
      severity: category === "invalid_request" ? "CRITICAL" : "WARNING",
      discriminator: "create_setup",
      message: "The payment provider could not start a card capture for a customer's booking.",
      metadata: { providerCategory: category, code: err instanceof PaymentProviderError ? err.code : undefined },
    });
    return { ok: false, error: "We couldn't start secure card entry right now. Nothing was charged. Please try again in a moment." };
  }
}
