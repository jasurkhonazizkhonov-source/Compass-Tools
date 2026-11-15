"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
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
import { startSequenceForLead } from "@/server/actions/sequences";

type SequenceOption = { id: string; name: string; description: string | null; stepCount: number; firstStepDelayMinutes?: number };

/** "right away", "in 30 minutes", "in 2 hours", "in 3 days" - the wait before step 1, as the approval prompt states it. */
function describeDelay(minutes: number): string {
  if (minutes <= 0) return "right away";
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  if (minutes < 60 * 24) {
    const h = Math.round(minutes / 60);
    return `in ${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.round(minutes / (60 * 24));
  return `in ${d} day${d === 1 ? "" : "s"}`;
}

/**
 * Apply a sequence to ONE lead in a single approved action: choose the sequence, review the confirmation, press "Approve and start". Cancel at any point
 * enrolls nothing and sends nothing. Approving enrolls the lead and, if step 1 has no delay, sends it immediately; later steps are sent automatically by
 * the scheduler - there is no separate "process due" step for the user. The server action does every check and reports exactly what happened.
 */
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
  const [stage, setStage] = useState<"choose" | "confirm">("choose");
  const [selected, setSelected] = useState<string | undefined>(sequences[0]?.id);
  const [selectedEmails, setSelectedEmails] = useState<Set<string>>(new Set(contactEmails[0] ? [contactEmails[0]] : []));
  const [problem, setProblem] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const chosen = sequences.find((s) => s.id === selected);
  const recipients = contactEmails.length > 1 ? [...selectedEmails] : contactEmails.slice(0, 1);

  function toggleRecipient(addr: string) {
    setSelectedEmails((prev) => {
      const next = new Set(prev);
      if (next.has(addr)) next.delete(addr);
      else next.add(addr);
      return next;
    });
  }

  function close() {
    setOpen(false);
    setStage("choose");
    setProblem(null);
  }

  function review() {
    if (!selected) {
      toast.error("Select a sequence");
      return;
    }
    if (contactEmails.length > 1 && selectedEmails.size === 0) {
      toast.error("Select at least one recipient email");
      return;
    }
    setProblem(null);
    setStage("confirm");
  }

  function approve() {
    if (!selected || isPending) return;
    const recipientEmail = contactEmails.length > 1 ? [...selectedEmails].join(", ") : undefined;
    setProblem(null);
    startTransition(async () => {
      try {
        const result = await startSequenceForLead(selected, leadId, recipientEmail);
        if (!result.ok) {
          // Stay in the dialog and say exactly why nothing (or nothing more) happened.
          setProblem(result.error);
          if (result.code === "ALREADY_ENROLLED" || result.code === "SEND_FAILED") router.refresh();
          return;
        }
        const when = result.nextSendAt ? format(new Date(result.nextSendAt), "MMM d, yyyy 'at' h:mm a") : null;
        if (result.firstStep === "sent") toast.success(`"${result.sequenceName}" started - the first email was sent${when ? `; the next goes out ${when}` : ""}.`);
        else if (result.firstStep === "scheduled") toast.success(`"${result.sequenceName}" started - the first email is scheduled${when ? ` for ${when}` : ""} and will be sent automatically.`);
        else toast.warning(`"${result.sequenceName}" started, but the first email could not be sent yet (${result.note ?? "temporary problem"}). It will be retried automatically${when ? ` at ${when}` : ""}.`);
        close();
        router.refresh();
      } catch {
        // A thrown action (session expired, network) - nothing is known to have happened, so do not claim success; refresh so the lead shows the truth.
        setProblem("Something went wrong and the result is not known. Check this lead's sequences below before trying again.");
        router.refresh();
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5">
          <Mail className="h-3.5 w-3.5" /> Apply Sequence
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {stage === "choose" ? (
          <>
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
              <Button variant="outline" onClick={close}>Cancel</Button>
              <Button onClick={review} disabled={sequences.length === 0}>Continue</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Start this sequence?</DialogTitle>
              <DialogDescription>Nothing is sent or enrolled until you approve.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2 text-sm" data-testid="sequence-approval">
              <p>
                Start <strong>{chosen?.name}</strong> ({chosen?.stepCount} step{chosen?.stepCount === 1 ? "" : "s"}) for this lead?
              </p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>The first email will be sent {describeDelay(chosen?.firstStepDelayMinutes ?? 0)}{recipients.length > 0 ? ` to ${recipients.join(", ")}` : ""}.</li>
                <li>Each later step is sent automatically at its own delay - you do not need to do anything else.</li>
                <li>You can unenroll the lead at any time from this page; nothing more is sent afterwards.</li>
              </ul>
            </div>
            {problem && (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {problem}
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={close} disabled={isPending}>Cancel</Button>
              <Button onClick={approve} disabled={isPending} className="gap-2">
                {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Approve and start
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
