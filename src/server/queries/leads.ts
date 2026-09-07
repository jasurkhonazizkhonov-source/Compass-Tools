import { prisma } from "@/lib/prisma";
import type { CabinClass, LeadSource, LeadStatus, Prisma, TripType } from "@/generated/prisma/client";
import { leadVisibilityWhere, type Viewer } from "@/server/visibility";
import { resolvePageSize } from "@/lib/pagination";

export type LeadFilters = {
  q?: string;
  status?: LeadStatus[];
  agentId?: string;
  cabinClass?: CabinClass;
  tripType?: TripType;
  source?: LeadSource;
  page?: number;
  pageSize?: number;
  sort?: "newest" | "oldest";
  viewer: Viewer;
};

export async function getLeads(filters: LeadFilters) {
  const page = Math.max(1, Math.trunc(filters.page ?? 1) || 1);
  // Pass 7 §18/§31, Pass 12 §28/§30 — 25/50/75/100 rows/page, validated
  // server-side against a strict allow-list.
  const pageSize = resolvePageSize(filters.pageSize);

  const where: Prisma.LeadWhereInput = {
    ...leadVisibilityWhere(filters.viewer),
    AND: [
      filters.status && filters.status.length > 0 ? { status: { in: filters.status } } : {},
      // The `?agent=` filter is a manual UI narrowing, not a visibility
      // grant — a restricted viewer can only ever narrow further within
      // their own leadVisibilityWhere() scope above, never widen past it,
      // so this only actually applies for a canViewAllRecords() viewer.
      // Pass 10 — "unassigned" is a distinct sentinel value (never a real
      // account id) meaning `assignedAgentId IS NULL`, the authoritative
      // ownership field itself — never inferred from Contact owner, Lead
      // status, or queue state. Safe for a restricted viewer too: ANDed
      // against their own `{assignedAgentId: viewer.id}` scope above, so
      // `agentId=unassigned` from a restricted viewer can only ever produce
      // an impossible (viewer.id === null) condition, never a widened one.
      filters.agentId === "unassigned" ? { assignedAgentId: null } : filters.agentId ? { assignedAgentId: filters.agentId } : {},
      filters.cabinClass ? { cabinClass: filters.cabinClass } : {},
      filters.tripType ? { tripType: filters.tripType } : {},
      filters.source ? { source: filters.source } : {},
      filters.q
        ? {
            OR: [
              { contact: { firstName: { contains: filters.q, mode: "insensitive" } } },
              { contact: { lastName: { contains: filters.q, mode: "insensitive" } } },
              { contact: { primaryEmail: { contains: filters.q, mode: "insensitive" } } },
              { contact: { primaryPhone: { contains: filters.q, mode: "insensitive" } } },
              { departureAirport: { iata: { contains: filters.q, mode: "insensitive" } } },
              { departureAirport: { city: { contains: filters.q, mode: "insensitive" } } },
              { arrivalAirport: { iata: { contains: filters.q, mode: "insensitive" } } },
              { arrivalAirport: { city: { contains: filters.q, mode: "insensitive" } } },
            ],
          }
        : {},
    ],
  };

  const [leads, total] = await Promise.all([
    prisma.lead.findMany({
      where,
      include: {
        contact: true,
        departureAirport: true,
        arrivalAirport: true,
        assignedAgent: true,
      },
      // updatedAt is used as the recency signal (matches Contact's list sort
      // and mirrors Quote's lastActivityAt convention) rather than
      // createdAt, so leads with recent status changes/edits/reassignment
      // surface first — not just recently-created ones. `id` is a
      // deterministic secondary tiebreaker (Pass 7 §25) so two leads
      // sharing an updatedAt can never appear on two pages or vanish
      // between page requests.
      orderBy: [{ updatedAt: filters.sort === "oldest" ? "asc" : "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.lead.count({ where }),
  ]);

  return { leads, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function listLeadsForEnrollment(viewer: Viewer) {
  const leads = await prisma.lead.findMany({
    where: leadVisibilityWhere(viewer),
    include: { contact: true, departureAirport: true, arrivalAirport: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return leads.map((l) => ({
    id: l.id,
    name: `${l.contact.firstName} ${l.contact.lastName}`,
    route: `${l.departureAirport?.iata ?? "?"} → ${l.arrivalAirport?.iata ?? "?"}`,
    status: l.status,
  }));
}

// See contactRecordExists in queries/contacts.ts for why this exists —
// unscoped existence check for the not-found vs. not-visible distinction.
export async function leadRecordExists(leadId: string): Promise<boolean> {
  const row = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true } });
  return row !== null;
}

// Every nested Account relation below is deliberately `select`-narrowed to
// {id, fullName} — never a bare `true` — so a Decimal field
// (commissionPercent/tipPercent) can never ride along into whatever
// downstream Client Component eventually renders it. TypeScript's
// structural typing would happily let a wider Prisma result satisfy a
// narrower client-side prop type at compile time, so this has to be
// enforced here, at the query, not assumed from the consuming component's
// own (narrower) prop type.
const ACCOUNT_NAME_SELECT = { id: true, fullName: true } as const;

export async function getLeadDetail(leadId: string, viewer: Viewer) {
  return prisma.lead.findFirst({
    where: { id: leadId, ...leadVisibilityWhere(viewer) },
    include: {
      contact: { include: { phones: true, emails: true } },
      departureAirport: true,
      arrivalAirport: true,
      assignedAgent: { select: ACCOUNT_NAME_SELECT },
      referredByContact: { select: { id: true, firstName: true, lastName: true } },
      statusHistory: { orderBy: { changedAt: "desc" }, include: { changedBy: { select: ACCOUNT_NAME_SELECT } } },
      notesRel: { orderBy: { createdAt: "desc" }, include: { author: { select: ACCOUNT_NAME_SELECT } } },
      tasks: { orderBy: { dueAt: "asc" }, include: { assignee: { select: ACCOUNT_NAME_SELECT } } },
      activities: { orderBy: { createdAt: "desc" }, take: 30, include: { actor: { select: ACCOUNT_NAME_SELECT } } },
      attachments: { orderBy: { createdAt: "desc" }, include: { uploadedBy: { select: ACCOUNT_NAME_SELECT } } },
      quotes: { orderBy: { createdAt: "desc" }, include: { itinerary: { include: { segments: true } } } },
      bookings: { orderBy: { createdAt: "desc" } },
      enrollments: {
        orderBy: { enrolledAt: "desc" },
        include: { sequence: { include: { steps: { orderBy: { order: "asc" } } } }, enrolledBy: { select: ACCOUNT_NAME_SELECT } },
      },
    },
  });
}
