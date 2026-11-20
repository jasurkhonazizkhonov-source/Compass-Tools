// Durable marketing-campaign delivery. A campaign is never sent inside a request: queueing records the intent, and this worker (run by the in-process poller every
// minute) does the work in small, rate-limited batches that survive a restart.
//
//   DRAFT --queue--> QUEUED | SCHEDULED --due--> QUEUED --first batch--> SENDING --nothing left--> SENT
//                         any of QUEUED/SCHEDULED/SENDING --pause--> PAUSED --resume--> QUEUED ;  any non-final --cancel--> CANCELLED
//
// Guarantees
//   * One row per (campaign, subscriber) - @@unique([campaignId, subscriberId]) - so a recipient can never be created twice, whatever runs concurrently.
//   * Write-ahead: before a message leaves, its row is atomically moved PENDING -> UNKNOWN (compare-and-swap). A crash after that point leaves UNKNOWN, which is
//     never sent again automatically: an uncertain outcome is shown as such and left to a person, never silently re-sent.
//   * A definite failure is retried with exponential backoff up to MAX_ATTEMPTS, then FAILED. A "no answer" (timeout / 5xx - the provider may have sent it) becomes UNKNOWN.
//   * Suppression is checked at SEND time against the subscriber's current status, so someone who unsubscribed after the audience was fixed is skipped.
//   * Provider limits are respected, not hidden: a per-minute budget and a rolling-24h cap per sending account (CAMPAIGN_SENDS_PER_MINUTE, CAMPAIGN_DAILY_LIMIT).
//     Hitting a provider limit backs the row off and stops the batch; it is never counted as a failure.
//   * A sender whose Gmail is disconnected pauses the campaign (nothing is lost, nothing is marked failed); fixing the connection and resuming continues it.
import { prisma } from "@/lib/prisma";
import { safeErrorTag } from "@/lib/safe-error-log";
import { sendEmail } from "@/server/email/service";
import { buildMarketingCampaignEmail } from "@/server/email/templates";
import { getCompanyForAccountId } from "@/server/queries/company";
import { resolveBaseUrl } from "@/lib/company-config";
import { personalizeHtml, personalizeText } from "@/lib/campaign-blocks";

export const MAX_ATTEMPTS = 3;
export const AUDIENCE_CHUNK = 1_000;
const BACKOFF_MINUTES = [5, 30, 120];
const RATE_LIMIT_BACKOFF_MS = 60 * 60 * 1000;

function intEnv(name: string, fallback: number, min = 1, max = 100_000): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= min ? Math.min(Math.trunc(v), max) : fallback;
}
/** Sends per worker tick (one tick per minute). Default 20/min - comfortably below Gmail's burst limits. */
export const sendsPerMinute = () => intEnv("CAMPAIGN_SENDS_PER_MINUTE", 20, 1, 600);
/** Rolling-24h cap per sending account. Default 400: below the ~500/day a standard Gmail account is allowed. Raise it only for an account whose provider limit is higher. */
export const dailyLimit = () => intEnv("CAMPAIGN_DAILY_LIMIT", 400, 1, 100_000);

export const isRateLimitError = (message: string) => /rate.?limit|quota|too many|429|daily (user )?sending|userRateLimitExceeded/i.test(message);

export type WorkerTick = { promoted: number; snapshotted: number; sent: number; failed: number; unknown: number; skipped: number; paused: number; completed: number };
const emptyTick = (): WorkerTick => ({ promoted: 0, snapshotted: 0, sent: 0, failed: 0, unknown: 0, skipped: 0, paused: 0, completed: 0 });

/** One worker pass. Never throws. */
export async function drainMarketingCampaigns(now = new Date()): Promise<WorkerTick> {
  const tick = emptyTick();
  try {
    const due = await prisma.marketingCampaign.updateMany({ where: { status: "SCHEDULED", scheduledAt: { lte: now } }, data: { status: "QUEUED", queuedAt: now } });
    tick.promoted = due.count;

    const campaigns = await prisma.marketingCampaign.findMany({
      where: { status: { in: ["QUEUED", "SENDING"] } },
      orderBy: [{ queuedAt: "asc" }, { id: "asc" }],
      take: 5,
      select: { id: true },
    });
    for (const { id } of campaigns) {
      try {
        await processCampaign(id, now, tick);
      } catch (err) {
        console.error(`[campaign-worker] campaign pass failed (${safeErrorTag(err)})`);
      }
    }
  } catch (err) {
    console.error(`[campaign-worker] tick failed (${safeErrorTag(err)})`);
  }
  return tick;
}

async function processCampaign(campaignId: string, now: Date, tick: WorkerTick): Promise<void> {
  // QUEUED -> SENDING exactly once (compare-and-swap).
  await prisma.marketingCampaign.updateMany({ where: { id: campaignId, status: "QUEUED" }, data: { status: "SENDING", startedAt: now } });
  const campaign = await prisma.marketingCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign || campaign.status !== "SENDING") return; // paused / cancelled in the meantime

  if (!campaign.audienceComplete) {
    tick.snapshotted += await snapshotAudienceChunk(campaign.id, campaign.companyId, campaign.audienceCursor);
    // Continue with sending in the same pass: the first recipients go out while a very large audience is still being fixed.
  }

  const senderId = campaign.createdById;
  if (!senderId) {
    await pauseCampaign(campaign.id, now, tick);
    return;
  }

  const sentLast24h = await prisma.marketingCampaignSend.count({
    where: { status: "SENT", sentAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) }, campaign: { createdById: senderId } },
  });
  // The per-minute limit is GLOBAL, not per process: it counts what this sender's campaigns attempted in the last ~minute in the DATABASE (rows are stamped at the
  // write-ahead claim, so a message still in flight counts), so two app instances sharing one database share one budget. The count and the claims are separate
  // statements, so two instances ticking at the very same instant can overshoot by at most one batch - a bounded, documented softness, not a per-process multiple.
  const attemptedLastMinute = await prisma.marketingCampaignSend.count({
    where: { lastAttemptAt: { gte: new Date(now.getTime() - 55_000) }, campaign: { createdById: senderId } },
  });
  let budget = Math.min(sendsPerMinute() - attemptedLastMinute, dailyLimit() - sentLast24h);
  if (budget > 0) {
    const batch = await prisma.marketingCampaignSend.findMany({
      where: { campaignId, status: "PENDING", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      orderBy: { id: "asc" },
      take: budget,
      include: { subscriber: { select: { id: true, email: true, firstName: true, lastName: true, status: true, unsubscribeToken: true } } },
    });
    if (batch.length > 0) {
      const company = await getCompanyForAccountId(senderId);
      const sender = await prisma.account.findUnique({ where: { id: senderId }, select: { id: true, fullName: true, email: true } });
      if (!sender) {
        await pauseCampaign(campaign.id, now, tick);
        return;
      }
      const baseUrl = resolveBaseUrl();
      for (const row of batch) {
        if (budget <= 0) break;
        // Pause / cancel take effect between recipients, not only between passes: re-read the campaign before every claim.
        const live = await prisma.marketingCampaign.findUnique({ where: { id: campaign.id }, select: { status: true } });
        if (live?.status !== "SENDING") break;
        // Write-ahead claim: PENDING -> UNKNOWN. Only one worker can win this; the loser skips the row.
        const claimed = await prisma.marketingCampaignSend.updateMany({
          where: { id: row.id, status: "PENDING", attempts: row.attempts },
          data: { status: "UNKNOWN", attempts: row.attempts + 1, lastAttemptAt: now, nextAttemptAt: null },
        });
        if (claimed.count !== 1) continue;

        // Suppression is judged now, at send time, from the subscriber's CURRENT status (re-read after the claim, not the copy read when the batch was selected).
        const current = (await prisma.subscriber.findUnique({ where: { id: row.subscriber.id }, select: { status: true } }))?.status ?? "UNSUBSCRIBED";
        if (current !== "SUBSCRIBED") {
          await prisma.marketingCampaignSend.update({ where: { id: row.id }, data: { status: current === "SUPPRESSED" ? "SKIPPED_SUPPRESSED" : "SKIPPED_UNSUBSCRIBED" } });
          tick.skipped++;
          continue;
        }

        const vars = { firstName: row.subscriber.firstName, lastName: row.subscriber.lastName, email: row.subscriber.email };
        const { subject, html } = buildMarketingCampaignEmail({
          subject: personalizeText(campaign.subject, vars),
          htmlContent: personalizeHtml(campaign.htmlContent, vars),
          unsubscribeUrl: `${baseUrl}/api/public/unsubscribe?token=${row.subscriber.unsubscribeToken}`,
          company,
          preheader: campaign.previewText ? personalizeText(campaign.previewText, vars) : undefined,
        });
        let result;
        try {
          result = await sendEmail({ accountId: senderId, to: row.subscriber.email, subject, html, senderName: campaign.senderName || sender.fullName, replyTo: campaign.replyTo || undefined });
        } catch {
          // The call itself blew up: whether the provider received it is unknown. Never re-sent.
          tick.unknown++;
          continue; // the row stays UNKNOWN
        }
        budget--;

        if (result.ok) {
          await prisma.marketingCampaignSend.update({ where: { id: row.id }, data: { status: "SENT", sentAt: new Date(), providerMessageId: result.messageId, errorMessage: null } });
          await prisma.subscriber.update({ where: { id: row.subscriber.id }, data: { lastCampaignSentAt: new Date() } }).catch(() => undefined);
          await prisma.emailLog.create({ data: { type: "MARKETING_CAMPAIGN", subject, fromEmail: sender.email, toEmail: row.subscriber.email, status: "SENT", messageId: result.messageId } }).catch(() => undefined);
          tick.sent++;
          continue;
        }
        if (result.ambiguous) {
          // The provider may or may not have sent it: left as UNKNOWN and shown as such. Never automatically re-sent.
          await prisma.marketingCampaignSend.update({ where: { id: row.id }, data: { errorMessage: "No answer from the provider; delivery could not be confirmed" } });
          tick.unknown++;
          continue;
        }
        if (result.code === "NOT_CONNECTED" || result.code === "REAUTH_REQUIRED") {
          // Nothing was sent: give the attempt back and pause the whole campaign until the sender reconnects Gmail.
          await prisma.marketingCampaignSend.update({ where: { id: row.id }, data: { status: "PENDING", attempts: row.attempts, errorMessage: "Sender's Gmail is not connected" } });
          await pauseCampaign(campaign.id, now, tick);
          return;
        }
        if (isRateLimitError(result.error)) {
          await prisma.marketingCampaignSend.update({ where: { id: row.id }, data: { status: "PENDING", attempts: row.attempts, nextAttemptAt: new Date(now.getTime() + RATE_LIMIT_BACKOFF_MS), errorMessage: "Provider sending limit reached; will retry later" } });
          break; // stop this campaign's batch: the provider asked us to slow down
        }
        const attempts = row.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          await prisma.marketingCampaignSend.update({ where: { id: row.id }, data: { status: "FAILED", errorMessage: "Sending failed" } });
          tick.failed++;
        } else {
          await prisma.marketingCampaignSend.update({
            where: { id: row.id },
            data: { status: "PENDING", nextAttemptAt: new Date(now.getTime() + BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)] * 60_000), errorMessage: "Sending failed; will retry" },
          });
        }
      }
    }
  }

  await completeIfDone(campaign.id, now, tick);
}

/** Takes one keyset chunk of the CURRENT subscribers and creates their (idempotent) send rows. Returns the number of rows created. */
export async function snapshotAudienceChunk(campaignId: string, companyId: string, cursor: string | null, chunk = AUDIENCE_CHUNK): Promise<number> {
  const subs = await prisma.subscriber.findMany({
    where: { companyId, status: "SUBSCRIBED", ...(cursor ? { id: { gt: cursor } } : {}) },
    orderBy: { id: "asc" },
    take: chunk,
    select: { id: true },
  });
  let created = 0;
  if (subs.length > 0) {
    const res = await prisma.marketingCampaignSend.createMany({ data: subs.map((s) => ({ campaignId, subscriberId: s.id, status: "PENDING" as const })), skipDuplicates: true });
    created = res.count;
  }
  const complete = subs.length < chunk;
  await prisma.marketingCampaign.updateMany({
    where: { id: campaignId, status: { in: ["SENDING", "QUEUED"] } },
    data: { audienceCursor: subs.length > 0 ? subs[subs.length - 1].id : cursor, audienceComplete: complete, ...(created > 0 ? { recipientCount: { increment: created } } : {}) },
  });
  return created;
}

async function completeIfDone(campaignId: string, now: Date, tick: WorkerTick): Promise<void> {
  const campaign = await prisma.marketingCampaign.findUnique({ where: { id: campaignId }, select: { audienceComplete: true, status: true } });
  if (!campaign || campaign.status !== "SENDING" || !campaign.audienceComplete) return;
  const pending = await prisma.marketingCampaignSend.count({ where: { campaignId, status: "PENDING" } });
  if (pending > 0) return;
  const done = await prisma.marketingCampaign.updateMany({ where: { id: campaignId, status: "SENDING" }, data: { status: "SENT", completedAt: now, sentAt: now } });
  if (done.count === 1) tick.completed++;
}

async function pauseCampaign(campaignId: string, now: Date, tick: WorkerTick): Promise<void> {
  const res = await prisma.marketingCampaign.updateMany({ where: { id: campaignId, status: { in: ["QUEUED", "SENDING"] } }, data: { status: "PAUSED", pausedAt: now } });
  if (res.count === 1) tick.paused++;
}

// ─────────────────────────── statistics (honest definitions) ───────────────────────────

export type CampaignStats = {
  audience: number;
  /** Waiting to be sent (including retries waiting out a delay). */
  queued: number;
  /** Accepted by the sending provider (Gmail). This is NOT "delivered to the inbox" and NOT "opened": neither is tracked. */
  sent: number;
  /** Definitely failed after the allowed attempts. */
  failed: number;
  /** The provider gave no answer, so it is not known whether the message went out. Never re-sent automatically. */
  unknown: number;
  skippedUnsubscribed: number;
  skippedSuppressed: number;
  completedFraction: number;
};

export function summarizeSendCounts(counts: Partial<Record<string, number>>): CampaignStats {
  const queued = counts.PENDING ?? 0;
  const sent = counts.SENT ?? 0;
  const failed = counts.FAILED ?? 0;
  const unknown = counts.UNKNOWN ?? 0;
  const su = counts.SKIPPED_UNSUBSCRIBED ?? 0;
  const ss = counts.SKIPPED_SUPPRESSED ?? 0;
  const audience = queued + sent + failed + unknown + su + ss;
  return { audience, queued, sent, failed, unknown, skippedUnsubscribed: su, skippedSuppressed: ss, completedFraction: audience === 0 ? 0 : (audience - queued) / audience };
}

export async function getCampaignStats(campaignId: string): Promise<CampaignStats> {
  const groups = await prisma.marketingCampaignSend.groupBy({ by: ["status"], where: { campaignId }, _count: { _all: true } });
  return summarizeSendCounts(Object.fromEntries(groups.map((g) => [g.status, g._count._all])));
}
