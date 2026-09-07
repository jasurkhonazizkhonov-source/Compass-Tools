"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Ban, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { sendCancellationForApproval } from "@/server/actions/cancellation";

type SegmentOption = {
  id: string;
  label: string;
};

/**
 * Charged-quote-only cancellation request — segment checkboxes (one per
 * individual flight leg, never a single "cancel everything" toggle),
 * cancellation fee/PNR/internal notes, and a single Send for Approval
 * action. Nothing is persisted until that's clicked — closing this dialog
 * (Cancel) leaves the quote completely untouched, matching Exchange's own
 * "nothing written until Send for Approval" design.
 */
export function CancellationDialog({ quoteId, segments, currency = "USD" }: { quoteId: string; segments: SegmentOption[]; currency?: string }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cancellationFee, setCancellationFee] = useState("");
  const [pnr, setPnr] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => (prev.size === segments.length ? new Set() : new Set(segments.map((s) => s.id))));
  }

  function handleSubmit() {
    if (selected.size === 0) {
      toast.error("Select at least one flight segment to cancel.");
      return;
    }
    startTransition(async () => {
      try {
        await sendCancellationForApproval({
          quoteId,
          segmentIds: [...selected],
          cancellationFee: cancellationFee ? Number(cancellationFee) : undefined,
          pnr: pnr || undefined,
          internalNotes: internalNotes || undefined,
        });
        toast.success("Cancellation sent for approval");
        setOpen(false);
        setSelected(new Set());
        setCancellationFee("");
        setPnr("");
        setInternalNotes("");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not submit the cancellation request");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* Wrapped in DialogTrigger (matching every other dialog in this app —
          new-lead-dialog.tsx, new-account-dialog.tsx, etc.) rather than a
          plain onClick={() => setOpen(true)} button: Radix only knows to
          restore keyboard focus to the trigger on close for an element it
          registered as its own trigger. A manually-opened button outside
          that registration left focus falling back to <body> on close (no
          onClick needed anymore — DialogTrigger opens the dialog itself,
          and the controlled open/onOpenChange state above is unaffected). */}
      <DialogTrigger asChild>
        <Button variant="destructive" size="sm" className="gap-1.5">
          <Ban className="h-3.5 w-3.5" /> Cancellation
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Request Cancellation</DialogTitle>
          <DialogDescription>
            Select which flight segment(s) to cancel. This does not cancel the whole itinerary unless every segment is selected.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium text-muted-foreground">Flight segments</Label>
              <button type="button" onClick={toggleAll} className="text-xs text-primary hover:underline">
                {selected.size === segments.length ? "Deselect all" : "Select all"}
              </button>
            </div>
            <div className="space-y-1 rounded-md border p-2">
              {segments.map((s) => (
                <label key={s.id} className="flex items-center gap-2 rounded px-1.5 py-1.5 text-sm hover:bg-muted/50 cursor-pointer">
                  <Checkbox checked={selected.has(s.id)} onCheckedChange={() => toggle(s.id)} />
                  <span className="truncate">{s.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cancellation-fee" className="text-xs font-medium text-muted-foreground">Cancellation Fee ({currency})</Label>
              <Input id="cancellation-fee" type="number" min="0" step="0.01" value={cancellationFee} onChange={(e) => setCancellationFee(e.target.value)} placeholder="0.00" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cancellation-pnr" className="text-xs font-medium text-muted-foreground">PNR Information</Label>
              <Input id="cancellation-pnr" value={pnr} onChange={(e) => setPnr(e.target.value)} placeholder="Internal only" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cancellation-notes" className="text-xs font-medium text-muted-foreground">Internal Notes</Label>
            <Textarea id="cancellation-notes" value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} placeholder="Never shown to the customer" rows={3} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleSubmit} disabled={isPending} className="gap-1.5">
            {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Send for Approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
