/**
 * The "is this eligible for auto-distribution" check, pulled out as a pure
 * function so it's testable without a database — per the spec's requirement
 * that a "newly-captured website lead" not be detected off a single field.
 * All three conditions must hold: sourced from the website, nobody's
 * claimed it yet, and it's never been through the queue before (so a lead
 * someone manually unassigned later doesn't silently get re-grabbed).
 */
export function isEligibleForAutoDistribution(lead: {
  source: string;
  assignedAgentId: string | null;
  queueDistributedAt: Date | null;
}): boolean {
  return lead.source === "WEBSITE" && lead.assignedAgentId === null && lead.queueDistributedAt === null;
}

/**
 * Pure equivalent of the `ORDER BY lastAssignedAt ASC NULLS FIRST, joinedAt
 * ASC` clause used to pick a worker inside distributeNewWebsiteLead's
 * transaction. Kept in sync with that SQL deliberately, so the
 * least-recently-served ordering can be unit-tested without a database.
 */
export function compareQueueEntries(
  a: { lastAssignedAt: Date | null; joinedAt: Date },
  b: { lastAssignedAt: Date | null; joinedAt: Date },
): number {
  if (a.lastAssignedAt === null && b.lastAssignedAt !== null) return -1;
  if (a.lastAssignedAt !== null && b.lastAssignedAt === null) return 1;
  if (a.lastAssignedAt !== null && b.lastAssignedAt !== null) {
    const diff = a.lastAssignedAt.getTime() - b.lastAssignedAt.getTime();
    if (diff !== 0) return diff;
  }
  return a.joinedAt.getTime() - b.joinedAt.getTime();
}
