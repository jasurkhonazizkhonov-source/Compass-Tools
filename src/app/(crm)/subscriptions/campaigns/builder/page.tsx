import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewSubscriptions } from "@/lib/permissions";
import { getMarketingCampaignDetail } from "@/server/queries/marketing-campaigns";
import { CampaignBuilder, type BuilderInitial } from "@/components/subscriptions/campaign-builder";
import { emptyDesign, parseStoredDesign } from "@/lib/campaign-blocks";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The block-based campaign builder. `?id=` opens an existing DRAFT that was made with the builder; without it a new design starts. Admin / Marketing Agent only. */
export default async function CampaignBuilderPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const current = await getCurrentAccount();
  if (!canViewSubscriptions(current?.role)) notFound();

  let initial: BuilderInitial = { name: "", subject: "", previewText: "", design: emptyDesign() };
  if (typeof sp.id === "string") {
    const campaign = await getMarketingCampaignDetail(sp.id, current!.companyId);
    if (!campaign) notFound();
    const design = parseStoredDesign(campaign.designJson);
    // Only a draft made with the builder can be edited here; anything else is edited (or just viewed) on its own page.
    if (!design || campaign.status !== "DRAFT") notFound();
    initial = { campaignId: campaign.id, name: campaign.name, subject: campaign.subject, previewText: campaign.previewText ?? "", design };
  }

  return (
    <div className="space-y-4">
      <Link href="/subscriptions" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to Subscriptions
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">{initial.campaignId ? "Edit campaign" : "New campaign (builder)"}</h1>
      <CampaignBuilder initial={initial} />
    </div>
  );
}
