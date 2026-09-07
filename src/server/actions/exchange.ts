"use server";

import { z } from "zod";
import { nanoid, customAlphabet } from "nanoid";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { logActivity } from "@/server/activity-log";
import { calculatePricing } from "@/lib/pricing";
import { parseAirportDateTimeString } from "@/lib/airport-datetime";
import { quoteVisibilityWhere } from "@/server/visibility";
import { canApproveExchangeOrCancellation } from "@/lib/permissions";
import { SUPPORTED_CURRENCIES, convertToUsd, resolveExchangeRate } from "@/lib/currency";
import { segmentSchema } from "@/server/actions/quote-segment-schema";
import { REVISABLE_EXCHANGE_STATUSES } from "@/lib/exchange-proposal";
import type { QuoteStatus } from "@/generated/prisma/client";

const quoteNumberAlphabet = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 8);

const exchangeSchema = z
  .object({
    originalQuoteId: z.string(),
    // Pass 26 — when set, this call REVISES an existing, still-unsigned
    // exchange proposal (the id of the CURRENT proposal in the chain)
    // instead of proposing the first-ever exchange against a CHARGED
    // original. Always the id of a Quote whose own originalQuoteId already
    // equals `originalQuoteId` above — re-verified server-side, never
    // trusted as-is (see sendExchangeForApproval's own body).
    supersedesQuoteId: z.string().optional(),
    tripType: z.enum(["ONE_WAY", "ROUND_TRIP", "MULTI_CITY"]),
    // Part 1 — same three itinerary-source values a normal quote records
    // (Quote.source), now that the Exchange builder also supports Sabre/
    // Apollo paste-parsing, not just Manual Entry.
    source: z.enum(["MANUAL", "SABRE", "APOLLO"]).default("MANUAL"),
    segments: z.array(segmentSchema).min(1),
    adults: z.number().min(1),
    children: z.number().min(0),
    infants: z.number().min(0),
    adultPrice: z.number().min(0),
    childPrice: z.number().min(0),
    infantPrice: z.number().min(0),
    taxes: z.number().min(0),
    serviceFee: z.number().min(0),
    gratuity: z.number().min(0),
    currency: z.enum(SUPPORTED_CURRENCIES).default("USD"),
    exchangeRate: z.number().positive().optional(),
    termsAndConditions: z.string().optional(),
    // Exchange-specific fields — see Quote.exchangeFee/fareDifference/pnr's
    // own schema doc comments. All optional at the Zod level (an agent may
    // genuinely not know the fare difference yet). exchangeFee/
    // fareDifference are customer-facing once set (getQuoteByToken); pnr
    // stays internal-only.
    exchangeFee: z.number().min(0).optional(),
    fareDifference: z.number().optional(), // may be negative — a lower-priced replacement fare
    // Pass 13 §22/§23 — the STAFF-ONLY actual-cost counterparts (see
    // Quote.internalExchangeFee/internalFareDifference's own schema doc
    // comment). Never read by any customer-facing renderer; independent of
    // exchangeFee/fareDifference above, which may legitimately differ.
    internalExchangeFee: z.number().min(0).optional(),
    internalFareDifference: z.number().optional(),
    pnr: z.string().optional(),
    internalNotes: z.string().optional(),
  })
  .refine((v) => v.currency === "USD" || (v.exchangeRate !== undefined && v.exchangeRate > 0), {
    message: "An exchange rate is required for a non-USD currency",
    path: ["exchangeRate"],
  });

export type SendExchangeForApprovalInput = z.infer<typeof exchangeSchema>;

/**
 * The entire exchange proposal (new itinerary + exchange fee/fare
 * difference/notes/PNR) lives only in client state until this one action
 * is called — there is no separate "start"/"save draft" server round-trip
 * (matching the exchange workflow's own explicit two-button design: Cancel
 * Exchange vs Send for Approval — "cancel" is simply never calling this,
 * nothing to clean up server-side). Creates the new exchange Quote (its
 * own real Quote+Itinerary+segments row, reusing the exact same shape
 * createQuote() builds, linked via originalQuoteId) at
 * PENDING_EXCHANGE_APPROVAL, and moves the ORIGINAL quote to EXCHANGED —
 * atomically, in one transaction, so the two can never end up
 * inconsistent with each other.
 *
 * Pass 26 — this is also THE canonical entry point for creating a REVISED
 * proposal (input.supersedesQuoteId set): same schema, same pricing/total
 * validation, same notification fan-out — the only difference is which
 * precondition gates it (an existing revisable proposal instead of a
 * CHARGED original) and that the OLD proposal is atomically superseded
 * instead of the TRUE original being moved to EXCHANGED a second time.
 * Deliberately one function, not two competing ones — see its own body for
 * the branch. A fresh approval cycle always starts at
 * PENDING_EXCHANGE_APPROVAL regardless of what state the proposal being
 * replaced was in (even EXCHANGE_APPROVED or already SENT/READ/VIEWED) —
 * approval can never carry over from one proposal version to the next.
 */
export async function sendExchangeForApproval(input: SendExchangeForApprovalInput) {
  const parsed = exchangeSchema.parse(input);
  const actor = await getCurrentAccount();
  if (!actor) throw new Error("Not signed in");

  const original = await prisma.quote.findFirst({
    where: { id: parsed.originalQuoteId, ...quoteVisibilityWhere(actor) },
    select: { id: true, status: true, leadId: true, contactId: true },
  });
  if (!original) throw new Error("Quote not found");

  // Pass 26 — two distinct, mutually-exclusive preconditions depending on
  // whether this call is proposing the FIRST exchange against a charged
  // quote, or REVISING an existing, still-unsigned proposal (Part 2's
  // versioning requirement). Re-derived entirely server-side — the
  // supersedesQuoteId the client submits is only ever a hint about WHICH
  // proposal to look up, never trusted as a claim that it's actually the
  // current/revisable one.
  let supersedes: { id: string; status: QuoteStatus; quoteNumber: string } | null = null;
  if (parsed.supersedesQuoteId) {
    const candidate = await prisma.quote.findFirst({
      where: { id: parsed.supersedesQuoteId, originalQuoteId: original.id, ...quoteVisibilityWhere(actor) },
      select: { id: true, status: true, quoteNumber: true, isCurrentExchangeProposal: true },
    });
    if (!candidate) throw new Error("The exchange proposal being revised was not found.");
    if (!candidate.isCurrentExchangeProposal || !REVISABLE_EXCHANGE_STATUSES.has(candidate.status)) {
      // Covers every reason revision is no longer possible: already
      // superseded by someone else, already disapproved, or already signed
      // (a real Booking now exists for it) — one honest message for all of
      // them rather than guessing which applies from a stale snapshot.
      throw new Error("This proposal is no longer active — it may have already been revised, signed, or reviewed. Please refresh and try again.");
    }
    supersedes = candidate;
  } else if (original.status !== "CHARGED") {
    // Server-side re-enforcement of "Exchange is only available for charged
    // quotes" — the button being hidden client-side for any other status is
    // a UX nicety, never the actual authorization boundary.
    throw new Error("Only a charged quote can be exchanged.");
  }

  const pricing = calculatePricing(parsed);

  // Pass 13 §25 — server-side re-derivation of the authoritative total,
  // never trusting the browser-submitted adultPrice/total on their own.
  // The builder's own client-side math already makes adultPrice a
  // structural function of exchangeFee+fareDifference (never an
  // independently-entered value) — this is the same check enforced again
  // here, so a request built by hand (bypassing the UI entirely) can never
  // submit a `total` that doesn't actually match Customer Exchange Fee +
  // Customer Fare Difference. Only checked when at least one of the two is
  // provided — an exchange with neither set yet has no customer total to
  // validate against.
  if (parsed.exchangeFee != null || parsed.fareDifference != null) {
    const customerTotal = (parsed.exchangeFee ?? 0) + (parsed.fareDifference ?? 0);
    const rate = resolveExchangeRate(parsed.currency, parsed.currency === "USD" ? null : (parsed.exchangeRate ?? null));
    const expectedTotalUsd = convertToUsd(customerTotal, rate);
    if (Math.abs(expectedTotalUsd - pricing.total) > 0.01) {
      throw new Error("The submitted total does not match Customer Exchange Fee + Customer Fare Difference — please re-check the values.");
    }
  }

  const quoteNumber = `Q-${quoteNumberAlphabet()}`;
  const secureToken = nanoid(32);

  const exchangeQuoteId = await prisma.$transaction(async (tx) => {
    const exchangeQuote = await tx.quote.create({
      data: {
        quoteNumber,
        secureToken,
        leadId: original.leadId,
        contactId: original.contactId,
        agentId: actor.id,
        originalQuoteId: original.id,
        status: "PENDING_EXCHANGE_APPROVAL",
        // Pass 26 — when revising (supersedes set), created as NOT yet the
        // current proposal and only flipped to true below, AFTER the old
        // proposal has been atomically claimed and flipped to false in the
        // same transaction — never both true at once, which the
        // [originalQuoteId, isCurrentExchangeProposal] unique index would
        // reject anyway. When this is the first-ever proposal (no existing
        // current row for this original), it's safe to mark current
        // immediately.
        isCurrentExchangeProposal: supersedes ? null : true,
        source: parsed.source,
        adults: parsed.adults,
        children: parsed.children,
        infants: parsed.infants,
        adultPrice: parsed.adultPrice,
        childPrice: parsed.childPrice,
        infantPrice: parsed.infantPrice,
        taxes: parsed.taxes,
        serviceFee: parsed.serviceFee,
        gratuity: parsed.gratuity,
        total: pricing.total,
        currency: parsed.currency,
        exchangeRate: parsed.currency === "USD" ? null : parsed.exchangeRate,
        termsAndConditions: parsed.termsAndConditions,
        exchangeFee: parsed.exchangeFee,
        fareDifference: parsed.fareDifference,
        internalExchangeFee: parsed.internalExchangeFee,
        internalFareDifference: parsed.internalFareDifference,
        pnr: parsed.pnr,
        internalNotes: parsed.internalNotes,
        statusHistory: {
          create: [
            {
              toStatus: "PENDING_EXCHANGE_APPROVAL",
              changedById: actor.id,
              note: supersedes
                ? `Revised exchange proposal against ${parsed.originalQuoteId}, superseding ${supersedes.quoteNumber}`
                : `Exchange proposed against ${parsed.originalQuoteId}`,
            },
          ],
        },
        itinerary: {
          create: {
            tripType: parsed.tripType,
            segments: {
              create: parsed.segments.map((s) => ({
                sequence: s.sequence,
                departureAirportId: s.departureAirportId,
                arrivalAirportId: s.arrivalAirportId,
                departureAt: parseAirportDateTimeString(s.departureAt),
                arrivalAt: parseAirportDateTimeString(s.arrivalAt),
                airlineId: s.airlineId,
                airlineCodeRaw: s.airlineCodeRaw,
                flightNumber: s.flightNumber,
                bookingClass: s.bookingClass,
                cabin: s.cabin,
                aircraftTypeId: s.aircraftTypeId,
                aircraftRaw: s.aircraftRaw,
                operatingCarrierName: s.operatingCarrierName,
                durationMinutes: s.durationMinutes,
                connectionType: s.connectionType,
                isExtraLeg: s.isExtraLeg ?? false,
              })),
            },
          },
        },
      },
      select: { id: true },
    });

    if (supersedes) {
      // The atomic claim: only succeeds if the proposal being revised is
      // STILL the current one and STILL in a revisable status at the
      // instant this statement actually runs — closing the race window
      // between the pre-check above and this transaction (two concurrent
      // "New Exchange Proposal" submissions, or a revision racing an
      // Admin's Approve/Disapprove click). A conditional updateMany, not a
      // plain update by id — the same atomic-claim-before-side-effect
      // pattern used throughout this codebase (see e.g. the airline-
      // confirmation first-send claim). If this affects 0 rows, the
      // transaction throws and Prisma rolls back everything in it,
      // including the exchangeQuote row just created above — no orphan.
      const claim = await tx.quote.updateMany({
        where: { id: supersedes.id, isCurrentExchangeProposal: true, status: { in: [...REVISABLE_EXCHANGE_STATUSES] } },
        data: { isCurrentExchangeProposal: null, status: "EXCHANGE_SUPERSEDED", supersededByQuoteId: exchangeQuote.id, lastActivityAt: new Date() },
      });
      if (claim.count !== 1) {
        throw new Error("This proposal was just changed by someone else — please refresh and try again.");
      }
      await tx.quoteStatusHistory.create({
        data: { quoteId: supersedes.id, fromStatus: supersedes.status, toStatus: "EXCHANGE_SUPERSEDED", changedById: actor.id, note: `Superseded by revised proposal ${quoteNumber}` },
      });
      // Only now safe to mark the new quote current — the old one is
      // already flipped to null within this same transaction, so the
      // unique index never sees two TRUE rows for this originalQuoteId at
      // once, even momentarily.
      await tx.quote.update({ where: { id: exchangeQuote.id }, data: { isCurrentExchangeProposal: true } });
      // The TRUE original stays exactly as it already is (EXCHANGED, set
      // when the first proposal was created) — never touched again by a
      // revision. This is the literal enforcement of "original Booking/
      // PNR/ticket status/cost must remain completely untouched by
      // creating a new proposal."
    } else {
      // Direct write, not transitionQuoteStatus() — EXCHANGED is one of the
      // branch statuses deliberately excluded from that function's linear
      // DRAFT..CHARGED rank progression (see quote-status.ts's STATUS_RANK
      // comment); this action's own CHARGED-only precondition above is the
      // real guard, not a generic rank check.
      await tx.quote.update({ where: { id: original.id }, data: { status: "EXCHANGED", lastActivityAt: new Date() } });
      await tx.quoteStatusHistory.create({
        data: { quoteId: original.id, fromStatus: "CHARGED", toStatus: "EXCHANGED", changedById: actor.id, note: `Exchange proposed: ${quoteNumber}` },
      });
    }

    return exchangeQuote.id;
  });

  await logActivity({
    quoteId: exchangeQuoteId,
    leadId: original.leadId,
    contactId: original.contactId,
    actorId: actor.id,
    type: "QUOTE_CREATED",
    description: `Exchange quote ${quoteNumber} proposed against quote ${parsed.originalQuoteId}, pending approval`,
  });

  // Notify every Admin/Manager in the actor's own company — the only
  // roles who can act on this (canApproveExchangeOrCancellation).
  const reviewers = await prisma.account.findMany({
    where: { companyId: actor.companyId, status: "ACTIVE", role: { in: ["ADMIN", "MANAGER"] } },
    select: { id: true },
  });
  if (reviewers.length > 0) {
    await prisma.notification.createMany({
      data: reviewers.map((r) => ({
        accountId: r.id,
        quoteId: exchangeQuoteId,
        leadId: original.leadId,
        type: "EXCHANGE_PENDING_APPROVAL",
        title: "Exchange Pending Approval",
        body: supersedes
          ? `${actor.fullName} sent a revised exchange proposal (${quoteNumber}), replacing ${supersedes.quoteNumber} for quote ${parsed.originalQuoteId} — awaiting review.`
          : `${actor.fullName} proposed an exchange (${quoteNumber}) for quote ${parsed.originalQuoteId} — awaiting review.`,
      })),
    });
  }

  revalidatePath(`/quotes/${original.id}`);
  revalidatePath(`/quotes/${exchangeQuoteId}`);
  if (supersedes) revalidatePath(`/quotes/${supersedes.id}`);
  revalidatePath("/quotes");

  return { exchangeQuoteId };
}

/**
 * Admin/Manager only — approves a pending exchange. Moves the exchange
 * quote to EXCHANGE_APPROVED, from which the EXISTING sendQuote() action
 * (unchanged) can send it to the customer — see quote-actions.tsx's Send
 * button, extended to also show for this status. The original quote and
 * its itinerary are never touched here; they stay exactly as EXCHANGED for
 * historical reference, per the "never lose the original itinerary"
 * requirement.
 */
export async function approveExchange(exchangeQuoteId: string) {
  const actor = await getCurrentAccount();
  if (!actor || !canApproveExchangeOrCancellation(actor.role)) {
    throw new Error("Only an Admin or Manager can approve an exchange.");
  }

  const exchangeQuote = await prisma.quote.findFirst({
    where: { id: exchangeQuoteId, ...quoteVisibilityWhere(actor) },
    select: { id: true, status: true, leadId: true, contactId: true, originalQuoteId: true, quoteNumber: true, agentId: true },
  });
  if (!exchangeQuote) throw new Error("Exchange quote not found");
  if (!exchangeQuote.originalQuoteId) throw new Error("This quote is not an exchange request.");
  if (exchangeQuote.status !== "PENDING_EXCHANGE_APPROVAL") {
    throw new Error("This exchange has already been reviewed.");
  }

  // Pass 26 §50-53 — an interactive transaction with a conditional
  // updateMany claim, not a plain update-by-id, so a concurrent event on
  // this exact row (an agent revising this proposal — sendExchangeForApproval's
  // own claim on the SAME row — or a duplicate double-click of Approve
  // itself) can never both "succeed": whichever transaction's UPDATE
  // commits first wins the row lock; the loser's WHERE clause is
  // re-evaluated against the now-changed row and matches nothing. The
  // pre-check above already gives a fast, clear error in the common
  // (non-racing) case — this is the real, race-proof floor underneath it.
  await prisma.$transaction(async (tx) => {
    const claim = await tx.quote.updateMany({
      where: { id: exchangeQuoteId, status: "PENDING_EXCHANGE_APPROVAL" },
      data: { status: "EXCHANGE_APPROVED", reviewedById: actor.id, reviewedAt: new Date(), lastActivityAt: new Date() },
    });
    if (claim.count !== 1) {
      throw new Error("This exchange has already been reviewed.");
    }
    await tx.quoteStatusHistory.create({
      data: { quoteId: exchangeQuoteId, fromStatus: "PENDING_EXCHANGE_APPROVAL", toStatus: "EXCHANGE_APPROVED", changedById: actor.id },
    });
  });

  await logActivity({
    quoteId: exchangeQuoteId,
    leadId: exchangeQuote.leadId,
    contactId: exchangeQuote.contactId,
    actorId: actor.id,
    type: "QUOTE_STATUS_CHANGED",
    description: `Exchange ${exchangeQuote.quoteNumber} approved by ${actor.fullName}`,
  });

  // Let the original exchange requester know it's ready to send.
  if (exchangeQuote.agentId) {
    await prisma.notification.create({
      data: {
        accountId: exchangeQuote.agentId,
        quoteId: exchangeQuoteId,
        leadId: exchangeQuote.leadId,
        type: "EXCHANGE_APPROVED",
        title: "Exchange Approved",
        body: `${actor.fullName} approved your exchange proposal ${exchangeQuote.quoteNumber} — ready to send to the customer.`,
      },
    });
  }

  revalidatePath(`/quotes/${exchangeQuoteId}`);
  revalidatePath(`/quotes/${exchangeQuote.originalQuoteId}`);
  revalidatePath("/quotes");
}

/**
 * Admin/Manager only — rejects a pending exchange. The exchange quote
 * itself is preserved (never deleted) at EXCHANGE_DISAPPROVED for
 * audit/history; the ORIGINAL quote returns to CHARGED, mirroring exactly
 * how cancelExchange leaves it — the customer's existing booking is
 * completely unaffected by a rejected exchange proposal. No customer email
 * is ever sent for a disapproved exchange.
 */
export async function disapproveExchange(exchangeQuoteId: string) {
  const actor = await getCurrentAccount();
  if (!actor || !canApproveExchangeOrCancellation(actor.role)) {
    throw new Error("Only an Admin or Manager can reject an exchange.");
  }

  const exchangeQuote = await prisma.quote.findFirst({
    where: { id: exchangeQuoteId, ...quoteVisibilityWhere(actor) },
    select: { id: true, status: true, leadId: true, contactId: true, originalQuoteId: true, quoteNumber: true, agentId: true },
  });
  if (!exchangeQuote) throw new Error("Exchange quote not found");
  if (!exchangeQuote.originalQuoteId) throw new Error("This quote is not an exchange request.");
  if (exchangeQuote.status !== "PENDING_EXCHANGE_APPROVAL") {
    throw new Error("This exchange has already been reviewed.");
  }

  // Pass 26 §50-53 — same conditional-claim race protection as
  // approveExchange above, guarding against a concurrent revision or a
  // duplicate double-click of Disapprove landing on the same row.
  await prisma.$transaction(async (tx) => {
    const claim = await tx.quote.updateMany({
      where: { id: exchangeQuoteId, status: "PENDING_EXCHANGE_APPROVAL" },
      data: {
        status: "EXCHANGE_DISAPPROVED",
        reviewedById: actor.id,
        reviewedAt: new Date(),
        lastActivityAt: new Date(),
        // Pass 26 — no longer the "current" proposal once disapproved, so
        // a fresh sendExchangeForApproval call (the first-ever-proposal
        // path, once the original is back at CHARGED below) can freely
        // mark ITS new quote current without colliding with this dead
        // one on the [originalQuoteId, isCurrentExchangeProposal] unique
        // index.
        isCurrentExchangeProposal: null,
      },
    });
    if (claim.count !== 1) {
      throw new Error("This exchange has already been reviewed.");
    }
    await tx.quoteStatusHistory.create({
      data: { quoteId: exchangeQuoteId, fromStatus: "PENDING_EXCHANGE_APPROVAL", toStatus: "EXCHANGE_DISAPPROVED", changedById: actor.id },
    });
    // The original quote returns to exactly where it was before the
    // exchange was proposed — never left in the transitional EXCHANGED
    // state once its one pending exchange has been rejected.
    await tx.quote.update({
      where: { id: exchangeQuote.originalQuoteId! },
      data: { status: "CHARGED", lastActivityAt: new Date() },
    });
    await tx.quoteStatusHistory.create({
      data: { quoteId: exchangeQuote.originalQuoteId!, fromStatus: "EXCHANGED", toStatus: "CHARGED", changedById: actor.id, note: `Exchange ${exchangeQuote.quoteNumber} disapproved` },
    });
  });

  await logActivity({
    quoteId: exchangeQuoteId,
    leadId: exchangeQuote.leadId,
    contactId: exchangeQuote.contactId,
    actorId: actor.id,
    type: "QUOTE_STATUS_CHANGED",
    description: `Exchange ${exchangeQuote.quoteNumber} disapproved by ${actor.fullName}`,
  });

  if (exchangeQuote.agentId) {
    await prisma.notification.create({
      data: {
        accountId: exchangeQuote.agentId,
        quoteId: exchangeQuoteId,
        leadId: exchangeQuote.leadId,
        type: "EXCHANGE_DISAPPROVED",
        title: "Exchange Disapproved",
        body: `${actor.fullName} did not approve your exchange proposal ${exchangeQuote.quoteNumber}. The original quote remains Charged.`,
      },
    });
  }

  revalidatePath(`/quotes/${exchangeQuoteId}`);
  revalidatePath(`/quotes/${exchangeQuote.originalQuoteId}`);
  revalidatePath("/quotes");
}
