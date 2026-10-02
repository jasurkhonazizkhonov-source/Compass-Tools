// Internal notification emails for an EXISTING lead or contact whose owner
// has just changed. This is a different event from a fresh website lead being
// accepted (that is the "New Flight Request" email, src/server/lead-
// assignment-email.ts) and the two never share a template or an EmailLog type.
//
// Who gets what (only when there is a real previous owner and the owner
// genuinely changed — the callers guarantee both, see below):
//   • previous owner — "Lead/Contact Reassigned": the item left their account
//   • new owner      — "Lead/Contact Reassigned to You": the full detail
// Each email is sent FROM that recipient's own connected Gmail TO that same
// address (src/server/email/own-gmail-send.ts). It is never sent from the
// admin/manager who performed the reassignment, and never rerouted through
// anyone else's mailbox.
//
// Exactly-once: these functions have no dedupe of their own on purpose — an
// item can legitimately move A → B → A. The guarantee comes from the callers
// (reassignLead / performContactReassignment), which only get here after an
// atomic compare-and-set on the owner (`UPDATE … WHERE owner = <the previous
// owner we read>`). A double-click, retry or concurrent duplicate loses that
// race, changes nothing and sends nothing. A same-owner "reassignment" never
// reaches this file at all.
//
// Reliability: the reassignment is already committed when this runs, so it
// NEVER throws and a failure never undoes it. Every attempt is recorded in
// EmailLog (SENT or FAILED).
import { prisma } from "@/lib/prisma";
import { buildContactReassignmentEmail, buildLeadReassignmentEmail } from "@/server/email/templates";
import { sendFromOwnGmail, type OwnGmailRecipient } from "@/server/email/own-gmail-send";
import { getCompanyById } from "@/server/queries/company";
import { formatPhoneInternational, phoneCountryName } from "@/lib/phone";
import { resolveBaseUrl } from "@/lib/company-config";
import { canViewAllRecords, canViewContacts, canViewLeads } from "@/lib/permissions";
import type { AccountRole } from "@/generated/prisma/client";

export type ReassignmentEmailOutcome = { previousOwner: "SENT" | "FAILED" | "SKIPPED"; newOwner: "SENT" | "FAILED" | "SKIPPED" };

const AIRPORT_SELECT = { iata: true, name: true, city: true, country: true } as const;
const ACCOUNT_SELECT = { id: true, email: true, fullName: true, role: true, companyId: true, status: true } as const;

type RecipientAccount = OwnGmailRecipient & { role: AccountRole; companyId: string; status: string };

/** Whether `account` may open the item after the move. The new owner always
 * can (provided their role has the page at all); the previous owner only if
 * their role sees every record company-wide. Anything else gets a plain
 * reference instead of a link that would end in an authorization error. */
function canOpen(kind: "lead" | "contact", account: RecipientAccount, isNewOwner: boolean): boolean {
  const roleHasPage = kind === "lead" ? canViewLeads(account.role) : canViewContacts(account.role);
  return roleHasPage && (isNewOwner || canViewAllRecords(account.role));
}

export async function sendLeadReassignmentEmails(params: {
  leadId: string;
  previousOwnerId: string | null;
  newOwnerId: string;
  actorId: string;
  reassignedAt: Date;
  reason: string | null;
}): Promise<ReassignmentEmailOutcome> {
  const outcome: ReassignmentEmailOutcome = { previousOwner: "SKIPPED", newOwner: "SKIPPED" };
  try {
    // No previous owner (an unassigned lead being claimed/assigned) or an
    // unchanged owner is not a "reassignment" — nothing to announce.
    if (!params.previousOwnerId || params.previousOwnerId === params.newOwnerId) return outcome;

    const [lead, accounts] = await Promise.all([
      prisma.lead.findUnique({
        where: { id: params.leadId },
        select: {
          contactId: true,
          status: true,
          source: true,
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
        },
      }),
      prisma.account.findMany({ where: { id: { in: [params.previousOwnerId, params.newOwnerId, params.actorId] } }, select: ACCOUNT_SELECT }),
    ]);
    const previousOwner = accounts.find((a) => a.id === params.previousOwnerId);
    const newOwner = accounts.find((a) => a.id === params.newOwnerId);
    const actor = accounts.find((a) => a.id === params.actorId);
    if (!lead || !newOwner) return outcome;

    const company = await getCompanyById(newOwner.companyId);
    const customerFullName = [lead.contact.firstName, lead.contact.middleName, lead.contact.lastName].filter(Boolean).join(" ");
    const phone = lead.contact.primaryPhone;
    const shared = {
      company,
      customerFullName,
      customerEmail: lead.contact.primaryEmail,
      customerPhone: phone,
      customerPhoneDisplay: phone ? formatPhoneInternational(phone) : null,
      customerCountry: phone ? phoneCountryName(phone) : null,
      tripType: lead.tripType,
      cabinClass: lead.cabinClass,
      adults: lead.adults,
      children: lead.children,
      infants: lead.infants,
      departureAirport: lead.departureAirport,
      arrivalAirport: lead.arrivalAirport,
      departureDate: lead.departureDate,
      returnDate: lead.returnDate,
      flexibleDates: lead.flexibleDates,
      preferredAirline: lead.preferredAirline,
      budget: lead.budget != null ? Number(lead.budget) : null,
      notes: lead.notes,
      status: lead.status,
      source: lead.source,
      newOwnerName: newOwner.fullName,
      previousOwnerName: previousOwner?.fullName ?? null,
      reassignedByName: actor?.fullName ?? "An administrator",
      reassignedAt: params.reassignedAt,
      reason: params.reason,
    } as const;
    const leadUrl = `${resolveBaseUrl()}/leads/${params.leadId}`;

    const deliver = async (recipient: RecipientAccount | undefined, direction: "AWAY" | "TO_YOU"): Promise<"SENT" | "FAILED" | "SKIPPED"> => {
      // A deactivated user (the usual reason a lead is being moved off them)
      // has no working mailbox access and should not be emailed.
      if (!recipient || recipient.status !== "ACTIVE") return "SKIPPED";
      const { subject, html } = buildLeadReassignmentEmail({
        ...shared,
        direction,
        recipientFullName: recipient.fullName,
        leadUrl: canOpen("lead", recipient, direction === "TO_YOU") ? leadUrl : null,
      });
      const { result, fromEmail } = await sendFromOwnGmail({ owner: recipient, subject, html });
      await prisma.emailLog.create({
        data: {
          type: "LEAD_REASSIGNMENT",
          subject,
          fromEmail,
          toEmail: recipient.email,
          status: result.ok ? "SENT" : "FAILED",
          errorMessage: result.ok ? undefined : result.error,
          messageId: result.ok ? result.messageId : undefined,
          leadId: params.leadId,
          contactId: lead.contactId,
        },
      });
      return result.ok ? "SENT" : "FAILED";
    };

    // Independent sends: one failing must not stop the other.
    const [prev, next] = await Promise.all([deliver(previousOwner, "AWAY"), deliver(newOwner, "TO_YOU")]);
    outcome.previousOwner = prev;
    outcome.newOwner = next;
    return outcome;
  } catch (err) {
    // Safe tag only — never the message (it could embed an address).
    console.error(`[reassignment-email] LEAD_REASSIGNMENT_EMAIL_FAILED (${err instanceof Error ? err.constructor.name : typeof err})`);
    return outcome;
  }
}

export async function sendContactReassignmentEmails(params: {
  contactId: string;
  previousOwnerId: string | null;
  newOwnerId: string;
  /** null for a system-triggered reassignment (no person performed it). */
  actorId: string | null;
  reassignedAt: Date;
  reason: string | null;
}): Promise<ReassignmentEmailOutcome> {
  const outcome: ReassignmentEmailOutcome = { previousOwner: "SKIPPED", newOwner: "SKIPPED" };
  try {
    if (!params.previousOwnerId || params.previousOwnerId === params.newOwnerId) return outcome;

    const ids = [params.previousOwnerId, params.newOwnerId, ...(params.actorId ? [params.actorId] : [])];
    const [contact, accounts] = await Promise.all([
      prisma.contact.findUnique({
        where: { id: params.contactId },
        select: {
          firstName: true,
          middleName: true,
          lastName: true,
          primaryEmail: true,
          primaryPhone: true,
          _count: { select: { leads: true } },
        },
      }),
      prisma.account.findMany({ where: { id: { in: ids } }, select: ACCOUNT_SELECT }),
    ]);
    const previousOwner = accounts.find((a) => a.id === params.previousOwnerId);
    const newOwner = accounts.find((a) => a.id === params.newOwnerId);
    const actor = params.actorId ? accounts.find((a) => a.id === params.actorId) : undefined;
    if (!contact || !newOwner) return outcome;

    const company = await getCompanyById(newOwner.companyId);
    const contactFullName = [contact.firstName, contact.middleName, contact.lastName].filter(Boolean).join(" ");
    const phone = contact.primaryPhone;
    const shared = {
      company,
      contactFullName,
      contactEmail: contact.primaryEmail,
      contactPhone: phone,
      contactPhoneDisplay: phone ? formatPhoneInternational(phone) : null,
      contactCountry: phone ? phoneCountryName(phone) : null,
      leadCount: contact._count.leads,
      newOwnerName: newOwner.fullName,
      previousOwnerName: previousOwner?.fullName ?? null,
      reassignedByName: actor?.fullName ?? "Automatic ownership match",
      reassignedAt: params.reassignedAt,
      reason: params.reason,
    } as const;
    const contactUrl = `${resolveBaseUrl()}/contacts/${params.contactId}`;

    const deliver = async (recipient: RecipientAccount | undefined, direction: "AWAY" | "TO_YOU"): Promise<"SENT" | "FAILED" | "SKIPPED"> => {
      if (!recipient || recipient.status !== "ACTIVE") return "SKIPPED";
      const { subject, html } = buildContactReassignmentEmail({
        ...shared,
        direction,
        recipientFullName: recipient.fullName,
        contactUrl: canOpen("contact", recipient, direction === "TO_YOU") ? contactUrl : null,
      });
      const { result, fromEmail } = await sendFromOwnGmail({ owner: recipient, subject, html });
      await prisma.emailLog.create({
        data: {
          type: "CONTACT_REASSIGNMENT",
          subject,
          fromEmail,
          toEmail: recipient.email,
          status: result.ok ? "SENT" : "FAILED",
          errorMessage: result.ok ? undefined : result.error,
          messageId: result.ok ? result.messageId : undefined,
          contactId: params.contactId,
        },
      });
      return result.ok ? "SENT" : "FAILED";
    };

    const [prev, next] = await Promise.all([deliver(previousOwner, "AWAY"), deliver(newOwner, "TO_YOU")]);
    outcome.previousOwner = prev;
    outcome.newOwner = next;
    return outcome;
  } catch (err) {
    console.error(`[reassignment-email] CONTACT_REASSIGNMENT_EMAIL_FAILED (${err instanceof Error ? err.constructor.name : typeof err})`);
    return outcome;
  }
}
