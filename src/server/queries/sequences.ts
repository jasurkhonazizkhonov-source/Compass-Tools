import { prisma } from "@/lib/prisma";
import { sequenceVisibilityWhere, type Viewer } from "@/server/visibility";
import { resolvePageSize } from "@/lib/pagination";

// Pass 7 §17/§18 — the top-level Sequence list itself, database-paginated
// at 25/page like every other CRM list. Deliberately separate from (and
// must not be confused with) getSequenceDetail's per-sequence `enrollments`
// list below, which stays unpaginated — a genuinely different list, out of
// this task's scope per its own explicit instruction not to conflate the
// two.
export async function getSequences(params: { viewer: Viewer; scopeUserId?: string; page?: number; pageSize?: number }) {
  const page = Math.max(1, Math.trunc(params.page ?? 1) || 1);
  const pageSize = resolvePageSize(params.pageSize); // Pass 12 §28/§30 — 25/50/75/100 allow-list
  const where = sequenceVisibilityWhere(params.viewer, params.scopeUserId);

  const [rawSequences, total] = await Promise.all([
    prisma.sequence.findMany({
      where,
      // createdAt ties are broken by id (Prisma orders findMany results
      // deterministically by primary key insertion order as a secondary
      // signal is NOT guaranteed by Postgres alone) — an explicit `id: "desc"`
      // tiebreaker keeps page boundaries stable across requests (Pass 7 §25).
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: {
        steps: { select: { id: true } },
        _count: { select: { enrollments: true } },
        createdBy: { select: { id: true, fullName: true } },
      },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.sequence.count({ where }),
  ]);

  // Real performance issue found and fixed: this used to fetch the actual
  // row ids of every ACTIVE enrollment for every sequence on the page just
  // to compute an "Active Enrollments" count via `.length` — for an
  // always-on nurture sequence enrolled against thousands of leads, that's
  // thousands of rows fetched and serialized purely to count them, right
  // next to a `_count` on the same page proving the codebase already knows
  // how to get a count without fetching rows. Prisma's filtered relation
  // count (`_count.select.enrollments: { where }`) can't coexist with the
  // existing unfiltered total count above in the same `_count` block (both
  // would need the same "enrollments" key) — so the active count is
  // computed via one small, batched `groupBy` instead: one extra query
  // total for the whole page, not one per row and not one per sequence.
  const activeCounts = rawSequences.length
    ? await prisma.sequenceEnrollment.groupBy({
        by: ["sequenceId"],
        where: { sequenceId: { in: rawSequences.map((s) => s.id) }, status: "ACTIVE" },
        _count: { _all: true },
      })
    : [];
  const activeCountBySequenceId = new Map(activeCounts.map((c) => [c.sequenceId, c._count._all]));
  const sequences = rawSequences.map((s) => ({ ...s, activeEnrollmentCount: activeCountBySequenceId.get(s.id) ?? 0 }));

  return { sequences, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

// For "apply a sequence to this lead" pickers — active sequences that
// actually have steps (enrollLeads rejects step-less sequences anyway).
// Same visibility scoping as getSequences — a restricted-role agent should
// never be offered someone else's sequence to enroll a lead into.
export async function getApplicableSequences(viewer: Viewer) {
  const sequences = await prisma.sequence.findMany({
    where: { isActive: true, ...sequenceVisibilityWhere(viewer) },
    orderBy: { name: "asc" },
    select: { id: true, name: true, description: true, _count: { select: { steps: true } } },
  });
  return sequences
    .filter((s) => s._count.steps > 0)
    .map((s) => ({ id: s.id, name: s.name, description: s.description, stepCount: s._count.steps }));
}

// Pass 8 — the sequence's own record (name, steps, createdBy) only.
// Enrollments were previously included here unbounded (a real Sequence can
// have far more than fits on one screen); they're now fetched separately
// and paginated by getSequenceEnrollments below, called with the same
// sequenceId + viewer from the detail page.
export async function getSequenceDetail(sequenceId: string, viewer: Viewer) {
  return prisma.sequence.findFirst({
    where: { id: sequenceId, ...sequenceVisibilityWhere(viewer) },
    include: {
      steps: { orderBy: { order: "asc" } },
      createdBy: { select: { id: true, fullName: true } },
    },
  });
}

// Pass 8 (§3) — the per-sequence enrollment list, database-paginated at
// 25/page like every other CRM list (Pass 7's own convention, reused
// verbatim: skip/take + count(), a deterministic id tiebreaker, a
// server-side pageSize cap). This is genuinely a separate list from the
// top-level Sequence list (getSequences) — pagination here does not affect
// or get confused with that one, per Pass 7's own established boundary.
//
// Independently re-verifies `sequenceVisibilityWhere` rather than trusting
// that the caller (the sequence detail page) already checked it via
// getSequenceDetail — the same "never trust a single upstream check"
// pattern this codebase already uses for Activity's own loadMoreActivities
// (Pass 6). This is what stops a user from seeing another company's/
// user's sequence's enrollments merely by knowing/guessing a sequenceId.
//
// Pass 9 §9 — deliberately no status/search filter or alternate sort param
// here, unlike Leads/Contacts/Tasks. The original (pre-Pass-7) enrollment
// list never had one, this is a compact secondary panel embedded alongside
// the Steps editor (not a primary full-page list), a single sequence's
// enrollment count is realistically bounded (applied to a deliberately
// chosen batch of leads, not the whole company), and `enrolledAt desc` is
// already a meaningful, deterministic default order. No existing pattern
// or business requirement calls for more — adding filter/sort UI here
// would be a feature addition looking for a justification, not a fix for
// an actual gap, so it was intentionally left out.
export async function getSequenceEnrollments(params: { sequenceId: string; viewer: Viewer; page?: number; pageSize?: number }) {
  const page = Math.max(1, Math.trunc(params.page ?? 1) || 1);
  const pageSize = resolvePageSize(params.pageSize); // Pass 12 §28/§30 — 25/50/75/100 allow-list
  const where = { sequenceId: params.sequenceId, sequence: sequenceVisibilityWhere(params.viewer) };

  const [enrollments, total] = await Promise.all([
    prisma.sequenceEnrollment.findMany({
      where,
      // `id` tiebreaker for deterministic pagination (Pass 7 §25 convention).
      orderBy: [{ enrolledAt: "desc" }, { id: "desc" }],
      include: {
        lead: { include: { contact: true, departureAirport: true, arrivalAirport: true } },
        stepLogs: { orderBy: { createdAt: "desc" } },
      },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.sequenceEnrollment.count({ where }),
  ]);

  return { enrollments, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}
