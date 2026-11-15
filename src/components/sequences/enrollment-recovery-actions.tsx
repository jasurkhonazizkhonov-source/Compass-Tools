"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";
import { Loader2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/crm/confirm-dialog";
import { GmailProblemNotice } from "@/components/sequences/gmail-problem-notice";
import { resolveUncertainDelivery, retryEnrollmentNow, type RecoveryResult } from "@/server/actions/sequences";
import type { EnrollmentStateKey } from "@/lib/sequence-progress";

const when = (iso: string | null) => (iso ? format(new Date(iso), "MMM d, yyyy 'at' h:mm a") : null);

/**
 * What a person can do about an enrollment that needs attention, on the lead page and in the sequence's table alike:
 *   - Retry scheduled / Failed  -> "Retry now": the SAME enrollment is restarted after Gmail is verified (never a second enrollment);
 *   - Delivery unconfirmed      -> "It was sent" / "Send again": the CRM cannot ask Gmail whether the message went out, so a person decides, and "Send again"
 *     warns that the customer may then receive it twice.
 * A Gmail problem found during the retry is shown right here with the connect / check-again actions; the lead page and the sequence page both refresh.
 */
export function EnrollmentRecoveryActions({ enrollmentId, leadId, state, sequenceName }: { enrollmentId: string; leadId: string; state: EnrollmentStateKey; sequenceName: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [problem, setProblem] = useState<Extract<RecoveryResult, { ok: false }> | null>(null);
  const [confirm, setConfirm] = useState<"sent" | "resend" | null>(null);

  if (state !== "retry_scheduled" && state !== "failed" && state !== "unconfirmed") return null;

  function report(result: RecoveryResult) {
    if (!result.ok) {
      setProblem(result);
      if (!result.gmail) toast.error(result.error);
      router.refresh();
      return;
    }
    setProblem(null);
    const at = when(result.nextSendAt);
    if (result.outcome === "sent") toast.success(`The email was sent${at ? `; the next step goes out ${at}` : ""}.`);
    else if (result.outcome === "recorded") toast.success(`Recorded as sent${at ? `; the next step goes out ${at}` : ""}.`);
    else if (result.outcome === "scheduled") toast.success(`Scheduled${at ? ` for ${at}` : ""}.`);
    else if (result.outcome === "retrying") toast.warning(`It could not be sent yet (${result.note ?? "temporary problem"}). It will be retried automatically${at ? ` at ${at}` : ""}.`);
    else toast.warning("Gmail did not confirm whether the email was sent. It was not resent; check the sender's Gmail Sent folder and choose below.");
    router.refresh();
  }

  function retry() {
    setProblem(null);
    startTransition(async () => {
      try {
        report(await retryEnrollmentNow(enrollmentId, leadId));
      } catch {
        toast.error("Something went wrong and the result is not known. Refresh the page before trying again.");
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-2" data-testid="recovery-actions">
      <div className="flex flex-wrap items-center gap-2">
        {(state === "retry_scheduled" || state === "failed") && (
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={retry} className="gap-1.5" aria-label={`Retry ${sequenceName} now`}>
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}
            {state === "failed" ? "Retry" : "Retry now"}
          </Button>
        )}
        {state === "unconfirmed" && (
          <>
            <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => setConfirm("sent")}>
              It was sent
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => setConfirm("resend")}>
              Send again
            </Button>
          </>
        )}
      </div>
      {problem?.gmail && <GmailProblemNotice gmail={problem.gmail} message={problem.error} leadId={leadId} onCheckAgain={retry} checking={pending} />}
      {problem && !problem.gmail && (
        <p role="alert" className="text-xs text-destructive">
          {problem.error}
        </p>
      )}
      <ConfirmDialog
        open={confirm === "sent"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Record this email as sent?"
        description={
          <>
            Only choose this if you checked the sender&apos;s Gmail <strong>Sent</strong> folder and the email to this lead is there. <strong>{sequenceName}</strong> will then move on to its next step.
          </>
        }
        confirmLabel="Yes, it was sent"
        onConfirm={async () => {
          const result = await resolveUncertainDelivery(enrollmentId, "sent", leadId);
          if (!result.ok) return { error: result.error };
          report(result);
        }}
      />
      <ConfirmDialog
        open={confirm === "resend"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Send this email again?"
        description={
          <>
            Gmail never confirmed whether the earlier email went out. If it did, this lead will receive <strong>two copies</strong>. Check the sender&apos;s Gmail <strong>Sent</strong> folder first.
          </>
        }
        confirmLabel="Send again"
        onConfirm={async () => {
          const result = await resolveUncertainDelivery(enrollmentId, "resend", leadId);
          if (!result.ok) {
            if (result.gmail) setProblem(result);
            return { error: result.error };
          }
          report(result);
        }}
      />
    </div>
  );
}
