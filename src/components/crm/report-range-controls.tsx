import Link from "next/link";
import { CalendarRange } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildReportHref, recentPayPeriods, payPeriodContaining, civilDateInZone, payPeriodName, payPeriodRangeLabel, toIsoDate, type ResolvedReportRange } from "@/lib/pay-period";
import { cn } from "@/lib/utils";

/**
 * The shared "which dates?" control for Salesboard and Commissions: quick selectors (current / previous pay period, this / last
 * month), a jump list of recent official pay periods, and an explicit From / To range. Plain links and a GET form — no client
 * state — so every view is a shareable URL and the server resolves it with the ONE range resolver (lib/pay-period.ts).
 *
 * Choosing dates only narrows what a report shows. It never changes who may see the report: each page's row scope is applied
 * server-side regardless of what range is requested.
 */
export type RangeQuickOption = { value: string; label: string };

export const DEFAULT_RANGE_OPTIONS: RangeQuickOption[] = [
  { value: "pay-period", label: "Current Pay Period" },
  { value: "previous-pay-period", label: "Previous Pay Period" },
  { value: "month", label: "Current Month" },
  { value: "previous-month", label: "Previous Month" },
];

export function ReportRangeControls({
  basePath,
  selected,
  preserve = {},
  options = DEFAULT_RANGE_OPTIONS,
  now = new Date(),
}: {
  basePath: string;
  selected: ResolvedReportRange;
  /** Other query parameters to keep when the range changes (e.g. the Admin's user filter). */
  preserve?: Record<string, string | null | undefined>;
  options?: RangeQuickOption[];
  now?: Date;
}) {
  const current = payPeriodContaining(civilDateInZone(now));
  const periods = recentPayPeriods(current, 12);
  const activeQuick = selected.kind === "custom" ? "custom" : selected.kind;
  const preservedEntries = Object.entries(preserve).filter(([, v]) => !!v) as [string, string][];

  return (
    <div className="space-y-2" data-testid="report-range-controls">
      <div className="flex gap-1 rounded-md border bg-card p-1 w-full max-w-full overflow-x-auto sm:w-fit" role="group" aria-label="Quick date ranges">
        {options.map((o) => (
          <Link
            key={o.value}
            href={buildReportHref(basePath, { ...preserve, period: o.value })}
            aria-current={activeQuick === o.value ? "true" : undefined}
            className={cn(
              "shrink-0 rounded px-2.5 py-1 text-xs font-medium transition-colors",
              activeQuick === o.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
            )}
          >
            {o.label}
          </Link>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        {/* keyed by the selection: a soft navigation reuses the DOM, and an uncontrolled defaultValue would otherwise keep showing the previous choice */}
        <form key={`pp-${selected.payPeriod?.key ?? "none"}`} method="get" action={basePath} className="flex w-full flex-wrap items-end gap-2 sm:w-auto" aria-label="Choose a pay period">
          {preservedEntries.map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <label className="flex min-w-0 max-w-full flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground sm:flex-none">
            Pay period
            <select
              name="payPeriod"
              defaultValue={selected.payPeriod?.key ?? ""}
              className="h-8 w-full min-w-0 max-w-full rounded-lg border border-input bg-transparent px-2 text-sm text-foreground sm:min-w-[12rem] dark:bg-input/30"
            >
              {!selected.payPeriod && <option value="">Select a pay period…</option>}
              {periods.map((p) => (
                <option key={p.key} value={p.key}>
                  {payPeriodName(p)} · {payPeriodRangeLabel(p)}
                  {p.key === current.key ? " (current)" : ""}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" size="sm" variant="outline">
            Show
          </Button>
        </form>

        <form key={`range-${selected.kind}-${selected.from ? toIsoDate(selected.from) : ""}-${selected.to ? toIsoDate(selected.to) : ""}`} method="get" action={basePath} className="flex flex-wrap items-end gap-2" aria-label="Choose a custom date range">
          {preservedEntries.map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            From
            <input
              type="date"
              name="from"
              required
              defaultValue={selected.kind === "custom" && selected.from ? toIsoDate(selected.from) : ""}
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm text-foreground dark:bg-input/30"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            To
            <input
              type="date"
              name="to"
              required
              defaultValue={selected.kind === "custom" && selected.to ? toIsoDate(selected.to) : ""}
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm text-foreground dark:bg-input/30"
            />
          </label>
          <Button type="submit" size="sm" variant="outline" className="gap-1.5">
            <CalendarRange className="h-3.5 w-3.5" /> Apply range
          </Button>
        </form>
      </div>

      {selected.warning && (
        <p role="alert" className="text-xs text-destructive" data-testid="report-range-warning">
          {selected.warning} Showing the current pay period instead.
        </p>
      )}
    </div>
  );
}

/** What the page is showing, in words: "Current Pay Period", "Previous Pay Period", "Custom Range" … plus the exact dates. */
export function rangeHeading(r: ResolvedReportRange): { title: string; dates: string } {
  const dates = r.kind === "all" ? "All time" : r.label.includes(" · ") ? r.label.split(" · ")[1] : r.label;
  if (r.isCurrentPayPeriod) return { title: "Current Pay Period", dates: r.payPeriod ? `${payPeriodName(r.payPeriod)} · ${dates}` : dates };
  switch (r.kind) {
    case "previous-pay-period":
      return { title: "Previous Pay Period", dates: r.payPeriod ? `${payPeriodName(r.payPeriod)} · ${dates}` : dates };
    case "pay-period":
      return { title: "Pay Period", dates: r.payPeriod ? `${payPeriodName(r.payPeriod)} · ${dates}` : dates };
    case "month":
      return { title: "Current Month", dates };
    case "previous-month":
      return { title: "Previous Month", dates };
    case "year":
      return { title: "This Year", dates };
    case "today":
      return { title: "Today", dates };
    case "week":
      return { title: "This Week", dates };
    case "all":
      return { title: "All Time", dates };
    case "custom":
      return { title: "Custom Range", dates };
  }
}
