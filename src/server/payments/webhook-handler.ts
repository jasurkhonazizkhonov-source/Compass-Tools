// Applies a VERIFIED provider webhook event. The caller (the route) has already
// checked the provider's signature over the raw body; nothing here trusts
// anything a browser said. Handling is:
//   - idempotent: a per-event ledger row (PaymentWebhookEvent) makes a
//     duplicate or replayed delivery a no-op;
//   - order-tolerant: every state change goes through applyChargeOutcome's
//     forward-only rules, so a late "failed" cannot undo a "succeeded";
//   - quiet about content: no payload is stored or logged, only ids and types.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { applyChargeOutcome, fromMinorUnits } from "@/server/payments/charge-state";
import type { ProviderEvent } from "@/server/payments/types";

export type WebhookOutcome = "processed" | "duplicate" | "ignored" | "unknown_charge";

const SAFE_CODE_RE = /^[a-z0-9_]{1,60}$/;
const safeCode = (v: unknown): string | undefined => (typeof v === "string" && SAFE_CODE_RE.test(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= 120 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

async function findCharge(object: Record<string, unknown>, paymentIntentId: string | undefined) {
  if (paymentIntentId) {
    const byIntent = await prisma.paymentCharge.findUnique({ where: { providerPaymentIntentId: paymentIntentId }, select: { id: true, status: true, amount: true } });
    if (byIntent) return byIntent;
  }
  // The charge id we put in the PaymentIntent's metadata when we created it.
  const metadata = object.metadata as Record<string, unknown> | undefined;
  const chargeId = str(metadata?.chargeId);
  if (chargeId) return prisma.paymentCharge.findUnique({ where: { id: chargeId }, select: { id: true, status: true, amount: true } });
  return null;
}

async function dispatch(event: ProviderEvent): Promise<WebhookOutcome> {
  const object = event.data.object;
  switch (event.type) {
    case "payment_intent.succeeded":
    case "payment_intent.processing":
    case "payment_intent.payment_failed":
    case "payment_intent.canceled": {
      const piId = str(object.id);
      const charge = await findCharge(object, piId);
      if (!charge) return "unknown_charge";
      if (event.type === "payment_intent.succeeded") await applyChargeOutcome({ chargeId: charge.id, outcome: "SUCCEEDED", paymentIntentId: piId });
      else if (event.type === "payment_intent.processing") await applyChargeOutcome({ chargeId: charge.id, outcome: "PENDING", paymentIntentId: piId });
      else if (event.type === "payment_intent.canceled") await applyChargeOutcome({ chargeId: charge.id, outcome: "CANCELED", paymentIntentId: piId });
      else {
        const err = (object.last_payment_error ?? {}) as Record<string, unknown>;
        const code = safeCode(err.decline_code) ?? safeCode(err.code);
        await applyChargeOutcome({
          chargeId: charge.id,
          outcome: "FAILED",
          paymentIntentId: piId,
          failureCategory: err.type === "card_error" ? "declined" : "unknown",
          failureCode: code,
          errorMessage: err.type === "card_error" ? "The card was declined." : "The payment provider reported the charge failed.",
        });
      }
      return "processed";
    }
    case "charge.refunded": {
      // amount_refunded is cumulative, so applying it is idempotent by nature.
      const piId = str(object.payment_intent);
      const total = num(object.amount);
      const refunded = num(object.amount_refunded);
      if (!piId || total === undefined || refunded === undefined) return "ignored";
      const charge = await findCharge({}, piId);
      if (!charge) return "unknown_charge";
      const full = refunded >= total;
      await prisma.paymentCharge.updateMany({
        where: { id: charge.id, status: { in: ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"] } },
        data: { refundedAmount: fromMinorUnits(refunded), status: full ? "REFUNDED" : "PARTIALLY_REFUNDED" },
      });
      return "processed";
    }
    case "payment_method.detached": {
      const pmId = str(object.id);
      if (!pmId) return "ignored";
      await prisma.paymentMethod.updateMany({ where: { providerPaymentMethodId: pmId, vaultStatus: "VAULTED" }, data: { vaultStatus: "DETACHED" } });
      return "processed";
    }
    default:
      return "ignored";
  }
}

export async function handleVerifiedWebhook(provider: string, event: ProviderEvent): Promise<WebhookOutcome> {
  try {
    await prisma.paymentWebhookEvent.create({ data: { id: event.id, provider, type: event.type.slice(0, 80) } });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    const seen = await prisma.paymentWebhookEvent.findUnique({ where: { id: event.id }, select: { processedAt: true } });
    // A ledger row that was never completed means the first delivery crashed
    // mid-way: process it again (every step above is idempotent).
    if (seen?.processedAt) return "duplicate";
  }
  const outcome = await dispatch(event);
  await prisma.paymentWebhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), outcome } });
  return outcome;
}
