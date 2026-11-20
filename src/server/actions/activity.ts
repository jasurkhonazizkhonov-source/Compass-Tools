"use server";

import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { leadVisibilityWhere, contactVisibilityWhere } from "@/server/visibility";
import { getEmailViewer, revealedContactIdsToday } from "@/server/privacy/customer-email";
import { maskEmailsInText } from "@/lib/customer-email-mask";

// Pass 6 (§32.C) — getLeadDetail/getContactDetail's own `activities` include
// stays bounded at 30 (unchanged, still the fast path every page load takes
// — see those queries), but a real lead/contact CAN have more than 30
// events (confirmed against the live dev DB: some leads/contacts already
// exceed 70). This is the "load more" companion those pages call only when
// the agent actually asks to see older history, never as part of the
// initial page load. Every exported action in a "use server" file is a
// callable RPC any client can invoke directly, so — same as every other
// entry point in this app — this re-verifies visibility itself rather than
// trusting that only the owning page's own "Load more" button ever calls it.
const ACTIVITY_PAGE_SIZE = 30;
const ACCOUNT_NAME_SELECT = { id: true, fullName: true } as const;

export async function loadMoreActivities(params: { leadId?: string; contactId?: string; cursor: string }) {
  const actor = await getCurrentAccount();
  const viewer = actor ? { id: actor.id, role: actor.role, companyId: actor.companyId } : null;

  let ownerContactId: string | undefined = params.contactId;
  if (params.leadId) {
    const visible = await prisma.lead.findFirst({ where: { id: params.leadId, ...leadVisibilityWhere(viewer) }, select: { id: true, contactId: true } });
    if (!visible) throw new Error("Lead not found");
    ownerContactId = visible.contactId;
  } else if (params.contactId) {
    const visible = await prisma.contact.findFirst({ where: { id: params.contactId, ...contactVisibilityWhere(viewer) }, select: { id: true } });
    if (!visible) throw new Error("Contact not found");
  } else {
    throw new Error("leadId or contactId is required");
  }

  const activities = await prisma.activity.findMany({
    where: params.leadId ? { leadId: params.leadId } : { contactId: params.contactId },
    orderBy: { createdAt: "desc" },
    take: ACTIVITY_PAGE_SIZE,
    cursor: { id: params.cursor },
    skip: 1, // the cursor row itself was already shown on a previous page
    include: { actor: { select: ACCOUNT_NAME_SELECT } },
  });

  // Customer-email privacy: an activity description can hold an address ("Primary email updated to ..."). A viewer who may not see complete addresses - and has not
  // revealed this customer today - gets them masked, the same as the first page of the timeline.
  const emailViewer = actor ? await getEmailViewer(actor) : null;
  const full = !!emailViewer && (!emailViewer.restricted || (!!ownerContactId && (await revealedContactIdsToday(emailViewer, [ownerContactId])).has(ownerContactId)));
  const shown = full ? activities : activities.map((a) => ({ ...a, description: maskEmailsInText(a.description) }));

  return { activities: shown, hasMore: activities.length === ACTIVITY_PAGE_SIZE };
}
