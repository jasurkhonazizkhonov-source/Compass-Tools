"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Mail, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { enrollLeads } from "@/server/actions/sequences";

type SequenceOption = { id: string; name: string; description: string | null; stepCount: number };

export function ApplySequenceDialog({
  leadId,
  sequences,
  contactEmails = [],
}: {
  leadId: string;
  sequences: SequenceOption[];
  /** Every email on file for this lead's contact, primary first — when
   * there's more than one, the agent picks which address (or both) this
   * sequence's automated sends go to (Part 4). */
  contactEmails?: string[];
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | undefined>(sequences[0]?.id);
  const [selectedEmails, setSelectedEmails] = useState<Set<string>>(new Set(contactEmails[0] ? [contactEmails[0]] : []));
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function toggleRecipient(addr: string) {
    setSelectedEmails((prev) => {
      const next = new Set(prev);
      if (next.has(addr)) next.delete(addr);
      else next.add(addr);
      return next;
    });
  }

  function submit() {
    if (!selected) {
      toast.error("Select a sequence");
      return;
    }
    if (contactEmails.length > 1 && selectedEmails.size === 0) {
      toast.error("Select at least one recipient email");
      return;
    }
    const recipientEmail = contactEmails.length > 1 ? [...selectedEmails].join(", ") : undefined;
    startTransition(async () => {
      const result = await enrollLeads(selected, [leadId], recipientEmail);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      if (result.enrolled === 0) {
        toast.error("This lead is already actively enrolled in that sequence");
        return;
      }
      toast.success("Sequence applied");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5">
          <Mail className="h-3.5 w-3.5" /> Apply Sequence
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Apply Sequence</DialogTitle>
          <DialogDescription>Choose a saved sequence to enroll this lead in.</DialogDescription>
        </DialogHeader>
        {sequences.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            No active sequences with steps exist yet — create one in the Sequences section first.
          </p>
        ) : (
          <RadioGroup value={selected} onValueChange={setSelected} className="max-h-72 overflow-y-auto space-y-1">
            {sequences.map((s) => (
              <label
                key={s.id}
                className="flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm cursor-pointer hover:bg-muted/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
              >
                <RadioGroupItem value={s.id} className="mt-0.5" />
                <div className="min-w-0">
                  <p className="font-medium">{s.name}</p>
                  {s.description && <p className="text-xs text-muted-foreground truncate">{s.description}</p>}
                  <p className="text-xs text-muted-foreground">{s.stepCount} step{s.stepCount === 1 ? "" : "s"}</p>
                </div>
              </label>
            ))}
          </RadioGroup>
        )}
        {contactEmails.length > 1 && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Send automated emails to</label>
            <div className="space-y-1 rounded-md border p-2">
              {contactEmails.map((addr) => (
                <label key={addr} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted/50 cursor-pointer">
                  <Checkbox checked={selectedEmails.has(addr)} onCheckedChange={() => toggleRecipient(addr)} />
                  <span className="truncate">{addr}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={isPending || sequences.length === 0} className="gap-2">
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
