import Link from "next/link";
import { format } from "date-fns";
import { CheckCircle2, AlertTriangle, XCircle, HelpCircle, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/crm/status-badge";
import { groupForState, overallState, type HealthCheckResult, type HealthGroup, type HealthState } from "@/server/system/health-checks";
import type { HealthEventView } from "@/server/system/health-events";
import type { StatusTone } from "@/lib/status-meta";
import type { HealthSeverity } from "@/generated/prisma/client";

const STATE_META: Record<HealthState, { label: string; tone: StatusTone; icon: typeof CheckCircle2 }> = {
  HEALTHY: { label: "Healthy", tone: "success", icon: CheckCircle2 },
  WARNING: { label: "Warning", tone: "warning", icon: AlertTriangle },
  CRITICAL: { label: "Critical", tone: "destructive", icon: XCircle },
  UNKNOWN: { label: "Unknown", tone: "neutral", icon: HelpCircle },
};

const SEVERITY_TONE: Record<HealthSeverity, StatusTone> = { CRITICAL: "destructive", WARNING: "warning", INFO: "neutral" };

const GROUPS: Array<{ key: HealthGroup; title: string; blurb: string }> = [
  { key: "critical", title: "Critical", blurb: "A core flow is broken or blocked. Act on these first." },
  { key: "warning", title: "Warning", blurb: "Degraded, needs attention, or could not be verified. Customers are not blocked." },
  { key: "informational", title: "Informational", blurb: "Working, or intentionally not in use." },
];

export function SystemHealthView({
  results,
  open,
  recentlyResolved,
  checkedAt,
}: {
  results: HealthCheckResult[];
  open: HealthEventView[];
  recentlyResolved: HealthEventView[];
  checkedAt: string;
}) {
  const overall = overallState(results);
  const meta = STATE_META[overall];
  const OverallIcon = meta.icon;

  return (
    <div className="space-y-5">
      <Card className="shadow-none">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-5">
          <div className="flex items-center gap-3">
            <OverallIcon className="h-6 w-6" aria-hidden />
            <div>
              <p className="text-sm text-muted-foreground">Overall status</p>
              <p className="text-lg font-semibold" data-testid="overall-state">{meta.label}</p>
            </div>
            <StatusBadge label={meta.label} tone={meta.tone} />
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>Checked {format(new Date(checkedAt), "MMM d, yyyy 'at' h:mm:ss a")}</span>
            <Link href="/system-health" className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-foreground hover:bg-muted">
              <RefreshCw className="h-3 w-3" aria-hidden /> Re-run checks
            </Link>
          </div>
        </CardContent>
      </Card>

      {GROUPS.map((group) => {
        const items = results.filter((r) => groupForState(r.state) === group.key);
        if (items.length === 0) return null;
        return (
          <section key={group.key} aria-labelledby={`group-${group.key}`} className="space-y-2">
            <div>
              <h2 id={`group-${group.key}`} className="text-sm font-semibold">
                {group.title} <span className="font-normal text-muted-foreground">({items.length})</span>
              </h2>
              <p className="text-xs text-muted-foreground">{group.blurb}</p>
            </div>
            <div className="space-y-2">
              {items.map((r) => (
                <CheckCard key={r.id} result={r} />
              ))}
            </div>
          </section>
        );
      })}

      <section aria-labelledby="incidents" className="space-y-2">
        <div>
          <h2 id="incidents" className="text-sm font-semibold">Incidents</h2>
          <p className="text-xs text-muted-foreground">Repeated occurrences of the same problem are one incident with a count. Resolved incidents are kept for 30 days.</p>
        </div>
        <IncidentList title="Open" events={open} empty="No open incidents." />
        <IncidentList title="Recently resolved" events={recentlyResolved} empty="Nothing resolved recently." />
      </section>
    </div>
  );
}

function CheckCard({ result }: { result: HealthCheckResult }) {
  const meta = STATE_META[result.state];
  const Icon = meta.icon;
  return (
    <Card className="shadow-none" data-testid={`check-${result.id}`}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
          <span className="flex items-center gap-2">
            <Icon className="h-4 w-4" aria-hidden />
            {result.title}
          </span>
          <StatusBadge label={meta.label} tone={meta.tone} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p>{result.summary}</p>
        {result.facts && result.facts.length > 0 && (
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
            {result.facts.map((f) => (
              <div key={f.label} className="flex justify-between gap-3 border-b border-dashed py-0.5">
                <dt className="text-muted-foreground">{f.label}</dt>
                <dd className="text-right font-medium break-words">{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {result.action && (
          <p className="rounded-md bg-muted/60 px-3 py-2 text-xs">
            <span className="font-medium">What to do: </span>
            {result.action}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function IncidentList({ title, events, empty }: { title: string; events: HealthEventView[]; empty: string }) {
  return (
    <Card className="shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="text-xs text-muted-foreground">{empty}</p>
        ) : (
          <ul className="divide-y">
            {events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge label={e.severity[0] + e.severity.slice(1).toLowerCase()} tone={SEVERITY_TONE[e.severity]} />
                    <Badge variant="outline" className="text-[10px] font-normal">{e.category}</Badge>
                    {e.occurrenceCount > 1 && <span className="text-xs text-muted-foreground">×{e.occurrenceCount}</span>}
                  </div>
                  <p className="mt-1 break-words">{e.message}</p>
                </div>
                <p className="text-right text-xs text-muted-foreground">
                  First {format(e.firstSeenAt, "MMM d, h:mm a")}
                  <br />
                  {e.resolvedAt ? `Resolved ${format(e.resolvedAt, "MMM d, h:mm a")}` : `Last ${format(e.lastSeenAt, "MMM d, h:mm a")}`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
