// The temporarily retained security code (CVV/CVC) of a Booking Form card — data access and lifecycle. See PaymentMethodCvv in
// schema.prisma and docs/CARD_VAULT_SECURITY.md §19.
//
// The CVV/CVC is Sensitive Authentication Data. The rules this module enforces:
//   • It exists only in the dedicated PaymentMethodCvv table, only as a card-vault envelope (own AAD), never plaintext.
//   • It lives AT MOST 24 hours from the moment the Booking Form was signed. The window is a constant — not configurable, not
//     extendable, never reset by viewing, editing, reassigning or recording a payment: `expiresAt` is written once, at
//     creation, and nothing in the application ever updates it (the database also pins it to signedAt + 24 h).
//   • It is destroyed early when the payment is recorded as successfully charged (workflow CONFIRMED) or the card's payment workflow is cancelled, when an Administrator
//     destroys it, and at expiry (daily cron + a check before every reveal). Destruction sets the ciphertext to NULL; the row is
//     deleted by the expiry cleanup. Nothing here ever returns, logs or audits the value or its ciphertext.
// Nothing outside this module and actions/booking-cvv.ts reads `encryptedCvv`.
import { prisma } from "@/lib/prisma";
import { safeErrorTag } from "@/lib/safe-error-log";
import { auditCardEvent } from "@/server/security/card-audit";
import { CardVaultError } from "@/server/security/card-encryption";
import { getCvvVault } from "@/server/security/payment-vault";

/** The one and only retention window: 24 hours after the Booking Form was signed. Deliberately NOT read from the environment. */
export const CVV_RETENTION_MS = 24 * 60 * 60 * 1000;

export type CvvDestroyReason = "PAYMENT_CONFIRMED" | "PAYMENT_CANCELLED" | "CARD_REMOVED" | "ADMIN_DESTROYED" | "EXPIRED";

export const cvvExpiryFor = (signedAt: Date) => new Date(signedAt.getTime() + CVV_RETENTION_MS);

export function isCvvExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return now.getTime() >= expiresAt.getTime();
}

export type PreparedCvv = { encryptedCvv: string; signedAt: Date; expiresAt: Date };

/**
 * Encrypts a (format-checked) security code for storage with the nested payment-method create. Returns null — never throws, never
 * stores anything — when there is no code, when the signing time is not a valid, already-past moment, when the window would
 * already be over (an already-expired record is never created), or when the vault is unavailable. A failure here must never fail
 * the booking: the card number is stored regardless and the Admin simply sees that no CVV/CVC is retained. Only a fixed tag is logged.
 */
export async function prepareCvvForStorage(cvv: string | undefined, paymentMethodId: string, signedAt: Date, now: Date = new Date()): Promise<PreparedCvv | null> {
  if (!cvv) return null;
  if (!(signedAt instanceof Date) || Number.isNaN(signedAt.getTime()) || signedAt.getTime() > now.getTime() + 60_000) return null;
  const expiresAt = cvvExpiryFor(signedAt);
  if (isCvvExpired(expiresAt, now)) return null;
  try {
    const encryptedCvv = await getCvvVault().store(cvv, paymentMethodId);
    return { encryptedCvv, signedAt, expiresAt };
  } catch (err) {
    console.error(`[booking] CVV_NOT_RETAINED (${err instanceof CardVaultError ? err.code : safeErrorTag(err)})`);
    return null;
  }
}

/**
 * Destroys the retained code for one payment method: ciphertext -> NULL, destroyedAt stamped. Idempotent (a second call finds nothing
 * to do and returns false) and best-effort: it never throws, so recording a payment is never blocked by it. The expiry is NOT touched.
 */
export async function destroyCvv(paymentMethodId: string, reason: CvvDestroyReason, actorId?: string | null): Promise<boolean> {
  try {
    const result = await prisma.paymentMethodCvv.updateMany({
      where: { paymentMethodId, encryptedCvv: { not: null } },
      data: { encryptedCvv: null, destroyedAt: new Date(), destroyedReason: reason },
    });
    if (result.count === 0) return false;
    await auditCardEvent({ actorId: actorId ?? null, action: "CVV_DESTROYED", entityId: paymentMethodId, success: true, reason, details: { trigger: reason } }).catch(() => {});
    return true;
  } catch (err) {
    console.error(`[booking] CVV_DESTROY_FAILED (${safeErrorTag(err)})`);
    return false;
  }
}

/**
 * The 24-hour cleanup, run by the daily cron and safe to run repeatedly: every record whose window has ended is deleted outright
 * (ciphertext and row). Returns how many rows were removed. Never throws into the cron run.
 */
export async function destroyExpiredCvvs(now: Date = new Date()): Promise<{ deleted: number }> {
  try {
    const result = await prisma.paymentMethodCvv.deleteMany({ where: { expiresAt: { lte: now } } });
    if (result.count > 0) {
      await auditCardEvent({
        actorId: null,
        action: "CVV_DESTROYED",
        entityId: "retention-cleanup",
        entityType: "PaymentMethodCvv",
        success: true,
        reason: "EXPIRED",
        details: { trigger: "EXPIRED", count: result.count },
      }).catch(() => {});
    }
    return { deleted: result.count };
  } catch (err) {
    console.error(`[booking] CVV_EXPIRY_CLEANUP_FAILED (${safeErrorTag(err)})`);
    return { deleted: 0 };
  }
}
