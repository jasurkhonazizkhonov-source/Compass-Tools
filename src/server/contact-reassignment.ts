// Plain server-only module — deliberately NOT a "use server" file (see
// src/server/contact-resolution.ts's identical warning). This is the
// shared CORE of "move a Contact (and everything under it) to a new
// owner" — it has no authorization check of its own, so it must never be
// reachable directly from client code. Two callers use it:
//   1. reassignContact() (src/server/actions/contacts.ts) — an explicit
//      admin/manager action, which checks canReassignLeads() BEFORE
//      calling this.
//   2. recheckContactOwnershipMatch() (below) — an automatic system
//      trigger fired after an agent edits a Contact's primary phone/email
//      and the new value now matches a DIFFERENT existing Contact's own
//      phone/email. This can legitimately fire for ANY agent regardless of
//      their own reassignment permission (it's the system correcting a
//      duplicate-identity situation, not the agent manually reassigning
//      anything), which is exactly why this core had to be factored out
//      from behind reassignContact's permission gate rather than reused
//      as-is.
import { prisma } from "@/lib/prisma";
import { duplicateContactWhere } from "@/lib/contact-matching";
import { sendEmail } from "@/server/email/service";
import { buildReassignmentEmail } from "@/server/email/templates";
import { getCompanyForAccountId } from "@/server/queries/company";
import { resolveBaseUrl } from "@/lib/company-config";

export type ReassignContactResult = { reassignedLeadCount: number };

/**
 * Moves a Contact's OWNERSHIP ONLY to `newOwnerId` — notifying the previous
 * and new Contact owner. No permission check — the caller is responsible
 * for authorizing this before invoking it. `actor` is optional: when the
 * reassignment is system-triggered (no human actor), activity/audit
 * entries and outgoing email simply have no actor identity attached —
 * there is no admin session to send the notification email FROM in that
 * case, so the email step is skipped (the in-app Notification is not,
 * since that has no "from" concept).
 *
 * Pass 7 — Contact ownership and Lead ownership are independent, explicit
 * business rules: this function used to also cascade every attached Lead's
 * assignedAgentId (and their Quotes' agentId) to the new Contact owner.
 * That was wrong — a Contact can legitimately have Leads owned by several
 * different agents, and reassigning who owns the CUSTOMER RELATIONSHIP
 * must not silently reassign every in-flight travel request under it too.
 * Only an explicit Lead reassignment (reassignLead, leads.ts) changes a
 * Lead's own owner now. `ReassignContactResult.reassignedLeadCount` is kept
 * at the type level for caller compatibility but is now always 0 — callers
 * should stop depending on it (see reassignContact's own comment).
 */
export async function performContactReassignment(params: {
  contactId: string;
  newOwnerId: string;
  reason: string;
  actor?: { id: string; fullName: string; email: string } | null;
  auditAction: string;
}): Promise<ReassignContactResult> {
  const { contactId, newOwnerId, reason, actor, auditAction } = params;

  const newOwner = await prisma.account.findUniqueOrThrow({ where: { id: newOwnerId }, select: { id: true, fullName: true, email: true, companyId: true } });

  const contact = await prisma.contact.findUniqueOrThrow({
    where: { id: contactId },
    select: {
      firstName: true,
      lastName: true,
      companyId: true,
      owner: { select: { id: true, fullName: true, email: true } },
    },
  });

  const contactName = `${contact.firstName} ${contact.lastName}`;
  const previousOwner = contact.owner;

  await prisma.$transaction([
    prisma.contact.update({ where: { id: contactId }, data: { ownerId: newOwnerId } }),
    // A CONTACT-scoped event only — no per-lead LEAD_REASSIGNED entries,
    // since no Lead's ownership actually changes here (see this function's
    // own doc comment). A Contact with zero Leads attached (e.g. a brand-
    // new or Bulk-Contacts-imported contact) still gets this event, same
    // as before.
    prisma.activity.create({
      data: {
        contactId,
        actorId: actor?.id,
        type: "CONTACT_REASSIGNED",
        description: previousOwner
          ? `Contact reassigned from ${previousOwner.fullName} to ${newOwner.fullName}${reason ? ` — ${reason}` : ""}`
          : `Contact assigned to ${newOwner.fullName}${reason ? ` — ${reason}` : ""}`,
        metadata: {
          previousOwnerId: previousOwner?.id ?? null,
          previousOwnerName: previousOwner?.fullName ?? null,
          newOwnerId: newOwner.id,
          newOwnerName: newOwner.fullName,
          reason: reason ?? null,
        },
      },
    }),
    prisma.auditLog.create({
      data: {
        actorId: actor?.id,
        action: auditAction,
        entityType: "Contact",
        entityId: contactId,
        metadata: {
          previousOwnerId: previousOwner?.id ?? null,
          previousOwnerName: previousOwner?.fullName ?? null,
          newOwnerId: newOwner.id,
          newOwnerName: newOwner.fullName,
          reason,
        },
      },
    }),
  ]);

  if (!previousOwner || previousOwner.id === newOwner.id) {
    // Either brand-new (no previous owner to notify) or a same-owner no-op
    // — still notify the new owner below, but there's no "previous owner"
    // leg to run.
  } else {
    const baseUrl = resolveBaseUrl();
    const contactUrl = `${baseUrl}/contacts/${contactId}`;

    await prisma.notification.create({
      data: {
        accountId: previousOwner.id,
        type: "CONTACT_REASSIGNED",
        title: `Contact reassigned: ${contactName}`,
        body: `Reassigned to ${newOwner.fullName}${actor ? ` by ${actor.fullName}` : reason ? ` — ${reason}` : ""}. Any leads you own for this contact are unaffected.`,
      },
    });

    // Only sent when a human actor initiated this (an admin's own Gmail
    // sends it) — a system-triggered reassignment has no CRM session to
    // send an email FROM, so it relies on the in-app Notification alone.
    if (previousOwner.email && actor) {
      const company = await getCompanyForAccountId(actor.id);
      const { subject, html } = buildReassignmentEmail({
        recipientFullName: previousOwner.fullName,
        contactFullName: contactName,
        previousOwnerName: previousOwner.fullName,
        newOwnerName: newOwner.fullName,
        reassignedByName: actor.fullName,
        reason,
        reassignedAt: new Date(),
        scope: "CONTACT",
        leads: [],
        contactUrl,
        company,
      });
      const result = await sendEmail({ accountId: actor.id, to: previousOwner.email, subject, html, senderName: actor.fullName });
      await prisma.emailLog.create({
        data: {
          type: "LEAD_REASSIGNMENT",
          subject,
          fromEmail: actor.email,
          toEmail: previousOwner.email,
          status: result.ok ? "SENT" : "FAILED",
          errorMessage: result.ok ? undefined : result.error,
          contactId,
        },
      });
    }
  }

  await prisma.notification.create({
    data: {
      accountId: newOwner.id,
      type: "CONTACT_ASSIGNED",
      title: `Contact assigned: ${contactName}`,
      body: `Assigned to you${actor ? ` by ${actor.fullName}` : reason ? ` — ${reason}` : ""}.`,
    },
  });

  return { reassignedLeadCount: 0 };
}

/**
 * Part 15/16 — after a Contact's primary phone/email is edited, checks
 * whether the NEW value now matches a DIFFERENT existing Contact in the
 * same company. If that other Contact has an owner different from this
 * one's current owner, the edited Contact (and everything under it —
 * Leads, Quotes) is automatically reassigned to that owner, since the
 * matching contact record represents the authoritative "this is who
 * really owns this customer relationship" signal. Company-scoped (never
 * matches across companies) and self-excluding (never "matches" the
 * contact being edited against itself). A no-op — never throws — so a
 * failure here can never turn an otherwise-successful phone/email edit
 * into an error for the editing agent; the edit itself has already
 * committed by the time this runs.
 */
export async function recheckContactOwnershipMatch(contactId: string): Promise<void> {
  try {
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      select: { id: true, companyId: true, ownerId: true, primaryPhone: true, primaryEmail: true },
    });
    if (!contact) return;

    const orConditions = duplicateContactWhere(contact.primaryPhone ?? undefined, contact.primaryEmail ?? undefined);
    if (orConditions.length === 0) return;

    const matched = await prisma.contact.findFirst({
      where: { id: { not: contactId }, companyId: contact.companyId, OR: orConditions },
      select: { id: true, ownerId: true },
    });
    if (!matched?.ownerId || matched.ownerId === contact.ownerId) return;

    await performContactReassignment({
      contactId,
      newOwnerId: matched.ownerId,
      reason: "Updated contact information matched an existing contact owned by another agent",
      auditAction: "CONTACT_AUTO_REASSIGNED",
    });
  } catch (err) {
    console.error(`recheckContactOwnershipMatch failed for contact ${contactId}:`, err);
  }
}
