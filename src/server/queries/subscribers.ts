import { prisma } from "@/lib/prisma";
import type { SubscriberStatus } from "@/generated/prisma/client";
import { resolvePageSize } from "@/lib/pagination";

// Pass 7 §17/§18/§28/§29 — database-paginated at 25/page. The status filter
// (all/active/unsubscribed) moved server-side (was client-side `useMemo`
// over the full unbounded list) — it has to, now that only one page's worth
// of rows ever reaches the client: a client-side filter over just the
// current page would silently show far fewer rows than the tab's own count
// implies. Bulk selection in the UI is now explicitly PAGE-scoped (see
// subscriber-list.tsx's own comment) — the safer of the two models §29
// describes, and the only one that doesn't require a separate
// "select every matching row" query.
export async function getSubscribers(params: { companyId: string; status?: SubscriberStatus; page?: number; pageSize?: number }) {
  const page = Math.max(1, Math.trunc(params.page ?? 1) || 1);
  const pageSize = resolvePageSize(params.pageSize); // Pass 12 §28/§30 — 25/50/75/100 allow-list
  const where = { companyId: params.companyId, ...(params.status ? { status: params.status } : {}) };

  const [rows, total] = await Promise.all([
    prisma.subscriber.findMany({
      where,
      // Explicit columns: the opaque unsubscribeToken (the capability behind a
      // subscriber's own unsubscribe link) is deliberately never selected — it must not
      // reach the page payload of any CRM user.
      select: {
        id: true,
        email: true,
        status: true,
        source: true,
        subscribedAt: true,
        unsubscribedAt: true,
        unsubscribeReasonCategory: true,
        unsubscribeReason: true,
        unsubscribeSource: true,
        unsubscribeRespondedAt: true,
      },
      // `id` tiebreaker for deterministic pagination (Pass 7 §25).
      orderBy: [{ subscribedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.subscriber.count({ where }),
  ]);

  // Marketing context for the unsubscribed rows on this page: the most recent campaign
  // that was actually sent to them before they unsubscribed. Derived from the existing
  // send records, so nothing extra is stored and no campaign id ever travels in a link.
  const unsubscribedIds = rows.filter((r) => r.status === "UNSUBSCRIBED").map((r) => r.id);
  const sends = unsubscribedIds.length
    ? await prisma.marketingCampaignSend.findMany({
        where: { subscriberId: { in: unsubscribedIds }, status: "SENT" },
        orderBy: [{ sentAt: "desc" }, { id: "desc" }],
        select: { subscriberId: true, sentAt: true, campaign: { select: { name: true } } },
      })
    : [];
  const subscribers = rows.map((r) => {
    const last = r.status === "UNSUBSCRIBED" ? sends.find((s) => s.subscriberId === r.id && (!r.unsubscribedAt || !s.sentAt || s.sentAt <= r.unsubscribedAt)) : undefined;
    return { ...r, lastCampaignName: last?.campaign.name ?? null };
  });

  return { subscribers, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function getSubscriberCounts(companyId: string) {
  const [total, subscribed, unsubscribed] = await Promise.all([
    prisma.subscriber.count({ where: { companyId } }),
    prisma.subscriber.count({ where: { companyId, status: "SUBSCRIBED" } }),
    prisma.subscriber.count({ where: { companyId, status: "UNSUBSCRIBED" } }),
  ]);
  return { total, subscribed, unsubscribed };
}
