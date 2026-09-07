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
import { getPaymentVault } from "@/server/security/payment-vault";
import { isValidCardNumber, isValidExpiry, isValidCvvFormat, detectCardBrand, lastFour, digitsOnly, isPaymentAllocationValid } from "@/lib/card-validation";
import { getClientIp } from "@/lib/request-ip";
import { recordIpCapture } from "@/server/security/ip-capture";
import { cacheCvv } from "@/server/security/cvv-cache";
import { passengerSchema } from "@/server/actions/booking-schema";
import { sendBookingSignedNotification } from "@/server/booking-notification";
import { resolveBaseUrl } from "@/lib/company-config";
import { LEGAL_CONTENT_VERSION } from "@/lib/legal-content";
import { checkPublicRateLimitFromRequest, RATE_LIMITS } from "@/server/security/rate-limit";
import { isQuoteBookable } from "@/lib/exchange-proposal";

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
export async function trackViewDealClicked(token: string) {
  const quote = await prisma.quote.findUnique({ where: { secureToken: token } });
  if (!quote) return;
  if (quote.status === "SENT" || quote.status === "READ") {
    await transitionQuoteStatus(quote.id, "VIEWED", { activityDescription: "Customer clicked View Deal" });
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
  const already = await prisma.activity.findFirst({ where: { quoteId: quote.id, type: "BOOKING_FORM_STARTED" }, select: { id: true } });
  if (already) return;
  await logActivity({
    quoteId: quote.id,
    leadId: quote.leadId,
    contactId: quote.contactId,
    type: "BOOKING_FORM_STARTED",
    description: "Customer opened the booking form",
  });
}

// One customer-entered card, as part of a (possibly multi-card) payment
// split. cardNumber/cvv exist only transiently inside submitBooking()'s own
// function body — see the loop below for exactly where each is used and
// discarded; neither is ever written to a Prisma call, logged, or included
// in any error message.
const cardEntrySchema = z.object({
  cardholderName: z.string().min(1),
  cardNumber: z.string().min(12).max(23), // allows spaces; stripped before validation
  expiryMonth: z.number().int().min(1).max(12),
  expiryYear: z.number().int(),
  cvv: z.string().min(3).max(4),
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
  // Card collection — native CRM fields, no external processor. One or
  // more payment methods, each with its own allocated amount (a booking
  // may split payment across multiple cards) — the server independently
  // re-validates every one of these (format checks on the client are UX
  // only, never trusted as a security control) and independently
  // re-validates that the allocated amounts sum to the booking total.
  paymentMethods: z.array(cardEntrySchema).min(1).max(6),
  paymentConsent: z.literal(true),
  gratuityAmount: z.number().min(0),
  termsAccepted: z.literal(true),
  signedName: z.string().min(1),
});

export type SubmitBookingInput = z.infer<typeof submitBookingSchema>;

export async function submitBooking(input: SubmitBookingInput) {
  // Pass 25 §28 — public-endpoint rate limiting, checked first, before any
  // parsing/DB work. Fails open (never blocks) when no trustworthy client
  // IP is available — see rate-limit.ts's own doc comment for why that's
  // the correct, deliberate behavior, not an oversight.
  const rateLimitCheck = await checkPublicRateLimitFromRequest("BOOKING_SUBMIT", RATE_LIMITS.BOOKING_SUBMIT);
  if (!rateLimitCheck.allowed) {
    return { ok: false as const, error: "Too many booking attempts from this connection. Please wait a few minutes and try again." };
  }

  const parsed = submitBookingSchema.parse(input);

  const quote = await prisma.quote.findUnique({
    where: { secureToken: parsed.token },
    include: { lead: true, contact: true, agent: true, sentByAgent: true, booking: true },
  });
  if (!quote) return { ok: false as const, error: "Quote not found" };
  if (quote.status === "CANCELED") return { ok: false as const, error: "This quote has been canceled" };
  if (quote.booking) return { ok: false as const, error: "This quote has already been booked" };
  // Pass 26 §2 — stale/superseded/pre-review token protection, the real
  // authorization boundary a customer's secureToken must satisfy before it
  // can ever create a Booking. `quote.booking == null` above rules out a
  // quote that's already been signed, but nothing previously stopped a
  // token for a quote that was NEVER actually sent (DRAFT, still
  // PENDING_EXCHANGE_APPROVAL/EXCHANGE_APPROVED before sendQuote), or one
  // that WAS sent but has since been superseded by a revised proposal
  // (EXCHANGE_SUPERSEDED) or rejected outright (EXCHANGE_DISAPPROVED) —
  // every one of those still had a real, guessable-only-by-having-received-
  // the-original-email secureToken that would otherwise have silently
  // accepted a signature. isQuoteBookable (src/lib/exchange-proposal.ts) is
  // the one shared allow-list; only a quote actually SENT to the customer
  // and not yet acted on may be booked.
  if (!isQuoteBookable(quote.status)) {
    return { ok: false as const, error: "This link is no longer active. Please contact your travel agent for your current quote." };
  }

  // Server-side validation — the authoritative check, independent of
  // whatever the client already validated. Error messages are always
  // generic; never echo any part of any submitted card number or CVV.
  // Each card's cardNumberDigits/cvv exist only for the duration of this
  // loop iteration — never carried into the Prisma write, a log line, or
  // any error message.
  // preparedCards holds every field that is permanently retained (per the
  // approved architecture). The CVV is deliberately kept in a SEPARATE
  // array, cvvsByIndex, that never touches preparedCards, never reaches the
  // Prisma create() call below, and is only ever used once — to seed the
  // transient authorization cache (cvv-cache.ts) immediately after the
  // corresponding PaymentMethod row's id is known. Once that seeding loop
  // finishes, cvvsByIndex goes out of scope and is not referenced again.
  const preparedCards: Array<{ cardholderName: string; encryptedPan: string; last4: string; cardBrand: string | undefined; expiryMonth: number; expiryYear: number; amount: number }> = [];
  const cvvsByIndex: string[] = [];
  for (const card of parsed.paymentMethods) {
    const cardNumberDigits = digitsOnly(card.cardNumber);
    const cardBrand = detectCardBrand(cardNumberDigits);
    if (!isValidCardNumber(cardNumberDigits)) {
      return { ok: false as const, error: "Payment information could not be processed" };
    }
    if (!isValidExpiry(card.expiryMonth, card.expiryYear)) {
      return { ok: false as const, error: "Payment information could not be processed" };
    }
    if (!isValidCvvFormat(card.cvv, cardBrand)) {
      return { ok: false as const, error: "Payment information could not be processed" };
    }
    const encryptedPan = await getPaymentVault().store(cardNumberDigits);
    preparedCards.push({
      cardholderName: card.cardholderName,
      encryptedPan,
      last4: lastFour(cardNumberDigits),
      cardBrand: cardBrand === "Unknown" ? undefined : cardBrand,
      expiryMonth: card.expiryMonth,
      expiryYear: card.expiryYear,
      amount: card.amount,
    });
    cvvsByIndex.push(card.cvv);
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
  // sent (never a freshly-looked-up rate; see buildPricingSnapshot's own
  // comment for why re-converting later would drift from what the
  // customer was actually quoted). This is the authoritative total that
  // payment allocation is validated against and that gets persisted below
  // — a USD quote keeps rate 1 and this is a no-op.
  const rate = resolveExchangeRate(quote.currency, quote.exchangeRate ? Number(quote.exchangeRate) : null);
  const pricing = convertBookingPricing(usdPricing, rate);

  // Payment allocation must exactly cover the booking total — see
  // isPaymentAllocationValid's own comment for why (no partial-payment
  // business rule exists in this app).
  if (!isPaymentAllocationValid(preparedCards.map((c) => c.amount), pricing.total)) {
    return { ok: false as const, error: "Payment allocation does not match the booking total" };
  }

  const bookingReference = `BFT-${bookingRefAlphabet()}`;
  const headerList = await headers();
  // Server-determined only — never accepts a client-submitted IP field.
  // See request-ip.ts for the trusted-proxy assumption and IPv4/IPv6
  // validation (a malformed/spoofed header value resolves to undefined
  // rather than being stored as a garbage string).
  const ip = getClientIp(headerList);
  const userAgent = headerList.get("user-agent") ?? undefined;

  // Pass 19 §8 — race-condition audit. The `if (quote.booking) return ...`
  // check above is a real check, but it reads BEFORE this create — a
  // genuine double-click (or a refresh-during-submit resending the same
  // request) can race two submitBooking calls close enough together that
  // BOTH pass that check before either has committed a Booking row. The
  // actual data-integrity guarantee is `Booking.quoteId @unique` in the
  // schema (already in place, not new) — Postgres itself rejects the
  // second concurrent insert, so a duplicate Booking was never actually
  // possible. What WAS missing: nothing here caught that specific,
  // predictable failure, so the unlucky second request would have thrown
  // an unhandled Prisma unique-constraint error instead of returning the
  // same clean, already-established "This quote has already been booked"
  // message the non-race path already gives. This narrows a rare bad-UX
  // edge case (a customer's second, redundant click seeing a generic
  // error instead of a clear one) without changing the actual safety
  // guarantee, which was already correct.
  let booking;
  try {
    booking = await prisma.booking.create({
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
      termsAcceptedAt: new Date(),
      // Pass 24 — the version of the legal text actually shown on THIS
      // signing (see legal-content.ts's own doc comment); never touched
      // afterward, and never backfilled for bookings that predate this
      // field (they simply keep termsVersion = null).
      termsVersion: LEGAL_CONTENT_VERSION,
      status: "PENDING_TICKETING",
      // Pass 22 fix — these three columns are documented (see
      // convertToUsd's own comment in currency.ts) as ALWAYS USD, the same
      // "agent tracks internal cost in USD" convention Quote itself uses —
      // unlike gratuityAmount/totalAmount just above, which are correctly
      // the customer-currency-converted `pricing` values. This previously
      // seeded all three from the CONVERTED `pricing` breakdown instead of
      // the raw `usdPricing` one, so every non-USD booking silently stored
      // a foreign-currency figure in a column computeBookingProfitUsd (and
      // the ticketing UI's bare "$" Ticket Cost field) both treat as
      // already-correct USD — producing a wrong profit/commission number
      // for that booking unless a ticketing agent happened to overwrite
      // every one of these fields before confirming it. These remain a
      // pre-fill/starting point for the ticketing agent to edit once the
      // real airline cost is known, exactly as before — only the currency
      // of the seeded number changes.
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
          // Explicit UTC-midnight anchor for this date-only ("YYYY-MM-DD")
          // value — matches the established pattern for date-only fields
          // elsewhere in this app (e.g. Account.hiredAt in
          // account-row-editor.tsx). A bare new Date("YYYY-MM-DD") already
          // parses as UTC per spec, but this app's naive (non-tz) Postgres
          // `timestamp` columns have shown local-process-timezone-dependent
          // round-trip behavior — being explicit here removes any doubt and
          // keeps every date-only write site in the app doing the same thing.
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
    },
    include: { signature: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false as const, error: "This quote has already been booked" };
    }
    throw err;
  }

  // Correlation log for the signing event itself — no request/correlation-
  // id concept exists elsewhere in this codebase, so a full framework would
  // be disproportionate here. Signature.id + Booking.id + signedAt already
  // form a stable, unique key; logging them at the moment of signing makes
  // this event grep-able against the deployment platform's own request
  // logs (e.g. Vercel's dashboard, searchable by timestamp) for fraud/
  // dispute investigation, without inventing new infrastructure. Never logs
  // the raw IP itself — only whether one was actually captured — since a
  // platform's own log dashboard is a much less tightly-controlled surface
  // than the permission-gated Reveal flow/IP vault that hold the real
  // value; see request-ip.ts and ip-encryption.ts's own header comments.
  console.log(
    JSON.stringify({
      event: "booking_signed",
      bookingId: booking.id,
      signatureId: booking.signature!.id,
      signedAt: booking.signature!.signedAt.toISOString(),
      ipCaptured: ip != null,
    })
  );

  // "IP vault" — an additional, permanent, encrypted, cross-booking
  // history row (see IpCapture's schema doc comment), on top of this
  // booking's own Signature.ipAddress above. Best-effort: never blocks or
  // fails the booking itself. Covers both a first-time booking and an
  // exchange's own signing step (same submitBooking call for both — an
  // exchange quote's originalQuoteId is set, an ordinary quote's is not).
  await recordIpCapture({
    ip,
    userAgent,
    formType: quote.originalQuoteId ? "EXCHANGE_BOOKING" : "NEW_BOOKING",
    bookingId: booking.id,
    signerName: parsed.signedName,
    signerEmail: parsed.contactEmail,
    companyId: quote.contact?.companyId,
    quoteId: quote.id,
  });

  // Payment methods are created individually (not as a single nested
  // `create: [...]`) specifically so each row's generated id is known the
  // instant it's created, with zero ambiguity about which id corresponds to
  // which card — a nested create + a separate unordered read-back could not
  // give that guarantee, and guessing wrong here would mean caching a CVV
  // under the WRONG payment method's id (i.e. cross-card CVV leakage),
  // which is explicitly forbidden. Each card's CVV is cached (see
  // cvv-cache.ts — the ONLY write of a CVV value anywhere in this codebase,
  // and never a Prisma call) immediately after that specific card's row
  // exists, using cvvsByIndex[i] from the exact same loop index that built
  // preparedCards[i].
  for (let i = 0; i < preparedCards.length; i++) {
    const c = preparedCards[i];
    const paymentMethod = await prisma.paymentMethod.create({
      data: {
        bookingId: booking.id,
        // Also attributed to the customer's Contact record — see §34: a
        // booking-submitted card must be associated with both Contact and
        // Booking, so it shows up under the Contact's own "Payment Methods"
        // section, not only on this specific booking's detail page.
        contactId: quote.contactId,
        cardholderName: c.cardholderName,
        encryptedPan: c.encryptedPan,
        last4: c.last4,
        cardBrand: c.cardBrand,
        expiryMonth: c.expiryMonth,
        expiryYear: c.expiryYear,
        amountAllocated: c.amount,
        consentGivenAt: new Date(),
      },
    });
    cacheCvv(paymentMethod.id, cvvsByIndex[i]);
  }

  // SIGNED is transitioned inline here (rather than via
  // transitionQuoteStatus) because it must stay atomic with the Lead ->
  // BOOKED update in the same transaction — but it still bumps
  // lastActivityAt and fires the same agent notification via
  // notifyQuoteActivity() afterward, so this path stays consistent with
  // every other quote-status transition rather than silently diverging.
  await prisma.$transaction([
    // Quote.gratuity/Quote.total are the quote's own internal USD ledger
    // fields (agent-entered pricing, source of truth for the itinerary
    // builder/quote email) — must stay USD here, using usdPricing, never
    // the currency-converted `pricing` above, or a non-USD quote's own
    // record would get silently corrupted with converted numbers.
    prisma.quote.update({ where: { id: quote.id }, data: { status: "SIGNED", signedAt: new Date(), lastActivityAt: new Date(), gratuity: usdPricing.gratuity, total: usdPricing.total } }),
    prisma.quoteStatusHistory.create({ data: { quoteId: quote.id, fromStatus: quote.status, toStatus: "SIGNED" } }),
    prisma.lead.update({ where: { id: quote.leadId }, data: { status: "BOOKED" } }),
    prisma.leadStatusHistory.create({ data: { leadId: quote.leadId, fromStatus: quote.lead.status, toStatus: "BOOKED" } }),
  ]);

  await logActivity({
    quoteId: quote.id,
    leadId: quote.leadId,
    contactId: quote.contactId,
    bookingId: booking.id,
    type: "BOOKING_SUBMITTED",
    description: `Booking ${bookingReference} submitted by customer`,
  });

  await notifyQuoteActivity(
    { id: quote.id, agentId: quote.agentId, leadId: quote.leadId, quoteNumber: quote.quoteNumber, contact: quote.contact },
    "SIGNED"
  );

  // "Booking Form Signed" staff notification — see
  // src/server/booking-notification.ts for the full recipient/sender/
  // idempotency/failure-handling logic. Called after everything above has
  // already committed, so a notification problem can never affect the
  // booking's own success — sendBookingSignedNotification() never throws.
  {
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
      // Falls back to the current agent only for a quote sent before that
      // field existed (sentByAgentId is null for it).
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
        // Same UTC-midnight anchor as the passenger-creation site above.
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
  }

  revalidatePath(`/leads/${quote.leadId}`);
  revalidatePath("/leads");
  revalidatePath(`/quotes/${quote.id}`);
  revalidatePath("/bookings");
  revalidatePath("/dashboard");

  return { ok: true as const, bookingReference, bookingId: booking.id };
}
