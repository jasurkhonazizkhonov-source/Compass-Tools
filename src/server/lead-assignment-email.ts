// The "New Flight Request" email — sent to the agent who just ACCEPTED a
// website-captured lead from the queue, containing everything the website
// form captured so they can reply to or call the customer immediately.
//
// Called from exactly one place: acceptLeadOffer (src/server/actions/
// lead-queue.ts), AFTER its atomic conditional claim
// (`WHERE assignedAgentId IS NULL AND offeredToId = <me> AND offerExpiresAt >
// now()`) has succeeded. That claim is the authoritative exactly-once guard:
// a double-click, refresh, retry or second tab all lose it (count === 0) and
// return before reaching this file, so a lead can only ever be "accepted"
// once and this email can only ever be requested once per acceptance. The
// findFirst below is a second, cheap guard for any future caller.
//
// Reliability contract (same as sendBookingSignedNotification): the lead is
// already assigned by the time this runs, so this NEVER throws and a failure
// never undoes or blocks the assignment. Every outcome is recorded in
// EmailLog (SENT or FAILED) and returned, never swallowed silently.
//
// Recipient: the accepting agent, resolved from the lead's own persisted
// assignment (lead.assignedAgentId must equal the recipient id passed in) —
// never "the first admin" or an alphabetical pick.
//
// Sender: every outbound email in this app is sent through a connected Gmail
// account (there is no shared mailbox). The accepting agent's own connection
// is tried first (the email lands in their own inbox as a normal message);
// only if they have no usable connection do the company's active Admins/
// Managers act as sending infrastructure — the same fallback convention
// sendBookingSignedNotification uses. The `to:` is always the accepting agent.
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/server/email/service";
import { buildNewFlightRequestEmail } from "@/server/email/templates";
import { getCompanyById } from "@/server/queries/company";
import { getGmailConnectionState } from "@/server/queries/gmail-connection";
import { formatPhoneInternational, phoneCountryName } from "@/lib/phone";

export type NewFlightRequestOutcome = { ok: boolean; alreadySent?: boolean; error?: string };

const AIRPORT_SELECT = { iata: true, name: true, city: true, country: true } as const;

export async function sendNewFlightRequestEmail(params: { leadId: string; recipientId: string; acceptedAt: Date }): Promise<NewFlightRequestOutcome> {
  try {
    const alreadySent = await prisma.emailLog.findFirst({
      where: { leadId: params.leadId, type: "NEW_LEAD_ASSIGNMENT", status: "SENT" },
      select: { id: true },
    });
    if (alreadySent) return { ok: true, alreadySent: true };

    const [lead, recipient] = await Promise.all([
      prisma.lead.findUnique({
        where: { id: params.leadId },
        select: {
          assignedAgentId: true,
          source: true,
          createdAt: true,
          contactId: true,
          tripType: true,
          cabinClass: true,
          adults: true,
          children: true,
          infants: true,
          departureDate: true,
          returnDate: true,
          flexibleDates: true,
          preferredAirline: true,
          budget: true,
          notes: true,
          contact: { select: { firstName: true, middleName: true, lastName: true, primaryEmail: true, primaryPhone: true } },
          departureAirport: { select: AIRPORT_SELECT },
          arrivalAirport: { select: AIRPORT_SELECT },
          segments: { orderBy: { sequence: "asc" }, select: { departureDate: true, departureAirport: { select: AIRPORT_SELECT }, arrivalAirport: { select: AIRPORT_SELECT } } },
        },
      }),
      prisma.account.findFirst({ where: { id: params.recipientId, status: "ACTIVE" }, select: { id: true, email: true, fullName: true, companyId: true } }),
    ]);

    if (!lead || !recipient) return { ok: false, error: "Lead or recipient not found." };
    // The email goes to whoever the lead is ACTUALLY assigned to — never to
    // an account merely named by the caller.
    if (lead.assignedAgentId !== recipient.id) return { ok: false, error: "This lead is not assigned to that agent." };
    if (lead.source !== "WEBSITE") return { ok: false, error: "Only website-captured leads send a New Flight Request email." };

    const company = await getCompanyById(recipient.companyId);
    const customerFullName = [lead.contact.firstName, lead.contact.middleName, lead.contact.lastName].filter(Boolean).join(" ");
    const { subject, html } = buildNewFlightRequestEmail({
      company,
      customerFullName,
      customerEmail: lead.contact.primaryEmail,
      customerPhone: lead.contact.primaryPhone,
      customerPhoneDisplay: lead.contact.primaryPhone ? formatPhoneInternational(lead.contact.primaryPhone) : null,
      customerCountry: lead.contact.primaryPhone ? phoneCountryName(lead.contact.primaryPhone) : null,
      tripType: lead.tripType,
      cabinClass: lead.cabinClass,
      adults: lead.adults,
      children: lead.children,
      infants: lead.infants,
      departureAirport: lead.departureAirport,
      arrivalAirport: lead.arrivalAirport,
      departureDate: lead.departureDate,
      returnDate: lead.returnDate,
      segments: lead.segments,
      flexibleDates: lead.flexibleDates,
      preferredAirline: lead.preferredAirline,
      budget: lead.budget != null ? Number(lead.budget) : null,
      notes: lead.notes,
      submittedAt: lead.createdAt,
      acceptedAt: params.acceptedAt,
      acceptedByName: recipient.fullName,
    });

    // The accepting agent first; the fallback list is only queried if that
    // send doesn't go through.
    // Held in one object (not two reassigned lets) so TypeScript tracks the
    // values the async helper below writes.
    const state: { senderEmail?: string; result: Awaited<ReturnType<typeof sendEmail>> } = {
      result: { ok: false, error: "No connected Gmail account was available to send this notification." },
    };
    const attempt = async (candidate: { id: string; email: string; fullName: string }) => {
      if ((await getGmailConnectionState(candidate.id)) !== "CONNECTED") return false;
      const r = await sendEmail({ accountId: candidate.id, to: recipient.email, subject, html, senderName: candidate.fullName });
      state.senderEmail = candidate.email;
      state.result = r;
      return r.ok;
    };

    let sent = await attempt(recipient);
    if (!sent) {
      const fallbacks = await prisma.account.findMany({
        where: { companyId: recipient.companyId, status: "ACTIVE", role: { in: ["ADMIN", "MANAGER"] }, id: { not: recipient.id } },
        orderBy: { fullName: "asc" },
        select: { id: true, email: true, fullName: true },
      });
      for (const candidate of fallbacks) {
        sent = await attempt(candidate);
        if (sent) break;
      }
    }

    const { result } = state;
    await prisma.emailLog.create({
      data: {
        type: "NEW_LEAD_ASSIGNMENT",
        subject,
        fromEmail: state.senderEmail ?? "unsent",
        toEmail: recipient.email,
        status: result.ok ? "SENT" : "FAILED",
        errorMessage: result.ok ? undefined : result.error,
        messageId: result.ok ? result.messageId : undefined,
        leadId: params.leadId,
        contactId: lead.contactId,
      },
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (err) {
    // Safe tag only — never the message (it could embed a recipient address).
    console.error(`[lead-assignment-email] NEW_FLIGHT_REQUEST_EMAIL_FAILED (${err instanceof Error ? err.constructor.name : typeof err})`);
    return { ok: false, error: "The New Flight Request email could not be sent." };
  }
}
