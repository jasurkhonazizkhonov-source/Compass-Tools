import { cn } from "@/lib/utils";

/**
 * One KPI figure. It used to carry a percentage-change line against the previous equivalent period ("-100.0% vs previous (Oct 21 –
 * Nov 5, 2026)"); that was removed from Commissions and Salesboard, the only two places this is used. The previous-period helpers
 * (previousEquivalentRange, percentChange in lib/pay-period.ts) and the queries are untouched.
 */
export function PeriodKpi({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div data-testid="period-kpi">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("tabular-nums", emphasize ? "text-lg font-semibold" : "text-base font-medium")}>{value}</p>
    </div>
  );
}
