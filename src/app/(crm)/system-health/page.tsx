import { notFound } from "next/navigation";
import { HeartPulse } from "lucide-react";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewSystemHealth } from "@/lib/permissions";
import { evaluateHealth } from "@/server/system/health-monitor";
import { listHealthEvents } from "@/server/system/health-events";
import { SystemHealthView } from "@/components/system-health/system-health-view";

export const dynamic = "force-dynamic";

/**
 * Admin-only System Health center. Authorization happens on the server, in
 * three independent layers: proxy.ts (route-level redirect), here (page-level
 * notFound() for anything that reaches the component directly), and the fact
 * that every datum below is produced by server-only modules — no secret,
 * environment value, host, user, SQL or stack trace is ever placed in the
 * response (checks report Configured / Missing / Invalid / Healthy /
 * Unavailable only).
 */
export default async function SystemHealthPage() {
  const current = await getCurrentAccount();
  if (!canViewSystemHealth(current?.role)) notFound();

  // Checks first (they also record/resolve incidents), then the incident lists,
  // so what is listed reflects this very evaluation.
  const results = await evaluateHealth();
  const events = await listHealthEvents();

  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <HeartPulse className="h-5 w-5 text-muted-foreground" />
          System Health
        </h1>
        <p className="text-sm text-muted-foreground">
          Live checks of the database, sign-in, email, payments and data integrity, plus a history of recorded incidents. Only Admins can see this page. Nothing here changes any data.
        </p>
      </div>
      <SystemHealthView results={results} open={events.open} recentlyResolved={events.recentlyResolved} checkedAt={new Date().toISOString()} />
    </div>
  );
}
