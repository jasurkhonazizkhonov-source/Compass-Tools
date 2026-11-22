import { prisma } from "@/lib/prisma";
import type { MarketingSendStatus, Prisma } from "@/generated/prisma/client";
import { resolvePageSize } from "@/lib/pagination";
import { dailyLimit } from "@/server/marketing/campaign-worker";

// The recipient-level "Delivery Status" list of one campaign, read page by page on the server (25 / 50 / 75 / 100 rows): a campaign with hundreds of thousands of recipients is never
// loaded into the page. Recipients are shown GROUPED in a fixed order and each group is ordered inside itself:
//   Sent -> Scheduled -> Waiting -> Outcome unknown -> Failed -> Skipped (unsubscribed) -> Skipped (suppressed) -> Cancelled
// "Sent" means the mail provider (Gmail) ACCEPTED the message - not that it reached an inbox. An ambiguous answer is "Outcome unknown", never "Sent".
//
// The groups are not stored: they are derived from the stored status plus facts the worker already keeps (the campaign's status, a recipient's retry time, the sender's rolling-24h count).
// Nothing here writes anything, and nothing invents a time: a time is shown only where one is actually recorded or can be computed from the worker's own rule.

export type RecipientGroup = "SENT" | "SCHEDULED" | "WAITING" | "UNKNOWN" | "FAILED" | "SKIPPED_UNSUBSCRIBED" | "SKIPPED_SUPPRESSED" | "CANCELLED";

/** The display order of the groups. */
export const RECIPIENT_GROUP_ORDER: readonly RecipientGroup[] = ["SENT", "SCHEDULED", "WAITING", "UNKNOWN", "FAILED", "SKIPPED_UNSUBSCRIBED", "SKIPPED_SUPPRESSED", "CANCELLED"];

export const RECIPIENT_GROUP_LABEL: Record<RecipientGroup, string> = {
  SENT: "Sent",
  SCHEDULED: "Scheduled",
  WAITING: "Waiting",
  UNKNOWN: "Outcome unknown",
  FAILED: "Failed",
  SKIPPED_UNSUBSCRIBED: "Skipped: unsubscribed",
  SKIPPED_SUPPRESSED: "Skipped: suppressed",
  CANCELLED: "Cancelled",
};

/** Campaign states in which a recipient that has not been sent yet can still be cancelled on its own. */
export const RECIPIENT_CANCELLABLE_CAMPAIGN_STATES: readonly string[] = ["QUEUED", "SENDING", "PAUSED"];

export type Segment = {
  group: RecipientGroup;
  count: number;
  where: Prisma.MarketingCampaignSendWhereInput;
  orderBy: Prisma.MarketingCampaignSendOrderByWithRelationInput[];
};

export type SegmentInput = {
  campaignStatus: string;
  counts: Partial<Record<MarketingSendStatus, number>>;
  /** PENDING recipients whose own retry time is still in the future (a backoff after a failed or rate-limited attempt). */
  pendingBackoff: number;
  /** The sending Gmail account has used its rolling-24h allowance: every unsent recipient is deferred until capacity frees up. */
  dailyLimitReached: boolean;
  now: Date;
};

/**
 * Which groups exist, how many recipients each holds, and the database filter that selects exactly them. Pure. The filters are disjoint and together cover every recipient, so the
 * counts add up to the audience and a page can be cut from them with plain offsets.
 */
export function planSegments({ campaignStatus, counts, pendingBackoff, dailyLimitReached, now }: SegmentInput): Segment[] {
  const n = (s: MarketingSendStatus) => counts[s] ?? 0;
  const pending = n("PENDING");
  const out: Segment[] = [];
  const add = (group: RecipientGroup, count: number, where: Prisma.MarketingCampaignSendWhereInput, orderBy: Segment["orderBy"]) => {
    if (count > 0) out.push({ group, count, where, orderBy });
  };
  const byId: Segment["orderBy"] = [{ id: "asc" }];

  let scheduled = 0;
  let waiting = 0;
  let scheduledWhere: Prisma.MarketingCampaignSendWhereInput = { status: "PENDING" };
  let waitingWhere: Prisma.MarketingCampaignSendWhereInput = { status: "PENDING" };
  let cancelledViaCampaign = 0;

  if (campaignStatus === "CANCELLED") {
    cancelledViaCampaign = pending; // the campaign was cancelled: what it had not sent will never be sent
  } else if (campaignStatus === "PAUSED") {
    waiting = pending; // paused: nothing moves until it is resumed
  } else if (dailyLimitReached) {
    scheduled = pending; // every unsent recipient is deferred by the daily allowance
  } else {
    scheduled = Math.min(pendingBackoff, pending);
    waiting = pending - scheduled;
    scheduledWhere = { status: "PENDING", nextAttemptAt: { gt: now } };
    waitingWhere = { status: "PENDING", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] };
  }

  add("SENT", n("SENT"), { status: "SENT" }, [{ sentAt: "desc" }, { id: "asc" }]);
  add("SCHEDULED", scheduled, scheduledWhere, [{ nextAttemptAt: { sort: "asc", nulls: "last" } }, { id: "asc" }]);
  add("WAITING", waiting, waitingWhere, byId);
  add("UNKNOWN", n("UNKNOWN"), { status: "UNKNOWN" }, byId);
  add("FAILED", n("FAILED"), { status: "FAILED" }, byId);
  add("SKIPPED_UNSUBSCRIBED", n("SKIPPED_UNSUBSCRIBED"), { status: "SKIPPED_UNSUBSCRIBED" }, byId);
  add("SKIPPED_SUPPRESSED", n("SKIPPED_SUPPRESSED"), { status: "SKIPPED_SUPPRESSED" }, byId);
  add("CANCELLED", n("CANCELLED") + cancelledViaCampaign, cancelledViaCampaign > 0 ? { OR: [{ status: "CANCELLED" }, { status: "PENDING" }] } : { status: "CANCELLED" }, byId);
  return out;
}

export type SegmentSlice = { segment: Segment; skip: number; take: number };

/** Cuts one page out of the ordered segments: the slices to fetch (usually one, two across a group boundary) and the total number of recipients. Pure. */
export function sliceSegments(segments: Segment[], page: number, pageSize: number): { slices: SegmentSlice[]; total: number; pageCount: number; page: number } {
  const total = segments.reduce((sum, s) => sum + s.count, 0);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);
  let offset = (safePage - 1) * pageSize;
  let remaining = pageSize;
  const slices: SegmentSlice[] = [];
  for (const segment of segments) {
    if (remaining <= 0) break;
    if (offset >= segment.count) {
      offset -= segment.count;
      continue;
    }
    const take = Math.min(segment.count - offset, remaining);
    slices.push({ segment, skip: offset, take });
    remaining -= take;
    offset = 0;
  }
  return { slices, total, pageCount, page: safePage };
}

export type RecipientRow = {
  id: string;
  email: string;
  group: RecipientGroup;
  label: string;
  /** The time that belongs to the status, only when one is recorded or computable. */
  at: Date | null;
  /** What `at` is: when it was sent, when the next attempt is due, or the earliest moment capacity frees up. */
  atKind: "sent" | "next" | "earliest" | null;
  /** Why it is in this state, in plain words (only for states that need one). */
  reason: string | null;
  /** True only while the message has not been sent and the worker has not started on it. The server re-checks this on every cancellation. */
  canCancel: boolean;
};

type RowFacts = { id: string; status: MarketingSendStatus; sentAt: Date | null; nextAttemptAt: Date | null; errorMessage: string | null; subscriber: { email: string } };
export type RowContext = { campaignStatus: string; dailyLimitReached: boolean; capacityFreesAt: Date | null; limit: number; now: Date };

/** The display facts of one recipient. Pure. */
export function describeRecipient(row: RowFacts, ctx: RowContext): RecipientRow {
  const base = { id: row.id, email: row.subscriber.email, at: null as Date | null, atKind: null as RecipientRow["atKind"], reason: null as string | null, canCancel: false };
  const cancellable = row.status === "PENDING" && RECIPIENT_CANCELLABLE_CAMPAIGN_STATES.includes(ctx.campaignStatus);
  switch (row.status) {
    case "SENT":
      return { ...base, group: "SENT", label: RECIPIENT_GROUP_LABEL.SENT, at: row.sentAt, atKind: row.sentAt ? "sent" : null };
    case "UNKNOWN":
      return { ...base, group: "UNKNOWN", label: RECIPIENT_GROUP_LABEL.UNKNOWN, reason: row.errorMessage ?? "No answer from Gmail. It is not sent again automatically." };
    case "FAILED":
      return { ...base, group: "FAILED", label: RECIPIENT_GROUP_LABEL.FAILED, reason: row.errorMessage ?? "Sending failed" };
    case "SKIPPED_UNSUBSCRIBED":
      return { ...base, group: "SKIPPED_UNSUBSCRIBED", label: RECIPIENT_GROUP_LABEL.SKIPPED_UNSUBSCRIBED, reason: "Unsubscribed before their turn" };
    case "SKIPPED_SUPPRESSED":
      return { ...base, group: "SKIPPED_SUPPRESSED", label: RECIPIENT_GROUP_LABEL.SKIPPED_SUPPRESSED, reason: "Suppressed before their turn" };
    case "CANCELLED":
      return { ...base, group: "CANCELLED", label: RECIPIENT_GROUP_LABEL.CANCELLED, reason: row.errorMessage ?? "Cancelled before it was sent" };
    default: {
      // PENDING
      if (ctx.campaignStatus === "CANCELLED") return { ...base, group: "CANCELLED", label: RECIPIENT_GROUP_LABEL.CANCELLED, reason: "The campaign was cancelled before this message was sent" };
      if (ctx.campaignStatus === "PAUSED") return { ...base, group: "WAITING", label: RECIPIENT_GROUP_LABEL.WAITING, reason: "The campaign is paused", canCancel: cancellable };
      const backoff = row.nextAttemptAt !== null && row.nextAttemptAt.getTime() > ctx.now.getTime();
      if (ctx.dailyLimitReached) {
        // A recipient waiting out its own retry keeps its own reason and time; everyone else is deferred by the daily allowance.
        if (backoff) return { ...base, group: "SCHEDULED", label: RECIPIENT_GROUP_LABEL.SCHEDULED, at: row.nextAttemptAt, atKind: "next", reason: row.errorMessage ?? "Retry scheduled", canCancel: cancellable };
        return {
          ...base,
          group: "SCHEDULED",
          label: RECIPIENT_GROUP_LABEL.SCHEDULED,
          at: ctx.capacityFreesAt,
          atKind: ctx.capacityFreesAt ? "earliest" : null,
          reason: `Daily sending limit reached (${ctx.limit} per 24 hours from the sending Gmail account). Sending continues automatically when capacity frees up.`,
          canCancel: cancellable,
        };
      }
      if (backoff) return { ...base, group: "SCHEDULED", label: RECIPIENT_GROUP_LABEL.SCHEDULED, at: row.nextAttemptAt, atKind: "next", reason: row.errorMessage ?? "Retry scheduled", canCancel: cancellable };
      return { ...base, group: "WAITING", label: RECIPIENT_GROUP_LABEL.WAITING, reason: "In the sending queue", canCancel: cancellable };
    }
  }
}

export type RecipientPage = {
  campaignStatus: string;
  scheduledAt: Date | null;
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /** Per group, for the summary line (only groups that have recipients). */
  groupCounts: Array<{ group: RecipientGroup; label: string; count: number }>;
  rows: RecipientRow[];
  dailyLimitReached: boolean;
};

/**
 * One page of a campaign's recipients, or null when the campaign does not exist in this company. Reads only: counts per status (one grouped query on the indexed
 * campaign/status pair), at most two slices of at most `pageSize` rows, and - only while a campaign is sending with recipients still unsent - the sender's rolling-24h count, exactly as
 * the worker counts it (claimWithinQuota: SENT plus uncertain UNKNOWN attempts in the last 24 hours, across all of that sender's campaigns).
 */
export async function getCampaignRecipientPage(params: { campaignId: string; companyId: string; page?: number; pageSize?: number | string; now?: Date }): Promise<RecipientPage | null> {
  const now = params.now ?? new Date();
  const pageSize = resolvePageSize(params.pageSize);
  const campaign = await prisma.marketingCampaign.findFirst({ where: { id: params.campaignId, companyId: params.companyId }, select: { id: true, status: true, scheduledAt: true, createdById: true } });
  if (!campaign) return null;

  const groups = await prisma.marketingCampaignSend.groupBy({ by: ["status"], where: { campaignId: campaign.id }, _count: { _all: true } });
  const counts = Object.fromEntries(groups.map((g) => [g.status, g._count._all])) as Partial<Record<MarketingSendStatus, number>>;
  const pending = counts.PENDING ?? 0;
  const sending = campaign.status === "QUEUED" || campaign.status === "SENDING";

  let pendingBackoff = 0;
  let dailyLimitReached = false;
  let capacityFreesAt: Date | null = null;
  const limit = dailyLimit();
  if (sending && pending > 0) {
    pendingBackoff = await prisma.marketingCampaignSend.count({ where: { campaignId: campaign.id, status: "PENDING", nextAttemptAt: { gt: now } } });
    if (campaign.createdById) {
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const sender = { campaign: { createdById: campaign.createdById } };
      const [sentInWindow, unknownInWindow] = await Promise.all([
        prisma.marketingCampaignSend.count({ where: { status: "SENT", sentAt: { gte: dayAgo }, ...sender } }),
        prisma.marketingCampaignSend.count({ where: { status: "UNKNOWN", lastAttemptAt: { gte: dayAgo }, ...sender } }),
      ]);
      dailyLimitReached = sentInWindow + unknownInWindow >= limit;
      if (dailyLimitReached) {
        // Capacity frees as the oldest counted attempt leaves the rolling 24 hours: that moment is the EARLIEST the next message can go (one slot at a time).
        const [oldestSent, oldestUnknown] = await Promise.all([
          prisma.marketingCampaignSend.findFirst({ where: { status: "SENT", sentAt: { gte: dayAgo }, ...sender }, orderBy: { sentAt: "asc" }, select: { sentAt: true } }),
          prisma.marketingCampaignSend.findFirst({ where: { status: "UNKNOWN", lastAttemptAt: { gte: dayAgo }, ...sender }, orderBy: { lastAttemptAt: "asc" }, select: { lastAttemptAt: true } }),
        ]);
        const times = [oldestSent?.sentAt, oldestUnknown?.lastAttemptAt].filter((t): t is Date => !!t).map((t) => t.getTime());
        if (times.length > 0) capacityFreesAt = new Date(Math.min(...times) + 24 * 60 * 60 * 1000);
      }
    }
  }

  const segments = planSegments({ campaignStatus: campaign.status, counts, pendingBackoff, dailyLimitReached, now });
  const { slices, total, pageCount, page } = sliceSegments(segments, params.page ?? 1, pageSize);

  const ctx: RowContext = { campaignStatus: campaign.status, dailyLimitReached, capacityFreesAt, limit, now };
  const rows: RecipientRow[] = [];
  for (const { segment, skip, take } of slices) {
    const found = await prisma.marketingCampaignSend.findMany({
      where: { campaignId: campaign.id, ...segment.where },
      orderBy: segment.orderBy,
      skip,
      take,
      select: { id: true, status: true, sentAt: true, nextAttemptAt: true, errorMessage: true, subscriber: { select: { email: true } } },
    });
    for (const r of found) rows.push(describeRecipient(r, ctx));
  }

  return {
    campaignStatus: campaign.status,
    scheduledAt: campaign.scheduledAt,
    total,
    page,
    pageSize,
    pageCount,
    groupCounts: segments.map((s) => ({ group: s.group, label: RECIPIENT_GROUP_LABEL[s.group], count: s.count })),
    rows,
    dailyLimitReached,
  };
}
