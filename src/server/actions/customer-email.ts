"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { contactVisibilityWhere, leadVisibilityWhere } from "@/server/visibility";
import { getEmailViewer, revealCustomerEmails } from "@/server/privacy/customer-email";
import type { EmailUsage } from "@/server/privacy/customer-email";

// The Reveal button's server action. It never returns an address: on success the page is re-rendered by the server, which decides (from the reveal record this action
// just wrote) to show that customer's complete addresses for the rest of the business day. The result carries only the allowance numbers.

export type RevealResult = { ok: true; charged: boolean; usage: EmailUsage } | { ok: false; error: string; usage?: EmailUsage };

export async function revealContactEmails(contactId: string, leadId?: string): Promise<RevealResult> {
  const actor = await getCurrentAccount();
  if (!actor) return { ok: false, error: "Not authenticated" };
  if (typeof contactId !== "string" || !contactId || contactId.length > 64 || (leadId !== undefined && (typeof leadId !== "string" || leadId.length > 64))) {
    return { ok: false, error: "Invalid request" };
  }

  // The same record-access rule as every contact action: the customer, or the lead it is viewed from, must be one this user may open.
  const direct = await prisma.contact.findFirst({ where: { id: contactId, ...contactVisibilityWhere(actor) }, select: { id: true } });
  let viaLead: string | null = null;
  if (!direct && leadId) {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, contactId, ...leadVisibilityWhere(actor) }, select: { id: true } });
    viaLead = lead?.id ?? null;
  }
  if (!direct && !viaLead) return { ok: false, error: "Contact not found" };

  const viewer = await getEmailViewer(actor);
  const outcome = await revealCustomerEmails(viewer, { contactId, leadId: viaLead ?? leadId ?? null });
  if (!outcome.ok) return { ok: false, error: outcome.error, usage: outcome.usage };

  revalidatePath(`/contacts/${contactId}`);
  if (leadId) revalidatePath(`/leads/${leadId}`);
  return { ok: true, charged: outcome.charged, usage: outcome.usage };
}
