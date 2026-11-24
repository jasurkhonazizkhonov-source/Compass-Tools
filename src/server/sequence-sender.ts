import type { Prisma } from "@/generated/prisma/client";

// WHO SENDS a sequence email, decided in ONE place for both kinds of enrollment (see SequenceEnrollment in schema.prisma):
//   * lead-based enrollment   -> the lead's assigned agent (exactly as it has always been; it follows a reassignment of the lead);
//   * contact-only enrollment -> the contact's OWNER (Contact.ownerId, the contact-level counterpart of a lead's assigned agent; it follows a reassignment of the contact),
//                                else the account that enrolled it (enrolledBy), so a contact nobody owns can still be emailed by the person who chose to email it.
// Used by the enrollment checks (which Gmail must be usable), the sender (which mailbox, which allowance) and the recovery actions, so they can never disagree.

export type SenderAccount = { id: string; fullName: string; email: string; phone: string | null; companyId: string };

type EnrollmentForSender = {
  leadId: string | null;
  lead: { assignedAgent: SenderAccount | null } | null;
  contact: { owner: SenderAccount | null };
  enrolledBy: SenderAccount | null;
};

export function enrollmentSender(enrollment: EnrollmentForSender): SenderAccount | null {
  if (enrollment.leadId) return enrollment.lead?.assignedAgent ?? null;
  return enrollment.contact.owner ?? enrollment.enrolledBy ?? null;
}

/** The sender chosen when a contact-only enrollment is CREATED (the same rule as above, from what is known then): the contact's owner, else the person enrolling. */
export function senderForNewContactEnrollment<T extends { id: string }>(contactOwner: T | null, actor: T | null): T | null {
  return contactOwner ?? actor;
}

/** Where the history entry of an enrollment goes: on the lead for a lead-based one (as always), on the contact for a contact-only one. */
export function activitySubject(enrollment: { leadId: string | null; contactId: string }): { leadId: string } | { contactId: string } {
  return enrollment.leadId ? { leadId: enrollment.leadId } : { contactId: enrollment.contactId };
}

/** Enrollments whose sender is one of these accounts (for the sending allowance: a mailbox that has run out of capacity holds back ALL of its rows, whichever kind). */
export function senderIsOneOf(accountIds: string[]): Prisma.SequenceEnrollmentWhereInput {
  return {
    OR: [
      { lead: { assignedAgentId: { in: accountIds } } },
      { leadId: null, contact: { ownerId: { in: accountIds } } },
      { leadId: null, contact: { ownerId: null }, enrolledById: { in: accountIds } },
    ],
  };
}
