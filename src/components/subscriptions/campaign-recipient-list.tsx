import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/crm/status-badge";
import { PaginationControls } from "@/components/crm/pagination-controls";
import { CancelRecipientButton } from "@/components/subscriptions/cancel-recipient-button";
import { maskCustomerEmail } from "@/lib/customer-email-mask";
import { BUSINESS_TIMEZONE } from "@/lib/pay-period";
import type { StatusTone } from "@/lib/status-meta";
import { RECIPIENT_GROUP_ORDER, type RecipientGroup, type RecipientPage, type RecipientRow } from "@/server/queries/campaign-recipients";

// The recipient-level Delivery Status of one campaign: every recipient, grouped (Sent, Scheduled, Waiting, Outcome unknown, Failed, Skipped, Cancelled), one server-cut page at a time.
// Presentational (server-rendered); the only client piece is the per-recipient Cancel button, which is shown only while a message has not been sent. Times are shown in the CRM's
// business time zone, named, never in the server's own.

export const RECIPIENT_PAGE_PARAM = "dpage";
export const RECIPIENT_PAGE_SIZE_PARAM = "dsize";

const TONE: Record<RecipientGroup, StatusTone> = {
  SENT: "success",
  SCHEDULED: "info",
  WAITING: "neutral",
  UNKNOWN: "warning",
  FAILED: "destructive",
  SKIPPED_UNSUBSCRIBED: "neutral",
  SKIPPED_SUPPRESSED: "neutral",
  CANCELLED: "neutral",
};

const timeFormat = new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TIMEZONE, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const AT_LABEL: Record<NonNullable<RecipientRow["atKind"]>, string> = { sent: "Sent", next: "Next attempt", earliest: "Earliest" };

function whenText(row: RecipientRow): string | null {
  if (!row.at || !row.atKind) return null;
  return `${AT_LABEL[row.atKind]} ${timeFormat.format(row.at)} PT`;
}

export function CampaignRecipientList({ campaignId, data, emailRestricted }: { campaignId: string; data: RecipientPage; emailRestricted: boolean }) {
  // A group heading is drawn where the group changes inside the page (and at the top), so the grouping is visible even when a group continues from the previous page.
  const startsGroup = data.rows.map((r, i) => i === 0 || r.group !== data.rows[i - 1].group);
  const counts = new Map(data.groupCounts.map((g) => [g.group, g.count]));

  return (
    <Card className="shadow-none" data-testid="campaign-recipient-list">
      <CardHeader className="space-y-1">
        <CardTitle className="text-sm font-medium">Delivery Status ({data.total.toLocaleString("en-US")})</CardTitle>
        {data.total > 0 && (
          <p className="text-xs text-muted-foreground" data-testid="recipient-summary">
            {RECIPIENT_GROUP_ORDER.filter((g) => counts.has(g))
              .map((g) => `${data.groupCounts.find((c) => c.group === g)!.label} ${counts.get(g)!.toLocaleString("en-US")}`)
              .join(" · ")}
          </p>
        )}
        <p className="text-xs text-muted-foreground">Sent means accepted by Gmail; inbox delivery is not tracked.</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.total === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="recipient-empty">
            {data.campaignStatus === "SCHEDULED" ? "Recipients are listed here once sending starts." : "No recipients have been recorded for this campaign yet."}
          </p>
        ) : (
          <ul className="space-y-1" aria-label="Campaign recipients">
            {data.rows.map((row, index) => {
              const heading = startsGroup[index];
              const shown = emailRestricted ? maskCustomerEmail(row.email) : row.email;
              const when = whenText(row);
              return (
                <li key={row.id} className="list-none">
                  {heading && (
                    <p className="mb-1 mt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground first:mt-0" data-testid="recipient-group-heading">
                      {row.label} ({(counts.get(row.group) ?? 0).toLocaleString("en-US")})
                    </p>
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b pb-1.5 text-sm" data-testid="campaign-recipient">
                    <span className="min-w-0 break-all">{shown}</span>
                    <span className="flex flex-wrap items-center justify-end gap-2">
                      <StatusBadge label={row.label} tone={TONE[row.group]} />
                      {when && <span className="text-xs text-muted-foreground">{when}</span>}
                      {row.canCancel && <CancelRecipientButton campaignId={campaignId} sendId={row.id} label={shown} />}
                    </span>
                    {row.reason && (
                      <span className="basis-full text-xs text-muted-foreground" data-testid="recipient-reason">
                        {row.reason}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <PaginationControls
          page={data.page}
          pageCount={data.pageCount}
          total={data.total}
          pageSize={data.pageSize}
          pageParam={RECIPIENT_PAGE_PARAM}
          pageSizeParam={RECIPIENT_PAGE_SIZE_PARAM}
          label="recipients"
        />
      </CardContent>
    </Card>
  );
}
