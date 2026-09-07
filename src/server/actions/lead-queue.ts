"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { logActivity } from "@/server/activity-log";
import { isEligibleForAutoDistribution } from "@/lib/lead-distribution";
import { getQueuePosition } from "@/server/queries/lead-queue";

/** Worker opts into the lead-distribution queue. Idempotent — a worker can
 * only ever have one queue row (accountId is unique), reused across
 * join/leave cycles rather than creating duplicates. `joinedAt` is set only
 * on first-ever creation and never touched again on rejoin — it's the
 * worker's permanent/logical queue position (see
 * getQueuePosition/getAllQueueMembers), so pausing and resuming must never
 * move it.
 *
 * `lastAssignedAt` — which drives actual dispatch order, NOT `joinedAt` —
 * is deliberately left UNTOUCHED here on resume. A paused worker is a
 * "ghost": temporarily excluded from claimNextWorker()'s candidate pool
 * (via isActive), but their queue-fairness history is preserved exactly as
 * it was. Resuming must restore their logical relationship to everyone
 * else, not treat them as having just joined — resetting lastAssignedAt to
 * null here would do exactly that (jump them to the front ahead of anyone
 * with real service history), which is the bug this comment used to
 * describe as the intended behavior. Leaving it alone means: a worker who
 * was mid-rotation when they paused resumes exactly where that history put
 * them, and a worker who had never been served yet (still null) simply
 * remains null, tied with any other never-served member and broken by
 * joinedAt — never an artificial jump to the very front. */
// Ticketing Agent, Flight Expert, and Marketing Agent never receive leads —
// see src/lib/permissions.ts's canViewLeads doc comment. Hiding the queue
// toggle in the topbar (LEAD_QUEUE_HIDDEN_ROLES) is a UX nicety only; this
// is the real enforcement, since a direct call to this action bypasses any
// hidden UI element entirely.
const LEAD_INELIGIBLE_ROLES = ["TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"] as const;

export async function joinLeadQueue() {
  const account = await getCurrentAccount();
  if (!account) return { ok: false as const, error: "No current account" };
  if ((LEAD_INELIGIBLE_ROLES as readonly string[]).includes(account.role)) {
    return { ok: false as const, error: "This role does not receive lead assignments" };
  }

  const entry = await prisma.leadQueueEntry.upsert({
    where: { accountId: account.id },
    create: { accountId: account.id },
    update: { isActive: true },
  });
  const position = await getQueuePosition(entry, account.companyId);

  // Leads may have piled up unassigned while nobody was accepting them —
  // best-effort, non-blocking (mirrors the same pattern already used when
  // a website lead is first created), so becoming available promptly
  // starts working through any backlog rather than waiting for the next
  // cron tick (/api/cron/leads).
  distributePendingWebsiteLeads().catch(() => undefined);

  revalidatePath("/", "layout");
  return { ok: true as const, position };
}

export async function leaveLeadQueue() {
  const account = await getCurrentAccount();
  if (!account) return { ok: false as const, error: "No current account" };

  await prisma.leadQueueEntry.updateMany({
    where: { accountId: account.id },
    data: { isActive: false },
  });
  const entry = await prisma.leadQueueEntry.findUnique({ where: { accountId: account.id } });
  const position = entry ? await getQueuePosition(entry, account.companyId) : null;

  revalidatePath("/", "layout");
  return { ok: true as const, position };
}

type DistributionResult =
  | { offered: true; accountId: string }
  | { offered: false; reason: "no_active_workers" | "already_assigned" | "not_a_website_lead" };

const OFFER_WINDOW_MS = 60_000;

/**
 * Atomically OFFERS one lead to the next eligible worker in the queue —
 * least-recently-served first, joinedAt as the tiebreak for workers who've
 * never been served yet. This does NOT assign the lead; it starts a
 * 60-second acceptance window (see acceptLeadOffer/expireStaleOfferAndAdvance).
 * `lastAssignedAt` is deliberately left untouched here — it only advances
 * once the worker's turn is actually consumed, whether by accepting or by
 * missing the window (see the two functions above).
 *
 * Two protections against the exact race conditions this needs to survive
 * (duplicate delivery, two workers being offered the same lead at once,
 * overlapping cron/poll runs):
 *
 * 1. `FOR UPDATE SKIP LOCKED` row-locks the chosen LeadQueueEntry so a
 *    concurrent call can't pick the same worker — it skips to the
 *    next-best one instead of blocking or double-booking. It also excludes
 *    any worker who already holds a *different* lead's live offer, so
 *    nobody is ever offered two leads at once.
 * 2. The Lead's own offer write is a conditional update (`WHERE
 *    assignedAgentId IS NULL AND (offeredToId IS NULL OR offerExpiresAt <=
 *    now())`) — so even if this function somehow ran twice for the same
 *    lead, only the first call can actually place the offer; the second
 *    sees 0 rows affected and backs off cleanly.
 *
 * A burst of simultaneous calls (more leads landing at once than there are
 * active workers) can make SKIP LOCKED find zero unlocked rows on a given
 * attempt — every candidate is momentarily held by a sibling transaction,
 * not because the queue is actually empty. That's indistinguishable from
 * "no active workers" in a single attempt, so a short retry with backoff
 * below gives those in-flight sibling transactions time to commit and
 * release their lock before this call gives up for real.
 *
 * Pass 22 fix — CONFIRMED CROSS-TENANT VULNERABILITY, now closed: the
 * candidate-worker query below previously had NO companyId filter at all
 * (LeadQueueEntry carries no companyId column of its own — it can only be
 * scoped through its owning Account). A worker at ANY company who stayed
 * active in the queue was eligible to be offered — and, via acceptLeadOffer,
 * to actually claim — a WEBSITE-sourced lead belonging to a completely
 * different company, exposing that company's customer PII (name/phone/
 * email/itinerary) and hijacking their sales lead. This function now
 * resolves the lead's own company (via its Contact) FIRST and filters the
 * candidate query to that company only.
 */
const NO_WORKER_RETRY_ATTEMPTS = 5;
const NO_WORKER_RETRY_DELAY_MS = 15;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function offerLeadToNextWorker(leadId: string): Promise<DistributionResult> {
  return prisma.$transaction(async (tx) => {
    const now = new Date();

    // Pass 22 fix — resolve the lead's OWN company before picking a
    // candidate worker. This is the fix for the confirmed cross-tenant
    // vulnerability described in this function's own doc comment above:
    // the candidate query below must never be allowed to match a worker
    // outside this exact company. Lead has no direct companyId column —
    // company is only ever known through its Contact (the same pattern
    // used everywhere else in this app that scopes a Lead by company).
    const lead = await tx.lead.findUnique({ where: { id: leadId }, select: { contact: { select: { companyId: true } } } });
    const companyId = lead?.contact.companyId;
    if (!companyId) return { offered: false as const, reason: "no_active_workers" as const };

    // Defense-in-depth beyond "they can never join" (joinLeadQueue rejects
    // TICKETING_AGENT/FLIGHT_EXPERT server-side): also excluded here at the
    // actual offer query, so a stale/pre-existing queue row for one of
    // these roles (e.g. from before this restriction existed, or a role
    // change after joining) can never be selected either. Same reasoning
    // for a."status" = 'ACTIVE' — setAccountStatus() already deactivates a
    // removed account's own LeadQueueEntry.isActive on removal (see
    // accounts.ts), but this is a second, independent check against the
    // Account row itself so a removed user can never receive a lead even
    // if their queue row were ever left stale. The NOT EXISTS clause keeps
    // a worker who's mid-countdown on a different lead from being offered
    // a second one simultaneously — one live offer per worker at a time.
    // a."companyId" = ${companyId} is the actual fix — see this function's
    // doc comment for the vulnerability this closes.
    const rows = await tx.$queryRaw<Array<{ id: string; accountId: string }>>`
      SELECT lqe."id", lqe."accountId" FROM "LeadQueueEntry" lqe
      JOIN "Account" a ON a."id" = lqe."accountId"
      WHERE lqe."isActive" = true AND a."status" = 'ACTIVE' AND a."companyId" = ${companyId}
        AND a."role" NOT IN ('TICKETING_AGENT', 'FLIGHT_EXPERT', 'MARKETING_AGENT')
        AND NOT EXISTS (
          SELECT 1 FROM "Lead" l
          WHERE l."offeredToId" = lqe."accountId" AND l."id" != ${leadId} AND l."offerExpiresAt" > ${now}
        )
      ORDER BY lqe."lastAssignedAt" ASC NULLS FIRST, lqe."joinedAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    const worker = rows[0];
    if (!worker) return { offered: false as const, reason: "no_active_workers" as const };

    const claimed = await tx.lead.updateMany({
      where: {
        id: leadId,
        assignedAgentId: null,
        OR: [{ offeredToId: null }, { offerExpiresAt: { lte: now } }],
      },
      data: { offeredToId: worker.accountId, offeredAt: now, offerExpiresAt: new Date(now.getTime() + OFFER_WINDOW_MS) },
    });
    if (claimed.count === 0) return { offered: false as const, reason: "already_assigned" as const };

    return { offered: true as const, accountId: worker.accountId };
  });
}

/**
 * The offered worker clicks Accept. A single atomic conditional update is
 * the entire race-safety mechanism against a near-simultaneous timeout: it
 * only succeeds `WHERE assignedAgentId IS NULL AND offeredToId = <me> AND
 * offerExpiresAt > now()`, the exact same kind of guard expireStaleOfferAndAdvance
 * uses in the opposite direction — whichever write's WHERE clause still
 * matches wins, the other sees 0 rows and backs off cleanly.
 */
export async function acceptLeadOffer(leadId: string) {
  const account = await getCurrentAccount();
  if (!account) return { ok: false as const, error: "No current account" };

  // Captured before the conditional update so LeadStatusHistory records the
  // real prior status — always ATTEMPTING_TO_CONTACT in practice today
  // (every lead this function can ever apply to came from createLead's
  // default, since isEligibleForAutoDistribution requires it never went
  // through the queue before), but fetched rather than assumed. contactId
  // is fetched here too — needed for the Contact-ownership claim below.
  const before = await prisma.lead.findUnique({ where: { id: leadId }, select: { status: true, contactId: true } });
  if (!before) return { ok: false as const, error: "Lead not found" };

  const now = new Date();
  // A fresh website lead accepted through the queue always becomes NEW —
  // distinct from ACCEPTED, which reassignLead uses for manual
  // reassignment, and distinct from ATTEMPTING_TO_CONTACT, the default for
  // every other lead-creation path. See the LeadStatus enum's doc comments.
  const claimed = await prisma.lead.updateMany({
    where: { id: leadId, assignedAgentId: null, offeredToId: account.id, offerExpiresAt: { gt: now } },
    data: { assignedAgentId: account.id, queueDistributedAt: now, offeredToId: null, offeredAt: null, offerExpiresAt: null, status: "NEW" },
  });
  if (claimed.count === 0) {
    return { ok: false as const, error: "This offer is no longer available" };
  }

  // Pass 30 — real bug found and fixed: this function previously never
  // touched Contact.ownerId at all. lead-capture's own route (the public
  // website endpoint) HAS a block that looks like it handles "first
  // Lead for a brand-new Contact -> assign the Contact too"
  // (`if (isNewContact && assignedAgentId) { ...contact.update... }`), but
  // that condition is structurally always false there — `assignedAgentId`
  // is only ever set when `isNewContact` is false (an EXISTING owned
  // contact, assigned immediately, never entering the queue at all — see
  // that route's own branching). So for the actual queue-distribution
  // path — the one this whole system exists for — a first-time website
  // Contact stayed permanently ownerless even after an agent successfully
  // accepted their Lead. Real, material impact: contactVisibilityWhere
  // (src/server/visibility.ts) scopes a restricted role's OWN Contacts
  // list strictly by `ownerId`, never by whether they hold the Lead — so
  // the accepting agent could never see this customer's Contact record in
  // their own Contacts page at all, despite actively owning and working
  // the Lead.
  //
  // Fixed here, the one real place "a Lead was just successfully
  // assigned" is authoritatively known: a conditional claim, exactly the
  // same atomic-claim-before-side-effect shape as the Lead claim just
  // above — `WHERE id = contactId AND ownerId IS NULL`. This is
  // deliberately a "fill in ownership only if there was none" claim, NEVER
  // an overwrite: an existing Contact that already has a real owner (the
  // establish "do not silently transfer existing Contact ownership" rule)
  // is completely untouched, matching this function's own pre-existing
  // guarantee for the Lead itself. Safe under concurrency the same way —
  // if two of this same Contact's separate Leads were independently
  // accepted by two different agents at nearly the same moment, whichever
  // claim's UPDATE commits first wins the Contact; the second matches 0
  // rows and silently no-ops rather than corrupting ownership.
  await prisma.contact.updateMany({
    where: { id: before.contactId, ownerId: null },
    data: { ownerId: account.id },
  });

  await Promise.all([
    prisma.leadQueueEntry.updateMany({
      where: { accountId: account.id },
      data: { lastAssignedAt: now, leadsAssignedCount: { increment: 1 } },
    }),
    prisma.leadStatusHistory.create({
      data: { leadId, fromStatus: before.status, toStatus: "NEW", changedById: account.id },
    }),
  ]);

  const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { contact: true } });
  // Activity History (Pass 5) — this is the ONE genuine "received from the
  // queue" moment in the whole distribution system: distributeNewWebsiteLead
  // only OFFERS a lead (sets offeredToId/offerExpiresAt); nothing is
  // actually assigned until the worker explicitly accepts here. actorId is
  // deliberately the accepting worker (not null/"System") — they are the
  // real actor of "I received this lead", even though the OFFER itself was
  // algorithmic. Queue position is best-effort: computing it can never
  // block or fail the actual acceptance (the lead is already reassigned by
  // this point regardless of whether this lookup succeeds).
  const queueEntry = await prisma.leadQueueEntry.findUnique({ where: { accountId: account.id }, select: { joinedAt: true } });
  const position = queueEntry ? await getQueuePosition(queueEntry, account.companyId) : null;
  await Promise.all([
    prisma.notification.create({
      data: {
        accountId: account.id,
        leadId,
        type: "LEAD_ASSIGNED",
        title: lead?.contact ? `New lead: ${lead.contact.firstName} ${lead.contact.lastName}` : "New lead assigned to you",
        body: "Assigned automatically from the lead queue.",
      },
    }),
    logActivity({
      leadId,
      actorId: account.id,
      type: "LEAD_RECEIVED_FROM_QUEUE",
      description: `${account.fullName} received this lead from the queue`,
      metadata: { source: "Lead Queue", queuePosition: position },
    }),
  ]);

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/dashboard");
  return { ok: true as const };
}

/**
 * Shared core for "this worker's turn on this offer is over, without them
 * accepting it" — used identically whether that happens because the 60s
 * window ran out (sweepExpiredOffers, requireExpired: true) or because the
 * worker explicitly clicked Skip (skipLeadOffer, requireExpired: false).
 * Either way: move the worker to the back of the rotation AND auto-pause
 * them (isActive: false) — a missed/skipped offer removes them from the
 * active queue entirely (shown as "Paused"/ghost) until they explicitly
 * resume, rather than merely deferring their next turn. This is a
 * deliberate policy: missing the window means a lost opportunity, and the
 * queue should not keep offering leads to someone who isn't actually
 * responding. Bumping lastAssignedAt (without incrementing
 * leadsAssignedCount, since they weren't actually given a lead) is enough
 * to achieve "moved to the end" once they resume — it's the exact field
 * that already drives the least-recently-served rotation, so no separate
 * flag is needed for ordering.
 *
 * The conditional update mirrors acceptLeadOffer's race guard in the
 * opposite direction — see that function's comment for how the two resolve
 * a near-simultaneous accept-vs-release race (whichever write's WHERE
 * clause still matches wins; the loser sees 0 rows and backs off cleanly).
 */
async function releaseOfferAndAdvance(leadId: string, offeredToId: string, requireExpired: boolean): Promise<boolean> {
  const now = new Date();
  const released = await prisma.lead.updateMany({
    where: requireExpired
      ? { id: leadId, assignedAgentId: null, offeredToId, offerExpiresAt: { lte: now } }
      : { id: leadId, assignedAgentId: null, offeredToId },
    data: { offeredToId: null, offeredAt: null, offerExpiresAt: null },
  });
  if (released.count === 0) return false; // someone else already resolved this offer (accepted, expired, or skipped elsewhere)

  await prisma.leadQueueEntry.updateMany({
    where: { accountId: offeredToId },
    data: { lastAssignedAt: now, isActive: false },
  });

  await offerLeadToNextWorker(leadId);
  return true;
}

async function expireStaleOfferAndAdvance(leadId: string, offeredToId: string): Promise<void> {
  await releaseOfferAndAdvance(leadId, offeredToId, true);
}

/**
 * The offered worker explicitly declines — same queue consequence as
 * missing the countdown (moved to the back of rotation, next eligible
 * worker gets a fresh 60s offer for the same lead), just triggered by a
 * click instead of the clock. Works regardless of remaining time (a skip
 * is a skip whether there's 45 seconds left or 1), but only for the
 * account that actually currently holds this offer — the same
 * conditional-update race safety as everywhere else in this file.
 */
export async function skipLeadOffer(leadId: string) {
  const account = await getCurrentAccount();
  if (!account) return { ok: false as const, error: "No current account" };

  const released = await releaseOfferAndAdvance(leadId, account.id, false);
  if (!released) {
    return { ok: false as const, error: "This offer is no longer active" };
  }
  return { ok: true as const };
}

/**
 * Lazy, reactive expiry sweep — there's no reliable periodic scheduler for
 * this in the current deployment (/api/cron/leads has no Vercel cron
 * trigger wired up), so expired offers are caught opportunistically by
 * whatever CRM activity happens to run next: every getMyLeadOffer() poll
 * (from any logged-in user's browser, via the centered lead-offer modal)
 * and every new lead's distribution call both trigger this first.
 */
async function sweepExpiredOffers(): Promise<void> {
  const stale = await prisma.lead.findMany({
    where: { assignedAgentId: null, offeredToId: { not: null }, offerExpiresAt: { lte: new Date() } },
    select: { id: true, offeredToId: true },
    take: MAX_LEADS_PER_RUN,
  });
  for (const lead of stale) {
    if (lead.offeredToId) await expireStaleOfferAndAdvance(lead.id, lead.offeredToId);
  }
}

/** The current account's own live offer, if any — polled by the centered
 * lead-offer modal. Sweeps expired offers first so a stale one is never
 * shown as still live. */
export async function getMyLeadOffer() {
  const account = await getCurrentAccount();
  if (!account) return null;

  await sweepExpiredOffers();

  const lead = await prisma.lead.findFirst({
    where: { offeredToId: account.id, assignedAgentId: null, offerExpiresAt: { gt: new Date() } },
    include: { contact: true, departureAirport: true, arrivalAirport: true },
  });
  if (!lead) return null;

  return {
    leadId: lead.id,
    contactName: lead.contact ? `${lead.contact.firstName} ${lead.contact.lastName}` : "Unknown contact",
    email: lead.contact?.primaryEmail ?? null,
    phone: lead.contact?.primaryPhone ?? null,
    source: lead.source,
    route: lead.departureAirport && lead.arrivalAirport ? `${lead.departureAirport.iata} → ${lead.arrivalAirport.iata}` : null,
    offerExpiresAt: lead.offerExpiresAt!.toISOString(),
  };
}

export async function distributeNewWebsiteLead(leadId: string): Promise<DistributionResult> {
  await sweepExpiredOffers();

  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { source: true, assignedAgentId: true, queueDistributedAt: true } });
  if (!lead || !isEligibleForAutoDistribution(lead)) {
    return { offered: false, reason: lead?.assignedAgentId ? "already_assigned" : "not_a_website_lead" };
  }

  let result: DistributionResult = { offered: false, reason: "no_active_workers" };
  for (let attempt = 0; attempt < NO_WORKER_RETRY_ATTEMPTS; attempt++) {
    result = await offerLeadToNextWorker(leadId);
    if (result.offered || result.reason !== "no_active_workers") break;
    if (attempt < NO_WORKER_RETRY_ATTEMPTS - 1) await sleep(NO_WORKER_RETRY_DELAY_MS * (attempt + 1));
  }

  return result;
}

const MAX_LEADS_PER_RUN = 50;

/**
 * Extension point for a real scheduler — see /api/cron/leads. Also called
 * directly (best-effort, non-blocking) right after a website lead is
 * created, so distribution isn't purely dependent on a cron delay. Scans
 * leads that are website-sourced, unassigned, and have never been through
 * the queue before (queueDistributedAt is the guard against re-grabbing a
 * lead someone manually unassigned later) — waiting leads are never dropped
 * or expired by age, so a lead captured days ago is scanned and offered
 * exactly the same as one captured a moment ago, oldest first.
 */
export async function distributePendingWebsiteLeads() {
  const pending = await prisma.lead.findMany({
    where: { source: "WEBSITE", assignedAgentId: null, queueDistributedAt: null, offeredToId: null },
    orderBy: { createdAt: "asc" },
    take: MAX_LEADS_PER_RUN,
    select: { id: true },
  });

  let distributed = 0;
  for (const lead of pending) {
    const result = await distributeNewWebsiteLead(lead.id);
    if (result.offered) {
      distributed++;
    } else if (result.reason === "no_active_workers") {
      break; // nobody to give the rest to right now either
    }
  }

  return { scanned: pending.length, distributed };
}
