import { prisma } from "@/lib/prisma";
import type { InquiryStatus } from "@/generated/prisma/client";
import { resolvePageSize } from "@/lib/pagination";

// Pass 7 §17/§18/§28 — database-paginated at 25/page like every other CRM
// list; "Get in Touch remains separate from Leads" is unaffected (still its
// own model/query, never merged with getLeads).
export async function getContactInquiries(params: { companyId: string; status?: InquiryStatus; page?: number; pageSize?: number }) {
  const page = Math.max(1, Math.trunc(params.page ?? 1) || 1);
  const pageSize = resolvePageSize(params.pageSize); // Pass 12 §28/§30 — 25/50/75/100 allow-list
  const where = { companyId: params.companyId, ...(params.status ? { status: params.status } : {}) };

  const [inquiries, total] = await Promise.all([
    prisma.contactInquiry.findMany({
      where,
      include: {
        assignedAdmin: { select: { id: true, fullName: true } },
        matchedContact: { select: { id: true, firstName: true, lastName: true, ownerId: true, owner: { select: { fullName: true } } } },
      },
      // `id` tiebreaker for deterministic pagination (Pass 7 §25).
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.contactInquiry.count({ where }),
  ]);

  return { inquiries, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function getContactInquiryDetail(inquiryId: string, companyId: string) {
  return prisma.contactInquiry.findFirst({
    where: { id: inquiryId, companyId },
    include: {
      assignedAdmin: { select: { id: true, fullName: true } },
      // Item 10 — surface the matched contact's most recent Lead (a Contact
      // can have Leads owned by different agents; only the most recent is
      // shown) as a pure read-time reference, never a new match — the
      // underlying contact match itself is still computed once, at
      // inquiry-submission time, by duplicateContactWhere.
      matchedContact: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          ownerId: true,
          owner: { select: { fullName: true } },
          leads: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true } },
        },
      },
      notes: { orderBy: { createdAt: "desc" }, include: { author: { select: { id: true, fullName: true } } } },
    },
  });
}

export async function getUnreadInquiryCount(companyId: string) {
  return prisma.contactInquiry.count({ where: { companyId, readAt: null } });
}
