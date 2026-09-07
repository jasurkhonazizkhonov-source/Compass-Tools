import { notFound } from "next/navigation";
import Link from "next/link";
import { format } from "date-fns";
import { DollarSign } from "lucide-react";
import { getCommissions, getCommissionsSummary } from "@/server/queries/commissions";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewCommissions } from "@/lib/permissions";
import { listLeadEligibleAgents } from "@/server/queries/reference-data";
import { EmptyState } from "@/components/crm/empty-state";
import { StatusBadge } from "@/components/crm/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PaginationControls } from "@/components/crm/pagination-controls";
import { redirectToValidPageIfNeeded } from "@/lib/pagination";
import { formatMoney } from "@/lib/currency";
import { COMMISSION_TRANSACTION_TYPE_META } from "@/lib/status-meta";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Part 14/16 — commission = booking profit × the quote owner's admin-set
 * commission %. Only CONFIRMED bookings with a computed profit generate a
 * row (see getCommissions). Travel Agent AND Manager see only their own;
 * only Admin sees company-wide, with an All Users / Individual User filter
 * (row-level scope enforced server-side in getCommissions, not here).
 *
 * Pass 24 — the table is now paginated (getCommissions), while the summary
 * card reflects the FULL filtered dataset via a separate, independent
 * query (getCommissionsSummary) — changing pages never changes the
 * summary totals, since the summary was never derived from the page's own
 * rows to begin with.
 */
export default async function CommissionsPage({ searchParams }: { searchParams: SearchParams }) {
  const current = await getCurrentAccount();
  if (!canViewCommissions(current?.role)) notFound();

  const sp = await searchParams;
  const canFilterByUser = current!.role === "ADMIN";
  const selectedUserId = canFilterByUser && typeof sp.user === "string" && sp.user !== "all" ? sp.user : undefined;
  const page = sp.page ? Number(sp.page) : 1;
  const pageSize = typeof sp.pageSize === "string" ? Number(sp.pageSize) : undefined;
  const filters = { userId: selectedUserId };

  const [{ rows: commissions, total, pageCount, pageSize: effectivePageSize }, summary, eligibleAgents] = await Promise.all([
    getCommissions(current, filters, page, pageSize),
    getCommissionsSummary(current, filters),
    canFilterByUser ? listLeadEligibleAgents(current!.companyId) : Promise.resolve([]),
  ]);
  redirectToValidPageIfNeeded(sp, "/commissions", page, pageCount);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Commissions</h1>
          <p className="text-sm text-muted-foreground">
            {summary.bookingCount} confirmed booking{summary.bookingCount === 1 ? "" : "s"} · {formatMoney(summary.totalCommission, "USD")} total commission
          </p>
        </div>
        {canFilterByUser && (
          <div className="flex gap-1 rounded-md border bg-card p-1 w-full max-w-full overflow-x-auto sm:w-fit">
            <Link
              href="/commissions?user=all"
              className={cn(
                "shrink-0 rounded px-2.5 py-1 text-xs font-medium transition-colors",
                !selectedUserId ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              )}
            >
              All Users
            </Link>
            {eligibleAgents.map((a) => (
              <Link
                key={a.id}
                href={`/commissions?user=${a.id}`}
                className={cn(
                  "shrink-0 rounded px-2.5 py-1 text-xs font-medium transition-colors",
                  selectedUserId === a.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                )}
              >
                {a.fullName}
              </Link>
            ))}
          </div>
        )}
      </div>

      <Card className="shadow-none">
        <CardHeader><CardTitle className="text-sm font-medium">Commission Summary</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <SummaryStat label="Bookings" value={String(summary.bookingCount)} />
            <SummaryStat label="Total Profit" value={formatMoney(summary.totalProfit, "USD")} />
            <SummaryStat label="Total Commission" value={formatMoney(summary.totalCommission, "USD")} />
            <SummaryStat
              label={summary.uniformTipPercent != null ? `Total Tips (${summary.uniformTipPercent}% applied)` : "Total Tips"}
              value={formatMoney(summary.totalTips, "USD")}
            />
            <SummaryStat label="Tip Earnings" value={formatMoney(summary.tipEarnings, "USD")} />
            <SummaryStat label="Total Earnings" value={formatMoney(summary.totalEarnings, "USD")} emphasize />
          </div>
        </CardContent>
      </Card>

      {commissions.length === 0 ? (
        <EmptyState icon={DollarSign} title="No commissions yet" description="Commission appears here once a booking's ticketing is saved as Confirmed." />
      ) : (
        <>
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Quote</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Booking</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead>Profit</TableHead>
                <TableHead>Commission %</TableHead>
                <TableHead>Commission</TableHead>
                <TableHead>Tip Earned</TableHead>
                <TableHead>Quote Owner</TableHead>
                <TableHead>Ticketing Agent</TableHead>
                <TableHead>Confirmed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {commissions.map((c) => (
                <TableRow key={c.bookingId} className="hover:bg-muted/40">
                  <TableCell className="text-sm">
                    <Link href={`/quotes/${c.quoteId}`} className="font-medium hover:underline hover:text-primary">
                      {c.quoteNumber}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge label={COMMISSION_TRANSACTION_TYPE_META[c.transactionType].label} tone={COMMISSION_TRANSACTION_TYPE_META[c.transactionType].tone} />
                  </TableCell>
                  <TableCell className="text-sm">{c.customerName}</TableCell>
                  <TableCell className="text-sm">
                    <Link href={`/bookings/${c.bookingId}`} className="hover:underline hover:text-primary">
                      {c.bookingReference}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{c.destination}</TableCell>
                  <TableCell className="text-sm tabular-nums">{formatMoney(c.profit, "USD")}</TableCell>
                  <TableCell className="text-sm tabular-nums text-muted-foreground">{c.commissionPercent}%</TableCell>
                  <TableCell className="text-sm font-semibold tabular-nums">{formatMoney(c.commissionAmount, "USD")}</TableCell>
                  <TableCell className="text-sm tabular-nums text-muted-foreground">{formatMoney(c.tipEarned, "USD")}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{c.quoteOwnerName}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{c.ticketingAgentName}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{format(c.confirmedAt, "MMM d, yyyy")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <PaginationControls page={page} pageCount={pageCount} total={total} pageSize={effectivePageSize} />
        </>
      )}
    </div>
  );
}

function SummaryStat({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("tabular-nums", emphasize ? "text-lg font-semibold" : "text-base font-medium")}>{value}</p>
    </div>
  );
}
