"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Eye, EyeOff, Loader2, ShieldAlert, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/crm/confirm-dialog";
import { revealBookingCvv, destroyBookingCvv } from "@/server/actions/booking-cvv";
import { safeActionMessage } from "@/lib/safe-action-message";
import { useTimedReveal } from "./use-timed-reveal";

/**
 * Admin-only "Reveal CVV/CVC" for one booking card, shown under the existing "Reveal Card Information". It is rendered ONLY when
 * the server decided the viewer is an Admin who may use it (the page passes `available` / `unavailable`; for everyone else the
 * prop is absent and nothing — not even a hidden node — is rendered). The code is NOT in the page data: it is fetched by the
 * dedicated server action when the Admin clicks, held in this component's state only, hidden after 30 seconds (and when the tab is
 * hidden, the window blurs or the component unmounts — useTimedReveal), never written to storage, the URL or the clipboard.
 * Hiding it here does NOT destroy it: the stored value stays until the payment is recorded, an Admin destroys it, or 24 hours after
 * the Booking Form was signed. Revealing never extends that deadline.
 */
export function CvvReveal({
  bookingId,
  paymentMethodId,
  state,
}: {
  bookingId: string;
  paymentMethodId: string;
  state: { available: true; expiresAt: string } | { available: false };
}) {
  const router = useRouter();
  const { value: revealed, secondsLeft, show, hide } = useTimedReveal<{ cvv: string }>();
  const [isPending, setIsPending] = useState(false);
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const [gone, setGone] = useState(!state.available);

  async function reveal() {
    setIsPending(true);
    try {
      const result = await revealBookingCvv(bookingId, paymentMethodId);
      if ("error" in result) {
        toast.error(result.error, { duration: 8000 });
        if (/no longer available/i.test(result.error)) setGone(true);
        return;
      }
      show({ cvv: result.cvv });
    } catch (err) {
      toast.error(safeActionMessage(err, "Unable to reveal the CVV/CVC. Only an Administrator with Reveal permission can do this."));
    } finally {
      setIsPending(false);
    }
  }

  async function destroy() {
    try {
      const result = await destroyBookingCvv(bookingId, paymentMethodId);
      if ("error" in result) return { error: result.error };
    } catch (err) {
      return { error: safeActionMessage(err, "Could not destroy the CVV/CVC.") };
    }
    hide();
    setGone(true);
    toast.success("CVV/CVC destroyed");
    router.refresh();
  }

  if (gone) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="cvv-unavailable">
        CVV/CVC no longer available — it is kept for at most 24 hours after the Booking Form is signed.
      </p>
    );
  }

  return (
    <div data-testid="cvv-reveal">
      {revealed ? (
        <div
          className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-3 space-y-3 select-none"
          onCopy={(e) => e.preventDefault()}
          onCut={(e) => e.preventDefault()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
            <ShieldAlert className="h-3.5 w-3.5" />
            Privileged view — auto-hides in {secondsLeft}s
          </div>
          <div>
            <p className="text-xs text-muted-foreground">CVV/CVC</p>
            <p className="text-sm font-medium font-mono" data-testid="cvv-value">{revealed.cvv}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={hide} className="gap-1.5">
              <EyeOff className="h-3.5 w-3.5" /> Hide CVV/CVC
            </Button>
            <Button size="sm" variant="outline" onClick={() => setConfirmDestroy(true)} className="gap-1.5 text-destructive hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5" /> Destroy CVV/CVC
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={reveal} disabled={isPending} className="gap-1.5">
            {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
            Reveal CVV/CVC
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmDestroy(true)} className="gap-1.5 text-muted-foreground hover:text-destructive">
            <Trash2 className="h-3.5 w-3.5" /> Destroy CVV/CVC
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirmDestroy}
        onOpenChange={setConfirmDestroy}
        title="Destroy CVV/CVC?"
        description="This permanently removes the stored CVV/CVC for this card. It cannot be recovered afterward."
        confirmLabel="Destroy CVV/CVC"
        onConfirm={destroy}
      />
    </div>
  );
}
