import { prisma } from "@/lib/prisma";
import { IN_FLIGHT_PREFIX, UNCERTAIN_PREFIX } from "@/lib/sequence-delivery";

// The sending allowance of ONE Gmail mailbox, shared by everything that sends automated mail from it (sequence steps and marketing campaigns - they are one Google
// allowance, see docs/COMPASS_CAMPAIGN_SENDING_CAPACITY.md). The limits are the CRM's own configured policy, not Google's numbers, and Gmail's own "slow down" answer
// (GmailConnection.sendBlockedUntil, recorded by sendViaGmail) always wins over them. The count is a ROLLING window, never "since midnight": nothing here assumes when
// Google resets anything - capacity simply frees up as the oldest counted messages age out of the window.

export function intEnv(name: string, fallback: number, min = 1, max = 100_000): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= min ? Math.min(Math.trunc(v), max) : fallback;
}

/** Rolling-24h cap per sending account, all automated mail together. Default 400: below the ~500/day a standard Gmail account is allowed. */
export const dailyLimit = () => intEnv("CAMPAIGN_DAILY_LIMIT", 400, 1, 100_000);
/** Sequence emails one mailbox may start per minute. Default 20 - comfortably below Gmail's burst limits; raise only for a mailbox whose provider limit is higher. */
export const sequenceSendsPerMinute = () => intEnv("SEQUENCE_SENDS_PER_MINUTE", 20, 1, 600);

export const DAY_MS = 24 * 60 * 60 * 1000;
/** How long to hold a mailbox's sending after Gmail said "slow down" when Gmail gave no usable time: long enough to clear a per-minute burst limit, short enough that a daily limit is re-probed. */
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
const MINUTE_WINDOW_MS = 55_000;

/** The slice of the Prisma client the quota reads, so the same function runs inside a transaction (under the sender's lock) or outside one (a cheap pre-check). */
type Db = {
  sequenceStepLog: Pick<typeof prisma.sequenceStepLog, "count">;
  marketingCampaignSend: Pick<typeof prisma.marketingCampaignSend, "count">;
  gmailConnection: Pick<typeof prisma.gmailConnection, "findUnique">;
};

/** Sequence emails this mailbox sent, or may have sent (write-ahead / unconfirmed), since `since`. */
export function countSequenceSends(db: Pick<Db, "sequenceStepLog">, senderId: string, since: Date): Promise<number> {
  return db.sequenceStepLog.count({
    where: {
      senderAccountId: senderId,
      OR: [
        { status: "SENT", sentAt: { gte: since } },
        { status: "FAILED", createdAt: { gte: since }, OR: [{ error: { startsWith: IN_FLIGHT_PREFIX } }, { error: { startsWith: UNCERTAIN_PREFIX } }] },
      ],
    },
  });
}

/** Campaign emails this mailbox's campaigns sent, or may have sent, since `since` (exactly how the campaign worker counts them). */
export function countCampaignSends(db: Pick<Db, "marketingCampaignSend">, senderId: string, since: Date): Promise<number> {
  return db.marketingCampaignSend.count({
    where: { OR: [{ status: "SENT", sentAt: { gte: since } }, { status: "UNKNOWN", lastAttemptAt: { gte: since } }], campaign: { createdById: senderId } },
  });
}

export type CapacityVerdict =
  | { ok: true }
  | { ok: false; reason: "PROVIDER_BACKOFF"; until: Date }
  | { ok: false; reason: "CAPACITY"; /** the per-minute budget (resets within a minute) or the rolling-24h cap */ window: "minute" | "day" };

/**
 * Can this mailbox start one more automated email right now? Reads only; the CALLER makes the answer binding by calling this inside a transaction that holds the
 * sender's advisory lock and creating the write-ahead marker in the same transaction (so no number of workers can overshoot).
 */
export async function checkSenderCapacity(db: Db, senderId: string, now: Date): Promise<CapacityVerdict> {
  const connection = await db.gmailConnection.findUnique({ where: { accountId: senderId }, select: { sendBlockedUntil: true } });
  const blockedUntil = connection?.sendBlockedUntil ?? null;
  if (blockedUntil && blockedUntil.getTime() > now.getTime()) return { ok: false, reason: "PROVIDER_BACKOFF", until: blockedUntil };

  const lastMinute = await db.sequenceStepLog.count({ where: { senderAccountId: senderId, createdAt: { gte: new Date(now.getTime() - MINUTE_WINDOW_MS) } } });
  if (lastMinute >= sequenceSendsPerMinute()) return { ok: false, reason: "CAPACITY", window: "minute" };

  const dayAgo = new Date(now.getTime() - DAY_MS);
  const used = (await countSequenceSends(db, senderId, dayAgo)) + (await countCampaignSends(db, senderId, dayAgo));
  if (used >= dailyLimit()) return { ok: false, reason: "CAPACITY", window: "day" };
  return { ok: true };
}

/** The advisory-lock key every automated sender of one mailbox takes (campaigns use the same one), so their counts are serialised together. */
export const senderLockKey = (senderId: string) => `campaign-send-quota:${senderId}`;
