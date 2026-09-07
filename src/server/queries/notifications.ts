import { prisma } from "@/lib/prisma";

export async function getRecentNotifications(accountId: string, limit = 15) {
  return prisma.notification.findMany({
    where: { accountId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      task: { select: { id: true, title: true, status: true } },
      lead: { select: { id: true, contact: { select: { firstName: true, lastName: true } } } },
      quote: { select: { id: true, quoteNumber: true } },
      contactInquiry: { select: { id: true } },
    },
  });
}

export async function getUnreadNotificationCount(accountId: string) {
  return prisma.notification.count({ where: { accountId, readAt: null } });
}
