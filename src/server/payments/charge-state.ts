// The single place a PaymentCharge's status is advanced. Both the synchronous
// result of a manual charge and the provider's signed webhooks funnel through
// applyChargeOutcome(), so the rules can't drift apart:
//   - forward-only: SUCCEEDED is never overwritten by a late FAILED/CANCELED;
//     a refund state is never overwritten by a late SUCCEEDED;
//   - idempotent: applying the same outcome twice is a no-op;
//   - the PaymentMethod's workflowStatus follows the charges (CONFIRMED once
//     the allocated amount has been collected, AUTHORIZED for a partial one,
//     FAILED when nothing succeeded).
import { prisma } from "@/lib/prisma";
import type { PaymentChargeStatus } from "@/generated/prisma/client";

export function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}
export function fromMinorUnits(minor: number): number {
  return minor / 100;
}

export type ChargeOutcome = "SUCCEEDED" | "FAILED" | "CANCELED" | "PENDING";

/** Which existing statuses an incoming outcome is allowed to replace. */
const REPLACEABLE: Record<ChargeOutcome, PaymentChargeStatus[]> = {
  PENDING: ["PENDING"],
  SUCCEEDED: ["PENDING", "FAILED"],
  FAILED: ["PENDING"],
  CANCELED: ["PENDING"],
};

export async function applyChargeOutcome(params: {
  chargeId: string;
  outcome: ChargeOutcome;
  paymentIntentId?: string;
  failureCategory?: string;
  failureCode?: string;
  errorMessage?: string;
}): Promise<{ applied: boolean }> {
  const { chargeId, outcome } = params;
  // One conditional UPDATE: the status check and the write cannot be split by a concurrent webhook.
  const updated = await prisma.paymentCharge.updateMany({
    where: { id: chargeId, status: { in: REPLACEABLE[outcome] } },
    data: {
      status: outcome,
      ...(params.paymentIntentId ? { providerPaymentIntentId: params.paymentIntentId } : {}),
      ...(outcome === "FAILED"
        ? { failureCategory: params.failureCategory ?? "unknown", failureCode: params.failureCode ?? null, errorMessage: params.errorMessage ?? null }
        : {}),
    },
  });
  if (updated.count === 0 && params.paymentIntentId) {
    // Keep the provider reference even when the status was already final.
    await prisma.paymentCharge.updateMany({ where: { id: chargeId, providerPaymentIntentId: null }, data: { providerPaymentIntentId: params.paymentIntentId } });
  }
  if (updated.count > 0 && outcome !== "PENDING") await syncMethodWorkflow(chargeId);
  return { applied: updated.count > 0 };
}

async function syncMethodWorkflow(chargeId: string) {
  const charge = await prisma.paymentCharge.findUnique({ where: { id: chargeId }, select: { paymentMethodId: true } });
  if (!charge) return;
  const method = await prisma.paymentMethod.findUnique({
    where: { id: charge.paymentMethodId },
    select: { id: true, amountAllocated: true, charges: { where: { provider: { not: null } }, select: { amount: true, refundedAmount: true, status: true } } },
  });
  if (!method) return;
  const collected = method.charges
    .filter((c) => c.status === "SUCCEEDED" || c.status === "PARTIALLY_REFUNDED")
    .reduce((sum, c) => sum + toMinorUnits(Number(c.amount)) - toMinorUnits(Number(c.refundedAmount)), 0);
  const allocated = toMinorUnits(Number(method.amountAllocated ?? 0));
  const anyPending = method.charges.some((c) => c.status === "PENDING");
  const anySucceeded = method.charges.some((c) => c.status === "SUCCEEDED" || c.status === "PARTIALLY_REFUNDED");
  const next = collected > 0 && collected >= allocated ? "CONFIRMED" : anySucceeded ? "AUTHORIZED" : anyPending ? "PENDING" : "FAILED";
  await prisma.paymentMethod.update({ where: { id: method.id }, data: { workflowStatus: next } });
}
