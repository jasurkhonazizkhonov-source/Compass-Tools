"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Save, Pencil, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { updateQuoteInternalNotes } from "@/server/actions/quotes";

/**
 * Agent-only editor — reachable regardless of quote/booking status, but
 * (Pass 13 §5) no longer freely editable forever: once ANY value has been
 * saved, the fields lock into a read-only display, with a separate
 * explicit "Edit" action required to change them again. This is purely a
 * "reduce accidental edits" UX guard, not a security boundary — the
 * underlying updateQuoteInternalNotes server action is unchanged and still
 * accepts a write at any time from an authorized agent; a determined user
 * can always click Edit first. Never shown to the customer — not included
 * on the quote page, booking form, exchange form, cancellation form, or
 * any customer email (unchanged from before this pass).
 */
export function QuoteInternalNotesEditor({
  quoteId,
  internalNotes,
  netTicketCost,
}: {
  quoteId: string;
  internalNotes: string | null;
  netTicketCost: number | null;
}) {
  const [notes, setNotes] = useState(internalNotes ?? "");
  const [cost, setCost] = useState(netTicketCost != null ? String(netTicketCost) : "");
  // Starts locked only when something was already saved (a brand-new quote
  // with nothing entered yet opens directly in the editable state — there
  // is nothing to accidentally overwrite).
  const [locked, setLocked] = useState(internalNotes != null || netTicketCost != null);
  const [isPending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      try {
        await updateQuoteInternalNotes(quoteId, {
          internalNotes: notes || null,
          netTicketCost: cost ? Number(cost) : null,
        });
        toast.success("Internal notes saved");
        setLocked(true);
      } catch {
        toast.error("Failed to save internal notes");
      }
    });
  }

  function cancelEdit() {
    // Discards any unsaved changes and reverts the visible fields back to
    // the last-saved values — editing is opt-in via Edit, so backing out
    // of it should never leave stray typed text behind.
    setNotes(internalNotes ?? "");
    setCost(netTicketCost != null ? String(netTicketCost) : "");
    setLocked(true);
  }

  if (locked) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Never shown to the customer — not included on the quote page, booking form, or any customer email.
        </p>
        <div className="rounded-md border bg-muted/30 p-3 space-y-2.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <Lock className="h-3 w-3" aria-hidden /> Locked
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Net Ticket Cost</p>
            <p className="text-sm font-medium">{netTicketCost != null ? `$${netTicketCost.toFixed(2)}` : "Not set"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Notes</p>
            <p className="text-sm whitespace-pre-wrap">{internalNotes || "No notes"}</p>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => setLocked(false)} className="gap-1.5" aria-label="Edit internal notes">
          <Pencil className="h-3.5 w-3.5" /> Edit
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Never shown to the customer — not included on the quote page, booking form, or any customer email.
      </p>
      <div className="space-y-1.5">
        <Label htmlFor={`internal-net-ticket-cost-${quoteId}`} className="text-xs">Net Ticket Cost</Label>
        <Input id={`internal-net-ticket-cost-${quoteId}`} type="number" value={cost} onChange={(e) => setCost(e.target.value)} className="w-40" placeholder="0.00" disabled={isPending} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`internal-notes-${quoteId}`} className="text-xs">Notes</Label>
        <Textarea
          id={`internal-notes-${quoteId}`}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          placeholder="Supplier, fare rules, internal booking info..."
          disabled={isPending}
        />
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={save} disabled={isPending} className="gap-1.5">
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save
        </Button>
        {(internalNotes != null || netTicketCost != null) && (
          <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={isPending}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
