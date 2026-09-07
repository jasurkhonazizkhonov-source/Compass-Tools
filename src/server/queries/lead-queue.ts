import { prisma } from "@/lib/prisma";
import { compareQueueEntries } from "@/lib/lead-distribution";

// Position is a permanent rank by original joinedAt, computed across every
// entry that has EVER joined the queue — active or paused — WITHIN THIS
// COMPANY (Pass 22 fix: previously counted every LeadQueueEntry across
// every company in the whole deployment, silently inflating a company's own
// queue position by however many unrelated companies' workers happened to
// have joined earlier — a correctness bug, not just a scoping gap, since
// LeadQueueEntry itself carries no companyId column and can only be scoped
// through its owning Account). Pausing removes a worker from distribution
// eligibility (see distributeNewWebsiteLead) but must never renumber
// anyone, including the paused worker themselves once they resume.
export async function getQueuePosition(entry: { joinedAt: Date }, companyId: string): Promise<number> {
  return prisma.leadQueueEntry.count({
    where: { joinedAt: { lte: entry.joinedAt }, account: { companyId } },
  });
}

export async function getMyQueueStatus(accountId: string | undefined, companyId: string | undefined) {
  if (!accountId || !companyId) return { isActive: false, position: null as number | null };

  const entry = await prisma.leadQueueEntry.findUnique({ where: { accountId } });
  if (!entry) return { isActive: false, position: null as number | null };

  const position = await getQueuePosition(entry, companyId);
  return { isActive: entry.isActive, position };
}

// Ordered to match distributeNewWebsiteLead's actual pick order (least
// recently served first) rather than plain join order, so this reflects who
// is genuinely "up next" for the following lead. Pass 22 fix: scoped by
// companyId — see getQueuePosition's comment for why this was previously
// missing across every function in this file.
export async function getActiveQueueMembers(companyId: string) {
  const entries = await prisma.leadQueueEntry.findMany({
    where: { isActive: true, account: { companyId } },
    include: { account: { select: { id: true, fullName: true } } },
  });
  return entries.sort(compareQueueEntries);
}

// Every worker who has ever joined the queue — active AND paused — for the
// account-page "who's currently ready for leads" roster. Ordered by the
// same permanent position rank as getQueuePosition, not distribution
// priority, since this is a "who's who" list rather than a dispatch order.
// Pass 22 fix: scoped by companyId (previously listed every company's
// workers to every viewer — a real cross-tenant staff-roster leak).
export async function getAllQueueMembers(companyId: string) {
  const entries = await prisma.leadQueueEntry.findMany({
    where: { account: { companyId } },
    orderBy: { joinedAt: "asc" },
    include: { account: { select: { id: true, fullName: true, avatarUrl: true } } },
  });
  return entries.map((entry, i) => ({ ...entry, position: i + 1 }));
}
