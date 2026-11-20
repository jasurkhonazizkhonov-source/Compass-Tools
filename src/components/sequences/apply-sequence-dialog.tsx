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
import { GmailProblemNotice } from "@/components/sequences/gmail-problem-notice";
import { getSequenceStartReadiness, startSequenceForLead, type GmailBlock } from "@/server/actions/sequences";
import type { RecipientOption } from "@/lib/customer-email-mask";

type SequenceOption = { id: string; name: string; description: string | null; stepCount: number; firstStepDelayMinutes?: number };
type Blocked = { error: string; gmail?: GmailBlock };

/** "immediately", "in 30 minutes", "in 2 hours", "in 3 days" - the wait before step 1, as the approval prompt states it. */
function describeDelay(minutes: number): string {
  if (minutes <= 0) return "immediately";
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  if (minutes < 60 * 24) {
    const h = Math.round(minutes / 60);
    return `in ${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.round(minutes / (60 * 24));
  return `in ${d} day${d === 1 ? "" : "s"}`;
}

/**
 * Apply a sequence to ONE lead: choose the sequence -> the CRM checks that the Gmail account which sends this lead's emails can really send -> confirmation ->
 * "Approve and Start" (one action) | Cancel (nothing happens).
 *   - If Gmail cannot be used the user is told why, in the dialog, BEFORE any confirmation: nothing is enrolled, scheduled or sent, and after fixing it the same
 *     choice is simply made again ("Check again" / reconnect and come back to this lead).
 *   - Approving re-checks on the server (the authority) and enrolls; if the first step has no delay it is sent immediately, later steps are sent automatically by
 *     the scheduler. The result shown is what actually happened.
 */
export function ApplySequenceDialog({
  leadId,
  sequences,
  contactEmails: plainEmails = [],
  contactRecipients,
}: {
  leadId: string;
  sequences: SequenceOption[];
  /** Every email on file for this lead's contact, primary first — when
   * there's more than one, the agent picks which address (or both) this
   * sequence's automated sends go to (Part 4). */
  contactEmails?: string[];
  /** Customer-email privacy: the same list as opaque ids + the label the viewer may see (masked until revealed). When given, the server resolves the chosen ids to
   * addresses, so a restricted viewer's browser never holds them. */
  contactRecipients?: RecipientOption[];
}) {
  const options: RecipientOption[] = contactRecipients ?? plainEmails.map((a) => ({ id: a, display: a, address: a }));
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<"choose" | "confirm">("choose");
  const [selected, setSelected] = useState<string | undefined>(sequences[0]?.id);
  const [selectedEmails, setSelectedEmails] = useState<Set<string>>(new Set(options[0] ? [options[0].id] : []));
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sender, setSender] = useState<{ name: string; isViewer: boolean } | null>(null);
  const [checking, startChecking] = useTransition();
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const chosen = sequences.find((s) => s.id === selected);
  const recipients = options.length > 1 ? options.filter((o) => selectedEmails.has(o.id)).map((o) => o.display) : options.slice(0, 1).map((o) => o.display);

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
    setBlocked(null);
    setSender(null);
  }

  function review() {
    if (!selected) {
      toast.error("Select a sequence");
      return;
    }
    if (options.length > 1 && selectedEmails.size === 0) {
      toast.error("Select at least one recipient email");
      return;
    }
    setProblem(null);
    setBlocked(null);
    startChecking(async () => {
      try {
        const readiness = await getSequenceStartReadiness(selected, leadId);
        if (!readiness.ok) {
          setBlocked({ error: readiness.error, gmail: readiness.gmail });
          return;
        }
        setSender({ name: readiness.senderName, isViewer: readiness.senderIsViewer });
        setStage("confirm");
      } catch {
        setBlocked({ error: "Gmail and the sequence could not be checked right now. Nothing was changed - try again in a moment." });
      }
    });
  }

  function approve() {
    if (!selected || isPending) return;
    const chosenIds = options.length > 1 ? [...selectedEmails] : [];
    // Opaque ids when the server supplied them (the server resolves the addresses); plain addresses only for callers that were given plain addresses.
    const recipientEmail = !contactRecipients && chosenIds.length > 0 ? chosenIds.join(", ") : undefined;
    const recipientIds = contactRecipients && chosenIds.length > 0 ? chosenIds : undefined;
    setProblem(null);
    startTransition(async () => {
      try {
        const result = recipientIds ? await startSequenceForLead(selected, leadId, undefined, recipientIds) : await startSequenceForLead(selected, leadId, recipientEmail);
        if (!result.ok) {
          // Gmail stopped working between the check and the approval: back to the chooser with the same notification. Nothing was enrolled.
          if (result.gmail) {
            setBlocked({ error: result.error, gmail: result.gmail });
            setStage("choose");
            return;
          }
          setProblem(result.error);
          if (result.code === "ALREADY_ENROLLED" || result.code === "SEND_FAILED") router.refresh();
          return;
        }
        const when = result.nextSendAt ? format(new Date(result.nextSendAt), "MMM d, yyyy 'at' h:mm a") : null;
        if (result.firstStep === "sent") toast.success(`"${result.sequenceName}" started - the first email was sent${when ? `; the next goes out ${when}` : ""}.`);
        else if (result.firstStep === "scheduled") toast.success(`"${result.sequenceName}" started - the first email is scheduled${when ? ` for ${when}` : ""} and will be sent automatically.`);
        else if (result.firstStep === "unconfirmed")
          toast.warning(`"${result.sequenceName}" started, but Gmail did not confirm whether the first email was sent. It was not resent - open the lead to decide.`);
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
              <RadioGroup
                value={selected}
                onValueChange={(v) => {
                  setSelected(v);
                  setBlocked(null);
                }}
                className="max-h-72 overflow-y-auto space-y-1"
              >
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
            {options.length > 1 && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Send automated emails to</label>
                <div className="space-y-1 rounded-md border p-2">
                  {options.map((o) => (
                    <label key={o.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted/50 cursor-pointer">
                      <Checkbox checked={selectedEmails.has(o.id)} onCheckedChange={() => toggleRecipient(o.id)} />
                      <span className="truncate">{o.display}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {blocked?.gmail && <GmailProblemNotice gmail={blocked.gmail} message={blocked.error} leadId={leadId} onCheckAgain={review} checking={checking} />}
            {blocked && !blocked.gmail && (
              <p role="alert" data-testid="start-blocked" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {blocked.error}
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={close}>Cancel</Button>
              <Button onClick={review} disabled={sequences.length === 0 || checking} className="gap-2">
                {checking && <Loader2 className="h-4 w-4 animate-spin" />}
                {checking ? "Checking Gmail..." : "Continue"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Start this email sequence?</DialogTitle>
              <DialogDescription>Nothing is sent or enrolled until you approve.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2 text-sm" data-testid="sequence-approval">
              <p>
                The lead will be enrolled in <strong>{chosen?.name}</strong> ({chosen?.stepCount} step{chosen?.stepCount === 1 ? "" : "s"}). The first eligible email will be sent{" "}
                {describeDelay(chosen?.firstStepDelayMinutes ?? 0)}, and the remaining steps will be sent automatically according to the sequence schedule.
              </p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>
                  Sent from {sender?.isViewer ? "your Gmail" : `${sender?.name ?? "the assigned agent"}'s Gmail`}
                  {recipients.length > 0 ? ` to ${recipients.join(", ")}` : ""}.
                </li>
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
                Approve and Start
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
