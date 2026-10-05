import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { percentChange } from "@/lib/pay-period";
import { cn } from "@/lib/utils";

/**
 * One KPI figure with an optional comparison against the previous equivalent period. A previous value of zero (or no previous
 * period at all, e.g. "All time") never produces a percentage — it says so in words instead of showing Infinity / NaN.
 */
export function PeriodKpi({
  label,
  value,
  current,
  previous,
  previousLabel,
  previousDisplay,
  emphasize,
}: {
  label: string;
  value: string;
  /** Raw numbers for the comparison; omit both to show the figure alone. */
  current?: number | null;
  previous?: number | null;
  previousLabel?: string | null;
  previousDisplay?: string;
  emphasize?: boolean;
}) {
  const hasComparison = previousLabel != null && current != null && previous != null;
  const change = hasComparison ? percentChange(current!, previous!) : null;
  return (
    <div data-testid="period-kpi">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("tabular-nums", emphasize ? "text-lg font-semibold" : "text-base font-medium")}>{value}</p>
      {hasComparison && (
        <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground" data-testid="period-kpi-comparison">
          {change === null ? (
            <>
              <Minus className="h-3 w-3" aria-hidden />
              <span>No earlier figure to compare{previous === 0 ? " (previous period was 0)" : ""}</span>
            </>
          ) : (
            <>
              {change > 0 ? <ArrowUpRight className="h-3 w-3 text-success" aria-hidden /> : change < 0 ? <ArrowDownRight className="h-3 w-3 text-destructive" aria-hidden /> : <Minus className="h-3 w-3" aria-hidden />}
              <span className={cn(change > 0 && "text-success", change < 0 && "text-destructive")}>
                {change > 0 ? "+" : ""}
                {change.toFixed(1)}%
              </span>
              <span>vs {previousDisplay ?? "previous"} ({previousLabel})</span>
            </>
          )}
        </p>
      )}
    </div>
  );
}
