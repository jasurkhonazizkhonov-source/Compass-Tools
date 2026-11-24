"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { bulkEnrollInSequence, type BulkEnrollResult } from "@/server/actions/bulk-selection";
import { RecipientModeChoice } from "@/components/sequences/recipient-mode-choice";
import type { RecipientMode } from "@/server/sequence-recipients";
import type { BulkRecordKind } from "@/lib/bulk-selection";

export type BulkSequenceOption = { id: string; name: string; description: string | null; stepCount: number };

type Step = "choose" | "confirm" | "result";

/**
 * "Add to sequence" for the selected Leads / Contacts. Three steps in one dialog: choose an eligible sequence, confirm exactly what
 * will happen, then see the outcome per record. The enrollment itself is the existing one (enrollLeads, via bulkEnrollInSequence),
 * which re-checks the caller's permission, the sequence and every record on the server.
 */
export function BulkEnrollDialog({
  open,
  onOpenChange,
  kind,
  ids,
  sequences,
  onSettled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: BulkRecordKind;
  ids: readonly string[];
  sequences: BulkSequenceOption[];
  /** Selected ids that ended up enrolled (new or already) - the list deselects them and keeps the rest selected. */
  onSettled: (ids: readonly string[]) => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("choose");
  const [sequenceId, setSequenceId] = useState<string | undefined>(sequences[0]?.id);
  const [pending, setPending] = useState(false);
  const [recipientMode, setRecipientMode] = useState<RecipientMode>("primary");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Extract<BulkEnrollResult, { ok: true }> | null>(null);

  const chosen = sequences.find((s) => s.id === sequenceId);
  const count = ids.length;
  const noun = kind === "leads" ? (count === 1 ? "lead" : "leads") : count === 1 ? "contact" : "contacts";

  function handleOpenChange(next: boolean) {
    if (pending) return; // not dismissible while the request is running
    if (!next) {
      setStep("choose");
      setRecipientMode("primary");
      setError(null);
      setResult(null);
    }
    onOpenChange(next);
  }

  async function submit() {
    if (!sequenceId || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await bulkEnrollInSequence({ sequenceId, kind, ids: [...ids], recipientMode });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setResult(res);
      setStep("result");
      onSettled(res.settledIds);
      router.refresh();
      if (res.failed.length === 0) toast.success(`${res.enrolled} enrolled${res.alreadyEnrolled ? `, ${res.alreadyEnrolled} already in the sequence` : ""}.`);
    } catch {
      setError("Something went wrong. Nothing was changed - please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        {step === "choose" && (
          <>
            <DialogHeader>
              <DialogTitle>Add {count} {noun} to a sequence</DialogTitle>
              <DialogDescription>Choose an active sequence. Each {kind === "leads" ? "lead" : "contact"} receives its automated emails.</DialogDescription>
            </DialogHeader>
            {sequences.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">No active sequences with steps are available to you. Create one in the Sequences section first.</p>
            ) : (
              <RadioGroup value={sequenceId} onValueChange={setSequenceId} className="max-h-72 space-y-1 overflow-y-auto" aria-label="Sequence">
                {sequences.map((s) => (
                  <label key={s.id} className="flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm hover:bg-muted/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
                    <RadioGroupItem value={s.id} className="mt-0.5" />
                    <div className="min-w-0">
                      <p className="font-medium">{s.name}</p>
                      {s.description && <p className="truncate text-xs text-muted-foreground">{s.description}</p>}
                      <p className="text-xs text-muted-foreground">{s.stepCount} step{s.stepCount === 1 ? "" : "s"}</p>
                    </div>
                  </label>
                ))}
              </RadioGroup>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>Cancel</Button>
              <Button onClick={() => setStep("confirm")} disabled={!chosen}>Review</Button>
            </DialogFooter>
          </>
        )}

        {step === "confirm" && chosen && (
          <>
            <DialogHeader>
              <DialogTitle>Enroll {count} {noun}?</DialogTitle>
              <DialogDescription>
                {count} {noun} will be enrolled in <strong>{chosen.name}</strong> ({chosen.stepCount} step{chosen.stepCount === 1 ? "" : "s"}).
                {kind === "contacts" && " Contacts are enrolled through their most recent lead; a contact with no lead you can access is skipped."}
                {" "}Records already actively enrolled in this sequence are skipped, not enrolled twice.
              </DialogDescription>
            </DialogHeader>
            <RecipientModeChoice value={recipientMode} onChange={setRecipientMode} disabled={pending} />
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("choose")} disabled={pending}>Back</Button>
              <Button onClick={submit} disabled={pending} className="gap-2">
                {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                Enroll {count} {noun}
              </Button>
            </DialogFooter>
          </>
        )}

        {step === "result" && result && (
          <>
            <DialogHeader>
              <DialogTitle>{result.failed.length === 0 ? "Enrollment complete" : "Enrollment finished with problems"}</DialogTitle>
              <DialogDescription>Sequence: {result.sequenceName}</DialogDescription>
            </DialogHeader>
            <ul className="space-y-1 text-sm" data-testid="bulk-enroll-result">
              <li><strong>{result.enrolled}</strong> enrolled</li>
              <li><strong>{result.alreadyEnrolled}</strong> already in this sequence (skipped)</li>
              <li><strong>{result.failed.length}</strong> could not be enrolled</li>
            </ul>
            {result.withoutEmail > 0 && (
              <p className="text-sm text-muted-foreground">{result.withoutEmail} enrolled {result.withoutEmail === 1 ? "has" : "have"} no email address on file, so the sequence will mark {result.withoutEmail === 1 ? "it" : "them"} failed when it runs.</p>
            )}
            {result.failed.length > 0 && (
              <div className="text-sm" data-testid="bulk-enroll-failures">
                <p className="font-medium text-destructive">Not enrolled (still selected):</p>
                <ul className="max-h-40 list-disc overflow-y-auto pl-5 text-muted-foreground">
                  {result.failed.slice(0, 20).map((f) => (
                    <li key={f.id}>{f.label ?? "A selected record"} - {f.reason}</li>
                  ))}
                  {result.failed.length > 20 && <li>and {result.failed.length - 20} more</li>}
                </ul>
              </div>
            )}
            <DialogFooter>
              <Button onClick={() => handleOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
