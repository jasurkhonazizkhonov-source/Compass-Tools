import { notFound } from "next/navigation";
import { Trophy } from "lucide-react";
import { getSalesboard, type SalesboardPeriod } from "@/server/queries/salesboard";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewSalesboard } from "@/lib/permissions";
import { EmptyState } from "@/components/crm/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/currency";
import { cn } from "@/lib/utils";
import Link from "next/link";

export const dynamic = "force-dynamic";

const PERIODS: { value: SalesboardPeriod; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "This Week" },
  { value: "month", label: "This Month" },
  { value: "year", label: "This Year" },
  { value: "all", label: "All Time" },
];

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Part 18 — leaderboard of confirmed-booking profit by user, sorted
 * highest to lowest. Timezone-aware date-range filtering (America/
 * Los_Angeles, same convention as the Pacific clock — see getSalesboard's
 * doc comment for why).
 */
export default async function SalesboardPage({ searchParams }: { searchParams: SearchParams }) {
  const current = await getCurrentAccount();
  if (!canViewSalesboard(current?.role)) notFound();

  const sp = await searchParams;
  const period: SalesboardPeriod = PERIODS.some((p) => p.value === sp.period) ? (sp.period as SalesboardPeriod) : "all";

  const rows = await getSalesboard(current, period);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Salesboard</h1>
          <p className="text-sm text-muted-foreground">Profit generated from confirmed bookings, highest to lowest</p>
        </div>
        <div className="flex gap-1 rounded-md border bg-card p-1 w-full max-w-full overflow-x-auto sm:w-fit">
          {PERIODS.map((p) => (
            <Link
              key={p.value}
              href={`/salesboard?period=${p.value}`}
              className={cn(
                "shrink-0 rounded px-2.5 py-1 text-xs font-medium transition-colors",
                period === p.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              )}
            >
              {p.label}
            </Link>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={Trophy} title="No confirmed bookings in this period" description="The leaderboard fills in as bookings are confirmed." />
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
