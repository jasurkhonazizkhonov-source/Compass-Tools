"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Eye, EyeOff, History, Info, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { revealBookingIp } from "@/server/actions/booking-security";
import { getBookingIpMaskedPreview, getIpHistoryForBooking, type IpVaultEntry, type IpVaultMaskedPreview } from "@/server/actions/ip-vault";

const REVEAL_TIMEOUT_SECONDS = 60;

const FORM_TYPE_LABEL: Record<string, string> = {
  NEW_BOOKING: "New Booking",
  EXCHANGE_BOOKING: "Exchange",
  CANCELLATION_CONFIRMATION: "Cancellation Confirmed",
};

function ipVersionOf(ip: string): "v4" | "v6" {
  return ip.includes(":") ? "v6" : "v4";
}

function VersionBadge({ version }: { version: "v4" | "v6" }) {
  return <span className="text-[10px] uppercase text-muted-foreground border rounded px-1 shrink-0">{version}</span>;
}

// "Not Captured" state, shown identically whether or not the viewer has
// Reveal access — nothing exists to reveal either way, and the reason is
// the same regardless of privilege level.
function NotCapturedNotice({ reason }: { reason: string }) {
  return (
    <div className="flex items-center gap-1">
      <p className="text-sm font-medium text-muted-foreground">Not captured</p>
      <Tooltip>
        <TooltipTrigger asChild>
          <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
        </TooltipTrigger>
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * Masked-by-default booking submission IP with a permission-gated Reveal
 * button — same pattern as PaymentMethodCard's PAN reveal: the resolved IP
 * is held only in this component's own local state (never a context,
 * global store, or any browser storage), cleared on auto-hide timeout,
 * manual Hide, or unmount.
 *
 * Extended to show a non-privileged MASKED preview (first octet/hextet
 * only, e.g. "24.x.x.x") to every viewer who can see the booking at all —
 * replacing the previous bare "Restricted" text, which showed zero
 * information — and, for Reveal-eligible viewers, a "History" panel
 * listing every signing event captured for this booking (new booking,
 * exchange, cancellation confirmation), not just the original signature.
 * When nothing was captured at all, an info tooltip explains why (almost
 * always: no trusted reverse proxy configured for this environment — see
 * request-ip.ts) instead of leaving the viewer to guess.
 */
export function BookingIpReveal({ bookingId, canReveal }: { bookingId: string; canReveal: boolean }) {
  const [revealed, setRevealed] = useState<{ ip: string; userAgent: string | null } | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(REVEAL_TIMEOUT_SECONDS);
  const [isPending, setIsPending] = useState(false);
  const [preview, setPreview] = useState<IpVaultMaskedPreview | null | undefined>(undefined);
  const [history, setHistory] = useState<IpVaultEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    getBookingIpMaskedPreview(bookingId)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [bookingId]);

  function clearTimer() {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }

  function hide() {
    clearTimer();
    setRevealed(null);
  }

  useEffect(() => clearTimer, []);

  async function reveal() {
    setIsPending(true);
    try {
      const result = await revealBookingIp(bookingId);
      setRevealed({ ip: result.ipAddress ?? "—", userAgent: result.userAgent });
      setSecondsLeft(REVEAL_TIMEOUT_SECONDS);
      clearTimer();
      intervalRef.current = setInterval(() => {
        setSecondsLeft((s) => {
          if (s <= 1) {
            clearTimer();
            setRevealed(null);
            return REVEAL_TIMEOUT_SECONDS;
          }
          return s - 1;
        });
      }, 1000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to reveal submission IP");
    } finally {
      setIsPending(false);
    }
  }

  async function toggleHistory() {
    if (history) {
      setHistory(null);
      return;
    }
    setHistoryLoading(true);
    try {
      const entries = await getIpHistoryForBooking(bookingId);
      setHistory(entries);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to load IP history");
    } finally {
      setHistoryLoading(false);
    }
  }

  if (preview === undefined) {
    return (
      <div>
        <p className="text-xs text-muted-foreground">Submission IP</p>
        <p className="text-sm font-medium text-muted-foreground">…</p>
      </div>
    );
  }

  if (!canReveal) {
    return (
      <div>
        <p className="text-xs text-muted-foreground">Submission IP</p>
        {preview && preview.masked !== null ? (
          <p className="text-sm font-medium font-mono flex items-center gap-1.5">
            {preview.masked}
            <VersionBadge version={preview.ipVersion} />
          </p>
        ) : preview ? (
          <NotCapturedNotice reason={preview.reason} />
        ) : (
          <p className="text-sm font-medium">Restricted</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {revealed ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-3 space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
            <ShieldAlert className="h-3.5 w-3.5" />
            Privileged view — auto-hides in {secondsLeft}s
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Submission IP</p>
            <p className="text-sm font-medium font-mono flex items-center gap-1.5">
              {revealed.ip}
              {revealed.ip !== "—" && <VersionBadge version={ipVersionOf(revealed.ip)} />}
            </p>
          </div>
          {revealed.userAgent && (
            <div>
              <p className="text-xs text-muted-foreground">User-Agent</p>
              <p className="text-xs font-mono break-all text-foreground/80">{revealed.userAgent}</p>
            </div>
          )}
          <Button size="sm" variant="outline" onClick={hide} className="gap-1.5">
            <EyeOff className="h-3.5 w-3.5" /> Hide
          </Button>
        </div>
      ) : preview && preview.masked !== null ? (
        <div>
          <p className="text-xs text-muted-foreground">Submission IP</p>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium font-mono flex items-center gap-1.5">
              {preview.masked}
              <VersionBadge version={preview.ipVersion} />
            </p>
            <Button size="sm" variant="outline" onClick={reveal} disabled={isPending} className="h-6 gap-1.5 px-2 text-xs">
              {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
              Reveal
            </Button>
          </div>
        </div>
      ) : preview ? (
        <div>
          <p className="text-xs text-muted-foreground">Submission IP</p>
          <NotCapturedNotice reason={preview.reason} />
        </div>
      ) : null}

      {preview && preview.count > 1 && (
        <Button size="sm" variant="ghost" onClick={toggleHistory} disabled={historyLoading} className="h-6 gap-1.5 px-2 text-xs text-muted-foreground">
          {historyLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <History className="h-3 w-3" />}
          {history ? "Hide" : "View"} full IP history ({preview.count} events)
        </Button>
      )}

      {history && (
        <div className="rounded-md border px-3 py-2 space-y-2">
          {history.map((entry) => (
            <div key={entry.id} className="text-xs border-b last:border-b-0 pb-2 last:pb-0">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground">{FORM_TYPE_LABEL[entry.formType] ?? entry.formType}</span>
                <span className="text-muted-foreground">{new Date(entry.capturedAt).toLocaleString()}</span>
              </div>
              <p className="font-mono text-foreground/80 flex items-center gap-1.5">
                {entry.ipAddress}
                <VersionBadge version={entry.ipVersion === "v6" ? "v6" : "v4"} />
              </p>
              {entry.signerEmail && <p className="text-muted-foreground">{entry.signerEmail}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
