// The shared core of "move a lead to a new status" — deliberately WITHOUT a
// visibility/ownership check. Used by the public updateLeadStatus action
// (src/server/actions/leads.ts), which adds that check for direct user-initiated
// calls, and by internal system-driven transitions that have already
// established their own authorization through a different chain (e.g.
// sendQuote's post-send "advance lead to QUOTED", authorized via the quote
// itself — see quoteVisibilityWhere).
//
// It lives in a plain server module, NOT in a "use server" file, on purpose:
// every async export of a "use server" file is a publicly callable Server
// Action, and this function trusts its caller. Living here keeps it callable
// only from other server code, so no client — and no Manager reaching outside
// their team — can invoke it directly with a lead id.
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { logActivity } from "@/server/activity-log";
import type { LeadStatus } from "@/generated/prisma/client";

export async function applyLeadStatusChange(leadId: string, toStatus: LeadStatus, actorId: string | undefined, note?: string) {
  const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });

  await prisma.$transaction([
    prisma.lead.update({ where: { id: leadId }, data: { status: toStatus } }),
    prisma.leadStatusHistory.create({
      data: { leadId, fromStatus: lead.status, toStatus, changedById: actorId, note },
    }),
  ]);

  await logActivity({
    leadId,
    contactId: lead.contactId,
    actorId,
    type: "STATUS_CHANGED",
    description: `Status changed from ${lead.status} to ${toStatus}`,
  });

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/dashboard");
}
