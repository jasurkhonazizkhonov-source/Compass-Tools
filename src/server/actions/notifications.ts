"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { getRecentNotifications, getUnreadNotificationCount } from "@/server/queries/notifications";

// All three actions below deliberately ignore any client-supplied account/
// notification-ownership claim and re-derive the actor from the session
// server-side — notification-bell.tsx (a Client Component) previously
// passed its own `accountId` prop straight through as a plain argument,
// which is just a POST body field as far as a direct server-action call is
// concerned. Without this, any authenticated user could read, mark-read, or
// mark-all-read another account's notifications (including a different
// company's) by calling these actions with a different id — notifications
// embed real lead/quote/customer names, so that was a genuine cross-account
// data leak, not just a UI inconvenience.

export async function fetchMyNotifications() {
  const actor = await getCurrentAccount();
  if (!actor) return { items: [], unreadCount: 0 };
  const [items, unreadCount] = await Promise.all([
    getRecentNotifications(actor.id),
    getUnreadNotificationCount(actor.id),
  ]);
  return { items, unreadCount };
}

export async function markNotificationRead(notificationId: string) {
  const actor = await getCurrentAccount();
  if (!actor) return;
  // updateMany (not update) so a notificationId belonging to another
  // account silently matches zero rows instead of mutating it — the same
  // fail-closed IDOR pattern the rest of the app uses (findFirst merged
  // with a visibility `where`), just expressed as an update.
  await prisma.notification.updateMany({ where: { id: notificationId, accountId: actor.id }, data: { readAt: new Date() } });
}

export async function markAllNotificationsRead() {
  const actor = await getCurrentAccount();
  if (!actor) return;
  await prisma.notification.updateMany({ where: { accountId: actor.id, readAt: null }, data: { readAt: new Date() } });
  revalidatePath("/tasks");
}
