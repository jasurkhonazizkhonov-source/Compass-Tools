// The "Booking Form Signed" internal staff notification — extracted out of
// submitBooking() (src/server/actions/booking.ts) so it's independently
// testable without needing to simulate that function's entire card-
// validation/pricing pipeline, and so its reliability properties (never
// throws past the caller, never double-sends) are enforced in one place.
//
// Reliability contract: by the time this function is called, the Booking/
// Signature/Quote/Lead rows are ALREADY committed (see submitBooking()) —
// this function's job is best-effort notification only. It NEVER throws;
// any failure (Gmail API error, unexpected DB error) is caught, logged to
// EmailLog as FAILED, and swallowed, so a notification problem can never
// turn an already-successful booking into an error response for the
// customer.
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { sendEmail } from "@/server/email/service";
import { buildBookingSignedNotificationEmail, buildBookingProfitNotificationEmail, type EmailPaymentMethod, type EmailSegment } from "@/server/email/templates";
import { toEmailSegments } from "@/server/email/segment-mapper";
import { getCompanyForAccountId, getCompanyForContactId } from "@/server/queries/company";
import { getGmailConnectionState } from "@/server/queries/gmail-connection";
import { SEGMENT_SELECT } from "@/server/queries/segment-select";
import { isSupportedCurrency, type SupportedCurrency } from "@/lib/currency";
import { formatHireAgeCompact } from "@/lib/account-format";
import { ROLE_LABELS } from "@/lib/permissions";
import type { AccountRole } from "@/generated/prisma/client";

export type BookingNotificationParams = {
  bookingId: string;
  bookingReference: string;
  bookingCreatedAt: Date;
  bookingUrl: string;
  quoteId: string;
  leadId: string;
  contactId: string;
  agent: { id: string; email: string; fullName: string } | null;
  customerFirstName: string;
  customerMiddleName: string | null;
  customerLastName: string;
  ip: string | undefined;
  signedName: string;
  contactEmail: string;
  contactPhone: string;
  passengers: Array<{ firstName: string; middleName: string | null; lastName: string; dateOfBirth: Date | null; type: "ADULT" | "CHILD" | "INFANT" }>;
  paymentMethods: EmailPaymentMethod[];
  pricing: {
    adults: number;
    children: number;
    infants: number;
    adultPrice: number;
    childPrice: number;
    infantPrice: number;
    taxes: number;
    serviceFee: number;
    gratuity: number;
    total: number;
    currency: string;
  };
};

/**
 * Sends the internal "Booking Form Signed" notification — recipients are
 * the quote's own agent (if any) plus every active Admin/Manager, sent via
 * whichever of them has a connected Gmail account (there is no CRM session
 * to send "as" in this customer-facing flow).
 *
 * Idempotency (Pass 23 §32/§33 re-investigation): the "already sent?"
 * check below and the EmailLog write that records a send ARE still two
 * separate, unguarded steps in this function's own code — read in
 * isolation, that's the same check-then-act shape fixed elsewhere in this
 * app with an atomic conditional claim (see sendBookingProfitNotification
 * below, and processDueTaskNotifications/processDueSequenceSteps). What
 * makes it safe here anyway: this function has exactly ONE call site
 * (submitBooking, src/server/actions/booking.ts), invoked only AFTER a
 * Booking row has already been created for a given quote — and
 * `Booking.quoteId` is `@unique`, so a genuine race between two
 * simultaneous submitBooking requests for the same quote already resolves
 * to exactly one successful booking.create() (the loser fails at that
 * unique-constraint check and never reaches this notification call at
 * all — see booking-retry.test.ts's own concurrency test for that
 * guarantee). There is no code path today that calls this function twice
 * for the same bookingId, so the theoretical race this comment used to
 * warn about is not actually reachable — left as a plain check-then-act
 * deliberately, rather than adding an atomic claim mechanism this
 * function would never exercise. If a future caller ever invokes this
 * directly (bypassing submitBooking's own uniqueness guarantee), that
 * assumption would need re-verifying. Never throws — every failure path
 * (no Gmail connected, a thrown error from sendEmail or the EmailLog
 * write) is caught and recorded, never propagated to the caller.
 */
export async function sendBookingSignedNotification(params: BookingNotificationParams): Promise<void> {
  try {
    const alreadySent = await prisma.emailLog.findFirst({
      where: { bookingId: params.bookingId, type: "BOOKING_NOTIFICATION", status: "SENT" },
      select: { id: true },
    });
    if (alreadySent) return;

    const company = params.agent ? await getCompanyForAccountId(params.agent.id) : await getCompanyForContactId(params.contactId);
    const itinerary = await prisma.itinerary.findUnique({
      where: { quoteId: params.quoteId },
      include: { segments: { select: SEGMENT_SELECT, orderBy: { sequence: "asc" } } },
    });
    const segments = toEmailSegments(itinerary?.segments ?? []);
    const currency: SupportedCurrency = isSupportedCurrency(params.pricing.currency) ? params.pricing.currency : "USD";

    const admins = await prisma.account.findMany({
      where: { companyId: company.id, status: "ACTIVE", role: { in: ["ADMIN", "MANAGER"] } },
      orderBy: { fullName: "asc" },
      select: { id: true, email: true, fullName: true },
    });

    // The notification's actual audience (the `to:` field) must reach only
    // the CRM user who originally sent the flight option to the customer —
    // never a broadcast to every admin/manager. params.agent is the
    // caller's resolved sentByAgent (falling back to the quote's current
    // agent only if a quote predates that field), not the current lead/
    // quote owner, so a later reassignment can never redirect this
    // notification to someone who didn't send the quote. Admins are only a
    // last-resort recipient fallback for the rare case where no sender was
    // ever recorded at all (nobody to notify otherwise).
    const recipients = params.agent ? [params.agent] : admins;
    if (recipients.length === 0) return;

    // Separately: whichever Gmail account actually transmits this email —
    // a different concern from who it's addressed to. This is a
    // customer-triggered event with no CRM session attached, so SOME
    // connected Gmail account has to send it; falling back to an admin's
    // connection here (even when that admin isn't a recipient) is about
    // sending infrastructure, not about widening the notification's
    // audience — the `to:` field above is unaffected either way.
    const senderCandidates = [...(params.agent ? [params.agent] : []), ...admins].filter(
      (r, i, arr) => arr.findIndex((x) => x.id === r.id) === i
    );

    const customerFullName = params.customerMiddleName
      ? `${params.customerFirstName} ${params.customerMiddleName} ${params.customerLastName}`
      : `${params.customerFirstName} ${params.customerLastName}`;

    const { subject, html } = buildBookingSignedNotificationEmail({
      bookingReference: params.bookingReference,
      customerFullName,
      contactEmail: params.contactEmail,
      contactPhone: params.contactPhone,
      signedName: params.signedName,
      signedAt: params.bookingCreatedAt,
      ipAddress: params.ip ?? null,
      segments,
      passengers: params.passengers,
      pricing: { ...params.pricing, currency },
      paymentMethods: params.paymentMethods,
      paymentPaid: false,
      bookingUrl: params.bookingUrl,
      company,
    });

    const toEmail = recipients.map((r) => r.email).join(", ");

    // Try every candidate whose Gmail *looks* connected, in order, not just
    // the first one — a connection can be recorded as CONNECTED yet still
    // fail at actual send time (an expired/revoked OAuth token only
    // surfaces once Gmail itself rejects the call). Previously this picked
    // exactly one "CONNECTED" candidate and gave up entirely if that one
    // send failed, silently dropping the notification even when another
    // admin/manager's connection would have worked. Falls through to the
    // next candidate only on a failed attempt — the first successful send
    // wins immediately.
    let sender: { id: string; email: string; fullName: string } | undefined;
    let result: Awaited<ReturnType<typeof sendEmail>> = { ok: false, error: "No recipient has connected Gmail yet — notification not sent." };
    for (const candidate of senderCandidates) {
      if ((await getGmailConnectionState(candidate.id)) !== "CONNECTED") continue;
      const attempt = await sendEmail({ accountId: candidate.id, to: toEmail, subject, html, senderName: candidate.fullName });
      if (attempt.ok) {
        sender = candidate;
        result = attempt;
        break;
      }
      // Keep the most recent failure's message/sender for the EmailLog
      // record in case every candidate ultimately fails.
      sender = candidate;
      result = attempt;
    }

    await prisma.emailLog.create({
      data: {
        type: "BOOKING_NOTIFICATION",
        subject,
        fromEmail: sender?.email ?? "unsent",
        toEmail,
        status: result.ok ? "SENT" : "FAILED",
        errorMessage: result.ok ? undefined : result.error,
        leadId: params.leadId,
        quoteId: params.quoteId,
        bookingId: params.bookingId,
        contactId: params.contactId,
      },
    });
  } catch (err) {
    // Best-effort — the booking itself is already safely committed by the
    // time this function is ever called. A notification failure must never
    // turn a successful booking into an error response for the customer.
    console.error(`Failed to send booking-signed notification for booking ${params.bookingId}:`, err);
  }
}

export type BookingProfitNotificationParams = {
  bookingId: string;
  bookingReference: string;
  quoteId: string;
  leadId: string;
  contactId: string;
  companyId: string;
  agent: { id: string; email: string; fullName: string; location: string | null; hiredAt: Date | null; role: AccountRole } | null;
  profit: number;
  destination: string;
  currency: string;
  passengerCount: number;
  ticketBookingCost: number;
  sellingCost: number;
  segments: EmailSegment[];
  /** True when this booking's quote is an approved Exchange (Quote.originalQuoteId set) rather than a normal new sale. Superseded by `transactionLabel` when both are set. */
  isExchange?: boolean;
  /** Part 16 — explicit transaction classification threaded straight through to buildBookingProfitNotificationEmail. */
  transactionLabel?: "EXCHANGE" | "CANCELLATION";
};

/** Pass 13 §15/§16 — the outcome of a notification attempt, returned (not
 * swallowed) so a caller that the user is DIRECTLY waiting on — the manual
 * "Notify Team of New Sale"/"Notify Team of Cancellation" button
 * (sendNewSaleNotification/sendCancellationNotification in
 * server/actions/bookings.ts) — can surface a real failure instead of
 * reporting success merely because this function didn't throw.
 * `alreadySent: true` distinguishes "this is a no-op because it already
 * succeeded before" (not a failure — a retry/refresh must stay silent-safe)
 * from a genuine send failure. */
export type NotificationOutcome = { ok: boolean; alreadySent?: boolean; error?: string };

/**
 * Part 17 — sends the internal "booking confirmed / profit" notification.
 * Recipients are every active user in the company, regardless of role —
 * this is a company-wide internal sale announcement, not scoped to the
 * sales-visibility roles that can see Commissions/Salesboard (deliberately
 * broader than that), and NOT filtered by Account.accountsVisible — the
 * Pass 11 Accounts-directory visibility toggle is a display preference for
 * the general /accounts page, unrelated to who counts as an active CRM
 * user eligible for this internal announcement (Pass 13 §14). Sent via
 * whichever recipient has a working connected Gmail account (see the send
 * loop below).
 *
 * Reliability contract (Pass 13 §15): this function itself never THROWS —
 * a notification problem must never turn an already-committed booking into
 * a thrown error deep inside unrelated code — but it now truthfully
 * REPORTS success/failure via its return value rather than always
 * resolving silently. The customer-facing auto-trigger path
 * (sendBookingSignedNotification above) intentionally still discards this
 * signal (a notification failure must never surface to a customer mid-
 * checkout); the manual, ticketing-agent-triggered callers
 * (sendNewSaleNotification/sendCancellationNotification) DO check it and
 * throw, so the "Notify Team" button can no longer report success when the
 * email silently never went out (the core bug this pass fixes — every
 * failure was already logged to EmailLog before, just never surfaced).
 *
 * Pass 23 §32/§33 — genuinely idempotent now, not just documented as
 * racy: this is a one-time internal announcement with no legitimate
 * resend concept (unlike sendAirlineConfirmationEmail, where resending is
 * a real customer-facing workflow) — a double-click on "Notify Team of
 * New/Cancelled Sale" must always produce exactly one team email, never
 * two, and the existing `alreadySent` contract already documents repeat
 * calls as silent no-ops, not errors. Deliberately NOT a copy of
 * cancellation.ts's one-way-status claim (there is no Booking/Quote
 * status field this function could claim against) — instead, the claim
 * IS the EmailLog row itself: an optimistic SENT-status insert, guarded
 * by a partial unique index on (bookingId, type) WHERE status='SENT'
 * scoped to exactly these two notification types (migration
 * 20260904000200), so two genuinely concurrent calls can never both pass.
 * If this attempt then fails to actually send, the SAME claimed row is
 * downgraded to FAILED below — never left as a false "SENT" record — which
 * also correctly reopens the unique slot for a legitimate retry.
 */
export async function sendBookingProfitNotification(params: BookingProfitNotificationParams): Promise<NotificationOutcome> {
  const emailLogType = params.transactionLabel === "CANCELLATION" ? "BOOKING_CANCELLATION_NOTIFICATION" : "BOOKING_PROFIT_NOTIFICATION";

  let claimId: string;
  try {
    const claim = await prisma.emailLog.create({
      data: {
        type: emailLogType,
        subject: "(sending...)",
        fromEmail: "pending",
        toEmail: "",
        status: "SENT",
        leadId: params.leadId,
        quoteId: params.quoteId,
        bookingId: params.bookingId,
        contactId: params.contactId,
      },
    });
    claimId = claim.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Someone else's claim already won — including, correctly, an
      // earlier successful send by THIS same call site (the ordinary
      // "already sent" case the old check-then-act read used to cover).
      return { ok: true, alreadySent: true };
    }
    console.error(`Failed to claim booking-profit notification for booking ${params.bookingId}:`, err);
    return { ok: false, error: "Unexpected error sending the team notification." };
  }

  try {
    const company = params.agent ? await getCompanyForAccountId(params.agent.id) : await getCompanyForContactId(params.contactId);
    const currency: SupportedCurrency = isSupportedCurrency(params.currency) ? params.currency : "USD";

    // Every active CRM user in the company, regardless of role — this is
    // an internal-only company announcement (never reaches the customer;
    // there is no path from this query to Contact/customer email at all).
    const recipients = await prisma.account.findMany({
      where: { companyId: params.companyId, status: "ACTIVE" },
      orderBy: { fullName: "asc" },
      select: { id: true, email: true, fullName: true },
    });
    if (recipients.length === 0) {
      const error = "No active CRM users found to notify.";
      await prisma.emailLog.update({
        where: { id: claimId },
        data: { subject: "(not sent — no active recipients)", fromEmail: "unsent", status: "FAILED", errorMessage: error },
      });
      return { ok: false, error };
    }

    const { subject, html } = buildBookingProfitNotificationEmail({
      agentFullName: params.agent?.fullName ?? "An agent",
      agentRole: params.agent ? ROLE_LABELS[params.agent.role] : null,
      agentLocation: params.agent?.location ?? null,
      hireAgeCompact: params.agent ? formatHireAgeCompact(params.agent.hiredAt) : null,
      profit: params.profit,
      destination: params.destination,
      currency,
      bookingReference: params.bookingReference,
      passengerCount: params.passengerCount,
      ticketBookingCost: params.ticketBookingCost,
      sellingCost: params.sellingCost,
      segments: params.segments,
      company,
      isExchange: params.isExchange,
      transactionLabel: params.transactionLabel,
    });

    // Part 19 — recipient privacy. This is a company-wide broadcast (every
    // active user), so the real distribution list must never appear in a
    // header any recipient can see. `to` is the sending account's own
    // address (so the sender also receives a normal copy of what went out,
    // without exposing their identity to anyone else), and the actual
    // recipient list goes in `bcc` — sendEmail/sendViaGmail already support
    // this end to end, it just wasn't being used here. EmailLog.toEmail
    // below still records the full distribution list for internal audit
    // purposes only (never rendered in any email header, never shown to a
    // recipient).
    const toEmail = recipients.map((r) => r.email).join(", ");

    // Try every recipient whose Gmail *looks* connected, in order, not just
    // the first one — a connection can be recorded as CONNECTED yet still
    // fail at actual send time (an expired/revoked OAuth token only
    // surfaces once Gmail itself rejects the call). Previously this picked
    // exactly one "CONNECTED" candidate and gave up entirely if that one
    // send failed, silently dropping the notification even when another
    // admin/manager's connection would have worked. Falls through to the
    // next candidate only on a failed attempt — the first successful send
    // wins immediately.
    let sender: { id: string; email: string; fullName: string } | undefined;
    let result: Awaited<ReturnType<typeof sendEmail>> = { ok: false, error: "No recipient has connected Gmail yet — notification not sent." };
    for (const candidate of recipients) {
      if ((await getGmailConnectionState(candidate.id)) !== "CONNECTED") continue;
      const attempt = await sendEmail({ accountId: candidate.id, to: candidate.email, bcc: toEmail, subject, html, senderName: candidate.fullName });
      if (attempt.ok) {
        sender = candidate;
        result = attempt;
        break;
      }
      // Keep the most recent failure's message/sender for the EmailLog
      // record in case every candidate ultimately fails.
      sender = candidate;
      result = attempt;
    }

    await prisma.emailLog.update({
      where: { id: claimId },
      data: {
        subject,
        fromEmail: sender?.email ?? "unsent",
        toEmail,
        status: result.ok ? "SENT" : "FAILED",
        errorMessage: result.ok ? undefined : result.error,
        messageId: result.ok ? result.messageId : undefined,
      },
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? "Failed to send the team notification." };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error sending the team notification.";
    console.error(`Failed to send booking-profit notification for booking ${params.bookingId}:`, err);
    // Even an unexpected exception (not just an ordinary send failure) is
    // still recorded — §15's "must be logged, observable, not silently
    // disappear" applies here too, not only to the ordinary failure path
    // above. Downgrades the SAME claimed row (never leaves it as a false
    // "SENT") — best-effort: if EVEN this update fails, this function
    // still returns a failure result rather than propagating.
    try {
      await prisma.emailLog.update({
        where: { id: claimId },
        data: { subject: "(not sent — unexpected error)", fromEmail: "unsent", status: "FAILED", errorMessage: message },
      });
    } catch {
      // Downgrading the claim failed too — nothing further to do; the
      // caller still gets an honest { ok: false } either way.
    }
    return { ok: false, error: message };
  }
}
