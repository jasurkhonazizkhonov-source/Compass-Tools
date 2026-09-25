// Shared helper for notifying the CRM users who administer a given public-
// website surface (Get in Touch inbox, Subscriptions) when a new public
// submission arrives — same underlying Notification model/mechanism every
// other in-app notification uses (see prisma/schema.prisma's Notification
// model and e.g. src/server/quote-status.ts's notifyQuoteActivity for the
// existing pattern this mirrors), not a parallel notification system.
import { prisma } from "@/lib/prisma";
import { canViewGetInTouch, canViewSubscriptions } from "@/lib/permissions";
import type { AccountRole, InquirySource } from "@/generated/prisma/client";
import { INQUIRY_SOURCE_META } from "@/lib/inquiry-source";

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

/** A new public inquiry notifies every Admin (canViewGetInTouch is
 * Admin-only, so recipients match page access exactly). The notification's
 * type and title name WHICH system the inquiry came from — Business Flights
 * "Get In Touch" (NEW_INQUIRY) or "CRM Inquiries" (NEW_CRM_INQUIRY) — and
 * clicking it opens the inquiry in ITS OWN section (the bell reads the
 * linked inquiry's source; see inquiryDetailPath). */
export async function notifyNewInquiry(companyId: string, inquiryId: string, submitterName: string, source: InquirySource) {
  const meta = INQUIRY_SOURCE_META[source];
  await notifyRoles(companyId, (role) => canViewGetInTouch(role), {
    type: meta.notificationType,
    title: meta.notificationTitle,
    body: `${submitterName} submitted a new inquiry (${meta.label}).`,
    contactInquiryId: inquiryId,
  });
}

const CATCH_UP_MIN_INTERVAL_MS = 30_000;
const CATCH_UP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const CATCH_UP_LOCK_KEY = 74020001;
let lastCatchUpAt = 0;

/**
 * The Business Flights Travel website is a SEPARATE application that inserts
 * its "Get In Touch" rows straight into ContactInquiry — it has no access to
 * this CRM's notification code, so those inquiries never produced an Admin
 * notification at all (only submissions made through this app's own public
 * route did). This closes that gap: any recent, unread inquiry that has no
 * notification yet gets one per Admin, typed by the inquiry's OWN source.
 *
 * Throttled per instance, and guarded by a Postgres advisory lock so several
 * Admins polling at once cannot create duplicates. Idempotent by
 * construction: an inquiry that already has any notification is skipped.
 */
export async function ensureInquiryNotifications(companyId: string, now: number = Date.now()): Promise<number> {
  if (now - lastCatchUpAt < CATCH_UP_MIN_INTERVAL_MS) return 0;
  lastCatchUpAt = now;

  return prisma.$transaction(async (tx) => {
    const lock = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_try_advisory_xact_lock(${CATCH_UP_LOCK_KEY}) AS ok`;
    if (!lock[0]?.ok) return 0;

    const missing = await tx.contactInquiry.findMany({
      where: { companyId, readAt: null, createdAt: { gte: new Date(now - CATCH_UP_WINDOW_MS) }, notifications: { none: {} } },
      select: { id: true, firstName: true, lastName: true, source: true },
      orderBy: { createdAt: "asc" },
      take: 50,
    });
    if (missing.length === 0) return 0;

    const admins = await tx.account.findMany({ where: { companyId, status: "ACTIVE" }, select: { id: true, role: true } });
    const adminIds = admins.filter((a) => canViewGetInTouch(a.role)).map((a) => a.id);
    if (adminIds.length === 0) return 0;

    await tx.notification.createMany({
      data: missing.flatMap((inq) => {
        const meta = INQUIRY_SOURCE_META[inq.source];
        return adminIds.map((accountId) => ({
          accountId,
          type: meta.notificationType,
          title: meta.notificationTitle,
          body: `${inq.firstName} ${inq.lastName} submitted a new inquiry (${meta.label}).`,
          contactInquiryId: inq.id,
        }));
      }),
    });
    return missing.length;
  });
}

/** Test seam. */
export function resetInquiryCatchUpThrottleForTests() {
  lastCatchUpAt = 0;
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
