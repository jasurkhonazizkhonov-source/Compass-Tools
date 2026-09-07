"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { BellRing, Loader2, Mail, Phone, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { getMyLeadOffer, acceptLeadOffer, skipLeadOffer } from "@/server/actions/lead-queue";
import { leadSourceLabel } from "@/lib/status-meta";
import { formatPhoneInternational } from "@/lib/phone";
import type { LeadSource } from "@/generated/prisma/client";

type Offer = {
  leadId: string;
  contactName: string;
  email: string | null;
  phone: string | null;
  source: LeadSource;
  route: string | null;
  offerExpiresAt: string;
};

// Same polling pattern as the rest of this CRM's "realtime" (NotificationBell,
// the old LeadQueueToggle position) — no new realtime architecture. Every
// poll doubles as the opportunistic expiry sweep (see getMyLeadOffer's doc
// comment — there's no reliable cron for this in the current deployment).
const POLL_INTERVAL_MS = 3_000;

function secondsLeft(expiresAt: string): number {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

// Short, subtle two-tone chime synthesized via the Web Audio API — no
// bundled audio asset needed. Wrapped in try/catch since some browsers
// block audio playback before any user gesture on the page; a blocked
// chime is a silent no-op, never a console error or a thrown exception.
function playOfferChime() {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    [880, 1175].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = now + i * 0.12;
      const end = start + 0.15;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.15, start + 0.02);
      gain.gain.linearRampToValueAtTime(0, end);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(end);
    });
    setTimeout(() => ctx.close().catch(() => undefined), 500);
  } catch {
    // Autoplay blocked or Web Audio unavailable — never surfaced to the user.
  }
}

export function LeadOfferModal({ accountId }: { accountId: string | undefined }) {
  const router = useRouter();
  const [offer, setOffer] = useState<Offer | null>(null);
  const [, forceTick] = useState(0);
  const [isPending, startTransition] = useTransition();
  // Tracks which offer's chime has already played, so re-renders and polls
  // that return the SAME offer never replay it — only a genuinely new
  // leadId (or the modal going away and a different one arriving) does.
  const chimedForLeadId = useRef<string | null>(null);

  // The countdown is always derived from the server's offerExpiresAt, never
  // from a client-side timer that could be reset — a refresh, a new tab, or
  // a dropped connection all just re-sync to the same authoritative value
  // on the next poll instead of restarting the clock.
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    async function poll() {
      try {
        const result = await getMyLeadOffer();
        if (!cancelled) setOffer(result);
      } catch {
        // Transient — next interval tick retries.
      }
    }
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [accountId]);

  useEffect(() => {
    if (!offer) return;
    const tick = setInterval(() => forceTick((t) => t + 1), 1000);
    return () => clearInterval(tick);
  }, [offer]);

  // Plays once per distinct offer — never on every poll/render while the
  // same offer is still showing, never during the countdown itself.
  useEffect(() => {
    if (!offer || chimedForLeadId.current === offer.leadId) return;
    chimedForLeadId.current = offer.leadId;
    playOfferChime();
  }, [offer]);

  if (!accountId || !offer) return null;

  const remaining = secondsLeft(offer.offerExpiresAt);
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const expired = remaining <= 0;

  function handleAccept() {
    if (!offer) return;
    startTransition(async () => {
      const result = await acceptLeadOffer(offer.leadId);
      if (result.ok) {
        toast.success("Lead accepted");
        setOffer(null);
        router.push(`/leads/${offer.leadId}`);
      } else {
        toast.error(result.error);
        setOffer(null); // someone else's window won, or it expired — clear it, the next poll will resync
      }
    });
  }

  function handleSkip() {
    if (!offer) return;
    startTransition(async () => {
      const result = await skipLeadOffer(offer.leadId);
      if (result.ok) {
        toast.info("Lead skipped — offered to the next agent");
      }
      setOffer(null); // either way, this offer is no longer ours — next poll resyncs
    });
  }

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BellRing className="h-4 w-4 text-primary" />
            New Lead Available
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5">
            <p className="font-medium text-sm">{offer.contactName}</p>
            {offer.email && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Mail className="h-3 w-3" /> {offer.email}
              </p>
            )}
            {offer.phone && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Phone className="h-3 w-3" /> {formatPhoneInternational(offer.phone)}
              </p>
            )}
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Tag className="h-3 w-3" /> {leadSourceLabel(offer.source)}
              {offer.route ? ` · ${offer.route}` : ""}
            </p>
          </div>

          <div className="text-center">
            <div className="font-mono text-4xl font-semibold tabular-nums tracking-tight">
              {expired ? "00:00" : `${minutes}:${String(seconds).padStart(2, "0")}`}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {expired ? "Offer expired" : "to accept this lead"}
            </p>
          </div>
        </div>

        <DialogFooter className="sm:flex-col gap-2">
          <Button className="w-full gap-1.5" disabled={isPending || expired} onClick={handleAccept}>
            {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Accept Lead
          </Button>
          <Button variant="outline" className="w-full" disabled={isPending} onClick={handleSkip}>
            Skip
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
