// Shared helper for notifying the CRM users who administer a given public-
// website surface (Get in Touch inbox, Subscriptions) when a new public
// submission arrives — same underlying Notification model/mechanism every
// other in-app notification uses (see prisma/schema.prisma's Notification
// model and e.g. src/server/quote-status.ts's notifyQuoteActivity for the
// existing pattern this mirrors), not a parallel notification system.
import { prisma } from "@/lib/prisma";
import { canViewGetInTouch, canViewSubscriptions } from "@/lib/permissions";
import type { AccountRole } from "@/generated/prisma/client";

async function notifyRoles(companyId: string, allowed: (role: AccountRole) => boolean, data: { title: string; body: string; type: string; contactInquiryId?: string }) {
  const recipients = await prisma.account.findMany({
    where: { companyId, status: "ACTIVE" },
    select: { id: true, role: true },
  });
  const targets = recipients.filter((r) => allowed(r.role));
  if (targets.length === 0) return;

  await prisma.notification.createMany({
    data: targets.map((r) => ({
      accountId: r.id,
      type: data.type,
      title: data.title,
      body: data.body,
      contactInquiryId: data.contactInquiryId,
    })),
  });
}

/** Part 1 — a new website Get in Touch submission notifies every Admin
 * (canViewGetInTouch is Admin-only, so notification recipients match page
 * access exactly). Clicking the notification opens the specific inquiry. */
export async function notifyNewInquiry(companyId: string, inquiryId: string, submitterName: string) {
  await notifyRoles(companyId, (role) => canViewGetInTouch(role), {
    type: "NEW_INQUIRY",
    title: "New Get in Touch Message",
    body: `${submitterName} submitted a new inquiry.`,
    contactInquiryId: inquiryId,
  });
}

/** Part 1 — a new website marketing-list subscriber notifies everyone with
 * Subscriptions access (Admin + Marketing Agent — canViewSubscriptions),
 * matching the permission model rather than hardcoding Admin-only. No
 * per-subscriber detail page exists, so there's nothing to deep-link to —
 * the notification-bell click-through falls back to the Subscriptions list
 * itself for this type. */
export async function notifyNewSubscriber(companyId: string, email: string) {
  await notifyRoles(companyId, (role) => canViewSubscriptions(role), {
    type: "NEW_SUBSCRIBER",
    title: "New Subscriber",
    body: `${email} subscribed to marketing emails.`,
  });
}
