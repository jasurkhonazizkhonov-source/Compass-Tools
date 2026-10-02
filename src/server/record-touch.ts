// "Updated" on the Leads and Contacts lists is the record's own `updatedAt`
// (Prisma maintains it on every write to that row) and the lists are sorted by
// it in the database. That is already right for edits made directly to a lead
// or contact. These two helpers cover the meaningful changes that happen
// ELSEWHERE but must still count as an update to the lead/contact:
//
//   • a customer's name / phone / email changing — those fields live on the
//     Contact, but they are part of every one of that customer's Leads;
//   • a quote being SENT — the lead (and its customer) just had meaningful
//     activity even when the lead's own status does not change (a second
//     quote, a resend, a lead already QUOTED).
//
// They are explicit, write-only and called ONLY from successful business
// actions. Nothing that merely reads a record, opens a page, polls or
// refreshes ever calls them, so opening a lead can never make it jump to the
// top. Best-effort by design: a failure here must never fail the action that
// already succeeded (the real change is committed; only the ordering hint is
// lost), so errors are swallowed after a safe-tag log line.
import { prisma } from "@/lib/prisma";

export async function touchLead(leadId: string): Promise<void> {
  try {
    await prisma.lead.update({ where: { id: leadId }, data: { updatedAt: new Date() } });
  } catch {
    console.error("[record-touch] LEAD_TOUCH_FAILED");
  }
}

export async function touchContact(contactId: string): Promise<void> {
  try {
    await prisma.contact.update({ where: { id: contactId }, data: { updatedAt: new Date() } });
  } catch {
    console.error("[record-touch] CONTACT_TOUCH_FAILED");
  }
}

/** A customer's own details changed: every lead of that customer was updated too. */
export async function touchContactLeads(contactId: string): Promise<void> {
  try {
    await prisma.lead.updateMany({ where: { contactId }, data: { updatedAt: new Date() } });
  } catch {
    console.error("[record-touch] CONTACT_LEADS_TOUCH_FAILED");
  }
}
