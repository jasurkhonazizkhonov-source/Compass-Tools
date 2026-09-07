"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Users, Loader2 } from "lucide-react";
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
import { reassignContact } from "@/server/actions/contacts";

type Agent = { id: string; fullName: string };
type AttachedLead = { id: string; route: string; ownerName: string | null };

export function ReassignContactDialog({
  contactId,
  contactName,
  currentOwnerId,
  currentOwnerName,
  leads,
  agents,
  trigger,
}: {
  contactId: string;
  contactName: string;
  /** The Contact's current owner — shown explicitly per Pass 7's
   * reassignment UI spec, and used to exclude the current owner from the
   * "New Owner" picker (reassigning to the same owner is never useful). */
  currentOwnerId?: string | null;
  currentOwnerName?: string | null;
  leads: AttachedLead[];
  agents: Agent[];
  /** Custom trigger element (e.g. a compact icon button for a table row) —
   * overrides the default full "Reassign Contact" button when provided. */
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [newOwnerId, setNewOwnerId] = useState("");
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();
  const selectableAgents = agents.filter((a) => a.id !== currentOwnerId);
  // Pass 10 §25 — an unassigned Contact is a valid, first-class ownership
  // state (e.g. every Bulk-Contacts-imported row with no assignedAgentId
  // set per row) — this is still the same reassignContact() call either
  // way, only the wording changes.
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
    if (!reason.trim()) {
      toast.error("A reason is required");
      return;
    }
    startTransition(async () => {
      try {
        await reassignContact(contactId, newOwnerId, reason.trim());
        toast.success(`${contactName} ${isAssign ? "assigned" : "reassigned"}`);
        reset();
        setOpen(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to assign contact");
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
        {trigger ?? (
          <Button variant="outline" className="gap-1.5">
            <Users className="h-4 w-4" /> {isAssign ? "Assign Contact" : "Reassign Contact"}
          </Button>
        )}
      </span>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isAssign ? "Assign Contact" : "Reassign Contact"}</DialogTitle>
          <DialogDescription>{contactName}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
            <span className="text-muted-foreground">Current owner: </span>
            <span className="font-medium">{currentOwnerName ?? "Unassigned"}</span>
          </div>
          {leads.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs">
                Attached leads ({leads.length})
              </Label>
              <div className="rounded-md border divide-y max-h-40 overflow-y-auto">
                {leads.map((l) => (
                  <div key={l.id} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span>{l.route}</span>
                    <span className="text-xs text-muted-foreground">{l.ownerName ?? "Unassigned"}</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Contact and Lead ownership are independent — these leads keep their own current owner shown above. Only the contact record itself moves to the new owner.
              </p>
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="reassign-contact-new-owner">{isAssign ? "Assign to" : "New Owner"}</Label>
            <Select value={newOwnerId} onValueChange={setNewOwnerId}>
              <SelectTrigger id="reassign-contact-new-owner" className="w-full"><SelectValue placeholder="Select CRM user" /></SelectTrigger>
              <SelectContent>
                {selectableAgents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.fullName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="reassign-contact-reason">Reason</Label>
            <Textarea
              id="reassign-contact-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="e.g. Sarah is on vacation, transferring her workload to Michael."
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
