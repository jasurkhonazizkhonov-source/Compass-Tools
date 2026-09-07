import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { contactVisibilityWhere, type Viewer } from "@/server/visibility";
import { resolvePageSize } from "@/lib/pagination";

export async function getContacts(params: {
  q?: string;
  agentId?: string;
  hasEmail?: boolean;
  hasPhone?: boolean;
  page?: number;
  pageSize?: number;
  viewer: Viewer;
}) {
  const page = Math.max(1, Math.trunc(params.page ?? 1) || 1);
  // Pass 7 §18/§31, Pass 12 §28/§30 — 25/50/75/100 rows/page, validated
  // server-side against a strict allow-list regardless of what a caller
  // passes — this is the actual enforcement point, not a UI convention.
  const pageSize = resolvePageSize(params.pageSize);

  const where: Prisma.ContactWhereInput = {
    ...contactVisibilityWhere(params.viewer),
    AND: [
      params.q
        ? {
            OR: [
              { firstName: { contains: params.q, mode: "insensitive" } },
              { lastName: { contains: params.q, mode: "insensitive" } },
              { primaryEmail: { contains: params.q, mode: "insensitive" } },
              { primaryPhone: { contains: params.q, mode: "insensitive" } },
            ],
          }
        : {},
      // Same "manual narrowing, never a widening grant" reasoning as
      // Lead's own `?agent=` filter (see queries/leads.ts) — this only
      // narrows further within contactVisibilityWhere's own scope above.
      // Pass 10 — "unassigned" is a distinct sentinel meaning `ownerId IS
      // NULL`, the authoritative Contact ownership field — independent of
      // any Lead's own ownership (Pass 7's ownership-independence rule).
      params.agentId === "unassigned" ? { ownerId: null } : params.agentId ? { ownerId: params.agentId } : {},
      params.hasEmail !== undefined ? { primaryEmail: params.hasEmail ? { not: null } : null } : {},
      params.hasPhone !== undefined ? { primaryPhone: params.hasPhone ? { not: null } : null } : {},
    ],
  };

  const [contacts, total] = await Promise.all([
    prisma.contact.findMany({
      where,
      include: {
        owner: { select: { id: true, fullName: true } },
        leads: {
          select: {
            id: true,
            status: true,
            departureAirport: { select: { iata: true } },
            arrivalAirport: { select: { iata: true } },
            assignedAgent: { select: { fullName: true } },
          },
        },
        _count: { select: { leads: true, bookings: true } },
      },
      // updatedAt reflects the most recent activity on the contact record
      // itself (edits, reassignment, primary phone/email changes, etc.) —
      // the same "recency" convention Quote list views use via
      // lastActivityAt. Contact has no dedicated activity-bump field, and
      // Prisma's auto-managed @updatedAt is a faithful, no-new-column proxy
      // for it. `id` is a secondary tiebreaker (Pass 7 §25) — real risk here
      // specifically, since bulkCreateContacts' own batch createMany can
      // give several rows the exact same updatedAt, which without a
      // deterministic secondary key could let a row appear on two pages or
      // be skipped between requests.
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.contact.count({ where }),
  ]);

  return { contacts, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

// Searchable-combobox lookup for "Referred By" (see NewLeadDialog) — same
// shape/convention as searchLeadsForTaskLink/searchAirports: empty query
// returns a small recent-first default list, non-empty query does a
// contains/insensitive OR match, both capped at a small `take`. Scoped by
// contactVisibilityWhere so a restricted-role agent can only tag a referrer
// from contacts they can already see.
export async function searchContacts(query: string, viewer: Viewer, excludeContactId?: string) {
  const where: Prisma.ContactWhereInput = {
    ...contactVisibilityWhere(viewer),
    ...(excludeContactId ? { id: { not: excludeContactId } } : {}),
    ...(query.trim()
      ? {
          OR: [
            { firstName: { contains: query, mode: "insensitive" } },
            { lastName: { contains: query, mode: "insensitive" } },
            { primaryEmail: { contains: query, mode: "insensitive" } },
            { primaryPhone: { contains: query, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  return prisma.contact.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: 8,
    select: { id: true, firstName: true, lastName: true, primaryPhone: true, primaryEmail: true },
  });
}

// Unscoped (no visibility filter) existence check — used only on the
// not-found path of getContactDetail, to distinguish "record doesn't exist
// at all" (real 404) from "record exists but this viewer can't see it"
// (Access Restricted page). Never returns any field beyond `id` so it can't
// leak data about a record the viewer isn't authorized to see.
export async function contactRecordExists(contactId: string): Promise<boolean> {
  const row = await prisma.contact.findUnique({ where: { id: contactId }, select: { id: true } });
  return row !== null;
}

// Deliberately `select`-narrowed to {id, fullName} — never a bare `true` —
// so a Decimal field (commissionPercent/tipPercent) on the nested Account
// row can never ride along into whatever downstream Client Component ends
// up rendering it (see the identical comment in queries/leads.ts).
const ACCOUNT_NAME_SELECT = { id: true, fullName: true } as const;

export async function getContactDetail(contactId: string, viewer: Viewer) {
  return prisma.contact.findFirst({
    where: { id: contactId, ...contactVisibilityWhere(viewer) },
    include: {
      owner: { select: { id: true, fullName: true } },
      phones: { orderBy: { isPrimary: "desc" } },
      emails: { orderBy: { isPrimary: "desc" } },
      leads: {
        orderBy: { createdAt: "desc" },
        include: { departureAirport: true, arrivalAirport: true, assignedAgent: { select: ACCOUNT_NAME_SELECT } },
      },
      quotes: { orderBy: { createdAt: "desc" } },
      bookings: { orderBy: { createdAt: "desc" } },
      notes: { orderBy: { createdAt: "desc" }, include: { author: { select: ACCOUNT_NAME_SELECT } } },
      tasks: { orderBy: { dueAt: "asc" }, include: { assignee: { select: ACCOUNT_NAME_SELECT } } },
      activities: { orderBy: { createdAt: "desc" }, take: 30, include: { actor: { select: ACCOUNT_NAME_SELECT } } },
      attachments: { orderBy: { createdAt: "desc" } },
      emailLogs: { orderBy: { createdAt: "desc" }, take: 20 },
      // Explicit select allow-list, never `include: true` — encryptedPan
      // (the only field that can ever be decrypted into a full PAN) must
      // never be reachable from this or any other ordinary query. Only
      // revealPaymentMethod()/startSupplierPaymentAuthorization() ever
      // select it. Archived (removed) cards are excluded from this default
      // list — their audit/charge history is preserved, just not shown here.
      paymentMethods: {
        where: { status: "ACTIVE" },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          cardholderName: true,
          last4: true,
          cardBrand: true,
          expiryMonth: true,
          expiryYear: true,
          bookingId: true,
          status: true,
          createdAt: true,
        },
      },
    },
  });
}
