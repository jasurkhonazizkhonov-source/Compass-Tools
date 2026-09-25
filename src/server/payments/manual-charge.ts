// Manual charges and refunds against a provider-VAULTED payment method.
//
// The flow: an authorized Admin picks a booking's saved card, enters an amount
// and a reason, and we ask the payment provider to charge the vaulted method by
// its reference. No card number and no card security code is involved at any
// point — Compass Tools does not have them and cannot retrieve them.
//
// Plain server module (the thin "use server" wrappers live in
// src/server/actions/manual-charge.ts) so the logic is unit/integration
// testable with a fake provider and never callable directly from a browser.
//
// Guarantees:
//   - Server-side authorization (Admin only), plus row-level booking access.
//   - Exactly-once: a client idempotency key is unique in the database and is
//     also the seed of the provider's own idempotency key, so a double click, a
//     replay or a retry after a timeout can never charge twice.
//   - Never trusts the browser for a result: status comes only from the
//     provider's server-side response (or its signed webhook).
//   - Only the booking's own currency; only that booking's own payment method.
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { logActivity } from "@/server/activity-log";
import { canInitiateManualCharge } from "@/lib/permissions";
import { bookingVisibilityWhere, type Viewer } from "@/server/visibility";
import { maxReasonableChargeAmount } from "@/lib/payment-limits";
import { formatMoney, isSupportedCurrency } from "@/lib/currency";
import { getPaymentProvider, type PaymentProviderAdapter } from "@/server/payments/provider";
import { applyChargeOutcome, toMinorUnits, fromMinorUnits } from "@/server/payments/charge-state";
import { recordHealthEvent } from "@/server/system/health-events";
import { safeErrorTag } from "@/lib/safe-error-log";

type Actor = (Viewer & { id: string; status: string; role: string }) | null;

export type ManualChargeResult =
  | { ok: true; chargeId: string; status: "SUCCEEDED" | "PENDING"; duplicate?: true }
  | { ok: false; code: "DENIED" | "INVALID" | "NOT_FOUND" | "NOT_CHARGEABLE" | "EXPIRED" | "OVER_LIMIT" | "IN_PROGRESS" | "KEY_REUSED" | "PROVIDER_UNAVAILABLE" | "DECLINED" | "AUTHENTICATION_REQUIRED" | "OUTCOME_UNKNOWN" | "FAILED"; error: string; chargeId?: string };

const KEY_RE = /^[A-Za-z0-9-]{16,80}$/;
// A card number typed into a free-text note by mistake must never be stored.
const CARD_SHAPED_RE = /\b(?:\d[ -]?){13,19}\b/;

const chargeSchema = z.object({
  paymentMethodId: z.string().min(1),
  bookingId: z.string().min(1),
  amount: z
    .number()
    .positive()
    .finite()
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "At most two decimal places"),
  reason: z
    .string()
    .trim()
    .min(3)
    .max(300)
    .refine((v) => !CARD_SHAPED_RE.test(v), "Never put card numbers in a note"),
  idempotencyKey: z.string().regex(KEY_RE),
});

export type ManualChargeInput = z.input<typeof chargeSchema>;

const DENIED: ManualChargeResult = { ok: false, code: "DENIED", error: "You are not authorized to charge payment methods." };

function cardExpired(month: number, year: number, now = new Date()): boolean {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  return year < y || (year === y && month < m);
}

/** Sum still "on" the card: succeeded/partially-refunded/in-flight provider charges, net of refunds. */
async function netChargedMinor(paymentMethodId: string, db: Pick<typeof prisma, "paymentCharge"> = prisma): Promise<number> {
  const rows = await db.paymentCharge.findMany({
    where: { paymentMethodId, provider: { not: null }, status: { in: ["PENDING", "SUCCEEDED", "PARTIALLY_REFUNDED"] } },
    select: { amount: true, refundedAmount: true },
  });
  return rows.reduce((sum, r) => sum + toMinorUnits(Number(r.amount)) - toMinorUnits(Number(r.refundedAmount)), 0);
}

export async function executeManualCharge(actor: Actor, rawInput: ManualChargeInput, provider: PaymentProviderAdapter | null = getPaymentProvider()): Promise<ManualChargeResult> {
  if (!actor || actor.status !== "ACTIVE" || !canInitiateManualCharge(actor)) return DENIED;

  const parsed = chargeSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "INVALID", error: "Check the amount (two decimals at most), the reason (3–300 characters, no card numbers) and try again." };
  const input = parsed.data;
  if (!provider) return { ok: false, code: "PROVIDER_UNAVAILABLE", error: "No payment provider is configured, so nothing can be charged right now." };

  // Row-level access: the booking must be one this account may see, and the
  // payment method must belong to THAT booking (never another customer's card).
  const booking = await prisma.booking.findFirst({
    where: { id: input.bookingId, ...bookingVisibilityWhere(actor) },
    select: { id: true, bookingReference: true, leadId: true, contactId: true, quote: { select: { currency: true } } },
  });
  if (!booking) return { ok: false, code: "NOT_FOUND", error: "This booking is not accessible." };
  const method = await prisma.paymentMethod.findFirst({
    where: { id: input.paymentMethodId, bookingId: booking.id },
    select: {
      id: true,
      status: true,
      vaultStatus: true,
      provider: true,
      providerCustomerId: true,
      providerPaymentMethodId: true,
      expiryMonth: true,
      expiryYear: true,
      amountAllocated: true,
      last4: true,
    },
  });
  if (!method) return { ok: false, code: "NOT_FOUND", error: "This payment method is not on file for this booking." };

  const currency = booking.quote.currency;
  if (!isSupportedCurrency(currency)) return { ok: false, code: "INVALID", error: "This booking has an unsupported currency." };

  // Replay of an earlier request with the same key: same card/amount only.
  const existing = await prisma.paymentCharge.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) {
    if (existing.paymentMethodId !== method.id || toMinorUnits(Number(existing.amount)) !== toMinorUnits(input.amount)) {
      return { ok: false, code: "KEY_REUSED", error: "That request was already used for a different charge. Reload the page and start again." };
    }
    if (existing.status !== "PENDING") return resultFromRow(existing, true);
    // Still PENDING: the earlier attempt's outcome is unknown. Re-ask the
    // provider with the SAME idempotency key — it returns the original result,
    // it can never create a second charge.
    return finalizeCharge({ chargeId: existing.id, method, provider, currency, booking, actor, input, duplicate: true });
  }

  if (method.status !== "ACTIVE" || method.vaultStatus !== "VAULTED" || !method.providerCustomerId || !method.providerPaymentMethodId) {
    return { ok: false, code: "NOT_CHARGEABLE", error: "This payment method was not vaulted with the payment provider, so it cannot be charged from the CRM." };
  }
  if (cardExpired(method.expiryMonth, method.expiryYear)) return { ok: false, code: "EXPIRED", error: "This card has expired. Ask the customer for a new payment method." };

  // The limit rule, the one-charge-in-flight rule and the insert happen inside
  // ONE transaction serialized per card by an advisory lock, so two concurrent
  // requests can neither both pass the checks nor both create a charge (a
  // partial unique index on the table is the last-resort backstop). The lock is
  // held only for these few queries — never across the provider call.
  const allocated = Number(method.amountAllocated ?? 0);
  const limitMinor = toMinorUnits(maxReasonableChargeAmount(allocated));
  type Claim = { kind: "created"; id: string } | { kind: "replay"; row: NonNullable<Awaited<ReturnType<typeof prisma.paymentCharge.findUnique>>> } | { kind: "in_progress" } | { kind: "over_limit" };
  let claim: Claim;
  try {
    claim = await prisma.$transaction(async (tx): Promise<Claim> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${method.id}))`;
      const replay = await tx.paymentCharge.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (replay) return { kind: "replay", row: replay };
      // One charge in flight per card at a time.
      if ((await tx.paymentCharge.count({ where: { paymentMethodId: method.id, provider: { not: null }, status: "PENDING" } })) > 0) return { kind: "in_progress" };
      // Never exceed what the booking's existing charge rule allows for this card.
      if ((await netChargedMinor(method.id, tx)) + toMinorUnits(input.amount) > limitMinor) return { kind: "over_limit" };
      const row = await tx.paymentCharge.create({
        data: {
          paymentMethodId: method.id,
          amount: input.amount,
          // Lowercase, matching every other PaymentCharge row in this app.
          currency: currency.toLowerCase(),
          status: "PENDING",
          referenceNote: input.reason,
          initiatedById: actor.id,
          provider: provider.id,
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      });
      return { kind: "created", id: row.id };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Backstop (unique key / one-pending index): report the existing row, never a second charge.
      const winner = await prisma.paymentCharge.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (winner) return winner.status === "PENDING" ? { ok: true, chargeId: winner.id, status: "PENDING", duplicate: true } : resultFromRow(winner, true);
      return { ok: false, code: "IN_PROGRESS", error: "Another charge on this card is still being processed. Wait for it to finish (or check its status) before charging again." };
    }
    throw err;
  }
  if (claim.kind === "replay") {
    if (claim.row.paymentMethodId !== method.id || toMinorUnits(Number(claim.row.amount)) !== toMinorUnits(input.amount)) {
      return { ok: false, code: "KEY_REUSED", error: "That request was already used for a different charge. Reload the page and start again." };
    }
    return claim.row.status === "PENDING" ? { ok: true, chargeId: claim.row.id, status: "PENDING", duplicate: true } : resultFromRow(claim.row, true);
  }
  if (claim.kind === "in_progress") return { ok: false, code: "IN_PROGRESS", error: "Another charge on this card is still being processed. Wait for it to finish (or check its status) before charging again." };
  if (claim.kind === "over_limit") {
    return { ok: false, code: "OVER_LIMIT", error: `That would exceed the maximum allowed for this payment method (${formatMoney(fromMinorUnits(limitMinor), currency)} including anything already charged).` };
  }
  const chargeId = claim.id;

  await audit(actor.id, "MANUAL_CHARGE_REQUESTED", chargeId, method.last4, { bookingId: booking.id, amount: input.amount, currency });
  return finalizeCharge({ chargeId, method, provider, currency, booking, actor, input, duplicate: false });
}

function resultFromRow(row: { id: string; status: string; errorMessage: string | null; failureCategory: string | null }, duplicate: boolean): ManualChargeResult {
  if (row.status === "SUCCEEDED" || row.status === "PARTIALLY_REFUNDED" || row.status === "REFUNDED") return { ok: true, chargeId: row.id, status: "SUCCEEDED", ...(duplicate ? { duplicate: true as const } : {}) };
  if (row.status === "PENDING") return { ok: true, chargeId: row.id, status: "PENDING", ...(duplicate ? { duplicate: true as const } : {}) };
  return failure(row.failureCategory, row.id, row.errorMessage);
}

function failure(category: string | null, chargeId: string, message?: string | null): ManualChargeResult {
  if (category === "declined") return { ok: false, code: "DECLINED", chargeId, error: message ?? "The card was declined." };
  if (category === "authentication_required") return { ok: false, code: "AUTHENTICATION_REQUIRED", chargeId, error: message ?? "The bank requires the cardholder to authenticate this payment, which cannot be done for a saved card. Ask the customer to pay another way or add a new card." };
  return { ok: false, code: "FAILED", chargeId, error: message ?? "The charge could not be completed." };
}

async function finalizeCharge(args: {
  chargeId: string;
  method: { id: string; providerCustomerId: string | null; providerPaymentMethodId: string | null; last4: string; amountAllocated: Prisma.Decimal | null };
  provider: PaymentProviderAdapter;
  currency: string;
  booking: { id: string; bookingReference: string; leadId: string; contactId: string };
  actor: NonNullable<Actor>;
  input: z.infer<typeof chargeSchema>;
  duplicate: boolean;
}): Promise<ManualChargeResult> {
  const { chargeId, method, provider, currency, booking, actor, input, duplicate } = args;
  if (!method.providerCustomerId || !method.providerPaymentMethodId) return { ok: false, code: "NOT_CHARGEABLE", error: "This payment method cannot be charged.", chargeId };

  let result;
  try {
    result = await provider.charge({
      customerId: method.providerCustomerId,
      paymentMethodId: method.providerPaymentMethodId,
      amountMinor: toMinorUnits(input.amount),
      currency,
      idempotencyKey: `mc-${chargeId}`,
      description: `Booking ${booking.bookingReference}`,
      metadata: { chargeId, bookingId: booking.id },
    });
  } catch (err) {
    console.error(`[manual-charge] PROVIDER_CALL_FAILED (${safeErrorTag(err)})`);
    result = { ok: false as const, failureCategory: "provider_unavailable" as const, outcomeUnknown: true as const };
  }

  if (result.ok) {
    await applyChargeOutcome({ chargeId, outcome: result.status === "succeeded" ? "SUCCEEDED" : "PENDING", paymentIntentId: result.paymentIntentId });
    if (result.status === "succeeded") {
      await logActivity({
        bookingId: booking.id,
        leadId: booking.leadId,
        contactId: booking.contactId,
        actorId: actor.id,
        type: "PAYMENT_CONFIRMED",
        description: `Manual charge of ${formatMoney(input.amount, currency as never)} succeeded on the card ending ${method.last4}`,
      });
    }
    await audit(actor.id, result.status === "succeeded" ? "MANUAL_CHARGE_SUCCEEDED" : "MANUAL_CHARGE_PROCESSING", chargeId, method.last4, { bookingId: booking.id, amount: input.amount, currency, paymentIntentId: result.paymentIntentId });
    return { ok: true, chargeId, status: result.status === "succeeded" ? "SUCCEEDED" : "PENDING", ...(duplicate ? { duplicate: true as const } : {}) };
  }

  if (result.outcomeUnknown) {
    // Leave the row PENDING: the provider may or may not have charged. The same
    // request (same key) resolves it; the health check flags stuck ones.
    await recordHealthEvent({
      type: "PAYMENT_PROVIDER_ERROR",
      category: "payment",
      severity: "WARNING",
      discriminator: "manual_charge_unknown",
      message: "A manual charge could not be confirmed with the payment provider (no response). It is left pending; retrying the same request is safe.",
    });
    return { ok: false, code: "OUTCOME_UNKNOWN", chargeId, error: "We couldn't confirm the result with the payment provider. The charge may or may not have gone through. Press Retry to check safely (it cannot charge twice)." };
  }

  const message = result.failureCategory === "declined" ? "The card was declined." : result.failureCategory === "authentication_required" ? undefined : "The payment provider rejected the charge.";
  await applyChargeOutcome({ chargeId, outcome: "FAILED", paymentIntentId: result.paymentIntentId, failureCategory: result.failureCategory, failureCode: result.failureCode, errorMessage: message });
  await logActivity({
    bookingId: booking.id,
    leadId: booking.leadId,
    contactId: booking.contactId,
    actorId: actor.id,
    type: "PAYMENT_CONFIRMED",
    description: `Manual charge of ${formatMoney(input.amount, currency as never)} failed on the card ending ${method.last4} (${result.failureCategory})`,
  });
  await audit(actor.id, "MANUAL_CHARGE_FAILED", chargeId, method.last4, { bookingId: booking.id, amount: input.amount, currency, category: result.failureCategory, code: result.failureCode ?? null });
  if (result.failureCategory === "invalid_request") {
    await recordHealthEvent({
      type: "PAYMENT_PROVIDER_ERROR",
      category: "payment",
      severity: "CRITICAL",
      discriminator: "manual_charge_rejected",
      message: "The payment provider rejected a manual charge as an invalid request (credentials or configuration problem).",
      metadata: { code: result.failureCode },
    });
  }
  return failure(result.failureCategory, chargeId, message);
}

async function audit(actorId: string | undefined, action: string, chargeId: string, last4: string, metadata: Record<string, unknown>) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId,
        action,
        entityType: "PaymentCharge",
        entityId: chargeId,
        // last4 only (already masked). Never a card number or security code.
        metadata: { ...metadata, last4 } as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    // Auditing must not turn a completed charge into an error the UI would invite a retry of.
    console.error(`[manual-charge] AUDIT_WRITE_FAILED (${safeErrorTag(err)})`);
  }
}

// ── refunds ────────────────────────────────────────────────────────────────

const refundSchema = z.object({
  chargeId: z.string().min(1),
  bookingId: z.string().min(1),
  /** Omit to refund whatever remains. */
  amount: z.number().positive().finite().optional(),
  idempotencyKey: z.string().regex(KEY_RE),
});

export type RefundInput = z.input<typeof refundSchema>;
export type RefundOutcome = { ok: true; status: "REFUNDED" | "PARTIALLY_REFUNDED"; duplicate?: true } | { ok: false; code: string; error: string };

export async function executeRefund(actor: Actor, rawInput: RefundInput, provider: PaymentProviderAdapter | null = getPaymentProvider()): Promise<RefundOutcome> {
  if (!actor || actor.status !== "ACTIVE" || !canInitiateManualCharge(actor)) return { ok: false, code: "DENIED", error: "You are not authorized to refund payments." };
  const parsed = refundSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "INVALID", error: "Check the refund amount and try again." };
  const input = parsed.data;
  if (!provider) return { ok: false, code: "PROVIDER_UNAVAILABLE", error: "No payment provider is configured." };

  const booking = await prisma.booking.findFirst({ where: { id: input.bookingId, ...bookingVisibilityWhere(actor) }, select: { id: true } });
  if (!booking) return { ok: false, code: "NOT_FOUND", error: "This booking is not accessible." };
  const charge = await prisma.paymentCharge.findFirst({
    where: { id: input.chargeId, paymentMethod: { bookingId: booking.id } },
    select: { id: true, amount: true, refundedAmount: true, status: true, providerPaymentIntentId: true, refundIdempotencyKeys: true, paymentMethod: { select: { last4: true } } },
  });
  if (!charge || !charge.providerPaymentIntentId) return { ok: false, code: "NOT_FOUND", error: "That charge cannot be refunded from the CRM." };
  if (charge.refundIdempotencyKeys.includes(input.idempotencyKey)) return { ok: true, status: charge.status === "REFUNDED" ? "REFUNDED" : "PARTIALLY_REFUNDED", duplicate: true };
  if (charge.status !== "SUCCEEDED" && charge.status !== "PARTIALLY_REFUNDED") return { ok: false, code: "NOT_REFUNDABLE", error: "Only a successful charge can be refunded." };

  const remainingMinor = toMinorUnits(Number(charge.amount)) - toMinorUnits(Number(charge.refundedAmount));
  const amountMinor = input.amount !== undefined ? toMinorUnits(input.amount) : remainingMinor;
  if (amountMinor <= 0 || amountMinor > remainingMinor) return { ok: false, code: "OVER_LIMIT", error: "The refund amount exceeds what is left to refund on this charge." };

  const result = await provider.refund({ paymentIntentId: charge.providerPaymentIntentId, amountMinor, idempotencyKey: `rf-${charge.id}-${input.idempotencyKey}` });
  if (!result.ok) {
    if (result.outcomeUnknown) return { ok: false, code: "OUTCOME_UNKNOWN", error: "We couldn't confirm the refund with the payment provider. Press Retry — it cannot refund twice." };
    return { ok: false, code: "FAILED", error: "The payment provider rejected the refund." };
  }

  // Apply once per client key. The condition + push are one atomic write, so a
  // concurrent duplicate cannot count the same refund twice.
  const newRefundedMinor = toMinorUnits(Number(charge.refundedAmount)) + amountMinor;
  const fullyRefunded = newRefundedMinor >= toMinorUnits(Number(charge.amount));
  const applied = await prisma.paymentCharge.updateMany({
    where: { id: charge.id, NOT: { refundIdempotencyKeys: { has: input.idempotencyKey } }, refundedAmount: charge.refundedAmount },
    data: { refundedAmount: fromMinorUnits(newRefundedMinor), status: fullyRefunded ? "REFUNDED" : "PARTIALLY_REFUNDED", refundIdempotencyKeys: { push: input.idempotencyKey } },
  });
  await audit(actor.id, "PAYMENT_REFUNDED", charge.id, charge.paymentMethod.last4, { bookingId: booking.id, amountMinor });
  return { ok: true, status: fullyRefunded ? "REFUNDED" : "PARTIALLY_REFUNDED", ...(applied.count === 0 ? { duplicate: true as const } : {}) };
}
