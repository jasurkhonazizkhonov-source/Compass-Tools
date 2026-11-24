import { prisma } from "@/lib/prisma";
import { safeErrorTag } from "@/lib/safe-error-log";
import { hasReplyDetectionScope } from "@/server/auth/gmail-oauth-config";
import { GmailInboundError, inboundApiForConnection, type GmailInboundApi } from "@/server/email/gmail-inbound";
import { classifyInboundMessage, type InboundMessageMeta } from "@/lib/reply-detection";
import { pollerStopRequested } from "@/server/background-poller";

// Automatic stop when a customer replies. The ONLY place that reads a mailbox, and it reads the narrowest thing that answers the question.
//
// How it works (one pass per minute from the background poller, and from /api/cron/sequence-replies):
//   * Every sequence email the CRM sends records Gmail's message id and conversation (thread) id on its SequenceStepLog row. Those rows - for enrollments that are still
//     ACTIVE (or FAILED, which a Retry could restart) - are the ONLY conversations that are ever looked at.
//   * Per sending mailbox with the gmail.metadata permission: (1) Gmail's change list since the saved position lists the messages that arrived (ids, labels - no content);
//     those in a tracked conversation are fetched as METADATA and judged by classifyInboundMessage (a human reply, or our own mail / an auto-reply / a bounce). (2) A
//     safety sweep re-reads the least recently checked conversations whatever the change list said, so a missed notification, an expired position, an outage or a second
//     instance can delay a stop by minutes but never lose it.
//   * A reply stops the enrollment inside ONE transaction (recordSequenceReply): the reply row (unique per mailbox + Gmail message id, so the same reply seen twice is a
//     no-op) and the enrollment's ACTIVE/FAILED -> REPLIED change commit together, with the reason, time and an Activity entry. The sender's own last-moment check
//     (status ACTIVE and its lease, due-sequence-steps.ts) means a step that has not started sending when this commits is never sent. A step already handed to Gmail
//     at that very instant cannot be recalled; it stays in the history and nothing after it is sent.
//   * A mailbox without the permission is skipped and reported (System Health / the sequence page say so); it can still send. A revoked connection is not read.

/** How many conversations the safety sweep re-reads per mailbox per pass. */
export const SWEEP_SIZE = 40;
/** A reply older than the email it answers (clock skew, a thread that pre-dates the send) is ignored beyond this much tolerance. */
const CLOCK_TOLERANCE_MS = 5 * 60_000;

export type ReplySyncResult = {
  mailboxes: number;
  skippedNoPermission: number;
  conversationsChecked: number;
  repliesFound: number;
  enrollmentsStopped: number;
  errors: number;
};

type Tracked = { id: string; enrollmentId: string; gmailThreadId: string; gmailMessageId: string | null; senderAccountId: string; sentAt: Date | null; createdAt: Date; checkedAt: Date | null };

export type RecordedReply = { duplicate: boolean; stopped: boolean };

/**
 * Records one reply and, when it ends the enrollment, stops it - atomically and idempotently. Safe to call any number of times for the same message, from any number of
 * processes: only the first call that inserts the reply row can stop anything.
 */
export async function recordSequenceReply(input: {
  enrollmentId: string;
  stepLogId: string | null;
  gmailConnectionId: string;
  gmailMessageId: string;
  gmailThreadId: string;
  fromEmail: string;
  receivedAt: Date;
}): Promise<RecordedReply> {
  return prisma.$transaction(
    async (tx) => {
      const created = await tx.sequenceReply.createMany({
        data: [{ ...input, stoppedEnrollment: false }],
        skipDuplicates: true,
      });
      if (created.count === 0) return { duplicate: true, stopped: false };

      // ACTIVE (due or waiting) and FAILED (a Retry could otherwise restart it and email someone who already answered) both end here. Conditional on the status, so a
      // concurrent unenroll / completion / second reply can never be overwritten.
      const stopped = await tx.sequenceEnrollment.updateMany({
        where: { id: input.enrollmentId, status: { in: ["ACTIVE", "FAILED"] } },
        data: { status: "REPLIED", nextSendAt: null, waitReason: null, stopReason: "REPLIED", stoppedAt: input.receivedAt, stoppedById: null },
      });
      if (stopped.count === 0) return { duplicate: false, stopped: false };

      await tx.sequenceReply.updateMany({ where: { gmailConnectionId: input.gmailConnectionId, gmailMessageId: input.gmailMessageId }, data: { stoppedEnrollment: true } });
      const enrollment = await tx.sequenceEnrollment.findUnique({ where: { id: input.enrollmentId }, select: { leadId: true, sequence: { select: { name: true } }, currentStepIdx: true } });
      if (enrollment) {
        await tx.activity.create({
          data: {
            leadId: enrollment.leadId,
            type: "SEQUENCE_REPLIED",
            description: `The customer replied to sequence "${enrollment.sequence.name}" (after step ${enrollment.currentStepIdx}). The remaining emails were cancelled automatically.`,
          },
        });
      }
      await tx.auditLog.create({
        data: { actorId: null, action: "SEQUENCE_STOPPED_BY_REPLY", entityType: "SequenceEnrollment", entityId: input.enrollmentId, metadata: { gmailThreadId: input.gmailThreadId } },
      });
      return { duplicate: false, stopped: true };
    },
    { maxWait: 10_000, timeout: 20_000 }
  );
}

/** Judges one message of a tracked conversation and records it when it is a human reply. */
async function judge(message: InboundMessageMeta, ctx: { connection: { id: string; googleEmail: string }; ownAddresses: string[]; byThread: Map<string, Tracked[]>; knownIds: Set<string> }, tally: ReplySyncResult): Promise<void> {
  const logs = ctx.byThread.get(message.threadId);
  if (!logs || logs.length === 0) return;
  const verdict = classifyInboundMessage(message, ctx.ownAddresses, ctx.knownIds);
  if (verdict.kind !== "reply") return;
  // Which of the enrollment's emails did it answer? The conversation tells us; a message dated before that email cannot be an answer to it.
  const log = logs.find((l) => !message.internalDateMs || message.internalDateMs >= (l.sentAt ?? l.createdAt).getTime() - CLOCK_TOLERANCE_MS) ?? null;
  if (!log) return;
  // counted below, once the reply is known to be NEW (finding the same message again is not another reply)
  const result = await recordSequenceReply({
    enrollmentId: log.enrollmentId,
    stepLogId: log.id,
    gmailConnectionId: ctx.connection.id,
    gmailMessageId: message.id,
    gmailThreadId: message.threadId,
    fromEmail: verdict.fromEmail,
    receivedAt: message.internalDateMs ? new Date(message.internalDateMs) : new Date(),
  });
  if (!result.duplicate) tally.repliesFound++;
  if (result.stopped) tally.enrollmentsStopped++;
}

async function syncMailbox(
  connection: { id: string; accountId: string; googleEmail: string; historyId: string | null; account: { email: string } },
  tracked: Tracked[],
  api: GmailInboundApi,
  now: Date,
  tally: ReplySyncResult
): Promise<void> {
  const byThread = new Map<string, Tracked[]>();
  for (const t of tracked) byThread.set(t.gmailThreadId, [...(byThread.get(t.gmailThreadId) ?? []), t]);
  const knownIds = new Set(tracked.map((t) => t.gmailMessageId).filter((id): id is string => !!id));
  const ctx = { connection, ownAddresses: [connection.googleEmail.toLowerCase(), connection.account.email.toLowerCase()], byThread, knownIds };

  // (1) The change list since the saved position.
  if (!connection.historyId) {
    // First look at this mailbox: from now on the change list is authoritative; everything already sent is covered by the safety sweep below (never-checked rows first).
    const start = await api.currentHistoryId();
    await prisma.gmailConnection.update({ where: { id: connection.id }, data: { historyId: start } });
  } else {
    try {
      let cursor = connection.historyId;
      let pageToken: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 20; page++) {
        const result = await api.listHistory(cursor, pageToken);
        for (const added of result.added) {
          if (!byThread.has(added.threadId) || seen.has(added.id)) continue;
          seen.add(added.id);
          const meta = await api.getMessage(added.id);
          if (meta) await judge(meta, ctx, tally);
        }
        if (!result.nextPageToken) {
          cursor = result.historyId;
          pageToken = undefined;
          break;
        }
        pageToken = result.nextPageToken;
      }
      if (!pageToken) await prisma.gmailConnection.update({ where: { id: connection.id }, data: { historyId: cursor } });
    } catch (err) {
      if (!(err instanceof GmailInboundError) || err.code !== "HISTORY_EXPIRED") throw err;
      // Gmail can no longer answer from that position (idle too long): start again from now and have the sweep re-read every tracked conversation.
      const start = await api.currentHistoryId();
      await prisma.gmailConnection.update({ where: { id: connection.id }, data: { historyId: start } });
      await prisma.sequenceStepLog.updateMany({ where: { id: { in: tracked.map((t) => t.id) } }, data: { repliesCheckedAt: null } });
    }
  }

  // (2) The safety sweep: the least recently checked conversations, whatever the change list said.
  const sweep = [...tracked]
    .sort((a, b) => ((a.checkedAt?.getTime() ?? 0) - (b.checkedAt?.getTime() ?? 0)) || a.createdAt.getTime() - b.createdAt.getTime())
    .slice(0, SWEEP_SIZE);
  const threads = [...new Set(sweep.map((t) => t.gmailThreadId))];
  for (const threadId of threads) {
    if (pollerStopRequested()) return;
    for (const message of await api.getThread(threadId)) await judge(message, ctx, tally);
    tally.conversationsChecked++;
  }
  if (sweep.length > 0) await prisma.sequenceStepLog.updateMany({ where: { id: { in: sweep.map((t) => t.id) } }, data: { repliesCheckedAt: now } });
}

export type ReplySyncOptions = {
  /** Test seam: supplies the Gmail client for a connection instead of exchanging the stored refresh token. */
  apiFor?: (connection: { accountId: string; encryptedRefreshToken: string }) => Promise<GmailInboundApi>;
  now?: Date;
};

/** One pass over every mailbox that has conversations to watch. Never throws; one mailbox failing never stops the others. */
export async function syncSequenceReplies(options: ReplySyncOptions = {}): Promise<ReplySyncResult & { processed: number }> {
  const now = options.now ?? new Date();
  const tally: ReplySyncResult = { mailboxes: 0, skippedNoPermission: 0, conversationsChecked: 0, repliesFound: 0, enrollmentsStopped: 0, errors: 0 };
  try {
    const rows = await prisma.sequenceStepLog.findMany({
      where: { status: "SENT", gmailThreadId: { not: null }, senderAccountId: { not: null }, enrollment: { status: { in: ["ACTIVE", "FAILED"] } } },
      select: { id: true, enrollmentId: true, gmailThreadId: true, gmailMessageId: true, senderAccountId: true, sentAt: true, createdAt: true, repliesCheckedAt: true },
    });
    const bySender = new Map<string, Tracked[]>();
    for (const r of rows) {
      if (!r.gmailThreadId || !r.senderAccountId) continue;
      const t: Tracked = { id: r.id, enrollmentId: r.enrollmentId, gmailThreadId: r.gmailThreadId, gmailMessageId: r.gmailMessageId, senderAccountId: r.senderAccountId, sentAt: r.sentAt, createdAt: r.createdAt, checkedAt: r.repliesCheckedAt };
      bySender.set(r.senderAccountId, [...(bySender.get(r.senderAccountId) ?? []), t]);
    }
    if (bySender.size === 0) return { ...tally, processed: 0 };

    const connections = await prisma.gmailConnection.findMany({
      where: { accountId: { in: [...bySender.keys()] }, status: "CONNECTED" },
      select: { id: true, accountId: true, googleEmail: true, scopes: true, historyId: true, encryptedRefreshToken: true, account: { select: { email: true } } },
    });
    for (const connection of connections) {
      if (pollerStopRequested()) break;
      if (!hasReplyDetectionScope(connection.scopes)) {
        tally.skippedNoPermission++;
        continue;
      }
      tally.mailboxes++;
      try {
        const api = await (options.apiFor ?? inboundApiForConnection)(connection);
        await syncMailbox(connection, bySender.get(connection.accountId) ?? [], api, now, tally);
        await prisma.gmailConnection.update({ where: { id: connection.id }, data: { inboundCheckedAt: now, inboundError: null } });
      } catch (err) {
        tally.errors++;
        // The category only (AUTH / SCOPE / RATE / UNAVAILABLE / an error name): never a message, address or token.
        const tag = err instanceof GmailInboundError ? err.code : safeErrorTag(err);
        await prisma.gmailConnection.update({ where: { id: connection.id }, data: { inboundError: String(tag).slice(0, 40) } }).catch(() => undefined);
        console.error(`[sequence-replies] mailbox check failed (${tag})`);
      }
    }
  } catch (err) {
    tally.errors++;
    console.error(`[sequence-replies] pass failed (${safeErrorTag(err)})`);
  }
  return { ...tally, processed: tally.conversationsChecked };
}
