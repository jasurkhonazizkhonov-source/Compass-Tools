"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewSubscriptions } from "@/lib/permissions";
import { buildMarketingCampaignEmail } from "@/server/email/templates";
import { sanitizeCampaignHtml } from "@/server/email/sanitize-campaign-html";
import { sendEmail } from "@/server/email/service";
import { getCompanyForAccountId } from "@/server/queries/company";
import { getGmailConnectionState } from "@/server/queries/gmail-connection";
import { resolveBaseUrl } from "@/lib/company-config";
import { firstUnfilledPlaceholder } from "@/lib/campaign-starters";
import { SAMPLE_RECIPIENT, hasErrors, parseStoredDesign, personalizeHtml, personalizeText, renderDesignToHtml, validateDesign, type CampaignDesign, type DesignIssue } from "@/lib/campaign-blocks";
import { dailyLimit, getCampaignStats, processCampaignNow, sendsPerMinute, type CampaignStats } from "@/server/marketing/campaign-worker";

// Durable campaign delivery controls and the block builder's server side. Admin / Marketing Agent only, company-scoped; every action re-checks that itself.
// Returned failures are ordinary `{ ok: false, error }` values (a thrown message reaches the browser as an opaque production digest); only an authorization failure throws.

async function assertMarketingAccess() {
  const current = await getCurrentAccount();
  if (!canViewSubscriptions(current?.role)) throw new Error("You are not authorized to manage marketing campaigns");
  return current!;
}

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });
const MAX_SCHEDULE_AHEAD_MS = 90 * 24 * 60 * 60 * 1000;

// ───────────────────────────── builder: save + preview + test ─────────────────────────────

export type SaveDesignInput = { campaignId?: string; name: string; subject: string; previewText?: string; senderName?: string; replyTo?: string; category?: string; design: CampaignDesign };

/** Validates the design on the SERVER (the browser's check is a convenience), renders it to email-safe HTML, cleans it, and stores both the design and the HTML. */
export async function saveCampaignDesign(input: SaveDesignInput): Promise<{ ok: true; campaignId: string; issues: DesignIssue[] } | (Fail & { issues?: DesignIssue[] })> {
  const admin = await assertMarketingAccess();
  const name = (input.name ?? "").trim();
  const subject = (input.subject ?? "").trim();
  if (!name || name.length > 200) return fail("Give the campaign a name (up to 200 characters).");
  if (subject.length > 300) return fail("The subject is too long (300 characters at most).");
  const issues = validateDesign(input.design, subject);
  if (hasErrors(issues)) return { ok: false, error: issues.find((i) => i.severity === "error")!.message, issues };

  const html = sanitizeCampaignHtml(renderDesignToHtml(input.design));
  if (!html.trim()) return fail("The campaign is empty once unsupported content is removed.");
  const data = {
    name,
    subject,
    htmlContent: html,
    designJson: input.design as unknown as object,
    previewText: input.previewText?.trim().slice(0, 200) || null,
    senderName: input.senderName?.trim().slice(0, 100) || null,
    replyTo: input.replyTo?.trim().slice(0, 254) || null,
    category: input.category?.trim().slice(0, 80) || null,
  };
  if (input.campaignId) {
    const existing = await prisma.marketingCampaign.findFirst({ where: { id: input.campaignId, companyId: admin.companyId }, select: { status: true } });
    if (!existing) return fail("Campaign not found.");
    if (existing.status !== "DRAFT") return fail("Only a draft can be edited. Pause or cancel the campaign first.");
    await prisma.marketingCampaign.update({ where: { id: input.campaignId }, data });
    revalidatePath(`/subscriptions/campaigns/${input.campaignId}`);
    return { ok: true, campaignId: input.campaignId, issues };
  }
  const created = await prisma.marketingCampaign.create({ data: { ...data, companyId: admin.companyId, createdById: admin.id }, select: { id: true } });
  revalidatePath("/subscriptions");
  return { ok: true, campaignId: created.id, issues };
}

/** The preview the builder shows: the SAME shell, sanitizer and personalization the real send uses, with sample recipient data, as a desktop or mobile frame. */
export async function previewCampaignDesign(design: CampaignDesign, subject: string): Promise<{ ok: true; html: string; subject: string; issues: DesignIssue[] }> {
  const admin = await assertMarketingAccess();
  const issues = validateDesign(design, subject);
  let body = "";
  try {
    body = hasErrors(issues.filter((i) => i.blockId === null && /design is not valid/.test(i.message))) ? "" : renderDesignToHtml(design);
  } catch {
    body = "";
  }
  const company = await getCompanyForAccountId(admin.id);
  const { html } = buildMarketingCampaignEmail({
    subject: personalizeText(subject || "(no subject)", SAMPLE_RECIPIENT),
    htmlContent: personalizeHtml(sanitizeCampaignHtml(body), SAMPLE_RECIPIENT),
    unsubscribeUrl: `${resolveBaseUrl()}/api/public/unsubscribe?token=preview`,
    company,
  });
  return { ok: true, html, subject: personalizeText(subject, SAMPLE_RECIPIENT), issues };
}

/** A test send to the signed-in user's OWN address, with sample personalization. It is independent of the subscriber list: it creates no send record, changes no status
 * and works with an empty list. */
export async function sendCampaignTest(campaignId: string): Promise<{ ok: true } | Fail> {
  const admin = await assertMarketingAccess();
  const campaign = await prisma.marketingCampaign.findFirst({ where: { id: campaignId, companyId: admin.companyId } });
  if (!campaign) return fail("Campaign not found.");
  if ((await getGmailConnectionState(admin.id)) !== "CONNECTED") return fail("Connect your Gmail account before sending a test.");
  const company = await getCompanyForAccountId(admin.id);
  const { subject, html } = buildMarketingCampaignEmail({
    subject: `[TEST] ${personalizeText(campaign.subject, SAMPLE_RECIPIENT)}`,
    htmlContent: personalizeHtml(campaign.htmlContent, SAMPLE_RECIPIENT),
    unsubscribeUrl: `${resolveBaseUrl()}/api/public/unsubscribe?token=test`,
    company,
    preheader: campaign.previewText ? personalizeText(campaign.previewText, SAMPLE_RECIPIENT) : undefined,
  });
  const result = await sendEmail({ accountId: admin.id, to: admin.email, subject, html, senderName: admin.fullName });
  return result.ok ? { ok: true } : fail(result.error || "The test could not be sent.");
}

// ───────────────────────────── queue / schedule / pause / resume / cancel ─────────────────────────────

/** Queues a draft for background delivery now, or at `scheduledAt`. Nothing is sent by this request. */
/**
 * What happened when a single-subscriber campaign was handed straight to the worker (see queueCampaign):
 *   sent    - the provider accepted the message;   unknown - the provider gave no answer: NOT re-sent automatically, shown as "Outcome unknown";
 *   skipped - the subscriber unsubscribed / was suppressed just before their turn: nothing was sent;
 *   paused  - the sender's Gmail is not connected: the campaign paused, nothing was sent;
 *   waiting - not sent in this request (a retry is scheduled, or a provider limit applies): the background worker carries on.
 */
export type ImmediateSendOutcome = "sent" | "unknown" | "skipped" | "paused" | "waiting";

/**
 * Queues a draft (or schedules it). Normally nothing is sent by this call: the worker picks the campaign up on its next tick. The one exception is a campaign whose whole
 * audience is exactly ONE subscriber and that is not scheduled for later: waiting up to a minute for a tick gives nothing there, so the same worker pass runs once now
 * (processCampaignNow). It is the same code with the same claims, quota, send-time suppression check and never-re-send-an-uncertain-message rule, so no safeguard is bypassed.
 * A larger audience is never sent from this request.
 */
export async function queueCampaign(campaignId: string, scheduledAt?: string | null): Promise<{ ok: true; status: "QUEUED" | "SCHEDULED"; audience: number; immediate?: ImmediateSendOutcome } | Fail> {
  const admin = await assertMarketingAccess();
  const campaign = await prisma.marketingCampaign.findFirst({ where: { id: campaignId, companyId: admin.companyId } });
  if (!campaign) return fail("Campaign not found.");
  if (campaign.status !== "DRAFT") return fail("Only a draft can be queued.");

  const unfilled = firstUnfilledPlaceholder(campaign.subject, campaign.htmlContent);
  if (unfilled) return fail(`Complete the [[${unfilled}]] placeholder before sending this campaign.`);
  const design = parseStoredDesign(campaign.designJson);
  if (design) {
    const issues = validateDesign(design, campaign.subject);
    if (hasErrors(issues)) return fail(issues.find((i) => i.severity === "error")!.message);
  }

  let when: Date | null = null;
  if (scheduledAt) {
    when = new Date(scheduledAt);
    if (Number.isNaN(when.getTime())) return fail("Choose a valid date and time.");
    if (when.getTime() < Date.now() + 60_000) return fail("Pick a time at least a minute from now.");
    if (when.getTime() > Date.now() + MAX_SCHEDULE_AHEAD_MS) return fail("A campaign can be scheduled at most 90 days ahead.");
  }
  const sender = campaign.createdById ?? admin.id;
  if ((await getGmailConnectionState(sender)) !== "CONNECTED") return fail("The sending account has no connected Gmail. Connect Gmail (or have the campaign's author do so) before queueing.");
  const audience = await prisma.subscriber.count({ where: { companyId: admin.companyId, status: "SUBSCRIBED" } });
  if (audience === 0) return fail("There are no active subscribers to send this campaign to right now.");

  const status = when ? "SCHEDULED" : "QUEUED";
  const res = await prisma.marketingCampaign.updateMany({
    where: { id: campaignId, companyId: admin.companyId, status: "DRAFT" },
    data: { status, queuedAt: new Date(), scheduledAt: when, createdById: sender },
  });
  if (res.count !== 1) return fail("This campaign was already queued.");
  await prisma.auditLog.create({ data: { actorId: admin.id, action: "CAMPAIGN_QUEUED", entityType: "MarketingCampaign", entityId: campaignId, metadata: { status, audience } } });

  let immediate: ImmediateSendOutcome | undefined;
  if (status === "QUEUED" && audience === 1) {
    try {
      const tick = await processCampaignNow(campaignId);
      immediate = tick.sent > 0 ? "sent" : tick.unknown > 0 ? "unknown" : tick.skipped > 0 ? "skipped" : tick.paused > 0 ? "paused" : "waiting";
    } catch {
      immediate = "waiting"; // already queued: the background worker picks it up on its next tick
    }
  }

  revalidatePath("/subscriptions");
  revalidatePath(`/subscriptions/campaigns/${campaignId}`);
  return { ok: true, status, audience, ...(immediate ? { immediate } : {}) };
}

async function transition(campaignId: string, from: Array<"QUEUED" | "SCHEDULED" | "SENDING" | "PAUSED">, data: Record<string, unknown>, action: string): Promise<{ ok: boolean }> {
  const admin = await assertMarketingAccess();
  const res = await prisma.marketingCampaign.updateMany({ where: { id: campaignId, companyId: admin.companyId, status: { in: from } }, data });
  if (res.count === 1) await prisma.auditLog.create({ data: { actorId: admin.id, action, entityType: "MarketingCampaign", entityId: campaignId } });
  revalidatePath("/subscriptions");
  revalidatePath(`/subscriptions/campaigns/${campaignId}`);
  return { ok: res.count === 1 };
}

export async function pauseCampaignDelivery(campaignId: string) {
  return transition(campaignId, ["QUEUED", "SCHEDULED", "SENDING"], { status: "PAUSED", pausedAt: new Date() }, "CAMPAIGN_PAUSED");
}

/** Resume: back to the queue (or back to SCHEDULED if its time has not come). Rows already sent are never sent again (unique rows + status). */
export async function resumeCampaignDelivery(campaignId: string) {
  const admin = await assertMarketingAccess();
  const c = await prisma.marketingCampaign.findFirst({ where: { id: campaignId, companyId: admin.companyId }, select: { scheduledAt: true, createdById: true } });
  if (!c) return { ok: false };
  if (c.createdById && (await getGmailConnectionState(c.createdById)) !== "CONNECTED") return { ok: false, error: "The sending account's Gmail is not connected." };
  const future = c.scheduledAt && c.scheduledAt.getTime() > Date.now();
  return transition(campaignId, ["PAUSED"], { status: future ? "SCHEDULED" : "QUEUED", pausedAt: null }, "CAMPAIGN_RESUMED");
}

/** Cancel is final. Recipients not yet sent stay unsent (and are reported as such); anything already sent stays sent. */
export async function cancelCampaignDelivery(campaignId: string) {
  return transition(campaignId, ["QUEUED", "SCHEDULED", "SENDING", "PAUSED"], { status: "CANCELLED", cancelledAt: new Date() }, "CAMPAIGN_CANCELLED");
}

/**
 * Cancels ONE recipient of a campaign that has not been sent yet, without touching the campaign or anyone else.
 *
 * The whole decision is one atomic conditional update - PENDING -> CANCELLED, only for this campaign, only for this company, only while the campaign can still send. The worker claims a
 * recipient with its own compare-and-swap on the same column (PENDING -> UNKNOWN, claimWithinQuota), so exactly one of the two can win a given row:
 *   - cancellation first: the row is no longer PENDING, the worker's claim finds nothing to claim and skips it - the message is never sent;
 *   - the worker first: the row is already UNKNOWN or SENT, this update matches no row, and the answer says so - it is NOT reported as cancelled, because the send had already begun.
 * Nothing is "assumed cancelled": success is returned only when the database actually changed that row. A sent, uncertain, failed, skipped or already cancelled recipient is never
 * changed. The audit entry names who and which recipient row, never an address.
 */
export async function cancelCampaignRecipient(campaignId: string, sendId: string): Promise<{ ok: true } | Fail> {
  const admin = await assertMarketingAccess();
  if (typeof campaignId !== "string" || typeof sendId !== "string" || !campaignId || !sendId) return fail("That recipient could not be found.");

  const res = await prisma.marketingCampaignSend.updateMany({
    where: { id: sendId, campaignId, status: "PENDING", campaign: { companyId: admin.companyId, status: { in: ["QUEUED", "SENDING", "PAUSED"] } } },
    data: { status: "CANCELLED", nextAttemptAt: null, errorMessage: "Cancelled before it was sent" },
  });
  if (res.count === 1) {
    await prisma.auditLog.create({ data: { actorId: admin.id, action: "CAMPAIGN_RECIPIENT_CANCELLED", entityType: "MarketingCampaignSend", entityId: sendId, metadata: { campaignId } } });
    revalidatePath(`/subscriptions/campaigns/${campaignId}`);
    return { ok: true };
  }

  // Nothing changed. Say why, from what is actually stored now (never guess, never claim a cancellation that did not happen).
  const row = await prisma.marketingCampaignSend.findFirst({ where: { id: sendId, campaignId, campaign: { companyId: admin.companyId } }, select: { status: true, campaign: { select: { status: true } } } });
  if (!row) return fail("That recipient could not be found.");
  switch (row.status) {
    case "SENT":
      return fail("This message has already been sent, so it cannot be cancelled.");
    case "UNKNOWN":
      return fail("Sending to this recipient has already started, so it can no longer be cancelled. Its outcome is shown as unknown.");
    case "CANCELLED":
      return fail("This recipient was already cancelled.");
    case "FAILED":
    case "SKIPPED_SUPPRESSED":
    case "SKIPPED_UNSUBSCRIBED":
      return fail("This recipient is no longer waiting to be sent, so there is nothing to cancel.");
    default:
      return fail("This campaign is no longer sending, so its recipients cannot be cancelled one by one.");
  }
}

// ───────────────────────────── analytics ─────────────────────────────

export type CampaignAnalytics = CampaignStats & {
  status: string;
  sentLastHour: number;
  perMinuteBudget: number;
  dailyLimit: number;
  sentLast24h: number;
  /** Hours the remaining queue needs at the configured daily limit (a plain estimate, not a promise). */
  estimatedHoursRemaining: number | null;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export async function getCampaignAnalytics(campaignId: string): Promise<CampaignAnalytics | null> {
  const admin = await assertMarketingAccess();
  const campaign = await prisma.marketingCampaign.findFirst({ where: { id: campaignId, companyId: admin.companyId }, select: { status: true, scheduledAt: true, startedAt: true, completedAt: true, createdById: true } });
  if (!campaign) return null;
  const stats = await getCampaignStats(campaignId);
  const now = Date.now();
  const [lastHour, last24] = await Promise.all([
    prisma.marketingCampaignSend.count({ where: { campaignId, status: "SENT", sentAt: { gte: new Date(now - 3_600_000) } } }),
    campaign.createdById
      ? prisma.marketingCampaignSend.count({ where: { status: "SENT", sentAt: { gte: new Date(now - 86_400_000) }, campaign: { createdById: campaign.createdById } } })
      : Promise.resolve(0),
  ]);
  const perDay = dailyLimit();
  return {
    ...stats,
    status: campaign.status,
    sentLastHour: lastHour,
    perMinuteBudget: sendsPerMinute(),
    dailyLimit: perDay,
    sentLast24h: last24,
    estimatedHoursRemaining: stats.queued > 0 ? Math.ceil((stats.queued / Math.min(perDay, sendsPerMinute() * 1440)) * 24) : null,
    scheduledAt: campaign.scheduledAt?.toISOString() ?? null,
    startedAt: campaign.startedAt?.toISOString() ?? null,
    completedAt: campaign.completedAt?.toISOString() ?? null,
  };
}
