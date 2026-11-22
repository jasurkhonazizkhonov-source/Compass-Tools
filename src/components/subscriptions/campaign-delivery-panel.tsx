"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pause, Play, CalendarClock, Ban, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/crm/confirm-dialog";
import { cancelCampaignDelivery, getCampaignAnalytics, pauseCampaignDelivery, queueCampaign, resumeCampaignDelivery, type CampaignAnalytics } from "@/server/actions/campaign-delivery";

const ACTIVE = new Set(["QUEUED", "SCHEDULED", "SENDING"]);
const POLL_MS = 10_000;

/**
 * The delivery CONTROLS of a campaign - Schedule, Pause, Resume, Cancel - and nothing else. The former "Delivery" information section (progress bar, Waiting / Sent / Failed /
 * Outcome unknown / Skipped tiles, the Gmail explanations and the sending-limit text) was removed from the page; the sending engine, the per-recipient records, the error handling
 * and the analytics server action are unchanged, and the campaign's status badge and the recipient history on the page still show where it stands.
 * Delivery itself happens in the background worker; this only asks the server to schedule, pause, resume or cancel. Renders nothing when no control applies (e.g. a finished campaign).
 */
export function CampaignDeliveryPanel({ campaignId, initial, canQueue }: { campaignId: string; initial: CampaignAnalytics; canQueue: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState<string>(initial.status);
  const [pending, startTransition] = useTransition();
  const [when, setWhen] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);

  // While delivery is active, notice a status change (e.g. QUEUED -> SENDING -> SENT) and refresh the page so the badge, the history and these controls follow it.
  useEffect(() => {
    if (!ACTIVE.has(status)) return;
    const id = setInterval(async () => {
      try {
        const next = await getCampaignAnalytics(campaignId);
        if (next && next.status !== status) {
          setStatus(next.status);
          router.refresh();
        }
      } catch {
        /* the next tick tries again */
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [campaignId, status, router]);

  async function refresh() {
    const next = await getCampaignAnalytics(campaignId);
    if (next) setStatus(next.status);
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

  const canSchedule = status === "DRAFT" && canQueue;
  const canPause = ACTIVE.has(status);
  const canResume = status === "PAUSED";
  const canCancel = ACTIVE.has(status) || status === "PAUSED";
  if (!canSchedule && !canPause && !canResume && !canCancel) return null;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="campaign-delivery-controls">
      {canSchedule && (
        <>
          <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="h-8 w-56" aria-label="Schedule for" />
          {/* The time is read in THIS browser's time zone and stored as an exact UTC instant; say which zone, so nobody schedules for the wrong hour. */}
          <span className="text-xs text-muted-foreground" data-testid="schedule-timezone">Your time zone: {Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
          <Button size="sm" variant="outline" className="gap-1.5" disabled={pending || !when} onClick={() => run(() => queueCampaign(campaignId, new Date(when).toISOString()), "Campaign scheduled")}>
            <CalendarClock className="h-3.5 w-3.5" /> Schedule
          </Button>
        </>
      )}
      {canPause && (
        <Button size="sm" variant="outline" className="gap-1.5" disabled={pending} onClick={() => run(() => pauseCampaignDelivery(campaignId), "Delivery paused")}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pause className="h-3.5 w-3.5" />} Pause
        </Button>
      )}
      {canResume && (
        <Button size="sm" className="gap-1.5" disabled={pending} onClick={() => run(() => resumeCampaignDelivery(campaignId), "Delivery resumed")}>
          <Play className="h-3.5 w-3.5" /> Resume
        </Button>
      )}
      {canCancel && (
        <Button size="sm" variant="outline" className="gap-1.5 text-destructive hover:text-destructive" disabled={pending} onClick={() => setCancelOpen(true)}>
          <Ban className="h-3.5 w-3.5" /> Cancel
        </Button>
      )}

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
    </div>
  );
}
