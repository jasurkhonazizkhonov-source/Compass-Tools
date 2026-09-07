import { CheckCircle2, PauseCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { StatusBadge } from "@/components/crm/status-badge";
import { EmptyState } from "@/components/crm/empty-state";
import { getAllQueueMembers } from "@/server/queries/lead-queue";

function initials(name: string) {
  return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}

/**
 * Visible to every user (not admin-gated) — "who's currently ready to
 * receive leads" is operational visibility, not an account-management
 * action. Read-only: accepting/pausing happens via the existing toggle on
 * the dashboard/topbar, not here.
 *
 * Pass 22 fix: requires the viewer's own companyId, threaded down from the
 * page (matching how the accounts directory right below it is already
 * scoped) — previously called getAllQueueMembers() with no company filter
 * at all, showing every OTHER company's staff roster to every viewer.
 */
export async function LeadAcceptanceStatus({ companyId }: { companyId: string }) {
  const members = await getAllQueueMembers(companyId);

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-sm font-medium">Lead Acceptance Status</CardTitle>
      </CardHeader>
      <CardContent>
        {members.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title="No one has joined the lead queue yet"
            description="Workers who click Accept Leads will appear here."
          />
        ) : (
          <ul className="divide-y">
            {members.map((m) => (
              <li key={m.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                {m.isActive ? (
                  <CheckCircle2 className="h-4 w-4 text-success shrink-0" aria-label="Accepting leads" />
                ) : (
                  <PauseCircle className="h-4 w-4 text-muted-foreground shrink-0" aria-label="Paused" />
                )}
                <Avatar size="sm">
                  {m.account.avatarUrl && <AvatarImage src={m.account.avatarUrl} alt={m.account.fullName} />}
                  <AvatarFallback>{initials(m.account.fullName)}</AvatarFallback>
                </Avatar>
                <span className="text-sm font-medium min-w-0 truncate">{m.account.fullName}</span>
                <span className="ml-auto flex items-center gap-2 shrink-0">
                  <StatusBadge label={m.isActive ? "Accepting Leads" : "Paused"} tone={m.isActive ? "success" : "neutral"} />
                  <span className="text-xs text-muted-foreground tabular-nums">Queue #{m.position}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
