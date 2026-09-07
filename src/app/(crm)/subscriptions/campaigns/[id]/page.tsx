import { notFound } from "next/navigation";
import Link from "next/link";
import { format } from "date-fns";
import { ArrowLeft } from "lucide-react";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewSubscriptions } from "@/lib/permissions";
import { getMarketingCampaignDetail } from "@/server/queries/marketing-campaigns";
import { getSubscriberCounts } from "@/server/queries/subscribers";
import { CampaignForm } from "@/components/subscriptions/campaign-form";
import { StatusBadge } from "@/components/crm/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CAMPAIGN_STATUS_META, MARKETING_SEND_STATUS_META } from "@/lib/status-meta";

export const dynamic = "force-dynamic";

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const current = await getCurrentAccount();
  if (!canViewSubscriptions(current?.role)) notFound();

  const campaign = await getMarketingCampaignDetail(id, current!.companyId);
  if (!campaign) notFound();

  // Pass 16 §7 — SENDING is now a genuinely visitable, potentially
  // long-lived state (a large campaign completes across several "Continue
  // Sending" batches), not just a transient in-request status — so it
  // needs the same live subscriber counts DRAFT already gets, to compute
  // how many are still left.
  const counts = campaign.status !== "SENT" ? await getSubscriberCounts(current!.companyId) : null;
  const meta = CAMPAIGN_STATUS_META[campaign.status];
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
        remaining={remaining}
      />

      {(campaign.status === "SENT" || campaign.status === "SENDING") && (
        <Card className="shadow-none">
          <CardHeader><CardTitle className="text-sm font-medium">Delivery Status ({campaign.sends.length}{campaign.sends.length >= 200 ? "+" : ""})</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-1.5 max-h-96 overflow-y-auto">
              {campaign.sends.map((s) => {
                const sendMeta = MARKETING_SEND_STATUS_META[s.status];
                return (
                  <li key={s.id} className="flex items-center justify-between text-sm border-b pb-1.5 last:border-b-0">
                    <span>{s.subscriber.email}</span>
                    <span className="flex items-center gap-2">
                      <StatusBadge label={sendMeta.label} tone={sendMeta.tone} />
                      {s.sentAt && <span className="text-xs text-muted-foreground">{format(s.sentAt, "MMM d, h:mm a")}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
