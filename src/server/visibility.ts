// Row-level visibility — the single source of truth for which
// Contacts/Leads/Quotes/Bookings a given account is allowed to see.
// Every query function that lists or fetches these records merges one of
// these `where` fragments into its own query, so the restriction is
// enforced by the database query itself (not a post-fetch filter or
// anything the frontend could bypass by hitting the route directly).
//
// A restricted (non-canViewAllRecords) viewer sees a Quote/Booking if
// EITHER its own agent link matches them OR its Lead's assignedAgentId
// does OR its Contact's ownerId does — these three can diverge (e.g. a
// quote created by one agent for a lead since reassigned to another), and
// the spec's own wording ("Quotes belonging to / associated with Leads or
// Contacts assigned to them") calls for the union, not just one signal.
import type { AccountRole, Prisma } from "@/generated/prisma/client";
import { canViewAllRecords, canViewAllQuotesAndBookings, canManageAllSequences } from "@/lib/permissions";

// Which leads a given actor may create a NEW quote against — mirrors
// quoteVisibilityWhere's own resource grouping (canViewAllQuotesAndBookings,
// which includes Flight Expert) rather than leadVisibilityWhere/
// canViewAllRecords, since this gates a QUOTE-creation action, not general
// Lead visibility. A restricted role (Travel Agent) may only quote a lead
// actually assigned to them — closes the previously-open "any authenticated
// user could create a quote for any leadId" gap (both in the createQuote
// action and the /quotes/new page's own lead lookup).
export function leadAccessForQuoting(actor: Viewer): Prisma.LeadWhereInput {
  if (!actor) return NOTHING_VISIBLE;
  if (canViewAllQuotesAndBookings(actor.role)) return { contact: { companyId: actor.companyId } };
  return { assignedAgentId: actor.id };
}

export type Viewer = { id: string; role: AccountRole; companyId: string } | null | undefined;

// A viewer that's missing entirely (shouldn't happen for an authenticated
// CRM page, but query functions are defensive rather than assuming it) is
// treated as having access to nothing — fail closed, not fail open.
const NOTHING_VISIBLE = { id: "__no_viewer__" };

// Company isolation (§32): a "sees everything" role only sees everything
// WITHIN its own company — never another company's records. The
// restricted (non-canViewAllRecords) branches below need no separate
// company filter: `ownerId`/`assignedAgentId` match a specific Account's
// globally-unique id, which by construction can only ever belong to one
// company, so `viewer.id` alone already can't cross a company boundary.
// Every Lead/Quote/Booking has a non-nullable `contactId`, and Contact
// itself carries `companyId` directly (set at creation from the creating
// agent's own company — see createLead in src/server/actions/leads.ts) —
// so scoping through `contact.companyId` is reliable even for records with
// no owner/agent assigned yet (e.g. a brand-new unassigned lead), unlike
// scoping through the nullable ownerId/assignedAgentId/agentId fields.
export function contactVisibilityWhere(viewer: Viewer): Prisma.ContactWhereInput {
  if (!viewer) return NOTHING_VISIBLE;
  if (canViewAllRecords(viewer.role)) return { companyId: viewer.companyId };
  return { ownerId: viewer.id };
}

export function leadVisibilityWhere(viewer: Viewer): Prisma.LeadWhereInput {
  if (!viewer) return NOTHING_VISIBLE;
  if (canViewAllRecords(viewer.role)) return { contact: { companyId: viewer.companyId } };
  return { assignedAgentId: viewer.id };
}

export function quoteVisibilityWhere(viewer: Viewer): Prisma.QuoteWhereInput {
  if (!viewer) return NOTHING_VISIBLE;
  if (canViewAllQuotesAndBookings(viewer.role)) return { contact: { companyId: viewer.companyId } };
  return {
    OR: [
      { agentId: viewer.id },
      { lead: { assignedAgentId: viewer.id } },
      { contact: { ownerId: viewer.id } },
    ],
  };
}

export function bookingVisibilityWhere(viewer: Viewer): Prisma.BookingWhereInput {
  if (!viewer) return NOTHING_VISIBLE;
  if (canViewAllQuotesAndBookings(viewer.role)) return { contact: { companyId: viewer.companyId } };
  return {
    OR: [
      { quote: { agentId: viewer.id } },
      { lead: { assignedAgentId: viewer.id } },
      { contact: { ownerId: viewer.id } },
    ],
  };
}

// Restricted (non-canViewAllRecords) roles see only tasks they're the
// assignee of. Tasks may hang off a Contact and/or a Lead (both nullable),
// but never carry a companyId of their own — company isolation for the
// canViewAllRecords branch is derived through whichever parent is present,
// falling back to "assigned to me" if somehow neither is (defensive; every
// real Task in this app is created with at least one parent).
// Every user sees sequences they personally created; Admin/Manager see
// every sequence company-wide (Part 12). Sequence has no companyId of its
// own (only a nullable createdById -> Account -> companyId chain) — a
// sequence with no creator on record (createdById null; legacy/orphaned
// data) is included in the company-wide branch rather than hidden from
// every admin everywhere, since there is no company to scope it to and it
// was previously visible to literally everyone with zero restriction at
// all; this is a strict tightening, not a new leak.
/**
 * @param scopeUserId Part 19 — "My Sequences / All Sequences / Specific
 * User", only honored for a company-wide viewer (canManageAllSequences). A
 * restricted viewer always sees only their own regardless of what's passed
 * here. Company-scoped even in the specific-user branch — otherwise an
 * admin could pass another company's userId and see that company's
 * sequences via a matching createdById (IDOR).
 */
export function sequenceVisibilityWhere(viewer: Viewer, scopeUserId?: string): Prisma.SequenceWhereInput {
  if (!viewer) return NOTHING_VISIBLE;
  if (canManageAllSequences(viewer.role)) {
    if (scopeUserId) return { createdById: scopeUserId, createdBy: { companyId: viewer.companyId } };
    return { OR: [{ createdBy: { companyId: viewer.companyId } }, { createdById: null }] };
  }
  return { createdById: viewer.id };
}

// Part 18 — a task's visibility is derived from the LEAD it belongs to, not
// from manual assigneeId — a user is never granted arbitrary task access
// just by being set as the assignee. companyId (when provided) additionally
// confines the match to one company, closing an IDOR where a company-wide
// viewer could pass another company's userId as scopeUserId and see that
// company's tasks via a matching lead.assignedAgentId.
function tasksOwnedByUser(userId: string, companyId?: string): Prisma.TaskWhereInput {
  return {
    OR: [
      { lead: { assignedAgentId: userId, ...(companyId ? { contact: { companyId } } : {}) } },
      // A task with no Lead at all (contact-only) falls back to the
      // contact's own owner — the closest available analog once there's no
      // Lead to derive visibility from.
      { AND: [{ leadId: null }, { contact: { ownerId: userId, ...(companyId ? { companyId } : {}) } }] },
    ],
  };
}

/**
 * @param scopeUserId Only honored for a company-wide viewer (canViewAllRecords)
 * — the "Specific User" / "My Tasks" filter. A restricted viewer always sees
 * only their own lead-owned tasks regardless of what's passed here.
 */
export function taskVisibilityWhere(viewer: Viewer, scopeUserId?: string): Prisma.TaskWhereInput {
  if (!viewer) return NOTHING_VISIBLE;
  if (canViewAllRecords(viewer.role)) {
    if (scopeUserId) return tasksOwnedByUser(scopeUserId, viewer.companyId);
    return {
      OR: [
        { contact: { companyId: viewer.companyId } },
        { lead: { contact: { companyId: viewer.companyId } } },
      ],
    };
  }
  return tasksOwnedByUser(viewer.id);
}
