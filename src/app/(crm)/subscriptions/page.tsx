import { notFound } from "next/navigation";
import Link from "next/link";
import { format } from "date-fns";
import { Send, Users } from "lucide-react";
import { getSubscribers, getSubscriberCounts } from "@/server/queries/subscribers";
import { getMarketingCampaigns } from "@/server/queries/marketing-campaigns";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewSubscriptions } from "@/lib/permissions";
import { EmptyState } from "@/components/crm/empty-state";
import { StatusBadge } from "@/components/crm/status-badge";
import { SubscriberList } from "@/components/subscriptions/subscriber-list";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { PaginationControls } from "@/components/crm/pagination-controls";
import { redirectToValidPageIfNeeded } from "@/lib/pagination";
import { CAMPAIGN_STATUS_META } from "@/lib/status-meta";
import type { SubscriberStatus } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Part 10 — Subscriptions: website marketing-list subscribers, plus a
 * distinct Marketing Campaigns sub-area (separate system from CRM
 * Sequences — different model, no CRM variables). Admin and Marketing
 * Agent both have access (Part 11).
 *
 * Pass 7 §17/§18/§28 — one route hosts TWO independent paginated lists, so
 * each gets its own URL page param ("campaignsPage" / "subscribersPage")
 * rather than sharing a single "page" — navigating one list's pages must
 * never reset the other's (see PaginationControls' `pageParam` prop). The
 * Subscribers status tabs (All/Active/Unsubscribed) are also now real
 * links (`?status=...`), not client state, so the filter survives
 * pagination and a page refresh — same convention every other filtered CRM
 * list already uses.
 */
export default async function SubscriptionsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const campaignsPage = sp.campaignsPage ? Number(sp.campaignsPage) : 1;
  const subscribersPage = sp.subscribersPage ? Number(sp.subscribersPage) : 1;
  const campaignsPageSize = typeof sp.campaignsPageSize === "string" ? Number(sp.campaignsPageSize) : undefined;
  const subscribersPageSize = typeof sp.subscribersPageSize === "string" ? Number(sp.subscribersPageSize) : undefined;
  const statusParam = typeof sp.status === "string" ? sp.status : "all";
  const status: SubscriberStatus | undefined = statusParam === "active" ? "SUBSCRIBED" : statusParam === "unsubscribed" ? "UNSUBSCRIBED" : undefined;

  const current = await getCurrentAccount();
  if (!canViewSubscriptions(current?.role)) notFound();

  const [
    { subscribers, total: subscriberTotal, pageCount: subscriberPageCount, pageSize: subscriberPageSize },
    counts,
    { campaigns, total: campaignTotal, pageCount: campaignPageCount, pageSize: campaignPageSize },
  ] = await Promise.all([
    getSubscribers({ companyId: current!.companyId, status, page: subscribersPage, pageSize: subscribersPageSize }),
    getSubscriberCounts(current!.companyId),
    getMarketingCampaigns({ companyId: current!.companyId, page: campaignsPage, pageSize: campaignsPageSize }),
  ]);
  redirectToValidPageIfNeeded(sp, "/subscriptions", campaignsPage, campaignPageCount, "campaignsPage");
  redirectToValidPageIfNeeded(sp, "/subscriptions", subscribersPage, subscriberPageCount, "subscribersPage");

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Subscriptions</h1>
        <p className="text-sm text-muted-foreground">
          {counts.total} subscriber{counts.total === 1 ? "" : "s"} · {counts.subscribed} subscribed · {counts.unsubscribed} unsubscribed
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-base font-semibold flex items-center gap-2"><Send className="h-4 w-4" /> Marketing Campaigns</h2>
          <Button asChild size="sm">
            <Link href="/subscriptions/campaigns/new">New Campaign</Link>
          </Button>
        </div>
        {campaigns.length === 0 ? (
          <EmptyState icon={Send} title="No campaigns yet" description="Create a marketing email campaign to reach your subscribers." />
        ) : (
          <div className="rounded-lg border bg-card overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Recipients</TableHead>
                  <TableHead>Created By</TableHead>
                  <TableHead>Sent</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((c) => {
                  const meta = CAMPAIGN_STATUS_META[c.status];
                  return (
                    <TableRow key={c.id} className="hover:bg-muted/40">
                      <TableCell className="text-sm">
                        <Link href={`/subscriptions/campaigns/${c.id}`} className="font-medium hover:underline hover:text-primary">
                          {c.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{c.subject}</TableCell>
                      <TableCell><StatusBadge label={meta.label} tone={meta.tone} /></TableCell>
                      <TableCell className="text-sm tabular-nums">{c.status === "SENT" ? c.recipientCount : c._count.sends}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{c.createdBy?.fullName ?? "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{c.sentAt ? format(c.sentAt, "MMM d, yyyy") : "—"}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{campaignTotal} campaign{campaignTotal === 1 ? "" : "s"}</p>
        <PaginationControls page={campaignsPage} pageCount={campaignPageCount} total={campaignTotal} pageSize={campaignPageSize} pageParam="campaignsPage" pageSizeParam="campaignsPageSize" label="campaigns" />
      </div>

      <div className="space-y-3">
        <h2 className="text-base font-semibold flex items-center gap-2"><Users className="h-4 w-4" /> Subscribers</h2>
        <SubscriberList subscribers={subscribers} counts={counts} statusParam={statusParam} status={status} filteredTotal={subscriberTotal} />
        <PaginationControls page={subscribersPage} pageCount={subscriberPageCount} total={subscriberTotal} pageSize={subscriberPageSize} pageParam="subscribersPage" pageSizeParam="subscribersPageSize" label="subscribers" />
      </div>
    </div>
  );
}
