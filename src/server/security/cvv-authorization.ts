"use server";

// ═══════════════════════════════════════════════════════════════════════
// CVV / CVC / CID POLICY — Start Supplier Payment authorization workflow.
//
// PCI SSC prohibits retaining a card's verification value after
// transaction authorization — encrypted, hashed, or otherwise — under any
// name. This module does NOT persist a CVV anywhere: there is no CVV field
// in prisma/schema.prisma (see the PaymentMethod model's header comment),
// no Prisma call in this file ever touches a CVV, and no log line/audit
// record in this file ever includes one.
//
// What this module DOES do, to satisfy the real business requirement that
// an authorized Admin/Manager/Ticketing Agent be able to use the CVV the
// customer actually submitted (not a value the agent has to separately
// source themselves): the customer's CVV is held in
// src/server/security/cvv-cache.ts's transient, in-memory, short-TTL cache
// for a bounded window after booking submission — see that file's own
// header for exactly why that is not a "hidden persistent CVV store." This
// module is the ONLY code path that ever reads from that cache, and it does
// so behind the full authorization/authentication/audit gate below. This is
// deliberately NOT a "Reveal CVV" button — there is no way to retrieve a
// CVV once its authorization window has expired or been explicitly ended;
// startSupplierPaymentAuthorization returns cvvAvailable: false in that
// case rather than any recoverable historical value.
// ═══════════════════════════════════════════════════════════════════════

import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canAuthorizeSupplierPayment } from "@/lib/permissions";
import { canAccessPaymentMethod } from "@/server/payment-method-access";
import { getPaymentVault } from "@/server/security/payment-vault";
import { requireMfa } from "@/server/security/privileged-access";
import { getClientIp } from "@/lib/request-ip";
import { claimCvvForAuthorization, destroyCvv, hasCachedCvv } from "@/server/security/cvv-cache";

const GENERIC_DENIAL = "You are not authorized to start a supplier payment authorization for this payment method";

async function auditSupplierPaymentAccess(params: {
  actorId: string | undefined;
  paymentMethodId: string;
  bookingId: string | undefined | null;
  last4: string | undefined | null;
  action: "SUPPLIER_PAYMENT_AUTHORIZATION_STARTED" | "SUPPLIER_PAYMENT_AUTHORIZATION_DENIED" | "SUPPLIER_PAYMENT_AUTHORIZATION_ENDED";
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
      // Deliberately never includes the PAN or CVV — only last4 (already-
      // masked) plus the requesting actor's own IP, mirroring every other
      // reveal-style audit record in this codebase.
      metadata: {
        bookingId: params.bookingId ?? null,
        last4: params.last4 ?? null,
        result: params.success ? "SUCCESS" : "DENIED",
        reason: params.reason ?? null,
        ip: ip ?? null,
      },
    },
  });
}

export type SupplierPaymentAuthorization = {
  cardholderName: string;
  pan: string;
  cardBrand: string | null;
  expiryMonth: number;
  expiryYear: number;
  /** Null for a Contact-level card that isn't attached to any specific
   * booking — there is no "amount" for it to be a portion of. */
  amountAllocated: number | null;
  /** The customer's originally submitted CVV, only while its short-lived
   * authorization window is still open. Never a historical/recovered value. */
  cvv: string | null;
  cvvAvailable: boolean;
};

/**
 * A predictable, typed result for every expected failure path — never a
 * raw thrown error the caller has to string-match, and never a generic
 * "An unexpected response was received from the server" fallback either.
 * `code` is a stable machine-readable reason the UI can branch on later
 * without parsing `message`; `message` is what's actually shown to the
 * user today. Never includes a stack trace or any internal detail.
 */
export type SupplierPaymentActionResult<T> = ({ success: true } & T) | { success: false; code: string; message: string };

function denied(code: string): { success: false; code: string; message: string } {
  return { success: false, code, message: GENERIC_DENIAL };
}

/**
 * "Start Supplier Payment" — the ONLY way a CVV is ever exposed to an
 * agent, and only for as long as this authorization stays active:
 *   1-3: authenticated session, active account, role + explicit
 *        payments.manual_supplier_payment permission
 *        (canAuthorizeSupplierPayment checks both).
 *   4:   IDOR/BOLA protection via bookingVisibilityWhere — same row-level
 *        scope every other booking/payment action goes through.
 *   5:   step-up authentication / MFA where the underlying auth system
 *        supports it (requireMfa) — fails closed in production.
 *   6:   audit event for both success and denial.
 *   7:   decrypt PAN via the vault (same mechanism as plain Reveal) and
 *        attempt to claim the still-cached CVV. If the CVV's TTL has
 *        elapsed, or it was already consumed by a prior authorization that
 *        ended, cvvAvailable is false and cvv is null — the UI must render
 *        "CVV — Not retained — new authorization required", never a stale
 *        value.
 */
export async function startSupplierPaymentAuthorization(paymentMethodId: string): Promise<SupplierPaymentActionResult<SupplierPaymentAuthorization>> {
  const actor = await getCurrentAccount();

  if (!actor || actor.status !== "ACTIVE") {
    await auditSupplierPaymentAccess({ actorId: actor?.id, paymentMethodId, bookingId: undefined, last4: undefined, action: "SUPPLIER_PAYMENT_AUTHORIZATION_DENIED", success: false, reason: "NO_ACTIVE_SESSION" });
    return denied("NO_ACTIVE_SESSION");
  }
  if (!canAuthorizeSupplierPayment(actor)) {
    await auditSupplierPaymentAccess({ actorId: actor.id, paymentMethodId, bookingId: undefined, last4: undefined, action: "SUPPLIER_PAYMENT_AUTHORIZATION_DENIED", success: false, reason: "MISSING_PERMISSION" });
    return denied("MISSING_PERMISSION");
  }

  const paymentMethod = await prisma.paymentMethod.findUnique({
    where: { id: paymentMethodId },
    select: { id: true, encryptedPan: true, cardholderName: true, cardBrand: true, expiryMonth: true, expiryYear: true, last4: true, bookingId: true, contactId: true, amountAllocated: true },
  });
  if (!paymentMethod) {
    await auditSupplierPaymentAccess({ actorId: actor.id, paymentMethodId, bookingId: undefined, last4: undefined, action: "SUPPLIER_PAYMENT_AUTHORIZATION_DENIED", success: false, reason: "NOT_FOUND" });
    return denied("NOT_FOUND");
  }

  const accessible = await canAccessPaymentMethod(actor, paymentMethod);
  if (!accessible) {
    await auditSupplierPaymentAccess({ actorId: actor.id, paymentMethodId, bookingId: paymentMethod.bookingId, last4: paymentMethod.last4, action: "SUPPLIER_PAYMENT_AUTHORIZATION_DENIED", success: false, reason: "RECORD_NOT_ACCESSIBLE" });
    return denied("RECORD_NOT_ACCESSIBLE");
  }

  const stepUp = requireMfa();
  if (!stepUp.ok) {
    await auditSupplierPaymentAccess({ actorId: actor.id, paymentMethodId, bookingId: paymentMethod.bookingId, last4: paymentMethod.last4, action: "SUPPLIER_PAYMENT_AUTHORIZATION_DENIED", success: false, reason: stepUp.reason });
    return denied(stepUp.reason);
  }

  const pan = await getPaymentVault().reveal(paymentMethod.encryptedPan);
  const cvv = claimCvvForAuthorization(paymentMethod.id, actor.id) ?? null;

  await auditSupplierPaymentAccess({ actorId: actor.id, paymentMethodId, bookingId: paymentMethod.bookingId, last4: paymentMethod.last4, action: "SUPPLIER_PAYMENT_AUTHORIZATION_STARTED", success: true });

  return {
    success: true,
    cardholderName: paymentMethod.cardholderName,
    pan,
    cardBrand: paymentMethod.cardBrand,
    expiryMonth: paymentMethod.expiryMonth,
    expiryYear: paymentMethod.expiryYear,
    amountAllocated: paymentMethod.amountAllocated !== null ? Number(paymentMethod.amountAllocated) : null,
    cvv,
    cvvAvailable: cvv !== null,
  };
}

/**
 * Ends an active supplier-payment authorization — explicitly destroys the
 * cached CVV (idempotent; safe to call even if it already expired). Call on
 * agent cancellation, and also called internally from confirmPaymentReceived
 * on both success and failure so the CVV never outlives the actual charge
 * attempt it was authorized for.
 */
export async function endSupplierPaymentAuthorization(paymentMethodId: string): Promise<SupplierPaymentActionResult<unknown>> {
  const actor = await getCurrentAccount();
  if (!actor || !canAuthorizeSupplierPayment(actor)) {
    return denied("MISSING_PERMISSION");
  }
  destroyCvv(paymentMethodId);
  await auditSupplierPaymentAccess({ actorId: actor.id, paymentMethodId, bookingId: undefined, last4: undefined, action: "SUPPLIER_PAYMENT_AUTHORIZATION_ENDED", success: true });
  return { success: true };
}

/** Read-only check the UI uses to decide whether to show "Start Supplier
 * Payment" vs. "CVV — Not retained — new authorization required" without
 * spending an authorization/audit event just to check. Never returns the
 * CVV itself. */
export async function checkCvvRetained(paymentMethodId: string): Promise<{ retained: boolean }> {
  return { retained: hasCachedCvv(paymentMethodId) };
}
