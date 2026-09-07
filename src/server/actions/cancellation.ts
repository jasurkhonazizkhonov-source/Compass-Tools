"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/request-ip";
import { recordIpCapture } from "@/server/security/ip-capture";
import { getCurrentAccount } from "@/lib/dev-session";
import { logActivity } from "@/server/activity-log";
import { quoteVisibilityWhere } from "@/server/visibility";
import { canApproveExchangeOrCancellation } from "@/lib/permissions";
import { sendEmail } from "@/server/email/service";
import { buildCancellationScheduledEmail } from "@/server/email/templates";
import { toEmailSegments } from "@/server/email/segment-mapper";
import { getCompanyForAccountId, getCompanyForContactId } from "@/server/queries/company";
import { SEGMENT_SELECT } from "@/server/queries/segment-select";
import { resolveBaseUrl } from "@/lib/company-config";
import { isSupportedCurrency } from "@/lib/currency";
import type { AccountRole } from "@/generated/prisma/client";
import { checkPublicRateLimitFromRequest, RATE_LIMITS } from "@/server/security/rate-limit";

const requestCancellationSchema = z.object({
  quoteId: z.string(),
  // Which individual FlightSegment rows (of the quote's OWN itinerary) are
  // proposed for cancellation — never assumed to be "all of them". Server
  // re-validates every id actually belongs to this quote's itinerary below
  // (never trusts the client-supplied id list on its own).
  segmentIds: z.array(z.string()).min(1),
  cancellationFee: z.number().min(0).optional(),
  pnr: z.string().optional(),
  internalNotes: z.string().optional(),
});

export type RequestCancellationInput = z.infer<typeof requestCancellationSchema>;

/**
 * Charged-quote-only cancellation request — records exactly which segments
 * were proposed (never "cancel means cancel everything"), moves the quote
 * to PENDING_CANCELLATION_APPROVAL, and notifies every Admin/Manager who
 * can act on it. Unlike Exchange, this deliberately does NOT create a
 * second Quote row — a cancellation proposes no new itinerary, only flags
 * existing segments, so QuoteCancellationRequest (a lightweight linked
 * record, not a full quote) is all that's needed. See its schema doc
 * comment for why more than one request can exist against the same quote
 * over time (a disregarded one never blocks a later new one).
 */
export async function sendCancellationForApproval(input: RequestCancellationInput) {
  const parsed = requestCancellationSchema.parse(input);
  const actor = await getCurrentAccount();
  if (!actor) throw new Error("Not signed in");

  const quote = await prisma.quote.findFirst({
    where: { id: parsed.quoteId, ...quoteVisibilityWhere(actor) },
    select: {
      id: true,
      status: true,
      leadId: true,
      contactId: true,
      quoteNumber: true,
      itinerary: { select: { segments: { select: { id: true } } } },
    },
  });
  if (!quote) throw new Error("Quote not found");
  if (quote.status !== "CHARGED") {
    throw new Error("Only a charged quote can have a cancellation requested.");
  }

  // Every proposed segment id must genuinely belong to THIS quote's own
  // itinerary — never trust the client-supplied id list to be scoped
  // correctly on its own (an IDOR-shaped input: a segment id from a
  // completely different quote/customer must never be accepted here).
  const validSegmentIds = new Set((quote.itinerary?.segments ?? []).map((s) => s.id));
  const requestedSegmentIds = [...new Set(parsed.segmentIds)];
  const invalid = requestedSegmentIds.filter((id) => !validSegmentIds.has(id));
  if (invalid.length > 0) {
    throw new Error("One or more selected flight segments do not belong to this quote.");
  }

  await prisma.$transaction([
    prisma.quoteCancellationRequest.create({
      data: {
        quoteId: quote.id,
        segmentIds: requestedSegmentIds,
        cancellationFee: parsed.cancellationFee,
        pnr: parsed.pnr,
        internalNotes: parsed.internalNotes,
        createdById: actor.id,
      },
    }),
    // Direct write, not transitionQuoteStatus() — same reasoning as
    // Exchange's EXCHANGED write (see exchange.ts): this is a branch
    // status, not part of the linear DRAFT..CHARGED progression, and this
    // action's own CHARGED-only precondition above is the real guard.
    prisma.quote.update({ where: { id: quote.id }, data: { status: "PENDING_CANCELLATION_APPROVAL", lastActivityAt: new Date() } }),
    prisma.quoteStatusHistory.create({
      data: { quoteId: quote.id, fromStatus: "CHARGED", toStatus: "PENDING_CANCELLATION_APPROVAL", changedById: actor.id, note: `Cancellation requested for ${requestedSegmentIds.length} segment(s)` },
    }),
  ]);

  await logActivity({
    quoteId: quote.id,
    leadId: quote.leadId,
    contactId: quote.contactId,
    actorId: actor.id,
    type: "QUOTE_STATUS_CHANGED",
    description: `Cancellation requested for ${requestedSegmentIds.length} segment(s) of quote ${quote.quoteNumber}`,
  });

  const reviewers = await prisma.account.findMany({
    where: { companyId: actor.companyId, status: "ACTIVE", role: { in: ["ADMIN", "MANAGER"] } },
    select: { id: true },
  });
  if (reviewers.length > 0) {
    await prisma.notification.createMany({
      data: reviewers.map((r) => ({
        accountId: r.id,
        quoteId: quote.id,
        leadId: quote.leadId,
        type: "CANCELLATION_PENDING_APPROVAL",
        title: "Cancellation Pending Approval",
        body: `${actor.fullName} requested a cancellation on quote ${quote.quoteNumber} — awaiting review.`,
      })),
    });
  }

  revalidatePath(`/quotes/${quote.id}`);
  revalidatePath("/quotes");
}

async function getPendingCancellationRequest(cancellationRequestId: string, actor: NonNullable<Awaited<ReturnType<typeof getCurrentAccount>>>) {
  const request = await prisma.quoteCancellationRequest.findUnique({
    where: { id: cancellationRequestId },
    include: {
      quote: {
        include: {
          contact: { include: { emails: { orderBy: { isPrimary: "desc" } } } },
          agent: true,
          itinerary: { include: { segments: { select: SEGMENT_SELECT, orderBy: { sequence: "asc" } } } },
        },
      },
    },
  });
  if (!request) throw new Error("Cancellation request not found");
  // quoteVisibilityWhere isn't directly usable against a
  // QuoteCancellationRequest row, so the same company/ownership scoping is
  // re-checked by hand here against the request's own parent quote.
  const visible = await prisma.quote.findFirst({ where: { id: request.quoteId, ...quoteVisibilityWhere(actor) }, select: { id: true } });
  if (!visible) throw new Error("Cancellation request not found");
  if (request.status !== "PENDING") throw new Error("This cancellation request has already been reviewed.");
  return request;
}

/**
 * Admin/Manager only — approves a pending cancellation. This is a
 * DELIBERATELY SEPARATE, earlier step from actually notifying the customer
 * (see sendCancellationForm below) — approving does NOT mean the flight
 * has already been cancelled, and no customer email is sent here. Mirrors
 * Exchange's own approveExchange (approval-only, EXCHANGE_APPROVED, no
 * customer email) exactly, for the same reason: an Admin/Manager reviewing
 * a request and a human deciding it's time to actually notify the
 * customer are two distinct decisions.
 */
export async function confirmCancellation(cancellationRequestId: string) {
  const actor = await getCurrentAccount();
  if (!actor || !canApproveExchangeOrCancellation(actor.role)) {
    throw new Error("Only an Admin or Manager can approve a cancellation.");
  }
  const request = await getPendingCancellationRequest(cancellationRequestId, actor);
  const quote = request.quote;

  await prisma.$transaction([
    prisma.quoteCancellationRequest.update({
      where: { id: cancellationRequestId },
      data: { status: "CONFIRMED", reviewedById: actor.id, reviewedAt: new Date() },
    }),
    prisma.quote.update({ where: { id: quote.id }, data: { status: "CANCELLATION_APPROVED", lastActivityAt: new Date() } }),
    prisma.quoteStatusHistory.create({
      data: { quoteId: quote.id, fromStatus: "PENDING_CANCELLATION_APPROVAL", toStatus: "CANCELLATION_APPROVED", changedById: actor.id },
    }),
  ]);

  await logActivity({
    quoteId: quote.id,
    leadId: quote.leadId,
    contactId: quote.contactId,
    actorId: actor.id,
    type: "QUOTE_STATUS_CHANGED",
    description: `Cancellation approved by ${actor.fullName} for quote ${quote.quoteNumber} — customer not yet notified`,
  });

  revalidatePath(`/quotes/${quote.id}`);
  revalidatePath("/quotes");
}

/** `allowResend: true` also accepts a quote already at CANCELLATION_FORM_SENT
 * (Pass 13 §31's Resend action) — `false` (the original, still-used-by-
 * sendCancellationForm behavior) requires exactly CANCELLATION_APPROVED,
 * i.e. "approved, not yet sent". */
async function getApprovedCancellationRequest(cancellationRequestId: string, actor: NonNullable<Awaited<ReturnType<typeof getCurrentAccount>>>, allowResend = false) {
  const request = await prisma.quoteCancellationRequest.findUnique({
    where: { id: cancellationRequestId },
    include: {
      quote: {
        include: {
          contact: { include: { emails: { orderBy: { isPrimary: "desc" } } } },
          agent: true,
          itinerary: { include: { segments: { select: SEGMENT_SELECT, orderBy: { sequence: "asc" } } } },
        },
      },
    },
  });
  if (!request) throw new Error("Cancellation request not found");
  const visible = await prisma.quote.findFirst({ where: { id: request.quoteId, ...quoteVisibilityWhere(actor) }, select: { id: true } });
  if (!visible) throw new Error("Cancellation request not found");
  // A resend requires the form to have ALREADY been sent at least once
  // (CANCELLATION_FORM_SENT) — it is never a substitute for the first send
  // (still CANCELLATION_APPROVED, handled by the non-resend branch only).
  const statusOk = allowResend
    ? request.quote.status === "CANCELLATION_FORM_SENT"
    : request.quote.status === "CANCELLATION_APPROVED";
  if (request.status !== "CONFIRMED" || !statusOk) {
    throw new Error(
      allowResend
        ? "This cancellation form can only be resent once it has already been sent at least once (and the customer hasn't confirmed yet)."
        : "This cancellation must be approved (and not already sent) before the form can be sent."
    );
  }
  return request;
}

/**
 * Pass 13 §31 — the shared core of both sendCancellationForm (first send)
 * and resendCancellationForm (below): builds and sends the exact same
 * customer-facing "scheduled, please confirm" email, against the exact
 * same segment selection, passenger/contact data, and secure View Deal
 * link the original send used — a resend is never a fresh cancellation
 * request, just the same one delivered again (e.g. the customer says they
 * never got the email). Does NOT create any new record and does NOT touch
 * Quote.status — callers decide separately whether a status transition is
 * appropriate (only the first send transitions APPROVED -> FORM_SENT).
 */
async function buildAndSendCancellationFormEmail(request: Awaited<ReturnType<typeof getApprovedCancellationRequest>>) {
  const quote = request.quote;
  if (!quote.agent || !quote.contact) {
    throw new Error("This quote has no agent or contact on file — cannot send the cancellation form.");
  }
  const knownEmails = quote.contact.emails.length > 0 ? quote.contact.emails.map((e) => e.email) : quote.contact.primaryEmail ? [quote.contact.primaryEmail] : [];
  if (knownEmails.length === 0) {
    throw new Error("This customer has no email address on file — cannot send the cancellation form.");
  }

  const company = await getCompanyForAccountId(quote.agent.id);
  const segments = toEmailSegments(quote.itinerary?.segments ?? []);
  const cancelledSet = new Set(request.segmentIds);
  const baseUrl = resolveBaseUrl();
  // The customer's link is the quote's existing, stable secureToken — this
  // app's security model never rotates it per-send (see Quote.secureToken's
  // own schema doc comment), so "a fresh link" for a resend is naturally
  // already the same permanently-valid, per-quote link the customer's
  // original email carried — nothing to regenerate.
  const viewDealUrl = `${baseUrl}/quote/${quote.secureToken}`;
  const currency = isSupportedCurrency(quote.currency) ? quote.currency : "USD";

  const { subject, html } = buildCancellationScheduledEmail({
    customerFirstName: quote.contact.firstName,
    agentFullName: quote.agent.fullName,
    agent: { fullName: quote.agent.fullName, email: quote.agent.email, phone: quote.agent.phone },
    segments,
    cancelledSegmentIds: cancelledSet,
    cancellationFee: request.cancellationFee != null ? Number(request.cancellationFee) : null,
    currency,
    viewDealUrl,
    company,
  });

  const result = await sendEmail({ accountId: quote.agent.id, to: knownEmails[0], subject, html, senderName: quote.agent.fullName, replyTo: quote.agent.email });

  await prisma.emailLog.create({
    data: {
      type: "BOOKING_NOTIFICATION",
      subject,
      fromEmail: quote.agent.email,
      toEmail: knownEmails[0],
      status: result.ok ? "SENT" : "FAILED",
      errorMessage: result.ok ? undefined : result.error,
      leadId: quote.leadId,
      quoteId: quote.id,
      contactId: quote.contactId,
    },
  });

  if (!result.ok) {
    throw new Error(result.error || "Could not send the cancellation form — please try again.");
  }
  return { quote };
}

/**
 * Pass 13 §30 — who may actually send/resend the customer-facing
 * cancellation form: an Admin/Manager (the existing approval-tier
 * authority), OR the quote's own responsible agent (its `sentByAgent` —
 * whoever actually sent this quote/itinerary to the customer, falling
 * back to the quote's current `agent` only for older quotes that predate
 * sentByAgent — the same fallback convention used throughout this
 * codebase, e.g. booking-notification.ts). Deliberately does NOT extend
 * this to "anyone who can see the quote" — only the two roles the
 * business process actually recognizes as authorized: the approver tier,
 * and the one specific agent who owns this customer relationship.
 * Approval itself (confirmCancellation/disregardCancellation) stays
 * Admin/Manager-only — this is a narrower grant for the send/resend step
 * only, per this section's explicit "separate Approve Cancellation from
 * Send Cancellation Form" instruction.
 */
function canSendCancellationForm(actor: { id: string; role: AccountRole }, quote: { sentByAgentId: string | null; agentId: string | null }): boolean {
  if (canApproveExchangeOrCancellation(actor.role)) return true;
  const responsibleAgentId = quote.sentByAgentId ?? quote.agentId;
  return responsibleAgentId != null && responsibleAgentId === actor.id;
}

/**
 * Part 8/Pass 13 §30 — the explicit, separate "Send Cancellation Form"
 * action. Only reachable once confirmCancellation has approved the
 * request (CANCELLATION_APPROVED) and never fires automatically. Sends
 * the customer-facing "scheduled, please confirm" email (never claims the
 * segment(s) are already cancelled — buildCancellationScheduledEmail),
 * linking to the customer's own View Deal page, and moves the quote to
 * CANCELLATION_FORM_SENT. Authorized for Admin/Manager OR the quote's own
 * responsible agent (see canSendCancellationForm above) — previously
 * Admin/Manager-only, which left the agent who actually owns the customer
 * relationship unable to send the form they were waiting on an approval
 * for.
 */
export async function sendCancellationForm(cancellationRequestId: string) {
  const actor = await getCurrentAccount();
  if (!actor) {
    throw new Error("Only an Admin, Manager, or the quote's responsible agent can send the cancellation form.");
  }
  const request = await getApprovedCancellationRequest(cancellationRequestId, actor, false);
  if (!canSendCancellationForm(actor, request.quote)) {
    throw new Error("Only an Admin, Manager, or the quote's responsible agent can send the cancellation form.");
  }
  const quote = request.quote;

  // Pass 22 fix — CONFIRMED customer-facing duplicate-send bug: this used
  // to send the email FIRST and only transition CANCELLATION_APPROVED ->
  // CANCELLATION_FORM_SENT afterward. Two near-simultaneous calls for the
  // same request (a double-click, or two staff members both clicking
  // Send) could both pass getApprovedCancellationRequest's read-only
  // status check before either write landed, so both would send the
  // customer their "cancellation scheduled" email. The atomic claim below
  // — the same conditional-update-before-side-effect pattern already used
  // by processDueTaskNotifications/processDueSequenceSteps — makes the
  // status transition itself the single-use gate: only the FIRST caller's
  // `updateMany` can still match `status: "CANCELLATION_APPROVED"`, so
  // only it proceeds to actually send. A concurrent loser sees count===0
  // and fails cleanly with a clear message instead of duplicating the
  // send. This does mean a send that fails AFTER a successful claim
  // leaves the quote at CANCELLATION_FORM_SENT rather than back at
  // CANCELLATION_APPROVED — recoverable via the existing "Resend
  // Cancellation Form" action, which has no such precondition.
  const claim = await prisma.quote.updateMany({
    where: { id: quote.id, status: "CANCELLATION_APPROVED" },
    data: { status: "CANCELLATION_FORM_SENT", lastActivityAt: new Date() },
  });
  if (claim.count === 0) {
    throw new Error("This cancellation form has already been sent.");
  }

  // The claim above already committed the status transition — if the send
  // itself fails, buildAndSendCancellationFormEmail's own FAILED EmailLog
  // write plus this throw are enough; recovery from here is via "Resend
  // Cancellation Form" (no CANCELLATION_APPROVED precondition), not a
  // second call to this action (which would now correctly reject with
  // "already sent").
  await buildAndSendCancellationFormEmail(request);

  await prisma.quoteStatusHistory.create({
    data: { quoteId: quote.id, fromStatus: "CANCELLATION_APPROVED", toStatus: "CANCELLATION_FORM_SENT", changedById: actor.id },
  });

  await logActivity({
    quoteId: quote.id,
    leadId: quote.leadId,
    contactId: quote.contactId,
    actorId: actor.id,
    type: "QUOTE_STATUS_CHANGED",
    description: `Cancellation form sent by ${actor.fullName} for quote ${quote.quoteNumber} — awaiting customer confirmation`,
  });

  revalidatePath(`/quotes/${quote.id}`);
  revalidatePath("/quotes");
  return { emailSent: true };
}

/**
 * Pass 13 §31 — "Resend Cancellation Form": available once the form has
 * already been sent at least once (CANCELLATION_FORM_SENT) and the
 * customer hasn't yet confirmed (still CANCELLATION_FORM_SENT, not
 * CANCELLATION_SUBMITTED/CONFIRMED — those move past the point a resend
 * makes sense). Same authorization as the first send (Admin/Manager or
 * the quote's responsible agent), same underlying email/segments/
 * passenger/customer data, same stable secureToken link. Deliberately
 * does NOT transition Quote.status again (it's already at
 * CANCELLATION_FORM_SENT and stays there) and does NOT create a second
 * Booking or mark anything as completed — purely "send that same email
 * again."
 */
export async function resendCancellationForm(cancellationRequestId: string) {
  const actor = await getCurrentAccount();
  if (!actor) {
    throw new Error("Only an Admin, Manager, or the quote's responsible agent can resend the cancellation form.");
  }
  const request = await getApprovedCancellationRequest(cancellationRequestId, actor, true);
  if (!canSendCancellationForm(actor, request.quote)) {
    throw new Error("Only an Admin, Manager, or the quote's responsible agent can resend the cancellation form.");
  }

  const { quote } = await buildAndSendCancellationFormEmail(request);

  await logActivity({
    quoteId: quote.id,
    leadId: quote.leadId,
    contactId: quote.contactId,
    actorId: actor.id,
    type: "QUOTE_STATUS_CHANGED",
    description: `Cancellation form resent by ${actor.fullName} for quote ${quote.quoteNumber} — awaiting customer confirmation`,
  });

  revalidatePath(`/quotes/${quote.id}`);
  revalidatePath("/quotes");
  return { emailSent: true };
}

/**
 * Public, unauthenticated (matches trackViewDealClicked's own pattern in
 * booking.ts) — the customer's "Confirm Cancellation" click on their View
 * Deal page (item 12/13). Requires the quote to actually be at
 * CANCELLATION_FORM_SENT; idempotent (a second click, or a stale/reloaded
 * page, silently no-ops rather than erroring) once already
 * CANCELLATION_SUBMITTED or further along. Does NOT create a second
 * Booking (Booking.quoteId is @unique and this quote's Booking already
 * exists from the original charge) and does NOT mark the flight as
 * actually cancelled — that only happens once a Ticketing-area action
 * confirms it (sendCancellationConfirmationEmail, bookings.ts).
 */
const cancellationPassengerUpdateSchema = z.object({
  id: z.string(),
  firstName: z.string().min(1),
  middleName: z.string().optional(),
  lastName: z.string().min(1),
  dateOfBirth: z.string().optional(), // "YYYY-MM-DD" from the DatePicker, or empty
  gender: z.string().optional(),
  tsaKnownTravelerNumber: z.string().optional(),
  globalEntryNumber: z.string().optional(),
});

export async function confirmCancellationByCustomer(token: string, passengers?: z.infer<typeof cancellationPassengerUpdateSchema>[]) {
  // Pass 25 §28 — same public-endpoint rate limiting as submitBooking,
  // checked first. Fails open (never blocks) when no trustworthy client
  // IP is available — see rate-limit.ts's own doc comment.
  const rateLimitCheck = await checkPublicRateLimitFromRequest("CANCELLATION_SUBMIT", RATE_LIMITS.CANCELLATION_SUBMIT);
  if (!rateLimitCheck.allowed) {
    throw new Error("Too many attempts from this connection. Please wait a few minutes and try again.");
  }

  const quote = await prisma.quote.findUnique({
    where: { secureToken: token },
    select: {
      id: true,
      status: true,
      leadId: true,
      contactId: true,
      quoteNumber: true,
      booking: { select: { id: true } },
      contact: { select: { firstName: true, lastName: true, primaryEmail: true, companyId: true } },
    },
  });
  if (!quote) throw new Error("This link is no longer valid.");

  if (quote.status === "CANCELLATION_SUBMITTED" || quote.status === "CANCELLATION_CONFIRMED") {
    return { alreadyConfirmed: true };
  }
  if (quote.status !== "CANCELLATION_FORM_SENT") {
    throw new Error("This cancellation isn't ready to be confirmed yet.");
  }

  // Pass 13 §33/§34/§37 — the customer may have edited their prefilled
  // passenger information on the signing page; persist exactly what they
  // actually submitted (never the stale prefilled values) to the existing
  // Passenger rows on THIS quote's own Booking. Every submitted id is
  // re-validated against `quote.booking.id` here — never trusted blindly —
  // so a request naming another booking's passenger id is rejected rather
  // than silently overwriting a different customer's record (the same
  // "never cross-customer" guarantee getLastChargedBookingForContact's own
  // query already provides at read time, enforced again here at write
  // time).
  const parsedPassengers = passengers ? passengers.map((p) => cancellationPassengerUpdateSchema.parse(p)) : [];
  if (parsedPassengers.length > 0) {
    if (!quote.booking) throw new Error("This cancellation isn't ready to be confirmed yet.");
    const ownedPassengerIds = new Set(
      (await prisma.passenger.findMany({ where: { bookingId: quote.booking.id }, select: { id: true } })).map((p) => p.id)
    );
    for (const p of parsedPassengers) {
      if (!ownedPassengerIds.has(p.id)) {
        throw new Error("This cancellation isn't ready to be confirmed yet.");
      }
    }
  }

  await prisma.$transaction([
    prisma.quote.update({ where: { id: quote.id }, data: { status: "CANCELLATION_SUBMITTED", lastActivityAt: new Date() } }),
    prisma.quoteStatusHistory.create({
      data: { quoteId: quote.id, fromStatus: "CANCELLATION_FORM_SENT", toStatus: "CANCELLATION_SUBMITTED", note: "Customer confirmed the cancellation" },
    }),
    ...parsedPassengers.map((p) =>
      prisma.passenger.update({
        where: { id: p.id },
        data: {
          firstName: p.firstName,
          middleName: p.middleName || null,
          lastName: p.lastName,
          dateOfBirth: p.dateOfBirth ? new Date(`${p.dateOfBirth}T00:00:00.000Z`) : null,
          gender: p.gender || null,
          tsaKnownTravelerNumber: p.tsaKnownTravelerNumber || null,
          globalEntryNumber: p.globalEntryNumber || null,
        },
      })
    ),
  ]);

  await logActivity({
    quoteId: quote.id,
    leadId: quote.leadId,
    contactId: quote.contactId,
    type: "QUOTE_STATUS_CHANGED",
    description: `Customer confirmed the cancellation for quote ${quote.quoteNumber}`,
  });

  // IP capture (Pass 21+ fix) — this customer-facing "signing" step
  // (clicking Confirm Cancellation) previously captured no IP/User-Agent
  // at all, unlike the original booking signature. A CANCELLATION_FORM_SENT
  // quote always already has a Booking (it was CHARGED before a
  // cancellation could even be requested — see sendCancellationForApproval
  // above), so quote.booking is always present here. Best-effort: never
  // blocks the customer's cancellation confirmation from succeeding.
  if (quote.booking) {
    let ip: string | undefined;
    let userAgent: string | undefined;
    try {
      const headerList = await headers();
      ip = getClientIp(headerList);
      userAgent = headerList.get("user-agent") ?? undefined;
    } catch {
      // headers() can throw outside a request context — must never block confirmation.
    }
    await recordIpCapture({
      ip,
      userAgent,
      formType: "CANCELLATION_CONFIRMATION",
      bookingId: quote.booking.id,
      signerName: quote.contact ? `${quote.contact.firstName} ${quote.contact.lastName}`.trim() : null,
      signerEmail: quote.contact?.primaryEmail ?? null,
      companyId: quote.contact?.companyId,
      quoteId: quote.id,
    });
  }

  // Let every Admin/Manager know the customer has confirmed — mirrors
  // sendCancellationForApproval's own notify-reviewers pattern, since this
  // is the signal that a Ticketing-area action (Send Flight Cancellation
  // Confirmation) is now the next step.
  const company = await getCompanyForContactId(quote.contactId);
  const reviewers = await prisma.account.findMany({
    where: { companyId: company.id, status: "ACTIVE", role: { in: ["ADMIN", "MANAGER"] } },
    select: { id: true },
  });
  if (reviewers.length > 0) {
    await prisma.notification.createMany({
      data: reviewers.map((r) => ({
        accountId: r.id,
        quoteId: quote.id,
        leadId: quote.leadId,
        type: "CANCELLATION_SUBMITTED",
        title: "Cancellation Confirmed by Customer",
        body: `The customer confirmed the cancellation for quote ${quote.quoteNumber} — ready for final processing.`,
      })),
    });
  }

  revalidatePath(`/quotes/${quote.id}`);
  return { alreadyConfirmed: false };
}

/**
 * Admin/Manager only — disregards a pending cancellation. The request is
 * preserved (never deleted) at DISREGARDED for audit/history; the quote
 * returns to CHARGED. No customer email is ever sent for a disregarded
 * cancellation. Reachable from either PENDING_CANCELLATION_APPROVAL (never
 * reviewed) or CANCELLATION_APPROVED (approved, but the form hasn't been
 * sent yet and an Admin/Manager has changed their mind) — never once the
 * form has actually been sent, at which point the customer is already
 * aware and disregarding silently would be confusing/incorrect.
 */
export async function disregardCancellation(cancellationRequestId: string) {
  const actor = await getCurrentAccount();
  if (!actor || !canApproveExchangeOrCancellation(actor.role)) {
    throw new Error("Only an Admin or Manager can disregard a cancellation.");
  }
  const request = await prisma.quoteCancellationRequest.findUnique({
    where: { id: cancellationRequestId },
    include: { quote: { select: { id: true, status: true, leadId: true, contactId: true, quoteNumber: true } } },
  });
  if (!request) throw new Error("Cancellation request not found");
  const visible = await prisma.quote.findFirst({ where: { id: request.quoteId, ...quoteVisibilityWhere(actor) }, select: { id: true } });
  if (!visible) throw new Error("Cancellation request not found");
  // Two valid entry points, matching the quote's own two pre-form-sent
  // stages: still PENDING (never reviewed) or already CONFIRMED/approved
  // but the form hasn't been sent yet (an Admin/Manager changing their
  // mind before the customer was ever notified). Anything else — already
  // DISREGARDED, or the form has already gone out — is rejected.
  const requestDisregardable = request.status === "PENDING" || request.status === "CONFIRMED";
  const quoteDisregardable = request.quote.status === "PENDING_CANCELLATION_APPROVAL" || request.quote.status === "CANCELLATION_APPROVED";
  if (!requestDisregardable || !quoteDisregardable) {
    throw new Error(
      request.status === "DISREGARDED"
        ? "This cancellation request has already been reviewed."
        : "This cancellation can no longer be disregarded — the form has already been sent to the customer."
    );
  }
  const quote = request.quote;
  const fromStatus = quote.status;

  await prisma.$transaction([
    prisma.quoteCancellationRequest.update({
      where: { id: cancellationRequestId },
      data: { status: "DISREGARDED", reviewedById: actor.id, reviewedAt: new Date() },
    }),
    prisma.quote.update({ where: { id: quote.id }, data: { status: "CHARGED", lastActivityAt: new Date() } }),
    prisma.quoteStatusHistory.create({
      data: { quoteId: quote.id, fromStatus, toStatus: "CHARGED", changedById: actor.id, note: "Cancellation request disregarded" },
    }),
  ]);

  await logActivity({
    quoteId: quote.id,
    leadId: quote.leadId,
    contactId: quote.contactId,
    actorId: actor.id,
    type: "QUOTE_STATUS_CHANGED",
    description: `Cancellation disregarded by ${actor.fullName} for quote ${quote.quoteNumber} — quote remains Charged`,
  });

  revalidatePath(`/quotes/${quote.id}`);
  revalidatePath("/quotes");
}
