"use server";

// CVV recollection — the PCI-compliant alternative to extending the
// existing ~24h post-booking CVV cache window (src/server/security/
// cvv-cache.ts). Rather than retain the customer's originally submitted
// CVV any longer than that, an authorized agent can request they confirm
// it again, once, via a short-lived public link. The customer's fresh
// submission flows through the EXACT SAME cacheCvv()/
// startSupplierPaymentAuthorization() path every other CVV in this
// codebase already uses — nothing here persists a CVV anywhere. See
// CvvRecollectionRequest's own schema comment for why this needed one
// small additive migration (a public single-use token needs its own
// short-lived, revocable identifier — reusing PaymentMethod.id directly
// as a public link would make a leaked link valid forever).

import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canAuthorizeSupplierPayment } from "@/lib/permissions";
import { canAccessPaymentMethod } from "@/server/payment-method-access";
import { sendEmail } from "@/server/email/service";
import { buildCvvRecollectionEmail } from "@/server/email/templates";
import { getCompanyForContactId } from "@/server/queries/company";
import { getClientIp } from "@/lib/request-ip";
import { resolveBaseUrl } from "@/lib/company-config";
import { isValidCvvFormat, digitsOnly, type CardBrand } from "@/lib/card-validation";
import { cacheCvv } from "@/server/security/cvv-cache";

/** How long a recollection link stays valid — deliberately much shorter
 * than the original ~24h booking-time window: this is a single, on-demand
 * request an agent just triggered, not a standing grace period. */
const RECOLLECTION_TTL_MS = 60 * 60 * 1000;

/** A leaked/forwarded link must not let an attacker brute-force a 3-4
 * digit CVV against the real card. After this many wrong submissions the
 * request is permanently invalidated (not merely rate-limited) — the
 * agent must issue a fresh request, which sends a new email and
 * invalidates any old link, same as a password-reset flow's own
 * convention. */
const MAX_FAILED_ATTEMPTS = 5;

async function auditCvvRecollection(params: {
  actorId: string | undefined;
  paymentMethodId: string;
  requestId: string | undefined;
  last4: string | undefined | null;
  action: "CVV_RECOLLECTION_REQUESTED" | "CVV_RECOLLECTION_REQUEST_DENIED" | "CVV_RECOLLECTION_SUBMITTED" | "CVV_RECOLLECTION_SUBMISSION_DENIED";
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
      // Never the CVV or PAN — only last4 (already-masked), the request
      // row's own id, and the requester's IP, matching every other
      // payment-method audit record in this codebase.
      metadata: { requestId: params.requestId ?? null, last4: params.last4 ?? null, result: params.success ? "SUCCESS" : "DENIED", reason: params.reason ?? null, ip: ip ?? null },
    },
  });
}

const GENERIC_DENIAL = "You are not authorized to request CVV recollection for this payment method";

/**
 * Authenticated, staff-triggered — same authorization ceiling as
 * "Start Supplier Payment" (canAuthorizeSupplierPayment + IDOR via
 * canAccessPaymentMethod), since this is the same sensitivity class of
 * action (surfacing a customer's CVV to an agent), just deferred to a
 * later moment via the customer's own fresh confirmation instead of the
 * originally-cached value.
 *
 * Deliberately does NOT require the extra requireMfa() step-up
 * startSupplierPaymentAuthorization uses: this function itself never
 * exposes a CVV to the agent — it only composes and sends an email asking
 * the CUSTOMER to confirm one. The actual sensitive "reveal the CVV to
 * me" moment stays exactly where it already was, unchanged, still behind
 * requireMfa: startSupplierPaymentAuthorization, called AFTER the
 * customer has submitted via this flow.
 */
export async function requestCvvRecollection(paymentMethodId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const actor = await getCurrentAccount();
  if (!actor || actor.status !== "ACTIVE" || !canAuthorizeSupplierPayment(actor)) {
    await auditCvvRecollection({ actorId: actor?.id, paymentMethodId, requestId: undefined, last4: undefined, action: "CVV_RECOLLECTION_REQUEST_DENIED", success: false, reason: "MISSING_PERMISSION" });
    return { ok: false, error: GENERIC_DENIAL };
  }

  const paymentMethod = await prisma.paymentMethod.findUnique({
    where: { id: paymentMethodId },
    select: { id: true, cardBrand: true, last4: true, bookingId: true, contactId: true },
  });
  if (!paymentMethod) {
    await auditCvvRecollection({ actorId: actor.id, paymentMethodId, requestId: undefined, last4: undefined, action: "CVV_RECOLLECTION_REQUEST_DENIED", success: false, reason: "NOT_FOUND" });
    return { ok: false, error: GENERIC_DENIAL };
  }
  const accessible = await canAccessPaymentMethod(actor, paymentMethod);
  if (!accessible) {
    await auditCvvRecollection({ actorId: actor.id, paymentMethodId, requestId: undefined, last4: paymentMethod.last4, action: "CVV_RECOLLECTION_REQUEST_DENIED", success: false, reason: "RECORD_NOT_ACCESSIBLE" });
    return { ok: false, error: GENERIC_DENIAL };
  }
  // PaymentMethod.contactId is always set (booking-submitted cards derive
  // it from the quote's own contact at submission time; contact-page-added
  // cards have no other owner) — see the model's own schema comment.
  const contact = await prisma.contact.findUnique({ where: { id: paymentMethod.contactId! }, select: { firstName: true, primaryEmail: true } });
  if (!contact?.primaryEmail) {
    await auditCvvRecollection({ actorId: actor.id, paymentMethodId, requestId: undefined, last4: paymentMethod.last4, action: "CVV_RECOLLECTION_REQUEST_DENIED", success: false, reason: "NO_CONTACT_EMAIL" });
    return { ok: false, error: "This customer has no email address on file to send the confirmation link to." };
  }

  const request = await prisma.cvvRecollectionRequest.create({
    data: { paymentMethodId, requestedById: actor.id, expiresAt: new Date(Date.now() + RECOLLECTION_TTL_MS) },
  });

  const company = await getCompanyForContactId(paymentMethod.contactId!);
  const { subject, html } = buildCvvRecollectionEmail({
    customerFirstName: contact.firstName,
    agentFullName: actor.fullName,
    agent: { fullName: actor.fullName, email: actor.email, phone: actor.phone },
    cardBrand: paymentMethod.cardBrand,
    last4: paymentMethod.last4,
    confirmUrl: `${resolveBaseUrl()}/cvv-recollection/${request.token}`,
    company,
  });
  const result = await sendEmail({ accountId: actor.id, to: contact.primaryEmail, subject, html, senderName: actor.fullName, replyTo: actor.email });

  await prisma.emailLog.create({
    data: {
      type: "BOOKING_NOTIFICATION",
      subject,
      fromEmail: actor.email,
      toEmail: contact.primaryEmail,
      status: result.ok ? "SENT" : "FAILED",
      errorMessage: result.ok ? undefined : result.error,
      messageId: result.ok ? result.messageId : undefined,
      bookingId: paymentMethod.bookingId ?? undefined,
      contactId: paymentMethod.contactId ?? undefined,
    },
  });

  if (!result.ok) {
    await auditCvvRecollection({ actorId: actor.id, paymentMethodId, requestId: request.id, last4: paymentMethod.last4, action: "CVV_RECOLLECTION_REQUEST_DENIED", success: false, reason: "EMAIL_SEND_FAILED" });
    return { ok: false, error: "The confirmation email could not be sent. Please try again or check the customer's email address." };
  }

  await auditCvvRecollection({ actorId: actor.id, paymentMethodId, requestId: request.id, last4: paymentMethod.last4, action: "CVV_RECOLLECTION_REQUESTED", success: true });
  return { ok: true };
}

/** Public, unauthenticated — read-only, masked info only, used by the
 * confirmation page to decide what to render for a given token, without
 * ever exposing anything sensitive.
 *
 * Returns null ONLY for a token that doesn't correspond to any real
 * request at all (unknown/malformed) — the page 404s exactly as it would
 * for any other broken link, revealing nothing about whether such a
 * request ever existed.
 *
 * For a token that DOES correspond to a real request, the specific
 * status is returned rather than collapsed into a single generic
 * failure, so the page can show the right thing for each case: "AVAILABLE"
 * (form still open), "USED" (already successfully confirmed — reopening
 * the same link, e.g. from a double-click or a re-visited email, should
 * not look like a broken link), or "EXPIRED" (past its TTL, or locked out
 * after MAX_FAILED_ATTEMPTS wrong submissions — both mean "no longer
 * usable, ask your agent for a new one" and share one message). None of
 * this weakens submitRecollectedCvv's own independent server-side
 * re-validation of the exact same conditions below — this function only
 * decides what the page SHOWS, never what submission is ALLOWED. */
export type CvvRecollectionTokenState =
  | { status: "AVAILABLE"; cardBrand: string | null; last4: string; companyName: string }
  | { status: "USED"; last4: string; companyName: string }
  | { status: "EXPIRED"; companyName: string };

export async function getCvvRecollectionRequestSummary(token: string): Promise<CvvRecollectionTokenState | null> {
  const request = await prisma.cvvRecollectionRequest.findUnique({
    where: { token },
    select: { expiresAt: true, usedAt: true, failedAttempts: true, paymentMethod: { select: { cardBrand: true, last4: true, contactId: true } } },
  });
  if (!request) return null;
  const company = await getCompanyForContactId(request.paymentMethod.contactId!);
  if (request.usedAt) return { status: "USED", last4: request.paymentMethod.last4, companyName: company.name };
  if (request.expiresAt < new Date() || request.failedAttempts >= MAX_FAILED_ATTEMPTS) return { status: "EXPIRED", companyName: company.name };
  return { status: "AVAILABLE", cardBrand: request.paymentMethod.cardBrand, last4: request.paymentMethod.last4, companyName: company.name };
}

/**
 * Public, unauthenticated — the customer's own submission. Validates the
 * token (exists, unexpired, unused, under the attempt limit), validates
 * CVV format for the card's own brand, and on success calls the EXACT
 * SAME cacheCvv() every other CVV in this app goes through — this
 * function itself never persists the value anywhere. A wrong CVV
 * increments failedAttempts and, at the limit, permanently invalidates
 * the request (fail closed — no unlimited guessing against a leaked
 * link).
 */
export async function submitRecollectedCvv(token: string, cvv: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const request = await prisma.cvvRecollectionRequest.findUnique({
    where: { token },
    select: { id: true, paymentMethodId: true, usedAt: true, expiresAt: true, failedAttempts: true, paymentMethod: { select: { cardBrand: true, last4: true } } },
  });
  const invalidLinkError = "This confirmation link is no longer valid. Please ask your agent to send a new one.";
  if (!request || request.usedAt || request.expiresAt < new Date() || request.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    await auditCvvRecollection({ actorId: undefined, paymentMethodId: request?.paymentMethodId ?? "unknown", requestId: request?.id, last4: request?.paymentMethod.last4, action: "CVV_RECOLLECTION_SUBMISSION_DENIED", success: false, reason: "INVALID_OR_EXPIRED_TOKEN" });
    return { ok: false, error: invalidLinkError };
  }

  const brand = (request.paymentMethod.cardBrand ?? "Unknown") as CardBrand;
  if (!isValidCvvFormat(cvv, brand)) {
    const updated = await prisma.cvvRecollectionRequest.update({ where: { id: request.id }, data: { failedAttempts: { increment: 1 } } });
    await auditCvvRecollection({ actorId: undefined, paymentMethodId: request.paymentMethodId, requestId: request.id, last4: request.paymentMethod.last4, action: "CVV_RECOLLECTION_SUBMISSION_DENIED", success: false, reason: `INVALID_FORMAT (attempt ${updated.failedAttempts}/${MAX_FAILED_ATTEMPTS})` });
    return { ok: false, error: "That doesn't look like a valid security code. Please check the 3 or 4 digits on the back (or front, for American Express) of your card." };
  }

  // Single-use: mark used FIRST, so a double-submit (double-click, or two
  // tabs) can never cache the same CVV twice / never race a concurrent
  // submission past the usedAt guard above.
  const claimed = await prisma.cvvRecollectionRequest.updateMany({
    where: { id: request.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) {
    return { ok: false, error: invalidLinkError };
  }

  cacheCvv(request.paymentMethodId, digitsOnly(cvv));
  await auditCvvRecollection({ actorId: undefined, paymentMethodId: request.paymentMethodId, requestId: request.id, last4: request.paymentMethod.last4, action: "CVV_RECOLLECTION_SUBMITTED", success: true });
  return { ok: true };
}
