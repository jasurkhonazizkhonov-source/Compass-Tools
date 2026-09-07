import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewSubscriptions } from "@/lib/permissions";
import { getSubscriberCounts } from "@/server/queries/subscribers";
import { CampaignForm } from "@/components/subscriptions/campaign-form";

export const dynamic = "force-dynamic";

export default async function NewCampaignPage() {
  const current = await getCurrentAccount();
  if (!canViewSubscriptions(current?.role)) notFound();

  const counts = await getSubscriberCounts(current!.companyId);

  return (
    <div className="max-w-3xl space-y-4">
      <Link href="/subscriptions" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to Subscriptions
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">New Campaign</h1>
      <CampaignForm recipientCount={counts.subscribed} excludedCount={counts.unsubscribed} />
    </div>
  );
}
