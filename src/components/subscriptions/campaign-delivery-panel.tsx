"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pause, Play, CalendarClock, Ban, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/crm/confirm-dialog";
import { cancelCampaignDelivery, getCampaignAnalytics, pauseCampaignDelivery, queueCampaign, resumeCampaignDelivery, type CampaignAnalytics } from "@/server/actions/campaign-delivery";

const ACTIVE = new Set(["QUEUED", "SCHEDULED", "SENDING"]);
const POLL_MS = 10_000;

/**
 * Delivery controls and analytics for a campaign. Delivery itself happens in the background worker; this panel only asks the server to queue, schedule, pause, resume or
 * cancel, and shows the numbers the worker has recorded. The definitions are stated on the page because they are easy to over-read:
 *   - "Sent" means the mail provider (Gmail) ACCEPTED the message. It does not mean it reached the inbox or was read: opens, clicks and bounces are not tracked.
 *   - "Outcome unknown" means the provider gave no answer; the message is never re-sent automatically.
 */
export function CampaignDeliveryPanel({ campaignId, initial, canQueue }: { campaignId: string; initial: CampaignAnalytics; canQueue: boolean }) {
  const router = useRouter();
  const [stats, setStats] = useState<CampaignAnalytics>(initial);
  const [pending, startTransition] = useTransition();
  const [when, setWhen] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);

  useEffect(() => {
    if (!ACTIVE.has(stats.status)) return;
    const id = setInterval(async () => {
      try {
        const next = await getCampaignAnalytics(campaignId);
        if (next) {
          setStats(next);
          if (next.status !== stats.status) router.refresh();
        }
      } catch {
        /* keep the last numbers; the next tick tries again */
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [campaignId, stats.status, router]);

  async function refresh() {
    const next = await getCampaignAnalytics(campaignId);
    if (next) setStats(next);
    router.refresh();
  }

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    startTransition(async () => {
      try {
        const r = await fn();
        if (!r.ok) toast.error(r.error ?? "That could not be done right now.");
        else toast.success(success);
        await refresh();
      } catch {
        toast.error("That could not be done right now.");
      }
    });
  }

  const pct = Math.round(stats.completedFraction * 100);
  const tile = (label: string, value: number, hint: string, testId: string) => (
    <div className="rounded-md border p-3" title={hint}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums" data-testid={testId}>{value.toLocaleString("en-US")}</p>
    </div>
  );

  return (
    <Card className="shadow-none" data-testid="campaign-delivery-panel">
      <CardHeader><CardTitle className="text-sm font-medium">Delivery</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {stats.audience > 0 && (
          <div className="space-y-1.5">
            <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Delivery progress">
              <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">{pct}% of the audience has been handled ({(stats.audience - stats.queued).toLocaleString("en-US")} of {stats.audience.toLocaleString("en-US")}).</p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {tile("Waiting", stats.queued, "Not yet sent, including retries waiting for their turn", "stat-queued")}
          {tile("Sent", stats.sent, "Accepted by Gmail. Not a promise of inbox delivery; opens and clicks are not tracked", "stat-sent")}
          {tile("Failed", stats.failed, "Failed after the allowed attempts", "stat-failed")}
          {tile("Outcome unknown", stats.unknown, "No answer from the provider; never re-sent automatically", "stat-unknown")}
          {tile("Skipped: unsubscribed", stats.skippedUnsubscribed, "Unsubscribed before their turn", "stat-unsub")}
          {tile("Skipped: suppressed", stats.skippedSuppressed, "Suppressed before their turn", "stat-suppressed")}
        </div>

        <dl className="grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
          <div><dt className="inline font-medium text-foreground">Sent</dt> <dd className="inline">= accepted by Gmail. Delivered, opened and clicked are not tracked.</dd></div>
          <div><dt className="inline font-medium text-foreground">Outcome unknown</dt> <dd className="inline">= no answer from Gmail; not re-sent, so nobody gets it twice.</dd></div>
        </dl>

        <p className="text-xs text-muted-foreground" data-testid="provider-limits">
          Sending runs in the background at up to {stats.perMinuteBudget} a minute, and at most {stats.dailyLimit.toLocaleString("en-US")} in any 24 hours from the sending Gmail account ({stats.sentLast24h.toLocaleString("en-US")} so far in the last 24 hours). Gmail&apos;s own limit is a few hundred messages a day for a standard account, so a large list takes days
          {stats.estimatedHoursRemaining != null ? `; at this rate the remaining ${stats.queued.toLocaleString("en-US")} need roughly ${stats.estimatedHoursRemaining.toLocaleString("en-US")} hours` : ""}.
        </p>

        {stats.status === "PAUSED" && (
          <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs" role="status">
            Delivery is paused. It also pauses by itself when the sending Gmail account is disconnected. Nothing is lost: resume continues with whoever has not been sent to.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {stats.status === "DRAFT" && canQueue && (
            <>
              <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="h-8 w-56" aria-label="Schedule for" />
              {/* The time is read in THIS browser's time zone and stored as an exact UTC instant; say which zone, so nobody schedules for the wrong hour. */}
              <span className="text-xs text-muted-foreground" data-testid="schedule-timezone">Your time zone: {Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
              <Button size="sm" variant="outline" className="gap-1.5" disabled={pending || !when} onClick={() => run(() => queueCampaign(campaignId, new Date(when).toISOString()), "Campaign scheduled")}>
                <CalendarClock className="h-3.5 w-3.5" /> Schedule
              </Button>
            </>
          )}
          {ACTIVE.has(stats.status) && (
            <Button size="sm" variant="outline" className="gap-1.5" disabled={pending} onClick={() => run(() => pauseCampaignDelivery(campaignId), "Delivery paused")}>
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pause className="h-3.5 w-3.5" />} Pause
            </Button>
          )}
          {stats.status === "PAUSED" && (
            <Button size="sm" className="gap-1.5" disabled={pending} onClick={() => run(() => resumeCampaignDelivery(campaignId), "Delivery resumed")}>
              <Play className="h-3.5 w-3.5" /> Resume
            </Button>
          )}
          {(ACTIVE.has(stats.status) || stats.status === "PAUSED") && (
            <Button size="sm" variant="outline" className="gap-1.5 text-destructive hover:text-destructive" disabled={pending} onClick={() => setCancelOpen(true)}>
              <Ban className="h-3.5 w-3.5" /> Cancel
            </Button>
          )}
        </div>

        <ConfirmDialog
          open={cancelOpen}
          onOpenChange={setCancelOpen}
          title="Cancel this campaign?"
          description="Delivery stops for good. Messages already sent stay sent; the people still waiting will not be emailed. This cannot be undone."
          cancelLabel="Keep going"
          confirmLabel="Cancel campaign"
          onConfirm={async () => {
            const r = await cancelCampaignDelivery(campaignId);
            if (!r.ok) return { error: "The campaign could not be cancelled (it may have just finished)." };
            toast.success("Campaign cancelled");
            await refresh();
          }}
        />
      </CardContent>
    </Card>
  );
}
