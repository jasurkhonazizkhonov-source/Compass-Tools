"use server";

import { revalidatePath } from "next/cache";
import { getCurrentAccount } from "@/lib/dev-session";
import { executeManualCharge, executeRefund, type ManualChargeInput, type ManualChargeResult, type RefundInput, type RefundOutcome } from "@/server/payments/manual-charge";

// Thin server-action wrappers. The authorization, validation and provider
// logic live in src/server/payments/manual-charge.ts so they can be tested
// with a fake provider; everything here that a browser can reach re-derives the
// actor from the session (never from a client-supplied id).

/** Admin-only: charge a booking's vaulted payment method through the payment provider. */
export async function initiateManualCharge(input: ManualChargeInput): Promise<ManualChargeResult> {
  const actor = await getCurrentAccount();
  const result = await executeManualCharge(actor, input);
  if (typeof input?.bookingId === "string") revalidatePath(`/bookings/${input.bookingId}`);
  return result;
}

/** Admin-only: refund (fully or partly) a successful provider charge. */
export async function refundManualCharge(input: RefundInput): Promise<RefundOutcome> {
  const actor = await getCurrentAccount();
  const result = await executeRefund(actor, input);
  if (typeof input?.bookingId === "string") revalidatePath(`/bookings/${input.bookingId}`);
  return result;
}
