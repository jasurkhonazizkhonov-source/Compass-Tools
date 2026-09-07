"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewSubscriptions } from "@/lib/permissions";
import { sendEmail } from "@/server/email/service";
import { buildMarketingCampaignEmail } from "@/server/email/templates";
import { getCompanyForAccountId } from "@/server/queries/company";
import { resolveBaseUrl } from "@/lib/company-config";

/** Admin or Marketing Agent — the two roles Part 11 grants Subscriptions
 * access to. Every action below re-asserts this independently of the page
 * link being hidden for every other role. */
async function assertMarketingAccess() {
  const current = await getCurrentAccount();
  if (!canViewSubscriptions(current?.role)) {
    throw new Error("You are not authorized to manage marketing campaigns");
  }
  return current!;
}

async function assertCampaignAccess(companyId: string, campaignId: string) {
  const campaign = await prisma.marketingCampaign.findFirst({ where: { id: campaignId, companyId } });
  if (!campaign) throw new Error("Campaign not found");
  return campaign;
}

const campaignSchema = z.object({
  name: z.string().min(1).max(200),
  subject: z.string().min(1).max(300),
  htmlContent: z.string().min(1),
});

export async function createMarketingCampaign(input: z.infer<typeof campaignSchema>) {
  const admin = await assertMarketingAccess();
  const data = campaignSchema.parse(input);
  const campaign = await prisma.marketingCampaign.create({
    data: { ...data, companyId: admin.companyId, createdById: admin.id },
  });
  revalidatePath("/subscriptions");
  return { campaignId: campaign.id };
}

export async function updateMarketingCampaign(campaignId: string, input: z.infer<typeof campaignSchema>) {
  const admin = await assertMarketingAccess();
  const data = campaignSchema.parse(input);
  const campaign = await assertCampaignAccess(admin.companyId, campaignId);
  if (campaign.status !== "DRAFT") {
    throw new Error("Only draft campaigns can be edited");
  }
  await prisma.marketingCampaign.update({ where: { id: campaignId }, data });
  revalidatePath("/subscriptions");
  revalidatePath(`/subscriptions/campaigns/${campaignId}`);
}

export async function deleteMarketingCampaign(campaignId: string) {
  const admin = await assertMarketingAccess();
  const campaign = await assertCampaignAccess(admin.companyId, campaignId);
  if (campaign.status !== "DRAFT") {
    throw new Error("Only draft campaigns can be deleted");
  }
  await prisma.marketingCampaign.delete({ where: { id: campaignId } });
  revalidatePath("/subscriptions");
}

/** Sends a one-off preview to the sending admin's own email address —
 * never touches campaign status/recipientCount/sends, so it can be used
 * freely while iterating on a draft. */
export async function sendTestMarketingCampaign(campaignId: string) {
  const admin = await assertMarketingAccess();
  const campaign = await assertCampaignAccess(admin.companyId, campaignId);
  const company = await getCompanyForAccountId(admin.id);
  const { subject, html } = buildMarketingCampaignEmail({
    subject: `[TEST] ${campaign.subject}`,
    htmlContent: campaign.htmlContent,
    unsubscribeUrl: `${resolveBaseUrl()}/api/public/unsubscribe?token=test`,
    company,
  });
  const result = await sendEmail({ accountId: admin.id, to: admin.email, subject, html, senderName: admin.fullName });
  if (!result.ok) throw new Error(result.error);
  return { ok: true as const };
}

// Pass 16 §7 — replaces the old MAX_RECIPIENTS_PER_SEND=400 hard cap, which
// silently left every subscriber past #400 permanently unsent (a campaign
// landed in the terminal SENT status regardless). Gmail's per-account daily
// sending cap (~500/day for a standard account) is a REAL external
// constraint this app has no control over — there is no bulk-marketing-ESP
// integration (SendGrid/SES/Resend), and adding one would be a genuinely
// new architectural system, out of scope for this fix. What was actually
// fixable is the application-side limitation: a single request sequentially
// emailing everyone in one shot. This batch size keeps each invocation
// comfortably fast and well under the daily cap; sendMarketingCampaign is
// now safely re-invokable (the UI's "Continue Sending" affordance, or the
// same click retried) to work through the rest — see this function's own
// doc comment for the full mechanism. A company whose subscriber count
// alone exceeds the ~500/day Gmail cap still needs multiple days' worth of
// "Continue Sending" clicks — that real provider limit isn't something any
// application architecture can remove, only work within; no automatic
// multi-day scheduler was built this pass (see the Pass 16 report's
// Remaining Limitations for why, and Sequences' own /api/cron/sequences
// for the shape such a scheduler would take if ever added).
const MAX_RECIPIENTS_PER_BATCH = 100;

/**
 * Sends the campaign's next batch of up to MAX_RECIPIENTS_PER_BATCH
 * currently-SUBSCRIBED subscribers who don't yet have a SENT record for
 * this campaign, via the calling admin's own connected Gmail. Writes an
 * EmailLog + upserted MarketingCampaignSend row per recipient (upsert, not
 * create — a previously-FAILED recipient is retried and their existing row
 * updated in place, never duplicated; the DB's own
 * @@unique([campaignId, subscriberId]) constraint is the real backstop
 * against two concurrent invocations both emailing the same subscriber).
 *
 * Batched and resumable: a DRAFT campaign is atomically claimed into
 * SENDING exactly once (unchanged race protection); a campaign already in
 * SENDING is safely re-entered by calling this again — each call processes
 * one more batch. Only transitions to the terminal SENT status once a
 * fresh count finds zero SUBSCRIBED subscribers still missing a SENT row —
 * a genuinely complete send, never a silently-truncated one. `done: false`
 * in the return value tells the UI another "Continue Sending" is needed.
 */
export async function sendMarketingCampaign(campaignId: string) {
  const admin = await assertMarketingAccess();
  const campaign = await assertCampaignAccess(admin.companyId, campaignId);

  if (campaign.status === "SENT") {
    throw new Error("This campaign has already been sent.");
  }

  if (campaign.status === "DRAFT") {
    // Checked BEFORE claiming DRAFT->SENDING, deliberately — a campaign
    // with nothing to send to must stay in DRAFT (still editable, still
    // re-attemptable once subscribers exist) rather than being claimed
    // into SENDING and immediately falling straight through to a
    // zero-recipient "SENT" below.
    const eligibleCount = await prisma.subscriber.count({ where: { companyId: admin.companyId, status: "SUBSCRIBED" } });
    if (eligibleCount === 0) {
      throw new Error("There are no active subscribers to send this campaign to right now.");
    }

    // Atomic claim: an ordinary read-then-write (check campaign.status,
    // then update it) has a real race window two concurrent Send clicks
    // could both pass through — this single conditional updateMany can
    // only ever report count 1 for exactly one caller, so a second
    // simultaneous send request (or a resubmitted one) is rejected cleanly
    // instead of the campaign being sent twice.
    const claimed = await prisma.marketingCampaign.updateMany({
      where: { id: campaignId, companyId: admin.companyId, status: "DRAFT" },
      data: { status: "SENDING" },
    });
    if (claimed.count === 0) {
      throw new Error("This campaign has already been sent or is currently sending.");
    }
  }
  // Else campaign.status is already SENDING — this call continues it.

  const stillNeedsAttempt = { companyId: admin.companyId, status: "SUBSCRIBED" as const, sends: { none: { campaignId, status: "SENT" as const } } };
  const batch = await prisma.subscriber.findMany({
    where: stillNeedsAttempt,
    take: MAX_RECIPIENTS_PER_BATCH,
    orderBy: { subscribedAt: "asc" },
  });

  const company = await getCompanyForAccountId(admin.id);
  const baseUrl = resolveBaseUrl();
  let sent = 0;
  let failed = 0;

  for (const subscriber of batch) {
    // Pass 22 fix — CONFIRMED duplicate-send bug: this used to send the
    // email FIRST and only record the attempt via `upsert` AFTERWARD.
    // `upsert` never fails on the `@@unique([campaignId, subscriberId])`
    // constraint — it just creates-or-updates either way — so the
    // constraint's own doc comment claiming it "makes that safe under
    // real concurrency" was false: two overlapping "Continue Sending"
    // batches (or a retried request) could both `findMany` the same
    // not-yet-attempted subscribers and both call sendEmail for each one
    // before either upsert landed. The claim below makes the constraint's
    // claim actually true: `create` is the atomic single-use gate for a
    // subscriber's first-ever attempt (a concurrent loser gets a real
    // P2002 and is skipped); a previous FAILED attempt is re-claimed via
    // a conditional `updateMany` so a genuine retry still works, but a
    // row currently PENDING (another invocation actively sending to this
    // subscriber right now) is correctly left alone rather than retried.
    let claimed = true;
    try {
      await prisma.marketingCampaignSend.create({
        data: { campaignId, subscriberId: subscriber.id, status: "PENDING" },
      });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
      const retryClaim = await prisma.marketingCampaignSend.updateMany({
        where: { campaignId, subscriberId: subscriber.id, status: "FAILED" },
        data: { status: "PENDING" },
      });
      claimed = retryClaim.count === 1;
    }
    if (!claimed) continue; // already claimed by a concurrent invocation, or already sent

    const { subject, html } = buildMarketingCampaignEmail({
      subject: campaign.subject,
      htmlContent: campaign.htmlContent,
      unsubscribeUrl: `${baseUrl}/api/public/unsubscribe?token=${subscriber.unsubscribeToken}`,
      company,
    });
    const result = await sendEmail({ accountId: admin.id, to: subscriber.email, subject, html, senderName: admin.fullName });

    await Promise.all([
      prisma.marketingCampaignSend.update({
        where: { campaignId_subscriberId: { campaignId, subscriberId: subscriber.id } },
        data: {
          status: result.ok ? "SENT" : "FAILED",
          sentAt: result.ok ? new Date() : undefined,
          errorMessage: result.ok ? undefined : result.error,
        },
      }),
      prisma.emailLog.create({
        data: {
          type: "MARKETING_CAMPAIGN",
          subject,
          fromEmail: admin.email,
          toEmail: subscriber.email,
          status: result.ok ? "SENT" : "FAILED",
          errorMessage: result.ok ? undefined : result.error,
          messageId: result.ok ? result.messageId : undefined,
        },
      }),
    ]);

    if (result.ok) sent++;
    else failed++;
  }

  // Currently-unsubscribed subscribers were never queried into the send
  // loop above (the safety guarantee — Part 12), but recording a
  // SKIPPED_UNSUBSCRIBED row for each one not already recorded makes that
  // exclusion visible in this campaign's own Delivery Status list rather
  // than just an absence nobody can see. `sends: { none: { campaignId } }`
  // keeps this idempotent across repeated batch calls — a subscriber who
  // unsubscribed between two "Continue Sending" clicks is only recorded
  // once. Best-effort: this is a transparency record, not part of the
  // safety guarantee itself (that's already fully enforced by the query
  // above never selecting an unsubscribed subscriber to send to), so a
  // failure here doesn't roll back the actual sends that already succeeded.
  const unsubscribed = await prisma.subscriber.findMany({
    where: { companyId: admin.companyId, status: "UNSUBSCRIBED", sends: { none: { campaignId } } },
    select: { id: true },
    take: 5000,
  });
  if (unsubscribed.length > 0) {
    await prisma.marketingCampaignSend.createMany({
      data: unsubscribed.map((s) => ({ campaignId, subscriberId: s.id, status: "SKIPPED_UNSUBSCRIBED" as const })),
      skipDuplicates: true,
    }).catch(() => undefined);
  }

  const [remaining, totalSentSoFar, totalUnsubscribedSkipped] = await Promise.all([
    prisma.subscriber.count({ where: stillNeedsAttempt }),
    prisma.marketingCampaignSend.count({ where: { campaignId, status: "SENT" } }),
    prisma.marketingCampaignSend.count({ where: { campaignId, status: "SKIPPED_UNSUBSCRIBED" } }),
  ]);
  const done = remaining === 0;

  await prisma.marketingCampaign.update({
    where: { id: campaignId },
    data: done
      ? { status: "SENT", sentAt: new Date(), recipientCount: totalSentSoFar }
      : { recipientCount: totalSentSoFar },
  });

  revalidatePath("/subscriptions");
  revalidatePath(`/subscriptions/campaigns/${campaignId}`);
  return { sent, failed, skipped: totalUnsubscribedSkipped, remaining, done };
}
