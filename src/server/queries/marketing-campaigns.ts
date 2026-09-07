import { prisma } from "@/lib/prisma";
import { resolvePageSize } from "@/lib/pagination";

// Pass 7 §17/§18/§28 — database-paginated at 25/page. Shares the
// /subscriptions route with Subscribers but is queried and paginated
// completely independently (its own `campaignsPage` URL param — see
// subscriptions/page.tsx — distinct from Subscribers' own `subscribersPage`,
// since one route hosts two independent paginated lists).
export async function getMarketingCampaigns(params: { companyId: string; page?: number; pageSize?: number }) {
  const page = Math.max(1, Math.trunc(params.page ?? 1) || 1);
  const pageSize = resolvePageSize(params.pageSize); // Pass 12 §28/§30 — 25/50/75/100 allow-list
  const where = { companyId: params.companyId };

  const [campaigns, total] = await Promise.all([
    prisma.marketingCampaign.findMany({
      where,
      include: { createdBy: { select: { fullName: true } }, _count: { select: { sends: true } } },
      // `id` tiebreaker for deterministic pagination (Pass 7 §25).
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.marketingCampaign.count({ where }),
  ]);

  return { campaigns, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function getMarketingCampaignDetail(campaignId: string, companyId: string) {
  return prisma.marketingCampaign.findFirst({
    where: { id: campaignId, companyId },
    include: {
      createdBy: { select: { fullName: true } },
      sends: {
        include: { subscriber: { select: { email: true } } },
        orderBy: { createdAt: "desc" },
        take: 200,
      },
      // Pass 16 §7 — an accurate SENT count, independent of the `sends`
      // list's own take:200 cap above (a campaign with more than 200 send
      // records would otherwise undercount how many have actually gone
      // out, which the batched/resumable send's "N remaining" UI needs to
      // get right for any campaign size, not just small ones).
      _count: { select: { sends: { where: { status: "SENT" } } } },
    },
  });
}
