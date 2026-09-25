"use server";

import { z } from "zod";
import { customAlphabet } from "nanoid";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { logActivity } from "@/server/activity-log";
import { calculatePricing } from "@/lib/pricing";
import { resolveExchangeRate, convertBookingPricing, convertAmount } from "@/lib/currency";
import { type EmailPaymentMethod } from "@/server/email/templates";
import { transitionQuoteStatus, notifyQuoteActivity } from "@/server/quote-status";
import { getPaymentProvider } from "@/server/payments/provider";
import { verifyVaultedSetup, type VerifiedVaultedMethod } from "@/server/payments/vaulted-methods";
import { recordHealthEvent } from "@/server/system/health-events";
import { isPaymentAllocationValid } from "@/lib/card-validation";
import { getClientIp } from "@/lib/request-ip";
import { recordIpCapture } from "@/server/security/ip-capture";
import { passengerSchema } from "@/server/actions/booking-schema";
import { sendBookingSignedNotification } from "@/server/booking-notification";
import { resolveBaseUrl } from "@/lib/company-config";
import { LEGAL_CONTENT_VERSION } from "@/lib/legal-content";
import { checkPublicRateLimitFromRequest, RATE_LIMITS } from "@/server/security/rate-limit";
import { BOOKABLE_QUOTE_STATUSES, isQuoteBookable } from "@/lib/exchange-proposal";
import { safeErrorTag } from "@/lib/safe-error-log";
import { runAfterResponse } from "@/lib/run-after-response";

const bookingRefAlphabet = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 7);

/** Called when the customer opens the secure quote page. Advances SENT to
 * READ once — the `if` guard is what prevents a duplicate transition (and
 * duplicate agent notification) on every repeat page load/refresh. */
export async function trackQuoteView(token: string) {
  const quote = await prisma.quote.findUnique({ where: { secureToken: token } });
  if (!quote) return;
  if (quote.status === "SENT") {
    await transitionQuoteStatus(quote.id, "READ", { activityDescription: "Customer opened the quote" });
  }
}

/** Called when the customer clicks "View Deal". Stronger engagement signal
 * than an email open — same repeat-visit dedup guard as trackQuoteView. */
// Real bug found and fixed: both this function and trackBookingFormStarted
// below already treat "no quote for this token" as an expected, silent
// no-op (the `if (!quote) return` line) — but until now that check only
// covered the moment of the FIRST lookup. A Quote is genuinely deletable
// (an Admin deleting its parent Lead/Contact cascades to it too, per
// schema.prisma's onDelete: Cascade), so if that delete lands in the
// narrow window between this function's own lookup and the WRITE further
// down the call chain (transitionQuoteStatus -> writeQuoteStatus's
// findUniqueOrThrow, or logActivity's quoteId foreign key below), the
// write throws a real, uncaught Prisma error straight through this
// customer-facing page's render — even though "the quote is gone" is
// exactly the same, already-handled condition as the first check, just
// observed a moment later. A customer opening a bookmarked/emailed quote
// link at the same moment an agent deletes that duplicate/test lead is a
// genuine, real-world way to hit this, not a contrived edge case.
// P2025 ("required record not found", from writeQuoteStatus's
// findUniqueOrThrow) and P2003 (a foreign key violation, from
// logActivity's activity.create referencing a quoteId/leadId/contactId
// that no longer exists) are the two Prisma error codes that mean
// specifically that — this narrowly catches only those and treats them as
// the same no-op the leading check already models, rather than a broad
// catch-all that would also swallow a genuine, unrelated bug.
function isVanishedRecordError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2025" || err.code === "P2003");
}

export async function trackViewDealClicked(token: string) {
  const quote = await prisma.quote.findUnique({ where: { secureToken: token } });
  if (!quote) return;
  if (quote.status === "SENT" || quote.status === "READ") {
    try {
      await transitionQuoteStatus(quote.id, "VIEWED", { activityDescription: "Customer clicked View Deal" });
    } catch (err) {
      if (!isVanishedRecordError(err)) throw err;
    }
  }
}

/** Called when the customer loads the booking form page. Not a status
 * transition (booking-form entry isn't part of the linear quote-status
 * progression) — just an Activity-timeline record so agents can see the
 * customer got this far. Logged once per quote, not on every repeat visit
 * to the form (e.g. the customer navigating back to double-check details). */
export async function trackBookingFormStarted(token: string) {
  const quote = await prisma.quote.findUnique({ where: { secureToken: token }, select: { id: true, leadId: true, contactId: true } });
  if (!quote) return;
  try {
    const already = await prisma.activity.findFirst({ where: { quoteId: quote.id, type: "BOOKING_FORM_STARTED" }, select: { id: true } });
    if (already) return;
    await logActivity({
      quoteId: quote.id,
      leadId: quote.leadId,
      contactId: quote.contactId,
      type: "BOOKING_FORM_STARTED",
      description: "Customer opened the booking form",
    });
  } catch (err) {
    if (!isVanishedRecordError(err)) throw err;
  }
}

// One payment method, as part of a (possibly multi-card) payment split. The
// customer typed the card into the payment provider's hosted fields (the
// browser sent the number and security code straight to the provider), so this
// app receives only the id of the completed capture — never a card number, an
// expiry, or a security code. Everything stored about the card is read back
// from the provider by verifyVaultedSetup(). (Any unknown extra key a stale
// client still sends, e.g. a card field, is dropped by zod's object stripping.)
const cardEntrySchema = z.object({
  setupIntentId: z.string().min(6).max(80),
  cardholderName: z.string().min(1).max(200),
  amount: z.number().positive(),
});

const submitBookingSchema = z.object({
  token: z.string(),
  passengers: z.array(passengerSchema).min(1),
  contactPhone: z.string().min(1),
  contactEmail: z.string().email(),
  billingAddress: z.string().min(1),
  billingApt: z.string().optional(),
  billingCity: z.string().min(1),
  billingState: z.string().min(1),
  billingZip: z.string().min(1),
  billingCountry: z.string().min(1),
  // Payment methods vaulted by the payment provider. One or more, each with
  // its own allocated amount (a booking may split payment across multiple
  // cards) — the server independently re-verifies every one with the provider
  // and independently re-validates that the allocated amounts sum to the
  // booking total. Nothing here authorizes or captures a charge: a saved
  // payment method is not a payment.
  paymentMethods: z.array(cardEntrySchema).min(1).max(6),
  paymentConsent: z.literal(true),
  gratuityAmount: z.number().min(0),
  termsAccepted: z.literal(true),
  signedName: z.string().min(1),
});

export type SubmitBookingInput = z.infer<typeof submitBookingSchema>;

export type SubmitBookingResult =
  | { ok: true; bookingReference: string; bookingId: string; alreadyCompleted?: true }
  | { ok: false; error: string; /** The request may or may not have been recorded — the client keeps the form filled and re-checks instead of clearing it. */ outcomeUnknown?: true };

// Thrown inside the signing transaction when the quote is no longer in a
// bookable status at the moment of the write (cancelled, superseded, or
// already signed by a concurrent request). Aborting the transaction rolls
// back everything written so far in it.
class QuoteNoLongerBookableError extends Error {}

const GENERIC_INCOMPLETE_MESSAGE =
  "We couldn't confirm your booking right now. Nothing has been lost — please wait a minute and reload this page. If your booking was received you'll be taken to your confirmation; otherwise you can safely try again.";

/** One follow-up step: its failure is logged with a safe tag (class name /
 * Prisma code only, never the message) and NEVER propagated — by the time
 * these run, the booking is already durably committed. */
async function bestEffort(label: string, step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (err) {
    console.error(`[booking] POST_COMMIT_STEP_FAILED step=${label} (${safeErrorTag(err)})`);
    await recordHealthEvent({
      type: "BOOKING_POST_COMMIT_STEP_FAILED",
      category: "bookings",
      severity: "WARNING",
      discriminator: label,
      message: `A follow-up step (${label}) failed after a booking was saved. The booking itself is intact.`,
      metadata: { step: label, failure: safeErrorTag(err) },
    });
  }
}

function sameSigner(
  existing: { contactEmail: string; signature: { signedName: string } | null },
  submitted: { contactEmail: string; signedName: string }
): boolean {
  const norm = (s: string) => s.trim().toLowerCase();
  return !!existing.signature && norm(existing.signature.signedName) === norm(submitted.signedName) && norm(existing.contactEmail) === norm(submitted.contactEmail);
}

export async function submitBooking(input: SubmitBookingInput): Promise<SubmitBookingResult> {
  // Pass 25 §28 — public-endpoint rate limiting, checked first, before any
  // parsing/DB work. Fails open (never blocks) when no trustworthy client
  // IP is available — see rate-limit.ts's own doc comment for why that's
  // the correct, deliberate behavior, not an oversight. A database error
  // inside the limiter itself also fails open (logged): the limiter is an
  // anti-abuse control, and if the database is genuinely down the signing
  // transaction below fails on its own with a clear result.
  let rateLimitCheck: Awaited<ReturnType<typeof checkPublicRateLimitFromRequest>> = { allowed: true };
  try {
    rateLimitCheck = await checkPublicRateLimitFromRequest("BOOKING_SUBMIT", RATE_LIMITS.BOOKING_SUBMIT);
  } catch (err) {
    console.error(`[booking] RATE_LIMIT_CHECK_FAILED (${safeErrorTag(err)})`);
  }
  if (!rateLimitCheck.allowed) {
    return { ok: false, error: "Too many booking attempts from this connection. Please wait a few minutes and try again." };
  }

  // Server-side validation is authoritative. A malformed submission is a
  // normal, expected outcome for a public endpoint — returned as a result
  // the form can show, never thrown as an unhandled exception (which the
  // customer would see as a generic "This page couldn't load").
  const validated = submitBookingSchema.safeParse(input);
  if (!validated.success) {
    return { ok: false, error: "Some of the information provided is missing or invalid. Please review the form and try again." };
  }
  const parsed = validated.data;

  const quote = await prisma.quote.findUnique({
    where: { secureToken: parsed.token },
    include: { lead: true, contact: true, agent: true, sentByAgent: true, booking: { include: { signature: true } } },
  });
  if (!quote) return { ok: false, error: "Quote not found" };
  if (quote.status === "CANCELED") return { ok: false, error: "This quote has been canceled" };
  if (quote.booking) {
    // Idempotent replay: the SAME signer re-submitting after a lost
    // response, a timeout, a refresh, or a browser retry gets the original
    // booking's confirmation — not a confusing "already booked" error for
    // something that did in fact succeed. Anyone else holding the link is
    // still refused.
    if (sameSigner(quote.booking, parsed)) {
      return { ok: true, bookingReference: quote.booking.bookingReference, bookingId: quote.booking.id, alreadyCompleted: true };
    }
    return { ok: false, error: "This quote has already been booked" };
  }
  // Pass 26 §2 — stale/superseded/pre-review token protection, the real
  // authorization boundary a customer's secureToken must satisfy before it
  // can ever create a Booking. isQuoteBookable (src/lib/exchange-proposal.ts)
  // is the one shared allow-list; only a quote actually SENT to the
  // customer and not yet acted on may be booked.
  if (!isQuoteBookable(quote.status)) {
    return { ok: false, error: "This link is no longer active. Please contact your travel agent for your current quote." };
  }

  // Server-side verification of every vaulted payment method with the
  // provider — the authoritative check, independent of whatever the browser
  // claims. A capture is accepted only if the provider itself reports it
  // completed AND it was made for THIS quote. Error messages are generic and
  // never echo provider text.
  const provider = getPaymentProvider();
  if (!provider) {
    console.error("[booking] PAYMENT_PROVIDER_UNAVAILABLE");
    await recordHealthEvent({
      type: "BOOKING_PAYMENT_UNAVAILABLE",
      category: "payment",
      severity: "CRITICAL",
      message: "A customer tried to finish a booking but no payment provider is configured. Nothing was charged and nothing was recorded.",
    });
    return { ok: false, error: "Online booking is temporarily unavailable. Nothing was charged and no booking was recorded. Please contact your travel agent." };
  }
  if (new Set(parsed.paymentMethods.map((c) => c.setupIntentId)).size !== parsed.paymentMethods.length) {
    return { ok: false, error: "Payment information could not be processed" };
  }
  const preparedCards: Array<VerifiedVaultedMethod & { id: string; cardholderName: string; amount: number }> = [];
  for (const card of parsed.paymentMethods) {
    const verified = await verifyVaultedSetup(card.setupIntentId, { quoteId: quote.id, providerCustomerId: quote.contact.providerCustomerId }, provider);
    if (!verified.ok) {
      if (verified.reason === "provider_unavailable" || verified.reason === "not_configured") {
        console.error(`[booking] PAYMENT_VERIFY_FAILED reason=${verified.reason} category=${verified.category ?? "-"}`);
        await recordHealthEvent({
          type: "PAYMENT_PROVIDER_ERROR",
          category: "payment",
          severity: "WARNING",
          discriminator: "verify_setup",
          message: "The payment provider could not be reached to verify a customer's payment method. Nothing was recorded; the customer was asked to retry.",
          metadata: { reason: verified.reason, providerCategory: verified.category },
        });
        return { ok: false, error: "We couldn't verify your payment method right now. Nothing was charged and no booking was recorded. Please try again in a moment." };
      }
      if (verified.reason === "not_completed") {
        return { ok: false, error: "Your card details were not completed. Please re-enter your card and try again. Nothing was charged." };
      }
      return { ok: false, error: "Payment information could not be processed" };
    }
    preparedCards.push({ ...verified.method, id: crypto.randomUUID(), cardholderName: card.cardholderName, amount: card.amount });
  }

  // Server recomputes the total from the quote's own stored USD pricing —
  // never trusts a client-submitted total.
  const usdPricing = calculatePricing({
    adults: quote.adults,
    children: quote.children,
    infants: quote.infants,
    adultPrice: Number(quote.adultPrice),
    childPrice: Number(quote.childPrice),
    infantPrice: Number(quote.infantPrice),
    taxes: Number(quote.taxes),
    serviceFee: Number(quote.serviceFee),
    gratuity: parsed.gratuityAmount,
  });

  // Booking currency always inherits the quote's own currency — the same
  // frozen exchange rate captured on Quote.exchangeRate when the quote was
  // sent (never a freshly-looked-up rate). This is the authoritative total
  // that payment allocation is validated against and that gets persisted
  // below — a USD quote keeps rate 1 and this is a no-op.
  const rate = resolveExchangeRate(quote.currency, quote.exchangeRate ? Number(quote.exchangeRate) : null);
  const pricing = convertBookingPricing(usdPricing, rate);

  // Payment allocation must exactly cover the booking total — see
  // isPaymentAllocationValid's own comment for why.
  if (!isPaymentAllocationValid(preparedCards.map((c) => c.amount), pricing.total)) {
    return { ok: false, error: "Payment allocation does not match the booking total" };
  }

  const bookingReference = `BFT-${bookingRefAlphabet()}`;
  const headerList = await headers();
  // Server-determined only — never accepts a client-submitted IP field.
  // See request-ip.ts for the trusted-proxy assumption and IPv4/IPv6
  // validation (a malformed/spoofed header value resolves to undefined
  // rather than being stored as a garbage string).
  const ip = getClientIp(headerList);
  const userAgent = headerList.get("user-agent") ?? undefined;
  const now = new Date();

  // ── THE critical section ───────────────────────────────────────────────
  // Everything that must be all-or-nothing happens in ONE transaction: the
  // Booking (with its passengers, signature, status history and every
  // payment method), the Quote -> SIGNED transition, and the Lead -> BOOKED
  // transition with their histories. Previously these were separate writes
  // (booking, then each card, then a second transaction for the statuses),
  // so a failure or platform timeout partway through — likely, given ~50
  // sequential round trips to a remote database — left a Booking row with
  // no payment methods and a quote still not SIGNED; the customer's retry
  // then hit "already booked" and the booking form redirected to a
  // "confirmation" for a booking that was never actually completed.
  //
  // Race safety: the quote's own status is claimed with a conditional
  // updateMany FIRST. Only one concurrent request can move it out of a
  // bookable status; every other request sees count 0 and aborts, rolling
  // back. Booking.quoteId @unique remains the last-resort backstop (P2002).
  let booking;
  try {
    booking = await prisma.$transaction(
      async (tx) => {
        const claimed = await tx.quote.updateMany({
          where: { id: quote.id, status: { in: [...BOOKABLE_QUOTE_STATUSES] } },
          data: {
            status: "SIGNED",
            signedAt: now,
            lastActivityAt: now,
            // Quote.gratuity/Quote.total are the quote's own internal USD
            // ledger fields — must stay USD here (usdPricing), never the
            // currency-converted `pricing`, or a non-USD quote's own record
            // would be silently corrupted with converted numbers.
            gratuity: usdPricing.gratuity,
            total: usdPricing.total,
          },
        });
        if (claimed.count === 0) throw new QuoteNoLongerBookableError();

        const created = await tx.booking.create({
          data: {
            quoteId: quote.id,
            leadId: quote.leadId,
            contactId: quote.contactId,
            bookingReference,
            contactPhone: parsed.contactPhone,
            contactEmail: parsed.contactEmail,
            billingAddress: parsed.billingAddress,
            billingApt: parsed.billingApt,
            billingCity: parsed.billingCity,
            billingState: parsed.billingState,
            billingZip: parsed.billingZip,
            billingCountry: parsed.billingCountry,
            gratuityAmount: pricing.gratuity,
            totalAmount: pricing.total,
            termsAcceptedAt: now,
            // Pass 24 — the version of the legal text actually shown on THIS
            // signing; never touched afterward.
            termsVersion: LEGAL_CONTENT_VERSION,
            status: "PENDING_TICKETING",
            // Pass 22 fix — these three columns are ALWAYS USD (the same
            // "agent tracks internal cost in USD" convention Quote uses),
            // unlike gratuityAmount/totalAmount above, which are the
            // customer-currency-converted `pricing` values. They remain a
            // pre-fill for the ticketing agent to edit once the real
            // airline cost is known.
            fareAmount: usdPricing.ticketSubtotal,
            taxAmount: usdPricing.taxes,
            serviceFeeAmount: usdPricing.serviceFee,
            statusHistory: { create: [{ toStatus: "PENDING_TICKETING" }] },
            passengers: {
              create: parsed.passengers.map((p) => ({
                type: p.type,
                firstName: p.firstName,
                middleName: p.middleName,
                lastName: p.lastName,
                // Explicit UTC-midnight anchor for this date-only value —
                // see the established pattern for date-only fields.
                dateOfBirth: p.dateOfBirth ? new Date(`${p.dateOfBirth}T00:00:00.000Z`) : undefined,
                gender: p.gender,
                tsaKnownTravelerNumber: p.tsaKnownTravelerNumber,
                globalEntryNumber: p.globalEntryNumber,
                frequentFlyerAirline: p.frequentFlyerAirline,
                frequentFlyerNumber: p.frequentFlyerNumber,
              })),
            },
            signature: {
              create: { signedName: parsed.signedName, ipAddress: ip, userAgent },
            },
            paymentMethods: {
              create: preparedCards.map((c) => ({
                id: c.id,
                // Also attributed to the customer's Contact record (§34): a
                // booking-submitted card must show up under the Contact's own
                // "Payment Methods" section, not only on this booking.
                contactId: quote.contactId,
                cardholderName: c.cardholderName,
                // Provider vault references + display metadata only. There
                // is no card number and no security code to store.
                provider: c.provider,
                providerCustomerId: c.providerCustomerId,
                providerPaymentMethodId: c.providerPaymentMethodId,
                providerSetupIntentId: c.providerSetupIntentId,
                cardFunding: c.cardFunding,
                vaultStatus: "VAULTED" as const,
                last4: c.last4,
                cardBrand: c.cardBrand,
                expiryMonth: c.expiryMonth,
                expiryYear: c.expiryYear,
                amountAllocated: c.amount,
                consentGivenAt: now,
              })),
            },
          },
          include: { signature: true },
        });

        await tx.quoteStatusHistory.create({ data: { quoteId: quote.id, fromStatus: quote.status, toStatus: "SIGNED" } });
        await tx.lead.update({ where: { id: quote.leadId }, data: { status: "BOOKED" } });
        await tx.leadStatusHistory.create({ data: { leadId: quote.leadId, fromStatus: quote.lead.status, toStatus: "BOOKED" } });
        return created;
      },
      // Interactive-transaction defaults (2s to acquire / 5s to finish) are
      // far too tight for a multi-statement write over a high-latency link
      // and would abort a perfectly healthy booking. Bounded well inside the
      // 60s function limit (see quote/layout.tsx).
      { maxWait: 15_000, timeout: 40_000 }
    );
  } catch (err) {
    if (err instanceof QuoteNoLongerBookableError) {
      // Lost a race: another request signed this quote, or it was
      // cancelled/superseded between our read and our write. If it was the
      // same signer's duplicate, replay that booking's confirmation.
      const winner = await findBookingForReplay(quote.id, parsed);
      if (winner) return { ok: true, bookingReference: winner.bookingReference, bookingId: winner.id, alreadyCompleted: true };
      return { ok: false, error: "This link is no longer active. Please contact your travel agent for your current quote." };
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await findBookingForReplay(quote.id, parsed);
      if (winner) return { ok: true, bookingReference: winner.bookingReference, bookingId: winner.id, alreadyCompleted: true };
      return { ok: false, error: "This quote has already been booked" };
    }
    // Anything else (a dropped connection, a pool timeout, a commit whose
    // outcome is unknown): log the safe category, then check whether the
    // transaction actually committed before telling the customer anything.
    console.error(`[booking] SIGNING_TRANSACTION_FAILED (${safeErrorTag(err)})`);
    await runAfterResponse(async () => {
      await recordHealthEvent({
        type: "BOOKING_SIGNING_FAILED",
        category: "bookings",
        severity: "CRITICAL",
        message: "A customer's booking submission hit a database/transaction error. The outcome was re-checked before answering the customer.",
        metadata: { failure: safeErrorTag(err) },
      });
    });
    let committed: Awaited<ReturnType<typeof findBookingForReplay>> = null;
    try {
      committed = await findBookingForReplay(quote.id, parsed);
    } catch {
      // Could not even look — the outcome is genuinely unknown.
    }
    if (committed) return { ok: true, bookingReference: committed.bookingReference, bookingId: committed.id, alreadyCompleted: true };
    return { ok: false, error: GENERIC_INCOMPLETE_MESSAGE, outcomeUnknown: true };
  }

  // ── Committed. Nothing below can fail the booking. ─────────────────────
  // Correlation log for the signing event itself (never the raw IP — only
  // whether one was captured; see request-ip.ts / ip-encryption.ts).
  console.log(
    JSON.stringify({
      event: "booking_signed",
      bookingId: booking.id,
      signatureId: booking.signature!.id,
      signedAt: booking.signature!.signedAt.toISOString(),
      ipCaptured: ip != null,
    })
  );

  revalidatePath(`/leads/${quote.leadId}`);
  revalidatePath("/leads");
  revalidatePath(`/quotes/${quote.id}`);
  revalidatePath("/bookings");
  revalidatePath("/dashboard");

  // Everything else — the IP vault record, the activity-timeline entry, the
  // agent notification and the staff email — is deliberately AFTER the
  // response: it is optional relative to the booking existing, and a Gmail
  // outage or slow email API previously sat on the customer's critical path
  // (and, when it threw, made a successfully signed booking look failed).
  await runAfterResponse(async () => {
    await Promise.allSettled([
      bestEffort("ip_vault", () =>
        // "IP vault" — an additional, permanent, encrypted, cross-booking
        // history row on top of this booking's own Signature.ipAddress.
        // Covers both a first-time booking and an exchange's signing step.
        recordIpCapture({
          ip,
          userAgent,
          formType: quote.originalQuoteId ? "EXCHANGE_BOOKING" : "NEW_BOOKING",
          bookingId: booking.id,
          signerName: parsed.signedName,
          signerEmail: parsed.contactEmail,
          companyId: quote.contact?.companyId,
          quoteId: quote.id,
        })
      ),
      bestEffort("activity_log", () =>
        logActivity({
          quoteId: quote.id,
          leadId: quote.leadId,
          contactId: quote.contactId,
          bookingId: booking.id,
          type: "BOOKING_SUBMITTED",
          description: `Booking ${bookingReference} submitted by customer`,
        })
      ),
      // SIGNED is transitioned inline above (atomic with the Lead -> BOOKED
      // update), so the agent notification that transitionQuoteStatus would
      // normally fire is sent here instead, keeping this path consistent
      // with every other quote-status transition.
      bestEffort("agent_notification", () =>
        notifyQuoteActivity(
          { id: quote.id, agentId: quote.agentId, leadId: quote.leadId, quoteNumber: quote.quoteNumber, contact: quote.contact },
          "SIGNED"
        )
      ),
    ]);

    // "Booking Form Signed" staff notification email — see
    // src/server/booking-notification.ts for recipient/sender/idempotency
    // logic. It never throws, but is wrapped anyway: this is the step most
    // exposed to an external API (Gmail).
    await bestEffort("staff_email", async () => {
      const baseUrl = resolveBaseUrl();
      const paymentMethods: EmailPaymentMethod[] = preparedCards.map((c) => ({
        cardBrand: c.cardBrand ?? null,
        last4: c.last4,
        expiryMonth: c.expiryMonth,
        expiryYear: c.expiryYear,
        amountAllocated: c.amount,
      }));

      await sendBookingSignedNotification({
        bookingId: booking.id,
        bookingReference,
        bookingCreatedAt: booking.createdAt,
        bookingUrl: `${baseUrl}/bookings/${booking.id}`,
        quoteId: quote.id,
        leadId: quote.leadId,
        contactId: quote.contactId,
        // The user who ORIGINALLY sent this quote, not necessarily whoever
        // currently owns the lead — see Quote.sentByAgentId's doc comment.
        agent: (() => {
          const sender = quote.sentByAgent ?? quote.agent;
          return sender ? { id: sender.id, email: sender.email, fullName: sender.fullName } : null;
        })(),
        customerFirstName: quote.contact.firstName,
        customerMiddleName: quote.contact.middleName,
        customerLastName: quote.contact.lastName,
        ip,
        signedName: parsed.signedName,
        contactEmail: parsed.contactEmail,
        contactPhone: parsed.contactPhone,
        passengers: parsed.passengers.map((p) => ({
          firstName: p.firstName,
          middleName: p.middleName ?? null,
          lastName: p.lastName,
          dateOfBirth: p.dateOfBirth ? new Date(`${p.dateOfBirth}T00:00:00.000Z`) : null,
          type: p.type,
        })),
        paymentMethods,
        pricing: {
          adults: quote.adults,
          children: quote.children,
          infants: quote.infants,
          adultPrice: convertAmount(Number(quote.adultPrice), rate),
          childPrice: convertAmount(Number(quote.childPrice), rate),
          infantPrice: convertAmount(Number(quote.infantPrice), rate),
          taxes: pricing.taxes,
          serviceFee: pricing.serviceFee,
          gratuity: pricing.gratuity,
          total: pricing.total,
          currency: quote.currency,
        },
      });
    });
  });

  return { ok: true, bookingReference, bookingId: booking.id };
}

/** The booking for this quote, if one exists and was signed by the same
 * person (name + email) as the current submission. Used to turn a lost
 * race, a P2002, or an ambiguous commit into the original confirmation. */
async function findBookingForReplay(quoteId: string, submitted: { contactEmail: string; signedName: string }) {
  const existing = await prisma.booking.findUnique({
    where: { quoteId },
    select: { id: true, bookingReference: true, contactEmail: true, signature: { select: { signedName: true } } },
  });
  return existing && sameSigner(existing, submitted) ? existing : null;
}
