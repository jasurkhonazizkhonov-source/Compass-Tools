"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { RecipientModeChoice } from "@/components/sequences/recipient-mode-choice";
import { enrollContactsBatch, previewEnrollAllContacts, type EnrollAllContactsPreview } from "@/server/actions/sequence-enroll-contacts";
import type { RecipientMode } from "@/server/sequence-recipients";

const n = (v: number) => v.toLocaleString("en-US");
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

type Totals = {
  processed: number;
  enrolled: number;
  alreadyEnrolled: number;
  missingEmail: number;
  addressSuppressed: number;
  noAssignedAgent: number;
  gmailUnavailable: number;
  inaccessible: number;
  failedOther: number;
};
const EMPTY: Totals = { processed: 0, enrolled: 0, alreadyEnrolled: 0, missingEmail: 0, addressSuppressed: 0, noAssignedAgent: 0, gmailUnavailable: 0, inaccessible: 0, failedOther: 0 };
type Phase = "setup" | "confirm" | "running" | "finished";

/**
 * "Enroll All Contacts" on a sequence: the contacts are chosen on the SERVER and enrolled in safe batches, so nothing is loaded into the browser and a long run can be
 * stopped between batches. It reuses the existing enrollment (each contact through its most recent lead). Safe to run again: whoever is already enrolled is skipped.
 */
export function EnrollAllContactsDialog({ sequenceId, sequenceName }: { sequenceId: string; sequenceName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("setup");
  const [mode, setMode] = useState<RecipientMode>("primary");
  const [preview, setPreview] = useState<EnrollAllContactsPreview | null>(null);
  const [totals, setTotals] = useState<Totals>(EMPTY);
  const [outcome, setOutcome] = useState<"done" | "stopped" | "error" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [gmailMessage, setGmailMessage] = useState<string | null>(null);
  const stop = useRef(false);

  useEffect(() => {
    if (!open) return;
    let stale = false;
    previewEnrollAllContacts({ sequenceId })
      .then((p) => !stale && setPreview(p))
      .catch(() => !stale && setPreview({ ok: false, error: "The contacts could not be counted right now. Please try again." }));
    return () => {
      stale = true;
    };
  }, [open, sequenceId]);

  function reset() {
    setPreview(null); // a stale count must never be shown the next time the dialog opens
    setPhase("setup");
    setTotals(EMPTY);
    setOutcome(null);
    setProblem(null);
    setGmailMessage(null);
    stop.current = false;
  }

  async function run() {
    stop.current = false;
    setPhase("running");
    setTotals(EMPTY);
    setOutcome(null);
    setProblem(null);
    let acc = { ...EMPTY };
    let cursor: string | null = null;
    try {
      for (;;) {
        const r = await enrollContactsBatch({ sequenceId, recipientMode: mode, cursor });
        if (!r.ok) {
          setProblem(r.error);
          setOutcome("error");
          break;
        }
        acc = {
          processed: acc.processed + r.processed,
          enrolled: acc.enrolled + r.enrolled,
          alreadyEnrolled: acc.alreadyEnrolled + r.alreadyEnrolled,
          missingEmail: acc.missingEmail + r.missingEmail,
          addressSuppressed: acc.addressSuppressed + r.addressSuppressed,
          noAssignedAgent: acc.noAssignedAgent + r.noAssignedAgent,
          gmailUnavailable: acc.gmailUnavailable + r.gmailUnavailable,
          inaccessible: acc.inaccessible + r.inaccessible,
          failedOther: acc.failedOther + r.failedOther,
        };
        setTotals(acc);
        if (r.gmailMessage) setGmailMessage((m) => m ?? r.gmailMessage ?? null);
        cursor = r.nextCursor;
        if (!cursor) {
          setOutcome("done");
          break;
        }
        if (stop.current) {
          setOutcome("stopped");
          break;
        }
      }
    } catch {
      // The browser lost the connection (or the server restarted): what earlier batches enrolled is safe, and running it again continues without enrolling anyone twice.
      setProblem("The connection was interrupted. Everyone enrolled so far stays enrolled; run it again to continue.");
      setOutcome("error");
    }
    setPhase("finished");
    router.refresh();
  }

  const total = preview && preview.ok ? preview.totalContacts : 0;
  const skippedNote = (
    <ul className="space-y-0.5 text-xs text-muted-foreground">
      <li>Contacts already actively enrolled in this sequence are skipped (nobody is enrolled twice).</li>
      <li>A contact with a lead you can access is enrolled through its most recent lead; a contact without one is enrolled as a contact - a lead is never needed.</li>
      <li>Contacts without a valid email address, or whose address unsubscribed or is suppressed, are skipped.</li>
    </ul>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (phase === "running" && !o) return; // not dismissible while enrolling; use Stop
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Users className="h-4 w-4" /> Enroll All Contacts
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Enroll All Contacts</DialogTitle>
          <DialogDescription>
            Enroll the contacts you can access in <strong>{sequenceName}</strong> without picking them one by one.
          </DialogDescription>
        </DialogHeader>

        {(phase === "setup" || phase === "confirm") && (
          <div className="space-y-3">
            <div className="rounded-md border bg-muted/30 p-3 text-sm" aria-live="polite" data-testid="all-contacts-preview">
              {!preview && (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Counting contacts...
                </p>
              )}
              {preview && !preview.ok && <p className="text-destructive">{preview.error}</p>}
              {preview && preview.ok && (
                <p>
                  <strong>{plural(preview.totalContacts, "contact")}</strong> in your CRM
                  {preview.alreadyEnrolled > 0 ? `, ${n(preview.alreadyEnrolled)} of them already enrolled in this sequence` : ""}.
                </p>
              )}
            </div>
            <RecipientModeChoice value={mode} onChange={setMode} />
            {skippedNote}
            {phase === "confirm" && (
              <div role="alertdialog" aria-label="Confirm enrolling all contacts" className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                <p>
                  Enroll every eligible contact in <strong>{sequenceName}</strong>, sending to {mode === "all" ? <strong>all their email addresses</strong> : <strong>their primary email only</strong>}? Eligibility is checked
                  again on the server for each contact. This runs in batches of 100; you can stop it at any time and run it again later.
                </p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={run}>
                    Enroll all contacts
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setPhase("setup")}>
                    Back
                  </Button>
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              {phase === "setup" && (
                <Button onClick={() => setPhase("confirm")} disabled={!preview || !preview.ok || total === 0}>
                  Review
                </Button>
              )}
            </DialogFooter>
          </div>
        )}

        {phase === "running" && (
          <div className="space-y-3" data-testid="all-contacts-progress">
            <p className="flex items-center gap-2 text-sm" role="status" aria-live="polite">
              <Loader2 className="h-4 w-4 animate-spin" />
              Processed {n(totals.processed)}
              {total > 0 ? ` of about ${n(total)}` : ""} contacts - {n(totals.enrolled)} enrolled so far
            </p>
            <div className="h-2 overflow-hidden rounded bg-muted" role="progressbar" aria-label="Contacts processed" aria-valuemin={0} aria-valuemax={Math.max(total, totals.processed)} aria-valuenow={totals.processed}>
              <div className="h-full bg-primary transition-all" style={{ width: `${total > 0 ? Math.min(100, Math.round((totals.processed / total) * 100)) : 0}%` }} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => (stop.current = true)}>
                Stop after this batch
              </Button>
            </DialogFooter>
          </div>
        )}

        {phase === "finished" && (
          <div className="space-y-3" data-testid="all-contacts-outcome">
            <p className="text-sm" role="status">
              {outcome === "done" && (
                <>
                  Finished: <strong>{plural(totals.enrolled, "contact")}</strong> enrolled in <strong>{sequenceName}</strong> out of {plural(totals.processed, "contact")} checked.
                </>
              )}
              {outcome === "stopped" && (
                <>
                  Stopped after {plural(totals.processed, "contact")}: <strong>{n(totals.enrolled)}</strong> enrolled. Run it again to continue; nobody is enrolled twice.
                </>
              )}
              {outcome === "error" && (
                <span role="alert" className="text-destructive">
                  {problem ?? "Something went wrong."} <span className="text-foreground">{n(totals.enrolled)} enrolled before it stopped.</span>
                </span>
              )}
            </p>
            <ul className="space-y-0.5 text-sm">
              <li>Newly enrolled: {n(totals.enrolled)}</li>
              {totals.alreadyEnrolled > 0 && <li>Already enrolled: {n(totals.alreadyEnrolled)}</li>}
              {totals.missingEmail > 0 && <li>No valid email address: {n(totals.missingEmail)}</li>}
              {totals.addressSuppressed > 0 && <li>Email unsubscribed or suppressed: {n(totals.addressSuppressed)}</li>}
              {totals.noAssignedAgent > 0 && <li>No assigned agent: {n(totals.noAssignedAgent)}</li>}
              {totals.gmailUnavailable > 0 && (
                <li>
                  Not enrolled because Gmail is unavailable: {n(totals.gmailUnavailable)}
                  {gmailMessage ? ` - ${gmailMessage}` : ""}
                </li>
              )}
              {totals.inaccessible > 0 && <li>No longer accessible: {n(totals.inaccessible)}</li>}
              {totals.failedOther > 0 && <li>Failed for another reason: {n(totals.failedOther)} - run it again to retry just those</li>}
            </ul>
            <DialogFooter>
              <Button
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
              >
                Close
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
