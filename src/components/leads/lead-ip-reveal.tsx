"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Eye, EyeOff, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { revealLeadSubmissionIp } from "@/server/actions/lead-submission";
import { safeActionMessage } from "@/lib/safe-action-message";
import { useTimedReveal } from "@/components/bookings/use-timed-reveal";

/**
 * The submitting IP of a lead: masked by default for everyone ("203.x.x.x"), with a Reveal only for
 * accounts that hold the IP-reveal permission. The full address is fetched on click through the
 * audited, recent-sign-in-gated server action, held only in this component's state (never storage, a
 * URL or a global), and concealed after the timer, on tab change / blur and on unmount — the same
 * pattern as the booking signer's IP. A refusal is shown inline (a returned message), never as an
 * opaque thrown error.
 */
export function LeadIpReveal({ leadId, masked, canReveal }: { leadId: string; masked: string; canReveal: boolean }) {
  const { value: revealed, secondsLeft, show, hide } = useTimedReveal<{ ip: string; version: "v4" | "v6" }>(30);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reveal() {
    setPending(true);
    setError(null);
    try {
      const result = await revealLeadSubmissionIp(leadId);
      if ("error" in result) {
        setError(result.error);
        toast.error(result.error, { duration: 8000 });
        return;
      }
      show({ ip: result.ipAddress, version: result.ipVersion });
    } catch (err) {
      const message = safeActionMessage(err, "Unable to reveal the submission IP. You may not have permission.");
      setError(message);
      toast.error(message);
    } finally {
      setPending(false);
    }
  }

  if (revealed) {
    return (
      <div className="space-y-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 dark:border-amber-800 dark:bg-amber-950/30" data-testid="lead-ip-revealed">
        <p className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
          <ShieldAlert className="h-3.5 w-3.5" /> Full IP address — privileged view, auto-hides in {secondsLeft}s
        </p>
        <p className="text-sm font-medium">
          <span className="font-mono break-all">{revealed.ip}</span>
        </p>
        <Button size="sm" variant="outline" onClick={hide} className="h-6 gap-1.5 px-2 text-xs">
          <EyeOff className="h-3 w-3" /> Hide
        </Button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium font-mono break-all">{masked}</span>
        {canReveal && (
          <Button size="sm" variant="outline" onClick={reveal} disabled={pending} className="h-6 gap-1.5 px-2 text-xs">
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
            {pending ? "Revealing…" : "Reveal"}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-destructive break-words">
          {error}
        </p>
      )}
    </div>
  );
}
