"use client";

import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { reassignLead } from "@/server/actions/leads";

type Agent = { id: string; fullName: string };

/** Compact single-lead reassignment dialog — reuses the exact same
 * reassignLead() server action as the Lead detail page's inline
 * "Assigned Agent" edit (CrmMetaCard), just with a different UI entry
 * point for the Leads list row, where there's no room for an inline
 * dropdown. Not a second reassignment system — one action, two triggers. */
export function ReassignLeadDialog({
  leadId,
  leadLabel,
  currentOwnerId,
  currentOwnerName,
  agents,
  trigger,
}: {
  leadId: string;
  leadLabel: string;
  /** Excluded from the "New Owner" picker — reassigning to the same owner
   * is never useful (Pass 7 reassignment UI consistency with Contact's own
   * dialog). */
  currentOwnerId?: string | null;
  currentOwnerName: string | null;
  agents: Agent[];
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [newOwnerId, setNewOwnerId] = useState("");
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();
  const selectableAgents = agents.filter((a) => a.id !== currentOwnerId);
  // Pass 10 §25 — an unassigned Lead is a valid, first-class ownership
  // state, not an edge case requiring a different mechanism: this is still
  // the exact same reassignLead() call either way, only the wording changes
  // ("Assign" reads more naturally than "Reassign" when there was no prior
  // owner to reassign FROM).
  const isAssign = !currentOwnerId;

  function reset() {
    setNewOwnerId("");
    setReason("");
  }

  function submit() {
    if (!newOwnerId) {
      toast.error("Select a new owner");
      return;
    }
    startTransition(async () => {
      try {
        await reassignLead(leadId, newOwnerId, reason.trim() || undefined);
        toast.success(`${leadLabel} ${isAssign ? "assigned" : "reassigned"}`);
        reset();
        setOpen(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to assign lead");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <span
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {trigger}
      </span>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isAssign ? "Assign Lead" : "Reassign Lead"}</DialogTitle>
          <DialogDescription>{leadLabel}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
            <span className="text-muted-foreground">Current owner: </span>
            <span className="font-medium">{currentOwnerName ?? "Unassigned"}</span>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="reassign-lead-new-owner">{isAssign ? "Assign to" : "New Owner"}</Label>
            <Select value={newOwnerId} onValueChange={setNewOwnerId}>
              <SelectTrigger id="reassign-lead-new-owner" className="w-full"><SelectValue placeholder="Select CRM user" /></SelectTrigger>
              <SelectContent>
                {selectableAgents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.fullName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="reassign-lead-reason">Reason (optional)</Label>
            <Textarea
              id="reassign-lead-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="e.g. Reassigning while Sarah is on vacation."
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>Cancel</Button>
          <Button onClick={submit} disabled={isPending} className="gap-1.5">
            {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {isAssign ? "Assign" : "Reassign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
