import { notFound } from "next/navigation";
import { Trophy } from "lucide-react";
import { getSalesboard, summarizeSalesboard } from "@/server/queries/salesboard";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewSalesboard } from "@/lib/permissions";
import { EmptyState } from "@/components/crm/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ReportRangeControls, rangeHeading, DEFAULT_RANGE_OPTIONS } from "@/components/crm/report-range-controls";
import { PeriodKpi } from "@/components/crm/period-kpi";
import { formatMoney } from "@/lib/currency";
import { previousEquivalentRange, resolveReportRange } from "@/lib/pay-period";
import { salesRangeForDays, toSalesRange } from "@/server/queries/sales-range";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

// This Year / All Time stay available on the Salesboard (they were there before pay periods existed).
const SALESBOARD_OPTIONS = [...DEFAULT_RANGE_OPTIONS, { value: "year", label: "This Year" }, { value: "all", label: "All Time" }];

/**
 * Part 18 — leaderboard of confirmed-booking profit by user, sorted highest to lowest.
 *
 * The default view is the CURRENT OFFICIAL PAY PERIOD (Period 1 = 21st → 5th, Period 2 = 6th → 20th; lib/pay-period.ts). It
 * flips on its own at the start of the 6th and the 21st in the business time zone — nothing is reset or deleted, an older
 * period is simply another date range. Any other period or a custom From/To goes through the SAME resolver and the SAME
 * query. Who may see the board is unchanged (every signed-in role, company-wide, hidden accounts left off): choosing dates
 * narrows the numbers and never widens access.
 */
export default async function SalesboardPage({ searchParams }: { searchParams: SearchParams }) {
  const current = await getCurrentAccount();
  if (!canViewSalesboard(current?.role)) notFound();

  const sp = await searchParams;
  const range = resolveReportRange({ period: one(sp.period), from: one(sp.from), to: one(sp.to), payPeriod: one(sp.payPeriod) });
  const previous = previousEquivalentRange(range);

  const [rows, previousRows] = await Promise.all([
    getSalesboard(current, toSalesRange(range)),
    previous ? getSalesboard(current, salesRangeForDays(previous.from, previous.to)) : Promise.resolve(null),
  ]);
  const totals = summarizeSalesboard(rows);
  const previousTotals = previousRows ? summarizeSalesboard(previousRows) : null;
  const heading = rangeHeading(range);

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Salesboard</h1>
            <p className="text-sm text-muted-foreground">Profit generated from confirmed bookings, highest to lowest</p>
          </div>
          <div className="sm:text-right" data-testid="salesboard-period">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{heading.title}</p>
            <p className="text-sm font-semibold">{heading.dates}</p>
          </div>
        </div>
        <ReportRangeControls basePath="/salesboard" selected={range} options={SALESBOARD_OPTIONS} />
      </div>

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-sm font-medium">{heading.title} totals</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <PeriodKpi
              label="Profit Generated"
              value={formatMoney(totals.totalProfit, "USD")}
              current={totals.totalProfit}
              previous={previousTotals?.totalProfit}
              previousLabel={previous?.label}
              emphasize
            />
            <PeriodKpi
              label="Confirmed Bookings"
              value={String(totals.bookingCount)}
              current={totals.bookingCount}
              previous={previousTotals?.bookingCount}
              previousLabel={previous?.label}
            />
            <PeriodKpi label="Average Profit per Booking" value={totals.averageProfit === null ? "—" : formatMoney(totals.averageProfit, "USD")} />
          </div>
        </CardContent>
      </Card>

      {rows.length === 0 ? (
        <EmptyState icon={Trophy} title="No confirmed bookings in this period" description="The leaderboard fills in as bookings are confirmed. Earlier periods are still available above." />
      ) : (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Confirmed Bookings</TableHead>
                <TableHead>Profit Generated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={r.id} className="hover:bg-muted/40">
                  <TableCell className="text-sm text-muted-foreground">
                    {i === 0 ? <Badge className="bg-amber-500 text-white hover:bg-amber-500">1</Badge> : i + 1}
                  </TableCell>
                  <TableCell className="font-medium text-sm">
                    {r.fullName}
                    {r.id === current?.id && <Badge variant="outline" className="ml-2 text-[10px]">You</Badge>}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.role}</TableCell>
                  <TableCell className="text-sm tabular-nums">{r.bookingCount}</TableCell>
                  <TableCell className="text-sm font-semibold tabular-nums">{formatMoney(r.profit, "USD")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
