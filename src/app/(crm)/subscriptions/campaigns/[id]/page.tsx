import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewSubscriptions } from "@/lib/permissions";
import { getEmailViewer } from "@/server/privacy/customer-email";
import { getMarketingCampaignDetail } from "@/server/queries/marketing-campaigns";
import { getSubscriberCounts } from "@/server/queries/subscribers";
import { CampaignForm } from "@/components/subscriptions/campaign-form";
import { CampaignDeliveryPanel } from "@/components/subscriptions/campaign-delivery-panel";
import { getCampaignAnalytics } from "@/server/actions/campaign-delivery";
import { parseStoredDesign } from "@/lib/campaign-blocks";
import { StatusBadge } from "@/components/crm/status-badge";
import { CAMPAIGN_STATUS_META } from "@/lib/status-meta";
import { redirectToValidPageIfNeeded } from "@/lib/pagination";
import { getCampaignRecipientPage } from "@/server/queries/campaign-recipients";
import { CampaignRecipientList, RECIPIENT_PAGE_PARAM, RECIPIENT_PAGE_SIZE_PARAM } from "@/components/subscriptions/campaign-recipient-list";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function CampaignDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const current = await getCurrentAccount();
  if (!canViewSubscriptions(current?.role)) notFound();
  // Recipient addresses follow the customer-email rule: masked unless the viewer is an Administrator or has the unlimited switch.
  const emailRestricted = (await getEmailViewer(current!)).restricted;

  const campaign = await getMarketingCampaignDetail(id, current!.companyId);
  if (!campaign) notFound();

  // Pass 16 §7 — SENDING is now a genuinely visitable, potentially
  // long-lived state (a large campaign completes across several "Continue
  // Sending" batches), not just a transient in-request status — so it
  // needs the same live subscriber counts DRAFT already gets, to compute
  // how many are still left.
  const counts = campaign.status !== "SENT" ? await getSubscriberCounts(current!.companyId) : null;
  // Background delivery: queued / scheduled / paused / cancelled campaigns (and any being sent by the worker) are controlled and measured from the delivery panel.
  const analytics = await getCampaignAnalytics(campaign.id);
  const managedByWorker = !!campaign.queuedAt || ["QUEUED", "SCHEDULED", "PAUSED", "CANCELLED"].includes(campaign.status);
  const builtWithBuilder = parseStoredDesign(campaign.designJson) !== null;
  const meta = CAMPAIGN_STATUS_META[campaign.status];
  // The recipient-level Delivery Status: one server-cut page (25 / 50 / 75 / 100) of the campaign's recipients, never the whole list.
  const recipientPageNumber = Math.trunc(Number(one(sp[RECIPIENT_PAGE_PARAM]) ?? 1)) || 1;
  const recipients = campaign.status === "DRAFT" ? null : await getCampaignRecipientPage({ campaignId: campaign.id, companyId: current!.companyId, page: recipientPageNumber, pageSize: one(sp[RECIPIENT_PAGE_SIZE_PARAM]) });
  if (recipients) redirectToValidPageIfNeeded(sp, `/subscriptions/campaigns/${campaign.id}`, recipientPageNumber, recipients.pageCount, RECIPIENT_PAGE_PARAM);
  const remaining = campaign.status === "SENDING" ? Math.max(0, (counts?.subscribed ?? 0) - campaign._count.sends) : undefined;

  return (
    <div className="max-w-3xl space-y-4">
      <Link href="/subscriptions" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to Subscriptions
      </Link>
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{campaign.name}</h1>
        <StatusBadge label={meta.label} tone={meta.tone} />
      </div>

      {campaign.status === "DRAFT" && builtWithBuilder && (
        <Link href={`/subscriptions/campaigns/builder?id=${campaign.id}`} className="inline-flex text-sm text-primary hover:underline">Edit in the builder</Link>
      )}

      {analytics && (managedByWorker || campaign.status === "SENDING" || campaign.status === "SENT") && (
        <CampaignDeliveryPanel campaignId={campaign.id} initial={analytics} canQueue={campaign.status === "DRAFT"} />
      )}

      <CampaignForm
        campaignId={campaign.id}
        campaignName={campaign.name}
        initialName={campaign.name}
        initialSubject={campaign.subject}
        initialHtml={campaign.htmlContent}
        recipientCount={campaign.status === "SENT" ? campaign.recipientCount : campaign.status === "SENDING" ? campaign._count.sends : (counts?.subscribed ?? 0)}
        excludedCount={counts?.unsubscribed ?? 0}
        readOnly={campaign.status !== "DRAFT"}
        canDelete={campaign.status === "DRAFT"}
        remaining={managedByWorker ? undefined : remaining}
      />

      {recipients && <CampaignRecipientList campaignId={campaign.id} data={recipients} emailRestricted={emailRestricted} />}
    </div>
  );
}
